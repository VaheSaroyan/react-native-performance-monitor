import { useEffect, useRef, useState } from 'react';
import type {
  AppInfo, DeviceInfo, Finding, LiveMessage, Sample, SessionMeta, SessionSummary,
} from '@rnperf/protocol';

declare global {
  interface Window {
    rnperf?: {
      getPort(): Promise<number>;
      getProjectRoot(): Promise<string | null>;
      pickProjectRoot(): Promise<string | null>;
    };
  }
}

/** The daemon port comes from the Electron main process, or the URL in a browser. */
export function resolvePort(): number {
  const fromQuery = new URLSearchParams(location.search).get('port');
  return fromQuery ? Number(fromQuery) : 8139;
}

const base = () => `http://127.0.0.1:${resolvePort()}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base() + path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `${path} failed`);
  return body;
}

export const api = {
  health: () => request<{ ok: boolean; projectRoot: string | null; sdkClients: unknown[] }>('/api/health'),
  devices: (refresh = false) => request<{ devices: DeviceInfo[] }>(`/api/devices${refresh ? '?refresh=1' : ''}`),
  apps: (deviceId: string) => request<{ apps: AppInfo[] }>(`/api/devices/${encodeURIComponent(deviceId)}/apps`),
  launch: (deviceId: string, bundleId: string) =>
    request<{ launched: boolean }>(`/api/devices/${encodeURIComponent(deviceId)}/launch`, {
      method: 'POST', body: JSON.stringify({ bundleId }),
    }),
  sessions: () => request<{ sessions: Array<SessionMeta & { live?: boolean }> }>('/api/sessions'),
  startSession: (config: Record<string, unknown>) =>
    request<{ session: SessionMeta }>('/api/sessions', { method: 'POST', body: JSON.stringify(config) }),
  stopSession: (id: string) => request<{ session: SessionMeta }>(`/api/sessions/${id}/stop`, { method: 'POST' }),
  deleteSession: (id: string) => request<{ deleted: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  samples: (id: string, full = false) =>
    request<{ samples: Sample[] }>(`/api/sessions/${id}/samples${full ? '?full=1' : ''}`),
  findings: (id: string) => request<{ findings: Finding[]; summary: SessionSummary }>(`/api/sessions/${id}/findings`),
  diff: (baseline: string, candidate: string) =>
    request<{ diff: import('@rnperf/protocol').SessionDiff }>('/api/diff', {
      method: 'POST', body: JSON.stringify({ baseline, candidate }),
    }),
  setProjectRoot: (projectRoot: string) =>
    request<{ projectRoot: string | null }>('/api/config', { method: 'POST', body: JSON.stringify({ projectRoot }) }),
};

/**
 * Subscribes to the daemon's live stream. Samples arrive here rather than
 * being polled, so a chart updates at the session's real sample rate.
 */
export function useLiveStream(onMessage: (m: LiveMessage) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      socket = new WebSocket(`ws://127.0.0.1:${resolvePort()}/live`);
      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        try {
          handler.current(JSON.parse(event.data) as LiveMessage);
        } catch {
          // A malformed frame is not worth tearing the connection down for.
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1200);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return { connected };
}

/** Rolling window of samples for the live charts. */
export function useSampleBuffer(sessionId: string | null, capacity = 240) {
  const [samples, setSamples] = useState<Sample[]>([]);

  useEffect(() => {
    setSamples([]);
    if (!sessionId) return;
    let cancelled = false;
    api.samples(sessionId).then(
      ({ samples: initial }) => { if (!cancelled) setSamples(initial.slice(-capacity)); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [sessionId, capacity]);

  const push = (sample: Sample) => {
    setSamples((previous) => {
      const next = [...previous, sample];
      return next.length > capacity ? next.slice(next.length - capacity) : next;
    });
  };

  return { samples, push, reset: () => setSamples([]) };
}

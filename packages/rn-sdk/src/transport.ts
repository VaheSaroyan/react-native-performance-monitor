import type { PerfEvent, Sample } from './types.js';

declare const global: Record<string, any>;

const PROTOCOL_VERSION = 1;

/**
 * An IPv6 literal must be bracketed inside a URL. This matters in practice:
 * a physical iPhone reaches the development machine over an IPv6 tunnel, and
 * an unbracketed address silently produces an unusable URL.
 */
function formatHost(host: string): string {
  const bare = host.replace(/^\[|\]$/g, '');
  return bare.includes(':') ? `[${bare}]` : bare;
}

export interface HelloPayload {
  app: { bundleId?: string; name?: string; version?: string };
  platform: 'ios' | 'android';
  deviceName?: string;
  runtime: { rnVersion?: string; hermes: boolean; dev: boolean };
}

/**
 * Reconnecting WebSocket to the daemon. Everything is best-effort: when the
 * daemon is not running the app must behave exactly as if the SDK were absent,
 * so failures are swallowed and retried with backoff rather than surfaced.
 */
export class Transport {
  private socket: WebSocket | null = null;
  private url: string;
  private closed = false;
  private retryMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: string[] = [];

  constructor(
    host: string,
    port: number,
    private readonly hello: HelloPayload,
    private readonly onStatus?: (s: 'connecting' | 'connected' | 'disconnected') => void,
  ) {
    this.url = `ws://${formatHost(host)}:${port}/ingest`;
  }

  connect(): void {
    if (this.closed || this.socket) return;
    this.onStatus?.('connecting');
    try {
      const socket = new global.WebSocket(this.url) as WebSocket;
      this.socket = socket;

      socket.onopen = () => {
        this.retryMs = 1000;
        this.onStatus?.('connected');
        this.send({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          startedAt: Date.now(),
          ...this.hello,
        });
        // Replay anything buffered while the daemon was unreachable.
        const pending = this.queue;
        this.queue = [];
        for (const message of pending) {
          try { socket.send(message); } catch { /* dropped */ }
        }
      };

      socket.onclose = () => this.handleDrop();
      socket.onerror = () => this.handleDrop();
    } catch {
      this.handleDrop();
    }
  }

  private handleDrop(): void {
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
    }
    this.socket = null;
    this.onStatus?.('disconnected');
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.retryMs);
    // Back off to 30s so a release build with no daemon is not retrying hard.
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }

  private send(payload: unknown): void {
    const text = JSON.stringify(payload);
    const socket = this.socket;
    if (socket && socket.readyState === 1) {
      try {
        socket.send(text);
        return;
      } catch { /* fall through to buffering */ }
    }
    // Keep only a short tail: stale samples are worth less than live ones.
    this.queue.push(text);
    if (this.queue.length > 60) this.queue.shift();
  }

  sendSample(sample: Sample): void {
    this.send({ type: 'sample', sample });
  }

  sendEvent(event: PerfEvent): void {
    this.send({ type: 'event', event });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.send({ type: 'bye' });
      this.socket?.close();
    } catch { /* ignore */ }
    this.socket = null;
  }

  get connected(): boolean {
    return this.socket?.readyState === 1;
  }
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { join } from 'node:path';
import {
  DAEMON_LOCKFILE, DEFAULT_DAEMON_PORT, PROTOCOL_VERSION,
  type DaemonMessage, type LiveMessage, type Platform, type SdkMessage, type SessionConfig,
} from '@rnperf/protocol';
import { DeviceRegistry, launchApp, listApps } from './devices/index.js';
import { SessionManager } from './session.js';
import { DATA_DIR, SessionStore } from './store.js';
import {
  buildSummary, deriveFindings, diffSessions, isPlausibleProjectRoot, locateComponent, readContext,
} from './analysis/index.js';

export interface SdkClient {
  id: string;
  bundleId?: string;
  appName?: string;
  platform: Platform;
  deviceName?: string;
  runtime: { rnVersion?: string; hermes: boolean; dev: boolean };
  connectedAt: number;
}

export interface DaemonOptions {
  port?: number;
  host?: string;
  /**
   * React Native project root, used to resolve component names to files.
   * Leave unset to skip source lookup entirely.
   */
  projectRoot?: string | null;
}

export class Daemon {
  readonly store = new SessionStore();
  readonly devices = new DeviceRegistry();
  readonly sessions = new SessionManager(this.store);
  readonly sdkClients = new Map<string, SdkClient>();

  private http?: Server;
  private liveWss?: WebSocketServer;
  private ingestWss?: WebSocketServer;
  private liveClients = new Set<WebSocket>();
  private readonly port: number;
  private readonly host: string;
  private boundPort = 0;
  projectRoot: string | null;

  constructor(opts: DaemonOptions = {}) {
    this.port = opts.port ?? Number(process.env.RNPERF_PORT ?? DEFAULT_DAEMON_PORT);
    // '::' binds dual-stack on Node, covering both IPv4 LAN clients and the
    // IPv6 tunnel that devicectl establishes to a physical iOS device.
    this.host = opts.host ?? '::';
    this.projectRoot = opts.projectRoot ?? null;
  }

  async start(): Promise<{ port: number }> {
    await this.store.init();
    this.devices.start();
    this.devices.onChange((devices) => this.broadcast({ type: 'devices', devices }));
    this.sessions.on('sample', (sessionId, sample) => this.broadcast({ type: 'sample', sessionId, sample }));
    this.sessions.on('event', (sessionId, event) => this.broadcast({ type: 'event', sessionId, event }));
    this.sessions.on('started', (meta) => this.broadcast({ type: 'session-started', meta }));
    this.sessions.on('ended', (meta) => this.broadcast({ type: 'session-ended', meta }));
    this.sessions.on('updated', (meta) => this.broadcast({ type: 'session-updated', meta }));
    this.sessions.on('warning', (_id, message) => this.broadcast({ type: 'error', message }));

    this.http = createServer((req, res) => void this.handleHttp(req, res));
    this.liveWss = new WebSocketServer({ noServer: true });
    this.ingestWss = new WebSocketServer({ noServer: true });

    this.http.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/live') {
        this.liveWss!.handleUpgrade(req, socket, head, (ws) => this.onLiveClient(ws));
      } else if (path === '/ingest') {
        this.ingestWss!.handleUpgrade(req, socket, head, (ws) => this.onSdkClient(ws));
      } else {
        socket.destroy();
      }
    });

    this.boundPort = await listenWithFallback(this.http, this.port, this.host);
    await writeLockfile(this.boundPort);
    return { port: this.boundPort };
  }

  /** The port actually bound, which may differ from the requested one. */
  get activePort(): number {
    return this.boundPort || this.port;
  }

  async stop(): Promise<void> {
    await removeLockfile(this.boundPort);
    await this.sessions.stopAll();
    this.devices.stop();
    for (const ws of this.liveClients) ws.close();
    this.liveWss?.close();
    this.ingestWss?.close();
    await new Promise<void>((resolve) => this.http?.close(() => resolve()) ?? resolve());
  }

  /* -------------------------------------------------------- websockets */

  private onLiveClient(ws: WebSocket): void {
    this.liveClients.add(ws);
    ws.on('close', () => this.liveClients.delete(ws));
    ws.on('error', () => this.liveClients.delete(ws));
    send(ws, { type: 'devices', devices: this.devices.list() });
    send(ws, { type: 'sessions', sessions: this.sessions.live().map((s) => s.meta) });
  }

  private broadcast(message: LiveMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.liveClients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  private onSdkClient(ws: WebSocket): void {
    const id = randomUUID().slice(0, 8);
    let client: SdkClient | undefined;

    const toDevice = (msg: DaemonMessage) => ws.send(JSON.stringify(msg));

    ws.on('message', (raw) => {
      let msg: SdkMessage;
      try {
        msg = JSON.parse(String(raw)) as SdkMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'hello': {
          client = {
            id,
            bundleId: msg.app.bundleId,
            appName: msg.app.name,
            platform: msg.platform,
            deviceName: msg.deviceName,
            runtime: msg.runtime,
            connectedAt: Date.now(),
          };
          this.sdkClients.set(id, client);
          toDevice({ type: 'welcome', clientId: id, intervalMs: 1000 });
          this.broadcast({
            type: 'sdk-connected',
            clientId: id,
            app: msg.app.name ?? msg.app.bundleId ?? 'app',
            platform: msg.platform,
          });
          if (msg.protocol !== PROTOCOL_VERSION) {
            this.broadcast({
              type: 'error',
              message: `SDK protocol v${msg.protocol} differs from daemon v${PROTOCOL_VERSION}; update @rnperf/sdk.`,
            });
          }
          break;
        }
        case 'sample': {
          if (!client) break;
          for (const session of this.sessions.route(client.bundleId, client.platform)) {
            session.ingestSdkSample(msg.sample);
          }
          break;
        }
        case 'event': {
          if (!client) break;
          for (const session of this.sessions.route(client.bundleId, client.platform)) {
            session.ingestSdkEvent(msg.event);
          }
          break;
        }
        case 'bye':
          ws.close();
          break;
      }
    });

    const cleanup = () => {
      this.sdkClients.delete(id);
      this.broadcast({ type: 'sdk-disconnected', clientId: id });
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  /* --------------------------------------------------------------- API */

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const segments = url.pathname.split('/').filter(Boolean);

    try {
      const result = await this.route(req, url, segments);
      if (result === undefined) {
        json(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
      } else {
        json(res, 200, result);
      }
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  }

  private async route(req: IncomingMessage, url: URL, seg: string[]): Promise<unknown | undefined> {
    const method = req.method ?? 'GET';
    if (seg[0] !== 'api') return undefined;
    const [, resource, id, action] = seg;

    /* health */
    if (resource === 'health') {
      return {
        ok: true,
        protocol: PROTOCOL_VERSION,
        port: this.activePort,
        projectRoot: this.projectRoot,
        liveSessions: this.sessions.live().length,
        sdkClients: [...this.sdkClients.values()],
      };
    }

    /* devices */
    if (resource === 'devices' && !id) {
      const devices = url.searchParams.get('refresh') ? await this.devices.refresh() : this.devices.list();
      return { devices };
    }
    if (resource === 'devices' && id && action === 'apps') {
      const device = this.devices.get(id);
      if (!device) throw new Error(`Unknown device ${id}`);
      return { apps: await listApps(device) };
    }
    if (resource === 'devices' && id && action === 'launch' && method === 'POST') {
      const device = this.devices.get(id);
      if (!device) throw new Error(`Unknown device ${id}`);
      const body = await readJson<{ bundleId: string }>(req);
      return { launched: await launchApp(device, body.bundleId) };
    }

    /* sessions */
    if (resource === 'sessions' && !id && method === 'GET') {
      const live = new Set(this.sessions.live().map((s) => s.id));
      const stored = await this.store.list();
      return {
        sessions: stored.map((m) => ({ ...m, live: live.has(m.id) })),
      };
    }
    if (resource === 'sessions' && !id && method === 'POST') {
      const body = await readJson<SessionConfig>(req);
      // Rescanning here would block on `devicectl`, which can take tens of
      // seconds; only pay that cost if the device is genuinely unknown.
      let device = this.devices.get(body.deviceId);
      if (!device) {
        await this.devices.refresh();
        device = this.devices.get(body.deviceId);
      }
      if (!device) throw new Error(`Unknown device ${body.deviceId}`);
      const session = await this.sessions.start(device, body);
      return { session: session.meta };
    }
    if (resource === 'sessions' && id && action === 'stop' && method === 'POST') {
      const meta = await this.sessions.stop(id);
      if (!meta) throw new Error(`Session ${id} is not running`);
      return { session: meta };
    }
    if (resource === 'sessions' && id && !action && method === 'DELETE') {
      await this.requireMeta(id);
      await this.sessions.stop(id).catch(() => null);
      const deleted = await this.store.delete(id);
      if (deleted) this.broadcast({ type: 'session-deleted', sessionId: id });
      return { deleted };
    }
    if (resource === 'sessions' && id && !action && method === 'PATCH') {
      const body = await readJson<{ label?: unknown }>(req);
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      if (!label) throw new Error('A recording needs a name');
      if (label.length > 120) throw new Error('That name is too long (120 characters at most)');
      const meta = await this.sessions.rename(id, label);
      if (!meta) throw new Error(`No recording with id ${id}`);
      return { session: meta };
    }
    if (resource === 'sessions' && id && !action && method === 'GET') {
      const meta = await this.requireMeta(id);
      const live = this.sessions.get(id);
      return { session: meta, live: Boolean(live), recent: live?.getRecent() ?? [] };
    }
    if (resource === 'sessions' && id && action === 'samples') {
      const live = this.sessions.get(id);
      const limit = numberParam(url, 'limit');
      if (live && !url.searchParams.get('full')) {
        return { samples: live.getRecent(limit ?? 300) };
      }
      return {
        samples: await this.store.readSamples(id, {
          from: numberParam(url, 'from'),
          to: numberParam(url, 'to'),
          limit,
        }),
      };
    }
    if (resource === 'sessions' && id && action === 'events') {
      const types = url.searchParams.get('types')?.split(',').filter(Boolean);
      return { events: await this.store.readEvents(id, { types, limit: numberParam(url, 'limit') }) };
    }
    if (resource === 'sessions' && id && action === 'summary') {
      return { summary: await this.summaryFor(id) };
    }
    if (resource === 'sessions' && id && action === 'findings') {
      const summary = await this.summaryFor(id);
      const [samples, events] = await Promise.all([
        this.store.readSamples(id),
        this.store.readEvents(id),
      ]);
      const findings = deriveFindings(summary, samples, events);
      const locate = url.searchParams.get('locate') !== '0';
      if (locate) await this.attachLocations(findings);
      return { findings, summary };
    }

    /* analysis */
    if (resource === 'diff' && method === 'POST') {
      const body = await readJson<{ baseline: string; candidate: string }>(req);
      const [a, b] = await Promise.all([this.summaryFor(body.baseline), this.summaryFor(body.candidate)]);
      return { diff: diffSessions(a, b) };
    }
    if (resource === 'locate' && method === 'POST') {
      const body = await readJson<{ name: string; root?: string; context?: boolean }>(req);
      const root = body.root ?? this.projectRoot;
      if (!root) {
        return {
          locations: [],
          root: null,
          message: 'No project root is set. Call set_project_root (or set it in the app) to resolve component names to files.',
        };
      }
      const locations = await locateComponent(root, body.name);
      if (body.context) {
        const withContext = await Promise.all(
          locations.map(async (l) => ({
            ...l,
            context: await readContext(l.file.startsWith('/') ? l.file : `${root}/${l.file}`, l.line),
          })),
        );
        return { locations: withContext, root };
      }
      return { locations, root };
    }
    if (resource === 'config' && method === 'POST') {
      const body = await readJson<{ projectRoot?: string }>(req);
      if (body.projectRoot) {
        if (!isPlausibleProjectRoot(body.projectRoot)) {
          throw new Error(
            `${body.projectRoot} is too broad to search. Pick the directory that holds your app's package.json.`,
          );
        }
        this.projectRoot = body.projectRoot;
      }
      return { projectRoot: this.projectRoot };
    }

    return undefined;
  }

  private async requireMeta(id: string) {
    const live = this.sessions.get(id);
    if (live) return live.meta;
    const meta = await this.store.getMeta(id);
    if (!meta) throw new Error(`Unknown session ${id}`);
    return meta;
  }

  async summaryFor(id: string) {
    const meta = await this.requireMeta(id);
    const [samples, events] = await Promise.all([
      this.store.readSamples(id),
      this.store.readEvents(id),
    ]);
    return buildSummary(meta, samples, events);
  }

  /** Resolve component names in findings to files in the project. */
  async attachLocations(findings: Array<{ subject?: string; locations?: unknown }>): Promise<void> {
    const root = this.projectRoot;
    if (!root) return;
    const names = [...new Set(findings.map((f) => f.subject).filter((s): s is string => Boolean(s)))];
    const located = await Promise.all(
      names.map(async (n) => [n, await locateComponent(root, n)] as const),
    );
    const map = new Map(located);
    for (const f of findings) {
      const hits = f.subject ? map.get(f.subject) : undefined;
      if (hits && hits.length) f.locations = hits;
    }
  }
}

/* ------------------------------------------------------------- helpers */

/**
 * Developer machines are crowded — the preferred port is often already taken
 * by Metro, another tool, or a stale daemon. Walk a small range rather than
 * failing to start, and record the result so local clients can find us.
 */
async function listenWithFallback(server: Server, preferred: number, host: string): Promise<number> {
  for (let port = preferred; port < preferred + 10; port += 1) {
    const bound = await new Promise<number | null>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        resolve(err.code === 'EADDRINUSE' ? null : null);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    if (bound !== null) return bound;
  }
  throw new Error(`No free port in ${preferred}–${preferred + 9} for the rnperf daemon.`);
}

async function writeLockfile(port: number): Promise<void> {
  try {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(
      join(DATA_DIR, DAEMON_LOCKFILE),
      JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }),
      'utf8',
    );
  } catch {
    // Discovery is a convenience; clients fall back to the default port.
  }
}

async function removeLockfile(port: number): Promise<void> {
  try {
    const { readFile, rm } = await import('node:fs/promises');
    const file = join(DATA_DIR, DAEMON_LOCKFILE);
    const current = JSON.parse(await readFile(file, 'utf8')) as { pid?: number };
    // Only clear our own entry — another daemon may have replaced it.
    if (current.pid === process.pid) await rm(file, { force: true });
    void port;
  } catch {
    // Nothing to clean up.
  }
}

/** Port a locally running daemon advertised, if any. */
export async function discoverDaemonPort(): Promise<number | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(DATA_DIR, DAEMON_LOCKFILE), 'utf8');
    const { port } = JSON.parse(raw) as { port?: number };
    return typeof port === 'number' ? port : null;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, message: LiveMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 4 * 1024 * 1024) throw new Error('Request body too large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

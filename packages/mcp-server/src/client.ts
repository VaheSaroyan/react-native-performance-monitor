import { DEFAULT_DAEMON_PORT } from '@rnperf/protocol';
import { Daemon, discoverDaemonPort } from '@rnperf/daemon';

/**
 * Talks to a running daemon over HTTP when the desktop app (or `rnperf daemon`)
 * has one up, and otherwise runs its own in-process. That means the MCP server
 * works on its own — an agent can record and analyse a session without the
 * desktop app ever being opened — while still sharing state with the UI when
 * it is open.
 */
export class DaemonClient {
  private base: string;
  private embedded?: Daemon;
  private mode: 'remote' | 'embedded' | 'unknown' = 'unknown';

  constructor(
    private readonly port = Number(process.env.RNPERF_PORT ?? DEFAULT_DAEMON_PORT),
    private readonly projectRoot = process.env.RNPERF_ROOT ?? process.cwd(),
  ) {
    this.base = `http://127.0.0.1:${this.port}`;
  }

  async ensure(): Promise<'remote' | 'embedded'> {
    if (this.mode !== 'unknown') return this.mode;

    // A daemon started by the desktop app may have landed on a different port
    // if the preferred one was taken, so check what it advertised first.
    const candidates = [this.port];
    if (!process.env.RNPERF_PORT) {
      const advertised = await discoverDaemonPort();
      if (advertised && advertised !== this.port) candidates.unshift(advertised);
    }

    for (const port of candidates) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          this.base = `http://127.0.0.1:${port}`;
          this.mode = 'remote';
          return this.mode;
        }
      } catch {
        // Nothing listening on this one — try the next, then host our own.
      }
    }

    this.embedded = new Daemon({ port: this.port, projectRoot: this.projectRoot });
    try {
      const { port } = await this.embedded.start();
      this.base = `http://127.0.0.1:${port}`;
    } catch (err) {
      // A race with the desktop app starting up: prefer the one that won.
      this.embedded = undefined;
      const res = await fetch(`${this.base}/api/health`).catch(() => null);
      if (!res?.ok) throw err;
      this.mode = 'remote';
      return this.mode;
    }
    this.mode = 'embedded';
    return this.mode;
  }

  get describeMode(): string {
    return this.mode === 'embedded'
      ? 'embedded daemon (started by the MCP server)'
      : 'shared daemon (desktop app or `rnperf daemon`)';
  }

  async get<T>(path: string): Promise<T> {
    await this.ensure();
    const res = await fetch(`${this.base}${path}`);
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok || body.error) throw new Error(body.error ?? `GET ${path} failed (${res.status})`);
    return body;
  }

  async post<T>(path: string, payload: unknown = {}): Promise<T> {
    await this.ensure();
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok || body.error) throw new Error(body.error ?? `POST ${path} failed (${res.status})`);
    return body;
  }

  async del<T>(path: string): Promise<T> {
    await this.ensure();
    const res = await fetch(`${this.base}${path}`, { method: 'DELETE' });
    return (await res.json()) as T;
  }

  async shutdown(): Promise<void> {
    await this.embedded?.stop();
  }
}

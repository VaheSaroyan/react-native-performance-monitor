import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  DeviceInfo, MetricSource, PerfEvent, Sample, SessionConfig, SessionMeta,
} from '@rnperf/protocol';
import { AndroidCollector } from './collectors/android.js';
import { IosDeviceCollector } from './collectors/ios-device.js';
import { IosSimulatorCollector } from './collectors/ios-sim.js';
import { SdkCollector } from './collectors/sdk.js';
import type { Collector, CollectorContext } from './collectors/types.js';
import type { SessionStore } from './store.js';

export interface SessionEvents {
  sample: (sessionId: string, sample: Sample) => void;
  event: (sessionId: string, event: PerfEvent) => void;
  warning: (sessionId: string, message: string) => void;
  ended: (meta: SessionMeta) => void;
}

/** Resolves to null if the promise has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One running capture against one device. */
export class Session extends EventEmitter {
  readonly id: string;
  readonly meta: SessionMeta;
  private collectors: Collector[] = [];
  readonly sdk: SdkCollector;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private warnings = new Set<string>();
  /** Recent samples kept in memory so the UI can backfill a chart instantly. */
  private recent: Sample[] = [];

  constructor(
    device: DeviceInfo,
    config: SessionConfig,
    private readonly store: SessionStore,
  ) {
    super();
    this.id = randomUUID().slice(0, 8);
    const intervalMs = Math.max(250, config.intervalMs ?? 1000);
    this.meta = {
      id: this.id,
      label: config.label ?? `${device.name} · ${new Date().toLocaleTimeString()}`,
      device,
      bundleId: config.bundleId,
      startedAt: Date.now(),
      intervalMs,
      tags: config.tags ?? {},
      sampleCount: 0,
      activeSources: [],
    };

    const ctx: CollectorContext = {
      deviceId: device.id,
      bundleId: config.bundleId,
      emit: (event) => this.handleEvent(event),
      warn: (message) => this.warn(message),
    };

    this.sdk = new SdkCollector(ctx);
    this.collectors.push(this.sdk);

    switch (device.source) {
      case 'adb': this.collectors.push(new AndroidCollector(ctx)); break;
      case 'ios-sim-host': this.collectors.push(new IosSimulatorCollector(ctx)); break;
      case 'ios-devicectl': this.collectors.push(new IosDeviceCollector(ctx)); break;
      default: break;
    }
  }

  async start(): Promise<void> {
    await this.store.create(this.meta);
    const started = await Promise.all(
      this.collectors.map(async (c) => {
        try {
          return (await c.start()) ? c : null;
        } catch (err) {
          this.warn(`${c.name} collector failed to start: ${(err as Error).message}`);
          return null;
        }
      }),
    );
    this.collectors = started.filter((c): c is Collector => c !== null);

    this.timer = setInterval(() => void this.tick(), this.meta.intervalMs);
    this.timer.unref?.();
  }

  private warn(message: string): void {
    if (this.warnings.has(message)) return;
    this.warnings.add(message);
    this.emit('warning', this.id, message);
    this.handleEvent({ type: 'log', t: Date.now(), level: 'warn', tag: 'rnperf', message });
  }

  private handleEvent(event: PerfEvent): void {
    void this.store.appendEvent(this.id, event);
    this.emit('event', this.id, event);
  }

  /** Called by the ingest server when the in-app SDK reports something. */
  ingestSdkSample(sample: Partial<Sample>): void {
    this.sdk.push(sample);
  }

  ingestSdkEvent(event: PerfEvent): void {
    this.handleEvent(event);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // A slow adb call must not stack up ticks.
    this.ticking = true;
    const t = Date.now();
    try {
      // Collectors are expected to return cached values immediately, but a
      // device call that hangs must not stop the clock for every other source.
      const deadlineMs = Math.max(250, this.meta.intervalMs * 0.8);
      const parts = await Promise.all(
        this.collectors.map(async (c) => {
          const empty = { name: c.name as MetricSource, part: {} as Partial<Sample> };
          try {
            const part = await withTimeout(c.tick(), deadlineMs);
            return part === null ? empty : { name: c.name as MetricSource, part };
          } catch {
            return empty;
          }
        }),
      );

      const sample: Sample = { t, dt: t - this.meta.startedAt };
      const contributing: MetricSource[] = [];
      for (const { name, part } of parts) {
        if (Object.keys(part).length === 0) continue;
        contributing.push(name);
        // The SDK stamps its own clock on each sample. Letting that through
        // would replace the session's timeline with the app's, so metric
        // fields are copied and timing fields are not.
        const { t: _ignoredT, dt: _ignoredDt, ...metrics } = part as Partial<Sample>;
        Object.assign(sample, metrics);
      }
      if (contributing.length === 0) return;

      for (const src of contributing) {
        if (!this.meta.activeSources.includes(src)) this.meta.activeSources.push(src);
      }
      this.meta.sampleCount += 1;

      this.recent.push(sample);
      if (this.recent.length > 600) this.recent.shift();

      void this.store.appendSample(this.id, sample);
      this.emit('sample', this.id, sample);
    } finally {
      this.ticking = false;
    }
  }

  getRecent(limit = 300): Sample[] {
    return this.recent.slice(-limit);
  }

  async stop(): Promise<SessionMeta> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all(this.collectors.map((c) => c.stop().catch(() => {})));
    this.meta.endedAt = Date.now();
    await this.store.flush();
    await this.store.writeMeta(this.meta);
    this.emit('ended', this.meta);
    return this.meta;
  }
}

/** Tracks every live session and routes SDK traffic to the right one. */
export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();

  constructor(private readonly store: SessionStore) {
    super();
  }

  async start(device: DeviceInfo, config: SessionConfig): Promise<Session> {
    const session = new Session(device, config, this.store);
    session.on('sample', (id, s) => this.emit('sample', id, s));
    session.on('event', (id, e) => this.emit('event', id, e));
    session.on('warning', (id, m) => this.emit('warning', id, m));
    this.sessions.set(session.id, session);
    await session.start();
    this.emit('started', session.meta);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  live(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * SDK clients identify themselves by bundle id and platform, not by session,
   * so route their samples to any live session that plausibly matches. When a
   * session names no bundle id, a platform match is enough.
   */
  route(bundleId: string | undefined, platform: string): Session[] {
    return this.live().filter((s) => {
      if (s.meta.device.platform !== platform) return false;
      if (!s.meta.bundleId || !bundleId) return true;
      return s.meta.bundleId === bundleId;
    });
  }

  async stop(id: string): Promise<SessionMeta | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    const meta = await session.stop();
    this.sessions.delete(id);
    this.emit('ended', meta);
    return meta;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}

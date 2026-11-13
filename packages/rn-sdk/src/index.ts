import { BridgeProbe, FpsProbe, StallProbe, isHermes, now, readJsHeap } from './probes.js';
import { Platform, inferBundleId, inferHost } from './rn.js';
import { NativeFrameProbe, explainMissingNativeModule } from './native.js';
import { RenderTracker } from './renders.js';
import { Transport } from './transport.js';
import type { PerfEvent, PerfMonitorOptions, Sample } from './types.js';

export type { PerfMonitorOptions, Sample, PerfEvent, ComponentRenderStat } from './types.js';

declare const global: Record<string, any>;

const DEFAULT_PORT = 8139;

class PerfMonitor {
  private transport?: Transport;
  private readonly fps = new FpsProbe();
  private readonly stalls = new StallProbe();
  private readonly bridge = new BridgeProbe();
  private readonly renders = new RenderTracker();
  private readonly nativeFrames = new NativeFrameProbe();
  private timer: ReturnType<typeof setInterval> | null = null;
  private reporting = false;
  private startedAt = 0;
  private currentScreen?: string;
  private marks = new Map<string, number>();
  private ttiReported = new Set<string>();
  private running = false;

  start(options: PerfMonitorOptions = {}): void {
    if (this.running) return;

    const dev = Boolean(global.__DEV__);
    if (!dev && !options.enableInRelease) {
      // Profiling costs real CPU. Opting in to it in production must be explicit.
      return;
    }

    const host = options.host === 'auto' || !options.host ? inferHost() : options.host;
    if (!host) {
      warn('could not infer the daemon host from the Metro bundle URL — pass `host` explicitly.');
      return;
    }

    this.running = true;
    this.startedAt = now();

    const platform: 'ios' | 'android' = Platform.OS === 'android' ? 'android' : 'ios';

    this.transport = new Transport(
      host,
      options.port ?? DEFAULT_PORT,
      {
        app: {
          bundleId: options.bundleId ?? inferBundleId(),
          name: options.appName,
          version: options.appVersion,
        },
        platform,
        deviceName: Platform.constants?.Model ?? Platform.constants?.Brand,
        runtime: {
          rnVersion: Platform.constants?.reactNativeVersion
            ? formatVersion(Platform.constants.reactNativeVersion)
            : undefined,
          hermes: isHermes(),
          dev,
        },
      },
      options.onStatus,
    );
    this.transport.connect();

    this.fps.start();
    this.stalls.start();
    if (options.trackBridge !== false) this.bridge.start();
    if (options.trackUiFrames !== false) {
      if (this.nativeFrames.attach()) {
        this.nativeFrames.start();
      } else {
        warn(explainMissingNativeModule());
      }
    }
    if (options.trackRenders !== false && !this.renders.install()) {
      warn('component render tracking is unavailable — React had not initialised when the monitor started. Call startPerfMonitor() after importing your root component.');
    }

    const intervalMs = options.intervalMs ?? 1000;
    this.timer = setInterval(() => void this.report(), intervalMs);

    this.installErrorHook();
  }

  private async report(): Promise<void> {
    if (!this.transport) return;
    // Reading the native window is a bridge round trip. If the JS thread is
    // blocked it may still be outstanding when the next tick fires; skipping
    // is correct, because the native side keeps accumulating either way and
    // the following read simply covers a longer window.
    if (this.reporting) return;
    this.reporting = true;
    try {
      await this.collectAndSend();
    } finally {
      this.reporting = false;
    }
  }

  private async collectAndSend(): Promise<void> {
    if (!this.transport) return;
    const t = Date.now();
    const sample: Sample = { t, dt: Math.round(now() - this.startedAt) };

    const fps = this.fps.read();
    if (fps !== undefined) sample.jsFps = Math.round(fps * 10) / 10;

    const { jsStallMaxMs, jsStallCount } = this.stalls.read();
    if (jsStallCount > 0) {
      sample.jsStallMaxMs = Math.round(jsStallMaxMs);
      sample.jsStallCount = jsStallCount;
    }

    Object.assign(sample, readJsHeap());

    const bridgeCalls = this.bridge.read();
    if (bridgeCalls !== undefined) sample.bridgeCalls = bridgeCalls;

    const renders = this.renders.read();
    if (renders) sample.renders = renders;

    if (this.currentScreen) sample.screen = this.currentScreen;

    if (this.nativeFrames.available) {
      const frames = await this.nativeFrames.read();
      if (frames.uiFps !== undefined) sample.uiFps = round1(frames.uiFps);
      if (frames.refreshHz !== undefined) sample.uiRefreshHz = frames.refreshHz;
      if (frames.frameP50Ms !== undefined) sample.frameP50Ms = round2(frames.frameP50Ms);
      if (frames.frameP95Ms !== undefined) sample.frameP95Ms = round2(frames.frameP95Ms);
      if (frames.frameP99Ms !== undefined) sample.frameP99Ms = round2(frames.frameP99Ms);
      if (frames.jankPercent !== undefined) sample.jankPercent = round1(frames.jankPercent);
      if (frames.framesRendered !== undefined) sample.framesRendered = frames.framesRendered;
      // Without a cable the daemon cannot read memory at all, so for a device
      // on Wi-Fi these are the only memory figures available for the run.
      if (frames.memoryMB !== undefined) sample.rssMB = round1(frames.memoryMB);
      if (frames.javaHeapMB !== undefined) sample.javaHeapMB = round1(frames.javaHeapMB);
      if (frames.nativeHeapMB !== undefined) sample.nativeHeapMB = round1(frames.nativeHeapMB);
    }

    // The transport may have been torn down while awaiting the bridge.
    this.transport?.sendSample(sample);
  }

  private installErrorHook(): void {
    try {
      const handler = global.ErrorUtils?.getGlobalHandler?.();
      global.ErrorUtils?.setGlobalHandler?.((error: Error, isFatal?: boolean) => {
        this.transport?.sendEvent({
          type: 'crash',
          t: Date.now(),
          message: `${isFatal ? 'Fatal: ' : ''}${error?.message ?? String(error)}`,
          stack: error?.stack,
        });
        handler?.(error, isFatal);
      });
    } catch { /* leave the app's own handler alone */ }
  }

  /* ------------------------------------------------------------ public */

  setScreen(name: string): void {
    if (this.currentScreen === name) return;
    this.currentScreen = name;
    this.transport?.sendEvent({ type: 'screen', t: Date.now(), name });
  }

  mark(name: string, detail?: unknown): void {
    this.marks.set(name, now());
    this.transport?.sendEvent({ type: 'mark', t: Date.now(), name, detail });
  }

  measure(name: string, startMark?: string, detail?: unknown): number | undefined {
    const start = this.marks.get(startMark ?? name);
    if (start === undefined) return undefined;
    const durationMs = now() - start;
    this.transport?.sendEvent({
      type: 'measure', t: Date.now(), name, durationMs: Math.round(durationMs * 100) / 100, detail,
    });
    return durationMs;
  }

  /** Report time-to-interactive for a screen. Ignored after the first call per screen. */
  reportTTI(screen?: string, durationMs?: number): void {
    const key = screen ?? '__app__';
    if (this.ttiReported.has(key)) return;
    this.ttiReported.add(key);
    this.transport?.sendEvent({
      type: 'tti',
      t: Date.now(),
      durationMs: Math.round(durationMs ?? now() - this.startedAt),
      screen,
    });
  }

  trackInteraction(name: string, durationMs: number): void {
    this.transport?.sendEvent({ type: 'interaction', t: Date.now(), name, durationMs: Math.round(durationMs) });
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, tag?: string): void {
    this.transport?.sendEvent({ type: 'log', t: Date.now(), level, message, tag });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.fps.stop();
    this.stalls.stop();
    this.bridge.stop();
    this.nativeFrames.stop();
    this.renders.uninstall();
    this.transport?.close();
    this.transport = undefined;
  }

  get isConnected(): boolean {
    return Boolean(this.transport?.connected);
  }
}

const monitor = new PerfMonitor();

/**
 * Start streaming performance data to the rnperf daemon.
 *
 * Call it once, as early as possible but **after** React has loaded, so the
 * render tracker can attach to React's commit hook:
 *
 * ```ts
 * import { startPerfMonitor } from '@rnperf/sdk';
 * import App from './App';
 *
 * startPerfMonitor();            // host is derived from the Metro URL
 * ```
 *
 * In a release build it is a no-op unless `enableInRelease` is set.
 */
export function startPerfMonitor(options?: PerfMonitorOptions): void {
  monitor.start(options);
}

export function stopPerfMonitor(): void {
  monitor.stop();
}

/** Tell the monitor which screen is active, so findings can name it. */
export function setScreen(name: string): void {
  monitor.setScreen(name);
}

export function mark(name: string, detail?: unknown): void {
  monitor.mark(name, detail);
}

/** Duration since `mark(startMark ?? name)`, also reported to the daemon. */
export function measure(name: string, startMark?: string, detail?: unknown): number | undefined {
  return monitor.measure(name, startMark, detail);
}

export function reportTTI(screen?: string, durationMs?: number): void {
  monitor.reportTTI(screen, durationMs);
}

export function trackInteraction(name: string, durationMs: number): void {
  monitor.trackInteraction(name, durationMs);
}

export function perfLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, tag?: string): void {
  monitor.log(level, message, tag);
}

export function isPerfMonitorConnected(): boolean {
  return monitor.isConnected;
}

/**
 * Drop-in for React Navigation: pass to `<NavigationContainer onStateChange>`
 * (or call from your own router) to segment metrics by screen.
 *
 * ```tsx
 * <NavigationContainer onStateChange={() => setScreen(navigationRef.getCurrentRoute()?.name ?? '')}>
 * ```
 */
export function createNavigationTracker(getCurrentRouteName: () => string | undefined) {
  let previous: string | undefined;
  let enteredAt = now();
  return () => {
    const name = getCurrentRouteName();
    if (!name || name === previous) return;
    if (previous) monitor.trackInteraction(`navigate:${previous}→${name}`, now() - enteredAt);
    previous = name;
    enteredAt = now();
    monitor.setScreen(name);
  };
}

/* --------------------------------------------------------------- helpers */

function formatVersion(v: { major?: number; minor?: number; patch?: number }): string {
  return `${v.major ?? 0}.${v.minor ?? 0}.${v.patch ?? 0}`;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function warn(message: string): void {
  if (global.__DEV__) console.warn(`[rnperf] ${message}`);
}

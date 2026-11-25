import { NativeModules, Platform, isExpoRuntime } from './rn.js';

declare const global: Record<string, any>;

/** One window of UI-thread frame data, drained from the native module. */
export interface NativeFrameMetrics {
  uiFps?: number;
  frameP50Ms?: number;
  frameP95Ms?: number;
  frameP99Ms?: number;
  jankPercent?: number;
  framesRendered?: number;
  /** The refresh rate the system was actually driving the display at during the window. */
  refreshHz?: number;
  /** The display's maximum refresh rate — 120 on ProMotion hardware. */
  displayMaxHz?: number;
  /** iOS: physical footprint in MB — what Xcode shows, and what jetsam judges. */
  memoryMB?: number;
  /** Android: Java heap in use. */
  javaHeapMB?: number;
  /** Android: native heap allocated. */
  nativeHeapMB?: number;
}

interface NativeModule {
  start(): void;
  stop(): void;
  getMetrics(): Promise<NativeFrameMetrics>;
}

/**
 * Bridge to the optional `RNPerfFrameMonitor` native module.
 *
 * Everything degrades to "no UI-thread data" rather than throwing: the module
 * is absent in Expo Go, in a build where pods were not reinstalled, and on
 * Android (where the daemon reads frame timings from `adb` instead).
 */
export class NativeFrameProbe {
  private module?: NativeModule;
  private started = false;
  private inFlight = false;
  private failures = 0;

  /** Attaches to the native module. Returns false when it is unavailable. */
  attach(): boolean {
    try {
      const candidate = NativeModules.RNPerfFrameMonitor as NativeModule | undefined;
      if (!candidate || typeof candidate.getMetrics !== 'function') return false;
      this.module = candidate;
      return true;
    } catch {
      return false;
    }
  }

  start(): void {
    if (!this.module || this.started) return;
    try {
      this.module.start();
      this.started = true;
    } catch {
      this.module = undefined;
    }
  }

  /**
   * Reads and resets the native window. Returns `{}` when a read is already
   * outstanding, which happens when the JS thread is blocked — precisely when
   * piling up more bridge calls would make things worse.
   */
  async read(): Promise<NativeFrameMetrics> {
    if (!this.module || !this.started || this.inFlight) return {};
    this.inFlight = true;
    try {
      const metrics = await this.module.getMetrics();
      this.failures = 0;
      return metrics ?? {};
    } catch {
      // Three consecutive failures means something is structurally wrong;
      // stop paying for a bridge call every second to rediscover that.
      this.failures += 1;
      if (this.failures >= 3) this.stop();
      return {};
    } finally {
      this.inFlight = false;
    }
  }

  stop(): void {
    if (!this.module) return;
    try {
      if (this.started) this.module.stop();
    } catch {
      // The module is going away regardless.
    }
    this.started = false;
    this.module = undefined;
  }

  get available(): boolean {
    return Boolean(this.module);
  }
}

/** Why UI-thread frame data is unavailable, phrased for a dev-time warning. */
export function explainMissingNativeModule(): string {
  const platform = Platform.OS;

  if (isExpoRuntime()) {
    return 'UI-thread FPS needs the rnperf native module, which Expo Go cannot load. Run `npx expo prebuild` and use a development build.';
  }
  if (platform === 'android') {
    return 'UI-thread FPS needs the rnperf native module. Rebuild the app (`npx react-native run-android`) so autolinking picks it up. Until then, connect the device over adb and the daemon will read frame timings itself.';
  }
  return 'UI-thread FPS needs the rnperf native module. Run `cd ios && pod install`, then rebuild the app.';
}

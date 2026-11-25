export interface Sample {
  t: number;
  dt: number;
  jsFps?: number;
  jsHeapMB?: number;
  jsHeapTotalMB?: number;
  jsStallMaxMs?: number;
  jsStallCount?: number;
  bridgeCalls?: number;
  screen?: string;

  // Filled by the RNPerfSDK native module (iOS only).
  uiFps?: number;
  uiRefreshHz?: number;
  uiDisplayMaxHz?: number;
  frameP50Ms?: number;
  frameP95Ms?: number;
  frameP99Ms?: number;
  jankPercent?: number;
  framesRendered?: number;
  rssMB?: number;
  javaHeapMB?: number;
  nativeHeapMB?: number;
  renders?: Record<string, ComponentRenderStat>;
}

export interface ComponentRenderStat {
  count: number;
  totalMs: number;
  maxMs: number;
  wasted?: number;
  mounts?: number;
  offScreen?: number;
}

export type PerfEvent =
  | { type: 'mark'; t: number; name: string; detail?: unknown }
  | { type: 'measure'; t: number; name: string; durationMs: number; detail?: unknown }
  | { type: 'screen'; t: number; name: string }
  | { type: 'tti'; t: number; durationMs: number; screen?: string }
  | { type: 'log'; t: number; level: 'debug' | 'info' | 'warn' | 'error'; tag?: string; message: string }
  | { type: 'crash'; t: number; message: string; stack?: string }
  | { type: 'interaction'; t: number; name: string; durationMs: number };

export interface PerfMonitorOptions {
  /**
   * Daemon host. `'auto'` (the default) derives it from the Metro bundle URL,
   * which is correct for a simulator, an emulator and a real device on Wi-Fi
   * without any configuration. A release build has no Metro URL, so with
   * `enableInRelease` this must be set explicitly.
   */
  host?: string | 'auto';
  port?: number;
  /** How often to report, in ms. Default 1000. */
  intervalMs?: number;
  /** Track per-component render counts and timings. Default true in dev. */
  trackRenders?: boolean;
  /**
   * Measure UI-thread frames with the rnperf native module (CADisplayLink on
   * iOS, Choreographer on Android). Default true; a no-op where the module is
   * not installed.
   */
  trackUiFrames?: boolean;
  /** Count native module calls crossing the bridge. Default true. */
  trackBridge?: boolean;
  /**
   * Report even in a release build. Default false — profiling has a cost.
   * Requires an explicit `host`. Component renders are unavailable in release;
   * frames, JS fps, stalls, memory, screens and marks all still report.
   */
  enableInRelease?: boolean;
  /** Reported alongside samples so the daemon can match this app to a session. */
  bundleId?: string;
  appName?: string;
  appVersion?: string;
  /** Called on connection state changes, for your own debug UI. */
  onStatus?: (status: 'connecting' | 'connected' | 'disconnected') => void;
}

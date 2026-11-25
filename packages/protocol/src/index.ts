/**
 * Shared wire types between the daemon, the desktop UI, the RN SDK and the MCP server.
 * Everything here is plain JSON-serialisable data.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_DAEMON_PORT = 8139;
/** Where the daemon records the port it actually bound, for local discovery. */
export const DAEMON_LOCKFILE = "daemon.json";

/* ------------------------------------------------------------------ devices */

export type Platform = 'android' | 'ios';

/** How we are able to read numbers off a given device. */
export type MetricSource =
  | 'adb'            // Android, via adb shell
  | 'ios-sim-host'   // iOS simulator, app runs as a host macOS process
  | 'ios-devicectl'  // physical iPhone/iPad, via devicectl + xctrace
  | 'sdk';           // in-app @rnperf/sdk probe

export interface DeviceCapabilities {
  /** Native resident memory of the app process. */
  nativeMemory: boolean;
  /** Process CPU usage. */
  cpu: boolean;
  /** Real rendered-frame timings (UI thread). */
  uiFrames: boolean;
  /** Can enumerate installed apps. */
  listApps: boolean;
  /** Can stream device logs. */
  logs: boolean;
  /** Why something is unavailable, keyed by capability. */
  notes?: Record<string, string>;
}

export interface DeviceInfo {
  id: string;                 // stable id: adb serial, simulator UDID, device UDID
  name: string;
  platform: Platform;
  kind: 'emulator' | 'simulator' | 'physical';
  osVersion?: string;
  model?: string;
  state: 'online' | 'offline' | 'unauthorized' | 'booting';
  source: MetricSource;
  capabilities: DeviceCapabilities;
}

export interface AppInfo {
  bundleId: string;           // package name on Android, bundle id on iOS
  name?: string;
  pid?: number;
  running: boolean;
}

/* ------------------------------------------------------------------ samples */

/**
 * One metrics sample. Every field is optional because different sources fill
 * in different parts; the daemon merges device-side and SDK-side samples that
 * land in the same time bucket.
 */
export interface Sample {
  /** Wall-clock ms since epoch, bucketed to the session sample interval. */
  t: number;
  /** ms since session start. */
  dt: number;

  // --- process level (adb / ps / xctrace)
  cpuPercent?: number;          // % of a single core
  rssMB?: number;               // resident set size
  pssMB?: number;               // Android proportional set size
  javaHeapMB?: number;          // Android Java/Dalvik heap
  nativeHeapMB?: number;        // Android native heap
  graphicsMB?: number;          // Android graphics/GL memory
  threadCpu?: Record<string, number>; // per-thread CPU%, e.g. { mqt_js: 62.4 }

  // --- UI thread frames (Android gfxinfo, or the iOS CADisplayLink module)
  uiFps?: number;
  /** Refresh rate the display was actually driven at, so "janky" is judged against the real budget. */
  uiRefreshHz?: number;
  /** The most the display can do — 120 on ProMotion hardware — when the app reports it separately. */
  uiDisplayMaxHz?: number;
  frameP50Ms?: number;
  frameP95Ms?: number;
  frameP99Ms?: number;
  jankPercent?: number;
  framesRendered?: number;

  // --- JS thread (@rnperf/sdk)
  jsFps?: number;
  jsHeapMB?: number;
  jsHeapTotalMB?: number;
  jsStallMaxMs?: number;        // worst JS event-loop stall in the window
  jsStallCount?: number;
  bridgeCalls?: number;         // native module calls in the window
  screen?: string;              // active screen name, if the app reports one

  /** Renders observed in this window, keyed by component display name. */
  renders?: Record<string, ComponentRenderStat>;
}

export interface ComponentRenderStat {
  count: number;
  /** Sum of React `actualDuration` across those renders, ms. */
  totalMs: number;
  maxMs: number;
  /** Re-renders whose props were shallow-equal to the previous ones; state, store or context drove them. */
  wasted?: number;
  /** How many of `count` were a component appearing for the first time rather than updating. */
  mounts?: number;
  /** How many of `count` happened on a navigation screen that was not the focused one. */
  offScreen?: number;
}

/* ------------------------------------------------------------------ events */

export type PerfEvent =
  | { type: 'mark'; t: number; name: string; detail?: unknown }
  | { type: 'measure'; t: number; name: string; durationMs: number; detail?: unknown }
  | { type: 'screen'; t: number; name: string }
  | { type: 'tti'; t: number; durationMs: number; screen?: string }
  | { type: 'log'; t: number; level: 'debug' | 'info' | 'warn' | 'error'; tag?: string; message: string }
  | { type: 'crash'; t: number; message: string; stack?: string }
  | { type: 'interaction'; t: number; name: string; durationMs: number };

/* ------------------------------------------------------------------ session */

export interface SessionConfig {
  deviceId: string;
  bundleId?: string;
  /** Sample interval in ms. Default 1000. */
  intervalMs?: number;
  label?: string;
  /** Free-form tags, e.g. { build: 'before-memo-fix' } — used by diff_sessions. */
  tags?: Record<string, string>;
}

export interface SessionMeta {
  id: string;
  label: string;
  device: DeviceInfo;
  bundleId?: string;
  startedAt: number;
  endedAt?: number;
  intervalMs: number;
  tags: Record<string, string>;
  sampleCount: number;
  /** Sources that actually produced data during the session. */
  activeSources: MetricSource[];
}

export interface SessionSummary {
  meta: SessionMeta;
  durationMs: number;
  metrics: Record<string, MetricSummary>;
  topComponents: Array<{ name: string } & ComponentRenderStat>;
  screens: Array<{ name: string; enteredAt: number; durationMs: number }>;
  eventCounts: Record<string, number>;
}

export interface MetricSummary {
  samples: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p05: number;
  /** Least-squares slope in units per minute — positive means growing. */
  slopePerMin: number;
  /** R² of that fit, 0..1. */
  fit: number;
}

/* ------------------------------------------------------------------ findings */

export type FindingKind =
  | 'js-fps-low'
  | 'js-thread-stall'
  | 'ui-jank'
  | 'ui-below-display-rate'
  | 'render-storm'
  | 'off-screen-render'
  | 'expensive-render'
  | 'memory-growth'
  | 'high-cpu'
  | 'slow-startup'
  | 'large-list-unvirtualised'
  | 'bridge-chatter';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  title: string;
  /** What was measured, in plain numbers. */
  evidence: string;
  /** Component / screen / thread the finding is attributed to, when known. */
  subject?: string;
  /** Candidate source locations, filled in by locate_component. */
  locations?: SourceLocation[];
  /** Concrete remediation for a coding agent to apply. */
  suggestion: string;
  /** Machine-readable numbers backing the finding. */
  data: Record<string, number | string>;
}

export interface SourceLocation {
  file: string;
  line: number;
  preview: string;
}

/* ------------------------------------------------------------------ diffing */

export interface SessionDiff {
  baseline: string;
  candidate: string;
  metrics: Array<{
    metric: string;
    baseline: number;
    candidate: number;
    delta: number;
    /** Null when the baseline was zero, where a percentage would be meaningless. */
    deltaPercent: number | null;
    /** 'better' | 'worse' | 'same', already accounting for metric direction. */
    verdict: 'better' | 'worse' | 'same';
  }>;
  components: Array<{
    name: string;
    baselineRenders: number;
    candidateRenders: number;
    delta: number;
  }>;
  summary: string;
}

/* ------------------------------------------------------------------ SDK wire */

/** Messages the in-app SDK sends to the daemon over ws://host:8787/ingest */
export type SdkMessage =
  | {
      type: 'hello';
      protocol: number;
      app: { bundleId?: string; name?: string; version?: string };
      platform: Platform;
      deviceName?: string;
      /** RN / Hermes details, shown in the UI. */
      runtime: { rnVersion?: string; hermes: boolean; dev: boolean };
      startedAt: number;
    }
  | { type: 'sample'; sample: Sample }
  | { type: 'event'; event: PerfEvent }
  | { type: 'bye' };

/** Messages the daemon sends back to the SDK. */
export type DaemonMessage =
  | { type: 'welcome'; clientId: string; intervalMs: number }
  | { type: 'config'; intervalMs?: number; trackRenders?: boolean }
  | { type: 'ping' };

/* ------------------------------------------------------------------ UI push */

/** Live stream pushed to the desktop UI over ws://localhost:8787/live */
export type LiveMessage =
  | { type: 'devices'; devices: DeviceInfo[] }
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'sample'; sessionId: string; sample: Sample }
  | { type: 'event'; sessionId: string; event: PerfEvent }
  | { type: 'session-started'; meta: SessionMeta }
  | { type: 'session-ended'; meta: SessionMeta }
  | { type: 'session-updated'; meta: SessionMeta }
  | { type: 'session-deleted'; sessionId: string }
  | { type: 'sdk-connected'; clientId: string; app: string; platform: Platform }
  | { type: 'sdk-disconnected'; clientId: string }
  | { type: 'error'; message: string };

/* ------------------------------------------------------------------ helpers */

export const METRIC_DIRECTION: Record<string, 'higher-is-better' | 'lower-is-better'> = {
  jsFps: 'higher-is-better',
  uiFps: 'higher-is-better',
  framesRendered: 'higher-is-better',
  cpuPercent: 'lower-is-better',
  rssMB: 'lower-is-better',
  pssMB: 'lower-is-better',
  javaHeapMB: 'lower-is-better',
  nativeHeapMB: 'lower-is-better',
  graphicsMB: 'lower-is-better',
  jsHeapMB: 'lower-is-better',
  jsHeapTotalMB: 'lower-is-better',
  jsStallMaxMs: 'lower-is-better',
  jsStallCount: 'lower-is-better',
  frameP50Ms: 'lower-is-better',
  frameP95Ms: 'lower-is-better',
  frameP99Ms: 'lower-is-better',
  jankPercent: 'lower-is-better',
  bridgeCalls: 'lower-is-better',
};

export const METRIC_LABELS: Record<string, string> = {
  jsFps: 'JS FPS',
  uiFps: 'UI FPS',
  cpuPercent: 'CPU %',
  rssMB: 'Memory (RSS)',
  pssMB: 'Memory (PSS)',
  javaHeapMB: 'Java heap',
  nativeHeapMB: 'Native heap',
  graphicsMB: 'Graphics memory',
  jsHeapMB: 'JS heap used',
  jsHeapTotalMB: 'JS heap total',
  jsStallMaxMs: 'Worst JS stall',
  jsStallCount: 'JS stalls',
  frameP50Ms: 'Frame time p50',
  frameP95Ms: 'Frame time p95',
  frameP99Ms: 'Frame time p99',
  jankPercent: 'Janky frames',
  bridgeCalls: 'Bridge calls',
  framesRendered: 'Frames rendered',
  uiRefreshHz: 'Display refresh rate',
  uiDisplayMaxHz: 'Display maximum refresh rate',
};

export const METRIC_UNITS: Record<string, string> = {
  jsFps: 'fps', uiFps: 'fps', cpuPercent: '%',
  rssMB: 'MB', pssMB: 'MB', javaHeapMB: 'MB', nativeHeapMB: 'MB',
  graphicsMB: 'MB', jsHeapMB: 'MB', jsHeapTotalMB: 'MB',
  jsStallMaxMs: 'ms', jsStallCount: '', frameP50Ms: 'ms',
  frameP95Ms: 'ms', frameP99Ms: 'ms', jankPercent: '%',
  bridgeCalls: '', framesRendered: '', uiRefreshHz: 'Hz', uiDisplayMaxHz: 'Hz',
};

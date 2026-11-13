import type { PerfEvent, Sample } from '@rnperf/protocol';

export interface CollectorContext {
  deviceId: string;
  bundleId?: string;
  /** Emit an out-of-band event (log line, crash, screen change). */
  emit: (event: PerfEvent) => void;
  /** Non-fatal problem worth surfacing in the UI once. */
  warn: (message: string) => void;
}

export interface Collector {
  readonly name: string;
  /** Called once before the first tick. May resolve to false to opt out. */
  start(): Promise<boolean>;
  /** One sampling tick. Return only the fields this collector owns. */
  tick(): Promise<Partial<Sample>>;
  stop(): Promise<void>;
}

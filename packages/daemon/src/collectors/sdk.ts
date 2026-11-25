import type { Sample } from '@rnperf/protocol';
import { round } from '../util/stats.js';
import type { Collector, CollectorContext } from './types.js';

/**
 * Passive collector: the in-app @rnperf/sdk pushes samples over the ingest
 * WebSocket and they are buffered here until the session's next tick, so SDK
 * data merges into the same timeline as device-side data.
 */
export class SdkCollector implements Collector {
  readonly name = 'sdk';
  private pending: Partial<Sample>[] = [];
  private seen = false;

  constructor(private readonly ctx: CollectorContext) {}

  async start(): Promise<boolean> {
    return true;
  }

  push(sample: Partial<Sample>): void {
    this.seen = true;
    this.pending.push(sample);
  }

  get hasData(): boolean {
    return this.seen;
  }

  async tick(): Promise<Partial<Sample>> {
    if (this.pending.length === 0) return {};
    const batch = this.pending;
    this.pending = [];
    return mergeSdkSamples(batch);
  }

  async stop(): Promise<void> {
    this.pending = [];
  }
}

type AvgKey =
  | 'jsFps' | 'jsHeapMB' | 'jsHeapTotalMB' | 'uiFps' | 'jankPercent'
  | 'rssMB' | 'javaHeapMB' | 'nativeHeapMB';
type MaxKey = 'jsStallMaxMs' | 'frameP50Ms' | 'frameP95Ms' | 'frameP99Ms';
type SumKey = 'jsStallCount' | 'bridgeCalls' | 'framesRendered';
type LastKey = 'uiRefreshHz' | 'uiDisplayMaxHz';

/**
 * Several SDK samples can arrive inside one daemon tick. Rates are averaged,
 * worst-case numbers take the max, and counts add up.
 */
export function mergeSdkSamples(batch: Partial<Sample>[]): Partial<Sample> {
  if (batch.length === 1) return { ...batch[0] };
  const out: Partial<Sample> = {};
  const values = (key: keyof Sample): number[] =>
    batch.map((s) => s[key]).filter((v): v is number => typeof v === 'number');

  const avg = (key: AvgKey) => {
    const vals = values(key);
    // Averaging reintroduces float noise the SDK had already rounded away,
    // which then shows up verbatim in findings and charts.
    if (vals.length) out[key] = round(vals.reduce((a, b) => a + b, 0) / vals.length, 2);
  };
  const max = (key: MaxKey) => {
    const vals = values(key);
    if (vals.length) out[key] = Math.max(...vals);
  };
  const sum = (key: SumKey) => {
    const vals = values(key);
    if (vals.length) out[key] = vals.reduce((a, b) => a + b, 0);
  };
  const last = (key: LastKey) => {
    const vals = values(key);
    if (vals.length) out[key] = vals[vals.length - 1];
  };

  // Rates and levels average; worst-case numbers take the maximum; counts add.
  avg('jsFps'); avg('jsHeapMB'); avg('jsHeapTotalMB');
  avg('uiFps'); avg('jankPercent');
  // Memory from the in-app module. When a cable is attached the device-side
  // collector runs after this one and its reading wins, which is what we want:
  // dumpsys sees proportional set size, the app can only see its own heaps.
  avg('rssMB'); avg('javaHeapMB'); avg('nativeHeapMB');
  // Tail latencies must not be averaged down — the p95 of a window that
  // contained a stutter is the number that matters.
  max('jsStallMaxMs'); max('frameP50Ms'); max('frameP95Ms'); max('frameP99Ms');
  sum('jsStallCount'); sum('bridgeCalls'); sum('framesRendered');
  last('uiRefreshHz'); last('uiDisplayMaxHz');

  const lastScreen = [...batch].reverse().find((s) => s.screen)?.screen;
  if (lastScreen) out.screen = lastScreen;

  const renders: NonNullable<Sample['renders']> = {};
  for (const s of batch) {
    for (const [name, stat] of Object.entries(s.renders ?? {})) {
      const existing = renders[name];
      if (!existing) {
        renders[name] = { ...stat };
      } else {
        existing.count += stat.count;
        existing.totalMs += stat.totalMs;
        existing.maxMs = Math.max(existing.maxMs, stat.maxMs);
        if (stat.wasted !== undefined) existing.wasted = (existing.wasted ?? 0) + stat.wasted;
      }
    }
  }
  if (Object.keys(renders).length) out.renders = renders;
  return out;
}

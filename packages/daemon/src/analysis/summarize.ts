import type {
  ComponentRenderStat, PerfEvent, Sample, SessionMeta, SessionSummary,
} from '@rnperf/protocol';
import { summarise } from '../util/stats.js';

const NUMERIC_KEYS = [
  'cpuPercent', 'rssMB', 'pssMB', 'javaHeapMB', 'nativeHeapMB', 'graphicsMB',
  'uiFps', 'frameP50Ms', 'frameP95Ms', 'frameP99Ms', 'jankPercent', 'framesRendered',
  'jsFps', 'jsHeapMB', 'jsHeapTotalMB', 'jsStallMaxMs', 'jsStallCount', 'bridgeCalls',
] as const;

export type NumericMetric = (typeof NUMERIC_KEYS)[number];
export const METRIC_KEYS: readonly NumericMetric[] = NUMERIC_KEYS;

export function buildSummary(
  meta: SessionMeta,
  samples: Sample[],
  events: PerfEvent[],
): SessionSummary {
  const metrics: SessionSummary['metrics'] = {};
  for (const key of NUMERIC_KEYS) {
    const points = samples
      .filter((s) => typeof s[key] === 'number' && Number.isFinite(s[key]))
      .map((s) => ({ x: s.dt, y: s[key] as number }));
    if (points.length >= 2) metrics[key] = summarise(points);
  }

  const topComponents = aggregateRenders(samples)
    .sort((a, b) => b.totalMs - a.totalMs || b.count - a.count)
    .slice(0, 25);

  const eventCounts: Record<string, number> = {};
  for (const e of events) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;

  const durationMs = (meta.endedAt ?? Date.now()) - meta.startedAt;

  return {
    meta,
    durationMs,
    metrics,
    topComponents,
    screens: buildScreenTimeline(samples, events, durationMs),
    eventCounts,
  };
}

export function aggregateRenders(samples: Sample[]): Array<{ name: string } & ComponentRenderStat> {
  const acc = new Map<string, ComponentRenderStat>();
  for (const s of samples) {
    for (const [name, stat] of Object.entries(s.renders ?? {})) {
      const existing = acc.get(name);
      if (!existing) {
        acc.set(name, { ...stat });
      } else {
        existing.count += stat.count;
        existing.totalMs += stat.totalMs;
        existing.maxMs = Math.max(existing.maxMs, stat.maxMs);
        if (stat.wasted !== undefined) existing.wasted = (existing.wasted ?? 0) + stat.wasted;
        if (stat.mounts !== undefined) existing.mounts = (existing.mounts ?? 0) + stat.mounts;
        if (stat.offScreen !== undefined) existing.offScreen = (existing.offScreen ?? 0) + stat.offScreen;
      }
    }
  }
  return [...acc.entries()].map(([name, stat]) => ({ name, ...stat }));
}

/** Turns screen markers into contiguous spans, so metrics can be attributed. */
export function buildScreenTimeline(
  samples: Sample[],
  events: PerfEvent[],
  durationMs: number,
): Array<{ name: string; enteredAt: number; durationMs: number }> {
  const marks: Array<{ name: string; at: number }> = [];
  const base = samples[0]?.t ?? events[0]?.t ?? 0;

  for (const e of events) {
    if (e.type === 'screen') marks.push({ name: e.name, at: Math.max(0, e.t - base) });
  }
  for (const s of samples) {
    if (!s.screen) continue;
    if (marks[marks.length - 1]?.name === s.screen) continue;
    marks.push({ name: s.screen, at: s.dt });
  }
  marks.sort((a, b) => a.at - b.at);

  const spans: Array<{ name: string; enteredAt: number; durationMs: number }> = [];
  for (let i = 0; i < marks.length; i += 1) {
    const cur = marks[i]!;
    if (spans[spans.length - 1]?.name === cur.name) continue;
    const end = marks[i + 1]?.at ?? durationMs;
    spans.push({ name: cur.name, enteredAt: cur.at, durationMs: Math.max(0, end - cur.at) });
  }
  return spans;
}

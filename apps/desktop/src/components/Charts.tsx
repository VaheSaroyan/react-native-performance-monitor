import {
  Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { Sample } from '@rnperf/protocol';

export interface Series {
  key: keyof Sample & string;
  label: string;
  color: string;
  unit: string;
  domain?: [number, number];
  /**
   * The value this metric must stay under (frame times) or over (frame rates).
   * Drawing it makes the chart answer "is this acceptable?" rather than only
   * "what was the number?".
   */
  threshold?: { value: number; label: string; side: 'above-is-bad' | 'below-is-bad' };
}

const fmt = (n: number): string =>
  Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sortedAsc[lo]!;
  const b = sortedAsc[hi]!;
  return lo === hi ? a : a + (b - a) * (pos - lo);
}

export function MetricChart({
  samples, series, live,
}: {
  samples: Sample[];
  series: Series;
  /** While recording, the headline is the current value; afterwards it summarises the run. */
  live?: boolean;
}) {
  const data = samples
    .filter((s) => typeof s[series.key] === 'number')
    .map((s) => ({ dt: s.dt / 1000, value: s[series.key] as number }));

  const threshold = series.threshold;
  const values = data.map((d) => d.value);
  const sorted = [...values].sort((a, b) => a - b);

  /*
   * A finished recording reports the figure that actually tests the budget —
   * the tail for latency, the floor for frame rates — because the last sample
   * of a run says nothing about how it went. While recording, the current
   * value is what the person is watching for.
   */
  let headline: number | null = null;
  let headlineLabel = '';
  if (values.length) {
    if (live) {
      headline = values[values.length - 1]!;
    } else if (threshold?.side === 'above-is-bad') {
      headline = quantile(sorted, 0.95);
      headlineLabel = 'p95';
    } else if (threshold?.side === 'below-is-bad') {
      headline = quantile(sorted, 0.05);
      headlineLabel = 'worst';
    } else {
      headline = quantile(sorted, 0.5);
      headlineLabel = 'median';
    }
  }

  // Colour the readout by whether that figure is acceptable, so the number
  // carries its own verdict.
  let readoutColor = series.color;
  if (threshold && headline !== null) {
    const bad = threshold.side === 'above-is-bad' ? headline > threshold.value : headline < threshold.value;
    readoutColor = bad ? 'var(--bad)' : 'var(--ok)';
  }

  const max = sorted.length ? sorted[sorted.length - 1]! : 0;

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="chart-title">{series.label}</span>
        {threshold && <span className="chart-budget">{threshold.label}</span>}
        <span className="chart-now" style={{ color: readoutColor }}>
          {headlineLabel && <em>{headlineLabel} </em>}
          {headline === null ? '—' : `${fmt(headline)}${series.unit}`}
        </span>
      </div>
      <div style={{ height: 132 }}>
        {data.length < 2 ? (
          <div className="chart-empty">waiting for data</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 14, bottom: 4, left: 4 }}>
              <defs>
                <linearGradient id={`g-${series.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={series.color} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={series.color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--line-soft)" vertical={false} />
              <XAxis
                dataKey="dt" tick={{ fill: 'var(--ink-faint)', fontSize: 10 }}
                tickLine={false} axisLine={{ stroke: 'var(--line)' }}
                tickFormatter={(v: number) => `${Math.round(v)}s`} minTickGap={28}
              />
              <YAxis
                domain={series.domain ?? ['auto', 'auto']}
                tick={{ fill: 'var(--ink-faint)', fontSize: 10 }}
                tickLine={false} axisLine={false} width={42} tickFormatter={fmt}
              />

              {/* The region that misses the budget, shaded before the trace is
                  drawn so the trace stays legible on top of it. */}
              {threshold && threshold.side === 'above-is-bad' && max > threshold.value && (
                <ReferenceArea
                  y1={threshold.value} y2={Math.max(max, threshold.value)}
                  fill="var(--bad)" fillOpacity={0.07} stroke="none"
                />
              )}
              {threshold && threshold.side === 'below-is-bad' && (
                <ReferenceArea
                  y1={0} y2={threshold.value}
                  fill="var(--bad)" fillOpacity={0.07} stroke="none"
                />
              )}
              {threshold && (
                <ReferenceLine
                  y={threshold.value} stroke="var(--bad)" strokeOpacity={0.5}
                  strokeDasharray="3 3" strokeWidth={1}
                />
              )}

              <Tooltip
                contentStyle={{
                  background: 'var(--raised)', border: '1px solid var(--line)',
                  borderRadius: 7, fontSize: 11.5, fontFamily: 'var(--num)',
                }}
                labelFormatter={(v) => `t+${fmt(Number(v))}s`}
                formatter={(v: number) => [`${fmt(v)}${series.unit}`, series.label]}
              />
              <Area
                type="monotone" dataKey="value" stroke={series.color} strokeWidth={1.5}
                fill={`url(#g-${series.key})`} isAnimationActive={false} dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

/**
 * Picks the charts this session can actually draw, and gives each one the
 * budget it is judged against. The refresh rate comes from the device when the
 * app reports it, so a 120Hz phone is held to 8.3ms rather than 16.7ms.
 */
function lastNumber(samples: Sample[], key: 'uiRefreshHz' | 'uiDisplayMaxHz'): number | undefined {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const value = samples[index][key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

export function chartsFor(samples: Sample[]): Series[] {
  // The rate the display was last driven at, not the first one seen: an adaptive
  // display changes rate mid-recording, and the latest reading is the one the
  // newest frames were judged against.
  const refreshHz = lastNumber(samples, 'uiRefreshHz') ?? 60;
  const displayMaxHz = lastNumber(samples, 'uiDisplayMaxHz');
  const budgetMs = Math.round((1000 / refreshHz) * 100) / 100;
  const capped = displayMaxHz !== undefined && Math.round(displayMaxHz) > Math.round(refreshHz);
  const rateLabel = capped
    ? `running at ${Math.round(refreshHz)}Hz of ${Math.round(displayMaxHz)}Hz`
    : `${Math.round(refreshHz)}Hz display`;
  const budgetLabel = `${budgetMs}ms budget · ${Math.round(refreshHz)}Hz`;

  const all: Series[] = [
    {
      key: 'jsFps', label: 'JS thread', color: 'var(--m-js)', unit: ' fps',
      domain: [0, Math.max(60, refreshHz)],
      threshold: { value: 45, label: '45 fps floor', side: 'below-is-bad' },
    },
    {
      key: 'uiFps', label: 'UI thread', color: 'var(--m-ui)', unit: ' fps',
      domain: [0, Math.max(60, refreshHz, displayMaxHz ?? 0)],
      threshold: { value: refreshHz * 0.9, label: rateLabel, side: 'below-is-bad' },
    },
    {
      key: 'frameP95Ms', label: 'Frame time p95', color: 'var(--m-ui)', unit: ' ms',
      threshold: { value: budgetMs, label: budgetLabel, side: 'above-is-bad' },
    },
    {
      key: 'frameP99Ms', label: 'Frame time p99', color: 'var(--m-ui)', unit: ' ms',
      threshold: { value: budgetMs, label: budgetLabel, side: 'above-is-bad' },
    },
    {
      key: 'jankPercent', label: 'Frames over budget', color: 'var(--bad)', unit: '%',
      domain: [0, 100],
      threshold: { value: 10, label: '10% tolerance', side: 'above-is-bad' },
    },
    {
      key: 'jsStallMaxMs', label: 'Worst JS stall', color: 'var(--bad)', unit: ' ms',
      threshold: { value: budgetMs, label: budgetLabel, side: 'above-is-bad' },
    },
    { key: 'cpuPercent', label: 'CPU', color: 'var(--m-cpu)', unit: '%' },
    { key: 'rssMB', label: 'Memory, resident', color: 'var(--m-mem)', unit: ' MB' },
    { key: 'pssMB', label: 'Memory, proportional', color: 'var(--m-mem)', unit: ' MB' },
    { key: 'jsHeapMB', label: 'JS heap', color: 'var(--m-heap)', unit: ' MB' },
    { key: 'javaHeapMB', label: 'Java heap', color: 'var(--m-heap)', unit: ' MB' },
    { key: 'nativeHeapMB', label: 'Native heap', color: 'var(--m-heap)', unit: ' MB' },
  ];

  return all.filter((s) => samples.some((sample) => typeof sample[s.key] === 'number'));
}

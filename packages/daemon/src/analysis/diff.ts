import { METRIC_DIRECTION, METRIC_LABELS, METRIC_UNITS, type SessionDiff, type SessionSummary } from '@rnperf/protocol';
import { round } from '../util/stats.js';

/** Changes smaller than this are noise, not a result. */
const NOISE_PERCENT = 5;

/**
 * Compares two sessions so a fix can be judged. Uses p50 for rates and p95 for
 * latency-style metrics, because a median frame time hides exactly the tail
 * that users feel.
 */
export function diffSessions(baseline: SessionSummary, candidate: SessionSummary): SessionDiff {
  const metrics: SessionDiff['metrics'] = [];
  const keys = new Set([...Object.keys(baseline.metrics), ...Object.keys(candidate.metrics)]);

  for (const key of [...keys].sort()) {
    const b = baseline.metrics[key];
    const c = candidate.metrics[key];
    if (!b || !c) continue;

    const useTail = /Ms$|jank|Stall/i.test(key);
    const bv = useTail ? b.p95 : b.p50;
    const cv = useTail ? c.p95 : c.p50;
    const delta = cv - bv;
    // A percentage against a zero baseline is noise dressed as precision;
    // callers render the absolute change instead when this is null.
    const deltaPercent = bv === 0 ? (cv === 0 ? 0 : null) : (delta / Math.abs(bv)) * 100;

    const higherIsBetter = METRIC_DIRECTION[key] === 'higher-is-better';
    let verdict: 'better' | 'worse' | 'same' = 'same';
    const moved = deltaPercent === null ? delta !== 0 : Math.abs(deltaPercent) >= NOISE_PERCENT;
    if (moved) {
      verdict = (delta > 0) === higherIsBetter ? 'better' : 'worse';
    }

    metrics.push({
      metric: key,
      baseline: round(bv, 2),
      candidate: round(cv, 2),
      delta: round(delta, 2),
      deltaPercent: deltaPercent === null ? null : round(deltaPercent, 1),
      verdict,
    });
  }

  const componentMap = new Map<string, { baselineRenders: number; candidateRenders: number }>();
  for (const c of baseline.topComponents) {
    componentMap.set(c.name, { baselineRenders: c.count, candidateRenders: 0 });
  }
  for (const c of candidate.topComponents) {
    const entry = componentMap.get(c.name) ?? { baselineRenders: 0, candidateRenders: 0 };
    entry.candidateRenders = c.count;
    componentMap.set(c.name, entry);
  }

  const components = [...componentMap.entries()]
    .map(([name, v]) => ({ name, ...v, delta: v.candidateRenders - v.baselineRenders }))
    .filter((c) => c.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 20);

  return {
    baseline: baseline.meta.id,
    candidate: candidate.meta.id,
    metrics,
    components,
    summary: describe(metrics, components, baseline, candidate),
  };
}

function describe(
  metrics: SessionDiff['metrics'],
  components: SessionDiff['components'],
  baseline: SessionSummary,
  candidate: SessionSummary,
): string {
  const better = metrics.filter((m) => m.verdict === 'better');
  const worse = metrics.filter((m) => m.verdict === 'worse');
  const lines: string[] = [];

  const durationNote =
    Math.abs(baseline.durationMs - candidate.durationMs) > Math.max(baseline.durationMs, candidate.durationMs) * 0.5
      ? ' Run lengths differ by more than 50%, so treat cumulative counts with caution.'
      : '';

  /*
   * Comparing runs that measured different things produces confident nonsense:
   * a component that "gained" 80,000 renders usually just means the in-app SDK
   * was connected for one run and not the other. Say so before anything else.
   */
  const baseSources = new Set(baseline.meta.activeSources);
  const candSources = new Set(candidate.meta.activeSources);
  const onlyBase = [...baseSources].filter((x) => !candSources.has(x));
  const onlyCand = [...candSources].filter((x) => !baseSources.has(x));
  const sourceWarning = onlyBase.length || onlyCand.length
    ? `These runs did not measure the same things: ${
        onlyBase.length ? `${onlyBase.join(' and ')} only in the before run` : ''
      }${onlyBase.length && onlyCand.length ? ', ' : ''}${
        onlyCand.length ? `${onlyCand.join(' and ')} only in the after run` : ''
      }. Differences below may reflect that rather than any change you made.`
    : '';

  if (sourceWarning) lines.push(sourceWarning);

  if (better.length === 0 && worse.length === 0) {
    lines.push(`No metric moved more than ${NOISE_PERCENT}% — this change is within noise.${durationNote}`);
  } else {
    const fmt = (m: SessionDiff['metrics'][number]) => {
      const unit = METRIC_UNITS[m.metric] ?? '';
      const label = METRIC_LABELS[m.metric] ?? m.metric;
      const sign = m.delta > 0 ? '+' : '';
      const change = m.deltaPercent === null
        ? 'no baseline to compare against'
        : `${sign}${m.deltaPercent}%`;
      return `${label} ${m.baseline}${unit} → ${m.candidate}${unit} (${change})`;
    };
    if (better.length) lines.push(`Improved: ${better.map(fmt).join('; ')}.`);
    if (worse.length) lines.push(`Regressed: ${worse.map(fmt).join('; ')}.`);
    lines.push(durationNote.trim());
  }

  const dropped = components.filter((c) => c.delta < 0).slice(0, 3);
  const added = components.filter((c) => c.delta > 0).slice(0, 3);
  if (dropped.length) {
    lines.push(
      `Fewer renders: ${dropped.map((c) => `${c.name} ${c.baselineRenders}→${c.candidateRenders}`).join(', ')}.`,
    );
  }
  if (added.length) {
    lines.push(
      `More renders: ${added.map((c) => `${c.name} ${c.baselineRenders}→${c.candidateRenders}`).join(', ')}.`,
    );
  }

  return lines.filter(Boolean).join(' ');
}

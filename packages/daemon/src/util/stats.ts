import type { MetricSummary } from '@rnperf/protocol';

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sortedAsc[lo]!;
  const b = sortedAsc[hi]!;
  return lo === hi ? a : a + (b - a) * (pos - lo);
}

/**
 * Least-squares fit of value against time, returning slope in units/minute and
 * the R² of the fit. Used to tell a genuine leak (steady climb, high R²) from
 * normal allocation churn (noisy, low R²).
 */
export function trend(points: Array<{ x: number; y: number }>): { slopePerMin: number; fit: number } {
  const n = points.length;
  if (n < 3) return { slopePerMin: 0, fit: 0 };
  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of points) {
    const dx = p.x - mx, dy = p.y - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0) return { slopePerMin: 0, fit: 0 };
  const slopePerMs = sxy / sxx;
  const fit = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slopePerMin: slopePerMs * 60_000, fit: Math.max(0, Math.min(1, fit)) };
}

export function summarise(points: Array<{ x: number; y: number }>): MetricSummary {
  const values = points.map((p) => p.y);
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const { slopePerMin, fit } = trend(points);
  return {
    samples: values.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: values.length ? sum / values.length : 0,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p05: quantile(sorted, 0.05),
    slopePerMin,
    fit,
  };
}

export const round = (n: number, places = 2): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

import {
  METRIC_LABELS, METRIC_UNITS,
  type Finding, type SessionDiff, type SessionSummary,
} from '@rnperf/protocol';

const round = (n: number, p = 1): number => Math.round(n * 10 ** p) / 10 ** p;

/**
 * Findings are rendered as text rather than raw JSON: the agent reading this
 * needs the reasoning and the remediation, and a wall of numbers buries both.
 */
export function formatFindings(findings: Finding[], summary: SessionSummary): string {
  const head =
    `Session ${summary.meta.id} — ${summary.meta.label}\n` +
    `${summary.meta.device.name} (${summary.meta.device.platform}, ${summary.meta.device.kind})` +
    `${summary.meta.bundleId ? ` · ${summary.meta.bundleId}` : ''}\n` +
    `${round(summary.durationMs / 1000)}s, ${summary.meta.sampleCount} samples, ` +
    `sources: ${summary.meta.activeSources.join(' + ') || 'none'}`;

  if (findings.length === 0) {
    return `${head}\n\nNo findings — nothing crossed a threshold.\n\n${formatMetricTable(summary)}`;
  }

  const body = findings
    .map((f, i) => {
      const lines = [
        `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}`,
        `   evidence: ${f.evidence}`,
      ];
      if (f.subject) lines.push(`   subject: ${f.subject}`);
      for (const loc of f.locations ?? []) {
        lines.push(`   source: ${loc.file}:${loc.line}  ${loc.preview}`);
      }
      lines.push(`   fix: ${f.suggestion}`);
      return lines.join('\n');
    })
    .join('\n\n');

  return `${head}\n\n${findings.length} finding(s), most severe first:\n\n${body}\n\n${formatMetricTable(summary)}`;
}

export function formatMetricTable(summary: SessionSummary): string {
  const rows = Object.entries(summary.metrics);
  if (rows.length === 0) return 'No metrics were captured.';

  const lines = ['Metrics (p50 / p95 / min / max, trend per minute):'];
  for (const [key, stat] of rows) {
    const unit = METRIC_UNITS[key] ?? '';
    const label = (METRIC_LABELS[key] ?? key).padEnd(18);
    const trend =
      Math.abs(stat.slopePerMin) > 0.01 && stat.fit > 0.5
        ? `  ${stat.slopePerMin > 0 ? '↑' : '↓'}${Math.abs(round(stat.slopePerMin, 2))}${unit}/min (R²=${round(stat.fit, 2)})`
        : '';
    lines.push(
      `  ${label} ${round(stat.p50)}${unit} / ${round(stat.p95)}${unit} / ` +
      `${round(stat.min)}${unit} / ${round(stat.max)}${unit}${trend}`,
    );
  }

  if (summary.topComponents.length) {
    lines.push('', 'Top components by render cost:');
    for (const c of summary.topComponents.slice(0, 10)) {
      lines.push(
        `  ${c.name.padEnd(24)} ${c.count} renders, ${round(c.totalMs)}ms total, ` +
        `${round(c.totalMs / Math.max(c.count, 1), 2)}ms avg` +
        (c.wasted ? `, ${c.wasted} with unchanged props` : ''),
      );
    }
  }

  if (summary.screens.length) {
    lines.push('', 'Screens:');
    for (const s of summary.screens) {
      lines.push(`  ${s.name.padEnd(24)} ${round(s.durationMs / 1000)}s`);
    }
  }

  return lines.join('\n');
}

export function formatDiff(diff: SessionDiff): string {
  const lines = [
    `Baseline ${diff.baseline} → candidate ${diff.candidate}`,
    '',
    diff.summary,
    '',
    'Metric                baseline    candidate    change',
  ];
  for (const m of diff.metrics) {
    const unit = METRIC_UNITS[m.metric] ?? '';
    const marker = m.verdict === 'better' ? '✓' : m.verdict === 'worse' ? '✗' : ' ';
    lines.push(
      `${marker} ${(METRIC_LABELS[m.metric] ?? m.metric).padEnd(18)} ` +
      `${String(m.baseline + unit).padStart(10)} ${String(m.candidate + unit).padStart(12)} ` +
      `${String(m.deltaPercent === null ? 'n/a' : (m.delta > 0 ? '+' : '') + m.deltaPercent + '%').padStart(10)}`,
    );
  }
  if (diff.components.length) {
    lines.push('', 'Render count changes:');
    for (const c of diff.components) {
      lines.push(
        `  ${c.name.padEnd(24)} ${c.baselineRenders} → ${c.candidateRenders} ` +
        `(${c.delta > 0 ? '+' : ''}${c.delta})`,
      );
    }
  }
  return lines.join('\n');
}

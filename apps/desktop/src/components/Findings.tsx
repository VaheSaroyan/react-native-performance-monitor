import type { Finding, SessionSummary, Severity } from '@rnperf/protocol';

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

/** Renders `backtick` spans in a suggestion as inline code. */
function withCode(body: string) {
  return body.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith('`') && part.endsWith('`')
      ? <code key={i}>{part.slice(1, -1)}</code>
      : <span key={i}>{part}</span>,
  );
}

export function countsBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/**
 * The first thing shown when a run ends. It answers "how bad, and what kind"
 * before any individual finding is read.
 */
export function Verdict({
  findings, summary,
}: {
  findings: Finding[];
  summary: SessionSummary;
}) {
  const counts = countsBySeverity(findings);
  const worst = ORDER.find((s) => counts[s] > 0);
  const seconds = Math.round(summary.durationMs / 1000);
  const sources = summary.meta.activeSources.join(' and ') || 'no sources';

  const headline = !worst
    ? 'Nothing crossed a threshold'
    : worst === 'critical'
      ? 'Users would feel this'
      : worst === 'high'
        ? 'Noticeable problems'
        : 'Worth tidying up';

  return (
    <div className={`verdict ${worst ?? 'clear'}`}>
      <div>
        <div className="verdict-head">{headline}</div>
        <div className="verdict-sub">
          {seconds}s on {summary.meta.device.name}, measured by {sources}
          {summary.meta.bundleId ? `, ${summary.meta.bundleId}` : ''}
        </div>
      </div>
      {findings.length > 0 && (
        <div className="sev-counts">
          {ORDER.filter((s) => counts[s] > 0).map((s) => (
            <div className={`sev ${s}`} key={s}>
              <b className="num">{counts[s]}</b>
              <span>{s}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FindingsList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return (
      <div className="card">
        <h3>No findings</h3>
        <p style={{ color: 'var(--ink-dim)', fontSize: 12.5 }}>
          Nothing crossed a threshold during this run. Findings come from what actually happened
          while recording, so exercise the screen you suspect and record for longer — a leak needs
          at least 45 seconds before it can be told apart from start-up allocation.
        </p>
      </div>
    );
  }

  return (
    <div>
      {findings.map((f, i) => (
        <div key={`${f.kind}-${f.subject ?? i}`} className={`finding ${f.severity}`}>
          <div className="finding-head">
            <span className="finding-rank">{String(i + 1).padStart(2, '0')}</span>
            <span className="finding-title">{f.title}</span>
            {f.subject && <span className="finding-where">{f.subject}</span>}
          </div>
          <div className="finding-evidence">{f.evidence}</div>
          {f.locations && f.locations.length > 0 && (
            <div className="locs">
              {f.locations.map((l) => (
                <span className="loc" key={`${l.file}:${l.line}`}>{l.file}:{l.line}</span>
              ))}
            </div>
          )}
          <div className="finding-fix">{withCode(f.suggestion)}</div>
        </div>
      ))}
    </div>
  );
}

export function ComponentTable({ summary }: { summary: SessionSummary }) {
  const rows = summary.topComponents.slice(0, 12);
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.totalMs), 1);

  return (
    <div className="card">
      <h3>Where render time went</h3>
      <table>
        <thead>
          <tr>
            <th>Component</th>
            <th style={{ textAlign: 'right' }}>Renders</th>
            <th style={{ textAlign: 'right' }}>No prop change</th>
            <th style={{ textAlign: 'right' }}>Average</th>
            <th style={{ textAlign: 'right' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.name}>
              <td>
                {c.name}
                <div className="bar" style={{ width: `${(c.totalMs / max) * 100}%` }} />
              </td>
              <td className="n">{c.count}</td>
              <td className="n" style={{ color: c.wasted ? 'var(--warn)' : 'var(--ink-faint)' }}>
                {c.wasted ?? 0}
              </td>
              <td className="n">{(c.totalMs / Math.max(c.count, 1)).toFixed(2)}ms</td>
              <td className="n">{c.totalMs.toFixed(0)}ms</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="notes">
        A render with no prop change did no useful work. A high count there points at a missing{' '}
        <b>React.memo</b>, or a callback prop that gets a new identity on every parent render.
        React Native&rsquo;s own components are listed for context but never reported as findings —
        the fix belongs to whatever renders them.
      </div>
    </div>
  );
}

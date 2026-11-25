import { useEffect, useRef, useState } from 'react';
import type { SessionMeta, Severity } from '@rnperf/protocol';

interface RecordingRowProps {
  session: SessionMeta;
  active: boolean;
  tally?: Record<Severity, number>;
  onSelect: () => void;
  onRename: (label: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

/** How long the delete button stays armed before it falls back to a plain button. */
const CONFIRM_MS = 3500;

/**
 * One recording in the sidebar. Renaming happens in place, and deleting takes a
 * second click on the same button: a recording cannot be brought back, but a
 * modal for every clean-up would make clearing out a long list tedious.
 */
export function RecordingRow({ session, active, tally, onSelect, onRename, onDelete }: RecordingRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.label);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  const startEditing = () => {
    setDraft(session.label);
    setConfirming(false);
    setEditing(true);
  };

  const commit = async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === session.label) return;
    setBusy(true);
    try {
      await onRename(next);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      await onDelete();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const live = !session.endedAt;

  return (
    <div className={`row recording ${active ? 'active' : ''} ${confirming ? 'confirming' : ''}`} onClick={onSelect}>
      <span className={`dot ${live ? 'rec' : ''}`} />
      <div className="row-main">
        {editing ? (
          <input
            ref={input}
            className="row-rename"
            aria-label="Recording name"
            value={draft}
            maxLength={120}
            onChange={(event) => setDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commit();
              if (event.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <div className="row-title" title={session.label} onDoubleClick={(event) => { event.stopPropagation(); startEditing(); }}>
            {session.label}
          </div>
        )}
        <div className="row-sub">
          {new Date(session.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          {live ? ', recording' : `, ${formatDuration(session.endedAt! - session.startedAt)}`}
        </div>
      </div>
      {tally && !editing && (
        <span className="tally">
          {(['critical', 'high', 'medium'] as Severity[]).flatMap((severity) =>
            Array.from({ length: Math.min(tally[severity], 3) }, (_, index) => (
              <i className={severity} key={`${severity}-${index}`} />
            )),
          )}
        </span>
      )}
      {!editing && (
        <span className="row-actions" onClick={(event) => event.stopPropagation()}>
          {!confirming && (
            <button className="quiet" disabled={busy} onClick={startEditing} title="Rename">
              Rename
            </button>
          )}
          <button
            className={confirming ? 'stop' : 'quiet'}
            disabled={busy}
            onClick={() => void remove()}
            title={live ? 'Stop and delete this recording' : 'Delete this recording'}
          >
            {confirming ? 'Delete?' : 'Delete'}
          </button>
        </span>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

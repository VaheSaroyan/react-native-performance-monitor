import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AppInfo, DeviceInfo, Finding, LiveMessage, Sample, SessionDiff, SessionMeta, SessionSummary, Severity,
} from '@rnperf/protocol';
import { METRIC_LABELS, METRIC_UNITS } from '@rnperf/protocol';
import { api, resolvePort, useLiveStream, useSampleBuffer } from './api';
import { MetricChart, chartsFor } from './components/Charts';
import { ComponentTable, FindingsList, Verdict, countsBySeverity } from './components/Findings';

type View =
  | { kind: 'welcome' }
  | { kind: 'device'; deviceId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'compare' };

type StoredSession = SessionMeta & { live?: boolean };

export default function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [view, setView] = useState<View>({ kind: 'welcome' });
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  const [sdkApps, setSdkApps] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  /** Severity tallies per session, so the sidebar can triage without opening each. */
  const [tallies, setTallies] = useState<Record<string, Record<Severity, number>>>({});

  const { samples, push, reset } = useSampleBuffer(liveSessionId);

  const refreshSessions = useCallback(() => {
    api.sessions().then(({ sessions: list }) => setSessions(list)).catch(() => {});
  }, []);

  const handleMessage = useCallback((message: LiveMessage) => {
    switch (message.type) {
      case 'devices': setDevices(message.devices); break;
      case 'sessions': refreshSessions(); break;
      case 'sample': if (message.sessionId === liveSessionId) push(message.sample); break;
      case 'session-started':
      case 'session-ended': refreshSessions(); break;
      case 'sdk-connected': setSdkApps((a) => [...new Set([...a, message.app])]); break;
      case 'sdk-disconnected': setSdkApps([]); break;
      case 'error': setNotice(message.message); break;
      default: break;
    }
  }, [liveSessionId, push, refreshSessions]);

  const { connected } = useLiveStream(handleMessage);

  useEffect(() => {
    api.devices(true).then(({ devices: d }) => setDevices(d)).catch(() => {});
    refreshSessions();
    api.health().then((h) => setProjectRoot(h.projectRoot)).catch(() => {});
  }, [refreshSessions]);

  // Tally findings for finished sessions so the list can show severity inline.
  useEffect(() => {
    const pending = sessions.filter((s) => s.endedAt && !tallies[s.id]).slice(0, 12);
    if (pending.length === 0) return;
    let cancelled = false;
    void Promise.all(
      pending.map(async (s) => {
        const { findings } = await api.findings(s.id).catch(() => ({ findings: [] as Finding[] }));
        return [s.id, countsBySeverity(findings)] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setTallies((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => { cancelled = true; };
  }, [sessions, tallies]);

  const selectedDevice = view.kind === 'device' ? devices.find((d) => d.id === view.deviceId) : undefined;

  const startRecording = async (deviceId: string, bundleId: string | undefined, label: string) => {
    reset();
    const { session } = await api.startSession({ deviceId, bundleId, label });
    setLiveSessionId(session.id);
    setView({ kind: 'session', sessionId: session.id });
    refreshSessions();
  };

  const stopRecording = async (sessionId: string) => {
    await api.stopSession(sessionId).catch(() => {});
    setLiveSessionId(null);
    setTallies((prev) => { const next = { ...prev }; delete next[sessionId]; return next; });
    refreshSessions();
  };

  const chooseProjectRoot = async () => {
    const picked = await window.rnperf?.pickProjectRoot();
    if (!picked) return;
    try {
      const { projectRoot: accepted } = await api.setProjectRoot(picked);
      setProjectRoot(accepted);
      setNotice(null);
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const finished = sessions.filter((s) => s.endedAt);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="titlebar">React Native performance</div>
        <div className="sidebar-scroll">
          <div className="group">
            <h2>Devices</h2>
            <button
              className="quiet" style={{ padding: '1px 6px', fontSize: 11 }}
              onClick={() => api.devices(true).then(({ devices: d }) => setDevices(d)).catch(() => {})}
            >
              Rescan
            </button>
          </div>
          {devices.length === 0 && (
            <div className="hint">
              Nothing connected. Start an emulator or simulator, or plug in a phone.
            </div>
          )}
          {devices.map((d) => (
            <div
              key={d.id}
              className={`row ${view.kind === 'device' && view.deviceId === d.id ? 'active' : ''}`}
              onClick={() => setView({ kind: 'device', deviceId: d.id })}
            >
              <span className={`dot ${d.state === 'online' ? 'on' : ''}`} />
              <div className="row-main">
                <div className="row-title">{d.name}</div>
                <div className="row-sub">{d.osVersion ?? d.platform}, {d.kind}</div>
              </div>
            </div>
          ))}

          <div className="group">
            <h2>Recordings</h2>
            {finished.length >= 2 && (
              <button
                className="quiet" style={{ padding: '1px 6px', fontSize: 11 }}
                onClick={() => setView({ kind: 'compare' })}
              >
                Compare
              </button>
            )}
          </div>
          {sessions.length === 0 && <div className="hint">No recordings yet.</div>}
          {sessions.slice(0, 40).map((s) => {
            const tally = tallies[s.id];
            return (
              <div
                key={s.id}
                className={`row ${view.kind === 'session' && view.sessionId === s.id ? 'active' : ''}`}
                onClick={() => {
                  setView({ kind: 'session', sessionId: s.id });
                  if (s.id !== liveSessionId) setLiveSessionId(s.endedAt ? null : s.id);
                }}
              >
                <span className={`dot ${!s.endedAt ? 'rec' : ''}`} />
                <div className="row-main">
                  <div className="row-title">{s.label}</div>
                  <div className="row-sub">
                    {new Date(s.startedAt).toLocaleTimeString()}
                    {s.endedAt ? `, ${Math.round((s.endedAt - s.startedAt) / 1000)}s` : ', recording'}
                  </div>
                </div>
                {tally && (
                  <span className="tally">
                    {(['critical', 'high', 'medium'] as Severity[]).flatMap((sev) =>
                      Array.from({ length: Math.min(tally[sev], 3) }, (_, i) => (
                        <i className={sev} key={`${sev}-${i}`} />
                      )),
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      <main className="main">
        {view.kind === 'welcome' && <Welcome projectRoot={projectRoot} onPickRoot={chooseProjectRoot} />}
        {view.kind === 'device' && selectedDevice && (
          <DeviceView device={selectedDevice} onStart={startRecording} />
        )}
        {view.kind === 'session' && (
          <SessionView
            sessionId={view.sessionId}
            isLive={liveSessionId === view.sessionId}
            samples={samples}
            onStop={() => stopRecording(view.sessionId)}
          />
        )}
        {view.kind === 'compare' && <CompareView sessions={finished} />}

        <div className="status">
          <span className={connected ? 'live' : 'off'}>
            {connected ? 'Daemon running' : 'Daemon unreachable'}
          </span>
          <span className="num">port {resolvePort()}</span>
          <span>{sdkApps.length ? `SDK: ${sdkApps.join(', ')}` : 'No app SDK connected'}</span>
          <span className="spacer" />
          {notice && <span className="off">{notice}</span>}
          <button className="quiet" onClick={chooseProjectRoot}>
            {projectRoot ? `Project: ${projectRoot.split('/').slice(-2).join('/')}` : 'Set project folder'}
          </button>
        </div>
      </main>
    </div>
  );
}

/* ----------------------------------------------------------- welcome */

function Welcome({ projectRoot, onPickRoot }: { projectRoot: string | null; onPickRoot: () => void }) {
  return (
    <>
      <div className="topbar"><h1>Start measuring</h1></div>
      <div className="content">
        <div className="blank">
          <h2>Pick a device to record from</h2>
          <p>
            CPU and memory come straight off the device. Frame rates, JS stalls and which components
            re-render need the SDK running inside your app.
          </p>
          <div className="steps">
            <div className="step">
              <span className="k">1</span>
              <span>Choose a device on the left, pick the app, and <b>start recording</b>.</span>
            </div>
            <div className="step">
              <span className="k">2</span>
              <span>Add <code>@rnperf/sdk</code> to your app and call <code>startPerfMonitor()</code> at
                startup to see the JS thread and UI frames.</span>
            </div>
            <div className="step">
              <span className="k">3</span>
              <span>Use the app the way a user would, then stop. You get ranked problems with the
                files to change.</span>
            </div>
            <div className="step">
              <span className="k">4</span>
              <span>Fix something, record again, and <b>compare</b> the two runs to confirm it worked.</span>
            </div>
          </div>
          <div className="actions">
            <button className="primary" onClick={onPickRoot}>
              {projectRoot ? 'Change project folder' : 'Set project folder'}
            </button>
          </div>
          {!projectRoot && (
            <p style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 10 }}>
              Setting the folder lets findings name the file and line to edit.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------ device */

function DeviceView({
  device, onStart,
}: {
  device: DeviceInfo;
  onStart: (deviceId: string, bundleId: string | undefined, label: string) => Promise<void>;
}) {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [bundleId, setBundleId] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setApps(null);
    setBundleId('');
    if (device.state !== 'online') return;
    api.apps(device.id).then(({ apps: list }) => {
      setApps(list);
      const running = list.find((a) => a.running);
      if (running) setBundleId(running.bundleId);
    }).catch(() => setApps([]));
  }, [device.id, device.state]);

  const selected = apps?.find((a) => a.bundleId === bundleId);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{device.name}</h1>
          <div className="sub">{device.osVersion ?? device.platform}, {device.kind}</div>
        </div>
        <span className="spacer" />
        <button
          className="primary"
          disabled={busy || device.state !== 'online'}
          onClick={async () => {
            setBusy(true);
            try {
              await onStart(device.id, bundleId || undefined, selected?.name ?? bundleId ?? device.name);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Starting' : 'Start recording'}
        </button>
      </div>
      <div className="content">
        <div className="toolbar">
          <label htmlFor="app-select">App to measure</label>
          <select id="app-select" value={bundleId} onChange={(e) => setBundleId(e.target.value)}>
            <option value="">None — SDK data only</option>
            {(apps ?? []).map((a) => (
              <option key={a.bundleId} value={a.bundleId}>
                {a.running ? 'Running — ' : ''}{a.name ? `${a.name} — ` : ''}{a.bundleId}
              </option>
            ))}
          </select>
          {bundleId && !selected?.running && (
            <button onClick={() => api.launch(device.id, bundleId).catch(() => {})}>Launch it</button>
          )}
          {apps === null && device.state === 'online' && (
            <span style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>Loading apps</span>
          )}
        </div>

        <div className="card">
          <h3>What this device can measure</h3>
          <table>
            <tbody>
              {capabilityRows(device).map((row) => (
                <tr key={row.label}>
                  <td style={{ width: 170 }}>{row.label}</td>
                  <td style={{ color: row.tone, whiteSpace: 'nowrap' }}>{row.status}</td>
                  <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="notes">
            <b>From the device</b> means the daemon reads it over adb, simctl or xctrace with no changes
            to your app. The rest come from <b>@rnperf/sdk</b> running inside it, which is the only way
            to see the JS thread at all — and on iOS the only way to see UI frames, since Apple exposes
            those solely through an Instruments trace.
          </div>
        </div>
      </div>
    </>
  );
}

interface CapabilityRow { label: string; status: string; tone: string; note: string }

/**
 * One row per metric, saying where it actually comes from. The device's own
 * capability flags describe only what is readable from outside the app, so
 * reporting them raw made UI frames look unavailable on iOS even though the
 * SDK's native module measures them.
 */
function capabilityRows(device: DeviceInfo): CapabilityRow[] {
  const notes = device.capabilities.notes ?? {};
  const fromDevice = (ok: boolean, note?: string) =>
    ok
      ? { status: 'From the device', tone: 'var(--ok)', note: note ?? '' }
      : { status: 'Not available', tone: 'var(--ink-faint)', note: note ?? '' };
  const viaSdk = (note: string) => ({ status: 'Via the app SDK', tone: 'var(--accent)', note });

  return [
    { label: 'CPU usage', ...fromDevice(device.capabilities.cpu, notes['cpu']) },
    { label: 'Native memory', ...fromDevice(device.capabilities.nativeMemory, notes['nativeMemory']) },
    {
      label: 'UI frames and jank',
      ...(device.capabilities.uiFrames
        ? fromDevice(true, notes['uiFrames'])
        : viaSdk(
            device.platform === 'ios'
              ? 'Apple exposes Core Animation frame stats only through an Instruments trace, so the SDK measures them in the app with CADisplayLink. Run pod install and rebuild.'
              : 'Measured in the app with Choreographer, for when no cable is attached. Rebuild so autolinking picks it up.',
          )),
    },
    { label: 'JS frames, stalls, renders', ...viaSdk('Only visible from inside the app. Call startPerfMonitor() at startup.') },
    {
      label: 'App memory',
      ...viaSdk(device.platform === 'ios'
        ? 'Physical footprint every second, the figure Xcode shows.'
        : 'Java and native heap every second.'),
    },
    { label: 'Installed apps', ...fromDevice(device.capabilities.listApps, notes['listApps']) },
    {
      label: 'Logs',
      ...(device.capabilities.logs
        ? fromDevice(true, notes['logs'])
        : {
            status: 'App logs only',
            tone: 'var(--accent)',
            note: notes['logs'] ?? 'System logs need Console.app or idevicesyslog. The SDK forwards your app’s own logs and crashes.',
          }),
    },
  ];
}

/* ----------------------------------------------------------- session */

function SessionView({
  sessionId, isLive, samples, onStop,
}: {
  sessionId: string; isLive: boolean; samples: Sample[]; onStop: () => void;
}) {
  // A finished run opens on its verdict; a live one opens on the trace.
  const [tab, setTab] = useState<'findings' | 'charts'>(isLive ? 'charts' : 'findings');
  const [analysis, setAnalysis] = useState<{ findings: Finding[]; summary: SessionSummary } | null>(null);
  const [stored, setStored] = useState<Sample[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setTab(isLive ? 'charts' : 'findings'); }, [isLive, sessionId]);

  useEffect(() => {
    setAnalysis(null);
    setStored([]);
    setLoading(true);
    Promise.all([api.findings(sessionId), api.samples(sessionId, true)])
      .then(([a, s]) => { setAnalysis(a); setStored(s.samples); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sessionId, isLive]);

  const shown = isLive && samples.length ? samples : stored.length ? stored : samples;
  const series = useMemo(() => chartsFor(shown), [shown]);

  // Device-side collectors see only CPU and memory. When nothing is reporting
  // from inside the app, most charts are simply absent, and the gap is worth
  // naming rather than leaving the reader to wonder.
  const hasSdkData = useMemo(
    () => shown.some((s) =>
      typeof s.jsFps === 'number' || typeof s.uiFps === 'number' ||
      typeof s.jsHeapMB === 'number' || s.renders !== undefined),
    [shown],
  );

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{analysis?.summary.meta.label ?? 'Recording'}</h1>
          <div className="sub">
            {isLive ? `Recording, ${shown.length} samples so far` : `${shown.length} samples`}
          </div>
        </div>
        <span className="spacer" />
        <div className="seg">
          <button className={tab === 'findings' ? 'active' : ''} onClick={() => setTab('findings')}>
            Problems{analysis ? ` (${analysis.findings.length})` : ''}
          </button>
          <button className={tab === 'charts' ? 'active' : ''} onClick={() => setTab('charts')}>
            Trace
          </button>
        </div>
        {isLive && <button className="stop" onClick={onStop}>Stop</button>}
      </div>

      <div className="content">
        {tab === 'findings' ? (
          loading && !analysis ? (
            <div className="blank"><p>Reading the recording</p></div>
          ) : analysis ? (
            <>
              <Verdict findings={analysis.findings} summary={analysis.summary} />
              <FindingsList findings={analysis.findings} />
              <ComponentTable summary={analysis.summary} />
            </>
          ) : (
            <div className="blank"><p>No analysis for this recording.</p></div>
          )
        ) : series.length === 0 ? (
          <div className="blank">
            <h2>No measurements yet</h2>
            <p>
              Waiting for the first sample. If the app is not running on the device, launch it —
              CPU and memory need a live process.
            </p>
          </div>
        ) : (
          <>
            <div className="chart-grid">
              {series.map((s) => <MetricChart key={s.key} samples={shown} series={s} live={isLive} />)}
            </div>
            {!hasSdkData && <SdkMissingNote platform={analysis?.summary.meta.device.platform} />}
          </>
        )}
      </div>
    </>
  );
}

/**
 * Shown when a recording has only device-side data. Names what is missing and
 * the one step that produces it, rather than leaving an unexplained gap.
 */
function SdkMissingNote({ platform }: { platform?: string }) {
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3>Only CPU and memory were recorded</h3>
      <p style={{ fontSize: 12.5, color: 'var(--ink-dim)', lineHeight: 1.65 }}>
        Those are the only measurements readable from outside the app. Frame rates, dropped frames,
        JS thread stalls, heap and per-component render counts all come from the SDK running inside
        it — and without them this recording cannot produce findings.
      </p>
      <div className="steps" style={{ marginTop: 12 }}>
        <div className="step">
          <span className="k">1</span>
          <span>Install the SDK: <code>npm pack -w @rnperf/sdk</code>, then install that tarball in
            your app.</span>
        </div>
        <div className="step">
          <span className="k">2</span>
          <span>Call <code>startPerfMonitor()</code> at your entry point, before the root component.</span>
        </div>
        <div className="step">
          <span className="k">3</span>
          <span>
            {platform === 'android'
              ? 'Rebuild the app so autolinking picks up the native frame module.'
              : 'Run pod install and rebuild. Expo Go cannot load the native module; a development build can.'}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- compare */

/**
 * The "did my fix work" view. The daemon already diffs two runs; without this
 * the feature was reachable only from the MCP tools.
 */
function CompareView({ sessions }: { sessions: StoredSession[] }) {
  const [baseline, setBaseline] = useState(sessions[1]?.id ?? '');
  const [candidate, setCandidate] = useState(sessions[0]?.id ?? '');
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!baseline || !candidate || baseline === candidate) return;
    setBusy(true); setError(null);
    try {
      const { diff: d } = await api.diff(baseline, candidate);
      setDiff(d);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const label = (id: string) => sessions.find((s) => s.id === id)?.label ?? id;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Compare two runs</h1>
          <div className="sub">Changes under 5% are treated as noise</div>
        </div>
      </div>
      <div className="content">
        <div className="cmp-pick">
          <label htmlFor="base">Before</label>
          <select id="base" value={baseline} onChange={(e) => setBaseline(e.target.value)}>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <label htmlFor="cand">After</label>
          <select id="cand" value={candidate} onChange={(e) => setCandidate(e.target.value)}>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <button className="primary" onClick={run} disabled={busy || baseline === candidate}>
            {busy ? 'Comparing' : 'Compare'}
          </button>
        </div>

        {baseline === candidate && (
          <div className="hint" style={{ padding: 0, marginBottom: 12 }}>
            Pick two different runs.
          </div>
        )}
        {error && <div className="card" style={{ marginBottom: 12 }}>{error}</div>}

        {diff && (
          <>
            <div className="card">
              <h3>{label(diff.baseline)} → {label(diff.candidate)}</h3>
              <p style={{ fontSize: 12.5, color: 'var(--ink-dim)', lineHeight: 1.65 }}>{diff.summary}</p>
            </div>

            <div className="card">
              <h3>Metrics</h3>
              <div className="cmp-row" style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                <span>Metric</span>
                <span style={{ textAlign: 'right' }}>Before</span>
                <span style={{ textAlign: 'right' }}>After</span>
                <span style={{ textAlign: 'right' }}>Change</span>
              </div>
              {diff.metrics.map((m) => {
                const unit = METRIC_UNITS[m.metric] ?? '';
                return (
                  <div className="cmp-row" key={m.metric}>
                    <span className="cmp-metric">{METRIC_LABELS[m.metric] ?? m.metric}</span>
                    <span className="cmp-val">{m.baseline}{unit}</span>
                    <span className="cmp-val">{m.candidate}{unit}</span>
                    <span className={`cmp-delta ${m.verdict}`}>
                      {m.verdict === 'same'
                        ? 'no change'
                        : m.deltaPercent === null
                          // No baseline to divide by, so show the absolute move.
                          ? `${m.delta > 0 ? '+' : ''}${m.delta}${unit}`
                          : `${m.delta > 0 ? '+' : ''}${m.deltaPercent}%`}
                    </span>
                  </div>
                );
              })}
            </div>

            {diff.components.length > 0 && (
              <div className="card">
                <h3>Render counts</h3>
                {diff.components.map((c) => (
                  <div className="cmp-row" key={c.name}>
                    <span className="cmp-metric">{c.name}</span>
                    <span className="cmp-val">{c.baselineRenders}</span>
                    <span className="cmp-val">{c.candidateRenders}</span>
                    <span className={`cmp-delta ${c.delta < 0 ? 'better' : 'worse'}`}>
                      {c.delta > 0 ? '+' : ''}{c.delta}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {!diff && !busy && (
          <div className="blank">
            <h2>Prove the fix worked</h2>
            <p>
              Record once before your change and once after, driving the app the same way both times.
              This shows which metrics moved and which components stopped re-rendering.
            </p>
          </div>
        )}
      </div>
    </>
  );
}

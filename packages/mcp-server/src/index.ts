#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type {
  AppInfo, DeviceInfo, Finding, PerfEvent, Sample, SessionDiff, SessionMeta, SessionSummary, SourceLocation,
} from '@rnperf/protocol';
import { DaemonClient } from './client.js';
import { formatDiff, formatFindings, formatMetricTable } from './format.js';

const client = new DaemonClient();

// Stamped in by the bundler from package.json. Running straight from source
// there is nothing to stamp, and the release also ships the bundle as a lone
// .mjs with no manifest beside it to read — so a literal is the only form that
// survives every way this server is started.
declare const __RNPERF_VERSION__: string | undefined;
const version = typeof __RNPERF_VERSION__ === 'string' ? __RNPERF_VERSION__ : 'dev';

const server = new McpServer({ name: 'rnperf', version });

const text = (body: string) => ({ content: [{ type: 'text' as const, text: body }] });

/* ------------------------------------------------------------- devices */

server.registerTool(
  'list_devices',
  {
    title: 'List devices',
    description:
      'List every connected Android device/emulator, booted iOS simulator and paired physical iPhone/iPad, ' +
      'with what each one can measure. Call this first — every other tool needs a device id.',
    inputSchema: {},
  },
  async () => {
    const { devices } = await client.get<{ devices: DeviceInfo[] }>('/api/devices?refresh=1');
    if (devices.length === 0) {
      return text(
        'No devices found.\n\n' +
        'Start an Android emulator or iOS simulator, or connect a device over USB. ' +
        'For a physical iPhone, make sure it is paired and trusted in Xcode.',
      );
    }
    const lines = devices.map((d) => {
      const caps = Object.entries(d.capabilities)
        .filter(([k, v]) => k !== 'notes' && v === true)
        .map(([k]) => k);
      const notes = Object.entries(d.capabilities.notes ?? {}).map(([k, v]) => `      ! ${k}: ${v}`);
      return [
        `${d.state === 'online' ? '●' : '○'} ${d.name}  [${d.id}]`,
        `      ${d.platform} ${d.osVersion ?? ''} · ${d.kind} · source: ${d.source} · state: ${d.state}`,
        `      measures: ${caps.join(', ') || 'nothing directly'}`,
        ...notes,
      ].join('\n');
    });
    return text(
      `${devices.length} device(s) — connected via ${client.describeMode}:\n\n${lines.join('\n\n')}\n\n` +
      'For JS FPS, JS stalls and per-component render counts on any device, install @rnperf/sdk in the app under test.',
    );
  },
);

server.registerTool(
  'list_apps',
  {
    title: 'List apps on a device',
    description: 'List installed user apps on a device, marking which are currently running. Use it to find the bundle id to profile.',
    inputSchema: { deviceId: z.string().describe('Device id from list_devices') },
  },
  async ({ deviceId }) => {
    const { apps } = await client.get<{ apps: AppInfo[] }>(`/api/devices/${encodeURIComponent(deviceId)}/apps`);
    if (apps.length === 0) return text(`No user apps found on ${deviceId}.`);
    const lines = apps.map(
      (a) => `${a.running ? '●' : '○'} ${a.bundleId}${a.name ? `  (${a.name})` : ''}${a.pid ? `  pid ${a.pid}` : ''}`,
    );
    return text(`Apps on ${deviceId} (● = running):\n\n${lines.join('\n')}`);
  },
);

server.registerTool(
  'launch_app',
  {
    title: 'Launch an app',
    description: 'Launch an app on a device, so a session can be recorded against a freshly started process.',
    inputSchema: {
      deviceId: z.string().describe('Device id from list_devices'),
      bundleId: z.string().describe('Package name (Android) or bundle id (iOS)'),
    },
  },
  async ({ deviceId, bundleId }) => {
    const { launched } = await client.post<{ launched: boolean }>(
      `/api/devices/${encodeURIComponent(deviceId)}/launch`, { bundleId },
    );
    return text(launched ? `Launched ${bundleId} on ${deviceId}.` : `Could not launch ${bundleId} on ${deviceId}.`);
  },
);

/* ------------------------------------------------------------ sessions */

server.registerTool(
  'start_session',
  {
    title: 'Start a recording session',
    description:
      'Begin recording performance metrics from a device. Returns a session id immediately and keeps ' +
      'recording in the background — drive the app (or ask the user to), then call stop_session. ' +
      'Use `tags` to label a run, e.g. { build: "before-memo-fix" }, so diff_sessions can compare them later.',
    inputSchema: {
      deviceId: z.string().describe('Device id from list_devices'),
      bundleId: z.string().optional().describe('App to measure. Required for CPU/memory from the device itself.'),
      label: z.string().optional().describe('Human-readable name for this run'),
      intervalMs: z.number().optional().describe('Sample interval in ms, default 1000'),
      tags: z.record(z.string()).optional().describe('Arbitrary key/value tags, e.g. { build: "baseline" }'),
    },
  },
  async (args) => {
    const { session } = await client.post<{ session: SessionMeta }>('/api/sessions', args);
    return text(
      `Started session ${session.id} ("${session.label}") on ${session.device.name}.\n\n` +
      `Sampling every ${session.intervalMs}ms. Exercise the app now — scroll the lists, navigate between ` +
      `screens, run the interaction you care about — then call stop_session with id ${session.id}.\n\n` +
      (session.bundleId
        ? ''
        : 'No bundleId was given, so only SDK data will be collected. Pass bundleId to also get CPU and memory from the device.'),
    );
  },
);

server.registerTool(
  'stop_session',
  {
    title: 'Stop a recording session',
    description: 'Stop recording and return the analysis: ranked findings with suggested fixes, plus the metric summary.',
    inputSchema: { sessionId: z.string() },
  },
  async ({ sessionId }) => {
    await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/stop`);
    const { findings, summary } = await client.get<{ findings: Finding[]; summary: SessionSummary }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/findings`,
    );
    return text(formatFindings(findings, summary));
  },
);

server.registerTool(
  'list_sessions',
  {
    title: 'List recorded sessions',
    description: 'List every recorded session, newest first, with its tags — use this to find ids for diff_sessions.',
    inputSchema: { limit: z.number().optional().describe('Default 20') },
  },
  async ({ limit }) => {
    const { sessions } = await client.get<{ sessions: Array<SessionMeta & { live?: boolean }> }>('/api/sessions');
    const shown = sessions.slice(0, limit ?? 20);
    if (shown.length === 0) return text('No sessions recorded yet. Use start_session to record one.');
    const lines = shown.map((s) => {
      const duration = s.endedAt ? `${Math.round((s.endedAt - s.startedAt) / 1000)}s` : 'recording…';
      const tags = Object.entries(s.tags ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
      return `${s.live ? '●' : ' '} ${s.id}  ${new Date(s.startedAt).toLocaleString()}  ${duration.padStart(10)}  ` +
             `${s.device.name} · ${s.label}${tags ? `  [${tags}]` : ''}`;
    });
    return text(`${sessions.length} session(s):\n\n${lines.join('\n')}`);
  },
);

/* ------------------------------------------------------------ analysis */

server.registerTool(
  'get_findings',
  {
    title: 'Get findings and suggested fixes',
    description:
      'The main analysis tool. Returns ranked performance problems for a session — dropped frames, JS thread ' +
      'stalls, memory growth, re-render storms, slow renders — each with the measurements behind it, the ' +
      'source files involved, and a concrete React Native fix. Works on a live session too.',
    inputSchema: {
      sessionId: z.string(),
      locate: z.boolean().optional().describe('Resolve component names to source files, default true'),
    },
  },
  async ({ sessionId, locate }) => {
    const query = locate === false ? '?locate=0' : '';
    const { findings, summary } = await client.get<{ findings: Finding[]; summary: SessionSummary }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/findings${query}`,
    );
    return text(formatFindings(findings, summary));
  },
);

server.registerTool(
  'get_session_summary',
  {
    title: 'Get a session metric summary',
    description: 'Statistical summary of a session: p50/p95/min/max and per-minute trend for every metric, plus the heaviest components and screens visited.',
    inputSchema: { sessionId: z.string() },
  },
  async ({ sessionId }) => {
    const { summary } = await client.get<{ summary: SessionSummary }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/summary`,
    );
    return text(
      `Session ${summary.meta.id} — ${summary.meta.label}\n` +
      `${summary.meta.device.name} · ${Math.round(summary.durationMs / 1000)}s · ` +
      `${summary.meta.sampleCount} samples\n\n${formatMetricTable(summary)}`,
    );
  },
);

server.registerTool(
  'get_metrics',
  {
    title: 'Get raw metric samples',
    description:
      'Raw time-series samples for a session, for spotting a spike at a specific moment rather than an aggregate. ' +
      'Prefer get_findings or get_session_summary unless you need the individual points.',
    inputSchema: {
      sessionId: z.string(),
      metrics: z.array(z.string()).optional().describe('Metric keys to include, e.g. ["jsFps","rssMB"]. Default: all.'),
      limit: z.number().optional().describe('Most recent N samples, default 120'),
    },
  },
  async ({ sessionId, metrics, limit }) => {
    const { samples } = await client.get<{ samples: Sample[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/samples?full=1&limit=${limit ?? 120}`,
    );
    if (samples.length === 0) return text(`No samples recorded for session ${sessionId}.`);
    const filtered = samples.map((s) => {
      if (!metrics?.length) return s;
      const picked: Record<string, unknown> = { dt: s.dt };
      const row = s as unknown as Record<string, unknown>;
      for (const key of metrics) if (key in row) picked[key] = row[key];
      return picked;
    });
    return text(
      `${filtered.length} sample(s) from session ${sessionId} (dt is ms since session start):\n\n` +
      JSON.stringify(filtered, null, 1),
    );
  },
);

server.registerTool(
  'diff_sessions',
  {
    title: 'Compare two sessions',
    description:
      'Compare a baseline session against a candidate to decide whether a fix actually worked. Reports each ' +
      'metric as better/worse/unchanged (changes under 5% are treated as noise) and shows which components ' +
      'now render more or less often. Record the two sessions the same way for a fair comparison.',
    inputSchema: {
      baseline: z.string().describe('Session id recorded before the change'),
      candidate: z.string().describe('Session id recorded after the change'),
    },
  },
  async ({ baseline, candidate }) => {
    const { diff } = await client.post<{ diff: SessionDiff }>('/api/diff', { baseline, candidate });
    return text(formatDiff(diff));
  },
);

server.registerTool(
  'get_logs',
  {
    title: 'Get logs and events from a session',
    description: 'Log lines, crashes, screen changes, marks and TTI events captured during a session.',
    inputSchema: {
      sessionId: z.string(),
      types: z.array(z.string()).optional().describe('Event types: log, crash, screen, mark, measure, tti, interaction'),
      level: z.enum(['debug', 'info', 'warn', 'error']).optional().describe('Minimum log level'),
      limit: z.number().optional().describe('Default 100'),
    },
  },
  async ({ sessionId, types, level, limit }) => {
    const query = new URLSearchParams();
    if (types?.length) query.set('types', types.join(','));
    query.set('limit', String(limit ?? 100));
    const { events } = await client.get<{ events: PerfEvent[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?${query}`,
    );
    const order = { debug: 0, info: 1, warn: 2, error: 3 };
    const filtered = level
      ? events.filter((e) => e.type !== 'log' || order[e.level] >= order[level])
      : events;
    if (filtered.length === 0) return text(`No matching events in session ${sessionId}.`);
    const lines = filtered.map((e) => {
      const ts = new Date(e.t).toLocaleTimeString();
      switch (e.type) {
        case 'log': return `${ts} [${e.level}] ${e.tag ? `${e.tag}: ` : ''}${e.message}`;
        case 'crash': return `${ts} [CRASH] ${e.message}\n${e.stack ?? ''}`;
        case 'screen': return `${ts} → screen ${e.name}`;
        case 'tti': return `${ts} TTI ${e.durationMs}ms${e.screen ? ` (${e.screen})` : ''}`;
        case 'measure': return `${ts} measure ${e.name} ${e.durationMs}ms`;
        case 'mark': return `${ts} mark ${e.name}`;
        case 'interaction': return `${ts} interaction ${e.name} ${e.durationMs}ms`;
      }
    });
    return text(lines.join('\n'));
  },
);

server.registerTool(
  'locate_component',
  {
    title: 'Find a component in the project',
    description:
      'Resolve a component name from a finding to the file and line where it is declared, optionally with ' +
      'surrounding source. Use it before editing a component a finding points at.',
    inputSchema: {
      name: z.string().describe('Component display name, e.g. ProductCard'),
      context: z.boolean().optional().describe('Include surrounding source lines, default true'),
      root: z.string().optional().describe('Project root to search; defaults to the configured project root'),
    },
  },
  async ({ name, context, root }) => {
    const result = await client.post<{
      locations: Array<SourceLocation & { context?: { startLine: number; text: string } | null }>;
      root: string;
    }>('/api/locate', { name, root, context: context !== false });

    if (result.locations.length === 0) {
      return text(
        `No declaration of \`${name}\` found under ${result.root}.\n\n` +
        'If the project lives elsewhere, call set_project_root first, or pass `root`.',
      );
    }
    const blocks = result.locations.map((l) => {
      const header = `${l.file}:${l.line}\n${l.preview}`;
      return l.context ? `${header}\n\n--- context from line ${l.context.startLine} ---\n${l.context.text}` : header;
    });
    return text(`\`${name}\` in ${result.root}:\n\n${blocks.join('\n\n────────\n\n')}`);
  },
);

server.registerTool(
  'set_project_root',
  {
    title: 'Set the project root',
    description: 'Point the daemon at the React Native project directory, so findings can be traced to source files.',
    inputSchema: { projectRoot: z.string().describe('Absolute path to the React Native project') },
  },
  async ({ projectRoot }) => {
    const result = await client.post<{ projectRoot: string }>('/api/config', { projectRoot });
    return text(`Project root set to ${result.projectRoot}. Findings will now resolve component names to files there.`);
  },
);

/* --------------------------------------------------------------- start */

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

const shutdown = async () => {
  await client.shutdown().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

void main().catch((err) => {
  console.error('[rnperf-mcp]', err);
  process.exit(1);
});

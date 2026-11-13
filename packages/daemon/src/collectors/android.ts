import type { Sample } from '@rnperf/protocol';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
import { ADB, run, streamLines } from '../util/exec.js';
import { androidPid, androidRefreshHz } from '../devices/android.js';
import { quantile, round } from '../util/stats.js';
import type { Collector, CollectorContext } from './types.js';

const USER_HZ = 100; // Android is built with CONFIG_HZ=100 on every shipping ABI.

/** RN's long-lived threads, named here so the UI can label them meaningfully. */
const THREAD_LABELS: Record<string, string> = {
  mqt_js: 'JS',
  'mqt_native_modu': 'Native modules',
  RenderThread: 'Render',
  hwuiTask0: 'HWUI',
};

interface CpuSnapshot { jiffies: number; uptimeSec: number }

export class AndroidCollector implements Collector {
  readonly name = 'adb';
  private pid?: number;
  private refreshHz = 60;
  private frameBudgetMs = 16.67;
  private lastCpu?: CpuSnapshot;
  private lastThreadCpu = new Map<string, number>();
  private tickCount = 0;
  private logStream?: { stop: () => void };
  private warnedProfiling = false;
  private memoryCache: Partial<Sample> = {};
  private memoryTimer?: NodeJS.Timeout;
  private memoryInFlight = false;
  private pollCache: Partial<Sample> = {};
  private pollTimer?: NodeJS.Timeout;
  private pollInFlight = false;
  private pidMissSince = 0;

  constructor(private readonly ctx: CollectorContext) {}

  async start(): Promise<boolean> {
    const { deviceId, bundleId } = this.ctx;
    if (!bundleId) {
      this.ctx.warn('No package selected — pick the app under test to collect Android metrics.');
      return false;
    }

    this.pid = await androidPid(deviceId, bundleId);
    if (!this.pid) {
      this.ctx.warn(`${bundleId} is not running on ${deviceId}. Launch it to start collecting.`);
    }

    this.refreshHz = await androidRefreshHz(deviceId);
    this.frameBudgetMs = 1000 / this.refreshHz;

    // framestats is only populated when HWUI profiling is on. Setting the
    // property takes effect for processes started afterwards, so warn if the
    // app is already up and we see no frame data.
    await run(ADB, ['-s', deviceId, 'shell', 'setprop', 'debug.hwui.profile', 'true'], { timeoutMs: 5000 });
    await run(ADB, ['-s', deviceId, 'shell', 'dumpsys', 'gfxinfo', bundleId, 'reset'], { timeoutMs: 8000 });

    this.startLogcat();
    this.startMemoryLoop();
    this.startPollLoop();
    return true;
  }

  /**
   * adb round trips take anywhere from 100ms to several seconds depending on
   * what the device is doing. Polling on its own loop and letting `tick()` read
   * the latest value keeps the session's sample rate steady, and stops a slow
   * device from delaying SDK data that needs no device access at all.
   */
  private startPollLoop(): void {
    const poll = async () => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      try {
        const pid = await this.currentPid();
        if (!pid) {
          this.pollCache = {};
          return;
        }
        this.pollCache = await this.sampleCpuAndFrames(pid, this.ctx.bundleId!);
      } catch {
        // Keep the last reading rather than reporting a gap.
      } finally {
        this.pollInFlight = false;
      }
    };
    void poll();
    this.pollTimer = setInterval(() => void poll(), 500);
    this.pollTimer.unref?.();
  }

  /**
   * Resolve the app's pid, backing off while it is not running: `pidof` plus
   * the `ps` fallback is expensive to repeat several times a second against an
   * app that simply has not been launched yet.
   */
  private async currentPid(): Promise<number | undefined> {
    const { deviceId, bundleId } = this.ctx;
    if (!bundleId) return undefined;

    if (this.pid) {
      this.tickCount += 1;
      if (this.tickCount % 20 !== 0) return this.pid;
    } else if (this.pidMissSince && Date.now() - this.pidMissSince < 3000) {
      return undefined;
    }

    const pid = await androidPid(deviceId, bundleId);
    if (pid !== this.pid) {
      this.pid = pid;
      this.lastCpu = undefined;
      this.lastThreadCpu.clear();
    }
    this.pidMissSince = pid ? 0 : Date.now();
    return pid;
  }

  /**
   * `dumpsys meminfo` takes ~500ms, which would stretch every sample interval
   * if it ran inline. It refreshes on its own cadence and each tick reads the
   * latest value — memory moves slowly enough that this loses nothing.
   */
  private startMemoryLoop(): void {
    const refresh = async () => {
      if (this.memoryInFlight || !this.ctx.bundleId || !this.pid) return;
      this.memoryInFlight = true;
      try {
        const next = await this.sampleMemory(this.ctx.bundleId);
        if (Object.keys(next).length) this.memoryCache = next;
      } catch {
        // Keep the previous reading; the next pass will catch up.
      } finally {
        this.memoryInFlight = false;
      }
    };
    void refresh();
    this.memoryTimer = setInterval(() => void refresh(), 2000);
    this.memoryTimer.unref?.();
  }

  private startLogcat(): void {
    const { deviceId } = this.ctx;
    // -T 1 starts at "now" rather than replaying the whole ring buffer.
    this.logStream = streamLines(
      ADB,
      ['-s', deviceId, 'logcat', '-T', '1', '-v', 'tag', 'ReactNative:W', 'ReactNativeJS:V', 'AndroidRuntime:E', '*:S'],
      (line) => {
        const m = /^([VDIWEF])\/([^:]+):\s?(.*)$/.exec(line.trim());
        if (!m) return;
        const [, lvl, tag, message] = m;
        const level: LogLevel =
          lvl === 'E' || lvl === 'F' ? 'error' : lvl === 'W' ? 'warn' : lvl === 'I' ? 'info' : 'debug';
        this.ctx.emit({ type: 'log', t: Date.now(), level, tag, message: message ?? '' });
      },
    );
  }

  /** Non-blocking: returns whatever the background pollers last produced. */
  async tick(): Promise<Partial<Sample>> {
    if (!this.ctx.bundleId || !this.pid) return {};
    return { ...this.memoryCache, ...this.pollCache };
  }

  /** CPU%, per-thread CPU and frame timings in a single adb round trip. */
  private async sampleCpuAndFrames(pid: number, pkg: string): Promise<Partial<Sample>> {
    const r = await run(
      ADB,
      ['-s', this.ctx.deviceId, 'shell',
       `cat /proc/${pid}/stat /proc/uptime; echo ---; cat /proc/${pid}/task/*/stat 2>/dev/null; ` +
       `echo ===; dumpsys gfxinfo ${pkg} framestats reset 2>/dev/null`],
      { timeoutMs: 10_000, maxBuffer: 16 * 1024 * 1024 },
    );
    if (!r.ok || !r.stdout) return {};

    const [cpuPart = '', gfxPart = ''] = splitOnce(r.stdout, '===');
    return { ...this.parseCpu(cpuPart), ...this.parseFrames(gfxPart) };
  }

  private parseCpu(text: string): Partial<Sample> {
    const [head, tail = ''] = splitOnce(text, '---');
    const lines = (head ?? '').trim().split('\n');
    const statLine = lines[0] ?? '';
    const uptimeLine = lines[lines.length - 1] ?? '';

    const jiffies = procStatJiffies(statLine);
    const uptimeSec = Number(uptimeLine.trim().split(/\s+/)[0]);
    if (jiffies === undefined || !Number.isFinite(uptimeSec)) return {};

    const out: Partial<Sample> = {};
    const prev = this.lastCpu;
    this.lastCpu = { jiffies, uptimeSec };
    if (prev) {
      const dtSec = uptimeSec - prev.uptimeSec;
      if (dtSec > 0.05) {
        out.cpuPercent = round(((jiffies - prev.jiffies) / USER_HZ / dtSec) * 100, 1);
      }
    }

    // Per-thread CPU: the JS thread saturating is the single most useful
    // signal in a React Native app, and it is invisible in process totals.
    const threadCpu: Record<string, number> = {};
    const dtSec = prev ? uptimeSec - prev.uptimeSec : 0;
    for (const line of tail.trim().split('\n')) {
      const name = procStatComm(line);
      const j = procStatJiffies(line);
      if (!name || j === undefined) continue;
      const label = THREAD_LABELS[name];
      if (!label) continue;
      const before = this.lastThreadCpu.get(name);
      this.lastThreadCpu.set(name, j);
      if (before !== undefined && dtSec > 0.05) {
        threadCpu[label] = round(((j - before) / USER_HZ / dtSec) * 100, 1);
      }
    }
    if (Object.keys(threadCpu).length) out.threadCpu = threadCpu;
    return out;
  }

  /** Real per-frame timings from gfxinfo framestats, with an aggregate fallback. */
  private parseFrames(text: string): Partial<Sample> {
    if (!text.trim()) return {};
    const durations = parseFramestats(text);
    if (durations.length >= 3) {
      const sorted = [...durations].sort((a, b) => a - b);
      const janky = durations.filter((d) => d > this.frameBudgetMs).length;
      const total = durations.reduce((a, b) => a + b, 0);
      return {
        framesRendered: durations.length,
        frameP50Ms: round(quantile(sorted, 0.5)),
        frameP95Ms: round(quantile(sorted, 0.95)),
        frameP99Ms: round(quantile(sorted, 0.99)),
        jankPercent: round((janky / durations.length) * 100, 1),
        // Effective FPS over the frames actually produced in the window.
        uiFps: round(Math.min(this.refreshHz, 1000 / Math.max(total / durations.length, this.frameBudgetMs)), 1),
      };
    }

    const agg = parseGfxinfoAggregate(text);
    if (agg && agg.totalFrames === 0) return {}; // idle window — no frames to report
    if (agg) {
      if (!this.warnedProfiling && agg.totalFrames > 0) {
        this.warnedProfiling = true;
        this.ctx.warn(
          'Per-frame timings unavailable — HWUI profiling was enabled just now. Restart the app to get p95/p99 frame times instead of aggregates.',
        );
      }
      return {
        framesRendered: agg.totalFrames,
        jankPercent: round(agg.jankPercent, 1),
        frameP50Ms: agg.p50,
        frameP95Ms: agg.p95,
        frameP99Ms: agg.p99,
      };
    }
    return {};
  }

  private async sampleMemory(pkg: string): Promise<Partial<Sample>> {
    const r = await run(ADB, ['-s', this.ctx.deviceId, 'shell', 'dumpsys', 'meminfo', pkg], { timeoutMs: 10_000 });
    if (!r.ok) return {};
    return parseMeminfo(r.stdout);
  }

  async stop(): Promise<void> {
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.logStream?.stop();
  }
}

/* ------------------------------------------------------------------ parsers */

/** Split on the first occurrence of a separator only. */
function splitOnce(text: string, sep: string): [string, string] {
  const i = text.indexOf(sep);
  return i < 0 ? [text, ''] : [text.slice(0, i), text.slice(i + sep.length)];
}

/** utime+stime from a `/proc/<pid>/stat` line. comm may contain spaces and parens. */
export function procStatJiffies(line: string): number | undefined {
  const close = line.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = line.slice(close + 2).trim().split(/\s+/);
  // After comm, field[0] is state; utime is field 14 overall → index 11 here.
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined;
  return utime + stime;
}

export function procStatComm(line: string): string | undefined {
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open < 0 || close <= open) return undefined;
  return line.slice(open + 1, close);
}

/**
 * framestats emits CSV blocks between ---PROFILEDATA--- markers, in
 * nanoseconds. Frame duration is FrameCompleted − IntendedVsync; rows with a
 * non-zero Flags column are skipped as the platform instructs (they are
 * janky-by-definition layout passes, not real frames).
 */
export function parseFramestats(text: string): number[] {
  const out: number[] = [];
  const blocks = text.split('---PROFILEDATA---');
  for (let i = 1; i < blocks.length; i += 2) {
    const block = blocks[i]!;
    const lines = block.trim().split('\n');
    const header = lines[0]?.split(',').map((s) => s.trim()) ?? [];
    const flagsIdx = header.indexOf('Flags');
    const vsyncIdx = header.indexOf('IntendedVsync');
    const doneIdx = header.indexOf('FrameCompleted');
    if (vsyncIdx < 0 || doneIdx < 0) continue;

    for (const line of lines.slice(1)) {
      const cols = line.split(',');
      if (cols.length <= doneIdx) continue;
      if (flagsIdx >= 0 && Number(cols[flagsIdx]) !== 0) continue;
      const start = Number(cols[vsyncIdx]);
      const end = Number(cols[doneIdx]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const ms = (end - start) / 1e6;
      // Frames over a second are stale ring-buffer entries, not real jank.
      if (ms > 0 && ms < 1000) out.push(ms);
    }
  }
  return out;
}

export function parseGfxinfoAggregate(
  text: string,
): { totalFrames: number; jankPercent: number; p50?: number; p95?: number; p99?: number } | null {
  const total = /Total frames rendered:\s*(\d+)/.exec(text);
  if (!total) return null;
  // An idle app renders nothing and the platform fills every percentile with a
  // 4950ms sentinel. Reporting that as a frame time would invent huge jank.
  if (Number(total[1]) === 0) return { totalFrames: 0, jankPercent: 0 };
  const janky = /Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/.exec(text);
  const pct = (n: string) => {
    const m = new RegExp(`${n}th percentile:\\s*(\\d+)ms`).exec(text);
    return m ? Number(m[1]) : undefined;
  };
  return {
    totalFrames: Number(total[1]),
    jankPercent: janky ? Number(janky[2]) : 0,
    p50: pct('50'),
    p95: pct('95'),
    p99: pct('99'),
  };
}

/**
 * `dumpsys meminfo <pkg>`. The main table's TOTAL row carries PSS and RSS
 * totals; the App Summary block carries the Java/native/graphics split.
 */
export function parseMeminfo(text: string): Partial<Sample> {
  const out: Partial<Sample> = {};
  const kbToMb = (kb: number) => round(kb / 1024, 1);

  const totalRow = /^\s*TOTAL\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(text);
  if (totalRow) {
    out.pssMB = kbToMb(Number(totalRow[1]));
    out.rssMB = kbToMb(Number(totalRow[5]));
  }

  const summary = text.slice(text.indexOf('App Summary'));
  const field = (label: string): number | undefined => {
    const m = new RegExp(`^\\s*${label}:\\s*(\\d+)`, 'm').exec(summary);
    return m ? Number(m[1]) : undefined;
  };
  const java = field('Java Heap');
  const native = field('Native Heap');
  const graphics = field('Graphics');
  if (java !== undefined) out.javaHeapMB = kbToMb(java);
  if (native !== undefined) out.nativeHeapMB = kbToMb(native);
  if (graphics !== undefined) out.graphicsMB = kbToMb(graphics);

  if (out.pssMB === undefined) {
    const t = field('TOTAL');
    if (t !== undefined) out.pssMB = kbToMb(t);
  }
  return out;
}

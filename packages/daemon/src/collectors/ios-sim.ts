import type { Sample } from '@rnperf/protocol';
import { XCRUN, run, streamLines } from '../util/exec.js';
import { simulatorAppPids } from '../devices/ios-sim.js';
import { round } from '../util/stats.js';
import type { Collector, CollectorContext } from './types.js';

/**
 * A simulator app is a plain macOS process, so host `ps` gives us CPU and
 * resident memory with no instrumentation at all. Frame timings are not
 * exposed — those need @rnperf/sdk (JS FPS) or a physical device.
 */
export class IosSimulatorCollector implements Collector {
  readonly name = 'ios-sim-host';
  private pid?: number;
  private tickCount = 0;
  private logStream?: { stop: () => void };
  private cpuStream?: { stop: () => void };
  private cpuStreamPid?: number;
  private latestCpu?: number;

  constructor(private readonly ctx: CollectorContext) {}

  async start(): Promise<boolean> {
    if (!this.ctx.bundleId) {
      this.ctx.warn('No bundle id selected — pick the app under test to collect simulator metrics.');
      return false;
    }
    await this.resolvePid();
    if (!this.pid) {
      this.ctx.warn(`${this.ctx.bundleId} is not running on this simulator. Launch it to start collecting.`);
    }
    this.startLogStream();
    this.startCpuStream();
    return true;
  }

  /**
   * macOS `top` reports a process's lifetime-average CPU in its first frame and
   * only becomes instantaneous from the second onwards, so a one-shot call
   * would have to block for a full second. Streaming it in the background keeps
   * the sample loop fast and still yields a true per-second figure.
   */
  private startCpuStream(): void {
    if (!this.pid || this.cpuStreamPid === this.pid) return;
    this.cpuStream?.stop();
    this.cpuStreamPid = this.pid;
    const pid = this.pid;
    this.cpuStream = streamLines(
      '/usr/bin/top',
      ['-l', '0', '-s', '1', '-pid', String(pid), '-stats', 'pid,cpu'],
      (line) => {
        const m = /^\s*(\d+)\s+([\d.]+)\s*$/.exec(line);
        if (!m || Number(m[1]) !== pid) return;
        const cpu = Number(m[2]);
        if (Number.isFinite(cpu)) this.latestCpu = round(cpu, 1);
      },
    );
  }

  private async resolvePid(): Promise<void> {
    const pids = await simulatorAppPids(this.ctx.deviceId);
    this.pid = this.ctx.bundleId ? pids.get(this.ctx.bundleId) : undefined;
  }

  private startLogStream(): void {
    const { deviceId, bundleId } = this.ctx;
    if (!bundleId) return;
    this.logStream = streamLines(
      XCRUN,
      ['simctl', 'spawn', deviceId, 'log', 'stream',
       '--style', 'compact', '--level', 'default',
       '--predicate', `subsystem == "${bundleId}" OR processImagePath CONTAINS "${bundleId.split('.').pop() ?? bundleId}"`],
      (line) => {
        if (/^Filtering the log data|^Timestamp/.test(line)) return;
        const level = /\bError\b|\bFault\b/.test(line) ? 'error' : /\bDefault\b/.test(line) ? 'info' : 'debug';
        this.ctx.emit({ type: 'log', t: Date.now(), level, tag: 'oslog', message: line.trim().slice(0, 2000) });
      },
    );
  }

  async tick(): Promise<Partial<Sample>> {
    this.tickCount += 1;
    const previousPid = this.pid;
    if (!this.pid || this.tickCount % 10 === 0) await this.resolvePid();
    if (!this.pid) return {};
    if (this.pid !== previousPid) {
      this.latestCpu = undefined;
      this.startCpuStream();
    }

    // `ps` costs a few milliseconds and gives an unambiguous RSS.
    const r = await run('/bin/ps', ['-o', 'rss=', '-p', String(this.pid)], { timeoutMs: 5000 });
    if (!r.ok || !r.stdout.trim()) {
      this.pid = undefined;
      return {};
    }

    const out: Partial<Sample> = {};
    const rssKb = Number(r.stdout.trim().split(/\s+/)[0]);
    if (Number.isFinite(rssKb)) out.rssMB = round(rssKb / 1024, 1);
    if (this.latestCpu !== undefined) out.cpuPercent = this.latestCpu;
    return out;
  }

  async stop(): Promise<void> {
    this.logStream?.stop();
    this.cpuStream?.stop();
  }
}

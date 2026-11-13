import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sample } from '@rnperf/protocol';
import { XCRUN, run } from '../util/exec.js';
import { xctraceAvailable } from '../devices/ios-device.js';
import { round } from '../util/stats.js';
import type { Collector, CollectorContext } from './types.js';

const WINDOW_SEC = 10;

/**
 * Physical iPhone/iPad sampling via `xctrace record` with the Activity Monitor
 * template. Instruments only reports in whole trace files, so this runs rolling
 * ~10s recordings in the background and publishes the newest result on each
 * tick. That means device metrics lag by up to one window and are coarse — the
 * in-app SDK is the better source on real hardware, and this fills in the
 * native memory and CPU the SDK cannot see.
 */
export class IosDeviceCollector implements Collector {
  readonly name = 'ios-devicectl';
  private latest: Partial<Sample> = {};
  private running = false;
  private stopped = false;
  private loop?: Promise<void>;
  private processName?: string;

  constructor(private readonly ctx: CollectorContext) {}

  async start(): Promise<boolean> {
    if (!(await xctraceAvailable())) {
      this.ctx.warn('xctrace is unavailable, so CPU and memory cannot be read from this device. Install Xcode, or use @rnperf/sdk.');
      return false;
    }
    if (!this.ctx.bundleId) {
      this.ctx.warn('No bundle id selected — pick the app under test to collect device metrics.');
      return false;
    }
    // Activity Monitor rows are keyed by process name, not bundle id.
    this.processName = this.ctx.bundleId.split('.').pop();
    this.running = true;
    this.loop = this.recordLoop();
    this.ctx.warn(`Sampling this device in ${WINDOW_SEC}s windows via xctrace — expect up to ${WINDOW_SEC}s of lag.`);
    return true;
  }

  private async recordLoop(): Promise<void> {
    while (this.running && !this.stopped) {
      const sample = await this.recordOnce().catch(() => ({}));
      if (Object.keys(sample).length) this.latest = sample;
    }
  }

  private async recordOnce(): Promise<Partial<Sample>> {
    const dir = await mkdtemp(join(tmpdir(), 'rnperf-xt-'));
    const trace = join(dir, 'run.trace');
    try {
      const rec = await run(
        XCRUN,
        ['xctrace', 'record', '--device', this.ctx.deviceId, '--template', 'Activity Monitor',
         '--output', trace, '--time-limit', `${WINDOW_SEC}s`],
        { timeoutMs: (WINDOW_SEC + 30) * 1000 },
      );
      if (!rec.ok && !rec.stdout.includes('Output file saved')) return {};

      const exported = await run(
        XCRUN,
        ['xctrace', 'export', '--input', trace, '--xpath',
         '/trace-toc/run[@number="1"]/data/table[@schema="sysmon-process"]'],
        { timeoutMs: 60_000, maxBuffer: 64 * 1024 * 1024 },
      );
      if (!exported.ok) return {};
      return parseSysmonProcess(exported.stdout, this.processName ?? '');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async tick(): Promise<Partial<Sample>> {
    return this.latest;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    await this.loop?.catch(() => {});
  }
}

/**
 * Instruments XML de-duplicates repeated values: the first occurrence of a
 * value carries `id="N"` and later ones only `ref="N"`. Resolving that table is
 * the whole trick to reading an exported trace.
 */
export function parseSysmonProcess(xml: string, processName: string): Partial<Sample> {
  const idValues = new Map<string, string>();
  const idAttrs = new Map<string, Record<string, string>>();

  const tagRe = /<([a-zA-Z-]+)([^>]*?)(\/?)>(?:([^<]*)<\/\1>)?/g;
  const rows: Array<Record<string, string>> = [];
  let currentRow: Record<string, string> | null = null;

  const attrsOf = (raw: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const attrRe = /([a-zA-Z-]+)="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(raw))) out[m[1]!] = m[2]!;
    return out;
  };

  for (const rowChunk of xml.split(/<row>/).slice(1)) {
    currentRow = {};
    const body = rowChunk.split('</row>')[0] ?? '';
    tagRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(body))) {
      const [, tag, rawAttrs, , text] = m;
      const attrs = attrsOf(rawAttrs ?? '');
      let value = text?.trim() ?? '';
      let resolvedAttrs = attrs;

      if (attrs['ref']) {
        value = idValues.get(attrs['ref']) ?? '';
        resolvedAttrs = { ...(idAttrs.get(attrs['ref']) ?? {}), ...attrs };
      } else if (attrs['id']) {
        idValues.set(attrs['id'], value);
        idAttrs.set(attrs['id'], attrs);
      }

      if (tag === 'process') {
        currentRow['processName'] = resolvedAttrs['fmt'] ?? value;
      } else if (tag) {
        currentRow[tag] = value || resolvedAttrs['fmt'] || '';
      }
    }
    rows.push(currentRow);
  }

  const needle = processName.toLowerCase();
  const matching = rows.filter((r) => (r['processName'] ?? '').toLowerCase().includes(needle));
  if (matching.length === 0) return {};

  const pick = (row: Record<string, string>, keys: string[]): number | undefined => {
    for (const k of keys) {
      const raw = row[k];
      if (raw === undefined || raw === '') continue;
      const n = Number(String(raw).replace(/[^\d.-]/g, ''));
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  };

  const cpus: number[] = [];
  const mems: number[] = [];
  for (const row of matching) {
    const cpu = pick(row, ['cpu-per-second', 'cpuPercent', 'cpu']);
    if (cpu !== undefined) cpus.push(cpu);
    // Instruments reports bytes for footprint columns.
    const mem = pick(row, ['memory-physical-footprint', 'physFootprint', 'resident-size', 'memory-resident-size']);
    if (mem !== undefined) mems.push(mem);
  }

  const out: Partial<Sample> = {};
  if (cpus.length) out.cpuPercent = round(cpus.reduce((a, b) => a + b, 0) / cpus.length, 1);
  if (mems.length) {
    const avg = mems.reduce((a, b) => a + b, 0) / mems.length;
    // Values above a gigabyte are certainly bytes; smaller ones may be MB already.
    out.rssMB = round(avg > 4_000_000 ? avg / (1024 * 1024) : avg, 1);
  }
  return out;
}

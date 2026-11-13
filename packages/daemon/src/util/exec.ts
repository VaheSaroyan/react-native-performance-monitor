import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  ok: boolean;
}

/**
 * Run a command and never throw. Device tooling fails constantly (cable
 * unplugged, app not running, adb restarting) and every caller wants to treat
 * that as "no data this tick" rather than an exception.
 */
export async function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: opts.timeoutMs ?? 10_000,
      maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
      env: opts.env ?? process.env,
      encoding: 'utf8',
    });
    return { stdout, stderr, code: 0, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
      code: typeof e.code === 'number' ? e.code : 1,
      ok: false,
    };
  }
}

/** True if a binary is resolvable on PATH. */
const whichCache = new Map<string, boolean>();
export async function has(cmd: string): Promise<boolean> {
  const cached = whichCache.get(cmd);
  if (cached !== undefined) return cached;
  const r = await run('/usr/bin/which', [cmd], { timeoutMs: 3000 });
  const ok = r.ok && r.stdout.trim().length > 0;
  whichCache.set(cmd, ok);
  return ok;
}

/** Long-lived line-oriented process (logcat, log stream). */
export function streamLines(
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
): { child: ChildProcess; stop: () => void } {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const feed = (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) onLine(line);
    }
    // Guard against a pathological no-newline stream.
    if (buf.length > 1_000_000) buf = '';
  };
  child.stdout?.on('data', feed);
  child.on('error', () => {});
  return {
    child,
    stop: () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    },
  };
}

export const ADB = process.env.RNPERF_ADB ?? 'adb';
export const XCRUN = '/usr/bin/xcrun';

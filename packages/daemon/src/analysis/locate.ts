import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative } from 'node:path';
import type { SourceLocation } from '@rnperf/protocol';
import { has, run } from '../util/exec.js';

const IGNORE = ['node_modules', '.git', 'ios/Pods', 'android/build', 'dist', 'build', '.expo'];

/**
 * A test, a story and a mock all declare something with the component's name,
 * and none of them is where a fix goes. Left in, they push the real file down
 * the list or off it.
 */
const NOT_SOURCE =
  /(^|\/)(__tests__|__mocks__|__fixtures__|\.storybook|\.rnstorybook|e2e)\/|\.(test|spec|stories|story|mock)\.[jt]sx?$/;

export function isComponentSource(file: string): boolean {
  return !NOT_SOURCE.test(file);
}

/**
 * Searching a home directory or a volume root takes minutes and never finds a
 * component faster than searching the actual project would. Refusing outright
 * is better than hanging the caller.
 */
export function isPlausibleProjectRoot(root: string): boolean {
  if (!root) return false;
  const normalised = root.replace(/\/+$/, '');
  if (normalised === '' || normalised === '/') return false;
  const home = homedir().replace(/\/+$/, '');
  if (normalised === home) return false;
  // One level below root: /Users, /Volumes, /opt and friends.
  return normalised.split('/').filter(Boolean).length > 1;
}

/**
 * Find where a component is declared, so a finding points at a file an agent
 * can actually edit rather than just a display name. Uses ripgrep when
 * available and falls back to grep.
 */
export async function locateComponent(root: string, name: string): Promise<SourceLocation[]> {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return [];
  if (!isPlausibleProjectRoot(root)) return [];

  // Declaration forms, most specific first.
  const pattern =
    `(export\\s+)?(default\\s+)?(function|const|class|let|var)\\s+${name}\\b` +
    `|${name}\\s*[:=]\\s*(React\\.)?(memo|forwardRef)\\s*\\(` +
    `|(export\\s+)?(const|let|var)\\s+${name}\\s*[:=]`;

  const hits = (await has('rg'))
    ? await ripgrep(root, pattern)
    : await grepFallback(root, pattern);

  const seen = new Set<string>();
  const out: SourceLocation[] = [];
  for (const hit of hits) {
    if (!isComponentSource(relative(root, hit.file) || hit.file)) continue;
    const key = `${hit.file}:${hit.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file: relative(root, hit.file) || hit.file, line: hit.line, preview: hit.preview.trim().slice(0, 200) });
    if (out.length >= 5) break;
  }
  return out;
}

interface Hit { file: string; line: number; preview: string }

async function ripgrep(root: string, pattern: string): Promise<Hit[]> {
  const args = [
    '--line-number', '--no-heading', '--color=never', '--max-count=3', '--max-filesize', '2M',
    '-t', 'ts', '-t', 'js', '-t', 'tsx', '-t', 'jsx',
    ...IGNORE.flatMap((g) => ['--glob', `!${g}/**`]),
    '-e', pattern, root,
  ];
  const r = await run('rg', args, { timeoutMs: 8000 });
  return parseGrepLines(r.stdout);
}

async function grepFallback(root: string, pattern: string): Promise<Hit[]> {
  const args = [
    '-rnE', '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx',
    ...IGNORE.map((g) => `--exclude-dir=${g.split('/')[0]}`),
    pattern, root,
  ];
  const r = await run('/usr/bin/grep', args, { timeoutMs: 8000 });
  return parseGrepLines(r.stdout);
}

function parseGrepLines(stdout: string): Hit[] {
  const out: Hit[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    out.push({ file: m[1]!, line: Number(m[2]), preview: m[3] ?? '' });
  }
  return out;
}

/** Read a window of source around a hit, for an agent about to make an edit. */
export async function readContext(
  file: string,
  line: number,
  radius = 12,
): Promise<{ startLine: number; text: string } | null> {
  try {
    const lines = (await readFile(file, 'utf8')).split('\n');
    const start = Math.max(0, line - 1 - radius);
    const end = Math.min(lines.length, line + radius);
    return { startLine: start + 1, text: lines.slice(start, end).join('\n') };
  } catch {
    return null;
  }
}

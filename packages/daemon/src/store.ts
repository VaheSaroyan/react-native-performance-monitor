import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PerfEvent, Sample, SessionMeta } from '@rnperf/protocol';

export const DATA_DIR = process.env.RNPERF_HOME ?? join(homedir(), '.rnperf');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');

/**
 * Sessions live as append-only JSONL on disk. Time series append cheaply, a
 * half-written session is still readable up to its last complete line, and
 * there is no native dependency to rebuild every time Electron changes its
 * Node ABI.
 */
export class SessionStore {
  private writeQueue: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    await mkdir(SESSIONS_DIR, { recursive: true });
  }

  /**
   * Ids arrive from URLs, and delete removes this directory recursively, so
   * anything that is not a plain id must never be turned into a path.
   */
  private dir(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
    return join(SESSIONS_DIR, id);
  }

  async create(meta: SessionMeta): Promise<void> {
    await mkdir(this.dir(meta.id), { recursive: true });
    await this.writeMeta(meta);
  }

  async writeMeta(meta: SessionMeta): Promise<void> {
    await writeFile(join(this.dir(meta.id), 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  }

  /** Appends are serialised so interleaved ticks cannot corrupt a line. */
  appendSample(id: string, sample: Sample): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(() => appendFile(join(this.dir(id), 'samples.jsonl'), JSON.stringify(sample) + '\n', 'utf8'))
      .catch(() => {});
    return this.writeQueue;
  }

  appendEvent(id: string, event: PerfEvent): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(() => appendFile(join(this.dir(id), 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8'))
      .catch(() => {});
    return this.writeQueue;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async getMeta(id: string): Promise<SessionMeta | null> {
    try {
      return JSON.parse(await readFile(join(this.dir(id), 'meta.json'), 'utf8')) as SessionMeta;
    } catch {
      return null;
    }
  }

  async list(): Promise<SessionMeta[]> {
    let ids: string[];
    try {
      ids = await readdir(SESSIONS_DIR);
    } catch {
      return [];
    }
    const metas = await Promise.all(ids.map((id) => this.getMeta(id)));
    return metas
      .filter((m): m is SessionMeta => m !== null)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async readSamples(id: string, opts: { from?: number; to?: number; limit?: number } = {}): Promise<Sample[]> {
    return this.readJsonl<Sample>(join(this.dir(id), 'samples.jsonl'), (s) => {
      if (opts.from !== undefined && s.dt < opts.from) return false;
      if (opts.to !== undefined && s.dt > opts.to) return false;
      return true;
    }, opts.limit);
  }

  async readEvents(id: string, opts: { types?: string[]; limit?: number } = {}): Promise<PerfEvent[]> {
    return this.readJsonl<PerfEvent>(
      join(this.dir(id), 'events.jsonl'),
      (e) => !opts.types || opts.types.includes(e.type),
      opts.limit,
    );
  }

  private async readJsonl<T>(file: string, keep: (v: T) => boolean, limit?: number): Promise<T[]> {
    const out: T[] = [];
    try {
      const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as T;
          if (keep(parsed)) out.push(parsed);
        } catch {
          // A torn final line from an interrupted write — skip it.
        }
        if (limit !== undefined && out.length >= limit) {
          rl.close();
          break;
        }
      }
    } catch {
      return out;
    }
    return out;
  }

  async delete(id: string): Promise<boolean> {
    try {
      await rm(this.dir(id), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

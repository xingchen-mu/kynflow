import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Series } from '../../shared/types.ts';
import { config } from '../config.ts';
import { t } from '../i18n.ts';
import { RequestError } from '../workflows/index.ts';

const VERSION = 1;
const NAME_CHARS = 60;
const MAX_SERIES = 100;
const ID = /^[\w-]{6,32}$/;

interface SeriesFile {
  version: number;
  series: Series[];
}

function sanitize(raw: unknown): Series | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<Series>;
  const id = typeof r.id === 'string' && ID.test(r.id) ? r.id : undefined;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!id || !name) return undefined;
  const at = Number.isFinite(r.createdAt) ? Number(r.createdAt) : Date.now();
  return {
    id,
    name: name.slice(0, NAME_CHARS),
    createdAt: at,
    updatedAt: Number.isFinite(r.updatedAt) ? Number(r.updatedAt) : at,
  };
}

/**
 * Series: boards that tell one story. Their settings and entities are shared (memory scope `series`), while
 * each board still keeps its own memory. Stored beside the boards, small enough to read whole.
 */
export class SeriesStore {
  private readonly file = join(config.dataDir, 'series.json');
  private items: Series[] = [];
  private loading?: Promise<void>;
  private lock: Promise<unknown> = Promise.resolve();

  async init() {
    await this.load();
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<SeriesFile>;
        if (Array.isArray(saved.series)) {
          this.items = saved.series.map(sanitize).filter((s): s is Series => Boolean(s));
        }
      } catch {
        this.items = [];
      }
    })();
    return this.loading;
  }

  /** Newest first, as the pickers show them. */
  async list(): Promise<Series[]> {
    await this.load();
    return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Series | undefined> {
    await this.load();
    return this.items.find((s) => s.id === id);
  }

  create(name?: string): Promise<Series> {
    return this.exclusive(async () => {
      if (this.items.length >= MAX_SERIES) throw new RequestError(t('系列最多 {n} 个', { n: MAX_SERIES }));
      const now = Date.now();
      const series: Series = {
        id: nanoid(10),
        name: name?.trim().slice(0, NAME_CHARS) || t('未命名系列'),
        createdAt: now,
        updatedAt: now,
      };
      this.items.push(series);
      await this.persist();
      return series;
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  private async persist() {
    const file = this.file;
    const tmp = `${file}.${nanoid(4)}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: VERSION, series: this.items } satisfies SeriesFile));
    await rename(tmp, file);
  }
}

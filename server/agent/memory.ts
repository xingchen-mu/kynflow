import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import {
  type AgentMemory,
  type AgentMemoryFile,
  ENTITY_KINDS,
  ENTITY_NAME_CHARS,
  ENTITY_SUMMARY_CHARS,
  ENTRY_CHARS,
  MAX_ENTITIES,
  MEMORY_LIMIT,
  MEMORY_TYPES,
  type MemoryEntity,
  type MemoryEntityKind,
  type MemoryEntry,
  type MemoryPromotion,
  type MemoryRef,
  type MemoryScope,
  type MemorySource,
  type MemoryType,
  isActiveEntity,
  isActiveMemory,
  memorySimilarity,
} from '../../shared/types.ts';
import { t } from '../i18n.ts';
import { RequestError } from '../workflows/index.ts';
import { cosine, type Embedder } from './embeddings.ts';
import { writeJson } from './write.ts';

/**
 * Long-term memory, after the designs agents share (Letta's core memory blocks, Claude Code's CLAUDE.md and
 * ChatGPT's saved memories): small, typed entries always in context, which the assistant writes itself and
 * the user can see and edit. Two scopes: this board, and the user across boards. What is on the board
 * (scripts, shot lists, prompts) stays there; memory holds what the board does not say.
 *
 * Entries are append-only. Updating an entry marks the old one invalid and adds a new one, so a later change
 * does not erase what was decided before; only active entries are sent to the model.
 *
 * A board also has entities (a character, place, prop or look). Facts attached to one are kept out of the
 * prompt index and read on demand, so a detailed setting does not crowd every request.
 */

const TYPE_LABEL: Record<MemoryType, string> = { setting: '设定', decision: '决定', preference: '偏好', feedback: '纠正' };
const ENTITY_LABEL: Record<MemoryEntityKind, string> = { character: '人物', scene: '场景', prop: '道具', style: '风格' };
const SOURCE_KINDS = new Set<MemorySource['kind']>(['chat', 'review', 'condense', 'user']);
const SOURCE_LABEL: Record<MemorySource['kind'], string> = { chat: '对话', review: '复盘', condense: '整理', user: '用户' };
/** How sure a writer of each kind usually is; the user's own edit is certain. */
const SOURCE_CONFIDENCE: Record<MemorySource['kind'], number> = { chat: 0.7, review: 0.8, condense: 0.6, user: 1 };
const VERSION = 2;
const INDEX_VERSION = 1;
/** Below this cosine similarity a vector hit is not worth showing. */
const SEMANTIC_MIN = 0.35;
/** How much a perfect semantic match adds over the keyword score: about a prefix match. */
const SEMANTIC_WEIGHT = 4;
/** An add this close to an active entry in the same place is the same thing said again: skipped. */
const SAME_TEXT = 0.92;
/** A new entry this close to an active one is probably a change of it: refused, so update is used instead. */
const NEAR_TEXT = 0.75;
/** BM25: how much repeated words help, and how much long entries are penalized. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Retrieval adds a little for recent and often-read entries; small enough not to outrank a real match. */
const RECENCY_WEIGHT = 0.8;
const USAGE_WEIGHT = 0.7;
const DAY = 86_400_000;
/** Invalid or archived entries kept on disk for the user to inspect. They never reach the prompt. */
const MAX_HISTORY = 200;
const MAX_ENTITY_HISTORY = 60;
const MAX_REFS = 20;

export interface MemoryOp {
  action: 'add' | 'update' | 'delete';
  scope: MemoryScope;
  id?: string;
  type?: MemoryType;
  text?: string;
  why?: string;
  /** Attach the fact to a board entity, or update an attached one in place. */
  entityId?: string;
  /** How sure the writer was, 0..1; by default it follows where the change came from. */
  confidence?: number;
  /** The user explicitly asked for this entry; lets it through when automatic memory is off. */
  requestedByUser?: boolean;
}

/** Where a batch of changes came from: talking with the user, condensing a conversation, or a review. */
export interface MemoryOrigin {
  kind: 'chat' | 'condense' | 'review';
  /** The panel row or board item it was derived from, when known. */
  entryId?: string;
  itemId?: string;
}

export interface EntityOp {
  action: 'add' | 'update' | 'delete';
  /** `series`: shared by every board of the series; default `board`. */
  scope?: 'series' | 'board';
  id?: string;
  kind?: MemoryEntityKind;
  name?: string;
  summary?: string;
  refs?: MemoryRef[];
  /** The user explicitly asked for it; lets it through when automatic memory is off. */
  requestedByUser?: boolean;
}

/** What to look for: free words, an entity, a scope, and whether history counts. */
export interface MemoryQuery {
  text?: string;
  scope?: MemoryScope | 'all';
  entityId?: string;
  includeHistory?: boolean;
  limit?: number;
}

export interface MemoryHit {
  kind: 'entity' | 'entry';
  scope: MemoryScope;
  id: string;
  text: string;
  at: number;
  by: 'assistant' | 'user';
  active: boolean;
  pinned?: boolean;
  type?: MemoryType;
  entityKind?: MemoryEntityKind;
  entityId?: string;
  entityName?: string;
}

export interface MemoryDetail {
  scope: MemoryScope;
  entry?: MemoryEntry;
  entity?: MemoryEntity;
  /** The entry followed by everything that replaced it, oldest first. */
  chain: MemoryEntry[];
  /** For an entity: the facts attached to it. */
  facts: MemoryEntry[];
}

const empty = (): AgentMemory => ({ auto: true, entries: [], entities: [] });
const activeSize = (entries: MemoryEntry[]) =>
  entries.filter(isActiveMemory).reduce((n, e) => n + e.text.length + (e.why?.length ?? 0), 0);
const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s，。,.、；;：:！!？?、"“”‘’()（）\[\]【】]/g, '');
const same = (a: string, b: string) => normalize(a) === normalize(b);
/** 0..1, or the default for where it came from. */
const confidenceOf = (value: number | undefined, kind: MemorySource['kind']) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, Number(value))) : SOURCE_CONFIDENCE[kind];
const sourceOfOrigin = (origin: MemoryOrigin | undefined): MemorySource => ({
  kind: origin?.kind ?? 'chat',
  ...(origin?.entryId ? { entryId: origin.entryId } : {}),
  ...(origin?.itemId ? { itemId: origin.itemId } : {}),
});
const date = (at: number) => {
  const d = new Date(at);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * Words for BM25: runs of Latin letters and digits as they are, Chinese/Japanese runs as overlapping
 * character bigrams (a lone character stays one token). No dictionary needed, and offline.
 */
function tokens(text: string): string[] {
  const out: string[] = [];
  let cjk = '';
  let word = '';
  const flushCjk = () => {
    if (cjk.length === 1) out.push(cjk);
    for (let i = 0; i < cjk.length - 1; i++) out.push(cjk.slice(i, i + 2));
    cjk = '';
  };
  const flushWord = () => {
    if (word) out.push(word);
    word = '';
  };
  for (const ch of text.normalize('NFKC').toLowerCase()) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) {
      flushWord();
      cjk += ch;
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      flushCjk();
      word += ch;
    } else {
      flushCjk();
      flushWord();
    }
  }
  flushCjk();
  flushWord();
  return out;
}

/** A little for entries read or written recently and often: a tie-breaker, never the main signal. */
function recencyBoost(item: { at: number; lastUsedAt?: number; useCount?: number }): number {
  const fresh = 1 / (1 + Math.max(0, Date.now() - (item.lastUsedAt ?? item.at)) / (30 * DAY));
  const used = Math.min(1, Math.log1p(item.useCount ?? 0) / Math.log(6));
  return RECENCY_WEIGHT * fresh + USAGE_WEIGHT * used;
}

/** Vectors of one scope's entries and entities, by id; rebuilt when the text or model changes. */
interface VectorIndex {
  version: number;
  model: string;
  items: Record<string, { hash: string; vector: number[] }>;
}

/** FNV-1a: enough to tell whether the text behind an id changed. */
function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Keeps the newest history entries; the oldest invalid or archived ones are dropped from the file. */
function trimHistory(entries: MemoryEntry[]): MemoryEntry[] {
  const history = entries.filter((e) => !isActiveMemory(e));
  if (history.length <= MAX_HISTORY) return entries;
  const drop = new Set(history.slice(0, history.length - MAX_HISTORY).map((e) => e.id));
  return entries.filter((e) => !drop.has(e.id));
}

/** Same for archived entities: the newest are kept, so the file does not grow without bound. */
function trimEntities(entities: MemoryEntity[]): MemoryEntity[] {
  const history = entities.filter((e) => !isActiveEntity(e));
  if (history.length <= MAX_ENTITY_HISTORY) return entities;
  const drop = new Set(history.slice(0, history.length - MAX_ENTITY_HISTORY).map((e) => e.id));
  return entities.filter((e) => !drop.has(e.id));
}

function refsOf(raw: unknown): MemoryRef[] {
  if (!Array.isArray(raw)) return [];
  const refs: MemoryRef[] = [];
  for (const item of raw.slice(0, MAX_REFS)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<MemoryRef>;
    const itemId = typeof r.itemId === 'string' && r.itemId ? r.itemId : undefined;
    const assetId = typeof r.assetId === 'string' && r.assetId ? r.assetId : undefined;
    if (itemId || assetId) refs.push({ ...(itemId ? { itemId } : {}), ...(assetId ? { assetId } : {}) });
  }
  return refs;
}

function sourceOf(raw: unknown): MemorySource | undefined {
  const r = raw as Partial<MemorySource> | undefined;
  return r && typeof r === 'object' && SOURCE_KINDS.has(r.kind as MemorySource['kind'])
    ? {
        kind: r.kind as MemorySource['kind'],
        ...(typeof r.entryId === 'string' ? { entryId: r.entryId } : {}),
        ...(typeof r.itemId === 'string' ? { itemId: r.itemId } : {}),
      }
    : undefined;
}

/** An entry read from disk, with the parts the current code understands. Broken rows are dropped. */
function sanitize(raw: unknown, scope: MemoryScope): MemoryEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<MemoryEntry>;
  const text = typeof r.text === 'string' ? r.text.trim() : '';
  if (!text) return undefined;
  const type = MEMORY_TYPES[scope].includes(r.type as MemoryType) ? (r.type as MemoryType) : MEMORY_TYPES[scope][0];
  const source = sourceOf(r.source);
  return {
    id: typeof r.id === 'string' && r.id ? r.id : `m${nanoid(6)}`,
    type,
    text,
    ...(typeof r.why === 'string' && r.why.trim() ? { why: r.why.trim() } : {}),
    at: Number.isFinite(r.at) ? Number(r.at) : Date.now(),
    ...(Number.isFinite(r.validAt) ? { validAt: Number(r.validAt) } : {}),
    ...(Number.isFinite(r.invalidAt) ? { invalidAt: Number(r.invalidAt) } : {}),
    ...(typeof r.supersededBy === 'string' ? { supersededBy: r.supersededBy } : {}),
    ...(r.archived ? { archived: true } : {}),
    ...(r.pinned ? { pinned: true } : {}),
    ...(typeof r.entityId === 'string' && r.entityId ? { entityId: r.entityId } : {}),
    ...(source ? { source } : {}),
    confidence: confidenceOf(r.confidence, source?.kind ?? (r.by === 'user' ? 'user' : 'chat')),
    ...(Number.isFinite(r.lastUsedAt) ? { lastUsedAt: Number(r.lastUsedAt) } : {}),
    ...(Number.isFinite(r.useCount) ? { useCount: Math.max(0, Number(r.useCount)) } : {}),
    by: r.by === 'user' ? 'user' : 'assistant',
  };
}

/** An entity read from disk; one without a known kind or a name is dropped. */
function sanitizeEntity(raw: unknown): MemoryEntity | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<MemoryEntity>;
  const kind = ENTITY_KINDS.includes(r.kind as MemoryEntityKind) ? (r.kind as MemoryEntityKind) : undefined;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!kind || !name) return undefined;
  const source = sourceOf(r.source);
  return {
    id: typeof r.id === 'string' && r.id ? r.id : `e${nanoid(6)}`,
    kind,
    name: name.slice(0, ENTITY_NAME_CHARS),
    summary: typeof r.summary === 'string' ? r.summary.trim().slice(0, ENTITY_SUMMARY_CHARS) : '',
    refs: refsOf(r.refs),
    at: Number.isFinite(r.at) ? Number(r.at) : Date.now(),
    ...(r.pinned ? { pinned: true } : {}),
    ...(r.archived ? { archived: true } : {}),
    ...(source ? { source } : {}),
    ...(Number.isFinite(r.lastUsedAt) ? { lastUsedAt: Number(r.lastUsedAt) } : {}),
    ...(Number.isFinite(r.useCount) ? { useCount: Math.max(0, Number(r.useCount)) } : {}),
    by: r.by === 'assistant' ? 'assistant' : 'user',
  };
}

/** The user's edit of the entity list: checked like the assistant's, keeping ids and authors where it can. */
function checkEntities(raw: unknown[], before: MemoryEntity[]): MemoryEntity[] {
  const now = Date.now();
  const entities: MemoryEntity[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<MemoryEntity>;
    const old = before.find((e) => e.id === r.id && !seen.has(e.id));
    const kind = r.kind ?? old?.kind;
    if (!kind || !ENTITY_KINDS.includes(kind)) {
      throw new RequestError(t('不支持的设定类型 {kind}；可用：{list}', { kind: String(kind ?? ''), list: ENTITY_KINDS.join('、') }));
    }
    const name = String(r.name ?? old?.name ?? '').trim();
    const summary = String(r.summary ?? old?.summary ?? '').trim();
    const pinned = Boolean(r.pinned ?? old?.pinned);
    const archived = Boolean(r.archived ?? old?.archived);
    const refs = refsOf(r.refs ?? old?.refs);
    if (!name) {
      // A row the user added and left empty is dropped; a named entity cannot lose its name.
      if (!old && !summary && !refs.length) continue;
      throw new RequestError(t('设定条目的名字不能是空的'));
    }
    if (name.length > ENTITY_NAME_CHARS) throw new RequestError(t('设定条目的名字不超过 {n} 字', { n: ENTITY_NAME_CHARS }));
    if (summary.length > ENTITY_SUMMARY_CHARS) throw new RequestError(t('设定条目的简介不超过 {n} 字', { n: ENTITY_SUMMARY_CHARS }));
    const changed =
      !old ||
      old.name !== name ||
      old.kind !== kind ||
      old.summary !== summary ||
      Boolean(old.pinned) !== pinned ||
      Boolean(old.archived) !== archived ||
      JSON.stringify(old.refs) !== JSON.stringify(refs);
    const id = old?.id ?? `e${nanoid(6)}`;
    seen.add(id);
    entities.push({
      id,
      kind,
      name,
      summary,
      refs,
      at: old ? (changed ? now : old.at) : now,
      by: old ? (changed ? 'user' : old.by) : 'user',
      ...(pinned ? { pinned: true } : {}),
      ...(archived ? { archived: true } : {}),
      ...(old?.source ? { source: old.source } : changed ? { source: { kind: 'user' as const } } : {}),
    });
  }
  if (entities.filter(isActiveEntity).length > MAX_ENTITIES) {
    throw new RequestError(t('设定条目最多 {n} 个，先删掉或归档一些', { n: MAX_ENTITIES }));
  }
  return entities;
}

/** Archives the oldest active entries until the scope fits; pinned entries are left alone. */
function makeRoom(entries: MemoryEntry[], scope: MemoryScope, protect: Set<string>, at: number): string[] {
  const archived: string[] = [];
  for (const entry of entries) {
    if (activeSize(entries) <= MEMORY_LIMIT[scope]) break;
    if (!isActiveMemory(entry) || entry.pinned || protect.has(entry.id)) continue;
    entry.archived = true;
    entry.invalidAt = at;
    archived.push(entry.text);
  }
  return archived;
}

/** Archives the oldest unpinned entities until there is room for the new one. */
function makeEntityRoom(entities: MemoryEntity[], protect: Set<string>): number {
  let archived = 0;
  for (const entity of [...entities].sort((a, b) => a.at - b.at)) {
    if (entities.filter(isActiveEntity).length <= MAX_ENTITIES) break;
    if (!isActiveEntity(entity) || entity.pinned || protect.has(entity.id)) continue;
    entity.archived = true;
    archived++;
  }
  return archived;
}

/** Which signal parts of a query a hit matches directly: whole words in the text, and whether it is pinned. */
function matchScore(text: string, words: string[], pinned: boolean): number {
  let n = pinned ? 2 : 0;
  for (const word of words) {
    if (!word) continue;
    const at = text.indexOf(word);
    if (at < 0) continue;
    n += text === word ? 6 : text.startsWith(word) ? 4 : 2;
  }
  return n;
}

/** What a cosine similarity adds to the keyword score. */
const semanticScore = (sim: number | undefined) => (sim === undefined ? 0 : Math.max(0, sim) * SEMANTIC_WEIGHT);

export class MemoryStore {
  constructor(
    private readonly dir: string,
    /** Optional: finds memory by meaning as well as by words. Without it search stays keyword-only. */
    private readonly embedder?: Embedder,
  ) {}

  private file(scope: MemoryScope, ownerId: string) {
    if (scope === 'user') return join(this.dir, 'memory-user.json');
    return join(this.dir, scope === 'series' ? `memory-series-${ownerId}.json` : `memory-board-${ownerId}.json`);
  }

  async read(scope: MemoryScope, projectId: string): Promise<AgentMemory> {
    const file = this.file(scope, projectId);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      throw err;
    }
    try {
      const saved = JSON.parse(raw) as Partial<AgentMemoryFile>;
      if (!saved || !Array.isArray(saved.entries)) throw new Error('memory file has no entries array');
      return {
        auto: saved.auto !== false,
        entries: saved.entries.map((e) => sanitize(e, scope)).filter((e): e is MemoryEntry => Boolean(e)),
        // Version 1 files have no entities; they read as an empty index and are upgraded on the next write.
        entities:
          scope !== 'user' && Array.isArray(saved.entities)
            ? saved.entities.map(sanitizeEntity).filter((e): e is MemoryEntity => Boolean(e))
            : [],
      };
    } catch (err) {
      // Never treat a broken file as an empty memory: the next write would overwrite what the user had.
      const backup = `${file}.corrupt-${Date.now()}`;
      await rename(file, backup).catch(() => {});
      console.error(`agent: memory file ${file} could not be read; kept as ${backup}`, err);
      return empty();
    }
  }

  private async write(scope: MemoryScope, projectId: string, memory: AgentMemory): Promise<void> {
    const file = this.file(scope, projectId);
    await writeJson(
      file,
      () =>
        ({
          version: VERSION,
          auto: memory.auto,
          entries: trimHistory(memory.entries),
          entities: scope === 'user' ? [] : trimEntities(memory.entities),
        }) satisfies AgentMemoryFile,
    );
  }

  /** The user's own edit of a scope, from the memory page: checked like the assistant's. */
  async replace(scope: MemoryScope, projectId: string, memory: unknown): Promise<AgentMemory> {
    const given = memory as Partial<AgentMemory> | undefined;
    if (!given || !Array.isArray(given.entries)) throw new RequestError(t('请求格式错误'));
    const before = await this.read(scope, projectId);
    const now = Date.now();
    const entities =
      scope === 'user' ? [] : checkEntities(Array.isArray(given.entities) ? given.entities : before.entities, before.entities);
    const entries: MemoryEntry[] = [];
    const seen = new Set<string>();
    for (const raw of given.entries) {
      const text = String(raw?.text ?? '').trim();
      if (!text) continue;
      const old = before.entries.find((e) => e.id === raw?.id && !seen.has(e.id));
      const type = raw?.type ?? old?.type ?? MEMORY_TYPES[scope][0];
      if (!MEMORY_TYPES[scope].includes(type as MemoryType)) {
        throw new RequestError(t('这个作用域不支持类型 {type}；可用：{list}', { type, list: MEMORY_TYPES[scope].join('、') }));
      }
      const why = String(raw?.why ?? '').trim() || undefined;
      if (text.length + (why?.length ?? 0) > ENTRY_CHARS) throw new RequestError(t('一条记忆不超过 {n} 字', { n: ENTRY_CHARS }));
      const pinned = Boolean(raw?.pinned ?? old?.pinned);
      const archived = Boolean(raw?.archived ?? old?.archived);
      const entityId =
        typeof raw?.entityId === 'string' && entities.some((e) => e.id === raw.entityId && isActiveEntity(e))
          ? raw.entityId
          : undefined;
      const changed =
        !old ||
        old.text !== text ||
        (old.why ?? '') !== (why ?? '') ||
        old.type !== type ||
        Boolean(old.pinned) !== pinned ||
        Boolean(old.archived) !== archived ||
        (old.entityId ?? '') !== (entityId ?? '');
      const id = old?.id ?? `m${nanoid(6)}`;
      const stillActive = !archived && !old?.invalidAt;
      seen.add(id);
      entries.push({
        id,
        type: type as MemoryType,
        text,
        ...(why ? { why } : {}),
        ...(entityId ? { entityId } : {}),
        at: old ? (changed ? now : old.at) : now,
        by: old ? (changed ? 'user' : old.by) : 'user',
        ...(old?.validAt ? { validAt: old.validAt } : stillActive ? { validAt: now } : {}),
        ...(old?.invalidAt ? { invalidAt: old.invalidAt } : {}),
        ...(old?.supersededBy ? { supersededBy: old.supersededBy } : {}),
        ...(archived ? { archived: true } : {}),
        ...(pinned ? { pinned: true } : {}),
        ...(old?.source ? { source: old.source } : changed ? { source: { kind: 'user' as const } } : {}),
        confidence: changed ? 1 : (old?.confidence ?? 1),
        ...(old?.lastUsedAt ? { lastUsedAt: old.lastUsedAt } : {}),
        ...(old?.useCount ? { useCount: old.useCount } : {}),
      });
    }
    if (activeSize(entries) > MEMORY_LIMIT[scope]) {
      throw new RequestError(
        t('记忆太长了（{size}/{limit} 字），删掉或合并一些', { size: activeSize(entries), limit: MEMORY_LIMIT[scope] }),
      );
    }
    const next = { auto: given.auto !== false, entries, entities };
    await this.write(scope, projectId, next);
    return next;
  }

  /**
   * The assistant's changes, each applied or refused with a reason it can act on (a full memory, an unknown
   * id). An entry saying what another already says is not added twice. Updates add a new entry and mark the
   * old one invalid instead of overwriting it.
   */
  async apply(
    projectId: string,
    ops: MemoryOp[],
    seriesId?: string,
    origin?: MemoryOrigin,
  ): Promise<{ done: string[]; refused: string[] }> {
    const done: string[] = [];
    const refused: string[] = [];
    const source = sourceOfOrigin(origin);
    for (const scope of ['series', 'board', 'user'] as const) {
      const mine = ops.filter((o) => o.scope === scope);
      if (!mine.length) continue;
      if (scope === 'series' && !seriesId) {
        refused.push(...mine.map(() => t('这块画布不属于任何系列，不能写系列记忆')));
        continue;
      }
      const owner = scope === 'series' ? seriesId! : projectId;
      const memory = await this.read(scope, owner);
      const where = scope === 'board' ? t('画布记忆') : scope === 'series' ? t('系列记忆') : t('用户偏好');
      const entries = [...memory.entries];
      let changed = false;
      /** An entity an entry may hang off; `false` when the id is unknown, so the op is refused. */
      const entityFor = (wanted: string | undefined): string | undefined | false => {
        const id = wanted?.trim();
        if (!id) return undefined;
        if (scope === 'user' || !memory.entities.some((e) => e.id === id && isActiveEntity(e))) return false;
        return id;
      };
      for (const op of mine) {
        const now = Date.now();
        if (!memory.auto && !op.requestedByUser && op.action !== 'delete') {
          refused.push(t('{where}：用户关掉了自动记忆；只有用户明确要求时才能写入', { where }));
          continue;
        }
        if (op.action === 'delete') {
          const at = entries.findIndex((e) => e.id === op.id);
          if (at < 0) {
            refused.push(t('{where}里没有 {id}', { where, id: op.id ?? '' }));
            continue;
          }
          if (!isActiveMemory(entries[at])) {
            refused.push(t('{where}里的 {id} 已经失效', { where, id: op.id ?? '' }));
            continue;
          }
          entries[at] = { ...entries[at], archived: true, invalidAt: now };
          done.push(t('删掉了{where}「{text}」', { where, text: entries[at].text }));
          changed = true;
          continue;
        }
        const text = op.text?.trim() ?? '';
        const why = op.why?.trim() || undefined;
        if (!text) {
          refused.push(t('text 不能是空的'));
          continue;
        }
        if (text.length + (why?.length ?? 0) > ENTRY_CHARS) {
          refused.push(t('「{text}…」太长了：一条不超过 {n} 字，拆开或写短一些', { text: text.slice(0, 20), n: ENTRY_CHARS }));
          continue;
        }
        const type = op.type && MEMORY_TYPES[scope].includes(op.type) ? op.type : undefined;
        if (op.type && !type) {
          refused.push(t('这个作用域不支持类型 {type}；可用：{list}', { type: op.type, list: MEMORY_TYPES[scope].join('、') }));
          continue;
        }
        if (op.action === 'update') {
          const at = entries.findIndex((e) => e.id === op.id);
          if (at < 0) {
            refused.push(t('{where}里没有 {id}', { where, id: op.id ?? '' }));
            continue;
          }
          const old = entries[at];
          if (!isActiveMemory(old)) {
            refused.push(t('{where}里的 {id} 已经失效', { where, id: op.id ?? '' }));
            continue;
          }
          const entityId = op.entityId === undefined ? old.entityId : entityFor(op.entityId);
          if (entityId === false) {
            refused.push(t('{where}里没有这个设定条目 {id}', { where, id: op.entityId ?? '' }));
            continue;
          }
          if (old.text === text && (old.why ?? '') === (why ?? '') && (!type || old.type === type) && (old.entityId ?? '') === (entityId ?? '')) continue;
          const snapshot = entries.map((e) => ({ ...e, ...(e.source ? { source: { ...e.source } } : {}) }));
          const entry: MemoryEntry = {
            id: `m${nanoid(6)}`,
            type: type ?? old.type,
            text,
            ...(why ? { why } : {}),
            ...(entityId ? { entityId } : {}),
            at: now,
            validAt: now,
            ...(old.pinned ? { pinned: true } : {}),
            source,
            confidence: confidenceOf(op.confidence, source.kind),
            by: 'assistant',
          };
          entries[at] = { ...old, invalidAt: now, supersededBy: entry.id };
          entries.push(entry);
          const archived = makeRoom(entries, scope, new Set([entry.id]), now);
          if (activeSize(entries) > MEMORY_LIMIT[scope]) {
            entries.splice(0, entries.length, ...snapshot);
            refused.push(t('{where}满了（上限 {n} 字）：先合并或删掉不再需要的', { where, n: MEMORY_LIMIT[scope] }));
            continue;
          }
          done.push(t('更新了{where}「{text}」', { where, text }));
          if (archived.length) done.push(t('{where}已满，归档了 {n} 条旧记忆', { where, n: archived.length }));
          changed = true;
          continue;
        }
        const entityId = entityFor(op.entityId);
        if (entityId === false) {
          refused.push(t('{where}里没有这个设定条目 {id}', { where, id: op.entityId ?? '' }));
          continue;
        }
        if (entries.some((e) => isActiveMemory(e) && same(e.text, text))) continue;
        // Near-duplicates are not stacked: the same thing is skipped, a change is pointed at update.
        const nearby = entries
          .filter((e) => isActiveMemory(e) && (e.entityId ?? '') === (entityId ?? ''))
          .map((e) => ({ entry: e, sim: memorySimilarity(e.text, text) }))
          .sort((a, b) => b.sim - a.sim)[0];
        if (nearby && nearby.sim >= SAME_TEXT) continue;
        if (nearby && nearby.sim >= NEAR_TEXT) {
          refused.push(
            t('{where}里已有相近的一条「{text}」：用 update 改它（id {id}），不要新增', {
              where,
              text: clip(nearby.entry.text, 20),
              id: nearby.entry.id,
            }),
          );
          continue;
        }
        const snapshot = entries.map((e) => ({ ...e, ...(e.source ? { source: { ...e.source } } : {}) }));
        const entry: MemoryEntry = {
          id: `m${nanoid(6)}`,
          type: type ?? MEMORY_TYPES[scope][0],
          text,
          ...(why ? { why } : {}),
          ...(entityId ? { entityId } : {}),
          at: now,
          validAt: now,
          source,
          confidence: confidenceOf(op.confidence, source.kind),
          by: 'assistant',
        };
        entries.push(entry);
        const archived = makeRoom(entries, scope, new Set([entry.id]), now);
        if (activeSize(entries) > MEMORY_LIMIT[scope]) {
          entries.splice(0, entries.length, ...snapshot);
          refused.push(
            t('{where}满了（上限 {n} 字）：先合并或删掉不再需要的，再记「{text}」', {
              where,
              n: MEMORY_LIMIT[scope],
              text: text.slice(0, 20),
            }),
          );
          continue;
        }
        done.push(t('记住了{where}「{text}」', { where, text }));
        if (archived.length) done.push(t('{where}已满，归档了 {n} 条旧记忆', { where, n: archived.length }));
        changed = true;
      }
      if (changed) await this.write(scope, owner, { auto: memory.auto, entries, entities: memory.entities });
    }
    return { done, refused };
  }

  /** The assistant's changes to entities: add, update in place, or archive one; on the board or the series. */
  async applyEntities(projectId: string, ops: EntityOp[], seriesId?: string): Promise<{ done: string[]; refused: string[] }> {
    const done: string[] = [];
    const refused: string[] = [];
    if (!ops.length) return { done, refused };
    for (const scope of ['series', 'board'] as const) {
      const mine = ops.filter((o) => (o.scope ?? 'board') === scope);
      if (!mine.length) continue;
      if (scope === 'series' && !seriesId) {
        refused.push(...mine.map(() => t('这块画布不属于任何系列，不能写系列记忆')));
        continue;
      }
      const owner = scope === 'series' ? seriesId! : projectId;
      const memory = await this.read(scope, owner);
      const where = scope === 'board' ? t('画布记忆') : t('系列记忆');
      const entities: MemoryEntity[] = memory.entities.map((e) => ({ ...e, refs: e.refs.map((r) => ({ ...r })) }));
      let changed = false;
      for (const op of mine) {
        const now = Date.now();
        if (!memory.auto && !op.requestedByUser) {
          refused.push(t('{where}：用户关掉了自动记忆；只有用户明确要求时才能写入', { where }));
          continue;
        }
        if (op.action === 'delete') {
          const at = entities.findIndex((e) => e.id === op.id);
          if (at < 0) {
            refused.push(t('{where}里没有 {id}', { where, id: op.id ?? '' }));
            continue;
          }
          if (!isActiveEntity(entities[at])) {
            refused.push(t('{where}里的 {id} 已经失效', { where, id: op.id ?? '' }));
            continue;
          }
          entities[at] = { ...entities[at], archived: true };
          done.push(t('删掉了{where}的设定「{name}」', { where, name: entities[at].name }));
          changed = true;
          continue;
        }
        const old = op.action === 'update' ? entities.find((e) => e.id === op.id) : undefined;
        if (op.action === 'update' && !old) {
          refused.push(t('{where}里没有 {id}', { where, id: op.id ?? '' }));
          continue;
        }
        if (old && !isActiveEntity(old)) {
          refused.push(t('{where}里的 {id} 已经失效', { where, id: op.id ?? '' }));
          continue;
        }
        if (op.kind && !ENTITY_KINDS.includes(op.kind)) {
          refused.push(t('不支持的设定类型 {kind}；可用：{list}', { kind: op.kind, list: ENTITY_KINDS.join('、') }));
          continue;
        }
        const kind = op.kind ?? old?.kind ?? 'character';
        const name = (op.name ?? old?.name ?? '').trim();
        if (!name) {
          refused.push(t('设定条目的名字不能是空的'));
          continue;
        }
        if (name.length > ENTITY_NAME_CHARS) {
          refused.push(t('「{name}…」太长了：设定条目的名字不超过 {n} 字', { name: name.slice(0, 12), n: ENTITY_NAME_CHARS }));
          continue;
        }
        const summary = (op.summary ?? old?.summary ?? '').trim();
        if (summary.length > ENTITY_SUMMARY_CHARS) {
          refused.push(t('设定条目的简介不超过 {n} 字，写短一些', { n: ENTITY_SUMMARY_CHARS }));
          continue;
        }
        const refs = op.refs ? refsOf(op.refs) : (old?.refs ?? []);
        if (op.action === 'add') {
          const clash = entities.find((e) => isActiveEntity(e) && e.kind === kind && same(e.name, name));
          if (clash) {
            if (same(clash.summary, summary)) continue;
            refused.push(
              t('{where}里已经有{kind}「{name}」：用 update 改它（id {id}）', { where, kind: ENTITY_LABEL[kind], name, id: clash.id }),
            );
            continue;
          }
          const snapshot = entities.map((e) => ({ ...e }));
          const entity: MemoryEntity = {
            id: `e${nanoid(6)}`,
            kind,
            name,
            summary,
            refs,
            at: now,
            by: 'assistant',
            source: { kind: 'chat' },
          };
          entities.push(entity);
          const archived = makeEntityRoom(entities, new Set([entity.id]));
          if (entities.filter(isActiveEntity).length > MAX_ENTITIES) {
            entities.splice(0, entities.length, ...snapshot);
            refused.push(t('{where}的设定条目已经满了（{n} 个），而且都置顶了：先删掉一些', { where, n: MAX_ENTITIES }));
            continue;
          }
          done.push(t('记住了{where}的{kind}「{name}」', { where, kind: ENTITY_LABEL[kind], name }));
          if (archived) done.push(t('设定条目已满，归档了 {n} 个旧的', { n: archived }));
          changed = true;
          continue;
        }
        if (!old) continue;
        if (old.name === name && old.summary === summary && old.kind === kind && JSON.stringify(old.refs) === JSON.stringify(refs)) {
          continue;
        }
        entities[entities.indexOf(old)] = { ...old, kind, name, summary, refs, at: now, by: 'assistant' };
        done.push(t('更新了{where}的{kind}「{name}」', { where, kind: ENTITY_LABEL[kind], name }));
        changed = true;
      }
      if (changed) await this.write(scope, owner, { auto: memory.auto, entries: memory.entries, entities });
    }
    return { done, refused };
  }

  /**
   * Finds memory by words, entity and scope. BM25 over Chinese character bigrams and Latin words decides the
   * order, with a small bonus for recent and often-read entries; when an embeddings model is configured,
   * meaning adds to it, so a paraphrase finds the entry too. Without one, or when the endpoint fails, this
   * stays keyword-only.
   */
  async search(projectId: string, query: MemoryQuery, seriesId?: string): Promise<MemoryHit[]> {
    const scopes: MemoryScope[] =
      query.scope === 'series' || query.scope === 'board' || query.scope === 'user' ? [query.scope] : ['series', 'board', 'user'];
    const ask = query.text?.trim() ?? '';
    const words = (query.text ?? '').split(/\s+/).map(normalize).filter(Boolean);
    const asked = [...new Set(tokens(ask))];
    const hits: (MemoryHit & { score: number })[] = [];
    for (const scope of scopes) {
      if (scope === 'series' && !seriesId) continue;
      const owner = scope === 'series' ? seriesId! : projectId;
      const memory = await this.read(scope, owner);
      const names = new Map(memory.entities.map((e) => [e.id, e.name]));
      const entities = memory.entities.filter(
        (e) => (isActiveEntity(e) || query.includeHistory) && (!query.entityId || e.id === query.entityId),
      );
      const entries = memory.entries.filter(
        (e) => (isActiveMemory(e) || query.includeHistory) && (!query.entityId || e.entityId === query.entityId),
      );
      const semantic =
        words.length && this.embedder
          ? await this.semantic(
              scope,
              owner,
              new Map([
                ...entities.map((e) => [`e${e.id}`, `${e.name} ${e.summary}`] as const),
                ...entries.map((e) => [`m${e.id}`, `${e.text} ${e.why ?? ''} ${names.get(e.entityId ?? '') ?? ''}`] as const),
              ]),
              ask,
            )
          : undefined;
      /** What retrieval reads for a hit; built once so every term's document frequency is known. */
      const corpus = new Map<string, { text: string; length: number; counts: Map<string, number> }>();
      const addDoc = (key: string, text: string) => {
        const list = tokens(text);
        const counts = new Map<string, number>();
        for (const token of list) counts.set(token, (counts.get(token) ?? 0) + 1);
        corpus.set(key, { text: normalize(text), length: list.length, counts });
      };
      for (const entity of entities) addDoc(`e${entity.id}`, `${entity.name} ${entity.summary}`);
      for (const entry of entries) addDoc(`m${entry.id}`, `${entry.text} ${entry.why ?? ''} ${names.get(entry.entityId ?? '') ?? ''}`);
      const df = new Map<string, number>();
      for (const doc of corpus.values()) for (const token of doc.counts.keys()) df.set(token, (df.get(token) ?? 0) + 1);
      const avg = [...corpus.values()].reduce((n, d) => n + d.length, 0) / (corpus.size || 1);
      const bm25 = (key: string) => {
        const doc = corpus.get(key);
        if (!doc) return 0;
        let n = 0;
        for (const token of asked) {
          const tf = doc.counts.get(token) ?? 0;
          if (!tf) continue;
          const seen = df.get(token) ?? 0;
          const idf = Math.log(1 + (corpus.size - seen + 0.5) / (seen + 0.5));
          n += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / (avg || 1))));
        }
        return n;
      };
      const relevance = (key: string, pinned: boolean) => matchScore(corpus.get(key)?.text ?? '', words, pinned) + bm25(key);
      for (const entity of entities) {
        const kw = relevance(`e${entity.id}`, Boolean(entity.pinned));
        const sim = semantic?.get(`e${entity.id}`);
        if (words.length && kw <= (entity.pinned ? 2 : 0) && (sim ?? 0) < SEMANTIC_MIN) continue;
        const text = `${entity.name}：${entity.summary}`.replace(/：$/, '');
        hits.push({
          kind: 'entity',
          scope,
          id: entity.id,
          text,
          at: entity.at,
          by: entity.by,
          active: isActiveEntity(entity),
          ...(entity.pinned ? { pinned: true } : {}),
          entityKind: entity.kind,
          score: kw + semanticScore(sim) + recencyBoost(entity),
        });
      }
      for (const entry of entries) {
        const kw = relevance(`m${entry.id}`, Boolean(entry.pinned));
        const sim = semantic?.get(`m${entry.id}`);
        if (words.length && kw <= (entry.pinned ? 2 : 0) && (sim ?? 0) < SEMANTIC_MIN) continue;
        hits.push({
          kind: 'entry',
          scope,
          id: entry.id,
          text: entry.text,
          at: entry.at,
          by: entry.by,
          active: isActiveMemory(entry),
          type: entry.type,
          ...(entry.pinned ? { pinned: true } : {}),
          ...(entry.entityId ? { entityId: entry.entityId } : {}),
          ...(entry.entityId && names.has(entry.entityId) ? { entityName: names.get(entry.entityId) } : {}),
          score: kw + semanticScore(sim) + recencyBoost(entry),
        });
      }
    }
    const limit = Math.max(1, Math.min(50, query.limit ?? 20));
    return hits
      .sort((a, b) => b.score - a.score || Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.at - a.at)
      .slice(0, limit)
      .map(({ score: _score, ...hit }) => hit);
  }

  /**
   * Similarity of each candidate to the query, from the scope's vector index. Vectors are embedded once per
   * text and kept beside the memory; a missing or broken index only means embedding again, and a failed
   * endpoint means no semantic scores this time.
   */
  private async semantic(
    scope: MemoryScope,
    owner: string,
    texts: Map<string, string>,
    query: string,
  ): Promise<Map<string, number> | undefined> {
    const embedder = this.embedder;
    if (!embedder || !texts.size || !query) return undefined;
    try {
      const [queryVector] = await embedder.embed([query.slice(0, 500)]);
      if (!queryVector?.length) return undefined;
      const file = this.indexFile(scope, owner);
      const index = await this.readIndex(file, embedder.model);
      const missing: { key: string; text: string; hash: string }[] = [];
      for (const [key, text] of texts) {
        const hash = hashText(`${embedder.model}\n${text}`);
        const hit = index.items[key];
        if (hit && hit.hash === hash && hit.vector.length === queryVector.length) continue;
        missing.push({ key, text, hash });
      }
      if (missing.length) {
        const vectors = await embedder.embed(missing.map((m) => m.text));
        if (vectors.length !== missing.length) throw new Error('embeddings: count mismatch');
        missing.forEach((m, i) => {
          index.items[m.key] = { hash: m.hash, vector: vectors[i] };
        });
        // Forget vectors of texts no longer in the scope, so the file stays small.
        const wanted = new Set(texts.keys());
        for (const key of Object.keys(index.items)) if (!wanted.has(key)) delete index.items[key];
        await this.writeIndex(file, index);
      }
      const scores = new Map<string, number>();
      for (const key of texts.keys()) {
        const vector = index.items[key]?.vector;
        if (vector) scores.set(key, cosine(vector, queryVector));
      }
      return scores;
    } catch (err) {
      // Not being able to embed must never break recall: keywords still work.
      console.error('agent: memory embeddings unavailable; searching by keywords only', err);
      return undefined;
    }
  }

  private indexFile(scope: MemoryScope, owner: string) {
    // User memory is the same on every board, so its index is too.
    return join(this.dir, scope === 'user' ? 'memory-index-user.json' : `memory-index-${scope}-${owner}.json`);
  }

  private async readIndex(file: string, model: string): Promise<VectorIndex> {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as Partial<VectorIndex>;
      if (saved.version === INDEX_VERSION && saved.model === model && saved.items && typeof saved.items === 'object') {
        const items: VectorIndex['items'] = {};
        for (const [key, value] of Object.entries(saved.items)) {
          const v = value as { hash?: unknown; vector?: unknown };
          if (typeof v?.hash === 'string' && Array.isArray(v.vector) && v.vector.every((n) => typeof n === 'number')) {
            items[key] = { hash: v.hash, vector: v.vector as number[] };
          }
        }
        return { version: INDEX_VERSION, model, items };
      }
    } catch {
      /* missing or broken: rebuilt below */
    }
    return { version: INDEX_VERSION, model, items: {} };
  }

  private async writeIndex(file: string, index: VectorIndex) {
    try {
      await writeJson(file, () => index);
    } catch (err) {
      console.error('agent: could not save the memory index', err);
    }
  }

  /** One entry or entity with what it replaced, what hangs off it, and where it points. */
  async detail(projectId: string, id: string, seriesId?: string): Promise<MemoryDetail | undefined> {
    const scopes: MemoryScope[] = seriesId ? ['series', 'board', 'user'] : ['board', 'user'];
    for (const scope of scopes) {
      const owner = scope === 'series' ? seriesId! : projectId;
      const memory = await this.read(scope, owner);
      const entity = memory.entities.find((e) => e.id === id);
      if (entity) {
        // Reading it is a use: retrieval later gives it a small bonus.
        const used = { ...entity, useCount: (entity.useCount ?? 0) + 1, lastUsedAt: Date.now() };
        await this.write(scope, owner, { ...memory, entities: memory.entities.map((e) => (e.id === entity.id ? used : e)) });
        const facts = memory.entries.filter((e) => e.entityId === entity.id && isActiveMemory(e));
        return { scope, entity: used, chain: [], facts };
      }
      const entry = memory.entries.find((e) => e.id === id);
      if (!entry) continue;
      const used = { ...entry, useCount: (entry.useCount ?? 0) + 1, lastUsedAt: Date.now() };
      const entries = memory.entries.map((e) => (e.id === entry.id ? used : e));
      await this.write(scope, owner, { ...memory, entries });
      const byId = new Map(entries.map((e) => [e.id, e]));
      let first: MemoryEntry = used;
      const back = new Set<string>([used.id]);
      for (;;) {
        const prev = entries.find((e) => e.supersededBy === first.id && !back.has(e.id));
        if (!prev) break;
        back.add(prev.id);
        first = prev;
      }
      const chain: MemoryEntry[] = [];
      let cur: MemoryEntry | undefined = first;
      while (cur && !chain.some((e) => e.id === cur!.id)) {
        chain.push(cur);
        cur = cur.supersededBy ? byId.get(cur.supersededBy) : undefined;
      }
      const parent = used.entityId ? memory.entities.find((e) => e.id === used.entityId) : undefined;
      return { scope, entry: used, ...(parent ? { entity: parent } : {}), chain, facts: [] };
    }
    return undefined;
  }

  /** A board branched from this one starts with the same memory. */
  async copy(fromProjectId: string, toProjectId: string): Promise<void> {
    const memory = await this.read('board', fromProjectId);
    await this.write('board', toProjectId, memory);
  }

  /** The board was deleted. Series memory stays: other boards still share it. */
  async forget(projectId: string) {
    await rm(this.file('board', projectId), { force: true });
    await rm(this.indexFile('board', projectId), { force: true });
  }
}

/** A writer's certainty, shown only where it is worth doubting. */
const lowConfidence = (e: MemoryEntry) =>
  e.confidence !== undefined && e.confidence < SOURCE_CONFIDENCE.chat ? ` · 可信度 ${e.confidence.toFixed(1)}` : '';

/**
 * Board settings that recur on several boards of a series and the series does not have yet: promoting one
 * makes it true for every board, instead of each keeping its own copy.
 */
export function memoryPromotions(
  series: AgentMemory,
  boards: { id: string; name: string; memory: AgentMemory }[],
): MemoryPromotion[] {
  const known = series.entries.filter(isActiveMemory);
  const groups: { text: string; entry: MemoryEntry; boards: Map<string, string> }[] = [];
  for (const board of boards) {
    for (const entry of board.memory.entries.filter(isActiveMemory)) {
      const group = groups.find((g) => memorySimilarity(g.text, entry.text) >= NEAR_TEXT);
      if (group) group.boards.set(board.id, board.name);
      else groups.push({ text: entry.text, entry, boards: new Map([[board.id, board.name]]) });
    }
  }
  return groups
    .filter((g) => g.boards.size >= 2 && !known.some((e) => memorySimilarity(e.text, g.text) >= NEAR_TEXT))
    .map((g) => ({
      text: g.entry.text,
      type: g.entry.type,
      ...(g.entry.why ? { why: g.entry.why } : {}),
      boards: [...g.boards].map(([id, name]) => ({ id, name })),
      at: g.entry.at,
    }))
    .sort((a, b) => b.boards.length - a.boards.length || b.at - a.at)
    .slice(0, 20);
}

/** One entry as the model reads it in the prompt: id, type, date, author, and a low confidence when there is one. */
const entryLine = (e: MemoryEntry) =>
  `- [${e.id} · ${TYPE_LABEL[e.type]} · ${date(e.at)} · ${e.by === 'user' ? '你' : '助手'}${lowConfidence(e)}] ${e.text}${e.why ? `（${e.why}）` : ''}`;

/** Memory as the model reads it: an entity index, the unscoped facts in effect, and the ids to act on. */
export function memoryBlock(board: AgentMemory, series: AgentMemory | undefined, user: AgentMemory): string {
  const entries = (m: AgentMemory) => {
    const active = m.entries.filter(isActiveMemory);
    return active.length ? active.map(entryLine) : ['（空）'];
  };
  const autoNote = (m: AgentMemory) =>
    m.auto ? [] : ['用户关掉了这部分的自动记忆：不要主动写入；用户明确要求时，用 remember 的 requested_by_user=true 记；delete 仍然可以。'];
  const section = (title: string, lines: string[], m: AgentMemory) => [`### ${title}`, ...lines, ...autoNote(m)].join('\n');

  /** A scope's entities first (details read on demand), then the facts not attached to one. */
  const scopeLines = (m: AgentMemory) => {
    const entities = m.entities.filter(isActiveEntity).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || a.at - b.at);
    const known = new Set(entities.map((e) => e.id));
    const index = entities.map(
      (e) => `- [${e.id} · ${ENTITY_LABEL[e.kind]}${e.pinned ? ' · 置顶' : ''}] ${e.name}${e.summary ? `：${clip(e.summary, 80)}` : ''}`,
    );
    // Facts attached to an entity are read on demand; only unscoped ones stay in the prompt.
    const loose = m.entries.filter((e) => isActiveMemory(e) && (!e.entityId || !known.has(e.entityId)));
    return [
      ...(index.length ? ['#### 设定条目（详情和挂在上面的事实用 read_memory <id> 读，或 search_memory 找）', ...index] : []),
      ...(index.length ? ['#### 其它记忆'] : []),
      ...(loose.length ? loose.map(entryLine) : ['（空）']),
    ];
  };
  return [
    '## 记忆',
    '下面是之前记下的，方括号里是 id、类型、写入日期和作者。只列出生效中的条目；它们可能过时：和画布内容、用户最新的话冲突时，以后者为准，并用 remember 更新或删掉旧的。设定条目的详情不在提示词里：需要时用 read_memory 读，或先用 search_memory 找。',
    section('用户偏好（所有画布通用，scope user）', entries(user), user),
    ...(series ? [section('系列设定（这个系列的所有画布共享，scope series）', scopeLines(series), series)] : []),
    section('这块画布（scope board）', scopeLines(board), board),
  ].join('\n');
}

/** One memory in full, for the read_memory tool: current state, provenance and what it replaced. */
export function describeMemory(detail: MemoryDetail): string {
  const where = detail.scope === 'board' ? '这块画布' : detail.scope === 'series' ? '系列记忆' : '用户偏好';
  const state = (e: MemoryEntry) => (e.archived ? '已归档' : e.invalidAt ? '已失效' : '生效中');
  if (detail.entity && !detail.entry) {
    const e = detail.entity;
    const refs = e.refs.map((r) => [r.itemId ? `节点 \`${r.itemId}\`` : '', r.assetId ? `素材 \`${r.assetId}\`` : ''].filter(Boolean).join('、')).filter(Boolean);
    return [
      `设定条目 [${e.id}] ${ENTITY_LABEL[e.kind]} · ${e.name}（${where}${e.pinned ? ' · 置顶' : ''}${e.archived ? ' · 已归档' : ''}）`,
      `简介：${e.summary || '（没有）'}`,
      ...(refs.length ? [`关联：${refs.join('；')}`] : []),
      `作者：${e.by === 'user' ? '用户' : '助手'} · ${date(e.at)}`,
      `挂在上面的事实（${detail.facts.length} 条）：`,
      ...(detail.facts.length ? detail.facts.map(entryLine) : ['（没有）']),
    ].join('\n');
  }
  if (!detail.entry) return '（没有这条记忆）';
  const e = detail.entry;
  const parent = detail.entity;
  return [
    `条目 [${e.id}] ${TYPE_LABEL[e.type]} · ${date(e.at)} · ${e.by === 'user' ? '用户' : '助手'} · ${state(e)}（${where}）`,
    `内容：${e.text}`,
    ...(e.why ? [`原因：${e.why}`] : []),
    ...(parent ? [`挂在：${ENTITY_LABEL[parent.kind]}「${parent.name}」（${parent.id}）`] : []),
    ...(e.source ? [`来源：${SOURCE_LABEL[e.source.kind]}${e.source.itemId ? ` · 节点 \`${e.source.itemId}\`` : ''}${e.source.entryId ? ` · 消息 \`${e.source.entryId}\`` : ''}`] : []),
    ...(e.confidence !== undefined ? [`可信度：${Math.round(e.confidence * 100)}%`] : []),
    ...(detail.chain.length > 1
      ? [
          '沿革（旧到新）：',
          ...detail.chain.map(
            (old) => `- ${date(old.at)} [${old.id}] ${old.text}${old.id === e.id ? '（这一条）' : old.supersededBy ? ` → 由 ${old.supersededBy} 替代` : ''}`,
          ),
        ]
      : []),
  ].join('\n');
}

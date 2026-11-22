import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'kynflow-memory-test-'));
const { MemoryStore, memoryBlock, memoryPromotions, describeMemory } = await import('../server/agent/memory.ts');
const { readMemoryUpdates } = await import('../server/agent/runtime.ts');
const { isActiveEntity, isActiveMemory } = await import('../shared/types.ts');

const store = () => new MemoryStore(mkdtempSync(join(tmpdir(), 'kynflow-memory-')));
const board = 'board00001';

test('the assistant adds, updates and deletes memory, without saying the same thing twice', async () => {
  const m = store();
  const first = await m.apply(board, [
    { action: 'add', scope: 'board', type: 'setting', text: '主角叫林晚，22 岁，短发' },
    { action: 'add', scope: 'user', type: 'preference', text: '默认 16:9，不要字幕' },
    { action: 'add', scope: 'board', type: 'setting', text: '主角叫林晚，22岁，短发。' },
  ]);
  assert.equal(first.done.length, 2, 'the third says what the first does');
  const saved = await m.read('board', board);
  assert.equal(saved.entries.length, 1);
  const id = saved.entries[0].id;
  assert.equal(saved.entries[0].by, 'assistant');

  await m.apply(board, [{ action: 'update', scope: 'board', id, text: '主角叫林晚，22 岁，长发', why: '用户改了设定' }]);
  const after = await m.read('board', board);
  assert.equal(after.entries.length, 2, 'the old entry stays as history');
  const active = after.entries.filter(isActiveMemory);
  assert.deepEqual(active.map((e) => [e.text, e.why]), [['主角叫林晚，22 岁，长发', '用户改了设定']]);
  assert.equal(after.entries[0].invalidAt !== undefined, true);
  assert.equal(after.entries[0].supersededBy, active[0].id);

  const gone = await m.apply(board, [
    { action: 'delete', scope: 'board', id: active[0].id },
    { action: 'delete', scope: 'board', id: 'nope' },
  ]);
  assert.equal(gone.done.length, 1);
  assert.match(gone.refused[0], /没有 nope/);
  assert.equal((await m.read('board', board)).entries.filter(isActiveMemory).length, 0);
  assert.equal((await m.read('user', 'another0001')).entries.length, 1, 'user memory is the same on every board');
});

test('memory archives old entries when full, instead of refusing everything', async () => {
  const m = store();
  const long = await m.apply(board, [{ action: 'add', scope: 'board', text: '长'.repeat(301) }]);
  assert.match(long.refused[0], /太长了/);
  const many = Array.from({ length: 8 }, (_, i) => ({ action: 'add' as const, scope: 'user' as const, text: '甲乙丙丁戊己庚辛'[i].repeat(140) }));
  const full = await m.apply(board, many);
  assert.equal(full.done.filter((d) => d.includes('记住了')).length, 8, 'the newest entries are kept');
  assert.equal(full.refused.length, 0);
  const entries = (await m.read('user', board)).entries;
  assert.ok(entries.some((e) => !isActiveMemory(e)), 'the oldest entries were archived');
  const activeSize = entries.filter(isActiveMemory).reduce((n, e) => n + e.text.length, 0);
  assert.ok(activeSize <= 1000, `active memory fits the limit (${activeSize})`);
});

test('a pinned entry survives automatic cleanup', async () => {
  const m = store();
  await m.apply(board, [{ action: 'add', scope: 'board', type: 'decision', text: '画风用日系动画' }]);
  const [kept] = (await m.read('board', board)).entries;
  await m.replace('board', board, { auto: true, entries: [{ ...kept, pinned: true }] });
  const many = Array.from({ length: 10 }, (_, i) => ({
    action: 'add' as const,
    scope: 'board' as const,
    text: '一二三四五六七八九十'[i].repeat(240),
  }));
  await m.apply(board, many);
  const entries = (await m.read('board', board)).entries;
  assert.ok(entries.some((e) => e.pinned && isActiveMemory(e) && e.text === '画风用日系动画'));
});

test('a scope switched off still allows deletion and an explicit user request', async () => {
  const m = store();
  await m.replace('board', board, { auto: false, entries: [] });
  const off = await m.apply(board, [{ action: 'add', scope: 'board', text: '画风用水彩' }]);
  assert.match(off.refused[0], /关掉了自动记忆/);
  assert.equal((await m.read('board', board)).entries.length, 0);

  const asked = await m.apply(board, [{ action: 'add', scope: 'board', text: '画风用水彩', requestedByUser: true }]);
  assert.equal(asked.done.length, 1);
  const [entry] = (await m.read('board', board)).entries;
  const removed = await m.apply(board, [{ action: 'delete', scope: 'board', id: entry.id }]);
  assert.equal(removed.done.length, 1, 'delete is always allowed');
});

test('the user edits memory in the page: new entries get ids, edited ones become the user\'s, and limits hold', async () => {
  const m = store();
  await m.apply(board, [{ action: 'add', scope: 'board', type: 'decision', text: '画风用日系动画' }]);
  const [kept] = (await m.read('board', board)).entries;
  const saved = await m.replace('board', board, {
    auto: true,
    entries: [
      kept,
      { id: '', type: 'setting', text: '女主穿灰色卫衣', at: 0, by: 'user' },
      { id: '', type: 'setting', text: '  ', at: 0, by: 'user' },
    ],
  });
  assert.equal(saved.entries.length, 2, 'an empty row is dropped');
  assert.deepEqual([saved.entries[0].id, saved.entries[0].by], [kept.id, 'assistant'], 'unchanged keeps its author');
  assert.ok(saved.entries[1].id.startsWith('m') && saved.entries[1].by === 'user');
  await assert.rejects(m.replace('board', board, { auto: true, entries: [{ text: '长'.repeat(301) }] }), /不超过/);
  await assert.rejects(m.replace('board', board, { entries: 'x' }), /格式错误/);
});

test('types outside a scope are refused, not silently changed', async () => {
  const m = store();
  const applied = await m.apply(board, [{ action: 'add', scope: 'board', type: 'feedback', text: '不要用写实' }]);
  assert.match(applied.refused[0], /不支持类型/);
  await assert.rejects(m.replace('board', board, { entries: [{ type: 'feedback', text: '不要用写实' }] }), /不支持类型/);
});

test('a broken memory file is kept aside instead of being overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kynflow-memory-'));
  const m = new MemoryStore(dir);
  writeFileSync(join(dir, `memory-board-${board}.json`), '{ broken');
  assert.deepEqual(await m.read('board', board), { auto: true, entries: [], entities: [] });
  assert.ok(readdirSync(dir).some((name) => name.includes('.corrupt-')));
});

test('branching a board carries its memory across', async () => {
  const m = store();
  await m.apply(board, [{ action: 'add', scope: 'board', type: 'setting', text: '主角叫林晚' }]);
  await m.copy(board, 'branch0001');
  assert.deepEqual(await m.read('board', 'branch0001'), await m.read('board', board));
});

test('the model reads memory with ids, types, dates and authors, and is told a scope is switched off', () => {
  const block = memoryBlock(
    { auto: false, entities: [], entries: [{ id: 'm1', type: 'decision', text: '画风用日系动画', why: '用户否掉了写实', at: 1, by: 'assistant' }] },
    undefined,
    { auto: true, entities: [], entries: [] },
  );
  assert.match(block, /- \[m1 · 决定 · \d{2}-\d{2} · 助手\] 画风用日系动画（用户否掉了写实）/);
  assert.match(block, /### 用户偏好.*\n（空）/);
  assert.match(block, /用户关掉了这部分的自动记忆/);
});

test('memory updates after a summary are read when well-formed, and the malformed case is reported', () => {
  const ok = readMemoryUpdates(
    '## 下一步\n- 出视频\n<memory_updates>\n[{"action":"add","scope":"board","type":"decision","text":"用 480p"},{"action":"jump","scope":"board"},{"action":"delete","scope":"user","id":"m2"}]\n</memory_updates>',
  );
  assert.deepEqual(ok.ops, [
    { action: 'add', scope: 'board', type: 'decision', text: '用 480p' },
    { action: 'delete', scope: 'user', id: 'm2' },
  ]);
  assert.equal(ok.malformed, false);
  assert.deepEqual(readMemoryUpdates('<memory_updates>不是 JSON</memory_updates>'), { ops: [], malformed: true });
  assert.deepEqual(readMemoryUpdates('没有这一段'), { ops: [], malformed: false });
});

test('board entities are added, updated in place and archived, with duplicates refused', async () => {
  const m = store();
  const added = await m.applyEntities(board, [
    { action: 'add', kind: 'character', name: '林晚', summary: '22 岁，短发', refs: [{ itemId: 'i1', assetId: 'a1' }] },
    { action: 'add', kind: 'character', name: '林晚', summary: '22 岁，短发' },
    { action: 'add', kind: 'character', name: '林晚', summary: '30 岁' },
    { action: 'add', kind: 'style', name: '日系动画', summary: '' },
  ]);
  assert.equal(added.done.length, 2);
  assert.match(added.refused[0], /已经有/);
  const [entity] = (await m.read('board', board)).entities;
  assert.deepEqual(entity.refs, [{ itemId: 'i1', assetId: 'a1' }]);

  const changed = await m.applyEntities(board, [{ action: 'update', id: entity.id, summary: '22 岁，长发' }]);
  assert.equal(changed.done.length, 1);
  const kept = (await m.read('board', board)).entities;
  assert.equal(kept.length, 2, 'an update changes the entity in place');
  assert.equal(kept.find((e) => e.id === entity.id)?.summary, '22 岁，长发');

  await m.applyEntities(board, [{ action: 'delete', id: entity.id }]);
  const after = (await m.read('board', board)).entities;
  assert.equal(after.filter(isActiveEntity).length, 1);
  assert.equal(after.some((e) => e.id === entity.id && e.archived), true);
});

test('the oldest unpinned entity is archived when there are too many', async () => {
  const m = store();
  for (let i = 0; i < 30; i++) await m.applyEntities(board, [{ action: 'add', kind: 'prop', name: `道具${i}`, summary: '' }]);
  const full = await m.applyEntities(board, [{ action: 'add', kind: 'prop', name: '新道具', summary: '' }]);
  assert.equal(full.done.length, 2, 'the new one, and the archive note');
  const entities = (await m.read('board', board)).entities;
  assert.equal(entities.filter(isActiveEntity).length, 30);
  assert.ok(entities.some((e) => !isActiveEntity(e) && e.name === '道具0'));
});

test('facts attached to an entity stay out of the prompt and are read or searched instead', async () => {
  const m = store();
  await m.applyEntities(board, [{ action: 'add', kind: 'character', name: '林晚', summary: '主角' }]);
  const [entity] = (await m.read('board', board)).entities;
  await m.apply(board, [
    { action: 'add', scope: 'board', type: 'setting', text: '林晚穿灰色卫衣', entityId: entity.id },
    { action: 'add', scope: 'board', type: 'decision', text: '全片 16:9' },
  ]);
  const block = memoryBlock(await m.read('board', board), undefined, await m.read('user', board));
  assert.match(block, new RegExp(`\\[${entity.id} · 人物\\] 林晚：主角`));
  assert.doesNotMatch(block, /灰色卫衣/, 'attached facts are read on demand');
  assert.match(block, /全片 16:9/);

  const hits = await m.search(board, { text: '灰色卫衣' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entityName, '林晚');
  const scoped = await m.search(board, { entityId: entity.id });
  assert.ok(scoped.length >= 2 && scoped.every((h) => h.id === entity.id || h.entityId === entity.id));

  const detail = await m.detail(board, entity.id);
  assert.equal(detail?.facts.length, 1);
  assert.match(describeMemory(detail!), /林晚穿灰色卫衣/);
});

test('a fact cannot hang off an unknown entity or a user-scope entity', async () => {
  const m = store();
  const bad = await m.apply(board, [
    { action: 'add', scope: 'board', text: '穿灰卫衣', entityId: 'nope' },
    { action: 'add', scope: 'user', text: '喜欢长片', entityId: 'nope' },
  ]);
  assert.equal(bad.refused.length, 2);
  assert.equal((await m.read('board', board)).entries.length, 0);
});

test('an empty entity row is dropped, but a named entity cannot lose its name', async () => {
  const m = store();
  const saved = await m.replace('board', board, {
    auto: true,
    entries: [],
    entities: [{ id: '', kind: 'character', name: ' ', summary: '', refs: [], at: 0, by: 'user' }],
  });
  assert.equal(saved.entities.length, 0);
  await m.applyEntities(board, [{ action: 'add', kind: 'prop', name: '刀', summary: '' }]);
  const [entity] = (await m.read('board', board)).entities;
  await assert.rejects(
    m.replace('board', board, { auto: true, entries: [], entities: [{ ...entity, name: '  ' }] }),
    /名字不能是空的/,
  );
});

test('a version 1 file reads without entities and is upgraded on the next write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kynflow-memory-'));
  const file = join(dir, `memory-board-${board}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, auto: true, entries: [{ id: 'm1', type: 'decision', text: '用 480p', at: 1, by: 'assistant' }] }));
  const m = new MemoryStore(dir);
  const before = await m.read('board', board);
  assert.deepEqual(before.entities, []);
  assert.equal(before.entries.length, 1);
  await m.applyEntities(board, [{ action: 'add', kind: 'style', name: '日系动画', summary: '干净的线条' }]);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.entities.length, 1);
});

test('series memory is written once and read by every board in the series', async () => {
  const m = store();
  const seriesId = 'series001';
  const result = await m.apply(
    board,
    [
      { action: 'add', scope: 'series', type: 'setting', text: '世界观：近未来上海' },
      { action: 'add', scope: 'board', type: 'setting', text: '这一集发生在雨夜' },
    ],
    seriesId,
  );
  assert.equal(result.done.length, 2);
  assert.equal((await m.read('series', seriesId)).entries.length, 1);

  // Another board of the same series, with no memory of its own, still finds the series entry.
  const hits = await m.search('another0001', { text: '近未来' }, seriesId);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].scope, 'series');
  const detail = await m.detail('another0001', hits[0].id, seriesId);
  assert.equal(detail?.scope, 'series');
});

test('series memory cannot be written when the board is in no series', async () => {
  const m = store();
  const result = await m.apply(board, [{ action: 'add', scope: 'series', text: '共享设定' }]);
  assert.equal(result.done.length, 0);
  assert.match(result.refused[0], /不属于任何系列/);
});

test('series entities are shared, and facts hang off an entity of their own scope', async () => {
  const m = store();
  const seriesId = 'series002';
  const added = await m.applyEntities(board, [{ action: 'add', scope: 'series', kind: 'character', name: '林晚', summary: '短发' }], seriesId);
  assert.equal(added.done.length, 1);
  const [entity] = (await m.read('series', seriesId)).entities;

  const wrong = await m.apply(board, [{ action: 'add', scope: 'board', text: '林晚怕水', entityId: entity.id }], seriesId);
  assert.match(wrong.refused[0], /没有这个设定条目/, 'a board fact cannot hang off a series entity');
  const ok = await m.apply(board, [{ action: 'add', scope: 'series', text: '林晚怕水', entityId: entity.id }], seriesId);
  assert.equal(ok.done.length, 1);
});

test('the prompt lists the series between user preferences and this board', () => {
  const block = memoryBlock(
    { auto: true, entities: [], entries: [] },
    { auto: true, entities: [], entries: [{ id: 's1', type: 'setting', text: '近未来上海', at: 1, by: 'assistant' }] },
    { auto: true, entities: [], entries: [] },
  );
  const at = (s: string) => block.indexOf(s);
  assert.ok(at('scope user') < at('scope series'));
  assert.ok(at('scope series') < at('scope board'));
  assert.match(block, /近未来上海/);
});

test('a series change in a summary is accepted', () => {
  const { ops, malformed } = readMemoryUpdates(
    '<memory_updates>[{"action":"add","scope":"series","type":"setting","text":"世界观：近未来上海"}]</memory_updates>',
  );
  assert.equal(malformed, false);
  assert.deepEqual(ops, [{ action: 'add', scope: 'series', type: 'setting', text: '世界观：近未来上海' }]);
});

test('a branch carries board memory; series memory stays shared, not copied', async () => {
  const m = store();
  const seriesId = 'series003';
  await m.apply(board, [{ action: 'add', scope: 'board', text: '雨夜' }], seriesId);
  await m.applyEntities(board, [{ action: 'add', scope: 'series', kind: 'style', name: '日系动画', summary: '' }], seriesId);
  await m.copy(board, 'branch0001');
  assert.equal((await m.read('board', 'branch0001')).entries[0].text, '雨夜');
  assert.equal((await m.read('series', seriesId)).entities.length, 1, 'the branch reads the same series memory');
});

test('with an embeddings model, memory is found by meaning; without one, only by keywords', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kynflow-memory-'));
  const vectors: Record<string, number[]> = {
    女主长什么样: [1, 0.1],
    林晚是短发: [1, 0.05],
    画风用写实: [0, 1],
  };
  const embedder = {
    model: 'fake',
    async embed(texts: string[]) {
      return texts.map((text) => vectors[text.trim()] ?? [0, 0]);
    },
  };
  const m = new MemoryStore(dir, embedder);
  await m.apply(board, [{ action: 'add', scope: 'board', type: 'setting', text: '林晚是短发' }]);
  const semantic = await m.search(board, { text: '女主长什么样' });
  assert.deepEqual(semantic.map((h) => h.text), ['林晚是短发']);

  const keywordOnly = new MemoryStore(dir);
  assert.equal((await keywordOnly.search(board, { text: '女主长什么样' })).length, 0, 'a paraphrase does not match keywords');
  assert.equal((await keywordOnly.search(board, { text: '林晚' })).length, 1);
});

test('a failing embeddings endpoint falls back to keywords', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kynflow-memory-'));
  const broken = {
    model: 'fake',
    async embed(): Promise<number[][]> {
      throw new Error('endpoint down');
    },
  };
  const m = new MemoryStore(dir, broken);
  await m.apply(board, [{ action: 'add', scope: 'board', type: 'setting', text: '林晚是短发' }]);
  const hits = await m.search(board, { text: '林晚' });
  assert.equal(hits.length, 1);
});

test('a broken vector index is rebuilt without touching the memory file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kynflow-memory-'));
  const embedder = {
    model: 'fake',
    async embed(texts: string[]) {
      return texts.map((text) => (text.includes('短发') || text.includes('女主') ? [1, 0] : [0, 1]));
    },
  };
  const m = new MemoryStore(dir, embedder);
  await m.apply(board, [{ action: 'add', scope: 'board', type: 'setting', text: '林晚是短发' }]);
  const indexFile = join(dir, `memory-index-board-${board}.json`);
  const memoryFile = join(dir, `memory-board-${board}.json`);
  writeFileSync(indexFile, '{ broken');
  const before = readFileSync(memoryFile, 'utf8');

  const hits = await m.search(board, { text: '女主长什么样' });
  assert.equal(hits.length, 1);
  assert.doesNotThrow(() => JSON.parse(readFileSync(indexFile, 'utf8')), 'the index was rebuilt');
  assert.equal(readFileSync(memoryFile, 'utf8'), before, 'searching never rewrites memory');
});

test('where an entry came from and how sure the writer was are kept; the user\'s edit is certain', async () => {
  const m = store();
  await m.apply(board, [{ action: 'add', scope: 'board', type: 'decision', text: '画风用日系动画' }], undefined, {
    kind: 'condense',
  });
  const [entry] = (await m.read('board', board)).entries;
  assert.equal(entry.source?.kind, 'condense');
  assert.equal(entry.confidence, 0.6);
  const detail = await m.detail(board, entry.id);
  assert.match(describeMemory(detail!), /来源：整理/);
  assert.match(describeMemory(detail!), /可信度：60%/);

  const saved = await m.replace('board', board, { auto: true, entries: [{ ...entry, text: '画风改用水彩' }] });
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].by, 'user');
  assert.equal(saved.entries[0].source?.kind, 'condense', 'provenance is kept; the user made it certain');
  assert.equal(saved.entries[0].confidence, 1);
});

test('a new entry that nearly repeats an active one is skipped or pointed at update', async () => {
  const m = store();
  const first = await m.apply(board, [{ action: 'add', scope: 'board', type: 'setting', text: '主角林晚，22岁，短发' }]);
  assert.equal(first.done.length, 1);
  const again = await m.apply(board, [{ action: 'add', scope: 'board', type: 'setting', text: '主角林晚 22岁 短发。' }]);
  assert.equal(again.done.length, 0, 'the same thing said again is skipped');
  const [kept] = (await m.read('board', board)).entries;
  const near = await m.apply(board, [{ action: 'add', scope: 'board', type: 'setting', text: '主角林晚，22 岁，短头发' }]);
  assert.match(near.refused[0], /相近/);
  assert.match(near.refused[0], new RegExp(kept.id), 'the refusal names the entry to update');
  assert.equal((await m.read('board', board)).entries.length, 1);
});

test('retrieval matches Chinese bigrams, favors a repeated query term, and remembers what was read', async () => {
  const m = store();
  await m.apply(board, [
    { action: 'add', scope: 'board', text: '雨夜 雨夜 街道' },
    { action: 'add', scope: 'board', text: '雨夜 屋顶' },
  ]);
  const ranked = await m.search(board, { text: '雨夜' });
  assert.equal(ranked[0].text, '雨夜 雨夜 街道', 'BM25 counts the repeated term');

  const [first, second] = (await m.read('board', board)).entries;
  const before = await m.search(board, { text: '雨夜' });
  assert.equal(before[0].id, first.id);
  await m.detail(board, second.id);
  const after = await m.read('board', board);
  assert.equal(after.entries.find((e) => e.id === second.id)?.useCount, 1);
  assert.ok(after.entries.find((e) => e.id === second.id)?.lastUsedAt);
  const reread = await m.search(board, { text: '雨夜' });
  assert.equal(reread[0].id, second.id, 'reading an entry helps it come back');
});

test('a setting several boards of a series share is offered for promotion, unless the series has it', () => {
  const entry = (text: string) => ({ id: `m${text}`, type: 'setting' as const, text, at: 1, by: 'assistant' as const });
  const empty = { auto: true, entries: [], entities: [] };
  const boards = [
    { id: 'b1', name: '第一集', memory: { auto: true, entries: [entry('世界观：近未来上海')], entities: [] } },
    { id: 'b2', name: '第二集', memory: { auto: true, entries: [entry('世界观：近未来上海')], entities: [] } },
    { id: 'b3', name: '第三集', memory: { auto: true, entries: [entry('这一集才有的设定')], entities: [] } },
  ];
  const found = memoryPromotions(empty, boards);
  assert.deepEqual(
    found.map((c) => [c.text, c.boards.map((b) => b.name)]),
    [['世界观：近未来上海', ['第一集', '第二集']]],
  );
  assert.equal(memoryPromotions({ ...empty, entries: [entry('世界观：近未来上海')] }, boards).length, 0);
});


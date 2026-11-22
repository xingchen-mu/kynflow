import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import type { AssetInfo, CanvasItem, Project, Task } from '../shared/types.ts';
import { canvasTools } from '../server/agent/tools.ts';
import { DIALOGUE_LUFS, concatClips, levelGains, lineTimes, loudness, placeCues, splitSubtitle, subtitleLayout, subtitleText } from '../server/agent/media.ts';

const skip = spawnSync('ffmpeg', ['-version']).status === 0 ? false : 'ffmpeg is not installed';
const dir = mkdtempSync(join(tmpdir(), 'kynflow-cut-'));

test('subtitles drop pause punctuation and the closing full stop, as Chinese subtitles are set, and keep ？！', () => {
  assert.equal(subtitleText('行，你慢慢看。我把烧烤放桌上了。'), '行　你慢慢看　我把烧烤放桌上了');
  assert.equal(subtitleText('  你疯了吗？！ '), '你疯了吗？！');
  assert.equal(subtitleText('Fine, go.'), 'Fine, go.');
});

test('a line too wide for one subtitle is split at the pause nearest the middle, or at the width', () => {
  assert.deepEqual(splitSubtitle('我等了你整整三年　你现在才告诉我这些', 12), ['我等了你整整三年', '你现在才告诉我这些']);
  assert.deepEqual(splitSubtitle('你到底还要骗我多久？我不想再听了', 10), ['你到底还要骗我多久？', '我不想再听了']);
  const parts = splitSubtitle('一二三四五六七八九十一二三四五六七八九十一二三', 10);
  assert.ok(parts.every((p) => [...p].length <= 10));
  assert.equal(parts.join(''), '一二三四五六七八九十一二三四五六七八九十一二三');
  assert.deepEqual(splitSubtitle('短句', 10), ['短句']);
});

test('dialogue clips are brought to one loudness; clips without dialogue move with the median, not up to speech level', () => {
  assert.deepEqual(levelGains([-20, null, -14, -16]), [4, 0, -2, 0]);
  assert.deepEqual(levelGains([-40]), [12], 'a raise is capped');
  assert.deepEqual(levelGains([null, null]), [], 'nothing to level by');
});

test('several lines over separate sounds split at the longest silences; one line spans its sounds', () => {
  const range = { start: 0, end: 5.17 };
  // S06 of a real cut: "总监，你也一个人啊" over the first two sounds, "现在不是" over the last.
  const spans = [{ start: 0.92, end: 1.45 }, { start: 2.21, end: 2.95 }, { start: 4.3, end: 5.17 }];
  const two = lineTimes([{ text: '总监，你也一个人啊。' }, { text: '现在不是。' }], spans, range);
  assert.deepEqual(two.map((l) => [l.from, l.to].map((v) => Math.round(v * 100) / 100)), [[0.82, 3.25], [4.2, 5.17]]);
  const one = lineTimes([{ text: '别熬太晚。' }], [{ start: 4.35, end: 5.17 }], range);
  assert.deepEqual([one[0].from, one[0].to].map((v) => Math.round(v * 100) / 100), [4.25, 5.17]);
  const given = lineTimes([{ text: 'a', from: 1, to: 2 }, { text: 'b', from: 3, to: 9 }], spans, range);
  assert.deepEqual(given.map((l) => [l.from, l.to]), [[1, 2], [3, 5.17]], 'given times are kept, inside the trim');
  const quiet = lineTimes([{ text: '嗯' }], [], { start: 1, end: 3 });
  assert.deepEqual([quiet[0].from, quiet[0].to], [1, 3], 'no sound: the whole trim');
});

test('cues land on the cut timeline, at least 0.8 s, never overlapping', () => {
  const cues = placeCues(
    [
      { offset: 0, start: 1, end: 4, lines: [{ text: '你来了。', from: 2, to: 2.2 }] },
      { offset: 3, start: 0, end: 5, lines: [{ text: '嗯，', from: 0, to: 1 }, { text: '走吧。', from: 0.5, to: 2 }] },
    ],
    20,
  );
  assert.deepEqual(cues, [
    { text: '你来了', start: 0.7, end: 1.5 },
    { text: '嗯', start: 3, end: 3.5 },
    { text: '走吧', start: 3.5, end: 5 },
  ]);
});

test('subtitles sit low in a landscape frame and clear of the app captions in a portrait one', () => {
  const wide = subtitleLayout(1920, 1080);
  const tall = subtitleLayout(1080, 1920);
  assert.equal(wide.maxEm, 20);
  assert.equal(tall.maxEm, 16);
  assert.ok(wide.top > 1080 * 0.8);
  assert.ok(tall.top < 1920 * 0.8 && tall.top > 1920 * 0.6);
});

/** A black clip with a tone, `db` from ffmpeg's default sine (about -22 LUFS), `seconds` long; `tone` false for a silent one. */
function clip(name: string, db: number, seconds = 3, tone = true): string {
  const out = join(dir, `${name}.mp4`);
  const args = ['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=320x180:d=${seconds}:r=10`];
  if (tone) args.push('-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`, '-af', `volume=${db}dB`, '-c:a', 'aac');
  args.push('-pix_fmt', 'yuv420p', '-shortest', '-y', out);
  const r = spawnSync('ffmpeg', args);
  assert.equal(r.status, 0, r.stderr.toString());
  return out;
}

/** How many bright pixels the subtitle strip of a frame of the cut has. */
async function brightInStrip(path: string, at: number): Promise<number> {
  const png = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', path, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']).stdout;
  const { top, stripH } = subtitleLayout(320, 180);
  const raw = await sharp(png).extract({ left: 0, top, width: 320, height: stripH }).greyscale().raw().toBuffer();
  return raw.filter((v) => v > 200).length;
}

test('a cut levels the dialogue clips to one loudness and burns their lines in while they are said', { skip }, async () => {
  const soft = clip('soft', -6);
  const loud = clip('loud', 13);
  const out = join(dir, 'cut.mp4');
  const cut = await concatClips(
    [
      { path: soft, lines: [{ text: '你来了。', from: 0.5, to: 2 }] },
      { path: loud, start: 1, lines: [{ text: '嗯。' }] },
    ],
    out,
    undefined,
    { level: true, subtitles: true },
  );
  assert.equal(Math.round(cut.duration * 10) / 10, 5);
  assert.equal(cut.gains.length, 2);
  for (const [from, to] of [[0, 3], [3, 5]]) {
    const level = await loudness(out, from + 0.2, to - 0.2);
    assert.ok(level !== null && Math.abs(level - DIALOGUE_LUFS) < 1.5, `loudness ${level} at ${from}–${to} s`);
  }
  assert.deepEqual(cut.cues.map((c) => c.text), ['你来了', '嗯']);
  assert.ok((await brightInStrip(out, 1)) > 50, 'subtitle shown while the line is said');
  assert.equal(await brightInStrip(out, 2.6), 0, 'and gone after');
});

test('without lines a cut leaves the sound as it was and has no subtitles', { skip }, async () => {
  const out = join(dir, 'plain.mp4');
  const cut = await concatClips([{ path: clip('a', -10) }, { path: clip('b', 10) }], out, undefined, { level: true, subtitles: true });
  assert.deepEqual(cut.gains, []);
  assert.deepEqual(cut.cues, []);
  assert.equal(await brightInStrip(out, 1), 0);
});

test('assemble_video takes each clip\'s lines: the dialogue is levelled and burnt in, or only levelled with subtitles off', { skip }, async () => {
  const paths: Record<string, string> = { a1: clip('tool-a', -6), a2: clip('tool-b', 10, 3, false) };
  const media = (id: string): AssetInfo => ({ id, url: `/files/${id}`, kind: 'video', mime: 'video/mp4', width: 320, height: 180 });
  const shot = (id: string, asset: string, name: string): CanvasItem => ({ id, kind: 'video', x: 0, y: 0, w: 320, h: 180, name, createdAt: 1, asset: media(asset) });
  const project: Project = { id: 'board00002', name: 't', items: [shot('vid0000001', 'a1', 'S01'), shot('vid0000002', 'a2', 'S02')], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 0, updatedAt: 0 };
  const deps = {
    tasks: { list: () => [] as Task[] },
    assets: {
      get: (id: string) => (paths[id] ? { ...media(id), file: `${id}.mp4`, createdAt: 1 } : undefined),
      path: (a: { id: string }) => paths[a.id],
      save: async (_data: Buffer, opts: { size: { width: number; height: number }; name?: string }) => ({ ...media('cut'), ...opts.size, name: opts.name, file: 'cut.mp4', createdAt: Date.now() }),
    },
    projects: {
      get: async () => project,
      patchItems: async (_id: string, patch: { upsert?: CanvasItem[] }) => {
        project.items.push(...(patch.upsert ?? []));
        return project;
      },
    },
    changed: () => {},
  } as unknown as Parameters<typeof canvasTools>[0];
  const assemble = canvasTools(deps, {} as Parameters<typeof canvasTools>[1]).find((t) => t.name === 'assemble_video')!;
  const clips = [{ id: 'vid0000001', lines: [{ text: '你来了。' }] }, { id: 'vid0000002' }];

  const out = await assemble.run({ clips, name: '成片' }, { projectId: project.id });
  assert.match(out.text, new RegExp(`对白音量统一到 ${DIALOGUE_LUFS} LUFS`));
  assert.match(out.text, /字幕 1 条：.*「你来了」/);
  assert.equal(project.items.at(-1)!.name, '成片');
  // The final-cut item remembers its clip list (id, trim, lines) so it can be re-cut.
  const cutItem = project.items.at(-1)!;
  assert.deepEqual(cutItem.cutList, [
    { id: 'vid0000001', start: undefined, end: undefined, lines: [{ text: '你来了。' }] },
    { id: 'vid0000002', start: undefined, end: undefined, lines: undefined },
  ]);

  const quiet = await assemble.run({ clips, subtitles: false }, { projectId: project.id });
  assert.match(quiet.text, /对白音量统一/);
  assert.doesNotMatch(quiet.text, /字幕/);

  const bare = await assemble.run({ clips: [{ id: 'vid0000002' }] }, { projectId: project.id });
  assert.match(bare.text, /没有写台词（lines）/);
});

/** A solid-colour PNG, for a keyframe the first frame of a clip can match or miss. */
async function keyframeImage(name: string, color: string): Promise<string> {
  const out = join(dir, `${name}.png`);
  await sharp({ create: { width: 320, height: 180, channels: 3, background: color } }).png().toFile(out);
  return out;
}

interface Files {
  [id: string]: { path: string; kind: 'video' | 'image' };
}

/** A board and its asset files, for the gate tests that need real media behind the items. */
function cutBoard(items: CanvasItem[], files: Files): { deps: Parameters<typeof canvasTools>[0]; project: Project } {
  const project: Project = { id: 'board00003', name: 't', items, viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 0, updatedAt: 0 };
  const info = (id: string): AssetInfo => ({
    id,
    url: `/files/${id}`,
    kind: files[id].kind,
    mime: files[id].kind === 'video' ? 'video/mp4' : 'image/png',
    width: 320,
    height: 180,
    name: id,
    createdAt: 1,
  });
  const deps = {
    tasks: { list: () => [] as Task[] },
    assets: {
      get: (id: string) => (files[id] ? { ...info(id), file: files[id].path } : undefined),
      path: (a: AssetInfo) => files[a.id].path,
      save: async (_data: Buffer, opts: { size: { width: number; height: number }; name?: string }) => ({
        id: 'cut',
        url: '/files/cut',
        kind: 'video',
        mime: 'video/mp4',
        ...opts.size,
        name: opts.name,
        file: 'cut.mp4',
        createdAt: Date.now(),
      }),
    },
    projects: {
      get: async () => project,
      patchItems: async (_id: string, patch: { upsert?: CanvasItem[] }) => {
        project.items.push(...(patch.upsert ?? []));
        return project;
      },
    },
    changed: () => {},
  } as unknown as Parameters<typeof canvasTools>[0];
  return { deps, project };
}

const imageShot = (id: string, asset: string, name: string): CanvasItem => ({
  id,
  kind: 'image',
  x: 0,
  y: 0,
  w: 320,
  h: 180,
  name,
  createdAt: 1,
  asset: { id: asset, url: `/files/${asset}`, kind: 'image', mime: 'image/png', width: 320, height: 180 },
});

const videoShot = (id: string, asset: string, name: string, inputs?: string[]): CanvasItem => ({
  id,
  kind: 'video',
  x: 0,
  y: 0,
  w: 320,
  h: 180,
  name,
  createdAt: 1,
  inputs,
  asset: { id: asset, url: `/files/${asset}`, kind: 'video', mime: 'video/mp4', width: 320, height: 180 },
});

test('assemble_video refuses a clip that does not start on its keyframe, names it, and can be skipped', { skip }, async () => {
  const files: Files = { kf: { path: await keyframeImage('gate-white', '#ffffff'), kind: 'image' }, v1: { path: clip('gate-frame', -10), kind: 'video' } };
  const { deps } = cutBoard([imageShot('img0000002', 'kf', 'S01 关键帧'), videoShot('vid0000004', 'v1', 'S01', ['img0000002'])], files);
  const assemble = canvasTools(deps, {} as Parameters<typeof canvasTools>[1]).find((t) => t.name === 'assemble_video')!;

  await assert.rejects(
    () => assemble.run({ clips: [{ id: 'vid0000004', lines: [{ text: '嗯。' }] }] }, { projectId: 'board00003' }),
    (e: Error) => /S01/.test(e.message) && /第 0 秒/.test(e.message) && /skip_first_frame_check/.test(e.message),
  );
  const out = await assemble.run({ clips: [{ id: 'vid0000004', lines: [{ text: '嗯。' }], skip_first_frame_check: true }] }, { projectId: 'board00003' });
  assert.match(out.text, /成片/);
});

test('assemble_video refuses a trim that cuts obvious sound, and an audible clip with no lines', { skip }, async () => {
  const files: Files = { v2: { path: clip('gate-sound', -10), kind: 'video' } };
  const { deps } = cutBoard([videoShot('vid0000005', 'v2', 'S02')], files);
  const assemble = canvasTools(deps, {} as Parameters<typeof canvasTools>[1]).find((t) => t.name === 'assemble_video')!;

  await assert.rejects(
    () => assemble.run({ clips: [{ id: 'vid0000005' }] }, { projectId: 'board00003' }),
    (e: Error) => /S02/.test(e.message) && /没有写 lines/.test(e.message),
  );
  await assert.rejects(
    () => assemble.run({ clips: [{ id: 'vid0000005', end: 2.5, lines: [{ text: '嗯。' }] }] }, { projectId: 'board00003' }),
    (e: Error) => /S02/.test(e.message) && /会切掉 0\.50 秒/.test(e.message),
  );
  const out = await assemble.run({ clips: [{ id: 'vid0000005', lines: [{ text: '嗯。' }] }] }, { projectId: 'board00003' });
  assert.match(out.text, /成片/);
});

test('a final-cut clip list survives a save/load round trip, so the film can be re-cut after a reload', () => {
  const cutList = [
    { id: 'vid0000001', start: 0.5, end: 3, lines: [{ text: '你来了。', from: 0.5, to: 2 }] },
    { id: 'vid0000002', lines: [{ text: '嗯。' }] },
  ];
  const item: CanvasItem = { id: 'cut0000001', kind: 'video', x: 0, y: 0, w: 320, h: 180, name: '成片', cutList, createdAt: 1 };
  const project: Project = { id: 'p', name: 't', items: [item], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 0, updatedAt: 0 };
  const restored: Project = JSON.parse(JSON.stringify(project));
  assert.deepEqual(restored.items[0].cutList, cutList);
});

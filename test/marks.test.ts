import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import type { AssetInfo, CanvasItem, Project, Task } from '../shared/types.ts';
import { cropFrame, markBoxes } from '../server/agent/media.ts';
import { canvasTools, promptHint } from '../server/agent/tools.ts';

const dir = mkdtempSync(join(tmpdir(), 'infinode-marks-'));
const grey = async () => sharp({ create: { width: 400, height: 200, channels: 3, background: '#808080' } }).png().toBuffer();
const pixel = async (png: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

test('layout boxes tint their area in order, keep the size, and stay inside the picture', async () => {
  const { png, width, height } = await markBoxes(await grey(), [
    { x: 0.1, y: 0.1, w: 0.2, h: 0.5 },
    { x: 0.9, y: 0.5, w: 0.5, h: 0.9 },
  ]);
  assert.deepEqual([width, height], [400, 200]);
  const [r, g, b] = await pixel(png, 80, 60);
  assert.ok(r > g + 30 && r > b + 30, `the first box is red: ${[r, g, b]}`);
  const [r2, g2, b2] = await pixel(png, 380, 150);
  assert.ok(b2 > r2 + 30, `the second box is blue, cut at the edge: ${[r2, g2, b2]}`);
  assert.deepEqual(await pixel(png, 200, 20), [128, 128, 128], 'outside the boxes nothing changes');
});

test('a prompt that says what not to draw, or uses bold, gets a note; words in quotes do not', () => {
  assert.equal(promptHint([{ label: '', text: '他站在阳台的地砖上，挡墙在他身后。' }]), '');
  assert.equal(promptHint([{ label: '', text: '门口的牌子上写着「禁止吸烟」。' }]), '', 'writing in the picture');
  const hint = promptHint([
    { label: 'S29', text: '他站在阳台上。绝对不要站在栏杆外面。' },
    { label: 'S30', text: '**两人的衣服**照参考图。' },
  ]);
  assert.match(hint, /S29：「….*绝对不要站在栏杆外.*…」/);
  assert.match(hint, /S30：加粗符号/);
  assert.match(hint, /mark_layout/);
});

test('mark_layout puts a layout image beside the scene, linked to it, and says which colour is whom', async () => {
  const platePath = join(dir, 'plate.png');
  writeFileSync(platePath, await grey());
  const media = (id: string): AssetInfo => ({ id, url: `/files/${id}.png`, kind: 'image', mime: 'image/png', width: 400, height: 200 });
  const plate: CanvasItem = { id: 'plate00001', kind: 'image', x: 0, y: 0, w: 512, h: 256, name: '阳台', createdAt: 1, asset: media('aplate') };
  const project: Project = { id: 'board00001', name: 't', items: [plate], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 0, updatedAt: 0 };
  let saved: Buffer | undefined;
  const deps = {
    tasks: { list: () => [] as Task[] },
    assets: {
      get: (id: string) => (id === 'aplate' ? { ...media(id), file: 'plate.png', createdAt: 1 } : undefined),
      path: () => platePath,
      save: async (data: Buffer, opts: { size: { width: number; height: number }; name?: string }) => {
        saved = data;
        return { ...media('alayout'), ...opts.size, name: opts.name, file: 'layout.png', createdAt: Date.now() };
      },
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
  const mark = canvasTools(deps, {} as Parameters<typeof canvasTools>[1], 'mcp').find((t) => t.name === 'mark_layout')!;
  assert.equal(mark.vision, true, 'only for models that can see the scene');
  const out = await mark.run(
    {
      id: plate.id,
      boxes: [
        { who: '陆星辰', x: 0.3, y: 0.4, w: 0.1, h: 0.4 },
        { who: '赵大宇', x: 0.7, y: 0.1, w: 0.2, h: 0.9 },
      ],
    },
    { projectId: project.id },
  );
  const layout = project.items.find((i) => i.id === out.items![0])!;
  assert.deepEqual([layout.name, layout.inputs, layout.w, layout.h], ['阳台 站位', [plate.id], plate.w, plate.h]);
  assert.ok(layout.x >= plate.x + plate.w, 'to the right of the scene');
  assert.equal(out.summary, '红框 = 陆星辰，蓝框 = 赵大宇');
  assert.match(out.text, /reference_ids 先放底图 `plate00001`/);
  const [r, g, b] = await pixel(saved!, 140, 120);
  assert.ok(r > g + 30 && r > b + 30);
});

test('a medium or close shot that asks for the feet gets a note; reference images called by their shot size do not count', () => {
  const s29 = promptHint([{ label: 'S29', text: '生成一张新的电影画面（中景，平视）。他站在阳台地砖上，脚踩着地砖，画面下方能看到他的小腿和鞋。' }]);
  assert.match(s29, /S29：中景，却写了「脚踩」/);
  assert.match(s29, /crop_image/);
  assert.equal(promptHint([{ label: '', text: '近景。图1是他的脸部特写，图2是他的全身照，是同一个人。他靠在栏杆上，身后是门框。' }]), '');
  assert.equal(promptHint([{ label: '', text: '全景，他从头到脚都在画面里，脚踩着地砖。' }]), '', 'a full shot shows the feet');
});

/** A 400×200 picture in four coloured quarters: red, green / blue, white. */
const quarters = async () =>
  sharp({ create: { width: 400, height: 200, channels: 3, background: '#ffffff' } })
    .composite([
      { input: { create: { width: 200, height: 100, channels: 3, background: '#ff0000' } }, left: 0, top: 0 },
      { input: { create: { width: 200, height: 100, channels: 3, background: '#00ff00' } }, left: 200, top: 0 },
      { input: { create: { width: 200, height: 100, channels: 3, background: '#0000ff' } }, left: 0, top: 100 },
    ])
    .png()
    .toBuffer();

test('cropping keeps the picture\'s shape and size, enlarging the part cut out', async () => {
  const { png, width, height, box } = await cropFrame(await quarters(), { x: 0, y: 0, w: 0.5 });
  assert.deepEqual([width, height, box], [400, 200, { x: 0, y: 0, w: 0.5, h: 0.5 }]);
  assert.deepEqual(await pixel(png, 100, 50), [255, 0, 0], 'the top-left quarter fills the frame');
  assert.deepEqual(await pixel(png, 390, 190), [255, 0, 0]);
  const late = await cropFrame(await quarters(), { x: 0.9, y: 0.9, w: 0.5 });
  assert.deepEqual(late.box, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 'kept inside the picture');
  assert.deepEqual(await pixel(late.png, 200, 100), [255, 255, 255]);
  assert.equal((await cropFrame(await quarters(), { x: 0, y: 0, w: 0.05 })).box.w, 0.3, 'not closer than 0.3');
});

test('crop_image puts the framing beside the scene, linked to it, at the scene\'s size', async () => {
  const platePath = join(dir, 'quarters.png');
  writeFileSync(platePath, await quarters());
  const media = (id: string): AssetInfo => ({ id, url: `/files/${id}.png`, kind: 'image', mime: 'image/png', width: 400, height: 200 });
  const plate: CanvasItem = { id: 'plate00002', kind: 'image', x: 0, y: 0, w: 512, h: 256, name: '阳台', createdAt: 1, asset: media('aplate') };
  const project: Project = { id: 'board00003', name: 't', items: [plate], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 0, updatedAt: 0 };
  let saved: Buffer | undefined;
  const deps = {
    tasks: { list: () => [] as Task[] },
    assets: {
      get: (id: string) => (id === 'aplate' ? { ...media(id), file: 'quarters.png', createdAt: 1 } : undefined),
      path: () => platePath,
      save: async (data: Buffer, opts: { size: { width: number; height: number }; name?: string }) => {
        saved = data;
        return { ...media('aframe'), ...opts.size, name: opts.name, file: 'frame.png', createdAt: Date.now() };
      },
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
  const crop = canvasTools(deps, {} as Parameters<typeof canvasTools>[1], 'mcp').find((t) => t.name === 'crop_image')!;
  const out = await crop.run({ id: plate.id, x: 0.5, y: 0.5, w: 0.5 }, { projectId: project.id });
  const framed = project.items.find((i) => i.id === out.items![0])!;
  assert.deepEqual([framed.name, framed.inputs, framed.w, framed.h], ['阳台 取景', [plate.id], plate.w, plate.h]);
  assert.ok(framed.x >= plate.x + plate.w, 'to the right of the scene');
  assert.equal(out.summary, '放大 2 倍');
  assert.deepEqual(await pixel(saved!, 200, 100), [255, 255, 255], 'the bottom-right quarter');
});

// Turns a real board in data/ into the static demo fixture: demo/board.json, meta.json and webp assets.
// Run with `npm run export:demo` after generating something worth showing.
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { LICENSES } from '../shared/licenses.ts';

const SOURCE = process.env.DEMO_BOARD ?? 'data/projects/osrz244OtG.json';
const OUT = process.env.DEMO_OUT ?? 'demo';
const MAX_WIDTH = 1400;

const project = JSON.parse(await readFile(SOURCE, 'utf8'));

await rm(join(OUT, 'assets'), { recursive: true, force: true });
await mkdir(join(OUT, 'assets'), { recursive: true });

const assets = new Map();
for (const item of project.items) {
  const asset = item.asset;
  if (!asset) continue;
  const ext = asset.kind === 'video' ? asset.url.split('.').pop() : 'webp';
  const file = `${asset.id}.${ext}`;
  const from = join('data', 'assets', basename(asset.url));
  const to = join(OUT, 'assets', file);
  if (asset.kind === 'video') {
    // No transcoding without ffmpeg; the mp4 is small enough as it is.
    await writeFile(to, await readFile(from));
  } else {
    await sharp(from).resize({ width: MAX_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toFile(to);
  }
  assets.set(asset.id, { ...asset, url: `${OUT}/assets/${file}` });
}

/** Names come from what each item was actually made with, not from what it looks like. */
const OP_NAMES = {
  'image.erase': '消除',
  'image.inpaint': '局部重绘',
  'image.outpaint': '扩图',
  'image.removeBg': '抠图',
  'image.upscale': '超清',
  'video.generate': '视频',
};

function nameOf(item) {
  const request = item.request;
  if (!request) return undefined;
  if (OP_NAMES[request.op]) return OP_NAMES[request.op];
  if (request.op === 'image.generate') return request.images?.length ? '换主体/参考图编辑' : '文生图';
  return undefined;
}

// Boards rebuilt by scripts/rebuild-demo-commercial.ts bring their own, accurate note.
const note = project.items.some((item) => item.id === 'demo-note')
  ? undefined
  : {
      id: 'demo-note',
      kind: 'text',
      x: -760,
      y: -1320,
      w: 620,
      h: 460,
      name: '这张画布是怎么来的',
      text: [
        '这张画布上的每一个结果，都是在自己的 ComfyUI 上真实生成后导出的。',
        '',
        '最左边是一张文生图的参考图。从它出发：换主体、消除、局部重绘、扩图，各出一个结果；再从换主体那张继续抠图、超清、再换一次主体；另有一段由参考图生成的视频。',
        '',
        '每条线表示「这个结果是从哪张图来的」，所以任何一步都能单独重来：不满意的一面，改一张就行，不用重做全片。',
      ].join('\n'),
      createdAt: Date.now(),
    };

const items = project.items
  .filter((item) => item.asset)
  .map((item) => {
    const asset = assets.get(item.asset.id);
    const name = nameOf(item);
    return { ...item, asset, ...(name ? { name } : {}) };
  });

const board = {
  id: 'demo',
  name: '演示画布 · 一张参考图，长出整条创作链',
  items: [note, ...items].filter(Boolean),
  viewport: project.viewport,
  createdAt: project.createdAt ?? Date.now(),
  updatedAt: Date.now(),
};

const pool = items.filter((i) => i.asset.kind === 'image').map((i) => i.asset);
const video = items.find((i) => i.asset.kind === 'video')?.asset;

// "试一下" replays the one reference edit the fixture already contains, prompt and result included.
const edit = items.find((i) => i.request?.images?.length) ?? items[1];
const reference = items.find((i) => i.id === edit?.inputs?.[0]) ?? items[0];

/** Capability key of a saved request, for looking up what it was made with. */
function licenseKey(request) {
  if (!request) return undefined;
  if (request.op === 'custom') return `custom:${request.workflow}`;
  if (request.op === 'image.generate') return `image.generate:${request.model}`;
  if (request.op === 'video.generate') return `video.generate:${request.model}`;
  return request.op;
}

// Derived from the board's own requests, so the disclosure cannot drift from what was generated.
const licenses = [];
for (const item of items) {
  const l = LICENSES[licenseKey(item.request)];
  if (!l) continue;
  const text = `${l.model} · ${l.license}${l.use === 'yes' ? '' : `（${l.note}）`}`;
  if (!licenses.includes(text)) licenses.push(text);
}

const meta = {
  title: 'Kynflow 演示模式',
  summary: project.summary ?? '一张参考图 → 换主体、消除、重绘、扩图、视频；每个结果都连回它的来源。',
  notice: '演示模式：结果是本机 ComfyUI 预生成的真实产物，页面不连接 GPU。',
  demo: {
    prompt: edit?.request?.prompt ?? '',
    reference: reference?.id,
    image: edit?.asset?.url ?? '',
    video: video?.url ?? '',
    // The request that actually made the shown image, so the replay is labelled with its real model.
    ...(edit?.request ? { request: edit.request } : {}),
  },
  images: pool.map((a) => a.url),
  // Every model the fixture actually used, with the license the demo is shown under.
  licenses,
};

await writeFile(join(OUT, 'board.json'), `${JSON.stringify(board, null, 2)}\n`);
await writeFile(join(OUT, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

console.log(`demo fixture: ${board.items.length} items, ${assets.size} assets → ${OUT}/`);

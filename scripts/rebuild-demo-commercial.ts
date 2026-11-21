// Rebuilds the demo board on a commercially licensed chain: Z-Image Turbo / Qwen-Image 2512 for
// keyframes, Qwen-Image-Edit 2511 for reference edits, SeedVR2 for upscaling, Wan 2.2 for the shot.
// Everything here is Apache 2.0, so the exported demo has nothing to disclose as research-only.
//
//   npm run demo:rebuild                    # generates assets and data/projects/demoClean1.json
//   DEMO_BOARD=data/projects/demoClean1.json npm run export:demo
//   PUBLIC_BASE=/ npm run build:demo
//
// The script checks the models first and stops without writing anything when one is missing:
// it never substitutes a model the demo is not allowed to show.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { imageSize } from 'image-size';
import { nanoid } from 'nanoid';
import type { AssetInfo, CanvasItem, TaskRequest } from '../shared/types.ts';
import { ComfyClient, type HistoryEntry, historyError, historyFiles } from '../server/comfy/client.ts';
import { mimeFor } from '../server/assets/store.ts';
import { buildCustom, fixModelPaths, graphIssues } from '../server/workflows/custom.ts';
import { buildWorkflow } from '../server/workflows/index.ts';
import { missingSlots, resolveModels } from '../server/workflows/models.ts';
import { PresetStore } from '../server/workflows/presets.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

type ObjectInfo = Record<string, { input: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>;

const comfy = new ComfyClient(process.env.COMFY_URL ?? 'http://127.0.0.1:8188', `infinode-demo-${process.pid}`);
const seed = Number(process.env.DEMO_SEED ?? 42);
const assetsDir = join('data', 'assets');
const projectFile = join('data', 'projects', 'demoClean1.json');

/** One generated item: a preset run, or a built-in SeedVR2 upscale of the first input. */
interface Shot {
  id: string;
  name: string;
  /** Preset id, e.g. tpl_qwen-edit-2511. */
  preset?: string;
  prompt?: string;
  params?: Record<string, string | number | boolean>;
  aspect?: string;
  /** Board items whose assets become this workflow's image inputs. */
  from?: string[];
  /** Built-in image.upscale factor instead of a preset. */
  upscale?: number;
  at: { x: number; y: number; w: number };
}

const SHOTS: Shot[] = [
  {
    id: 'clean1',
    name: '文生图',
    preset: 'tpl_z-image-turbo',
    prompt: '一只坐在木桌上的橘猫，旁边是红苹果和陶瓷杯，清晨窗光，浅景深，写实摄影',
    aspect: '4:3',
    at: { x: 0, y: 0, w: 512 },
  },
  {
    id: 'clean2',
    name: '换主体',
    preset: 'tpl_qwen-edit-2511',
    prompt: '把图中的猫换成一只戴着红色针织围巾的柴犬，其他保持不变',
    from: ['clean1'],
    at: { x: 760, y: -720, w: 512 },
  },
  {
    id: 'clean3',
    name: '再换一次主体',
    preset: 'tpl_qwen-edit-2511',
    prompt: '把图中的柴犬换成一只戴红色贝雷帽的柯基，其他保持不变',
    from: ['clean2'],
    at: { x: 1520, y: -240, w: 512 },
  },
  {
    id: 'clean4',
    name: '超清',
    upscale: 2,
    from: ['clean2'],
    at: { x: 1520, y: -720, w: 512 },
  },
  {
    id: 'clean5',
    name: '视频',
    preset: 'tpl_wan2.2-i2v',
    prompt: '橘猫慢慢抬头看向窗外，尾巴轻轻摆动，安静的室内，清晨光线',
    from: ['clean1'],
    at: { x: 760, y: 1150, w: 640 },
  },
  {
    id: 'clean6',
    name: '文生图',
    preset: 'tpl_z-image-turbo',
    prompt: '一只戴着飞行员护目镜的柯基犬，坐在复古双翼飞机的驾驶舱里',
    aspect: '1:1',
    at: { x: -760, y: 0, w: 512 },
  },
  {
    id: 'clean7',
    name: '文生图 · Qwen-Image 2512',
    preset: 'tpl_qwen-image-2512',
    prompt: '一张极简风格的咖啡店海报，中央是一杯拿铁，顶部写着“秋日限定”',
    aspect: '3:4',
    at: { x: -760, y: -600, w: 387 },
  },
];

// ---------------------------------------------------------------- preflight

const presets = new PresetStore();
await presets.init();

let info: ObjectInfo;
try {
  info = await comfy.json<ObjectInfo>('/object_info');
} catch (err) {
  console.error(`无法连接 ComfyUI（${comfy.baseUrl}）：${(err as Error).message}`);
  console.error('启动本机 ComfyUI 后重跑；脚本没有生成任何素材。');
  process.exit(1);
}

const missing: string[] = [];
const autoFixed: string[] = [];
const missingFiles = new Set<string>();
const downloads = new Map<string, { directory: string; url: string }>();

for (const id of new Set(SHOTS.map((s) => s.preset).filter((p): p is string => Boolean(p)))) {
  const preset = presets.get(id);
  if (!preset) {
    missing.push(`模板 ${id} 不在 presets/ 里`);
    continue;
  }
  for (const m of preset.models) downloads.set(m.name, { directory: m.directory, url: m.url });
  const issues = graphIssues(preset.graph, info);
  for (const issue of issues) {
    const line = `${preset.name}：${issue.message}`;
    if (issue.type === 'auto') autoFixed.push(line);
    else missing.push(line);
    if (issue.type === 'file' && issue.value) missingFiles.add(issue.value);
  }
}

resolveModels(info);
for (const slot of missingSlots('image.upscale')) missing.push(`超清（SeedVR2）：缺少模型槽 ${slot}`);

if (autoFixed.length) {
  console.log('模型文件按精度/子目录自动匹配：');
  for (const line of autoFixed) console.log(`  ${line}`);
}

if (missing.length) {
  console.error('缺少可商用链路所需的模型或节点，脚本没有生成任何素材：');
  for (const line of missing) console.error(`  - ${line}`);
  const files = [...missingFiles].flatMap((name) => {
    const m = downloads.get(name);
    return m ? [[name, m] as const] : [];
  });
  if (files.length) {
    console.error('\n需要下载的模型文件：');
    for (const [name, m] of files) console.error(`  - ${name} → models/${m.directory}/\n    ${m.url}`);
  }
  console.error('\n把上面的文件放到 ComfyUI（脚本连的是 ' + comfy.baseUrl + '）后重跑 npm run demo:rebuild。');
  process.exit(1);
}

// ---------------------------------------------------------------- running

const EXT_BY_MIME: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm' };

async function upload(asset: AssetInfo) {
  const file = basename(asset.url);
  const data = await readFile(join(assetsDir, file));
  const comfyName = await comfy.upload(data, `demo_${file}`);
  return { comfyName, width: asset.width, height: asset.height };
}

async function waitFor(promptId: string, label: string): Promise<HistoryEntry> {
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const entry = await comfy.history(promptId);
    if (entry?.status?.completed || entry?.status?.status_str === 'error') {
      const err = historyError(entry);
      if (err) throw new Error(`${label}：${err}`);
      return entry;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    if (seconds % 30 === 0) console.log(`  ${label} 已运行 ${seconds}s`);
  }
}

async function saveOutput(file: { filename: string; subfolder: string; type: string }, expected: { width: number; height: number }, label: string) {
  const mime = mimeFor(file.filename);
  if (!mime) throw new Error(`${label}：输出 ${file.filename} 不是图片或视频`);
  const data = await comfy.view(file);
  const id = nanoid(12);
  const stored = id + EXT_BY_MIME[mime];
  await writeFile(join(assetsDir, stored), data);
  let { width, height } = expected;
  if (mime.startsWith('image/')) {
    const dim = imageSize(data);
    width = dim.width;
    height = dim.height;
  }
  const asset: AssetInfo = { id, url: `/files/${stored}`, kind: mime.startsWith('video/') ? 'video' : 'image', mime, width, height, name: file.filename };
  return asset;
}

const assets = new Map<string, AssetInfo>();
const items: CanvasItem[] = [];

for (const shot of SHOTS) {
  const inputs = (shot.from ?? []).map((id) => assets.get(id)!);
  const files = await Promise.all(inputs.map(upload));
  const label = `${shot.name}（${shot.preset ?? '超清'}）`;
  console.log(`${label}…`);

  let built;
  let request: TaskRequest;
  if (shot.upscale) {
    request = { op: 'image.upscale', image: inputs[0].id, scale: shot.upscale, seed };
    built = buildWorkflow(request, { images: files }, seed, () => undefined);
  } else {
    const preset = presets.get(shot.preset!)!;
    request = { op: 'custom', workflow: preset.id, prompt: shot.prompt, aspect: shot.aspect, params: shot.params, images: inputs.map((a) => a.id) };
    built = buildCustom(preset, request, { images: files, videos: [] }, seed);
    fixModelPaths(built.graph, info);
  }

  const promptId = crypto.randomUUID();
  const started = Date.now();
  await comfy.queuePrompt(built.graph, promptId);
  const entry = await waitFor(promptId, label);
  const results = historyFiles(entry, built.outputNodes).filter((f) => mimeFor(f.filename));
  if (!results.length) throw new Error(`${label}：ComfyUI 没有返回可显示的图片或视频`);
  const asset = await saveOutput(results[0], built.expected, label);
  console.log(`  → ${asset.url} ${asset.width}x${asset.height} (${Math.round((Date.now() - started) / 1000)}s)`);

  assets.set(shot.id, asset);
  const width = shot.at.w;
  const height = Math.round((width * asset.height) / asset.width);
  items.push({
    id: shot.id,
    kind: asset.kind,
    x: shot.at.x,
    y: shot.at.y,
    w: width,
    h: height,
    asset,
    ...(shot.from ? { inputs: shot.from } : {}),
    request,
    name: shot.name,
    createdAt: Date.now(),
  });
}

// ---------------------------------------------------------------- board

const note: CanvasItem = {
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
    '关键帧与海报用 Z-Image Turbo 和 Qwen-Image 2512，换主体用 Qwen-Image-Edit 2511，超清用 SeedVR2，镜头用 Wan 2.2——全部 Apache 2.0，可商用。',
    '',
    '每条线表示「这个结果是从哪张图来的」，所以任何一步都能单独重来：不满意的一面，改一张就行，不用重做全片。',
  ].join('\n'),
  createdAt: Date.now(),
};

const project = {
  id: 'demoClean1',
  name: '演示画布 · 可商用链路',
  // Read by export:demo for meta.json's one-liner; kept next to the board it describes.
  summary: '一张参考图 → 换主体、再换主体、超清、视频；每个结果都连回它的来源。',
  items: [note, ...items],
  viewport: { zoom: 0.33743299758264106, x: -60.30405609729553, y: 374.74643414585694 },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

await writeFile(projectFile, `${JSON.stringify(project, null, 2)}\n`);

console.log(`\n已写入 ${projectFile}（${items.length} 个结果，全部 Apache 2.0）。下一步：`);
console.log(`  DEMO_BOARD=${projectFile} npm run export:demo`);
console.log('  PUBLIC_BASE=/ npm run build:demo');

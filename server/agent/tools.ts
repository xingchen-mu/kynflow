import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { msg } from '../../shared/i18n.ts';
import { licenseLabel } from '../../shared/licenses.ts';
import { list, t } from '../i18n.ts';
import {
  type AgentPrompt,
  type AgentTaskGraph,
  type VisualCritique,
  type AgentTodo,
  type AssetInfo,
  type CanvasItem,
  type CutListEntry,
  ENTRY_CHARS,
  type ImageModel,
  MEMORY_LIMIT,
  type Project,
  type ReviewReason,
  type Task,
  type TaskRequest,
  type VideoModel,
  type WorkflowCapability,
  type WorkflowInput,
  type WorkflowLike,
} from '../../shared/types.ts';
import { GAP, boundsOf, displaySize, placeRow } from '../../shared/geometry.ts';
import { publicAsset } from '../assets/store.ts';
import {
  type BatchJob,
  type CanvasDeps,
  LONG_SIDE,
  type ResultWriter,
  describeItem,
  findItems,
  inputMedia,
  launch,
  launchBatch,
  patchBoard,
  placeGroups,
  readBoard,
  stateOf,
} from './board.ts';
import { customEstimate, imageEstimate, roughly, videoEstimate } from './estimate.ts';
import { GUIDES } from './guides.ts';
import type { EntityOp, MemoryHit, MemoryOp, MemoryQuery } from './memory.ts';
import { redoneVersion } from '../../shared/frames.ts';
import { type Arrangement, type Side, arrange, besideOf, clearOf } from './layout.ts';
import { DIALOGUE_LUFS, KEYFRAME_TOLERANCE, MARK_COLORS, type Cut, type Tile, concatClips, contactSheet, cropFrame, frameDistance, frameSignature, lastFrame, markBoxes, probe, soundSpans, videoFrame } from './media.ts';
import { editIssues, stabilityIssues } from './guards.ts';
import { matchesCapability } from '../workflows/capability.ts';
import { REASON_FIX, REASON_LABEL, REVIEW_REASONS, RETRY_LIMIT, retriesLeft } from './review.ts';
import type { TaskGraphAction } from './task-graph.ts';
import type { CritiqueRequest } from './runtime.ts';
import type { WorkflowRank } from './router.ts';

/** Per call: which board, and where the user was looking when they asked. */
export interface ToolContext {
  projectId: string;
  /** Internal harness operations are deliberately absent from external MCP calls. */
  harness?: {
    sessionId: string;
    graph(): AgentTaskGraph;
    updateGraph(action: TaskGraphAction): Promise<AgentTaskGraph>;
    activateSkill(id: string): Promise<void>;
    critique(request: CritiqueRequest, signal?: AbortSignal): Promise<VisualCritique>;
  };
  workflowRanks?: (pool: WorkflowLike[]) => Promise<WorkflowRank[]>;
  /** Board point at the center of the user's view; new unlinked items go there. */
  view?: { x: number; y: number };
  signal?: AbortSignal;
  /** Fires when the user sends another message during the run; long waits end early so it is read. */
  interrupt?: AbortSignal;
  /** Short progress line for the panel while the call runs. */
  progress?: (text: string) => void;
  /** Wake the agent with a summary once all these tasks have finished. */
  notify?: (what: string, items: CanvasItem[]) => void;
  /** The agent already knows how these items ended (it waited or cancelled): no notice about them. */
  seen?: (ids: string[]) => void;
  /** Replaces the to-do list the panel shows. */
  todos?: (list: AgentTodo[]) => void;
  /** Changes the board's or the user's memory. */
  remember?: (ops: MemoryOp[]) => Promise<{ done: string[]; refused: string[] }>;
  /** Adds, updates or archives a board entity (a character, place, prop or look). */
  rememberEntity?: (ops: EntityOp[]) => Promise<{ done: string[]; refused: string[] }>;
  /** Finds memory by words, entity or scope. */
  searchMemory?: (query: MemoryQuery) => Promise<MemoryHit[]>;
  /** One entry or entity in full, with provenance; undefined when there is no such id. */
  readMemory?: (id: string) => Promise<string | undefined>;
}

export interface ToolOutput {
  /** What the model reads. */
  text: string;
  images?: { data: string; mimeType: string }[];
  /** One line for the panel. */
  summary: string;
  /** Board items to show with the call. */
  items?: string[];
  /**
   * Hold the work until the user agrees in the panel; then `approve(payload)` runs it. `frames`: first
   * frames (or other items) the card shows; `since`: when it was made, so frames redone later replace them;
   * `confirm` / `reject`: the buttons' labels, when not 开始 / 不要; `body`: Markdown on the card (a plan).
   */
  approval?: { title: string; detail: string; payload: Json; frames?: string[]; since?: number; confirm?: string; reject?: string; body?: string; prompts?: AgentPrompt[] };
  /** Options for the user to click in the panel; the answer comes back as their next message. */
  question?: { text: string; options: { label: string; description?: string }[]; multiple?: boolean };
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A canvas operation, independent of the agent runtime (plain JSON Schema parameters). */
export interface CanvasTool<A = Record<string, unknown>> {
  name: string;
  /** Short name for the panel (Chinese source text, shown through t). */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Only offered to models that can see images. */
  vision?: boolean;
  /** Changes nothing (outside agents may run these without asking). */
  readOnly?: boolean;
  /** Cancels or removes things. */
  destructive?: boolean;
  /** What a call is doing, from its arguments. */
  describe(args: A): string;
  /** The prompts a call would generate from, shown to the user to read and edit first (approval mode `prompts`). */
  prompts?(args: A): AgentPrompt[];
  run(args: A, ctx: ToolContext): Promise<ToolOutput>;
  /** Does the work `run` asked approval for. */
  approve?(payload: Json, ctx: ToolContext): Promise<ToolOutput>;
}

const tool = <A>(def: CanvasTool<A>) => def as unknown as CanvasTool;

const ids = (description: string, max?: number) => ({
  type: 'array',
  items: { type: 'string' },
  description,
  ...(max ? { maxItems: max } : {}),
});

const clip = (s: string, max = 40) => (s.length > max ? `${s.slice(0, max)}…` : s);

const VIDEO_DURATIONS = [3, 5, 8, 10];
const snapDuration = (s: number | undefined) => VIDEO_DURATIONS.reduce((best, d) => (Math.abs(d - (Number(s) || 5)) < Math.abs(best - (Number(s) || 5)) ? d : best));
const MAX_BATCH = 40;
const MAX_LISTED = 300;
const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** Videos review_items looks at in one call (three frames each). */
const MAX_REVIEW_CLIPS = 8;
/** Moved items whose old positions a result lists, so the model can put them back. */
const MAX_RESTORE = 100;
const SIDES: Side[] = ['right', 'left', 'below', 'above'];
const ARRANGEMENTS: Arrangement[] = ['row', 'column', 'grid', 'groups'];
const ARRANGED: Record<Arrangement, string> = { row: '一行', column: '一列', grid: '网格', groups: '按类型分列' };

/** Where an item sits on the board and how large it is shown there. */
const placed = (i: CanvasItem) => ` · 在画布 (${i.x},${i.y})，显示 ${i.w}×${i.h}`;

/** The board cannot undo what the assistant moved: the result lists where things were. */
const formerly = (items: CanvasItem[]) =>
  items.length > MAX_RESTORE
    ? `（共 ${items.length} 个，太多了，没有记下原位置）`
    : `原位置（用户要放回去时，用 move_items 的 positions 照这些坐标放回）：${items.map((i) => `\`${i.id}\` (${i.x},${i.y})`).join('，')}`;

/** Saying what not to draw: image models draw what is named, so a "不要…" sentence tends to draw it. */
const NEGATION = /不要|不能|不可|别让|切勿|禁止|绝对|避免|千万/;

/** A shot size that cuts people off above the knees (reference images described as "脸部特写" left out). */
const CLOSE_SHOT = /中近景|中景|近景|特写/;
/** Asking to see the feet or the whole body. */
const WHOLE_BODY = /脚踩|脚下|双脚|脚尖|小腿|从头到脚|全身(?!照|像|图)/;
/** Reference images called by their shot size: not the shot being asked for. */
const REFERENCE_SHOTS = /(脸部|头肩|正脸|面部)特写|全身(照|像|图)/g;

/**
 * A note for the model when an image prompt says what not to draw or uses Markdown bold, or asks a medium
 * or close shot to show the feet (the model then pulls back to a full figure, small in the frame). Text in
 * quotes (writing that is to appear in the picture) is left alone.
 */
export function promptHint(prompts: { label: string; text: string }[]): string {
  const said = (p: { label: string }, what: string) => `${p.label ? `${p.label}：` : ''}${what}`;
  const negated: string[] = [];
  const shrunk: string[] = [];
  for (const p of prompts) {
    const plain = p.text.replace(/["“][^"”]*["”]|「[^」]*」/g, '');
    const neg = NEGATION.exec(plain);
    const bold = plain.includes('**');
    if (neg || bold) {
      const at = neg ? `「…${plain.slice(Math.max(0, neg.index - 6), neg.index + 12).replace(/\s+/g, ' ')}…」` : '';
      negated.push(said(p, [at, bold ? '加粗符号 **' : ''].filter(Boolean).join('、')));
    }
    const shot = plain.replace(REFERENCE_SHOTS, '');
    const close = CLOSE_SHOT.exec(shot);
    const whole = WHOLE_BODY.exec(shot);
    if (close && whole) shrunk.push(said(p, `${close[0]}，却写了「${whole[0]}」`));
  }
  let hint = '';
  if (negated.length) {
    hint +=
      `\n提醒：这些提示词里有否定的说法或加粗符号——${negated.slice(0, 6).join('；')}。` +
      '画图模型分不清「不要」，写进去的画面反而容易画出来，加粗也只是噪音。以后写成正面描述：人在哪一层、前面和后面各是什么；站位反复画错就用 mark_layout 标出来。';
  }
  if (shrunk.length) {
    hint +=
      `\n提醒：这些提示词的景别是中景或近景，却要求画出脚或全身——${shrunk.slice(0, 6).join('；')}。` +
      '模型会把人缩成全身像，占不满画面。中景、近景的位置关系用腰和胸以上的东西写（靠着什么、身后和身前是什么）；参考的场景图是大全景时，先用 crop_image 裁到这个镜头的取景。';
  }
  return hint;
}

const chunk = <T,>(xs: T[], size: number): T[][] => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

/** Generation settings of an item, without the prompt and asset ids. */
function settingsOf(req: TaskRequest | undefined): string {
  if (!req) return '';
  const { prompt: _p, images: _i, videos: _v, ...rest } = req as Record<string, unknown>;
  return ` · 参数：${JSON.stringify(rest)}`;
}

function inputsLine(wf: WorkflowLike): string {
  const describe = (i: WorkflowInput) => {
    const opt = i.optional ? '（可选）' : '';
    switch (i.type) {
      case 'prompt':
        return `提示词${i.default ? '（有默认值）' : ''}`;
      case 'negative':
        return '反向提示词';
      case 'image':
        return `图片「${i.label}」${opt}`;
      case 'video':
        return `视频「${i.label}」${opt}`;
      case 'mask':
        return '蒙版';
      case 'width':
      case 'height':
      case 'aspect':
        return '画面尺寸（用 aspect 参数）';
      case 'seed':
        return '';
      default: {
        const extra = [i.options?.length ? `可选值 ${i.options.join(' / ')}` : '', i.default !== undefined ? `默认 ${String(i.default)}` : '']
          .filter(Boolean)
          .join('，');
        return `params.${i.id}「${i.label}」(${i.type}${extra ? `，${extra}` : ''})`;
      }
    }
  };
  return [...new Set(wf.inputs.map(describe).filter(Boolean))].join('；') || '无';
}

const CAPABILITY_LABEL: Record<WorkflowCapability, string> = {
  text_to_image: '文生图',
  image_edit: '图生图/编辑',
  inpaint: '局部重绘',
  upscale: '放大',
  remove_background: '抠图',
  text_to_video: '文生视频',
  image_to_video: '图生视频',
  video_edit: '视频编辑',
  text_to_audio: '文生音频',
  text_to_3d: '文生 3D',
  text_to_document: '文生文本',
  other: '其它',
};

/** What a workflow can do and what it needs, in one line. */
function capabilityLine(wf: WorkflowLike, history: Task[]): string {
  const info = wf.capability;
  if (!info) return '能力未标注';
  const c = info.constraints;
  const minImages = c.min_images ?? wf.inputs.filter((i) => i.type === 'image' && !i.optional).length;
  const minVideos = c.min_videos ?? wf.inputs.filter((i) => i.type === 'video' && !i.optional).length;
  const bits = [CAPABILITY_LABEL[info.capability]];
  if (c.max_images) bits.push(`图片 ${minImages}–${c.max_images} 张`);
  if (c.max_videos) bits.push(`视频 ${minVideos}–${c.max_videos} 个`);
  if (c.requires_mask) bits.push('需蒙版');
  if (c.controls_aspect) bits.push('可改比例');
  if (c.requires_prompt) bits.push('需提示词');
  if (info.cost) bits.push({ low: '低成本', medium: '中成本', high: '高成本' }[info.cost]);
  const measured = customEstimate(history, wf.id);
  if (measured) bits.push(`实测 GPU ${roughly(measured.seconds)}（${measured.samples} 次）`);
  else if (info.expected_seconds) bits.push(`预估 GPU ${roughly(info.expected_seconds)}`);
  else bits.push('耗时未知');
  // Only worth saying when metadata answered but some node was missing; a fully offline
  // server marks every workflow 'degraded', so repeating it per line would be noise.
  if (c.unverified_nodes?.length) bits.push(`节点信息缺失：${c.unverified_nodes.join('/')}`);
  return bits.join(' · ');
}

/**
 * `panel`: the in-app assistant, which is woken when batches finish and asks for approval in the panel.
 * `mcp`: an outside agent (Claude Code, Codex…), which waits with wait_for_items and asks its user itself.
 */
export type ToolHost = 'panel' | 'mcp';

/**
 * Re-runs the same edit (concatClips) from a stored cut list, without the keyframe/edit
 * gate checks. Used by the 'recompose' button: redo a shot, then recompose to pick it up.
 */
export async function runCut(
  deps: CanvasDeps,
  projectId: string,
  cutList: CutListEntry[],
  options: { subtitles?: boolean; level?: boolean },
  signal?: AbortSignal,
  progress?: (text: string) => void,
): Promise<{ asset: AssetInfo; cut: Cut; items: CanvasItem[] }> {
  const p = await readBoard(deps, projectId);
  const items = findItems(p, cutList.map((c) => c.id));
  const media = inputMedia(deps, items, 'video');
  const clips = media.map((m, i) => {
    const stored = deps.assets.get(m.id);
    if (!stored) throw new Error(t('节点 {id} 的视频文件不见了', { id: items[i].id }));
    const c = cutList[i];
    const lines = (c.lines ?? []).flatMap((l) => (l?.text?.trim() ? [{ text: l.text.trim().slice(0, 200), from: l.from, to: l.to }] : []));
    return { path: deps.assets.path(stored), start: c.start, end: c.end, lines };
  });
  progress?.(t('剪辑 {n} 段…', { n: clips.length }));
  const dir = await mkdtemp(join(tmpdir(), 'kynflow-cut-'));
  try {
    const out = join(dir, 'cut.mp4');
    const cut = await concatClips(clips, out, signal, { level: options.level !== false, subtitles: options.subtitles !== false });
    const info = await probe(out);
    const asset = await deps.assets.save(await readFile(out), { filename: 'cut.mp4', mime: 'video/mp4', size: { width: info.width, height: info.height }, name: '成片' });
    return { asset: publicAsset(asset), cut, items };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function canvasTools(deps: CanvasDeps, writer: ResultWriter, host: ToolHost = 'panel'): CanvasTool[] {
  const afterBatch = host === 'panel' ? '这一批全部结束时你会自动收到一条通知，不用 wait_for_items。' : '用 wait_for_items 等结果（单次等待有上限，超时就再调用一次）。';

  const commercial = () => Boolean(deps.commercialOnly?.());
  /** Qwen-Image 2.1 unless asked otherwise, or Z-Image when only commercially licensed models may run. */
  const imageModel = (asked?: ImageModel): ImageModel => (asked === 'zimage' || asked === 'qwen' ? asked : commercial() ? 'zimage' : 'qwen');
  const noReferences = () =>
    commercial()
      ? t('zimage 不支持参考图；用户开启了「只用可商用的模型」，Qwen-Image 2.1 也不能用。改图请用 list_workflows 里可商用的模板（如 Qwen-Image-Edit 2511），通过 run_workflow 运行')
      : t('zimage 不支持参考图，要用参考图请用 qwen');

  /** Stops before submitting a shot that the guide says will break: fine hand work or a big move under a complex camera. */
  const assertStable = (jobs: { prompt: string; name?: string | null }[]) => {
    const blocked = jobs.flatMap((j, i) => {
      const issues = stabilityIssues(j.prompt);
      return issues.length ? [{ name: j.name?.trim() || `第 ${i + 1} 段`, issues }] : [];
    });
    if (!blocked.length) return;
    const lines = blocked.flatMap((b) =>
      b.issues.map((issue) =>
        issue.risk === 'hands'
          ? t('{name}：手部「{hand}」和复杂运镜（{camera}）在同一个镜头里', { name: b.name, hand: issue.detail, camera: issue.camera })
          : t('{name}：大幅动作「{motion}」和复杂运镜（{camera}）在同一个镜头里', { name: b.name, motion: issue.detail, camera: issue.camera }),
      ),
    );
    throw new Error(
      t('视频提交前的稳定性预检没通过：\n{lines}\n改法：拆成两个镜头（一个只拍手部或大动作，运镜固定），或者把这个镜头改成固定机位、只保留一种平稳的运镜。这两样挤在同一时刻最容易画崩：多出手指、肢体粘连、人和东西粘在一起。', {
        lines: lines.join('\n'),
      }),
    );
  };

  const launchVideos = async (payload: Json, ctx: ToolContext): Promise<ToolOutput> => {
    const { quality, jobs, since } = payload as { quality: '480p' | '720p'; jobs: { prompt: string; frames: string[]; duration: number; name: string | null }[]; since?: number };
    assertStable(jobs);
    const p = await readBoard(deps, ctx.projectId);
    const redone: string[] = [];
    const batch: BatchJob[] = jobs.map((j) => {
      const frames = findItems(p, j.frames).map((f) => {
        const newer = since ? redoneVersion(p.items, f, since, (i) => stateOf(deps, i).done) : undefined;
        if (newer) redone.push(`${f.name}：\`${f.id}\` → \`${newer.id}\``);
        return newer ?? f;
      });
      const media = inputMedia(deps, frames, 'image');
      const first = frames[0];
      return {
        request: { op: 'video.generate', model: 'minimax', prompt: j.prompt, aspect: 'auto', quality, duration: j.duration, images: media.map((m) => m.id) },
        inputs: frames,
        name: j.name ?? undefined,
        // Same height as its frame, so the storyboard keeps one row per shot.
        size: { w: Math.round(first.h * (media[0].width / media[0].height)), h: first.h },
      };
    });
    const { items, failed } = await launchBatch(deps, writer, ctx.projectId, batch, { layout: 'beside', view: ctx.view });
    if (!items.length) throw new Error(failed[0]?.error ?? t('提交失败'));
    ctx.notify?.(host === 'panel' ? t('用户确认后提交的 {n} 段视频', { n: items.length }) : t('{n} 段视频', { n: items.length }), items);
    return {
      text:
        `已提交 ${items.length} 段视频：${items.map((i) => `${i.name ? `${i.name} → ` : ''}\`${i.id}\``).join('，')}` +
        (redone.length ? `\n确认卡之后重做过的首帧，用了重做后的版本：${redone.join('；')}` : '') +
        (ctx.notify ? '' : `\n${afterBatch}`),
      summary: failed.length
        ? t('{n} 段已提交，{failed} 段失败：{error}', { n: items.length, failed: failed.length, error: failed[0].error })
        : redone.length
          ? t('{n} 段已提交，其中 {redone} 段用了重做后的首帧', { n: items.length, redone: redone.length })
          : t('{n} 段已提交', { n: items.length }),
      items: items.map((i) => i.id),
    };
  };

  /**
   * The board cannot undo what the assistant does, so a snapshot comes first; the user restores it from
   * 项目快照. Only the latest few of these are kept.
   */
  const snapshotFirst = async (projectId: string, name: string): Promise<string> => {
    const snap = await deps.projects.createSnapshot(projectId, name, { auto: true });
    return snap ? `动手前存了快照「${snap.name}」，用户可以在顶栏菜单的「项目快照」里恢复。` : '';
  };

  /** Takes finished items off the board; their files stay in the asset library. */
  const deleteItems = async (payload: Json, ctx: ToolContext): Promise<ToolOutput> => {
    const { ids: doomed } = payload as { ids: string[] };
    const p = await readBoard(deps, ctx.projectId);
    const present = doomed.filter((id) => p.items.some((i) => i.id === id));
    const saved = present.length ? await snapshotFirst(ctx.projectId, t('助手删除 {n} 个节点之前', { n: present.length })) : '';
    if (present.length) await patchBoard(deps, ctx.projectId, { remove: present });
    const gone = doomed.length - present.length;
    return {
      text:
        `已从画布删掉 ${present.length} 个节点：${present.map((id) => `\`${id}\``).join(' ')}` +
        (gone ? `（另有 ${gone} 个在确认前已经不在画布上了）` : '') +
        `。${saved}`,
      summary: t('删掉了 {n} 个', { n: present.length }),
    };
  };

  /**
   * The failed item a retry points at. Each result's retries are counted through `retryOf`, so a chain
   * gets RETRY_LIMIT retries in all; past that the model has to ask the user instead of trying again.
   */
  const retryTarget = (project: Project, id: string): CanvasItem => {
    const [item] = findItems(project, [id]);
    if (!retriesLeft(project, item)) {
      throw new Error(
        t('「{name}」已经重做 {limit} 次，重试预算用完了：不要再用相近参数重做，用 ask_user 把原因和选项交给用户（换方案、就用这版、用户自己改）', {
          name: item.name ?? item.id,
          limit: RETRY_LIMIT,
        }),
      );
    }
    return item;
  };

  /** What one more run like this costs in GPU time, for the retry budget line. */
  const retryCost = (item: CanvasItem): string => {
    const req = item.request;
    if (req?.op === 'image.generate') return `重做一次${roughly(imageEstimate(deps.tasks.list(), req))}`;
    if (req?.op === 'video.generate') return `重做一次${roughly(videoEstimate(deps.tasks.list(), req.quality, [req.duration]).seconds)}`;
    return '';
  };

  return [
    tool<{ ids?: string[] }>({
      name: 'read_board',
      readOnly: true,
      label: msg('读取画布'),
      description:
        '列出画布上的节点：id、图片还是视频、名称、尺寸或生成状态、由哪些节点生成、提示词，以及在画布上的位置（左上角坐标，x 向右、y 向下）和显示大小。传 ids 时只看这些节点，给出完整提示词和生成参数。',
      parameters: { type: 'object', properties: { ids: ids('只看这些节点（可选）') } },
      describe: (a) => (a.ids?.length ? t('{n} 个节点', { n: a.ids.length }) : t('全部节点')),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        if (args.ids?.length) {
          const items = findItems(p, args.ids);
          return {
            text: items.map((i) => describeItem(deps, i, 4000) + placed(i) + settingsOf(i.request)).join('\n'),
            summary: t('{n} 个节点', { n: items.length }),
            items: items.map((i) => i.id),
          };
        }
        const shown = p.items.slice(-MAX_LISTED);
        const lines = shown.map((i) => `- ${describeItem(deps, i)}${placed(i)}`);
        const more = p.items.length > shown.length ? `\n（只列出了最新的 ${shown.length} 个）` : '';
        return {
          text: p.items.length ? `画布「${p.name}」共 ${p.items.length} 个节点：\n${lines.join('\n')}${more}` : `画布「${p.name}」是空的`,
          summary: t('{n} 个节点', { n: p.items.length }),
        };
      },
    }),

    tool<{ name: string; section?: string }>({
      name: 'read_guide',
      readOnly: true,
      label: msg('读手册'),
      description:
        '读做某类作品的手册：步骤、规则、自查清单和例子。开始做之前先读全文（不传 section）；之后哪一步的规则记不清了，就只重读那一节，不要凭印象做。现有的手册：' +
        GUIDES.map((g) => `${g.id}（${g.when}；分节：${g.sections.map((s) => s.id).join('、')}）`).join('；'),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: GUIDES.map((g) => g.id) },
          section: { type: 'string', enum: [...new Set(GUIDES.flatMap((g) => g.sections.map((s) => s.id)))], description: '只读这一节；不传就读全文' },
        },
        required: ['name'],
      },
      describe: (a) => {
        const g = GUIDES.find((x) => x.id === a.name);
        const s = g?.sections.find((x) => x.id === a.section);
        return g ? (s ? t('{guide} · {section}', { guide: t(g.title), section: t(s.title) }) : t(g.title)) : (a.name ?? '');
      },
      async run(args) {
        const g = GUIDES.find((x) => x.id === args.name);
        if (!g) throw new Error(`没有叫 ${args.name} 的手册，现有：${GUIDES.map((x) => x.id).join('、')}`);
        const sections = args.section ? g.sections.filter((s) => s.id === args.section) : g.sections;
        if (!sections.length) throw new Error(`${g.id} 手册里没有 ${args.section} 这一节，现有：${g.sections.map((s) => s.id).join('、')}`);
        return {
          text: sections.map((s) => s.text).join('\n\n'),
          summary: sections.length === 1 ? t('{guide} · {section}', { guide: t(g.title), section: t(sections[0].title) }) : t(g.title),
        };
      },
    }),

    tool<{ ids: string[] }>({
      name: 'view_images',
      readOnly: true,
      label: msg('查看图片'),
      vision: true,
      description: '查看画布上的图片节点（一次最多 4 张），用来检查生成质量或看懂参考图。视频看不了，可以看它的首帧或参考图。',
      parameters: { type: 'object', properties: { ids: { ...ids('图片节点 id', 4), minItems: 1 } }, required: ['ids'] },
      describe: (a) => t('{n} 张', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, args.ids.slice(0, 4));
        const images: ToolOutput['images'] = [];
        const lines: string[] = [];
        for (const item of items) {
          const state = stateOf(deps, item);
          if (!state.done) {
            lines.push(`\`${item.id}\`：${state.text}，还没有图可看`);
            continue;
          }
          const stored = deps.assets.get(state.media.id);
          if (state.media.kind !== 'image' || !stored || !VIEWABLE.has(stored.mime)) {
            const what = state.media.kind === 'video' ? '是视频' : state.media.kind === 'audio' ? '是音频' : state.media.kind === 'model3d' ? '是 3D 模型' : state.media.kind === 'document' ? '是文档' : '文件格式看不了';
            lines.push(`\`${item.id}\`：${what}，看不了`);
            continue;
          }
          images.push({ data: (await deps.assets.read(stored)).toString('base64'), mimeType: stored.mime });
          lines.push(`第 ${images.length} 张：${describeItem(deps, item, 200)}`);
        }
        return { text: lines.join('\n'), images, summary: t('{n} 张图片', { n: images.length }), items: items.map((i) => i.id) };
      },
    }),

    tool<{ id: string; count?: number; start?: number; end?: number }>({
      name: 'view_video_frames',
      readOnly: true,
      vision: true,
      label: msg('看视频画面'),
      description:
        '把视频节点按时间抽帧，拼成一张带时间标注的图来看画面（一次 2–12 帧，默认 6 帧）。拆解参考视频时先用它看整条，再对关键段落传 start / end 细看。视频不能直接播放；要把某一帧单独留在画布上，用 capture_frame。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '视频节点 id' },
          count: { type: 'number', minimum: 2, maximum: 12, description: '抽几帧，默认 6' },
          start: { type: 'number', minimum: 0, description: '只看这一段，从第几秒开始；默认从 0' },
          end: { type: 'number', minimum: 0, description: '看到第几秒；默认到结尾' },
        },
        required: ['id'],
      },
      describe: (a) => t('{n} 帧', { n: a.count ?? 6 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const [video] = findItems(p, [args.id]);
        const [media] = inputMedia(deps, [video], 'video');
        const stored = deps.assets.get(media.id);
        if (!stored) throw new Error(t('节点 {id} 的视频文件不见了', { id: video.id }));
        const path = deps.assets.path(stored);
        const info = await probe(path);
        const count = Math.max(2, Math.min(12, Math.round(args.count ?? 6)));
        // Seeking exactly at the end can land past the last frame, so stop just short of it.
        const last = Math.max(0, info.duration - 0.05);
        const from = Math.max(0, Math.min(args.start ?? 0, last));
        const to = Math.min(last, Math.max(from, args.end ?? last));
        const at = Array.from({ length: count }, (_, i) => Math.round((from + ((to - from) * i) / (count - 1)) * 100) / 100);
        const tiles = await Promise.all(at.map(async (s) => ({ image: await videoFrame(path, s), label: `${s.toFixed(1)}s` })));
        const sheet = await contactSheet(tiles, count > 6 ? 4 : 3);
        return {
          text: `\`${video.id}\`${video.name ? ` ${video.name}` : ''}：${info.duration.toFixed(2)} 秒，${info.width}×${info.height}，${Math.round(info.fps)} fps，${info.hasAudio ? '有声音' : '没有音轨'}。抽了 ${count} 帧：${at.map((s) => `${s.toFixed(1)}s`).join('、')}。`,
          images: [{ data: sheet.toString('base64'), mimeType: 'image/jpeg' }],
          summary: t('{n} 帧', { n: count }),
          items: [video.id],
        };
      },
    }),

    tool<{ prompt: string; model?: ImageModel; reference_ids?: string[]; aspect?: string; quality?: '1k' | '2k'; count?: number; name?: string; group?: string; retry_of?: string }>({
      name: 'generate_image',
      label: msg('生成图片'),
      description:
        '在画布上生成图片，结果放在第一张参考图旁边并连线（多张从上到下排成一列；写了 group 时排进那一类型的列）。提交后立刻返回新节点 id，不等结果。' +
        'qwen（默认，Qwen-Image）：质量高、能写中文字，可传最多 10 张参考图做编辑、换背景、保持人物一致，提示词里用「图1」「图2」按 reference_ids 的顺序指代。' +
        'zimage（Z-Image Turbo）：几秒出图的草图模型，不支持参考图。' +
        '重做检查不通过的节点时传 retry_of=<那个节点 id>（次数记在它身上），name 和 group 跟原来一样。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述' },
          model: { type: 'string', enum: ['qwen', 'zimage'] },
          reference_ids: ids('参考图节点 id（只有 qwen 支持，最多 10 张）', 10),
          aspect: { type: 'string', description: '画面比例，如 16:9、9:16、1:1、3:4、4:3、21:9；auto = 跟第一张参考图一样。默认：有参考图时 auto，否则 1:1' },
          quality: { type: 'string', enum: ['1k', '2k'], description: '默认 1k' },
          count: { type: 'integer', minimum: 1, maximum: 4, description: '张数，默认 1' },
          name: { type: 'string', description: '节点名称（可选，显示在画布上）' },
          group: { type: 'string', description: '图片类型，如「全身照」「脸部特写」「场景」「关键帧」：同一类型的图从上到下排成一列，画布上已有这一列时接在它下面（可选）' },
          retry_of: { type: 'string', description: '重做的来源：检查不通过的那个节点 id（可选）' },
        },
        required: ['prompt'],
      },
      describe: (a) => clip(a.prompt ?? ''),
      prompts: (a) => [{ label: a.name?.trim() ?? '', text: a.prompt ?? '', refs: a.reference_ids ?? [] }],
      async run(args, ctx) {
        const model = imageModel(args.model);
        const refIds = args.reference_ids ?? [];
        if (model === 'zimage' && refIds.length) throw new Error(noReferences());
        if (refIds.length > 10) throw new Error(t('参考图最多 {n} 张', { n: 10 }));
        const p = await readBoard(deps, ctx.projectId);
        const refs = findItems(p, refIds);
        const media = inputMedia(deps, refs, 'image');
        const request: TaskRequest = {
          op: 'image.generate',
          model,
          prompt: args.prompt,
          aspect: args.aspect?.trim() || (refs.length ? 'auto' : '1:1'),
          quality: args.quality === '2k' ? '2k' : '1k',
          images: media.map((m) => m.id),
        };
        const count = Math.min(4, Math.max(1, Math.round(args.count ?? 1)));
        const retry = args.retry_of ? retryTarget(p, args.retry_of) : undefined;
        const { items, error } = await launch(deps, writer, ctx.projectId, { request, count, inputs: refs, name: args.name, group: args.group, retryOf: retry?.id, images: true, view: ctx.view });
        const made = items.map((i) => `\`${i.id}\``).join(' ');
        return {
          text:
            `已提交 ${items.length} 张，新节点：${made}。每张${roughly(imageEstimate(deps.tasks.list(), request))}（前面有排队任务会更久）。${error ? `另有 ${count - items.length} 张提交失败：${error}` : ''}` +
            promptHint([{ label: '', text: args.prompt }]),
          summary: t('{n} 张已提交', { n: items.length }),
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ prompt: string; model?: VideoModel; image_ids?: string[]; aspect?: string; quality?: '480p' | '720p'; duration?: number; count?: number; name?: string }>({
      name: 'generate_video',
      label: msg('生成视频'),
      description:
        '用 MiniMax H3 在画布上生成带音频的视频，提交后立刻返回新节点 id，不等结果。很慢：一段要几分钟，具体按这台服务器的实测速度算（面板里写在 <canvas_context>，外部 agent 用 get_context 查），GPU 一次只跑一个任务。' +
        'minimax（默认）：image_ids 可传 0–2 张，第 1 张是首帧、第 2 张是尾帧，不传就是纯文生视频。' +
        'minimax-ref（多图参考）：image_ids 传 1–9 张参考图（人物、场景、道具、分镜），提示词里用 @图1、@图2 指代。' +
        '提示词写动作、镜头运动、对白和声音，不要只重复画面内容。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model: { type: 'string', enum: ['minimax', 'minimax-ref'] },
          image_ids: ids('首帧/尾帧或参考图的节点 id', 9),
          aspect: { type: 'string', description: '16:9、9:16、1:1、4:3、3:4；auto = 跟第一张图一样。默认：有图时 auto，否则 16:9' },
          quality: { type: 'string', enum: ['480p', '720p'], description: '默认 480p，720p 更清晰也更慢' },
          duration: { type: 'integer', enum: VIDEO_DURATIONS, description: '秒数，默认 5' },
          count: { type: 'integer', minimum: 1, maximum: 2, description: '默认 1' },
          name: { type: 'string', description: '节点名称（可选）' },
        },
        required: ['prompt'],
      },
      describe: (a) => clip(a.prompt ?? ''),
      prompts: (a) => [{ label: a.name?.trim() ?? '', text: a.prompt ?? '', refs: a.image_ids ?? [] }],
      async run(args, ctx) {
        const model: VideoModel = args.model === 'minimax-ref' ? 'minimax-ref' : 'minimax';
        const imageIds = args.image_ids ?? [];
        if (model === 'minimax' && imageIds.length > 2) throw new Error(t('minimax 最多 2 张图（首帧、尾帧）；要用更多参考图请用 minimax-ref'));
        if (model === 'minimax-ref' && !imageIds.length) throw new Error(t('minimax-ref 至少需要 1 张参考图'));
        if (imageIds.length > 9) throw new Error(t('参考图最多 {n} 张', { n: 9 }));
        const p = await readBoard(deps, ctx.projectId);
        const frames = findItems(p, imageIds);
        const media = inputMedia(deps, frames, 'image');
        const duration = snapDuration(args.duration);
        const request: TaskRequest = {
          op: 'video.generate',
          model,
          prompt: args.prompt,
          aspect: args.aspect?.trim() || (frames.length ? 'auto' : '16:9'),
          quality: args.quality === '720p' ? '720p' : '480p',
          duration,
          images: media.map((m) => m.id),
        };
        const count = Math.min(2, Math.max(1, Math.round(args.count ?? 1)));
        const { items, error } = await launch(deps, writer, ctx.projectId, { request, count, inputs: frames, name: args.name, view: ctx.view });
        return {
          text: `已提交 ${items.length} 段 ${duration} 秒视频，新节点：${items.map((i) => `\`${i.id}\``).join(' ')}。预计 GPU ${roughly(videoEstimate(deps.tasks.list(), request.quality, items.map(() => duration)).seconds)}（前面有排队任务会更久）。${error ? `另有 ${count - items.length} 段提交失败：${error}` : ''}`,
          summary: t('{n} 段已提交（{duration} 秒）', { n: items.length, duration }),
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ capability?: string; needs?: 'image' | 'video' | 'mask'; image_count?: number; video_count?: number; aspect?: string }>({
      name: 'list_workflows',
      readOnly: true,
      label: msg('查看工作流'),
      description:
        '列出能用的工作流：id、能力（文生图 / 图生图编辑 / 局部重绘 / 放大 / 抠图 / 文生视频 / 图生视频 / 视频编辑）、约束、成本耗时、输入和参数。' +
        '运行前按 capability 和实际 image_count / video_count 筛选，要求明确比例时传 aspect；只能从返回的候选里选 run_workflow。' +
        '没有候选时按补救建议处理，不要用相近能力代替。不确定有哪些能力时可先不带条件列全部。',
      parameters: {
        type: 'object',
        properties: {
          capability: {
            type: 'string',
            description: '按能力筛选，如 image_edit、image_to_video、upscale',
          },
          needs: {
            type: 'string',
            enum: ['image', 'video', 'mask'],
            description: '只列出接受这类输入的（兼容旧调用；有实际数量时用 image_count / video_count）',
          },
          image_count: { type: 'integer', minimum: 0, description: '实际会传入的图片数量，包括 0；不确定时不传' },
          video_count: { type: 'integer', minimum: 0, description: '实际会传入的视频数量，包括 0；不确定时不传' },
          aspect: { type: 'string', description: '明确要求的画面比例，如 16:9；auto 或不传表示不筛选比例' },
        },
      },
      describe: () => t('可用的工作流'),
      async run(args, ctx) {
        const query = args ?? {};
        const caps = await deps.capabilities();
        const all = deps.workflows();
        const ready = all.filter((w) => !caps.features[`custom:${w.id}`]?.length && !w.inputs.some((i) => i.type === 'mask'));
        const blocked = all.filter((w) => !ready.includes(w));
        const blockedText = blocked.length
          ? `\n暂不可用：${blocked
              .slice(0, 3)
              .map((w) => {
                const missing = caps.features[`custom:${w.id}`] ?? [];
                return missing.length ? `「${w.name}」缺 ${missing.join('、')}` : `「${w.name}」需要蒙版，请在画布选中图片后手动运行`;
              })
              .join('；')}${blocked.length > 3 ? `；另有 ${blocked.length - 3} 个` : ''}`
          : '';
        const pool = ready.filter((w) => matchesCapability(w, query));
        if (!pool.length) {
          const queried = query.capability || query.needs || query.image_count !== undefined || query.video_count !== undefined || (query.aspect && query.aspect !== 'auto');
          if (!queried) return { text: `没有能用的工作流。请先导入一个节点和模型齐全的工作流。${blockedText}`, summary: t('{n} 个可用', { n: 0 }) };

          const capPool = ready.filter((w) => matchesCapability(w, { capability: query.capability, needs: query.needs }));
          const countPool = capPool.filter((w) => matchesCapability(w, { image_count: query.image_count, video_count: query.video_count }));
          let reason: string;
          if (!capPool.length) {
            const have = [...new Set(ready.map((w) => w.capability?.capability).filter((c): c is WorkflowCapability => Boolean(c)))];
            const labels = have.map((c) => `${CAPABILITY_LABEL[c]}(${c})`).join('、');
            const capability = query.capability ? (CAPABILITY_LABEL[query.capability as WorkflowCapability] ?? query.capability) : '';
            const want = [capability, query.needs ? `接受${query.needs}输入` : ''].filter(Boolean).join(' + ');
            reason = `没有满足「${want}」的工作流。现在可用能力：${labels || '无'}。请导入一个能力与输入类型相符、依赖齐全的工作流`;
          } else if (!countPool.length) {
            const requirements = capPool.slice(0, 3).map((w) => {
              const images = w.inputs.filter((i) => i.type === 'image');
              const videos = w.inputs.filter((i) => i.type === 'video');
              const parts = [
                query.image_count !== undefined ? `图片需 ${images.filter((i) => !i.optional).length}–${images.length} 张` : '',
                query.video_count !== undefined ? `视频需 ${videos.filter((i) => !i.optional).length}–${videos.length} 个` : '',
              ].filter(Boolean);
              return `「${w.name}」${parts.join('，')}`;
            });
            reason = `能力相符，但实际素材数量不符：${requirements.join('；')}。请调整素材数量，或在编辑器里修正必需/可选输入映射`;
          } else {
            reason = `能力与素材数量相符，但这些工作流不支持把比例改为 ${query.aspect}。请在编辑器里添加宽高或比例输入映射，或导入支持比例控制的工作流`;
          }
          return { text: `${reason}。${blockedText}\n不要运行其它能力代替。`, summary: t('无匹配') };
        }
        const history = deps.tasks.list();
        const ranks = await ctx.workflowRanks?.(pool);
        const sorted = ranks ? ranks.map((r) => pool.find((w) => w.id === r.id)!) : pool;
        const lines = sorted.map((w) => {
          const license = licenseLabel(`custom:${w.id}`, (zh) => zh);
          const rank = ranks?.find((r) => r.id === w.id);
          const route = rank ? ` · 路由分 ${rank.score}（执行 ${rank.samples} 次，用户质量反馈 ${rank.qualitySamples} 次${rank.quality === null ? '，质量未知' : ''}）` : '';
          return `- \`${w.id}\`「${w.name}」· ${capabilityLine(w, history)}${route}${license ? ` · ${license}` : ''}${w.description ? ` · ${clip(w.description, 80)}` : ''}\n  输入：${inputsLine(w)}`;
        });
        return {
          text: `能用的工作流 ${pool.length} 个：\n${lines.join('\n')}${blockedText}`,
          summary: t('{n} 个可用', { n: pool.length }),
        };
      },
    }),

    tool<{
      workflow_id: string;
      prompt?: string;
      negative?: string;
      image_ids?: string[];
      video_ids?: string[];
      aspect?: string;
      params?: Record<string, string | number | boolean>;
      count?: number;
      name?: string;
      group?: string;
      retry_of?: string;
    }>({
      name: 'run_workflow',
      label: msg('运行工作流'),
      description: '运行 list_workflows 里列出的工作流，结果放到画布上并连线。提交后立刻返回新节点 id。图片、视频输入按工作流里的顺序传节点 id。重做检查不通过的节点时传 retry_of=<那个节点 id>（次数记在它身上）。',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string' },
          prompt: { type: 'string' },
          negative: { type: 'string' },
          image_ids: ids('图片输入的节点 id，按顺序'),
          video_ids: ids('视频输入的节点 id，按顺序'),
          aspect: { type: 'string', description: '画面比例（工作流有尺寸输入时才有用），如 16:9；auto = 跟第一张输入图一样' },
          params: { type: 'object', description: '其它参数：键是 list_workflows 里 params.<id> 的 id，值是字符串、数字或布尔' },
          count: { type: 'integer', minimum: 1, maximum: 4 },
          name: { type: 'string', description: '节点名称（可选）' },
          group: { type: 'string', description: '出图的工作流：图片类型，如「全身照」「脸部特写」「场景」「关键帧」：同一类型的图从上到下排成一列，画布上已有这一列时接在它下面（可选）' },
          retry_of: { type: 'string', description: '重做的来源：检查不通过的那个节点 id（可选）' },
        },
        required: ['workflow_id'],
      },
      describe: (a) => a.workflow_id,
      prompts: (a) => (a.prompt?.trim() ? [{ label: a.name?.trim() ?? '', text: a.prompt, refs: [...(a.image_ids ?? []), ...(a.video_ids ?? [])] }] : []),
      async run(args, ctx) {
        const wf = deps.workflows().find((w) => w.id === args.workflow_id);
        if (!wf) throw new Error(t('没有 id 为 {id} 的工作流（用 list_workflows 查看）', { id: args.workflow_id }));
        const caps = await deps.capabilities();
        const missing = caps.features[`custom:${wf.id}`] ?? [];
        if (missing.length) throw new Error(t('这个工作流暂时不可用：{reason}', { reason: missing.join('、') }));
        if (wf.inputs.some((i) => i.type === 'mask')) throw new Error(t('这个工作流需要蒙版，请用户在画布上选中图片后手动运行'));
        const prompt = wf.inputs.find((i) => i.type === 'prompt');
        if (prompt && !String(prompt.default ?? '').trim() && !args.prompt?.trim()) throw new Error(t('这个工作流需要提示词'));
        const p = await readBoard(deps, ctx.projectId);
        const imageItems = findItems(p, args.image_ids ?? []);
        const videoItems = findItems(p, args.video_ids ?? []);
        for (const kind of ['image', 'video'] as const) {
          const slots = wf.inputs.filter((i) => i.type === kind);
          const given = (kind === 'image' ? imageItems : videoItems).length;
          const required = slots.filter((i) => !i.optional).length;
          const labels = list(slots.map((s) => t(s.label)));
          if (given > slots.length) throw new Error(kind === 'image' ? t('这个工作流最多 {n} 个图片输入', { n: slots.length }) : t('这个工作流最多 {n} 个视频输入', { n: slots.length }));
          if (given < required) throw new Error(kind === 'image' ? t('这个工作流需要 {n} 个图片输入：{list}', { n: required, list: labels }) : t('这个工作流需要 {n} 个视频输入：{list}', { n: required, list: labels }));
        }
        const images = inputMedia(deps, imageItems, 'image');
        const videos = inputMedia(deps, videoItems, 'video');
        const controlsAspect =
          (wf.inputs.some((i) => i.type === 'width') && wf.inputs.some((i) => i.type === 'height')) || wf.inputs.some((i) => i.type === 'aspect');
        const askedAspect = args.aspect?.trim();
        if (askedAspect && askedAspect !== 'auto' && !controlsAspect) {
          throw new Error(t('这个工作流不支持调整画面比例，请在编辑器里添加宽高或比例输入映射'));
        }
        const request: TaskRequest = {
          op: 'custom',
          workflow: wf.id,
          prompt: args.prompt,
          negative: args.negative,
          images: images.map((m) => m.id),
          videos: videos.map((m) => m.id),
          aspect: controlsAspect ? askedAspect || 'auto' : 'auto',
          params: args.params ?? {},
        };
        const count = Math.min(4, Math.max(1, Math.round(args.count ?? 1)));
        const retry = args.retry_of ? retryTarget(p, args.retry_of) : undefined;
        const { items, error } = await launch(deps, writer, ctx.projectId, {
          request,
          count,
          inputs: [...imageItems, ...videoItems],
          name: args.name ?? wf.name,
          group: args.group,
          retryOf: retry?.id,
          images: wf.kind === 'image',
          view: ctx.view,
        });
        return {
          text: `已提交「${wf.name}」${items.length} 次，新节点：${items.map((i) => `\`${i.id}\``).join(' ')}。${error ? `另有 ${count - items.length} 次提交失败：${error}` : ''}`,
          summary: `${t(wf.name)} · ${t('{n} 个已提交', { n: items.length })}`,
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ ids: string[]; timeout_seconds?: number }>({
      name: 'wait_for_items',
      readOnly: true,
      label: msg('等待结果'),
      description:
        '等这些节点生成完（或失败），返回每个的结果。需要拿结果做下一步时才用；视频很慢，除非用户要求，否则提交后不必等。超时后返回当前进度，可以再次调用。',
      parameters: {
        type: 'object',
        properties: {
          ids: { ...ids('要等的节点 id', 20), minItems: 1 },
          timeout_seconds: { type: 'integer', minimum: 10, maximum: 1200, description: '最多等多久，默认 300' },
        },
        required: ['ids'],
      },
      describe: (a) => t('{n} 个节点', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, args.ids);
        const taskIds = new Set(items.map((i) => i.taskId).filter(Boolean));
        const deadline = Date.now() + Math.min(1200, Math.max(10, args.timeout_seconds ?? 300)) * 1000;
        const states = () => items.map((item) => ({ item, state: stateOf(deps, item) }));
        const isOpen = (s: ReturnType<typeof stateOf>) => !s.done && !s.finished;

        const final = await new Promise<ReturnType<typeof states>>((resolve) => {
          let last = '';
          const check = () => {
            const now = states();
            const open = now.filter((s) => isOpen(s.state));
            const first = open[0]?.state;
            const line = `${now.length - open.length}/${now.length} 完成${first && !first.done ? ` · ${first.text}` : ''}`;
            if (line !== last) ctx.progress?.(line);
            last = line;
            if (!open.length || Date.now() >= deadline || ctx.signal?.aborted || ctx.interrupt?.aborted) {
              deps.tasks.off('task', onTask);
              clearInterval(timer);
              ctx.signal?.removeEventListener('abort', check);
              ctx.interrupt?.removeEventListener('abort', check);
              resolve(now);
            }
          };
          const onTask = (task: Task) => {
            if (taskIds.has(task.id)) check();
          };
          deps.tasks.on('task', onTask);
          const timer = setInterval(check, 5000);
          ctx.signal?.addEventListener('abort', check);
          ctx.interrupt?.addEventListener('abort', check);
          check();
        });

        ctx.seen?.(final.filter(({ state }) => !isOpen(state)).map(({ item }) => item.id));
        const lines = final.map(({ item, state }) =>
          state.done ? `\`${item.id}\` 完成（${state.media.width}×${state.media.height}）` : `\`${item.id}\` ${state.finished ? state.text : `还没好：${state.text}`}`,
        );
        const done = final.filter((s) => s.state.done).length;
        const open = final.filter((s) => isOpen(s.state)).length;
        const failed = final.length - done - open;
        return {
          text:
            lines.join('\n') +
            (!open ? '' : ctx.interrupt?.aborted ? '\n（用户发来了新消息，先停止等待）' : '\n（等待超时，可以稍后再调用 wait_for_items）'),
          summary: [t('{done}/{total} 完成', { done, total: final.length }), failed ? t('{n} 个失败', { n: failed }) : '', open ? t('{n} 个还在生成', { n: open }) : ''].filter(Boolean).join(t('，')),
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ id?: string; title: string; content: string }>({
      name: 'write_note',
      label: msg('写文本'),
      description:
        '在画布上新建或更新一个文本节点，用来放剧本、角色设定、分镜表、备注。内容是简单的 Markdown，表格用 | 分隔。' +
        '更新时传 id，会整段替换。用户可能在画布上改过，改之前先用 read_board 读最新内容。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要更新的文本节点 id；不传就新建' },
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title', 'content'],
      },
      describe: (a) => a.title ?? '',
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const lines = args.content.split('\n').length;
        const wide = /^\s*\|/m.test(args.content);
        const size = { w: wide ? 760 : 440, h: Math.min(1400, Math.max(180, 64 + lines * 22)) };
        if (args.id) {
          const [item] = findItems(p, [args.id]);
          if (item.kind !== 'text') throw new Error(t('节点 {id} 不是文本节点', { id: args.id }));
          await patchBoard(deps, ctx.projectId, { upsert: [{ ...item, name: args.title.trim() || item.name, text: args.content, h: Math.max(item.h, size.h) }] });
          return { text: `已更新文本节点 \`${item.id}\``, summary: t('更新「{title}」', { title: args.title }), items: [item.id] };
        }
        const bounds = boundsOf(p.items);
        const start = ctx.view ? { x: ctx.view.x - size.w / 2, y: ctx.view.y - size.h / 2 } : bounds ? { x: bounds.x - size.w - GAP * 3, y: bounds.y } : { x: 0, y: 0 };
        const [pos] = placeRow(p.items, start, [size]);
        const note: CanvasItem = { id: nanoid(10), kind: 'text', x: Math.round(pos.x), y: Math.round(pos.y), ...size, name: args.title.trim(), text: args.content, createdAt: Date.now() };
        await patchBoard(deps, ctx.projectId, { upsert: [note] });
        return { text: `已新建文本节点 \`${note.id}\`「${note.name}」`, summary: t('「{title}」', { title: args.title }), items: [note.id] };
      },
    }),

    tool<{ jobs: { prompt: string; reference_ids?: string[]; aspect?: string; name?: string; group?: string; retry_of?: string }[]; model?: ImageModel; quality?: '1k' | '2k' }>({
      name: 'batch_generate_images',
      label: msg('批量出图'),
      description:
        `一次提交多张图（最多 ${MAX_BATCH} 张），每张有自己的提示词和参考图（规则同 generate_image）。` +
        '每张写 group（图片类型）：同一类型的图按顺序从上到下排成一列，不同类型的列并排；画布上已有这一类型的列时，新图接在它下面。同一类型的图在整个画布上用同一个 group 名。' +
        `提交后立刻返回；${afterBatch}分镜关键帧 group 写「关键帧」、按镜头顺序提交，name 写镜头编号。` +
        '重做检查不通过的图时，在这一张的 retry_of 写那个节点 id（次数记在它身上）。',
      parameters: {
        type: 'object',
        properties: {
          jobs: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_BATCH,
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                reference_ids: ids('参考图节点 id（只有 qwen 支持，最多 10 张）', 10),
                aspect: { type: 'string', description: '如 16:9、9:16、1:1；auto = 跟第一张参考图一样' },
                name: { type: 'string', description: '节点名称，如 S01 或「程诺 · 全身」' },
                group: { type: 'string', description: '图片类型，如「全身照」「脸部特写」「场景」「关键帧」：同一类型的图从上到下排成一列，画布上已有这一列时接在它下面' },
                retry_of: { type: 'string', description: '重做的来源：检查不通过的那个节点 id（可选）' },
              },
              required: ['prompt'],
            },
          },
          model: { type: 'string', enum: ['qwen', 'zimage'] },
          quality: { type: 'string', enum: ['1k', '2k'], description: '默认 1k' },
        },
        required: ['jobs'],
      },
      describe: (a) => t('{n} 张', { n: a.jobs?.length ?? 0 }),
      prompts: (a) => (a.jobs ?? []).slice(0, MAX_BATCH).map((j) => ({ label: j.name?.trim() ?? '', text: j.prompt ?? '', refs: j.reference_ids ?? [] })),
      async run(args, ctx) {
        const model = imageModel(args.model);
        const p = await readBoard(deps, ctx.projectId);
        // Check every job before queueing any, so a bad id does not leave half a batch.
        const jobs: BatchJob[] = args.jobs.slice(0, MAX_BATCH).map((j, n) => {
          const refIds = j.reference_ids ?? [];
          if (model === 'zimage' && refIds.length) throw new Error(t('第 {n} 张：{reason}', { n: n + 1, reason: noReferences() }));
          const refs = findItems(p, refIds.slice(0, 10));
          const media = inputMedia(deps, refs, 'image');
          const retry = j.retry_of ? retryTarget(p, j.retry_of) : undefined;
          return {
            request: {
              op: 'image.generate',
              model,
              prompt: j.prompt,
              aspect: j.aspect?.trim() || (refs.length ? 'auto' : '1:1'),
              quality: args.quality === '2k' ? '2k' : '1k',
              images: media.map((m) => m.id),
            },
            inputs: refs,
            name: j.name,
            group: j.group,
            retryOf: retry?.id,
          };
        });
        const { items, failed } = await launchBatch(deps, writer, ctx.projectId, jobs, { layout: 'groups', view: ctx.view });
        if (!items.length) throw new Error(failed[0]?.error ?? t('提交失败'));
        ctx.notify?.(t('{n} 张图片', { n: items.length }), items);
        const list = items.map((i) => `${i.name ? `${i.name} → ` : ''}\`${i.id}\``).join('\n');
        const errors = failed.map((f) => `第 ${f.index + 1} 张提交失败：${f.error}`).join('\n');
        return {
          text:
            `已提交 ${items.length} 张：\n${list}${errors ? `\n${errors}` : ''}\n${ctx.notify ? '全部结束时你会收到通知。' : afterBatch}` +
            promptHint(args.jobs.slice(0, MAX_BATCH).map((j, i) => ({ label: j.name?.trim() || `第 ${i + 1} 张`, text: j.prompt ?? '' }))),
          summary: failed.length ? t('{n} 张已提交，{failed} 张失败', { n: items.length, failed: failed.length }) : t('{n} 张已提交', { n: items.length }),
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ jobs: { prompt: string; first_frame_id: string; last_frame_id?: string; duration?: number; name?: string }[]; quality?: '480p' | '720p' }>({
      name: 'batch_generate_videos',
      label: msg('批量出视频'),
      description:
        `一次提交多段图生视频（MiniMax H3，最多 ${MAX_BATCH} 段），每段从自己的首帧图开始，可选尾帧；视频放在首帧右边。` +
        '提交前会做稳定性预检：同一段里既有精细手部动作或大幅动作、又有复杂运镜（两种以上的运镜，或环绕、手持、快速摇移）会被直接拒收，按提示拆镜头或改成固定机位。' +
        (host === 'panel'
          ? '这一步很耗 GPU，会先在面板上请用户确认：调用后告诉用户在等他确认，然后结束这一轮；用户确认后会自动提交，全部结束时你会收到通知。' +
            '确认卡弹出后又重做了某个镜头的首帧时（name 和 group 跟原来一样），不用重新提交：用户确认时会自动换成重做后的版本。再调用一次会让之前没确认的卡作废。'
          : `这一步很耗 GPU（一块 GPU 排队跑，get_context 里有实测速度，返回结果里有这一批的预计时间），调用前先跟用户确认。提交后立刻返回；${afterBatch}`),
      parameters: {
        type: 'object',
        properties: {
          jobs: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_BATCH,
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                first_frame_id: { type: 'string', description: '首帧图片节点 id' },
                last_frame_id: { type: 'string', description: '尾帧图片节点 id（可选）' },
                duration: { type: 'integer', enum: VIDEO_DURATIONS, description: '秒数，默认 5；镜头短也生成 5 秒，剪辑时再裁' },
                name: { type: 'string', description: '节点名称，如 S01' },
              },
              required: ['prompt', 'first_frame_id'],
            },
          },
          quality: { type: 'string', enum: ['480p', '720p'], description: '默认 480p' },
        },
        required: ['jobs'],
      },
      describe: (a) => t('{n} 段', { n: a.jobs?.length ?? 0 }),
      prompts: (a) =>
        (a.jobs ?? []).slice(0, MAX_BATCH).map((j) => ({ label: j.name?.trim() ?? '', text: j.prompt ?? '', refs: [j.first_frame_id, ...(j.last_frame_id ? [j.last_frame_id] : [])].filter(Boolean) })),
      async run(args, ctx) {
        assertStable(args.jobs.slice(0, MAX_BATCH));
        const p = await readBoard(deps, ctx.projectId);
        const quality = args.quality === '720p' ? '720p' : '480p';
        const jobs = args.jobs.slice(0, MAX_BATCH).map((j) => {
          const frames = findItems(p, [j.first_frame_id, ...(j.last_frame_id ? [j.last_frame_id] : [])]);
          inputMedia(deps, frames, 'image');
          return { prompt: j.prompt, frames: frames.map((f) => f.id), duration: snapDuration(j.duration), name: j.name ?? null };
        });
        const seconds = jobs.reduce((n, j) => n + j.duration, 0);
        const since = Date.now();
        const estimate = videoEstimate(deps.tasks.list(), quality, jobs.map((j) => j.duration));
        const minutes = Math.max(1, Math.round(estimate.seconds / 60));
        if (host === 'mcp') {
          const out = await launchVideos({ quality, jobs }, ctx);
          return { ...out, text: `${out.text}\n预计 GPU 约 ${minutes} 分钟（共 ${seconds} 秒、${quality}）。` };
        }
        return {
          text: `已在面板上请用户确认：${jobs.length} 段、共 ${seconds} 秒、${quality}，预计 GPU 约 ${minutes} 分钟。用户确认后会自动提交，全部结束时你会收到通知。现在告诉用户在等他确认，然后结束这一轮。`,
          summary: t('等待确认'),
          approval: {
            title: t('生成 {n} 段视频', { n: jobs.length }),
            detail: t(
              estimate.measured
                ? '共 {seconds} 秒 · {quality} · 预计 GPU 约 {minutes} 分钟（按这台服务器以往的速度估算，期间其他生成任务要排队）'
                : '共 {seconds} 秒 · {quality} · 预计 GPU 约 {minutes} 分钟（按参考显卡的速度估算，期间其他生成任务要排队）',
              { seconds, quality, minutes },
            ),
            payload: { quality, jobs, since },
            frames: jobs.map((j) => j.frames[0]),
            since,
          },
        };
      },
      approve: launchVideos,
    }),

    tool<{ ids: string[] }>({
      name: 'review_items',
      readOnly: true,
      label: msg('审片'),
      vision: true,
      description:
        `把最多 16 个图片或视频节点拼成带编号的大图来检查：图片每 4 张拼一张，视频每段取开头、中间、结尾三帧（编号后面加 a、b、c），一次最多 ${MAX_REVIEW_CLIPS} 段视频。比一张张用 view_images 省。` +
        '检查：人物是不是同一个人、有没有多出来的人、人是不是画面的主体（人太小、比分镜表的景别远的要重做）、背景对不对；站位：每个人在哪一层（屋里、门框、阳台、栏杆外）、脚有没有踩在地面上、和墙、栏杆、家具谁在前谁在后、左右是不是和分镜表一样；视线：有没有人盯着镜头（分镜没要求就算错），说话的两个人是不是看着对方；人和家具、道具接触的地方（坐的椅子、靠的桌子、手里拿的东西）有没有粘在一起或穿过去；视频还要看动作有没有做出来、人物有没有变形。' +
        '站位画错了，用 mark_layout 在底图上标出位置再出，不要只是换个说法重画；人太小，先用 crop_image 把场景图裁到这一镜的取景再出。',
      parameters: { type: 'object', properties: { ids: { ...ids('节点 id', 16), minItems: 1 } }, required: ['ids'] },
      describe: (a) => t('{n} 个', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, args.ids.slice(0, 16));
        const stills: Tile[] = [];
        const clips: Tile[][] = [];
        const lines: string[] = [];
        const skipped: string[] = [];
        let n = 0;
        for (const item of items) {
          const state = stateOf(deps, item);
          const stored = state.done ? deps.assets.get(state.media.id) : undefined;
          if (!state.done || !stored) {
            skipped.push(`\`${item.id}\` (${state.done ? t('文件不见了') : state.text})`);
            continue;
          }
          const path = deps.assets.path(stored);
          if (stored.kind === 'video') {
            if (clips.length >= MAX_REVIEW_CLIPS) {
              skipped.push(`\`${item.id}\` (一次最多看 ${MAX_REVIEW_CLIPS} 段视频)`);
              continue;
            }
            const { duration } = await probe(path);
            const at = [Math.min(0.3, duration / 4), duration / 2, Math.max(0, duration - 0.4)];
            const label = String(++n);
            clips.push(await Promise.all(at.map(async (s, k) => ({ image: await videoFrame(path, s), label: `${label}${'abc'[k]}` }))));
            lines.push(`${label}a、${label}b、${label}c = 开头、中间、结尾：${describeItem(deps, item, 120)}`);
          } else {
            stills.push({ image: path, label: String(++n) });
            lines.push(`${n} = ${describeItem(deps, item, 120)}`);
          }
        }
        if (!n) throw new Error(t('没有可看的画面：{list}', { list: list(skipped) }));
        const sheets = await Promise.all([
          ...chunk(stills, 4).map((c) => contactSheet(c, 2)),
          ...chunk(clips, 2).map((c) => contactSheet(c.flat(), 3)),
        ]);
        return {
          text: `${sheets.length > 1 ? `共 ${sheets.length} 张拼图，图片在前、视频在后。` : ''}拼图里的编号：\n${lines.join('\n')}${skipped.length ? `\n跳过：${skipped.join('、')}` : ''}`,
          images: sheets.map((sheet) => ({ data: sheet.toString('base64'), mimeType: 'image/jpeg' })),
          summary: t('{n} 个', { n }),
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ entries: { id: string; verdict: 'pass' | 'fail'; reason?: ReviewReason; note?: string }[] }>({
      name: 'record_review',
      label: msg('记检查结论'),
      description:
        '看过结果之后，把结论写回节点：verdict 是 pass 或 fail；fail 时 reason 从这些里选：' +
        REVIEW_REASONS.map((r) => `${r}（${REASON_LABEL[r]}）`).join('、') +
        '，note 一句话写清哪里不对。结论留在节点上，之后的对话里 read_board 也看得到。' +
        `不通过的重做时，在 generate_image、batch_generate_images、run_workflow 里带 retry_of=<这个节点的 id>：每个结果最多重做 ${RETRY_LIMIT} 次；` +
        '预算用完还不行，就用 ask_user 把原因和选项交给用户，不要自己再试。',
      parameters: {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '节点 id' },
                verdict: { type: 'string', enum: ['pass', 'fail'] },
                reason: { type: 'string', enum: REVIEW_REASONS, description: '没通过的原因（fail 时写）' },
                note: { type: 'string', description: '哪里不对，一句话（可选）' },
              },
              required: ['id', 'verdict'],
            },
          },
        },
        required: ['entries'],
      },
      describe: (a) => t('{n} 个', { n: a.entries?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const entries = args.entries.slice(0, 16);
        const items = findItems(p, entries.map((e) => e.id));
        const now = Date.now();
        const next: CanvasItem[] = [];
        const lines: string[] = [];
        let passed = 0;
        let failed = 0;
        for (const [i, e] of entries.entries()) {
          const item = items[i];
          if (item.kind === 'text' || item.kind === 'prompt') throw new Error(t('节点 {id} 是文本节点：检查结论只记在图片和视频上', { id: item.id }));
          const state = stateOf(deps, item);
          if (!state.done) throw new Error(t('节点 {id} 还没有结果（{state}），等它生成完再记结论', { id: item.id, state: state.text }));
          const ok = e.verdict === 'pass';
          const reason = ok ? undefined : REVIEW_REASONS.includes(e.reason as ReviewReason) ? (e.reason as ReviewReason) : 'other';
          const note = e.note?.trim().slice(0, 120) || undefined;
          next.push({ ...item, review: { verdict: ok ? 'pass' : 'fail', ...(reason ? { reason } : {}), ...(note ? { note } : {}), at: now } });
          if (ok) {
            passed++;
            lines.push(`\`${item.id}\` 通过`);
            continue;
          }
          failed++;
          const left = retriesLeft(p, item);
          const cost = left ? retryCost(item) : '';
          lines.push(
            `\`${item.id}\` 不通过（${REASON_LABEL[reason!]}）${note ? `：${note}` : ''}。改法：${REASON_FIX[reason!]}。` +
              (left
                ? `还能重做 ${left} 次${cost ? `（${cost}）` : ''}：重做时传 retry_of=\`${item.id}\`，name 和 group 跟原来一样。`
                : `重试预算（${RETRY_LIMIT} 次）已经用完：不要再重做，用 ask_user 把原因和「换方案 / 就用这版 / 用户自己改」交给用户选。`),
          );
        }
        await patchBoard(deps, ctx.projectId, { upsert: next });
        return {
          text: lines.join('\n'),
          summary: t('{passed} 个通过，{failed} 个不通过', { passed, failed }),
          items: next.map((i) => i.id),
        };
      },
    }),

    tool<{ ids: string[] }>({
      name: 'inspect_clips',
      readOnly: true,
      label: msg('听声音'),
      description:
        '查看视频节点的时长，以及哪几秒有明显的声音（生成的镜头里通常就是台词；环境声很轻，不算）。剪辑前用它决定每段裁到哪里：台词常常在镜头后半段才说，别按分镜秒数直接裁掉。',
      parameters: { type: 'object', properties: { ids: { ...ids('视频节点 id', 40), minItems: 1 } }, required: ['ids'] },
      describe: (a) => t('{n} 段', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, args.ids);
        const media = inputMedia(deps, items, 'video');
        const lines: string[] = [];
        for (const [i, m] of media.entries()) {
          const stored = deps.assets.get(m.id);
          if (!stored) throw new Error(t('节点 {id} 的视频文件不见了', { id: items[i].id }));
          const path = deps.assets.path(stored);
          const info = await probe(path);
          const spans = info.hasAudio ? await soundSpans(path, info.duration) : [];
          const sound = !info.hasAudio ? '没有音轨' : spans.length ? `明显的声音在 ${spans.map((s) => `${s.start.toFixed(2)}–${s.end.toFixed(2)}`).join('、')} 秒` : '只有很轻的环境声，没有台词';
          lines.push(`\`${items[i].id}\`${items[i].name ? ` ${items[i].name}` : ''}：${info.duration.toFixed(2)} 秒；${sound}`);
        }
        return { text: lines.join('\n'), summary: t('{n} 段', { n: items.length }), items: items.map((i) => i.id) };
      },
    }),

    tool<{ clips: { id: string; start?: number; end?: number; skip_first_frame_check?: boolean; lines?: { text: string; from?: number; to?: number }[] }[]; subtitles?: boolean; level?: boolean; name?: string }>({
      name: 'assemble_video',
      label: msg('剪辑成片'),
      description:
        '按顺序把视频节点拼成一条成片（硬切），每段可以裁头尾（start/end 是这段里的秒数）。保留每段自带的声音，剪辑点做极短的淡入淡出，不会爆音。\n' +
        '每段的 lines 写这段里说的台词原文（按说话顺序，一人一句；画外音、电话里的声音也算；没有台词就不写）：有台词的段，对白音量统一到 -16 LUFS，没有台词的段跟着一起调，环境声不会被拉得和台词一样响；台词默认烧成画面下方的字幕（标点按中文字幕习惯处理，太长会拆成先后两条），subtitles=false 不烧。' +
        '每句默认显示在这段里有声音的那几秒、按字数分配；对不上时给每句写 from / to（这段里的秒数，看 inspect_clips）。\n' +
        '拼之前会抽每段视频的第 0 秒，和它的首帧图比对：差得太多就报错，指出是哪一段（确认这段本来就不是从关键帧开始的，给这一段传 skip_first_frame_check=true 跳过检查）。\n' +
        '有声音的段没写 lines（台词）会被拦下；裁剪会切掉 0.3 秒以上的明显声音也会报错，不再只是提示。\n' +
        '成片放在画布上，连回每一段。在运行服务的电脑上用 ffmpeg 处理，几十秒到几分钟。',
      parameters: {
        type: 'object',
        properties: {
          clips: {
            type: 'array',
            minItems: 1,
            maxItems: 80,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                start: { type: 'number' },
                end: { type: 'number' },
                skip_first_frame_check: { type: 'boolean', description: '这段不比对第 0 秒和首帧：确认这段本来就不是从关键帧开始时才用，默认 false' },
                lines: {
                  type: 'array',
                  maxItems: 6,
                  description: '这段里说的台词，按顺序',
                  items: {
                    type: 'object',
                    properties: {
                      text: { type: 'string', description: '台词原文，和分镜表一字不差' },
                      from: { type: 'number', description: '这句从这段的第几秒开始说' },
                      to: { type: 'number', description: '这句说到第几秒' },
                    },
                    required: ['text'],
                  },
                },
              },
              required: ['id'],
            },
          },
          subtitles: { type: 'boolean', description: '把台词烧成字幕，默认 true' },
          level: { type: 'boolean', description: '统一每段对白的音量，默认 true' },
          name: { type: 'string', description: '成片名称' },
        },
        required: ['clips'],
      },
      describe: (a) => t('{n} 段', { n: a.clips?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, args.clips.map((c) => c.id));
        const media = inputMedia(deps, items, 'video');
        const clips = media.map((m, i) => {
          const stored = deps.assets.get(m.id);
          if (!stored) throw new Error(t('节点 {id} 的视频文件不见了', { id: items[i].id }));
          const c = args.clips[i];
          const lines = (c.lines ?? []).flatMap((l) => (l?.text?.trim() ? [{ text: l.text.trim().slice(0, 200), from: l.from, to: l.to }] : []));
          return { path: deps.assets.path(stored), start: c.start, end: c.end, lines };
        });
        // Gate: each clip must start on its keyframe. Clips whose first input is not a finished image
        // (an imported video, or a previous cut) cannot be checked and are left alone.
        const wrong = (
          await Promise.all(
            clips.map(async (c, i) => {
              if (args.clips[i].skip_first_frame_check) return undefined;
              const frameId = items[i].inputs?.[0] ?? items[i].sourceId;
              if (!frameId) return undefined;
              const frame = p.items.find((it) => it.id === frameId);
              if (!frame || frame.kind !== 'image') return undefined;
              const state = stateOf(deps, frame);
              if (!state.done || state.media.kind !== 'image') return undefined;
              const stored = deps.assets.get(state.media.id);
              if (!stored) return undefined;
              const [want, got] = await Promise.all([
                frameSignature(deps.assets.path(stored)),
                videoFrame(c.path, 0).then((png) => frameSignature(png)),
              ]);
              const diff = frameDistance(want, got);
              if (diff <= KEYFRAME_TOLERANCE) return undefined;
              return t('{name}：第 0 秒和首帧 `{frame}` 差 {diff}（容差 {tolerance}），这段视频不是从关键帧开始的', {
                name: items[i].name ?? items[i].id,
                frame: frameId,
                diff: diff.toFixed(2),
                tolerance: KEYFRAME_TOLERANCE.toFixed(2),
              });
            }),
          )
        ).filter((x): x is string => Boolean(x));
        if (wrong.length) {
          throw new Error(
            t('关键帧检查没通过：这几段视频的第 0 秒和它们的首帧对不上：\n{lines}\n改法：用原来的关键帧重新生成这一段（或者重新出关键帧，再生成），让视频从这张图开始；确认这段本来就不是从关键帧开始的，给这一段传 skip_first_frame_check: true 跳过检查。', {
              lines: wrong.join('\n'),
            }),
          );
        }
        // Gate: sound the edit would lose, or audible clips with no lines written.
        const infos = await Promise.all(clips.map((c) => probe(c.path)));
        const spans = await Promise.all(infos.map((info, i) => (info.hasAudio ? soundSpans(clips[i].path, info.duration) : Promise.resolve([] as { start: number; end: number }[]))));
        const edit = editIssues(
          clips.map((c, i) => ({
            name: items[i].name ?? items[i].id,
            duration: infos[i].duration,
            start: c.start ?? 0,
            end: c.end ?? infos[i].duration,
            hasAudio: infos[i].hasAudio,
            spans: spans[i],
            lines: c.lines.length,
          })),
        );
        if (edit.length) {
          const lines = edit.map((e) =>
            e.kind === 'missing-lines'
              ? t('{name}：{from}–{to} 秒有明显的声音，但这段没有写 lines（台词）', { name: e.name, from: e.span.start.toFixed(2), to: e.span.end.toFixed(2) })
              : t('{name}：{from}–{to} 秒有明显的声音，裁到 {keepFrom}–{keepTo} 秒会切掉 {lost} 秒', {
                  name: e.name,
                  from: e.span.start.toFixed(2),
                  to: e.span.end.toFixed(2),
                  keepFrom: e.keep.from.toFixed(2),
                  keepTo: e.keep.to.toFixed(2),
                  lost: e.lost.toFixed(2),
                }),
          );
          throw new Error(
            t('剪辑前的检查没通过：\n{lines}\n改法：有声音的段把台词原文写进 lines（照分镜表一字不差，按说话顺序，一人一句）；裁剪会切掉声音的段，把 start / end 调整到声音之外（台词说完再留 0.3 秒左右），再重新剪。', {
              lines: lines.join('\n'),
            }),
          );
        }
        ctx.progress?.(`剪辑 ${clips.length} 段…`);
        const dir = await mkdtemp(join(tmpdir(), 'kynflow-cut-'));
        try {
          const out = join(dir, 'cut.mp4');
          const cut = await concatClips(clips, out, ctx.signal, { level: args.level !== false, subtitles: args.subtitles !== false });
          const info = await probe(out);
          const name = args.name?.trim().slice(0, 60) || '成片';
          const asset = await deps.assets.save(await readFile(out), { filename: 'cut.mp4', mime: 'video/mp4', size: { width: info.width, height: info.height }, name });
          const fresh = await readBoard(deps, ctx.projectId);
          const b = boundsOf(items)!;
          const size = displaySize(info.width, info.height, 960);
          const [pos] = placeRow(fresh.items, { x: b.x + b.w + GAP * 4, y: b.y + (b.h - size.h) / 2 }, [size]);
          const item: CanvasItem = {
            id: nanoid(10),
            kind: 'video',
            x: Math.round(pos.x),
            y: Math.round(pos.y),
            ...size,
            asset: publicAsset(asset),
            inputs: [...new Set(items.map((i) => i.id))],
            name,
            cutList: args.clips.map((c) => ({ id: c.id, start: c.start, end: c.end, lines: c.lines })),
            createdAt: Date.now(),
          };
          await patchBoard(deps, ctx.projectId, { upsert: [item] });
          const moved = cut.gains.flatMap((g, i) => (Math.abs(g) >= 3 ? [`${items[i].name ?? items[i].id} ${g > 0 ? '+' : ''}${g} dB`] : []));
          const lined = clips.some((c) => c.lines.length);
          const sound = cut.gains.length
            ? `\n对白音量统一到 ${DIALOGUE_LUFS} LUFS${moved.length ? `（调得多的：${moved.join('、')}）` : ''}。`
            : args.level !== false && !lined
              ? '\n没有写台词（lines），对白音量没有统一，也没有字幕。'
              : '';
          const subs = cut.cues.length ? `\n字幕 ${cut.cues.length} 条：${cut.cues.map((c) => `${c.start.toFixed(1)}–${c.end.toFixed(1)} 秒「${c.text}」`).join('；')}` : '';
          return {
            text: `成片 \`${item.id}\`：${clips.length} 段，${info.duration.toFixed(1)} 秒，${info.width}×${info.height}${sound}${subs}`,
            summary: t('{duration} 秒', { duration: info.duration.toFixed(1) }),
            items: [item.id],
          };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    }),

    tool<{ ids: string[]; remove?: boolean }>({
      name: 'cancel_items',
      destructive: true,
      label: msg('取消生成'),
      description: '取消这些节点还在排队或生成中的任务。remove=true 时顺便把这些占位节点从画布上删掉（只删还没有结果的，已经生成好的图和视频不会删）。',
      parameters: {
        type: 'object',
        properties: { ids: { ...ids('节点 id'), minItems: 1 }, remove: { type: 'boolean', description: '同时删掉这些占位节点，默认 false' } },
        required: ['ids'],
      },
      describe: (a) => t('{n} 个节点', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, args.ids);
        const cancelled: string[] = [];
        for (const item of items) {
          if (!item.taskId) continue;
          const [task] = deps.tasks.list([item.taskId]);
          if (task?.status !== 'queued' && task?.status !== 'running') continue;
          await deps.tasks.cancel(item.taskId);
          cancelled.push(item.id);
        }
        ctx.seen?.(items.map((i) => i.id));
        const removable = args.remove ? items.filter((i) => i.kind !== 'text' && i.kind !== 'prompt' && !stateOf(deps, i).done).map((i) => i.id) : [];
        if (removable.length) await patchBoard(deps, ctx.projectId, { remove: removable });
        return {
          text: (cancelled.length ? `已取消：${cancelled.map((id) => `\`${id}\``).join(' ')}` : '这些节点没有进行中的任务') + (removable.length ? `；已从画布删掉 ${removable.length} 个占位` : ''),
          summary: removable.length ? t('取消了 {n} 个，删掉 {removed} 个占位', { n: cancelled.length, removed: removable.length }) : t('取消了 {n} 个', { n: cancelled.length }),
          items: cancelled.filter((id) => !removable.includes(id)),
        };
      },
    }),

    tool<{ ids: string[] }>({
      name: 'delete_items',
      destructive: true,
      label: msg('删除节点'),
      description:
        '把已经生成好的图片和视频从画布上删掉（用户说「删掉这几张」「不要的都删了」时）。' +
        (host === 'panel' ? '会先在面板上弹确认卡，用户点了才删；调用后告诉用户在等他确认，然后结束这一轮。' : '会直接删除，先问过用户再调用。') +
        '删之前会自动存一个快照，删错了用户可以在顶栏菜单的「项目快照」里恢复（画布上的撤销撤不回助手的改动）。还在排队或生成中的用 cancel_items；文本节点不能用它删。',
      parameters: {
        type: 'object',
        properties: { ids: { ...ids('要删的节点 id'), minItems: 1 } },
        required: ['ids'],
      },
      describe: (a) => t('{n} 个节点', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, [...new Set(args.ids)]);
        const done = items.filter((i) => i.kind !== 'text' && i.kind !== 'prompt' && stateOf(deps, i).done);
        const kept = items.filter((i) => !done.includes(i));
        if (!done.length) throw new Error(t('这些节点里没有已经生成好的图片或视频：还在生成的用 cancel_items，文本节点不能删'));
        const skipped = kept.length
          ? `\n没删：${kept.map((i) => `\`${i.id}\`（${i.kind === 'text' || i.kind === 'prompt' ? '文本节点' : '还没有结果，用 cancel_items'}）`).join('，')}`
          : '';
        const payload = { ids: done.map((i) => i.id) };
        if (host === 'mcp') {
          const out = await deleteItems(payload, ctx);
          return { ...out, text: out.text + skipped };
        }
        const images = done.filter((i) => i.kind === 'image').length;
        const videos = done.filter((i) => i.kind === 'video').length;
        const others = done.length - images - videos;
        return {
          text: `已在面板上请用户确认删除 ${done.length} 个节点：${payload.ids.map((id) => `\`${id}\``).join(' ')}。用户点了才会删。现在告诉用户在等他确认，然后结束这一轮。${skipped}`,
          summary: t('等待确认'),
          approval: {
            title: others
              ? t('删除 {n} 个节点', { n: done.length })
              : !videos
                ? t('删除 {n} 张图', { n: images })
                : !images
                  ? t('删除 {n} 段视频', { n: videos })
                  : t('删除 {images} 张图和 {videos} 段视频', { images, videos }),
            detail: t('删之前会自动存一个快照：删错了，在顶栏菜单的「项目快照」里恢复（画布上的撤销撤不回）。'),
            payload,
            frames: payload.ids,
            confirm: t('删除'),
          },
        };
      },
      approve: deleteItems,
    }),

    tool<{ ids?: string[]; beside?: string; side?: Side; dx?: number; dy?: number; positions?: { id: string; x: number; y: number }[] }>({
      name: 'move_items',
      label: msg('移动节点'),
      description:
        '移动画布上的节点（坐标是画布坐标，x 向右、y 向下，位置指左上角；现在的位置和大小用 read_board 看）。三种用法选一种：' +
        '① ids + beside（另一个节点的 id）+ side（right / left / below / above，默认 right）：把这些节点整体放到那个节点旁边，彼此的相对位置不变，挡路的节点会自动让开；' +
        '② ids + dx / dy：整体平移；' +
        '③ positions：把每个节点放到给定坐标，比如放回原位。' +
        '画布上的撤销撤不回助手的移动：返回里记着原位置，用户要放回去时用 positions；一次挪动一大片之前，先用 save_snapshot 存个快照。',
      parameters: {
        type: 'object',
        properties: {
          ids: ids('要移动的节点 id（用法 ① ②）'),
          beside: { type: 'string', description: '放到这个节点旁边（用法 ①）' },
          side: { type: 'string', enum: SIDES, description: '放在 beside 节点的哪一边，默认 right' },
          dx: { type: 'number', description: '向右移多少（负数向左）' },
          dy: { type: 'number', description: '向下移多少（负数向上）' },
          positions: {
            type: 'array',
            description: '每个节点的新位置（用法 ③）',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
              required: ['id', 'x', 'y'],
            },
          },
        },
      },
      describe: (a) => t('{n} 个节点', { n: a.positions?.length || a.ids?.length || 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const at = new Map<string, { x: number; y: number }>();
        let moved: CanvasItem[];
        if (args.positions?.length) {
          moved = findItems(p, [...new Set(args.positions.map((m) => m.id))]);
          for (const m of args.positions) {
            if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) throw new Error(t('positions 里的 x、y 要是数字'));
            at.set(m.id, { x: m.x, y: m.y });
          }
        } else {
          if (!args.ids?.length) throw new Error(t('要传 ids（配 beside 或 dx / dy），或者传 positions'));
          moved = findItems(p, [...new Set(args.ids)]);
          const b = boundsOf(moved)!;
          let dx: number;
          let dy: number;
          if (args.beside) {
            if (args.ids.includes(args.beside)) throw new Error(t('beside 的节点不能也在要移动的节点里'));
            const [anchor] = findItems(p, [args.beside]);
            const side = SIDES.includes(args.side as Side) ? (args.side as Side) : 'right';
            const ours = new Set(moved.map((i) => i.id));
            const spot = clearOf(p.items.filter((i) => !ours.has(i.id)), besideOf(anchor, b, side), side);
            dx = spot.x - b.x;
            dy = spot.y - b.y;
          } else {
            dx = Number(args.dx ?? 0);
            dy = Number(args.dy ?? 0);
            if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) throw new Error(t('要传 beside，或者不全为 0 的 dx / dy'));
          }
          for (const i of moved) at.set(i.id, { x: i.x + dx, y: i.y + dy });
        }
        await patchBoard(deps, ctx.projectId, {
          upsert: moved.map((i) => ({ ...i, x: Math.round(at.get(i.id)!.x), y: Math.round(at.get(i.id)!.y) })),
        });
        const b = boundsOf(moved.map((i) => ({ ...i, ...at.get(i.id)! })))!;
        return {
          text: `已移动 ${moved.length} 个节点，现在整体在 (${Math.round(b.x)},${Math.round(b.y)})，占 ${Math.round(b.w)}×${Math.round(b.h)}。${formerly(moved)}`,
          summary: t('移动了 {n} 个', { n: moved.length }),
          items: moved.map((i) => i.id),
        };
      },
    }),

    tool<{ ids: string[]; layout: Arrangement; columns?: number; gap?: number }>({
      name: 'arrange_items',
      label: msg('排列节点'),
      description:
        '把这些节点重新排整齐，顺序就是 ids 的顺序（比如按镜头号排）。layout：row 排成一行（顶端对齐）；column 排成一列（左边对齐）；' +
        'grid 排成网格（columns 列，不传就接近正方形）；groups 按类型（group）分列，同一类型从上到下一列，各列按类型第一次出现的顺序从左到右，没有类型的节点单独一列。' +
        '排好的整块放在这些节点原来所在区域的左上角，挡到别的节点时往右让开。排之前会自动存快照；返回里也记着原位置，用户只想把它们放回去时用 move_items 的 positions。',
      parameters: {
        type: 'object',
        properties: {
          ids: { ...ids('要排的节点 id，按排列顺序', MAX_LISTED), minItems: 1 },
          layout: { type: 'string', enum: ARRANGEMENTS },
          columns: { type: 'integer', minimum: 1, description: 'grid 的列数' },
          gap: { type: 'number', minimum: 0, description: `节点之间的间距，默认 ${GAP}` },
        },
        required: ['ids', 'layout'],
      },
      describe: (a) => t('{n} 个节点', { n: a.ids?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const items = findItems(p, [...new Set(args.ids)]);
        const layout = ARRANGEMENTS.includes(args.layout) ? args.layout : 'grid';
        const gap = typeof args.gap === 'number' && Number.isFinite(args.gap) ? Math.min(Math.max(0, args.gap), 1000) : GAP;
        const { positions, w, h } = arrange(items, layout, { columns: args.columns, gap });
        const b = boundsOf(items)!;
        const ours = new Set(items.map((i) => i.id));
        const spot = clearOf(p.items.filter((i) => !ours.has(i.id)), { x: b.x, y: b.y, w, h }, 'right');
        const saved = await snapshotFirst(ctx.projectId, t('助手排列 {n} 个节点之前', { n: items.length }));
        await patchBoard(deps, ctx.projectId, {
          upsert: items.map((i, n) => ({ ...i, x: Math.round(spot.x + positions[n].x), y: Math.round(spot.y + positions[n].y) })),
        });
        return {
          text: `已把 ${items.length} 个节点排成${ARRANGED[layout]}，整体在 (${Math.round(spot.x)},${Math.round(spot.y)})，占 ${Math.round(w)}×${Math.round(h)}。${saved}${formerly(items)}`,
          summary: t('排好了 {n} 个', { n: items.length }),
          items: items.map((i) => i.id),
        };
      },
    }),

    tool<{ changes: { id: string; name?: string; group?: string }[] }>({
      name: 'update_items',
      label: msg('改名称和类型'),
      description:
        '修改节点的名称（name）和类型（group），只改传了的字段，传空字符串就清掉。文本节点的 name 就是标题。' +
        '重做的关键帧要和原来的 name、group 一样，视频确认卡才认得出来；批量出图按 group 分列。改了 group 不会自动挪位置，要排进那一列用 arrange_items。',
      parameters: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_LISTED,
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, name: { type: 'string' }, group: { type: 'string', description: '图片类型，比如「关键帧」「角色」' } },
              required: ['id'],
            },
          },
        },
        required: ['changes'],
      },
      describe: (a) => t('{n} 个节点', { n: a.changes?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const next = new Map(findItems(p, args.changes.map((c) => c.id)).map((i) => [i.id, i]));
        for (const c of args.changes) {
          const item = next.get(c.id)!;
          next.set(c.id, {
            ...item,
            name: c.name === undefined ? item.name : c.name.trim().slice(0, 60) || undefined,
            group: c.group === undefined ? item.group : c.group.trim().slice(0, 30) || undefined,
          });
        }
        const lines: string[] = [];
        for (const [id, item] of next) {
          const before = p.items.find((i) => i.id === id)!;
          const diff = [
            before.name !== item.name ? `名称「${before.name ?? ''}」→「${item.name ?? ''}」` : '',
            before.group !== item.group ? `类型「${before.group ?? ''}」→「${item.group ?? ''}」` : '',
          ].filter(Boolean);
          if (diff.length) lines.push(`\`${id}\` ${diff.join('，')}`);
        }
        const changed = [...next.values()].filter((i) => lines.some((l) => l.startsWith(`\`${i.id}\``)));
        if (changed.length) await patchBoard(deps, ctx.projectId, { upsert: changed });
        return {
          text: lines.length ? `已修改：\n${lines.join('\n')}` : '都和原来一样，没有改动',
          summary: t('改了 {n} 个', { n: changed.length }),
          items: [...next.keys()],
        };
      },
    }),

    tool<{ name: string }>({
      name: 'save_snapshot',
      label: msg('存快照'),
      description:
        '把画布现在的样子存成快照，用户可以在顶栏菜单的「项目快照」里恢复，或从它分出一块新画布。用户要求时存；' +
        '自己要大改画布之前（比如批量重做一整组图、一次挪动一大片节点）也先存一个。delete_items 和 arrange_items 动手前会自动存，不用再存。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '快照名称，说清楚是哪个版本，比如「第一版关键帧」' } },
        required: ['name'],
      },
      describe: (a) => a.name ?? '',
      async run(args, ctx) {
        const snap = await deps.projects.createSnapshot(ctx.projectId, args.name);
        if (!snap) throw new Error(t('画布不存在（可能已被删除）'));
        return {
          text: `已存快照「${snap.name}」（${snap.itemCount} 个节点），用户可以在顶栏菜单的「项目快照」里恢复。`,
          summary: t('「{title}」', { title: snap.name }),
        };
      },
    }),

    tool<{ id: string; seconds?: number; name?: string; group?: string }>({
      name: 'capture_frame',
      label: msg('截取视频帧'),
      description:
        '从视频节点截一帧存成图片，放到画布上并连回这段视频。不传 seconds 就截最后一帧：拿它当下一段视频的首帧，接缝处人物的姿势和位置完全对得上（做法见 short_drama 手册 video 一节）。' +
        '传 seconds 就截那一秒的画面。要当下一个镜头的首帧时，name 写那个镜头的编号，group 写「关键帧」，它会排进关键帧那一列。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '视频节点 id' },
          seconds: { type: 'number', minimum: 0, description: '截第几秒的画面；不传就截最后一帧' },
          name: { type: 'string' },
          group: { type: 'string', description: '图片类型，比如「关键帧」' },
        },
        required: ['id'],
      },
      describe: (a) => (typeof a.seconds === 'number' ? t('第 {s} 秒', { s: a.seconds }) : t('最后一帧')),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const [video] = findItems(p, [args.id]);
        const [media] = inputMedia(deps, [video], 'video');
        const stored = deps.assets.get(media.id);
        if (!stored) throw new Error(t('节点 {id} 的视频文件不见了', { id: video.id }));
        const path = deps.assets.path(stored);
        const info = await probe(path);
        // A time in the last moments may fall past the last frame: that is the last frame too.
        const at = typeof args.seconds === 'number' && Number.isFinite(args.seconds) && args.seconds < info.duration - 0.2 ? Math.max(0, args.seconds) : undefined;
        const png = at === undefined ? await lastFrame(path, ctx.signal) : await videoFrame(path, at);
        if (!png.length) throw new Error(t('没有从视频里截到画面'));
        const name =
          args.name?.trim().slice(0, 60) ||
          (at === undefined
            ? video.name ? t('{name} 尾帧', { name: video.name }) : t('尾帧')
            : video.name ? t('{name} 第 {s} 秒', { name: video.name, s: at }) : t('第 {s} 秒', { s: at }));
        const asset = await deps.assets.save(png, { filename: 'frame.png', mime: 'image/png', size: { width: info.width, height: info.height }, name });
        const fresh = await readBoard(deps, ctx.projectId);
        const size = displaySize(info.width, info.height, LONG_SIDE.image);
        const group = args.group?.trim().slice(0, 30) || undefined;
        const [pos] = group
          ? placeGroups(fresh.items, [{ group, inputs: [video] }], [size], () => besideOf(video, size, 'right'))
          : [clearOf(fresh.items, besideOf(video, size, 'right'), 'right')];
        const item: CanvasItem = {
          id: nanoid(10),
          kind: 'image',
          x: Math.round(pos.x),
          y: Math.round(pos.y),
          ...size,
          asset: publicAsset(asset),
          inputs: [video.id],
          name,
          group,
          createdAt: Date.now(),
        };
        await patchBoard(deps, ctx.projectId, { upsert: [item] });
        return {
          text: `已截取 \`${video.id}\` 的${at === undefined ? '最后一帧' : `第 ${at} 秒`}，存成图片 \`${item.id}\`「${name}」（${info.width}×${info.height}）`,
          summary: name,
          items: [item.id],
        };
      },
    }),

    tool<{ id: string; x: number; y: number; w: number; name?: string }>({
      name: 'crop_image',
      vision: true,
      label: msg('取景'),
      description:
        '从一张图里裁出一块，放大回原图的尺寸，存成新图片放在原图右边并连回原图。裁出的形状和原图一样：只给左上角 x、y 和宽度 w（都是相对原图宽高的比例），高度是同样的比例。' +
        '主要用来给关键帧取景：场景图是交代整个空间的大全景，直接拿它当参考、又写「机位和图1一样」，人就会被画成大场景里的小人。中景、近景的镜头，先用 view_images 看清场景图，' +
        '把这个镜头要拍的那一块裁出来（以人站的地方为中心，裁出来的画面里人要占大半个高度），再拿裁好的图代替原来的场景图当参考；要标站位就在裁好的图上用 mark_layout。w 最小 0.3，放得越大越糊。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要裁的图片节点 id（一般是场景图）' },
          x: { type: 'number', minimum: 0, maximum: 1, description: '裁出区域左边缘的位置' },
          y: { type: 'number', minimum: 0, maximum: 1, description: '裁出区域上边缘的位置' },
          w: { type: 'number', minimum: 0.3, maximum: 1, description: '裁出区域的宽度，高度按同样的比例' },
          name: { type: 'string', description: '新图片的名称（可选），比如「S29 取景」' },
        },
        required: ['id', 'x', 'y', 'w'],
      },
      describe: (a) => `${Math.round((a.w ?? 1) * 100)}%`,
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const [source] = findItems(p, [args.id]);
        const [media] = inputMedia(deps, [source], 'image');
        const stored = deps.assets.get(media.id);
        if (!stored) throw new Error(t('节点 {id} 的图片文件不见了', { id: source.id }));
        const { png, width, height, box } = await cropFrame(deps.assets.path(stored), args);
        const name = args.name?.trim().slice(0, 60) || t('{name} 取景', { name: source.name ?? t('图片') });
        const asset = await deps.assets.save(png, { filename: 'frame.png', mime: 'image/png', size: { width, height }, name });
        const size = { w: source.w, h: source.h };
        const pos = clearOf(p.items, besideOf(source, size, 'right'), 'right');
        const item: CanvasItem = { id: nanoid(10), kind: 'image', x: Math.round(pos.x), y: Math.round(pos.y), ...size, asset: publicAsset(asset), inputs: [source.id], name, createdAt: Date.now() };
        await patchBoard(deps, ctx.projectId, { upsert: [item] });
        const zoom = Math.round((1 / box.w) * 10) / 10;
        return {
          text:
            `取景图 \`${item.id}\`「${name}」：原图从 (${box.x}, ${box.y}) 起、宽 ${box.w} 的一块，放大了 ${zoom} 倍。` +
            '出关键帧时用它代替原来的场景图当场景参考，景别和人在画面里占多大照分镜表写；放大的背景会有点糊，提示词照常写清画面清晰、景深多浅。要标站位就在这张图上用 mark_layout。',
          summary: t('放大 {n} 倍', { n: zoom }),
          items: [item.id],
        };
      },
    }),

    tool<{ id: string; boxes: { who: string; x: number; y: number; w: number; h: number }[]; name?: string }>({
      name: 'mark_layout',
      vision: true,
      label: msg('标站位'),
      description:
        `在一张场景图（一般是这个机位的空场景）上用彩色方框标出每个人的位置，生成一张「站位图」放在画布上。画图模型常常画错文字里的前后层次（门里还是门外、栏杆这一侧还是外侧），标在图上它照得准得多。` +
        `框按顺序是${MARK_COLORS.map((c) => c.name).join('、')}色。x、y、w、h 是相对图片宽高的比例（0–1，x、y 是框的左上角）：先用 view_images 看清底图，框住人在画面里要占的整块区域。` +
        '底图的取景就是成片的取景：中景、近景的镜头，先用 crop_image 把场景图裁到这个镜头的取景，再在裁好的图上标，框从头顶上方一点一直伸到画面底边（腰或胸以下被画面切掉），人占画面的大半高度；在大全景上直接标，人只会是小小的一个。' +
        '全身入画的全景，框的底边画在他脚踩的那片地面上；按透视，离镜头远的人框小、底边高，近的框大、底边低。' +
        '出图时把底图和站位图都放进 reference_ids，底图在前，站位图紧跟其后，提示词怎么写见 qwen_image 手册的 layout 一节。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '场景图节点 id' },
          boxes: {
            type: 'array',
            minItems: 1,
            maxItems: MARK_COLORS.length,
            items: {
              type: 'object',
              properties: {
                who: { type: 'string', description: '框里是谁（或什么），比如「陆星辰」' },
                x: { type: 'number', minimum: 0, maximum: 1 },
                y: { type: 'number', minimum: 0, maximum: 1 },
                w: { type: 'number', minimum: 0, maximum: 1 },
                h: { type: 'number', minimum: 0, maximum: 1 },
              },
              required: ['who', 'x', 'y', 'w', 'h'],
            },
          },
          name: { type: 'string', description: '站位图的名称（可选），比如「S30 站位」' },
        },
        required: ['id', 'boxes'],
      },
      describe: (a) => t('{n} 个框', { n: a.boxes?.length ?? 0 }),
      async run(args, ctx) {
        const p = await readBoard(deps, ctx.projectId);
        const [plate] = findItems(p, [args.id]);
        const [media] = inputMedia(deps, [plate], 'image');
        const stored = deps.assets.get(media.id);
        if (!stored) throw new Error(t('节点 {id} 的图片文件不见了', { id: plate.id }));
        const boxes = args.boxes.slice(0, MARK_COLORS.length);
        const { png, width, height } = await markBoxes(deps.assets.path(stored), boxes);
        const name = args.name?.trim().slice(0, 60) || t('{name} 站位', { name: plate.name ?? t('场景') });
        const asset = await deps.assets.save(png, { filename: 'layout.png', mime: 'image/png', size: { width, height }, name });
        const size = { w: plate.w, h: plate.h };
        const pos = clearOf(p.items, besideOf(plate, size, 'right'), 'right');
        const item: CanvasItem = { id: nanoid(10), kind: 'image', x: Math.round(pos.x), y: Math.round(pos.y), ...size, asset: publicAsset(asset), inputs: [plate.id], name, createdAt: Date.now() };
        await patchBoard(deps, ctx.projectId, { upsert: [item] });
        const legend = boxes.map((b, i) => `${MARK_COLORS[i].name}框 = ${b.who}`).join('，');
        return {
          text:
            `站位图 \`${item.id}\`「${name}」：${legend}。出图时 reference_ids 先放底图 \`${plate.id}\`、再放这张站位图，然后是人物图；` +
            '提示词写「图1是这台机位的实景，成片的场景、机位、景别和光线与图1完全一样。图2是同一张照片，上面的方框标出了每个人在画面里占的位置和大小：红框里是……」；全景再加一句「框的底边是脚踩的地方」。',
          summary: legend,
          items: [item.id],
        };
      },
    }),

    // In the panel only: outside agents have their own to-do lists, questions and plan modes.
    ...(host === 'panel' ? panelTools() : []),
  ];
}

const TODO_STATES = ['pending', 'in_progress', 'completed'] as const;
const MAX_TODOS = 30;
const MAX_OPTIONS = 6;

/** The to-do list, asking the user, and handing in a plan: what the panel shows and answers. */
function panelTools(): CanvasTool[] {
  return [
    tool<{ todos: { content: string; status: AgentTodo['status'] }[] }>({
      name: 'update_todos',
      readOnly: true,
      label: msg('待办'),
      description:
        '多步的任务（三步以上，比如做一部短剧、整理一整块画布）开始时，把步骤列成待办清单，用户在面板顶部能看到进度。每次传完整的清单，会整个替换。' +
        '同一时间只有一项 in_progress；做完一项马上标 completed，不要攒着一起标；计划变了就改清单。一两步就能做完的事不用列。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            maxItems: MAX_TODOS,
            items: {
              type: 'object',
              properties: { content: { type: 'string', description: '这一步做什么，一句话' }, status: { type: 'string', enum: TODO_STATES } },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
      describe: (a) => t('{done}/{total} 完成', { done: a.todos?.filter((x) => x.status === 'completed').length ?? 0, total: a.todos?.length ?? 0 }),
      async run(args, ctx) {
        const list: AgentTodo[] = (args.todos ?? [])
          .map((x) => ({ content: String(x.content ?? '').trim().slice(0, 120), status: TODO_STATES.includes(x.status) ? x.status : 'pending' }))
          .filter((x) => x.content)
          .slice(0, MAX_TODOS);
        ctx.todos?.(list);
        const done = list.filter((x) => x.status === 'completed').length;
        const now = list.find((x) => x.status === 'in_progress');
        return {
          text: `待办已更新：${done}/${list.length} 完成${now ? `，正在做「${now.content}」` : ''}`,
          summary: t('{done}/{total} 完成', { done, total: list.length }),
        };
      },
    }),

    tool<{ question: string; options: { label: string; description?: string }[]; multiple?: boolean }>({
      name: 'ask_user',
      readOnly: true,
      label: msg('提问'),
      description:
        `需要用户拍板时（画风、比例、几个镜头、两个方案选哪个），在面板上给出 2–${MAX_OPTIONS} 个可以直接点的选项，用户也可以自己填。用户的回答会作为下一条消息发来。` +
        '调用后告诉用户你在等他选，然后结束这一轮。一次只问一个问题；能自己定的小事不要问，不要用它确认生成（批量视频自带确认卡）。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '问题，一句话' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: MAX_OPTIONS,
            items: {
              type: 'object',
              properties: { label: { type: 'string', description: '选项，几个字' }, description: { type: 'string', description: '选这个会怎样（可选）' } },
              required: ['label'],
            },
          },
          multiple: { type: 'boolean', description: '可以多选，默认单选' },
        },
        required: ['question', 'options'],
      },
      describe: (a) => clip(a.question ?? ''),
      async run(args) {
        const text = String(args.question ?? '').trim().slice(0, 300);
        const options = (args.options ?? [])
          .map((o) => ({ label: String(o.label ?? '').trim().slice(0, 60), ...(o.description?.trim() ? { description: o.description.trim().slice(0, 200) } : {}) }))
          .filter((o) => o.label)
          .slice(0, MAX_OPTIONS);
        if (!text || options.length < 2) throw new Error(t('要有一个问题和至少两个选项'));
        return {
          text: `已在面板上问用户「${text}」（选项：${options.map((o) => o.label).join(' / ')}）。用户的回答会作为下一条消息发来。现在告诉用户在等他选，然后结束这一轮。`,
          summary: text,
          question: { text, options, ...(args.multiple ? { multiple: true } : {}) },
        };
      },
    }),

    tool<{
      changes: {
        action: MemoryOp['action'];
        scope: MemoryOp['scope'];
        id?: string;
        type?: MemoryOp['type'];
        text?: string;
        why?: string;
        entity_id?: string;
        requested_by_user?: boolean;
      }[];
    }>({
      name: 'remember',
      label: msg('记忆'),
      description:
        '把值得长期记住的事写进记忆，或者改掉、删掉旧的（id 见系统提示词最后的「记忆」）。scope board 只对这块画布有效（type：setting 人物、画风、世界设定；decision 定下来的事，包括否掉的方案；preference 这部作品的偏好），' +
        `scope series 对这个系列的所有画布都有效（同一部作品的不同画布共享人物、世界观和画风设定），scope user 对所有画布都有效（type：preference 用户的长期偏好；feedback 用户纠正过的做法）。每条一句话，写清楚是什么，原因写在 why。一条不超过 ${ENTRY_CHARS} 字；画布记忆最多 ${MEMORY_LIMIT.board} 字，系列设定最多 ${MEMORY_LIMIT.series} 字，用户偏好最多 ${MEMORY_LIMIT.user} 字，满了会自动归档最旧的非置顶条目。` +
        'update 会保留旧条目作为历史，不会覆盖；用户改了主意就 update 或 delete。用户关掉了自动记忆的作用域，只有用户明确要求时才能写，这时把 requested_by_user 设为 true；delete 总是可以。' +
        '不要记画布上已有的内容（剧本、分镜、提示词）、临时进度和一次性的要求。',
      parameters: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['add', 'update', 'delete'] },
                scope: { type: 'string', enum: ['series', 'board', 'user'], description: 'series：整个系列共享；board：这块画布；user：所有画布' },
                id: { type: 'string', description: 'update / delete 时：记忆的 id' },
                type: { type: 'string', enum: ['setting', 'decision', 'preference', 'feedback'] },
                text: { type: 'string' },
                why: { type: 'string', description: '原因（可选）' },
                entity_id: { type: 'string', description: '挂到某个设定条目下时填它的 id（可选，见提示词里的设定条目）' },
                requested_by_user: { type: 'boolean', description: '用户明确要求记下来时设 true（可选）' },
              },
              required: ['action', 'scope'],
            },
          },
        },
        required: ['changes'],
      },
      describe: (a) => t('{n} 处改动', { n: a.changes?.length ?? 0 }),
      async run(args, ctx) {
        if (!ctx.remember) throw new Error(t('这里不能写记忆'));
        const ops = (args.changes ?? []).slice(0, 10).map((c) => ({
          action: c.action,
          scope: c.scope === 'user' ? ('user' as const) : c.scope === 'series' ? ('series' as const) : ('board' as const),
          ...(c.id ? { id: c.id } : {}),
          ...(c.type ? { type: c.type } : {}),
          ...(c.text ? { text: c.text } : {}),
          ...(c.why ? { why: c.why } : {}),
          ...(c.entity_id ? { entityId: c.entity_id } : {}),
          ...(c.requested_by_user ? { requestedByUser: true } : {}),
        }));
        const { done, refused } = await ctx.remember(ops);
        return {
          text: [...done, ...refused.map((reason) => t('没写入：{reason}', { reason }))].join('\n') || t('没有变化'),
          summary: done.length ? done.join(t('；')) : refused.length ? t('没写入：{reason}', { reason: refused[0] }) : t('没有变化'),
        };
      },
    }),

    tool<{
      changes: {
        action: EntityOp['action'];
        scope?: 'series' | 'board';
        id?: string;
        kind?: EntityOp['kind'];
        name?: string;
        summary?: string;
        refs?: { item_id?: string; asset_id?: string }[];
        requested_by_user?: boolean;
      }[];
    }>({
      name: 'remember_entity',
      label: msg('设定条目'),
      description:
        '把长期设定记成一个条目：人物、场景、道具或画风。条目只有名字和一句简介会进提示词，细节挂在条目下（用 remember 的 entity_id），需要时再读。' +
        'scope board（默认）只属于这块画布；人物、世界观、画风这类整个系列通用的设定用 scope series，系列里每块画布都能看到。' +
        '已经有同名的同类条目就用 update（id 见提示词里的设定条目）；用户改了主意就 update，不要新建。关联的画布节点或素材放 refs。' +
        '用户关掉了自动记忆时，只有用户明确要求才能写，把 requested_by_user 设为 true。不要记画布上已有的内容。',
      parameters: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['add', 'update', 'delete'] },
                scope: { type: 'string', enum: ['series', 'board'], description: 'series：整个系列共享（人物、世界观、画风）；默认 board：这块画布' },
                id: { type: 'string', description: 'update / delete 时：条目的 id' },
                kind: { type: 'string', enum: ['character', 'scene', 'prop', 'style'], description: '人物 / 场景 / 道具 / 画风' },
                name: { type: 'string', description: '名字，几个字' },
                summary: { type: 'string', description: '一句简介：一眼能认出它是什么' },
                refs: {
                  type: 'array',
                  maxItems: 20,
                  description: '关联的画布节点或素材（可选）',
                  items: {
                    type: 'object',
                    properties: {
                      item_id: { type: 'string', description: '画布节点 id' },
                      asset_id: { type: 'string', description: '素材库里的 id' },
                    },
                  },
                },
                requested_by_user: { type: 'boolean', description: '用户明确要求时设 true（可选）' },
              },
              required: ['action'],
            },
          },
        },
        required: ['changes'],
      },
      describe: (a) => t('{n} 个设定条目', { n: a.changes?.length ?? 0 }),
      async run(args, ctx) {
        if (!ctx.rememberEntity) throw new Error(t('这里不能写记忆'));
        const ops = (args.changes ?? []).slice(0, 10).map((c) => ({
          action: c.action,
          ...(c.scope ? { scope: c.scope } : {}),
          ...(c.id ? { id: c.id } : {}),
          ...(c.kind ? { kind: c.kind } : {}),
          ...(c.name ? { name: c.name } : {}),
          ...(c.summary ? { summary: c.summary } : {}),
          ...(c.refs
            ? {
                refs: c.refs
                  .map((r) => ({ ...(r.item_id ? { itemId: r.item_id } : {}), ...(r.asset_id ? { assetId: r.asset_id } : {}) }))
                  .filter((r) => r.itemId || r.assetId),
              }
            : {}),
          ...(c.requested_by_user ? { requestedByUser: true } : {}),
        }));
        const { done, refused } = await ctx.rememberEntity(ops);
        return {
          text: [...done, ...refused.map((reason) => t('没写入：{reason}', { reason }))].join('\n') || t('没有变化'),
          summary: done.length ? done.join(t('；')) : refused.length ? t('没写入：{reason}', { reason: refused[0] }) : t('没有变化'),
        };
      },
    }),

    tool<{
      query?: string;
      scope?: 'all' | 'series' | 'board' | 'user';
      entity_id?: string;
      include_history?: boolean;
      limit?: number;
    }>({
      name: 'search_memory',
      readOnly: true,
      label: msg('检索记忆'),
      description:
        '在记忆里找东西：按关键词、按挂在哪个设定条目下、按作用域。提示词里只有设定条目的索引，细节和挂在上面的事实要用这个工具或 read_memory 读。' +
        '不传 query 就列出最近的记忆；include_history=true 连已失效、已归档的也找。结果里有 id，可以接着 read_memory 看详情。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，空格分开多个（可选）' },
          scope: { type: 'string', enum: ['all', 'series', 'board', 'user'], description: '默认 all' },
          entity_id: { type: 'string', description: '只看挂在某个设定条目下的（可选）' },
          include_history: { type: 'boolean', description: '连历史一起找，默认 false' },
          limit: { type: 'number', description: '最多几条，默认 20' },
        },
      },
      describe: (a) => clip(a.query ?? ''),
      async run(args, ctx) {
        if (!ctx.searchMemory) throw new Error(t('这里不能读取记忆'));
        const kinds: Record<string, string> = { character: '人物', scene: '场景', prop: '道具', style: '风格' };
        const hits: MemoryHit[] = await ctx.searchMemory({
          ...(args.query?.trim() ? { text: args.query.trim() } : {}),
          scope: args.scope ?? 'all',
          ...(args.entity_id ? { entityId: args.entity_id } : {}),
          includeHistory: Boolean(args.include_history),
          limit: args.limit,
        });
        if (!hits.length) {
          return { text: '没有找到相关的记忆。试试更短的关键词，或把 include_history 设为 true。', summary: t('没有找到') };
        }
        const lines = hits.map((h) => {
          const what = h.kind === 'entity' ? (h.entityKind ? kinds[h.entityKind] : '设定条目') : '记忆';
          const when = new Date(h.at).toISOString().slice(5, 10);
          const where = h.scope === 'board' ? '画布' : h.scope === 'series' ? '系列' : '偏好';
          return `- [${h.id} · ${what} · ${where} · ${when}${h.active ? '' : ' · 已失效'}${h.pinned ? ' · 置顶' : ''}] ${h.text}${h.entityName ? `（挂在「${h.entityName}」下）` : ''}`;
        });
        return {
          text: `找到 ${hits.length} 条：\n${lines.join('\n')}\n详情用 read_memory <id> 读。`,
          summary: t('找到 {n} 条', { n: hits.length }),
        };
      },
    }),

    tool<{ id: string }>({
      name: 'read_memory',
      readOnly: true,
      label: msg('读取记忆'),
      description:
        '按 id 读一条记忆或设定条目的全文：内容、原因、来源、挂在哪个条目下、关联的节点，以及它替换过的旧条目。id 来自提示词里的「记忆」或 search_memory。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '记忆或设定条目的 id' } },
        required: ['id'],
      },
      describe: (a) => a.id ?? '',
      async run(args, ctx) {
        if (!ctx.readMemory) throw new Error(t('这里不能读取记忆'));
        const id = String(args.id ?? '').trim();
        const text = id ? await ctx.readMemory(id) : undefined;
        if (!text) throw new Error(t('没有 id 为 {id} 的记忆', { id }));
        return { text, summary: t('读取 {id}', { id }) };
      },
    }),

    tool<{ plan: string }>({
      name: 'present_plan',
      readOnly: true,
      label: msg('方案'),
      description:
        '计划模式下，把想好的完整方案交给用户确认：要做什么、分几步、每一步出什么（几张图、几段视频）、大概要多久、还有什么要用户定。用 Markdown 写，写具体，不写空话。' +
        '调用后告诉用户方案在等他确认，然后结束这一轮。用户点「按这个做」后计划模式关闭，你会收到通知再动手；用户不同意时会告诉你要改哪里。',
      parameters: {
        type: 'object',
        properties: { plan: { type: 'string', description: '方案全文（Markdown）' } },
        required: ['plan'],
      },
      describe: () => '',
      async run(args) {
        const plan = String(args.plan ?? '').trim().slice(0, 8000);
        if (!plan) throw new Error(t('方案是空的'));
        return {
          text: '方案已经放在面板上等用户确认。现在告诉用户方案在等他确认，然后结束这一轮。',
          summary: t('等待确认'),
          approval: { title: t('按这个方案做吗？'), detail: '', body: plan, payload: {}, confirm: t('按这个做'), reject: t('再改改') },
        };
      },
      approve: async () => ({ text: '用户确认了方案。', summary: t('已确认方案') }),
    }),
  ];
}

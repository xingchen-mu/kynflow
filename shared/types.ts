import type { Lang } from './i18n.ts';
// Types shared by the browser app and the backend.

export type MediaKind = 'image' | 'video' | 'audio' | 'model3d' | 'document';

export interface AssetInfo {
  id: string;
  url: string;
  kind: MediaKind;
  mime: string;
  /** Pixel size for images and videos; 0 for audio, 3D models and documents. */
  width: number;
  height: number;
  name?: string;
  /** Videos and audio: seconds, once the page has read it. */
  duration?: number;
  createdAt?: number;
  usage?: AssetUsage;
}

export interface AssetUsage {
  references: number;
  projects: { id: string; name: string }[];
  /** Name of a board item showing it (from the most recently edited board), e.g. a shot the assistant named. */
  name?: string;
}

export type ImageModel = 'zimage' | 'qwen';
export type VideoModel = 'minimax' | 'minimax-ref';
export type ImageQuality = '1k' | '2k';
export type VideoQuality = '480p' | '720p';

/** `aspect` is "W:H" (e.g. "16:9") or "auto" (follow the first input image). */
export type TaskRequest =
  | {
      op: 'image.generate';
      model: ImageModel;
      prompt: string;
      aspect: string;
      quality: ImageQuality;
      /** Reference images (asset ids). Only used by models that accept references. */
      images?: string[];
      seed?: number;
    }
  | { op: 'image.inpaint'; image: string; mask: string; prompt: string; seed?: number }
  | { op: 'image.erase'; image: string; mask: string; seed?: number }
  | {
      op: 'image.outpaint';
      image: string;
      /** Padding in source-image pixels. */
      left: number;
      top: number;
      right: number;
      bottom: number;
      prompt?: string;
      seed?: number;
    }
  | { op: 'image.removeBg'; image: string; seed?: number }
  | { op: 'image.upscale'; image: string; scale: number; seed?: number }
  | {
      op: 'video.generate';
      model: VideoModel;
      prompt: string;
      aspect: string;
      quality: VideoQuality;
      /** Seconds. */
      duration: number;
      /** minimax: [first frame?, last frame?]. minimax-ref: reference images. */
      images?: string[];
      seed?: number;
    }
  | {
      /** A workflow the user imported (see CustomWorkflow). */
      op: 'custom';
      workflow: string;
      prompt?: string;
      negative?: string;
      /** Asset ids for the workflow's image inputs, in order. */
      images?: string[];
      /** Asset ids for its video inputs, in order. */
      videos?: string[];
      mask?: string;
      /** Only used when the workflow exposes width/height. */
      aspect?: string;
      quality?: ImageQuality;
      /** Values for exposed parameters, by WorkflowInput.id. */
      params?: Record<string, string | number | boolean>;
      seed?: number;
    };

export type TaskOp = TaskRequest['op'];
export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface Task {
  id: string;
  request: TaskRequest;
  status: TaskStatus;
  promptId?: string;
  /** 0..1 */
  progress: number;
  stage?: string;
  /** 0 = running next. Only set while queued. */
  queuePosition?: number;
  expected: { kind: MediaKind; width: number; height: number };
  results: AssetInfo[];
  error?: string;
  seed: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface Capabilities {
  comfyOnline: boolean;
  comfyUrl: string;
  comfyVersion?: string;
  gpu?: string;
  /** key: capability id (e.g. "image.generate:zimage", "custom:<id>"), value: missing requirements (empty = available) */
  features: Record<string, string[]>;
  /** Model files picked for built-in tools, by slot (e.g. "qwen.unet"). */
  models: Record<string, string>;
  /** Built-in tools: missing model files that can be downloaded, by capability id. */
  downloads?: Record<string, ModelDownload[]>;
}

// ------------------------------------------------------------------ imported workflows

/** One node of a ComfyUI API-format prompt ("Export (API)"). */
export interface ComfyApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export type ComfyApiGraph = Record<string, ComfyApiNode>;

export type WorkflowInputType =
  | 'prompt'
  | 'negative'
  | 'image'
  | 'video'
  | 'mask'
  | 'seed'
  | 'width'
  | 'height'
  /** A ratio dropdown such as ResolutionSelector.aspect_ratio ("16:9 (Widescreen)"). */
  | 'aspect'
  | 'number'
  | 'text'
  | 'select'
  | 'boolean';

/** Binds a node field of the graph to something the canvas provides. */
export interface WorkflowInput {
  /** Unique within the workflow; params are sent under this key. */
  id: string;
  type: WorkflowInputType;
  node: string;
  field: string;
  label: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** Image/video inputs: may be left empty (the loader is then cut out of the graph). */
  optional?: boolean;
}

/** Coarse, machine-readable class of work a workflow does. */
export type WorkflowCapability =
  | 'text_to_image'
  | 'image_edit'
  | 'inpaint'
  | 'upscale'
  | 'remove_background'
  | 'text_to_video'
  | 'image_to_video'
  | 'video_edit'
  | 'text_to_audio'
  | 'text_to_3d'
  | 'text_to_document'
  | 'other';

/** How a capability description was obtained. 'degraded': derived without full node metadata. */
export type CapabilitySource = 'declared' | 'inferred' | 'degraded';

/** Author-provided relative GPU cost; absent means unknown. */
export type WorkflowCost = 'low' | 'medium' | 'high';

/** What a run of this workflow needs, in a form the selector can filter on. */
export interface WorkflowConstraints {
  /** At least one image slot is required. */
  requires_image: boolean;
  /** A mask slot exists (the run cannot be started without one). */
  requires_mask: boolean;
  /** Optional on old saved capabilities; readers fall back to the input mapping. */
  min_images?: number;
  min_videos?: number;
  max_images: number;
  max_videos: number;
  /** Width+height or an aspect dropdown can be driven by the request. */
  controls_aspect: boolean;
  /** A prompt slot exists with no default value. */
  requires_prompt: boolean;
  /** Node class types this server has no metadata for. Only enumerable when /object_info answered. */
  unverified_nodes?: string[];
}

export interface WorkflowCapabilityInfo {
  capability: WorkflowCapability;
  source: CapabilitySource;
  constraints: WorkflowConstraints;
  /** What the inference looked at, e.g. 'image_input', 'class:remove_background'. */
  evidence: string[];
  /** Optional author estimates; real history is supplied separately by the agent. */
  cost?: WorkflowCost;
  expected_seconds?: number;
}

export interface CustomWorkflow {
  id: string;
  name: string;
  description?: string;
  /** What the outputs are. */
  kind: MediaKind;
  graph: ComfyApiGraph;
  inputs: WorkflowInput[];
  /** Nodes whose saved files are the results. */
  outputs: string[];
  /** Absent on workflows imported before capabilities existed; filled in when read. */
  capability?: WorkflowCapabilityInfo;
  createdAt: number;
  updatedAt: number;
}

/** What the canvas needs to run a workflow (user-imported or preset); the graph stays on the server. */
export type WorkflowLike = Omit<CustomWorkflow, 'graph'>;

/** A field of the graph that could be exposed, with its ComfyUI spec when known. */
export interface WorkflowField {
  node: string;
  classType: string;
  title?: string;
  field: string;
  value: unknown;
  kind: 'number' | 'text' | 'select' | 'boolean';
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
}

/** Something the connected ComfyUI lacks for a workflow. */
export interface WorkflowIssue {
  /** 'auto': a missing file this server has under another name/precision; used automatically. */
  type: 'node' | 'file' | 'offline' | 'auto';
  message: string;
  node?: string;
  field?: string;
  value?: string;
  /** For missing files: what the server does have for that field. */
  options?: string[];
}

/** What the server worked out from an imported JSON, for the editor to review. */
export interface WorkflowDraft {
  workflow: Omit<CustomWorkflow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
  fields: WorkflowField[];
  /** Nodes that can produce result files. */
  outputCandidates: { node: string; classType: string; title?: string }[];
  /** Output kinds the graph could produce; the editor asks the author to pick one when there are several. */
  kindCandidates?: MediaKind[];
  issues: WorkflowIssue[];
}

export interface ModelDownload {
  name: string;
  url: string;
  /** ComfyUI models subfolder, e.g. "diffusion_models". */
  directory: string;
}

/**
 * Where model downloads come from. Hugging Face links are fetched from the chosen endpoint;
 * 'auto' tries Hugging Face and hf-mirror.com in turn and remembers the one that answered.
 */
export type ModelSource = 'auto' | 'huggingface' | 'hf-mirror' | 'custom';

/**
 * How downloaded files reach ComfyUI's models folders: written directly (ComfyUI is on this machine),
 * fetched by the ComfyUI server itself over SSH (SSH_HOST), or by the user with the commands shown.
 */
export type ModelInstallMode = 'local' | 'ssh' | 'manual' | 'offline';

export interface ModelDownloadJob {
  id: string;
  name: string;
  directory: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  received: number;
  total?: number;
  /** Bytes per second while running. */
  speed?: number;
  /** Full path of the file on the ComfyUI machine. */
  path?: string;
  /** Host the file came from, e.g. "hf-mirror.com". */
  source?: string;
  /** The file was already there. */
  existed?: boolean;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface ModelInstallInfo {
  mode: ModelInstallMode;
  /** SSH host alias, in 'ssh' mode. */
  host?: string;
  /** Why files cannot be installed automatically ('manual' / 'offline'). */
  reason?: string;
  source: ModelSource;
  /** Endpoint for 'custom' (e.g. an in-house mirror). */
  endpoint?: string;
  hfTokenConfigured: boolean;
  jobs: ModelDownloadJob[];
}

/** What a download would do, shown before it starts. */
export interface ModelInstallPlan {
  mode: ModelInstallMode;
  host?: string;
  reason?: string;
  files: {
    name: string;
    directory: string;
    /** Target path on the ComfyUI machine (relative to the ComfyUI folder when unknown). */
    path: string;
    url: string;
    size?: number;
    exists?: boolean;
    /** Why this file could not be checked or cannot be downloaded. */
    error?: string;
  }[];
  /** Free space where the files go, when known. */
  free?: number;
  /** Shell commands that download the files by hand. */
  commands: string;
}

/** An official ComfyUI template packaged as a ready-made tool (presets/*.json). */
export interface PresetInfo extends Omit<CustomWorkflow, 'graph'> {
  preset: true;
  template: string;
  category: string;
  usage: number;
  /** Thumbnail file name in ComfyUI's template folder. */
  thumb?: string;
  models: ModelDownload[];
  /** What the connected ComfyUI lacks (all empty = ready). `notes`: other blockers, e.g. fp8 support. */
  missing: { nodes: string[]; models: ModelDownload[]; notes: string[] };
}

/**
 * What the assistant asks before doing: `risky`, only costly or destructive work (video batches, deleting);
 * `prompts`, also every generation, showing its prompts to read and edit first; `always`, every write.
 */
export type ApprovalMode = 'risky' | 'prompts' | 'always';
export const APPROVAL_MODES: ApprovalMode[] = ['risky', 'prompts', 'always'];

export interface Settings {
  comfyUrl: string;
  /** Only models whose license allows commercial use (see shared/licenses.ts); the rest are switched off. */
  commercialOnly?: boolean;
  /** Interface language of the page that last opened Kynflow: the server's messages and the assistant follow it. */
  language?: Lang;
  /** Canvas assistant model settings. The API key itself is never returned. */
  agentModel?: string;
  agentBaseUrl?: string;
  agentThinking?: string;
  /** For an OpenAI-compatible endpoint (agentBaseUrl): the model's context length in tokens (128000 when unset). */
  agentContextWindow?: number;
  /** For an OpenAI-compatible endpoint: the model reasons, so agentThinking is sent to it. */
  agentReasoning?: boolean;
  /** What the assistant asks the user before doing (see ApprovalMode). */
  agentApprovalMode?: ApprovalMode;
  /** OpenAI-compatible embeddings model used to find memory by meaning; empty means keywords only. */
  agentEmbeddingModel?: string;
  /** Embeddings endpoint when it differs from agentBaseUrl. */
  agentEmbeddingBaseUrl?: string;
  agentApiKeyConfigured?: boolean;
  /** Where model downloads come from (see ModelSource). */
  modelSource?: ModelSource;
  /** Hugging Face compatible endpoint for modelSource 'custom'. */
  modelEndpoint?: string;
  /** A Hugging Face token is saved (for gated models). The token itself is never returned. */
  hfTokenConfigured?: boolean;
}

/** Text items hold notes such as a script or a shot list. */
export type ItemKind = MediaKind | 'text' | 'prompt';

/** One line of dialogue in a clip, kept on the cut list so the film can be re-cut. */
export interface CutLine {
  text: string;
  /** Seconds into the clip; omitted means "follow where the sound stands out". */
  from?: number;
  to?: number;
}

/**
 * One clip of a final cut: which board item it came from, how it was trimmed, and what was said.
 * Stored on the final-cut item so the same edit can be re-run (recompose) without the assistant.
 */
export interface CutListEntry {
  id: string;
  /** Seconds into the clip; omitted means the whole clip. */
  start?: number;
  end?: number;
  lines?: CutLine[];
}

/** Why a checked result fell short, in classes the assistant can act on. */
export type ReviewReason = 'subject_mismatch' | 'composition' | 'subject_too_small' | 'clipping' | 'action_missing' | 'text_wrong' | 'other';

/** The assistant's verdict on a result, kept on the item so later turns (and the user) can see it. */
export interface ItemReview {
  verdict: 'pass' | 'fail';
  /** Only for 'fail'. */
  reason?: ReviewReason;
  /** One line on what is wrong, kept short. */
  note?: string;
  at: number;
}

export interface CanvasItem {
  id: string;
  kind: ItemKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Set once the media exists. */
  asset?: AssetInfo;
  /** Set while the item is a placeholder waiting for a task. */
  taskId?: string;
  /** Index into task.results this placeholder will show. */
  resultIndex?: number;
  /** The request that produced (or will produce) this item; used for retry and info. */
  request?: TaskRequest;
  /** Board items this one was made from, in request order (drawn as connection lines). */
  inputs?: string[];
  /** Older name for inputs[0]; kept so earlier boards still show their links. */
  sourceId?: string;
  /** Prompt node connected by hand: its text is this item's prompt (drawn as a line). */
  promptId?: string;
  error?: string;
  name?: string;
  /** Text notes (light Markdown) and prompt nodes (plain text); `name` is the title. */
  text?: string;
  /** Image type the assistant filed it under (e.g. 全身照, 关键帧): one column per type on the board. */
  group?: string;
  /** The assistant's check of the result; kept so later turns see what was wrong. */
  review?: ItemReview;
  /** Independent visual assessment, separate from the orchestrator's review. */
  critic?: VisualCritique;
  /** The item this one was made to replace (a retried result); bounds how many retries a result gets. */
  retryOf?: string;
  /**
   * Only on final-cut items: the clips used, their trim ranges and dialogue lines.
   * Lets the user recompose the film (re-run the same edit) or redo one shot without re-editing by hand.
   */
  cutList?: CutListEntry[];
  createdAt: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Project {
  id: string;
  name: string;
  items: CanvasItem[];
  viewport: Viewport;
  createdAt: number;
  updatedAt: number;
  /** The series it belongs to: member boards share series memory. */
  seriesId?: string;
}

/** A series: boards that tell one story share settings and entities. */
export interface Series {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  itemCount: number;
  cover?: string;
  seriesId?: string;
}

export interface ProjectSnapshotSummary {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  itemCount: number;
}

// ------------------------------------------------------------------ canvas agent

/** One row of the agent panel's conversation. */
export type AgentEntry =
  | {
      kind: 'user';
      id: string;
      text: string;
      /** Board items selected when the message was sent. */
      selection?: string[];
      /** Board and conversation can go back to just before this message. */
      rewind?: boolean;
      at: number;
    }
  | { kind: 'assistant'; id: string; text: string; error?: string; at: number }
  /** Something that happened on its own, e.g. a batch of tasks finished and woke the agent. */
  /** `detail`: more to read when unfolded (the summary of a condensed conversation). */
  | { kind: 'event'; id: string; text: string; detail?: string; at: number }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      label: string;
      /** `waiting`: held until the user approves it in the panel (`approval`). */
      status: 'running' | 'done' | 'error' | 'waiting';
      /** `frames`: first frames of the work held (video batches), shown on the card; `since`: when it was made. */
      /**
       * `confirm` / `reject`: the buttons' labels, when not 开始 / 不要; `body`: Markdown shown on the card (a plan);
       * `prompts`: what the work would generate from, for the user to read and edit before it is submitted.
       */
      approval?: { title: string; detail: string; frames?: string[]; since?: number; confirm?: string; reject?: string; body?: string; prompts?: AgentPrompt[] };
      /** A question with options for the user to pick (status `waiting` until answered). */
      question?: AgentQuestion;
      /** One line on what the call is doing or did (or its error). */
      summary: string;
      /** Board items it made or looked at. */
      items?: string[];
      at: number;
    };

/** A prompt shown before it is generated from: `label` names the job (a shot), `refs` are its input items. */
export interface AgentPrompt {
  label: string;
  text: string;
  refs?: string[];
}

/** A step of the assistant's to-do list for a long task. */
export interface AgentTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** What the assistant asked, with options to click; `skipped`: the user wrote something else instead. */
export interface AgentQuestion {
  text: string;
  options: { label: string; description?: string }[];
  /** More than one option may be picked. */
  multiple?: boolean;
  state: 'pending' | 'answered' | 'skipped';
  answer?: string;
}

/** How full the context was at the last request, against the size at which it is condensed. */
export interface AgentContext {
  used: number;
  limit: number;
}

/** `series`: every board of the series (shared settings); `board`: this board only; `user`: every board (the user's own preferences). */
export type MemoryScope = 'series' | 'board' | 'user';
/** setting: characters, style, world; decision: what was settled (and turned down, with why); preference; feedback: a correction. */
export type MemoryType = 'setting' | 'decision' | 'preference' | 'feedback';

/** Characters of all entries of a scope together: memory stays a small part of every request. */
export const MEMORY_LIMIT: Record<MemoryScope, number> = { series: 1500, board: 2000, user: 1000 };
/** Characters of one entry, its reason included. */
export const ENTRY_CHARS = 300;
export const MEMORY_TYPES: Record<MemoryScope, MemoryType[]> = {
  series: ['setting', 'decision', 'preference'],
  board: ['setting', 'decision', 'preference'],
  user: ['preference', 'feedback'],
};

/** The kinds of lasting things a board has: a character, a place, an object, a look. */
export type MemoryEntityKind = 'character' | 'scene' | 'prop' | 'style';
export const ENTITY_KINDS: MemoryEntityKind[] = ['character', 'scene', 'prop', 'style'];
/** Characters of an entity's name and summary; the summary is shown in the prompt index, cut if longer. */
export const ENTITY_NAME_CHARS = 40;
export const ENTITY_SUMMARY_CHARS = 240;
/** Active entities on a board; older unpinned ones are archived when a new one would exceed this. */
export const MAX_ENTITIES = 30;

/** What an entity points at: a board item and/or an asset in the library. */
export interface MemoryRef {
  itemId?: string;
  assetId?: string;
}

/**
 * A named thing the board keeps coming back to. Facts about it hang off it (MemoryEntry.entityId), so the
 * prompt only carries an index and the details are read when needed.
 */
export interface MemoryEntity {
  id: string;
  kind: MemoryEntityKind;
  name: string;
  summary: string;
  refs: MemoryRef[];
  at: number;
  by: 'assistant' | 'user';
  /** Survives automatic cleanup when there are too many entities. */
  pinned?: boolean;
  /** Kept for the record but not sent to the model. */
  archived?: boolean;
  source?: MemorySource;
  /** When the assistant last read it; a small hint in retrieval. */
  lastUsedAt?: number;
  /** How often the assistant read it. */
  useCount?: number;
}

/** Where a memory entry came from, so the user can tell what it is based on. */
export interface MemorySource {
  kind: 'chat' | 'review' | 'condense' | 'user';
  /** The panel row or board item it was derived from, when known. */
  entryId?: string;
  itemId?: string;
}

/**
 * One thing the assistant remembers across conversations. Entries are append-only: an update marks the old
 * entry invalid and adds a new one, so what was believed earlier stays visible in the history.
 */
export interface MemoryEntry {
  id: string;
  type: MemoryType;
  text: string;
  /** Why it holds, when that matters (a turned-down option's reason, the occasion of a correction). */
  why?: string;
  /** When the assistant or user recorded it. */
  at: number;
  /** When the fact became true in the work, when that differs from when it was recorded. */
  validAt?: number;
  /** When the fact stopped being true. Inactive entries stay in the file, out of the prompt. */
  invalidAt?: number;
  /** The entry that replaced this one after an update. */
  supersededBy?: string;
  /** Kept for the record but not sent to the model. */
  archived?: boolean;
  /** Survives automatic cleanup when the scope is full. */
  pinned?: boolean;
  /** The entity this fact is about; such facts are read on demand rather than kept in the prompt. */
  entityId?: string;
  source?: MemorySource;
  /** How sure the writer was, 0..1: a summary says less than the user's own edit. */
  confidence?: number;
  /** When the assistant last read it; a small hint in retrieval. */
  lastUsedAt?: number;
  /** How often the assistant read it. */
  useCount?: number;
  /** Written by the assistant (while working or condensing) or by the user in the memory page. */
  by: 'assistant' | 'user';
}

/** One scope's memory; `auto`: the assistant may write to it on its own. */
export interface AgentMemory {
  auto: boolean;
  entries: MemoryEntry[];
  /** Series and board scopes: named things facts can hang off. Empty for the user scope. */
  entities: MemoryEntity[];
}

/** What is stored on disk, versioned so later migrations can tell formats apart. */
export interface AgentMemoryFile extends AgentMemory {
  version: number;
}

/** An entry that is in effect: not archived, and not replaced by a newer one. */
export const isActiveMemory = (e: MemoryEntry) => !e.archived && !e.invalidAt;
/** An entity that is in effect and part of the prompt's index. */
export const isActiveEntity = (e: MemoryEntity) => !e.archived;

/**
 * How much two pieces of text say the same thing, 0..1: character bigrams after NFKC, case, whitespace and
 * punctuation are removed. One-character texts compare as equal or nothing.
 */
export function memorySimilarity(a: string, b: string): number {
  const clean = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const x = clean(a);
  const y = clean(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => {
    const set = new Set<string>();
    if (s.length === 1) set.add(s);
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(x);
  const gb = grams(y);
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return (2 * shared) / (ga.size + gb.size);
}

/**
 * Something several boards of a series remember separately: promoting it to series memory makes every
 * board of the series use it.
 */
export interface MemoryPromotion {
  text: string;
  type: MemoryType;
  why?: string;
  /** The boards it was found on. */
  boards: { id: string; name: string }[];
  at: number;
}

export interface AgentMemories {
  /** Shared by every board of the series; empty when the board belongs to none. */
  series: AgentMemory;
  board: AgentMemory;
  user: AgentMemory;
  /** Set when the board belongs to a series: its name and member boards. */
  seriesInfo?: SeriesInfo;
}

/** The series a board is in, as the memory page shows it. */
export interface SeriesInfo {
  id: string;
  name: string;
  /** Member boards, this one included. */
  projects: { id: string; name: string }[];
}

/** A saved prompt the user runs as /name in the assistant's input. */
export interface AgentCommand {
  name: string;
  prompt: string;
}

/** An outside assistant (CLI or editor) that can drive the board over MCP. */
export interface AgentExtension {
  id: string;
  /** The executable looked up on PATH to tell whether it is installed. */
  bin: string;
  installed: boolean;
  /** Its MCP config already mentions kynflow. */
  mcpConfigured: boolean;
  /** Where that config lives, e.g. "~/.claude.json". */
  configPath: string;
  /** How to install it, empty when the client is an app rather than a CLI. */
  install: string;
  /** One command or a JSON snippet that connects it to this server. */
  connect: string;
  connectKind: 'command' | 'json';
}

export interface AgentStatus {
  /** False until a model is usable (e.g. its API key is missing); `reason` says what to do. */
  ready: boolean;
  /** "provider/model", e.g. "deepseek/deepseek-flash". */
  model: string;
  /** The model can look at images. */
  vision: boolean;
  reason?: string;
}

/** Tokens and estimated cost of a board's conversation so far (from the provider's catalog prices). */
export interface AgentUsage {
  tokens: number;
  cost: number;
}

export interface AgentView {
  entries: AgentEntry[];
  running: boolean;
  usage: AgentUsage;
  todos: AgentTodo[];
  /** Plan mode: the assistant only reads and proposes until the user accepts its plan. */
  plan: boolean;
  /** Unknown until the first request (and right after condensing). */
  context: AgentContext | null;
  /** The conversation the panel is showing. */
  sessionId: string;
  taskGraph?: AgentTaskGraph;
}

/** One past conversation of a board, as the history list shows it. */
export interface AgentSessionInfo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** The board's conversations: which one is open and the ones kept in history, newest first. */
export interface AgentSessionList {
  current: string;
  sessions: AgentSessionInfo[];
}

/** Sent over /api/events as `agent`. */
export interface AgentEventData {
  projectId: string;
  /** Added or changed (matched by id). */
  entry?: AgentEntry;
  running?: boolean;
  usage?: AgentUsage;
  todos?: AgentTodo[];
  taskGraph?: AgentTaskGraph;
  plan?: boolean;
  context?: AgentContext | null;
  /** The conversation was cleared or another one was opened. */
  reset?: boolean;
  /** With `reset`: the conversation now open. */
  sessionId?: string;
}

/** Execution dependencies; unrelated to canvas links or ComfyUI nodes. */
export type AgentTaskStatus = 'pending' | 'ready' | 'running' | 'reviewing' | 'completed' | 'failed' | 'blocked';
export type VisualDimension = 'instruction' | 'identity' | 'composition' | 'spatial' | 'style' | 'quality' | 'temporal' | 'text';
export interface AgentAcceptanceCriterion {
  id: string;
  description: string;
  /** A visual hard constraint must be checked by the independent critic. */
  dimension?: VisualDimension;
  threshold?: number;
  /** Whole-media temporal claims cannot be accepted from sparse sampled frames. */
  scope?: 'whole_media' | 'sampled_frames';
}
export interface AgentTask {
  id: string;
  objective: string;
  dependencies: string[];
  /** Canvas item ids, scoped to this board. */
  inputs: string[];
  outputs: string[];
  /** Invalidated outputs remain discoverable for retry_of and recovery. */
  previousOutputs?: string[];
  acceptanceCriteria: AgentAcceptanceCriterion[];
  evidence: { criterionId: string; note: string }[];
  status: AgentTaskStatus;
  attempts: number;
  maxAttempts: number;
  error?: string;
}
export interface AgentTaskGraph {
  version: 1;
  revision: number;
  objective: string;
  tasks: AgentTask[];
}
export interface VisualCritique {
  verdict: 'pass' | 'fail';
  scores: Partial<Record<VisualDimension, { score: number; evidence: string }>>;
  thresholds: Partial<Record<VisualDimension, number>>;
  reason?: ReviewReason;
  diagnosis: string;
  repair: string;
  /** References and criteria make an assessment's scope explicit. */
  referenceIds: string[];
  assetId?: string;
  referenceAssets?: Record<string, string>;
  objective: string;
  model: string;
  at: number;
  assessmentVersion?: 'criteria-v2';
  coverage?: 'image' | 'sampled_video';
  checks?: VisualCriterionCheck[];
  defects?: VisualDefect[];
  repairPlan?: VisualRepairStep[];
}
export interface VisualCriterion {
  id: string;
  dimension: VisualDimension;
  description: string;
  threshold: number;
  scope?: 'whole_media' | 'sampled_frames';
}
export interface VisualCriterionCheck extends VisualCriterion {
  score: number;
  evidence: string;
  visibility: 'observed' | 'uncertain' | 'unobservable';
  verdict: 'pass' | 'fail';
}
export type VisualDefectCategory = 'identity_drift' | 'layout_mismatch' | 'spatial_conflict' | 'subject_scale' | 'object_clipping' | 'action_missing' | 'text_error' | 'style_drift' | 'color_mismatch' | 'render_artifact' | 'temporal_discontinuity' | 'insufficient_evidence' | 'instruction_mismatch';
export interface VisualDefect {
  criterionId: string;
  category: VisualDefectCategory;
  evidence: string;
  /** Normalized location in the target image; omitted when not localizable. */
  region?: { x: number; y: number; w: number; h: number };
}
export interface VisualRepairStep {
  category: VisualDefectCategory;
  action: 'reference_edit' | 'layout_guide' | 'crop_reference' | 'prompt_revision' | 'localized_edit' | 'inspect_more';
  capability?: 'image_edit' | 'inpaint';
  requiresReference: boolean;
  instruction: string;
  preserve: string[];
  verify: string[];
  /** Suggestions never submit work or authorize an unbounded retry loop. */
  seedOnlyAllowed: false;
}
export interface AgentSkillInfo {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'user';
  tools: string[];
}
export interface AgentExperience {
  id: string;
  projectId: string;
  sessionId: string;
  task: string;
  workflowId?: string;
  failure?: ReviewReason;
  strategy: string;
  outcome: 'success' | 'failure';
  /** Only a human-facing API can promote this to user confirmation. */
  confirmation: 'agent' | 'user';
  itemIds: string[];
  at: number;
}
export interface AgentTraceEvent {
  id: string;
  runId: string;
  at: number;
  type: 'run_start' | 'run_end' | 'tool_start' | 'tool_end' | 'model' | 'recovery' | 'generation_queued' | 'generation_end' | 'approval' | 'context';
  tool?: string;
  callId?: string;
  ok?: boolean;
  durationMs?: number;
  tokens?: number;
  cost?: number;
  items?: string[];
  taskIds?: string[];
  taskId?: string;
  gpuMs?: number;
  retry?: boolean;
  arguments?: TraceValue;
  result?: TraceValue;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  error?: { category: string; message: string };
  response?: string;
}

export type TraceValue = null | boolean | number | string | TraceValue[] | { [key: string]: TraceValue };
export type AgentHarnessProfile = 'baseline' | 'enhanced';
export interface AgentTraceFeedback {
  verdict: 'accepted' | 'rejected' | 'mixed';
  comment: string;
  assetIds: string[];
  at: number;
  source: 'user';
}
/** Observable execution evidence; never includes model thinking blocks or image payloads. */
export interface AgentRunTrace {
  version: 1;
  runId: string;
  sessionId: string;
  projectId: string;
  parentRunId?: string;
  userIntent: string;
  model: string;
  promptVersion: string;
  profile: AgentHarnessProfile;
  enhancement?: 'legacy' | 'targeted';
  source: 'user' | 'event';
  generationEnvironment: 'comfyui' | 'mock';
  startedAt: number;
  finishedAt?: number;
  execution: 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted';
  events: AgentTraceEvent[];
  droppedEvents: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    paidTokens: number;
    cost: number;
    gpuSeconds: number;
    toolCalls: number;
    modelCalls: number;
    generations: number;
    retries: number;
    toolErrors: number;
    userInterventions: number;
  };
  outputs: string[];
  outcome: {
    status: 'success' | 'failed' | 'partial';
    basis: 'unconfirmed' | 'execution' | 'user';
    response?: string;
    agentReview: { itemId: string; verdict: 'pass' | 'fail'; reason?: string }[];
    userFeedback?: AgentTraceFeedback;
  };
  feedbackHistory: AgentTraceFeedback[];
}

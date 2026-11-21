// Stand-in for the local server used by the static demo build (`npm run build:demo`).
// Boards, assets and task progress come from demo/board.json, demo/meta.json and preloaded media:
// nothing is generated, nothing connects to ComfyUI, and the page says so.
import type {
  AgentMemories,
  AgentSessionList,
  AgentStatus,
  AgentView,
  AssetInfo,
  Capabilities,
  CanvasItem,
  CustomWorkflow,
  ModelDownloadJob,
  ModelInstallInfo,
  PresetInfo,
  Project,
  ProjectSummary,
  Series,
  Settings,
  Task,
  TaskRequest,
  WorkflowDraft,
} from '../../shared/types';
import type { EventHandlers } from './api';
import { t } from '../i18n';

// Vite fills these in; under node:test there is no import.meta.env at all.
const env = (import.meta as { env?: Record<string, string | undefined> }).env;

export const isDemo = env?.VITE_DEMO === '1';

export interface DemoMeta {
  title: string;
  summary: string;
  notice: string;
  demo: { prompt: string; reference?: string; image: string; video: string; request?: TaskRequest };
  images: string[];
  licenses: string[];
}

const base = env?.BASE_URL ?? '/';

/** Fixture paths are stored relative to the build root; the site may not be served from "/". */
const url = (path: string) => `${base}${path.replace(/^\/+/, '')}`;

let fixture: Promise<{ board: Project; meta: DemoMeta }> | undefined;

function load() {
  fixture ??= (async () => {
    const [board, meta] = await Promise.all([
      fetch(url('demo/board.json')).then((r) => r.json() as Promise<Project>),
      fetch(url('demo/meta.json')).then((r) => r.json() as Promise<DemoMeta>),
    ]);
    for (const item of board.items) if (item.asset) item.asset = { ...item.asset, url: url(item.asset.url) };
    meta.images = meta.images.map(url);
    meta.demo.image = meta.demo.image ? url(meta.demo.image) : '';
    meta.demo.video = meta.demo.video ? url(meta.demo.video) : '';
    return { board, meta };
  })();
  return fixture;
}

/** The preloaded work shown in the demo, once the fixture is on the page. */
export async function demoMeta(): Promise<DemoMeta> {
  return (await load()).meta;
}

const projects = new Map<string, Project>();
const demoSeries: Series[] = [];
let created = 0;
let loaded = false;

async function seed() {
  if (loaded) return;
  loaded = true;
  const { board } = await load();
  projects.set(board.id, structuredClone(board));
}

const tasks = new Map<string, Task>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let handlers: EventHandlers | null = null;

/** A finished task's output: the fixture's own image or video, labelled as preloaded. */
async function result(kind: 'image' | 'video'): Promise<AssetInfo> {
  const { meta } = await load();
  if (kind === 'video') return { id: 'demo-video', url: meta.demo.video, kind, mime: 'video/mp4', width: 736, height: 576, name: t('演示视频'), createdAt: Date.now() };
  return { id: 'demo-image', url: meta.demo.image, kind, mime: 'image/webp', width: 1184, height: 896, name: t('演示结果'), createdAt: Date.now() };
}

function emit(task: Task) {
  tasks.set(task.id, task);
  handlers?.onTask(structuredClone(task));
}

function later(ms: number, fn: () => void) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
}

function isVideo(request: TaskRequest) {
  return request.op === 'video.generate';
}

const emptyView = (): AgentView => ({
  entries: [],
  running: false,
  usage: { tokens: 0, cost: 0 },
  todos: [],
  plan: false,
  context: null,
  sessionId: 'demo',
});

const offline = () => new Error(t('演示模式不连接本地服务：请在自己的机器上运行完整版'));

export const demoApi = {
  async capabilities(): Promise<Capabilities> {
    await seed();
    return { comfyOnline: false, comfyUrl: '', features: {}, models: {} };
  },

  async uploadAsset(): Promise<AssetInfo> {
    throw new Error(t('演示模式不支持上传文件'));
  },
  async assets(): Promise<AssetInfo[]> {
    const { board } = await load();
    return board.items.map((i) => i.asset).filter((a): a is AssetInfo => Boolean(a)).map((a) => ({ ...a, usage: { references: 0, projects: [] } }));
  },
  async setAssetSize(): Promise<{ ok: true }> {
    return { ok: true };
  },
  async deleteAsset(): Promise<{ ok: true }> {
    throw offline();
  },

  async createTask(request: TaskRequest, id?: string): Promise<Task> {
    await seed();
    const kind = isVideo(request) ? 'video' : 'image';
    const task: Task = {
      id: id ?? `demo-task-${Date.now()}`,
      request,
      status: 'queued',
      progress: 0,
      queuePosition: 1,
      expected: kind === 'video' ? { kind, width: 736, height: 576 } : { kind, width: 1184, height: 896 },
      results: [],
      seed: 1,
      createdAt: Date.now(),
    };
    emit(task);
    later(600, () => emit({ ...task, status: 'running', stage: t('采样中'), progress: 0.3, queuePosition: undefined, startedAt: Date.now() }));
    later(1400, () => emit({ ...task, status: 'running', stage: t('采样中'), progress: 0.7, queuePosition: undefined, startedAt: Date.now() }));
    later(2400, () => {
      void result(kind).then((asset) => emit({ ...task, status: 'done', stage: undefined, progress: 1, queuePosition: undefined, startedAt: Date.now() - 2400, finishedAt: Date.now(), results: [asset] }));
    });
    return structuredClone(task);
  },
  async cancelTask(id: string): Promise<Task> {
    const task = tasks.get(id);
    if (!task) throw new Error(t('任务不存在'));
    const cancelled: Task = { ...task, status: 'cancelled', finishedAt: Date.now() };
    emit(cancelled);
    return cancelled;
  },
  async tasks(ids: string[]): Promise<Task[]> {
    return ids.map((id) => tasks.get(id)).filter((t): t is Task => Boolean(t));
  },
  async taskHistory(): Promise<Task[]> {
    return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  },

  async projects(): Promise<ProjectSummary[]> {
    await seed();
    return [...projects.values()].map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, itemCount: p.items.length, cover: p.items.find((i) => i.asset)?.asset?.url }));
  },
  async createProject(name?: string, seriesId?: string): Promise<Project> {
    await seed();
    const project: Project = {
      id: `demo-${++created}`,
      name: name ?? t('新的画布'),
      items: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(seriesId ? { seriesId } : {}),
    };
    projects.set(project.id, project);
    return structuredClone(project);
  },
  async project(id: string): Promise<Project> {
    await seed();
    const project = projects.get(id);
    if (!project) throw new Error(t('画布不存在'));
    return structuredClone(project);
  },
  async saveProject(id: string, patch: Partial<Pick<Project, 'name' | 'items' | 'viewport' | 'seriesId'>>): Promise<{ updatedAt: number }> {
    const project = projects.get(id);
    if (!project) throw new Error(t('画布不存在'));
    Object.assign(project, patch, { updatedAt: Date.now() });
    return { updatedAt: project.updatedAt };
  },
  async setProjectSeries(id: string, seriesId: string | null): Promise<{ seriesId: string | null }> {
    const project = projects.get(id);
    if (!project) throw new Error(t('画布不存在'));
    if (seriesId) project.seriesId = seriesId;
    else delete project.seriesId;
    project.updatedAt = Date.now();
    return { seriesId };
  },
  async series(): Promise<Series[]> {
    return [...demoSeries];
  },
  async createSeries(name?: string): Promise<Series> {
    const now = Date.now();
    const series: Series = { id: `demo-series-${demoSeries.length + 1}`, name: name ?? t('未命名系列'), createdAt: now, updatedAt: now };
    demoSeries.push(series);
    return series;
  },
  async deleteProject(id: string): Promise<{ ok: true }> {
    projects.delete(id);
    return { ok: true };
  },
  async projectSnapshots() {
    return [];
  },
  async createSnapshot(): Promise<never> {
    throw offline();
  },
  async restoreSnapshot(): Promise<never> {
    throw offline();
  },
  async branchProject(): Promise<never> {
    throw offline();
  },

  async settings(): Promise<Settings> {
    return { comfyUrl: '', commercialOnly: false };
  },
  async saveSettings(): Promise<{ settings: Settings; capabilities: Capabilities }> {
    return { settings: { comfyUrl: '' }, capabilities: await demoApi.capabilities() };
  },
  async testComfy(): Promise<never> {
    throw offline();
  },

  async workflows(): Promise<CustomWorkflow[]> {
    return [];
  },
  async presets(): Promise<PresetInfo[]> {
    return [];
  },
  async preset(): Promise<never> {
    throw offline();
  },
  async draftWorkflow(): Promise<WorkflowDraft> {
    throw offline();
  },
  async workflowDraft(): Promise<WorkflowDraft> {
    throw offline();
  },
  async createWorkflow(): Promise<never> {
    throw offline();
  },
  async updateWorkflow(): Promise<never> {
    throw offline();
  },
  async deleteWorkflow(): Promise<never> {
    throw offline();
  },

  async agentStatus(): Promise<AgentStatus> {
    return { ready: false, model: '', vision: false, reason: t('演示模式不接入模型；完整版可以连接任意 OpenAI 兼容接口') };
  },
  async agent(): Promise<AgentView> {
    return emptyView();
  },
  async sendAgent(): Promise<never> {
    throw offline();
  },
  async abortAgent(): Promise<{ ok: true }> {
    return { ok: true };
  },
  async clearAgent(): Promise<{ ok: true }> {
    return { ok: true };
  },
  async agentSessions(): Promise<AgentSessionList> {
    return { current: 'demo', sessions: [] };
  },
  async newAgentSession(): Promise<AgentSessionList> {
    return { current: 'demo', sessions: [] };
  },
  async openAgentSession(): Promise<AgentSessionList> {
    return { current: 'demo', sessions: [] };
  },
  async renameAgentSession(): Promise<AgentSessionList> {
    return { current: 'demo', sessions: [] };
  },
  async deleteAgentSession(): Promise<AgentSessionList> {
    return { current: 'demo', sessions: [] };
  },
  async condenseAgent(): Promise<never> {
    throw offline();
  },
  async answerAgent(): Promise<never> {
    throw offline();
  },
  async setAgentPlan(): Promise<{ ok: true }> {
    return { ok: true };
  },
  async rewindAgent(): Promise<never> {
    throw offline();
  },
  async agentCommands() {
    return [];
  },
  async agentMemory(): Promise<AgentMemories> {
    const empty = () => ({ auto: true, entries: [], entities: [] });
    return { series: empty(), board: empty(), user: empty() };
  },
  async saveAgentMemory() {
    return { auto: true, entries: [], entities: [] };
  },
  async memoryPromotions() {
    return [];
  },
  async saveAgentCommands() {
    return [];
  },
  async presence(): Promise<{ ok: true }> {
    return { ok: true };
  },
  async approveAgent(): Promise<{ ok: true }> {
    return { ok: true };
  },

  async modelInstall(): Promise<ModelInstallInfo> {
    return { mode: 'offline', reason: t('演示模式不连接本地服务：请在自己的机器上运行完整版'), source: 'huggingface', hfTokenConfigured: false, jobs: [] };
  },
  async modelDownloads(): Promise<ModelDownloadJob[]> {
    return [];
  },
  async planModels(): Promise<never> {
    throw offline();
  },
  async downloadModels(): Promise<never> {
    throw offline();
  },
  async cancelDownload(): Promise<never> {
    throw offline();
  },
};

/** No event stream in the demo: hand the page the fixture and let it settle. */
export function demoSubscribeEvents(h: EventHandlers) {
  handlers = h;
  void seed().then(() => {
    h.onConnection(true);
    h.onHello({ comfyOnline: false, active: [] });
  });
  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    handlers = null;
  };
}

/** The item a first-time visitor should see: the finished video of the fixture board. */
export function demoHeroId(items: CanvasItem[]): string | undefined {
  return items.find((i) => i.kind === 'video')?.id ?? items.find((i) => i.asset)?.id;
}

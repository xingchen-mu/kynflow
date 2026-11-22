import { ArrowUp, Bell, Box, Bot, Brain, ChevronDown, CircleAlert, CircleCheck, ClipboardList, Copy, FileText, FoldVertical, History, Hourglass, Loader2, MessageSquareText, Music, Pencil, Puzzle, RefreshCw, RotateCcw, Search, Sparkles, Square, SquarePen, StickyNote, Terminal, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { thumbUrl } from '../../shared/media';
import type { AgentCommand, AgentContext, AgentEntry, AgentEventData, AgentExtension, AgentQuestion, AgentSessionInfo, AgentStatus, AgentTodo, AgentUsage, ApprovalMode } from '../../shared/types';
import { builtinCommand, expandCommand, parseCommand } from '../../shared/commands';
import { ensureVisible, revealItems } from '../canvas/view';
import { kindLabel } from '../canvas/items';
import { api } from '../lib/api';
import { boundsOf, viewportCenter } from '../../shared/geometry';
import { redoneVersion } from '../../shared/frames';
import { savePending } from '../projects/sync';
import { select, toast, useStore } from '../store';
import { Markdown } from '../components/Markdown';
import { Dropdown } from '../components/Dropdown';
import { lang, t } from '../i18n';
import { CommandsModal, SlashMenu, type SlashItem, slashItems } from './Commands';
import { MemoryModal } from './Memory';
import { QuestionCard } from './Question';
import { Todos } from './Todos';

const WIDTH_KEY = 'kynflow:agent-width';
const SOURCE_KEY = 'kynflow:agent-source';

type AgentSource = 'builtin' | 'extensions';

const SOURCES: { id: AgentSource; label: string }[] = [
  { id: 'builtin', label: t('内置助手') },
  { id: 'extensions', label: t('扩展') },
];

function savedSource(): AgentSource {
  // Older builds had one tab per external assistant; they all live in the extension list now.
  return localStorage.getItem(SOURCE_KEY) === 'builtin' || !localStorage.getItem(SOURCE_KEY) ? 'builtin' : 'extensions';
}

function setSource(source: AgentSource) {
  useAgent.setState({ source });
  localStorage.setItem(SOURCE_KEY, source);
}

/** Tools whose results are new board items worth bringing into view. */
const CREATES = new Set(['generate_image', 'generate_video', 'run_workflow']);

const SUGGESTIONS = [t('把选中的图做成 5 秒视频'), t('雨夜街头：人物三连拍'), t('检查选中的图，有问题就重生成')];

interface AgentState {
  open: boolean;
  source: AgentSource;
  status: AgentStatus | null;
  /** Board the conversation belongs to. */
  projectId: string | null;
  entries: AgentEntry[];
  running: boolean;
  usage: AgentUsage;
  draft: string;
  todos: AgentTodo[];
  /** Plan mode: the assistant reads and proposes until a plan is accepted. */
  plan: boolean;
  context: AgentContext | null;
  /** The user's saved /commands. */
  commands: AgentCommand[];
  /** Outside assistants detected on this machine, null until loaded. */
  extensions: AgentExtension[] | null;
  extensionsLoading: boolean;
  /** The "condense now" bar: what to keep in particular, and whether it is running. */
  condense: { focus: string; busy: boolean } | null;
  /** The conversation the panel is showing. */
  sessionId: string;
  /** The board's other conversations, newest first. */
  sessions: AgentSessionInfo[];
}

export const useAgent = create<AgentState>(() => ({
  open: true,
  source: savedSource(),
  status: null,
  projectId: null,
  entries: [],
  running: false,
  usage: { tokens: 0, cost: 0 },
  draft: '',
  todos: [],
  plan: false,
  context: null,
  commands: [],
  extensions: null,
  extensionsLoading: false,
  condense: null,
  sessionId: '',
  sessions: [],
}));

export function toggleAgent(open = !useAgent.getState().open) {
  useAgent.setState({ open });
}

/** Opens the panel with a replication brief ready to send; selected items go along as the references. */
export function startReplication() {
  toggleAgent(true);
  useAgent.setState({
    draft: t('帮我复刻这条爆款内容：先读 viral_replication 手册，再按里面的步骤拆解我选的参考素材。拆解、一致性锁和分段方案先给我看，确认后再出图、再生成视频。'),
  });
}

/** Loads the open board's conversation (on opening the panel, switching boards and reconnecting). */
export async function refreshAgent() {
  const projectId = useStore.getState().projectId;
  if (!projectId || !useAgent.getState().open) return;
  try {
    const [status, view, list] = await Promise.all([api.agentStatus(), api.agent(projectId), api.agentSessions(projectId)]);
    if (useStore.getState().projectId !== projectId) return;
    useAgent.setState({
      status,
      projectId,
      entries: view.entries,
      running: view.running,
      usage: view.usage,
      todos: view.todos,
      plan: view.plan,
      context: view.context,
      sessionId: view.sessionId,
      sessions: list.sessions,
    });
  } catch (err) {
    useAgent.setState({
      status: { ready: false, model: '', vision: false, reason: (err as Error).message },
      projectId,
      entries: [],
      running: false,
      usage: { tokens: 0, cost: 0 },
      todos: [],
      plan: false,
      context: null,
      sessionId: '',
      sessions: [],
    });
  }
}

export async function loadCommands() {
  try {
    useAgent.setState({ commands: await api.agentCommands() });
  } catch {
    /* server offline */
  }
}

/** Re-scans this machine for installed assistants and their MCP config. */
export async function loadExtensions() {
  useAgent.setState({ extensionsLoading: true });
  try {
    useAgent.setState({ extensions: await api.agentExtensions(), extensionsLoading: false });
  } catch (err) {
    useAgent.setState({ extensions: [], extensionsLoading: false });
    toast(t('检测本机助手失败：{message}', { message: (err as Error).message }), 'error');
  }
}

export function onAgentEvent(e: AgentEventData) {
  const s = useAgent.getState();
  if (e.projectId !== s.projectId) return;
  if (e.reset) {
    useAgent.setState({
      entries: [],
      running: false,
      usage: { tokens: 0, cost: 0 },
      todos: [],
      plan: false,
      context: null,
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
    });
    void refreshAgent();
    return;
  }
  const patch: Partial<AgentState> = {};
  if (e.running !== undefined) patch.running = e.running;
  if (e.usage) patch.usage = e.usage;
  if (e.todos) patch.todos = e.todos;
  if (e.plan !== undefined) patch.plan = e.plan;
  if (e.context !== undefined) patch.context = e.context;
  const entry = e.entry;
  if (entry) {
    const i = s.entries.findIndex((x) => x.id === entry.id);
    patch.entries = i >= 0 ? s.entries.map((x, j) => (j === i ? entry : x)) : [...s.entries, entry];
    if (entry.kind === 'tool' && entry.status === 'done' && entry.items?.length && CREATES.has(entry.tool)) void revealItems(entry.items);
  }
  useAgent.setState(patch);
}


/** Sends the input, running it first when it is a /command. */
async function send() {
  const { draft, commands, plan } = useAgent.getState();
  const text = draft.trim();
  const command = parseCommand(text);
  if (command) {
    const builtin = builtinCommand(command.name);
    if (builtin) {
      useAgent.setState({ draft: '' });
      if (builtin === 'new') return newSession();
      if (builtin === 'condense') return condenseNow(command.rest);
      // /plan alone switches it; with words after it, switches it on and sends them.
      await setPlan(command.rest ? true : !plan);
      return command.rest ? sendText(command.rest) : undefined;
    }
    const own = commands.find((c) => c.name.toLowerCase() === command.name.toLowerCase());
    if (own) return sendText(expandCommand(own, command.rest));
  }
  return sendText(text);
}

async function sendText(text: string) {
  const { projectId, selection, viewport, screen } = useStore.getState();
  if (!text || !projectId) return;
  useAgent.setState({ draft: '' });
  try {
    // The agent reads the board from the server: let it see what was just added or moved.
    await savePending();
    await api.sendAgent(projectId, { text, selection, view: viewportCenter(viewport, screen.w, screen.h - 160) });
  } catch (err) {
    toast((err as Error).message, 'error');
    if (!useAgent.getState().draft) useAgent.setState({ draft: text });
  }
}

async function stop() {
  const { projectId } = useAgent.getState();
  if (projectId) await api.abortAgent(projectId).catch((err) => toast((err as Error).message, 'error'));
}

/** Gives a conversation a name; Enter saves it in the history list. */
async function renameSession(sessionId: string, title: string): Promise<boolean> {
  const { projectId } = useAgent.getState();
  if (!projectId || !title.trim()) return false;
  try {
    await api.renameAgentSession(projectId, sessionId, title.trim());
    await refreshAgent();
    return true;
  } catch (err) {
    toast((err as Error).message, 'error');
    return false;
  }
}

/** Deletes a conversation. Deleting the open one starts a new empty conversation. */
async function deleteSession(sessionId: string): Promise<void> {
  const { projectId } = useAgent.getState();
  if (!projectId || !confirm(t('删除这段对话？'))) return;
  try {
    await api.deleteAgentSession(projectId, sessionId);
    await refreshAgent();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

/** Starts a new conversation; the current one stays in the board's history. */
async function newSession() {
  const { projectId, running } = useAgent.getState();
  if (!projectId || running) return;
  try {
    await api.newAgentSession(projectId);
    await refreshAgent();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

/** Opens one of the board's past conversations and continues it. */
async function openSession(sessionId: string): Promise<boolean> {
  const { projectId, sessionId: current, running } = useAgent.getState();
  if (!projectId || running || !sessionId || sessionId === current) return false;
  try {
    await api.openAgentSession(projectId, sessionId);
    await refreshAgent();
    return true;
  } catch (err) {
    toast((err as Error).message, 'error');
    return false;
  }
}

async function setPlan(on: boolean) {
  const { projectId } = useAgent.getState();
  if (!projectId) return;
  try {
    await api.setAgentPlan(projectId, on);
    useAgent.setState({ plan: on });
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

/** Condenses the earlier conversation now, keeping `focus` in particular. */
async function condenseNow(focus: string) {
  const { projectId } = useAgent.getState();
  if (!projectId) return;
  useAgent.setState({ condense: { focus, busy: true } });
  try {
    await api.condenseAgent(projectId, focus);
    await refreshAgent();
    useAgent.setState({ condense: null });
  } catch (err) {
    toast((err as Error).message, 'error');
    useAgent.setState((s) => ({ condense: s.condense ? { ...s.condense, busy: false } : null }));
  }
}

/** Board and conversation back to just before a message, which comes back into the input to edit. */
async function rewind(id: string) {
  const { projectId } = useAgent.getState();
  if (!projectId) return;
  if (!confirm(t('回到发这条消息之前？画布和对话都会恢复到那时：之后的改动都会撤掉（包括你自己做的），还在生成的任务会取消，花掉的费用不会退。现在的画布会先存一个快照，后悔了可以在「项目快照」里恢复。'))) return;
  try {
    const { text } = await api.rewindAgent(projectId, id);
    await refreshAgent();
    useAgent.setState({ draft: text });
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function answerQuestion(id: string, answer: string) {
  const { projectId } = useAgent.getState();
  if (!projectId) return;
  try {
    await savePending();
    await api.answerAgent(projectId, id, answer);
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

function focusItems(ids: string[]) {
  const items = useStore.getState().items.filter((i) => ids.includes(i.id));
  const bounds = boundsOf(items);
  if (!bounds) return toast(t('这些节点已经不在画布上了'), 'info');
  select(items.map((i) => i.id));
  ensureVisible(bounds);
}

function ItemChip({ id }: { id: string }) {
  const item = useStore((s) => s.items.find((i) => i.id === id));
  if (!item) return <span className="agent-chip gone" title={t('已不在画布上')} />;
  const media = item.asset;
  return (
    <button className="agent-chip" title={item.name ?? t('在画布上查看')} onClick={() => focusItems([id])}>
      {media ? (
        media.kind === 'image' || media.kind === 'video' ? (
          <img src={thumbUrl(media.url)} alt="" />
        ) : media.kind === 'audio' ? (
          <Music />
        ) : media.kind === 'model3d' ? (
          <Box />
        ) : (
          <FileText />
        )
      ) : item.kind === 'text' ? (
        <StickyNote />
      ) : item.kind === 'prompt' ? (
        <MessageSquareText />
      ) : item.error ? (
        <CircleAlert className="bad" />
      ) : (
        <Loader2 className="spin" />
      )}
    </button>
  );
}

/** A selected item the message will carry: click it to find it on the board, × to leave it out. */
function AttachedChip({ id }: { id: string }) {
  const item = useStore((s) => s.items.find((i) => i.id === id));
  if (!item) return null;
  const media = item.asset;
  const kind = item.kind === 'text' ? t('文本') : item.kind === 'prompt' ? t('提示词') : kindLabel(item.kind);
  const textual = item.kind === 'text' || item.kind === 'prompt';
  return (
    <span className="agent-attached-chip">
      <button className={`agent-chip ${textual ? 'agent-chip-note' : ''}`} title={item.name ? `${kind} · ${item.name}` : kind} onClick={() => ensureVisible(item)}>
        {media ? (
          media.kind === 'image' || media.kind === 'video' ? (
            <img src={thumbUrl(media.url)} alt="" />
          ) : media.kind === 'audio' ? (
            <Music />
          ) : media.kind === 'model3d' ? (
            <Box />
          ) : (
            <FileText />
          )
        ) : item.kind === 'text' ? (
          <>
            <StickyNote />
            <span>{item.name || kind}</span>
          </>
        ) : item.kind === 'prompt' ? (
          <>
            <MessageSquareText />
            <span>{item.name || kind}</span>
          </>
        ) : item.error ? (
          <CircleAlert className="bad" />
        ) : (
          <Loader2 className="spin" />
        )}
      </button>
      <button className="agent-attached-remove" title={t('不带这个节点')} onClick={() => select([id], 'toggle')}>
        <X />
      </button>
    </span>
  );
}

/** What the message will carry: the items selected on the board, shown above the input. */
function Attached({ ids }: { ids: string[] }) {
  return (
    <div className="agent-attached">
      <div className="agent-attached-head">
        <span>{t('会带上选中的 {n} 个节点', { n: ids.length })}</span>
        <button onClick={() => select([])}>{t('都不带')}</button>
      </div>
      <div className="agent-chips">
        {ids.slice(0, 12).map((id) => (
          <AttachedChip key={id} id={id} />
        ))}
        {ids.length > 12 && <span className="agent-chip more">+{ids.length - 12}</span>}
      </div>
    </div>
  );
}

function Chips({ ids }: { ids: string[] }) {
  return (
    <div className="agent-chips">
      {ids.slice(0, 12).map((id) => (
        <ItemChip key={id} id={id} />
      ))}
      {ids.length > 12 && (
        <button className="agent-chip more" onClick={() => focusItems(ids)}>
          +{ids.length - 12}
        </button>
      )}
    </div>
  );
}

function Entry({ entry }: { entry: AgentEntry }) {
  const running = useAgent((s) => s.running);
  const ready = useAgent((s) => Boolean(s.status?.ready));
  if (entry.kind === 'user') {
    return (
      <div className="agent-msg user">
        <div className="agent-bubble-row">
          {entry.rewind && (
            <button className="icon-btn small agent-rewind" disabled={running} title={t('回到这里：画布和对话都恢复到发这条消息之前，消息回到输入框里可以改了再发')} onClick={() => void rewind(entry.id)}>
              <RotateCcw />
            </button>
          )}
          <div className="agent-bubble">{entry.text}</div>
        </div>
        {entry.selection && <Chips ids={entry.selection} />}
      </div>
    );
  }
  if (entry.kind === 'assistant') {
    return (
      <div className="agent-msg assistant">
        {entry.text && <Markdown text={entry.text} className="agent-text" />}
        {entry.error && (
          <div className="agent-error">
            <CircleAlert /> {entry.error}
            {!running && ready && (
              <button className="agent-retry" title={t('接着上一步继续，不用重新说一遍')} onClick={() => void sendText(t('继续'))}>
                {t('重试')}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
  if (entry.kind === 'event' && entry.detail) {
    return (
      <details className="agent-event agent-summary">
        <summary>
          <FoldVertical /> <span>{entry.text}</span>
        </summary>
        <Markdown text={entry.detail} className="agent-text" />
      </details>
    );
  }
  if (entry.kind === 'event') {
    return (
      <div className="agent-event">
        <Bell /> <span>{entry.text}</span>
      </div>
    );
  }
  return (
    <div className={`agent-tool ${entry.status}`}>
      <span className="agent-tool-icon">
        {entry.status === 'running' ? (
          <Loader2 className="spin" />
        ) : entry.status === 'done' ? (
          <CircleCheck />
        ) : entry.status === 'waiting' ? (
          <Hourglass />
        ) : (
          <CircleAlert />
        )}
      </span>
      <div className="agent-tool-main">
        <div className="agent-tool-line" title={entry.summary}>
          <b>{entry.label}</b>
          {entry.summary && <span>{entry.summary}</span>}
        </div>
        {entry.items && <Chips ids={entry.items} />}
        {entry.status === 'waiting' && entry.approval && <Approval id={entry.id} approval={entry.approval} />}
        {entry.question && <QuestionCard question={entry.question as AgentQuestion} onAnswer={(answer) => answerQuestion(entry.id, answer)} />}
      </div>
    </div>
  );
}

/** Work the agent holds until the user agrees, e.g. a batch of long video generations. */
function Approval({ id, approval }: { id: string; approval: NonNullable<Extract<AgentEntry, { kind: 'tool' }>['approval']> }) {
  const [busy, setBusy] = useState(false);
  // The prompts as the user is editing them.
  const [prompts, setPrompts] = useState(() => approval.prompts?.map((p) => p.text) ?? []);
  const items = useStore((s) => s.items);
  // What will be submitted: a keyframe redone after the card was made replaces its old version.
  const frames = approval.frames?.map((id) => {
    const frame = items.find((i) => i.id === id);
    return (frame && approval.since !== undefined ? redoneVersion(items, frame, approval.since, (i) => Boolean(i.asset))?.id : undefined) ?? id;
  });
  const redone = frames?.filter((f, i) => f !== approval.frames![i]).length ?? 0;
  const answer = async (ok: boolean) => {
    const { projectId } = useAgent.getState();
    if (!projectId) return;
    setBusy(true);
    try {
      await api.approveAgent(projectId, id, ok, ok && approval.prompts ? prompts : undefined);
    } catch (err) {
      toast((err as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <div className="agent-approval">
      <b>{approval.title}</b>
      {approval.detail && <span>{approval.detail}</span>}
      {approval.body && <Markdown text={approval.body} className="agent-text agent-plan" />}
      {approval.prompts?.map((p, i) => (
        <div key={i} className="agent-prompt">
          <div className="agent-prompt-head">
            <b>{p.label || t('第 {n} 条', { n: i + 1 })}</b>
            {prompts[i] !== p.text && <span className="agent-prompt-edited">{t('已修改')}</span>}
          </div>
          {p.refs && p.refs.length > 0 && <Chips ids={p.refs} />}
          <textarea
            value={prompts[i] ?? ''}
            disabled={busy}
            rows={Math.min(10, Math.max(3, Math.ceil((prompts[i] ?? '').length / 48)))}
            onChange={(e) => setPrompts((all) => all.map((x, j) => (j === i ? e.target.value : x)))}
          />
        </div>
      ))}
      {frames && <Chips ids={frames} />}
      {redone > 0 && <span>{t('{n} 段的首帧用的是确认卡之后重做的版本', { n: redone })}</span>}
      <div className="agent-approval-bar">
        <button className="btn ghost small" disabled={busy} onClick={() => void answer(false)}>
          {approval.reject ?? t('不要')}
        </button>
        <button className="btn primary small" disabled={busy} onClick={() => void answer(true)}>
          {approval.confirm ?? t('开始')}
        </button>
      </div>
    </div>
  );
}

const compact = new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en', { notation: 'compact', maximumFractionDigits: 1 });

/** Costs come in US dollars (model list prices); the Chinese interface shows yuan at this rough fixed rate. */
const CNY_PER_USD = 7.2;

function AgentDock() {
  const open = useAgent((s) => s.open);
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) ? Math.max(360, Math.min(560, saved)) : 400;
  });
  const widthRef = useRef(width);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => {
      const next = Math.max(360, Math.min(560, w0 + (x0 - ev.clientX)));
      widthRef.current = next;
      setWidth(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      localStorage.setItem(WIDTH_KEY, String(widthRef.current));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!open) return null;
  return (
    <div className="agent-dock" style={{ width }} data-ui>
      <div className="agent-resize" onPointerDown={startResize} title={t('拖动调整宽度')} />
      <AgentPanel />
    </div>
  );
}

export { AgentDock };

/** Copies text and flashes the button that did it. */
function useCopied() {
  const [copied, setCopied] = useState('');
  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      toast(t('复制失败，请手动选择'), 'error');
    }
  };
  return { copied, copy };
}

interface ExtInfo {
  name: string;
  description: string;
  icon: typeof Bot;
}

const EXT_INFO: Record<string, ExtInfo> = {
  claude: {
    name: 'Claude Code',
    description: t('Anthropic 的命令行助手，通过 MCP 读取画布并生成内容。'),
    icon: Sparkles,
  },
  codex: {
    name: 'Codex',
    description: t('OpenAI 的命令行助手，通过 MCP 在画布上生成和整理素材。'),
    icon: Terminal,
  },
  gemini: {
    name: 'Gemini CLI',
    description: t('Google 的命令行助手，配置后可通过 MCP 操作画布。'),
    icon: Brain,
  },
  cursor: {
    name: 'Cursor',
    description: t('把 Kynflow 的 MCP 服务加进 Cursor 配置，就能在编辑器里直接操作画布。'),
    icon: Bot,
  },
};

/** One outside assistant: what it is, whether this machine has it, and how to connect it. */
function ExtensionCard({ ext }: { ext: AgentExtension }) {
  const info = EXT_INFO[ext.id] ?? { name: ext.id, description: '', icon: Bot };
  const Icon = info.icon;
  const { copied, copy } = useCopied();
  // Already connected assistants stay quiet; the rest open with the setup steps.
  const [open, setOpen] = useState(!ext.mcpConfigured);
  return (
    <div className="agent-ext">
      <div className="agent-ext-top">
        <span className="agent-ext-icon">
          <Icon />
        </span>
        <div className="agent-ext-name">
          <strong>{info.name}</strong>
          <small>{ext.bin}</small>
        </div>
        <div className="agent-ext-badges">
          <span className={ext.installed ? 'ok' : ''}>{ext.installed ? t('已安装') : t('未检测到')}</span>
          {ext.mcpConfigured && <span className="ok">{t('已接入')}</span>}
        </div>
      </div>
      <p className="agent-ext-desc">{info.description}</p>
      {open && (
        <>
          <div className="agent-ext-meta">
            <span>{t('配置文件')}</span>
            <code>{ext.configPath}</code>
          </div>
          {!ext.installed && ext.install && (
            <>
              <div className="agent-ext-label">{t('安装')}</div>
              <div className="agent-command">
                <code>{ext.install}</code>
                <button className="icon-btn small" title={t('复制命令')} onClick={() => void copy(ext.install, 'install')}>
                  {copied === 'install' ? <CircleCheck /> : <Copy />}
                </button>
              </div>
            </>
          )}
          <div className="agent-ext-label">{ext.connectKind === 'json' ? t('写入配置文件') : t('接入')}</div>
          <div className="agent-command">
            <code>{ext.connect}</code>
            <button className="icon-btn small" title={t('复制命令')} onClick={() => void copy(ext.connect, 'connect')}>
              {copied === 'connect' ? <CircleCheck /> : <Copy />}
            </button>
          </div>
        </>
      )}
      <div className="agent-ext-foot">
        {ext.mcpConfigured ? (
          <div className="agent-ext-ok">
            <CircleCheck /> {t('这个助手已经配置好 Kynflow。')}
          </div>
        ) : (
          <span />
        )}
        <button className="agent-ext-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? t('收起配置') : t('查看配置')}
          <ChevronDown className={open ? 'open' : ''} />
        </button>
      </div>
    </div>
  );
}

/** Extension list: outside assistants detected on this machine. */
function Extensions() {
  const extensions = useAgent((s) => s.extensions);
  const loading = useAgent((s) => s.extensionsLoading);
  return (
    <div className="agent-source-body" data-scrollable>
      <div className="agent-ext-head">
        <div className="agent-source-title">
          <Puzzle /> {t('助手扩展')}
        </div>
        <button className="icon-btn small" title={t('重新检测')} onClick={() => void loadExtensions()} disabled={loading}>
          <RefreshCw className={loading ? 'spin' : ''} />
        </button>
      </div>
      <p className="agent-source-note">{t('安装下面任意一个助手，它就能通过 MCP 直接操作当前画布。')}</p>
      {loading && !extensions ? (
        <div className="agent-ext-loading">
          <Loader2 className="spin" /> {t('正在检测本机环境…')}
        </div>
      ) : (
        (extensions ?? []).map((ext) => <ExtensionCard key={ext.id} ext={ext} />)
      )}
    </div>
  );
}

/** "1.2万 tokens · ¥0.022" / "12.3K tokens · $0.003" */
function usageText(u: AgentUsage): string {
  const tokens = compact.format(u.tokens);
  if (!(u.cost > 0)) return `${tokens} tokens`;
  const cost = lang === 'zh' ? u.cost * CNY_PER_USD : u.cost;
  return `${tokens} tokens · ${lang === 'zh' ? '¥' : '$'}${cost.toFixed(cost < 0.1 ? 3 : 2)}`;
}

export function AgentPanel() {
  const { open, source, status, entries, running, usage, draft, todos, plan, context, commands, condense, sessionId, sessions } = useAgent();
  const projectId = useStore((s) => s.projectId);
  const selection = useStore((s) => s.selection);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [active, setActive] = useState(0);
  const [managing, setManaging] = useState(false);
  const [remembering, setRemembering] = useState(false);
  const [history, setHistory] = useState(false);
  /** Thinking level and approval mode: changed here, saved as soon as they change. */
  const [tuning, setTuning] = useState<{ thinking: string; approval: ApprovalMode } | null>(null);

  useEffect(() => {
    if (!open) return;
    void api
      .settings()
      .then((s) => setTuning({ thinking: s.agentThinking ?? 'low', approval: s.agentApprovalMode ?? 'risky' }))
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (open && projectId) void refreshAgent();
  }, [open, projectId]);

  useEffect(() => {
    if (open) void loadCommands();
  }, [open]);

  useEffect(() => {
    if (open && source === 'extensions' && !useAgent.getState().extensions) void loadExtensions();
  }, [open, source]);

  // Follow the conversation unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries, running, open]);

  const closeMemory = useCallback(() => setRemembering(false), []);
  const tune = (patch: { thinking?: string; approval?: ApprovalMode }) => {
    setTuning((v) => v && { ...v, ...patch });
    void api
      .saveSettings({
        ...(patch.thinking ? { agentThinking: patch.thinking } : {}),
        ...(patch.approval ? { agentApprovalMode: patch.approval } : {}),
      })
      .catch((err) => toast((err as Error).message, 'error'));
  };
  const slash = slashItems(draft, commands);
  useEffect(() => setActive(0), [draft]);

  if (!open) return null;
  const last = entries[entries.length - 1];
  const thinking = running && (!last || last.kind === 'user' || last.kind === 'event' || (last.kind === 'tool' && last.status !== 'running'));
  const ready = Boolean(status?.ready);
  const full = context ? Math.min(100, Math.round((context.used / context.limit) * 100)) : 0;

  /** A command picked from the menu: run when it was typed out in full, else fill it in. */
  const pick = (item: SlashItem) => {
    if (draft.trim().toLowerCase() === `/${item.name.toLowerCase()}`) return void send();
    useAgent.setState({ draft: `/${item.name} ` });
  };

  return (
    <div className="agent-panel" data-ui>
      <div className="agent-head">
        <Bot className="agent-logo" />
        <span className="agent-title">Agent</span>
        {source === 'builtin' && status?.model && (
          <span className="agent-model" title={status.model}>
            {status.model.split('/').pop()}
          </span>
        )}
        <span className="agent-head-gap" />
        {source === 'builtin' && (
          <>
            {usage.tokens > 0 && (
              <span
                className="agent-usage"
                title={
                  lang === 'zh'
                    ? t('这段对话用掉的 tokens 和费用。tokens 不算命中缓存的部分，那部分几乎不花钱；费用按模型的公开价格估算，美元按 1:{rate} 换成人民币，以服务商账单为准', { rate: CNY_PER_USD })
                    : t('这段对话用掉的 tokens 和费用。tokens 不算命中缓存的部分，那部分几乎不花钱；费用按模型的公开价格估算，以服务商账单为准')
                }
              >
                {usageText(usage)}
              </span>
            )}
            <button className="icon-btn small" title={t('记忆：助手跨对话记住的偏好和决定')} onClick={() => setRemembering(true)} disabled={!projectId}>
              <Brain />
            </button>
            <button
              className="icon-btn small"
              title={t('整理对话：把较早的部分整理成摘要，后面每次请求都更省')}
              onClick={() => useAgent.setState({ condense: { focus: '', busy: false } })}
              disabled={!ready || running || entries.length < 4 || condense !== null}
            >
              <FoldVertical />
            </button>
            <button className="icon-btn small" title={t('历史对话')} onClick={() => setHistory((shown) => !shown)} disabled={!projectId || running}>
              <History />
            </button>
            <button className="icon-btn small" title={t('新对话')} onClick={() => void newSession()} disabled={!entries.length || running}>
              <SquarePen />
            </button>
          </>
        )}
        <button className="icon-btn small" title={t('收起')} onClick={() => toggleAgent(false)}>
          <X />
        </button>
        {history && (
          <div className="agent-history-pop">
            <div className="agent-history-head">
              <span>{t('历史对话')}</span>
              <button className="icon-btn small" title={t('关闭')} onClick={() => setHistory(false)}>
                <X />
              </button>
            </div>
            <HistoryList
              sessions={sessions}
              current={sessionId}
              running={running}
              onClose={() => setHistory(false)}
              onOpen={async (id) => {
                if (await openSession(id)) setHistory(false);
              }}
            />
          </div>
        )}
      </div>
      {history && <div className="agent-history-scrim" onClick={() => setHistory(false)} />}

      <div className="agent-sources">
        {SOURCES.map((item) => (
          <button key={item.id} className={source === item.id ? 'on' : ''} onClick={() => setSource(item.id)}>
            {item.label}
          </button>
        ))}
      </div>

      {source === 'extensions' ? (
        <Extensions />
      ) : (
        <>
          <Todos todos={todos} />

      <div
        className="agent-log"
        ref={log}
        data-scrollable
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!entries.length && (
          <div className="agent-empty">
            <Bot />
            {SUGGESTIONS.map((s) => (
              <button key={s} className="agent-suggest" onClick={() => useAgent.setState({ draft: s })}>
                {s}
              </button>
            ))}
            <p className="agent-empty-tip">{t('打 / 可以用命令，比如 /计划')}</p>
          </div>
        )}
        {entries.map((e) => (
          <Entry key={e.id} entry={e} />
        ))}
        {thinking && (
          <div className="agent-thinking">
            <Loader2 className="spin" /> {t('思考中…')}
          </div>
        )}
      </div>

      {status && !ready && (
        <div className="agent-setup">
          <CircleAlert /> {status.reason}
        </div>
      )}

      {condense && (
        <div className="agent-condense">
          <input
            autoFocus
            value={condense.focus}
            disabled={condense.busy}
            maxLength={500}
            placeholder={t('整理较早的对话：重点保留什么（可以不填）')}
            onChange={(e) => useAgent.setState({ condense: { ...condense, focus: e.target.value } })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void condenseNow(condense.focus);
              else if (e.key === 'Escape' && !condense.busy) useAgent.setState({ condense: null });
            }}
          />
          <button className="btn ghost small" disabled={condense.busy} onClick={() => useAgent.setState({ condense: null })}>
            {t('取消')}
          </button>
          <button className="btn primary small" disabled={condense.busy} onClick={() => void condenseNow(condense.focus)}>
            {condense.busy && <Loader2 className="spin" />} {t('整理')}
          </button>
        </div>
      )}

      <div className={`agent-input ${plan ? 'plan' : ''}`}>
        {slash && <SlashMenu items={slash} active={active} onPick={pick} onHover={setActive} onManage={() => setManaging(true)} />}
        {selection.length > 0 && <Attached ids={selection} />}
        <textarea
          value={draft}
          rows={3}
          disabled={!ready}
          placeholder={plan ? t('计划模式：助手只读画布、出方案，你确认后才动手') : t('想让助手做什么？打 / 用命令')}
          onChange={(e) => useAgent.setState({ draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (slash?.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : slash.length - 1)) % slash.length);
            } else if (slash?.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
              e.preventDefault();
              pick(slash[Math.min(active, slash.length - 1)]);
            } else if (slash && e.key === 'Escape') {
              useAgent.setState({ draft: '' });
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="agent-input-bar">
          <button
            className={`agent-plan-toggle ${plan ? 'on' : ''}`}
            disabled={!ready || !projectId}
            title={t('计划模式：助手先只读画布、写出方案给你确认，确认后才出图、改画布')}
            onClick={() => void setPlan(!plan)}
          >
            <ClipboardList /> {t('计划模式')}
          </button>
          {tuning && (
            <>
              <span className="agent-tune">
                <Dropdown
                  value={tuning.thinking}
                  options={[
                    { value: 'off', label: t('思考：关') },
                    { value: 'minimal', label: t('思考：极低') },
                    { value: 'low', label: t('思考：低') },
                    { value: 'medium', label: t('思考：中') },
                    { value: 'high', label: t('思考：高') },
                  ]}
                  onChange={(thinking) => tune({ thinking })}
                />
              </span>
              <span className="agent-tune">
                <Dropdown
                  wide
                  value={tuning.approval}
                  title={t('助手什么时候先问你')}
                  options={[
                    { value: 'risky', label: t('高风险'), desc: t('只在删除内容、整批视频、接受方案时先问') },
                    { value: 'prompts', label: t('看提示词'), desc: t('每次生成前先确认提示词，可以直接改') },
                    { value: 'always', label: t('逐项审批'), desc: t('每一项修改画布或提交任务都先审批') },
                  ]}
                  onChange={(approval) => tune({ approval: approval as ApprovalMode })}
                />
              </span>
            </>
          )}
          {context && (
            <span
              className={`agent-context ${full >= 80 ? 'full' : ''}`}
              title={t('上下文用了 {used} tokens。到 {limit} 时会把较早的对话整理成摘要，用到一半时会先清掉旧的工具结果', {
                used: compact.format(context.used),
                limit: compact.format(context.limit),
              })}
            >
              {t('上下文 {n}%', { n: full })}
            </span>
          )}
          {running && <span className="agent-hint">{t('工作中，可以继续补充要求')}</span>}
          {running && (
            <button className="btn ghost small" onClick={() => void stop()}>
              <Square /> {t('停止')}
            </button>
          )}
          <button className="btn primary small" disabled={!ready || !draft.trim()} onClick={() => void send()}>
            <ArrowUp /> {t('发送')}
          </button>
        </div>
      </div>
        </>
      )}

      {remembering && projectId && <MemoryModal projectId={projectId} onClose={closeMemory} />}
      {managing && <CommandsModal onClose={() => setManaging(false)} onSaved={(list) => useAgent.setState({ commands: list })} />}
    </div>
  );
}

/** The board's past conversations, shown inside the assistant panel: open, rename, search or delete one. */
function HistoryList({
  sessions,
  current,
  running,
  onClose,
  onOpen,
}: {
  sessions: AgentSessionInfo[];
  current: string;
  running: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const needle = query.trim().toLowerCase();
  const shown = needle ? sessions.filter((s) => s.title.toLowerCase().includes(needle)) : sessions;

  const save = async (id: string) => {
    if (!draft.trim()) return;
    setBusy(true);
    if (await renameSession(id, draft)) setEditing('');
    setBusy(false);
  };

  const remove = async (id: string) => {
    setBusy(true);
    await deleteSession(id);
    setBusy(false);
  };

  return (
    <div className="agent-history">
      <label className="agent-history-search">
        <Search />
        <input value={query} placeholder={t('搜索对话')} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {shown.length === 0 ? (
        <div className="agent-history-empty">
          {needle ? t('没有匹配的对话') : t('还没有历史对话。开始新对话后，这里会保留之前的对话。')}
        </div>
      ) : (
        shown.map((session) => (
          <div key={session.id} className={`agent-history-row ${session.id === current ? 'on' : ''}`}>
            {editing === session.id ? (
              <input
                className="agent-history-rename"
                autoFocus
                value={draft}
                title={t('回车保存，Esc 取消')}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save(session.id);
                  if (e.key === 'Escape') setEditing('');
                }}
              />
            ) : (
              <button
                className="agent-history-open"
                onClick={() => (session.id === current ? onClose() : onOpen(session.id))}
              >
                <span className="agent-history-title">{session.title}</span>
                <span className="agent-history-when">
                  {session.id === current ? `${t('当前')} · ` : ''}
                  {new Date(session.updatedAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </button>
            )}
            <div className="agent-history-actions">
              <button
                className="icon-btn small"
                title={t('重命名')}
                disabled={busy || running}
                onClick={() => {
                  setEditing(session.id);
                  setDraft(session.title);
                }}
              >
                <Pencil />
              </button>
              <button
                className="icon-btn small"
                title={t('删除')}
                disabled={busy || running}
                onClick={() => void remove(session.id)}
              >
                <Trash2 />
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

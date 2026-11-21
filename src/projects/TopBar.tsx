import { Box, Bot, Check, ChevronDown, Cloud, CloudOff, FileText, Film, History, Images, Loader2, MapPin, Maximize2, Minus, Music, Plus, RotateCcw, Trash2, Workflow, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { thumbUrl } from '../../shared/media';
import { boundsOf } from '../../shared/geometry';
import type { ProjectSummary, Task } from '../../shared/types';
import { fitAll, ensureVisible } from '../canvas/view';
import { addAssets } from '../assets/actions';
import { toggleAgent, useAgent } from '../assistant/AgentPanel';
import { launch } from '../generation/tasks';
import { api } from '../lib/api';
import { applyTask, select, toast, useStore, zoomAt } from '../store';
import { createProject, openProject } from './sync';
import { t } from '../i18n';

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open, close]);
  return ref;
}

function timeAgo(at: number) {
  const s = (Date.now() - at) / 1000;
  if (s < 60) return t('刚刚');
  if (s < 3600) return t('{n} 分钟前', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n} 小时前', { n: Math.floor(s / 3600) });
  return new Date(at).toLocaleDateString();
}

function ProjectMenu() {
  const projectId = useStore((s) => s.projectId);
  const name = useStore((s) => s.projectName);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ProjectSummary[]>([]);
  const ref = useOutsideClose(open, () => setOpen(false));

  useEffect(() => {
    if (open) void api.projects().then(setList).catch(() => {});
  }, [open]);

  return (
    <div className="project" ref={ref}>
      <input
        className="project-name"
        value={name}
        style={{ width: `${Math.min(260, Math.max(56, [...name].reduce((w, ch) => w + (/[\u2e80-\uffff]/.test(ch) ? 14 : 8), 16)))}px` }}
        onChange={(e) => useStore.setState({ projectName: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        spellCheck={false}
      />
      <button className="icon-btn small" onClick={() => setOpen((v) => !v)} title={t('切换画布')}>
        <ChevronDown />
      </button>
      {open && (
        <div className="menu project-menu" data-scrollable>
          <button
            className="menu-item new"
            onClick={() => {
              setOpen(false);
              void createProject();
            }}
          >
            <Plus /> {t('新建画布')}
          </button>
          {projectId && <button className="menu-item" onClick={() => { setOpen(false); useStore.setState({ modal: { type: 'snapshots' } }); }}><History /> {t('项目快照')}</button>}
          <div className="menu-sep" />
          {list.map((p) => (
            <div key={p.id} className={`project-row ${p.id === projectId ? 'on' : ''}`}>
              <button
                className="project-open"
                onClick={() => {
                  setOpen(false);
                  if (p.id !== projectId) void openProject(p.id);
                }}
              >
                <div className="project-cover">{p.cover ? <img src={thumbUrl(p.cover)} alt="" /> : null}</div>
                <div className="project-meta">
                  <span>{p.name}</span>
                  <small>
                    {t('{n} 个元素 · {ago}', { n: p.itemCount, ago: timeAgo(p.updatedAt) })}
                  </small>
                </div>
                {p.id === projectId && <Check className="dd-check" />}
              </button>
              {p.id !== projectId && (
                <button
                  className="icon-btn small danger"
                  title={t('删除画布')}
                  onClick={async () => {
                    if (!confirm(t('删除画布「{name}」？画布里的图片文件不会被删除。', { name: p.name }))) return;
                    await api.deleteProject(p.id);
                    setList((l) => l.filter((x) => x.id !== p.id));
                  }}
                >
                  <Trash2 />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function opLabel(task: Task) {
  const r = task.request;
  switch (r.op) {
    case 'image.generate':
      return r.images?.length ? t('参考图生成') : t('文生图');
    case 'video.generate':
      return r.model === 'minimax-ref' ? t('多图参考视频') : r.images?.length ? t('图生视频') : t('文生视频');
    case 'image.inpaint':
      return t('局部重绘');
    case 'image.erase':
      return t('消除');
    case 'image.outpaint':
      return t('扩图');
    case 'image.removeBg':
      return t('抠图');
    case 'image.upscale':
      return t('超清');
    case 'custom':
      return t([...useStore.getState().workflows, ...useStore.getState().presets].find((w) => w.id === r.workflow)?.name ?? '自定义工作流');
  }
}

function TaskMenu() {
  const live = useStore((s) => s.tasks);
  const items = useStore((s) => s.items);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<Task[]>([]);
  const [tab, setTab] = useState<'active' | 'all'>('active');
  const [loading, setLoading] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));

  // The server keeps every task, so the list survives a reload; live ones come in over the stream.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .taskHistory()
      .then(setHistory)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open]);

  const merged = useMemo(() => {
    const byId = new Map(history.map((task) => [task.id, task]));
    for (const task of Object.values(live)) byId.set(task.id, task);
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [history, live]);

  const active = merged.filter((task) => task.status === 'queued' || task.status === 'running');
  const shown = (tab === 'active' ? active : merged).slice(0, 60);

  const onBoard = (task: Task) => {
    const ids = new Set(task.results.map((r) => r.id));
    return items.find((item) => item.asset && ids.has(item.asset.id));
  };

  const locate = (task: Task) => {
    const item = onBoard(task);
    if (!item) return;
    select([item.id]);
    ensureVisible(boundsOf([item])!);
    setOpen(false);
  };

  const cancel = async (task: Task) => {
    try {
      applyTask(await api.cancelTask(task.id));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const again = (task: Task) => {
    const out = task.results[0];
    const ratio = out ? out.height / out.width : task.expected.height / task.expected.width;
    void launch({ request: task.request, kind: task.expected.kind, size: { w: 512, h: Math.max(64, Math.round(512 * ratio)) } });
    setOpen(false);
  };

  return (
    <div className="task-menu-wrap" ref={ref}>
      <button className={`pill ${active.length ? 'busy' : ''}`} onClick={() => setOpen((v) => !v)} title={t('任务：进度、结果与重试')}>
        {active.length ? <Loader2 className="spin" /> : <Check />}
        <span className="pill-label">{active.length ? t('{n} 个任务进行中', { n: active.length }) : t('任务')}</span>
      </button>
      {open && (
        <div className="menu task-menu" data-scrollable>
          <div className="task-tabs">
            <button className={tab === 'active' ? 'on' : ''} onClick={() => setTab('active')}>
              {t('进行中')}{active.length ? ` ${active.length}` : ''}
            </button>
            <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>
              {t('全部')}{merged.length ? ` ${merged.length}` : ''}
            </button>
            {loading && <Loader2 className="spin task-loading" />}
          </div>
          {shown.length ? (
            shown.map((task) => {
              const out = task.results[0];
              const running = task.status === 'queued' || task.status === 'running';
              const seconds = task.finishedAt && task.startedAt ? Math.round((task.finishedAt - task.startedAt) / 1000) : 0;
              return (
                <div key={task.id} className={`task-row ${task.status}`}>
                  <div className="task-thumb">
                    {out ? (
                      out.kind === 'video' ? (
                        <Film />
                      ) : out.kind === 'image' ? (
                        <img src={thumbUrl(out.url)} alt="" loading="lazy" />
                      ) : out.kind === 'audio' ? (
                        <Music />
                      ) : out.kind === 'model3d' ? (
                        <Box />
                      ) : (
                        <FileText />
                      )
                    ) : running ? (
                      <Loader2 className="spin" />
                    ) : (
                      <X />
                    )}
                  </div>
                  <div className="task-main">
                    <div className="task-title">
                      <span>{opLabel(task)}</span>
                      <small>{'prompt' in task.request && task.request.prompt ? task.request.prompt : ''}</small>
                    </div>
                    <div className="task-status">
                      {task.status === 'done' ? t('完成') : task.status === 'error' ? t(task.error ?? '失败') : task.status === 'cancelled' ? t('已取消') : (task.stage ?? t('排队中'))}
                      {seconds ? ` · ${seconds}s` : ''} · {timeAgo(task.createdAt)}
                    </div>
                    {running && (
                      <div className="task-progress">
                        <div style={{ width: `${Math.round(task.progress * 100)}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="task-actions">
                    {running && (
                      <button className="icon-btn small" title={t('取消')} onClick={() => void cancel(task)}>
                        <X />
                      </button>
                    )}
                    {task.status === 'done' &&
                      (onBoard(task) ? (
                        <button className="icon-btn small" title={t('定位')} onClick={() => locate(task)}>
                          <MapPin />
                        </button>
                      ) : (
                        <button className="icon-btn small" title={t('放到画布')} onClick={() => { addAssets(task.results); toast(t('已放到画布'), 'success'); setOpen(false); }}>
                          <Plus />
                        </button>
                      ))}
                    {(task.status === 'error' || task.status === 'cancelled') && (
                      <button className="icon-btn small" title={t('重试')} onClick={() => again(task)}>
                        <RotateCcw />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="task-empty">{tab === 'active' ? t('没有进行中的任务') : t('还没有任务记录')}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function ZoomControl() {
  const zoom = useStore((s) => s.viewport.zoom);
  const screen = useStore((s) => s.screen);
  const step = (k: number) => zoomAt(screen.w / 2, screen.h / 2, zoom * k);
  return (
    <div className="zoom" data-ui>
      <button className="icon-btn small" onClick={() => step(1 / 1.25)} title={t('缩小 (⌘-)')}>
        <Minus />
      </button>
      <button className="zoom-val" onClick={() => zoomAt(screen.w / 2, screen.h / 2, 1)} title={t('回到 100% (⌘0)')}>
        {Math.round(zoom * 100)}%
      </button>
      <button className="icon-btn small" onClick={() => step(1.25)} title={t('放大 (⌘=)')}>
        <Plus />
      </button>
      <button className="icon-btn small" onClick={fitAll} title={t('适应画布 (⇧1)')}>
        <Maximize2 />
      </button>
    </div>
  );
}

export function TopBar() {
  const caps = useStore((s) => s.caps);
  const comfyOnline = useStore((s) => s.comfyOnline);
  const serverOnline = useStore((s) => s.serverOnline);
  const saveState = useStore((s) => s.saveState);
  const agentOpen = useAgent((s) => s.open);
  return (
    <div className="topbar-row">
      <div className="topbar left" data-ui>
        <div className="logo" title="Kynflow">
          <img src="/brand/kynflow-icon.png" alt="" width={22} height={22} />
        </div>
        <ProjectMenu />
        {saveState !== 'saved' && <span className={`save-state ${saveState}`}>{saveState === 'saving' ? t('保存中…') : t('保存失败')}</span>}
      </div>
      <div className="topbar right" data-ui>
        <div className="topbar-tools">
          <TaskMenu />
          <button
            className="pill icon"
            onClick={() => useStore.setState({ modal: { type: 'review' } })}
            title={t('结果挑选：逐张看结果，标记通过或不通过')}
            aria-label={t('结果挑选')}
          >
            <Images />
          </button>
          <button className="pill icon" onClick={() => useStore.setState({ modal: { type: 'workflows' } })} title={t('导入和管理自己的 ComfyUI 工作流')} aria-label={t('我的工作流')}>
            <Workflow />
          </button>
          <button className={`pill icon ${agentOpen ? 'on' : ''}`} onClick={() => toggleAgent()} title={t('展开或收起 Agent (⌘J)')} aria-label="Agent">
            <Bot />
          </button>
        </div>
        <button
          className={`pill status ${serverOnline && comfyOnline ? 'ok' : 'bad'}`}
          onClick={() => useStore.setState({ modal: { type: 'settings' } })}
          title={!serverOnline ? t('本地服务未连接') : comfyOnline ? `ComfyUI ${caps?.comfyVersion ?? ''}` : t('ComfyUI 未连接：检查 SSH 隧道和服务器上的 ComfyUI')}
        >
          {serverOnline && comfyOnline ? <Cloud /> : <CloudOff />}
          <span className="pill-label">{!serverOnline ? t('本地服务未连接') : comfyOnline ? caps?.gpu ?? t('ComfyUI 已连接') : t('ComfyUI 未连接')}</span>
        </button>
      </div>
    </div>
  );
}

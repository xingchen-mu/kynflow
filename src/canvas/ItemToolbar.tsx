import { Brush, Camera, Clapperboard, Download, Eraser, Expand, Film, Info, Maximize2, MoreHorizontal, Pencil, Puzzle, RefreshCw, Scissors, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isBlock } from '../../shared/licenses';
import type { CanvasItem, WorkflowLike } from '../../shared/types';
import { captureFrame, download } from '../assets/actions';
import { promptOptional, runWorkflow } from '../workflows/actions';
import { openGenerator } from '../generation/openGenerator';
import { redoShot, regenerate, recomposeItem } from '../generation/tasks';
import { removeBackground, upscale } from '../generation/edits';
import { toScreen } from '../../shared/geometry';
import { unavailableReason } from '../generation/models';
import { removeItems, select, setComposer, toast, useStore } from '../store';
import { t } from '../i18n';

function useFeature(key: string): { ok: boolean; why?: string } {
  const caps = useStore((s) => s.caps);
  const missing = caps?.features[key];
  if (!caps || !missing) return { ok: true };
  if (!caps.comfyOnline) return { ok: false, why: t('ComfyUI 未连接') };
  if (!missing.length) return { ok: true };
  const reason = unavailableReason(missing, true);
  return { ok: false, why: missing.some(isBlock) ? t('{reason}（可在设置里关闭「只用可商用的模型」）', { reason }) : reason };
}

/** One row of the selected item's action menu. */
function Row(props: { icon: React.ReactNode; label: string; title: string; onClick: () => void; feature?: string; danger?: boolean }) {
  const f = useFeature(props.feature ?? '');
  return (
    <button className={`ia-row ${props.danger ? 'danger' : ''}`} title={f.ok ? props.title : f.why} disabled={!f.ok} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

/** Runs an imported workflow on this item, asking for whatever else it needs first. */
function applyTool(item: CanvasItem, wf: WorkflowLike) {
  const count = (t: string) => wf.inputs.filter((i) => i.type === t).length;
  if (count('mask')) {
    useStore.setState({ editing: { kind: 'custom', itemId: item.id, workflowId: wf.id } });
    return;
  }
  const slots = count('image') + count('video');
  if (slots > 1 || !promptOptional(wf)) {
    // Needs a prompt or more inputs: open the generator at the end of a new wire.
    setComposer({ mode: wf.kind, workflowId: wf.id });
    select([item.id]);
    openGenerator(item);
    toast(slots > 1 ? t('「{name}」还需要 {n} 个输入，按顺序选中后在生成节点里生成', { name: t(wf.name), n: slots - 1 }) : t('在生成节点里写提示词，然后生成「{name}」', { name: t(wf.name) }), 'info');
    return;
  }
  void runWorkflow(wf, item.kind === 'video' ? { images: [], videos: [item] } : { images: [item] });
}

/** Actions for the one selected item: a small button at its corner, opening a list instead of a bar across the picture. */
export function ItemToolbar() {
  const items = useStore((s) => s.items);
  const selection = useStore((s) => s.selection);
  const viewport = useStore((s) => s.viewport);
  const screen = useStore((s) => s.screen);
  const workflows = useStore((s) => s.workflows);
  const presets = useStore((s) => s.presets);
  const caps = useStore((s) => s.caps);
  const noteEditing = useStore((s) => s.noteEditing);
  const [open, setOpen] = useState(false);
  const single = selection.length === 1 ? selection[0] : null;

  // A different selection, or a click elsewhere, puts the list away.
  useEffect(() => setOpen(false), [single]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.ia-menu, .ia-trigger')) return setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!single) return null;
  const item = items.find((i) => i.id === single);
  if (!item) return null;
  const texty = (item.kind === 'text' || item.kind === 'prompt') && noteEditing !== item.id;
  if (!texty && !item.asset) return null;

  const s = toScreen(viewport, item);
  if (s.x + s.w < 0 || s.x > screen.w || s.y + s.h < 0 || s.y > screen.h) return null;

  const size = 28;
  const left = Math.min(Math.max(s.x + s.w - size, 8), Math.max(8, screen.w - size - 8));
  const top = s.y >= size + 16 ? s.y - size - 8 : Math.min(s.y + 8, Math.max(8, screen.h - size - 8));
  const menuW = 236;
  const menuLeft = Math.min(Math.max(s.x + s.w - menuW, 8), Math.max(8, screen.w - menuW - 8));
  const belowTop = top + size + 8;
  const opensDown = belowTop + 300 <= screen.h;
  const close = () => setOpen(false);
  const tools = texty ? [] : toolsFor(item, workflows, presets, caps);

  const menu = (
    <div
      className="ia-menu"
      data-ui
      style={{
        left: menuLeft,
        width: menuW,
        ...(opensDown ? { top: belowTop, maxHeight: Math.max(160, screen.h - belowTop - 12) } : { bottom: screen.h - top + 8, maxHeight: Math.max(160, top - 20) }),
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {texty ? (
        <>
          <Row icon={<Pencil />} label={t('编辑')} title={item.kind === 'prompt' ? t('编辑提示词（双击也可以）') : t('编辑文本（双击也可以）')} onClick={() => { close(); useStore.setState({ noteEditing: item.id }); }} />
          {item.kind === 'prompt' && (
            <Row icon={<Sparkles />} label={t('生成')} title={t('打开生成节点，用这段提示词生成')} onClick={() => { close(); openGenerator(item); }} />
          )}
          <div className="ia-sep" />
        </>
      ) : item.kind === 'video' ? (
        <>
          <Row icon={<Maximize2 />} label={t('预览')} title={t('带声音全屏播放（双击也可以）')} onClick={() => { close(); useStore.setState({ lightboxId: item.id }); }} />
          <Row icon={<Camera />} label={t('截取当前帧')} title={t('把视频当前画面存成图片，可用作下一段的首帧')} onClick={() => { close(); void captureFrame(item); }} />
          {items.some((other) => other.id !== item.id && other.cutList?.some((c) => c.id === item.id)) && (
            <Row icon={<RefreshCw />} label={t('只重做这一段')} title={t('沿用原 request 和首帧重新提交，其余节点不动')} onClick={() => { close(); redoShot(item); }} />
          )}
          <div className="ia-sep" />
        </>
      ) : (
        <>
          {[2, 4].map((k) => (
            <Row key={k} icon={<Sparkles />} label={t('{k} 倍超清', { k })} title={t('SeedVR2 超清放大')} feature="image.upscale" onClick={() => { close(); void upscale(item, k); }} />
          ))}
          <Row icon={<Expand />} label={t('扩图')} title={t('向外扩展画面')} feature="image.outpaint" onClick={() => { close(); useStore.setState({ editing: { kind: 'outpaint', itemId: item.id } }); }} />
          <Row icon={<Brush />} label={t('局部重绘')} title={t('涂抹区域并描述要画的内容')} feature="image.inpaint" onClick={() => { close(); useStore.setState({ editing: { kind: 'inpaint', itemId: item.id } }); }} />
          <Row icon={<Eraser />} label={t('消除')} title={t('涂抹要去掉的物体')} feature="image.erase" onClick={() => { close(); useStore.setState({ editing: { kind: 'erase', itemId: item.id } }); }} />
          <Row icon={<Scissors />} label={t('抠图')} title={t('去除背景，输出透明 PNG')} feature="image.removeBg" onClick={() => { close(); void removeBackground(item); }} />
          <Row icon={<Clapperboard />} label={t('生视频')} title={t('以这张图作为首帧生成视频')} onClick={() => { close(); setComposer({ mode: 'video', workflowId: '' }); openGenerator(item); }} />
          <div className="ia-sep" />
        </>
      )}
      {tools.length > 0 && (
        <>
          <div className="ia-group">{t('我的工具')}</div>
          {tools.map((w) => (
            <Row key={w.id} icon={<Puzzle />} label={`${t(w.name)}${w.inputs.some((i) => i.type === 'mask') ? ` · ${t('需涂抹')}` : ''}`} title={t('用导入的工作流处理它')} onClick={() => { close(); applyTool(item, w); }} />
          ))}
          <div className="ia-sep" />
        </>
      )}
      {!texty && item.cutList?.length ? <Row icon={<Film />} label={t('重拼')} title={t('用剪辑清单重新走同一套剪辑逻辑')} onClick={() => { close(); void recomposeItem(item); }} /> : null}
      {!texty && item.request && <Row icon={<RefreshCw />} label={t('用同样的设置再生成一个')} title={t('用同样的设置再生成一个')} onClick={() => { close(); void regenerate(item); }} />}
      <Row icon={<Info />} label={t('节点信息')} title={t('查看节点信息')} onClick={() => { close(); useStore.setState({ modal: { type: 'details', itemId: item.id } }); }} />
      {!texty && <Row icon={<Download />} label={t('下载')} title={t('下载')} onClick={() => { close(); download(item); }} />}
      <Row icon={<Trash2 />} label={t('删除')} title={t('删除')} danger onClick={() => { close(); removeItems([item.id]); }} />
    </div>
  );

  return (
    <>
      <button
        className={`ia-trigger ${open ? 'on' : ''}`}
        data-ui
        style={{ left, top }}
        title={t('更多操作')}
        aria-label={t('更多操作')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal />
      </button>
      {open && menu}
    </>
  );
}

/** Imported workflows and runnable presets that take this kind of item as input. */
function toolsFor(item: CanvasItem, workflows: WorkflowLike[], presets: WorkflowLike[], caps: ReturnType<typeof useStore.getState>['caps']): WorkflowLike[] {
  const takes = (w: WorkflowLike) => w.inputs.some((i) => i.type === (item.kind === 'video' ? 'video' : 'image'));
  return [...workflows.filter(takes), ...presets.filter((p) => takes(p) && caps?.comfyOnline && !caps.features[`custom:${p.id}`]?.length)];
}

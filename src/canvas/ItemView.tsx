import { AlertTriangle, Box, Download, FileText, Loader2, MessageSquareText, Music, RotateCcw, Trash2, Volume2, X } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { thumbUrl } from '../../shared/media';
import type { CanvasItem, Task } from '../../shared/types';
import { cancel, retry } from '../generation/tasks';
import { api } from '../lib/api';
import { patchItem, removeItems, updateItems, useStore } from '../store';
import { Markdown } from '../components/Markdown';
import { t } from '../i18n';

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return <span className="ph-elapsed">{s >= 60 ? t('{m}分{s}秒', { m: Math.floor(s / 60), s: s % 60 }) : t('{s}秒', { s })}</span>;
}

function Placeholder({ item, task }: { item: CanvasItem; task?: Task }) {
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  if (item.error) {
    return (
      <div className="ph ph-error">
        <div className="ph-inner">
          <AlertTriangle className="ph-icon" />
          <div className="ph-text" title={t(item.error)}>
            {t(item.error)}
          </div>
          <div className="ph-actions">
            {item.request && (
              <button className="ph-btn" onPointerDown={stop} onClick={() => retry(item)}>
                <RotateCcw /> {t('重试')}
              </button>
            )}
            <button className="ph-btn" onPointerDown={stop} onClick={() => removeItems([item.id])}>
              <Trash2 /> {t('删除')}
            </button>
          </div>
        </div>
      </div>
    );
  }
  const running = task?.status === 'running';
  const label = task?.stage ?? t('提交中…');
  const progress = task?.progress ?? 0;
  return (
    <div className={`ph ${running ? 'ph-running' : ''}`}>
      <div className="ph-inner">
        <Loader2 className="ph-icon spin" />
        <div className="ph-text">{label}</div>
        {task && (
          <div className="ph-meta">
            {running && task.startedAt ? <Elapsed since={task.startedAt} /> : null}
          </div>
        )}
      </div>
      {task && (
        <button className="ph-cancel" title={t('取消')} onPointerDown={stop} onClick={() => void cancel(item)}>
          <X />
        </button>
      )}
      <div className="ph-progress">
        <div style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </div>
  );
}

/** The thumbnail while the item is small on screen; the original once it is shown large (or the thumbnail fails). */
function ImageView({ item, full }: { item: CanvasItem; full: boolean }) {
  const [failed, setFailed] = useState(false);
  const asset = item.asset!;
  return (
    <img
      src={full || failed ? asset.url : thumbUrl(asset.url)}
      alt={item.name ?? ''}
      draggable={false}
      decoding="async"
      onError={() => !full && setFailed(true)}
    />
  );
}

/**
 * A frame while the video is small on screen; the player once it is shown large or hovered (then it plays).
 * A board of many clips would otherwise keep a decoder and a download going for each.
 */
function VideoView({ item, full }: { item: CanvasItem; full: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const asset = item.asset!;
  const [hover, setHover] = useState(false);
  // Some builds ship the clip without a thumbnail (the static demo does): fall back to its own frame.
  const [noThumb, setNoThumb] = useState(false);
  const live = full || hover || noThumb;
  useEffect(() => {
    if (hover) void ref.current?.play().catch(() => {});
    else ref.current?.pause();
  }, [hover, live]);
  return (
    <div className="video-view" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {live ? (
        <video
          ref={ref}
          src={asset.url}
          poster={thumbUrl(asset.url)}
          muted
          loop
          playsInline
          preload={noThumb ? 'auto' : 'metadata'}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            const duration = Math.round(v.duration * 10) / 10;
            const sized = v.videoWidth && v.videoHeight && (v.videoWidth !== asset.width || v.videoHeight !== asset.height);
            if (!sized && (!Number.isFinite(duration) || duration === asset.duration)) return;
            // Remembered on the item, so the badge shows without loading the video next time.
            const fixed = { ...asset, ...(sized ? { width: v.videoWidth, height: v.videoHeight } : {}), ...(Number.isFinite(duration) ? { duration } : {}) };
            patchItem(item.id, { asset: fixed, ...(sized ? { h: Math.round(item.w * (v.videoHeight / v.videoWidth)) } : {}) });
            if (sized) void api.setAssetSize(asset.id, v.videoWidth, v.videoHeight).catch(() => {});
          }}
        />
      ) : (
        <img src={thumbUrl(asset.url)} alt={item.name ?? ''} draggable={false} decoding="async" onError={() => setNoThumb(true)} />
      )}
      <div className="video-badge">
        {item.request?.op === 'video.generate' && <Volume2 />}
        {asset.duration ? `${asset.duration.toFixed(1)}s` : t('视频')}
      </div>
    </div>
  );
}

function NoteEditor({ item }: { item: CanvasItem }) {
  const [title, setTitle] = useState(item.name ?? '');
  const [text, setText] = useState(item.text ?? '');
  const done = () => {
    useStore.setState({ noteEditing: null });
    const name = title.trim() || undefined;
    if (name === item.name && text === (item.text ?? '')) return;
    updateItems((items) => items.map((i) => (i.id === item.id ? { ...i, name, text } : i)));
  };
  return (
    <div
      className="note editing"
      data-ui
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) done();
      }}
    >
      <input className="note-title" value={title} placeholder={t('标题')} onChange={(e) => setTitle(e.target.value)} />
      <textarea className="note-input" data-scrollable autoFocus value={text} placeholder={t('写点什么：剧本、分镜、备注…')} onChange={(e) => setText(e.target.value)} />
    </div>
  );
}

function PromptEditor({ item }: { item: CanvasItem }) {
  const [text, setText] = useState(item.text ?? '');
  const done = () => {
    useStore.setState({ noteEditing: null });
    if (text === (item.text ?? '')) return;
    updateItems((items) => items.map((i) => (i.id === item.id ? { ...i, text } : i)));
  };
  return (
    <div
      className="prompt editing"
      data-ui
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) done();
      }}
    >
      <div className="prompt-head">
        <MessageSquareText />
        <span>{t('提示词')}</span>
      </div>
      <textarea
        className="note-input"
        data-scrollable
        autoFocus
        value={text}
        placeholder={t('写一段提示词，例如：一只橘猫坐在窗台上，暖色夕阳')}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}

/** A prompt node: plain text that can be wired to pictures and clips; double-click to edit. */
function PromptView({ item }: { item: CanvasItem }) {
  const editing = useStore((s) => s.noteEditing === item.id);
  const selected = useStore((s) => s.selection.includes(item.id));
  if (editing) return <PromptEditor item={item} />;
  return (
    <div className="prompt">
      <div className="prompt-head">
        <MessageSquareText />
        <span>{t('提示词')}</span>
      </div>
      <div className="prompt-body" {...(selected ? { 'data-scrollable': true } : {})}>
        {item.text || <span className="note-empty">{t('双击编辑提示词')}</span>}
      </div>
    </div>
  );
}

/** Audio, 3D files and documents have no frame: show what they are and how to open them. */
function MediaName({ item }: { item: CanvasItem }) {
  return <span className="media-name">{item.name ?? item.asset!.url.split('/').pop()}</span>;
}

function AudioView({ item }: { item: CanvasItem }) {
  return (
    <div className="audio-view" onPointerDown={(e) => e.stopPropagation()}>
      <Music className="media-icon" />
      <MediaName item={item} />
      <audio src={item.asset!.url} controls preload="metadata" />
    </div>
  );
}

function Model3DView({ item }: { item: CanvasItem }) {
  const ext = item.asset!.url.split('.').pop()?.toUpperCase();
  return (
    <div className="model-view" onPointerDown={(e) => e.stopPropagation()}>
      <Box className="media-icon" />
      <MediaName item={item} />
      <small>{ext} · {t('3D 模型')}</small>
      <a className="media-open" href={item.asset!.url} download title={t('下载模型')}>
        <Download />
      </a>
    </div>
  );
}

function DocumentView({ item }: { item: CanvasItem }) {
  const asset = item.asset!;
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(asset.url)
      .then((r) => r.text())
      .then((value) => {
        if (!live) return;
        let shown = value.slice(0, 4096);
        if (/json/.test(asset.mime)) {
          try {
            shown = JSON.stringify(JSON.parse(value), null, 2).slice(0, 4096);
          } catch {
            /* show the raw text */
          }
        }
        setText(shown);
      })
      .catch(() => live && setText(''));
    return () => {
      live = false;
    };
  }, [asset.url, asset.mime]);
  return (
    <div className="doc-view" onPointerDown={(e) => e.stopPropagation()}>
      <div className="doc-head">
        <FileText className="media-icon" />
        <MediaName item={item} />
      </div>
      <pre>{text === null ? t('正在读取…') : text || t('空文件')}</pre>
    </div>
  );
}

/** A text item: title and light Markdown; double-click to edit. */
function NoteView({ item }: { item: CanvasItem }) {
  const editing = useStore((s) => s.noteEditing === item.id);
  const selected = useStore((s) => s.selection.includes(item.id));
  if (editing) return <NoteEditor item={item} />;
  return (
    <div className="note">
      {item.name && <div className="note-title">{item.name}</div>}
      {/* Scrolls (instead of panning the board) only once selected. */}
      <div className="note-body" {...(selected ? { 'data-scrollable': true } : {})}>
        {item.text ? <Markdown text={item.text} /> : <span className="note-empty">{t('双击编辑')}</span>}
      </div>
    </div>
  );
}

export const ItemView = memo(function ItemView({ item, task, full = true }: { item: CanvasItem; task?: Task; full?: boolean }) {
  if (item.kind === 'text' || item.kind === 'prompt') {
    return (
      <div
        className={`item ${item.kind === 'prompt' ? 'item-prompt' : 'item-note'}`}
        data-item-id={item.id}
        style={{ transform: `translate(${item.x}px, ${item.y}px)`, width: item.w, height: item.h }}
      >
        {item.kind === 'prompt' ? <PromptView item={item} /> : <NoteView item={item} />}
      </div>
    );
  }
  return (
    <div
      className={`item ${item.asset ? '' : 'item-pending'}`}
      data-item-id={item.id}
      style={{ transform: `translate(${item.x}px, ${item.y}px)`, width: item.w, height: item.h }}
    >
      {item.asset ? (
        item.kind === 'image' ? (
          <ImageView item={item} full={full} />
        ) : item.kind === 'video' ? (
          <VideoView item={item} full={full} />
        ) : item.kind === 'audio' ? (
          <AudioView item={item} />
        ) : item.kind === 'model3d' ? (
          <Model3DView item={item} />
        ) : (
          <DocumentView item={item} />
        )
      ) : (
        <Placeholder item={item} task={task} />
      )}
    </div>
  );
});

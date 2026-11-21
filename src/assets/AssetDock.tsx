import { Box, ChevronLeft, FileText, Film, ImagePlus, Images, Loader2, Music, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { AssetInfo, MediaKind } from '../../shared/types';
import { thumbUrl } from '../../shared/media';
import { addAssets, uploadFiles, UPLOAD_ACCEPT } from './actions';
import { Dropdown } from '../components/Dropdown';
import { api } from '../lib/api';
import { t } from '../i18n';
import { toast, useStore } from '../store';

const WIDTH_KEY = 'infinode:assets-width';
const MIN_WIDTH = 200;
const MAX_WIDTH = 420;

export const useAssetDock = create<{ open: boolean }>(() => ({ open: false }));

export function toggleAssets(open = !useAssetDock.getState().open) {
  useAssetDock.setState({ open });
}

function Preview({ asset }: { asset: AssetInfo }) {
  const [failed, setFailed] = useState(false);
  if (asset.kind === 'audio') return <div className="asset-fallback"><Music /></div>;
  if (asset.kind === 'model3d') return <div className="asset-fallback"><Box /></div>;
  if (asset.kind === 'document') return <div className="asset-fallback"><FileText /></div>;
  if (failed) return <div className="asset-fallback">{asset.kind === 'video' ? <Film /> : <Images />}</div>;
  if (asset.kind === 'video') {
    return <video src={asset.url} poster={thumbUrl(asset.url)} muted playsInline preload="metadata" onError={() => setFailed(true)} />;
  }
  return <img src={thumbUrl(asset.url)} alt={assetTitle(asset)} loading="lazy" onError={() => setFailed(true)} />;
}

function kindLabel(kind: MediaKind) {
  return kind === 'video' ? t('视频') : kind === 'audio' ? t('音频') : kind === 'model3d' ? t('3D') : kind === 'document' ? t('文本') : t('图片');
}
const pad = (n: number) => String(n).padStart(2, '0');

/** The name of a board node showing it, else its own (uploads keep the file name), else its type and when it was made. */
export function assetTitle(asset: AssetInfo): string {
  const name = asset.usage?.name ?? asset.name;
  if (name) return name;
  if (!asset.createdAt) return t('未命名资产');
  const d = new Date(asset.createdAt);
  return `${kindLabel(asset.kind)} · ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The asset library, docked to the left of the canvas; collapsible to a narrow rail and resizable. */
export function AssetDock() {
  const open = useAssetDock((s) => s.open);
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, saved)) : 240;
  });
  const widthRef = useRef(width);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => {
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w0 + (ev.clientX - x0)));
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
    <aside className="asset-dock" style={{ width }} data-ui>
      <div className="asset-resize" onPointerDown={startResize} title={t('拖动调整宽度')} />
      <AssetLibrary />
    </aside>
  );
}

function AssetLibrary() {
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [kind, setKind] = useState<'all' | MediaKind>('all');
  const [query, setQuery] = useState('');
  const [usage, setUsage] = useState<'all' | 'used' | 'unused'>('all');
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const itemCount = useStore((s) => s.items.length);

  const load = async () => {
    setLoading(true);
    try {
      setAssets(await api.assets());
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [itemCount]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const used = Boolean(asset.usage?.references);
      return (kind === 'all' || asset.kind === kind) && (usage === 'all' || (usage === 'used' ? used : !used)) && (!q || assetTitle(asset).toLowerCase().includes(q) || (asset.name ?? '').toLowerCase().includes(q));
    });
  }, [assets, kind, query, usage]);

  const upload = async (files: File[]) => {
    const imported = await uploadFiles(files);
    if (imported.length) toast(t('已导入 {n} 个资产', { n: imported.length }), 'success');
    await load();
  };

  const add = (asset: AssetInfo) => {
    addAssets([asset]);
    toast(t('已添加到画布'), 'success');
  };

  const remove = async (asset: AssetInfo) => {
    if (deleting) return;
    const used = asset.usage?.references ?? 0;
    const ask = used
      ? t('资产在 {n} 个节点中使用。删除后它会从资产库移除，画布上已有的这些节点仍会保留。', { n: used })
      : t('确定删除资产「{name}」？此操作不可撤销。', { name: assetTitle(asset) });
    if (!confirm(ask)) return;
    setDeleting(asset.id);
    try {
      await api.deleteAsset(asset.id);
      setAssets((all) => all.filter((a) => a.id !== asset.id));
      toast(used ? t('已从资产库移除') : t('资产已删除'), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <div className="asset-dock-head">
        <Images className="asset-dock-icon" />
        <span className="asset-dock-title">{t('资产库')}</span>
        <span className="asset-dock-count">{assets.length}</span>
        <span className="grow" />
        <button className="icon-btn small" title={t('刷新')} onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? 'spin' : ''} />
        </button>
        <button className="icon-btn small" title={t('收起资产库')} onClick={() => toggleAssets(false)}>
          <ChevronLeft />
        </button>
      </div>
      <div className="asset-dock-body">
        <div className="asset-library">
          <div className="asset-toolbar">
            <div className="asset-tabs">
              {(['all', 'image', 'video', 'audio', 'model3d', 'document'] as const).map((value) => (
                <button key={value} className={kind === value ? 'on' : ''} onClick={() => setKind(value)}>
                  {value === 'all' ? t('全部') : kindLabel(value)}
                </button>
              ))}
            </div>
            <label className="asset-search">
              <Search />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('搜索资产')} />
            </label>
            <span className="asset-select">
              <Dropdown
                value={usage}
                options={[
                  { value: 'all', label: t('全部资产') },
                  { value: 'used', label: t('已用于项目') },
                  { value: 'unused', label: t('未使用') },
                ]}
                onChange={(v) => setUsage(v as 'all' | 'used' | 'unused')}
              />
            </span>
            <button className="btn primary asset-upload" onClick={() => document.getElementById('asset-dock-upload')?.click()}>
              <ImagePlus /> {t('导入资产')}
            </button>
            <input
              id="asset-dock-upload"
              hidden
              type="file"
              accept={UPLOAD_ACCEPT}
              multiple
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                void upload(files);
              }}
            />
          </div>
          {loading && !assets.length ? (
            <div className="asset-empty">
              <Loader2 className="spin" />
              <span>{t('正在加载资产库…')}</span>
            </div>
          ) : visible.length ? (
            <div className="asset-grid" data-scrollable>
              {visible.map((asset) => (
                <div
                  key={asset.id}
                  className="asset-card"
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-infinode-asset', JSON.stringify(asset));
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => add(asset)}
                  onKeyDown={(e) => e.key === 'Enter' && add(asset)}
                  title={t('点击添加到画布，或拖到画布上')}
                >
                  <div className="asset-preview">
                    <Preview asset={asset} />
                    <button
                      className="asset-delete"
                      disabled={deleting === asset.id}
                      title={t('删除资产')}
                      aria-label={t('删除资产')}
                      onPointerDown={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(asset);
                      }}
                    >
                      {deleting === asset.id ? <Loader2 className="spin" /> : <Trash2 />}
                    </button>
                    <span className="asset-kind">{kindLabel(asset.kind)}</span>
                    <span className="asset-add">
                      <Plus />
                    </span>
                  </div>
                  <div className="asset-meta">
                    <strong title={assetTitle(asset)}>{assetTitle(asset)}</strong>
                    <small
                      title={
                        [
                          asset.width > 0 && asset.height > 0 ? `${asset.width} × ${asset.height}` : '',
                          asset.usage?.projects.map((p) => p.name).join(', '),
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      }
                    >
                      {asset.width > 0 && asset.height > 0 ? `${asset.width} × ${asset.height}` : kindLabel(asset.kind)}
                      {asset.usage?.references ? ` · ${t('{n} 次引用', { n: asset.usage.references })}` : ''}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="asset-empty">
              <Images />
              <strong>{query ? t('没有匹配的资产') : t('资产库还是空的')}</strong>
              <span>{query ? t('换个名称试试') : t('资产库还是空的')}</span>
            </div>
          )}
          <div className="asset-foot">{t('{n} 个资产', { n: visible.length })}</div>
        </div>
      </div>
    </>
  );
}

import { Box, Bot, Flame, Image as ImageIcon, Images, LayoutTemplate, Maximize2, MessageSquareText, Puzzle, Search, Settings as SettingsIcon, StickyNote, Workflow, ZoomIn } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AssetInfo } from '../shared/types';
import { addAssets } from './assets/actions';
import { assetTitle, toggleAssets } from './assets/AssetDock';
import { startReplication, toggleAgent } from './assistant/AgentPanel';
import { addNote, addPrompt, kindLabel } from './canvas/items';
import { ensureVisible, fitAll } from './canvas/view';
import { openGenerator } from './generation/openGenerator';
import { api } from './lib/api';
import { select, setComposer, useStore, zoomAt } from './store';
import { t } from './i18n';

interface Entry {
  key: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

const close = () => useStore.setState({ modal: null });

/** ⌘K: one place to find actions, assets, board nodes and workflows. */
export function CommandPalette() {
  const items = useStore((s) => s.items);
  const workflows = useStore((s) => s.workflows);
  const presets = useStore((s) => s.presets);
  const screen = useStore((s) => s.screen);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.assets().then(setAssets).catch(() => {});
  }, []);

  const entries = useMemo<Entry[]>(() => {
    const actions: Entry[] = [
      { key: 'fit', group: t('动作'), label: t('适应画布'), hint: '⇧1', icon: <Maximize2 />, run: fitAll },
      { key: '100', group: t('动作'), label: t('回到 100%'), hint: '⌘0', icon: <ZoomIn />, run: () => zoomAt(screen.w / 2, screen.h / 2, 1) },
      { key: 'prompt', group: t('动作'), label: t('添加提示词节点'), icon: <MessageSquareText />, run: () => addPrompt() },
      { key: 'note', group: t('动作'), label: t('添加文本节点'), icon: <StickyNote />, run: () => addNote() },
      { key: 'assets', group: t('动作'), label: t('展开或收起资产库'), hint: '⌘B', icon: <Images />, run: () => toggleAssets() },
      { key: 'assistant', group: t('动作'), label: t('展开或收起 Agent'), hint: '⌘J', icon: <Bot />, run: () => toggleAgent() },
      { key: 'replicate', group: t('动作'), label: t('爆款内容复刻'), icon: <Flame />, run: startReplication },
      { key: 'workflows', group: t('动作'), label: t('我的工作流'), icon: <Puzzle />, run: () => useStore.setState({ modal: { type: 'workflows' } }) },
      { key: 'presets', group: t('动作'), label: t('官方模板'), icon: <LayoutTemplate />, run: () => useStore.setState({ modal: { type: 'presets' } }) },
      { key: 'settings', group: t('动作'), label: t('设置'), icon: <SettingsIcon />, run: () => useStore.setState({ modal: { type: 'settings' } }) },
    ];
    const flows: Entry[] = [...workflows, ...presets].map((w) => ({
      key: `flow-${w.id}`,
      group: t('工作流'),
      label: w.name,
      hint: kindLabel(w.kind),
      icon: <Workflow />,
      run: () => {
        setComposer({ mode: w.kind, workflowId: w.id });
        openGenerator();
      },
    }));
    const nodes: Entry[] = items.map((item) => {
      const hint = item.kind === 'prompt' ? t('提示词') : item.kind === 'text' ? t('文本') : kindLabel(item.kind);
      const prompt = item.request && 'prompt' in item.request ? item.request.prompt : '';
      return {
        key: `node-${item.id}`,
        group: t('节点'),
        label: item.name ?? item.text?.slice(0, 40) ?? (prompt ?? '').slice(0, 40) ?? '',
        hint,
        icon: <Box />,
        run: () => {
          select([item.id]);
          ensureVisible(item);
        },
      };
    });
    const files: Entry[] = assets.map((asset) => ({
      key: `asset-${asset.id}`,
      group: t('资产'),
      label: assetTitle(asset),
      hint: kindLabel(asset.kind),
      icon: <ImageIcon />,
      run: () => addAssets([asset]),
    }));
    return [...actions, ...flows, ...nodes.map((n) => ({ ...n, label: n.label || n.hint || '' })), ...files];
  }, [items, workflows, presets, assets, screen.w, screen.h]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries.slice(0, 14);
    return entries.filter((entry) => `${entry.label} ${entry.group} ${entry.hint ?? ''}`.toLowerCase().includes(q)).slice(0, 20);
  }, [entries, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  const run = (entry: Entry) => {
    close();
    entry.run();
  };

  return (
    <div className="palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true">
        <div className="palette-input">
          <Search />
          <input
            autoFocus
            value={query}
            placeholder={t('搜索动作、资产、节点或工作流')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                close();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter' && results[active]) {
                e.preventDefault();
                run(results[active]);
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={list} data-scrollable>
          {results.length ? (
            results.map((entry, i) => (
              <button key={entry.key} className={`palette-item ${i === active ? 'on' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => run(entry)}>
                <span className="palette-icon">{entry.icon}</span>
                <span className="palette-label">{entry.label}</span>
                {entry.hint && <span className="palette-hint">{entry.hint}</span>}
                <span className="palette-group">{entry.group}</span>
              </button>
            ))
          ) : (
            <div className="palette-empty">{t('没有匹配项')}</div>
          )}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t('选择')}
          </span>
          <span>
            <kbd>↵</kbd> {t('打开')}
          </span>
          <span>
            <kbd>esc</kbd> {t('关闭')}
          </span>
        </div>
      </div>
    </div>
  );
}

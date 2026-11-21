import { Layers, Monitor, Pin, Plus, Trash2, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  type AgentMemories,
  type AgentMemory,
  ENTITY_KINDS,
  ENTITY_NAME_CHARS,
  ENTITY_SUMMARY_CHARS,
  ENTRY_CHARS,
  MAX_ENTITIES,
  MEMORY_LIMIT,
  MEMORY_TYPES,
  type MemoryEntity,
  type MemoryEntityKind,
  type MemoryEntry,
  type MemoryPromotion,
  type MemoryRef,
  type MemoryScope,
  type MemorySource,
  type MemoryType,
  type Series,
  isActiveEntity,
  isActiveMemory,
  memorySimilarity,
} from '../../shared/types';
import { Modal } from '../components/Modal';
import { Dropdown } from '../components/Dropdown';
import { api } from '../lib/api';
import { toast, useStore } from '../store';
import { t } from '../i18n';

const TYPE_LABEL: Record<MemoryType, string> = { setting: t('设定'), decision: t('决定'), preference: t('偏好'), feedback: t('纠正') };
const ENTITY_KIND_LABEL: Record<MemoryEntityKind, string> = {
  character: t('人物'),
  scene: t('场景'),
  prop: t('道具'),
  style: t('风格'),
};
const SCOPE_ICON: Record<MemoryScope, React.ReactNode> = {
  user: <User />,
  series: <Layers />,
  board: <Monitor />,
};
const SOURCE_LABEL: Record<MemorySource['kind'], string> = {
  chat: t('对话'),
  review: t('复盘'),
  condense: t('整理'),
  user: t('用户'),
};
/** The page reads in this order: what is shared widest first. */
const SCOPES: MemoryScope[] = ['user', 'series', 'board'];

const activeSize = (entries: MemoryEntry[]) =>
  entries.filter(isActiveMemory).reduce((n, e) => n + e.text.trim().length + (e.why?.trim().length ?? 0), 0);
const when = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** The source and certainty of an entry, for the line above its text. */
const originOf = (e: MemoryEntry) => {
  const kind = e.source?.kind ?? (e.by === 'user' ? 'user' : 'chat');
  const certainty = Math.round((e.confidence ?? (e.by === 'user' ? 1 : 0.7)) * 100);
  return { source: SOURCE_LABEL[kind], certainty };
};

/**
 * Active entries in one scope that say nearly the same thing, by the newer one's index: the older index,
 * its text and how alike they are. One entry shows at most one such warning.
 */
function nearDuplicates(entries: MemoryEntry[]): Map<number, { index: number; text: string; sim: number }> {
  const out = new Map<number, { index: number; text: string; sim: number }>();
  const active = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => isActiveMemory(e) && e.at > 0 && Boolean(e.text.trim()));
  for (let a = 0; a < active.length; a++) {
    for (let b = a + 1; b < active.length; b++) {
      const x = active[a];
      const y = active[b];
      if ((x.e.entityId ?? '') !== (y.e.entityId ?? '')) continue;
      const sim = memorySimilarity(x.e.text, y.e.text);
      if (sim < 0.72) continue;
      const newer = x.e.at >= y.e.at ? x : y;
      const older = newer === x ? y : x;
      if (!out.has(newer.i)) out.set(newer.i, { index: older.i, text: older.e.text, sim });
    }
  }
  return out;
}

/**
 * What the assistant remembers across conversations, both scopes: read, edit, delete, add, pin, and whether
 * it may write there on its own. Entries the assistant replaces stay in the history; only active ones are
 * sent to the model. The assistant reads the edit with the next message.
 *
 * A board also lists its entities (characters, places, props, looks). Facts can be attached to one; those are
 * read on demand instead of riding in every request.
 */
export function MemoryModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [memory, setMemory] = useState<AgentMemories | null>(null);
  const [saved, setSaved] = useState<AgentMemories | null>(null);
  const [busy, setBusy] = useState(false);
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [promotions, setPromotions] = useState<MemoryPromotion[]>([]);
  const [newSeries, setNewSeries] = useState('');
  const [tab, setTab] = useState<MemoryScope>('user');
  const items = useStore((s) => s.items);
  useEffect(() => {
    Promise.all([api.agentMemory(projectId), api.series(), api.memoryPromotions(projectId)])
      .then(([m, list, next]) => {
        setMemory(m);
        setSaved(m);
        setSeriesList(list);
        setPromotions(next);
      })
      .catch((err) => {
        toast((err as Error).message, 'error');
        onClose();
      });
  }, [projectId, onClose]);

  const change = (scope: MemoryScope, next: Partial<AgentMemory>) => setMemory((m) => m && { ...m, [scope]: { ...m[scope], ...next } });
  const edit = (scope: MemoryScope, i: number, patch: Partial<MemoryEntry>) =>
    memory && change(scope, { entries: memory[scope].entries.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
  const remove = (scope: MemoryScope, i: number) => memory && change(scope, { entries: memory[scope].entries.filter((_, j) => j !== i) });
  const editEntity = (scope: MemoryScope, i: number, patch: Partial<MemoryEntity>) =>
    memory && change(scope, { entities: memory[scope].entities.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
  const removeEntity = (scope: MemoryScope, i: number) => memory && change(scope, { entities: memory[scope].entities.filter((_, j) => j !== i) });
  const addEntity = (scope: MemoryScope) =>
    memory &&
    change(scope, {
      entities: [...memory[scope].entities, { id: '', kind: 'character', name: '', summary: '', refs: [], at: 0, by: 'user' }],
    });
  /** Keeps the newer of two near-identical entries and archives the older, out of the prompt but in history. */
  const archiveOlder = (scope: MemoryScope, older: number) =>
    memory && change(scope, { entries: memory[scope].entries.map((e, j) => (j === older ? { ...e, archived: true } : e)) });
  /** A setting several boards share, added to the series list; the user still saves the page. */
  const promote = (candidate: MemoryPromotion) => {
    if (!memory) return;
    change('series', {
      entries: [
        ...memory.series.entries,
        {
          id: '',
          type: candidate.type,
          text: candidate.text,
          ...(candidate.why ? { why: candidate.why } : {}),
          at: 0,
          by: 'user',
          confidence: 1,
          source: { kind: 'user' as const },
        },
      ],
    });
    setPromotions((list) => list.filter((p) => p !== candidate));
    toast(t('已加到系列记忆，保存后生效'), 'success');
  };

  /** Joining or leaving a series reloads the page: its memory is shared with other boards. */
  const moveToSeries = async (seriesId: string | null) => {
    setBusy(true);
    try {
      await api.setProjectSeries(projectId, seriesId);
      const m = await api.agentMemory(projectId);
      setMemory(m);
      setSaved(m);
      toast(seriesId ? t('已加入系列') : t('已退出系列'), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const createSeries = async () => {
    const name = newSeries.trim();
    if (!name) return;
    setBusy(true);
    try {
      const series = await api.createSeries(name);
      setSeriesList((list) => [series, ...list]);
      setNewSeries('');
      await moveToSeries(series.id);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!memory || !saved) return;
    setBusy(true);
    try {
      for (const scope of SCOPES) {
        if (scope === 'series' && !memory.seriesInfo) continue;
        if (JSON.stringify(memory[scope]) === JSON.stringify(saved[scope])) continue;
        await api.saveAgentMemory(projectId, scope, memory[scope]);
      }
      toast(t('记忆已保存，助手下一条消息就会用上'), 'success');
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  /** What a ref points at, when the item or asset is still on this board. */
  const refOf = (ref: MemoryRef) => {
    const item = ref.itemId ? items.find((i) => i.id === ref.itemId) : undefined;
    const holder = item ?? (ref.assetId ? items.find((i) => i.asset?.id === ref.assetId) : undefined);
    return { name: holder?.name || holder?.asset?.name || ref.itemId || ref.assetId || '', url: holder?.asset?.url };
  };

  /** Pin, delete: quiet until the card is hovered. */
  const icons = (pinned: boolean, onPin: () => void, onDelete: () => void) => (
    <>
      <button className={`mem-icon ${pinned ? 'on' : ''}`} title={pinned ? t('取消置顶') : t('置顶')} onClick={onPin}>
        <Pin />
      </button>
      <button className="mem-icon danger" title={t('删除')} onClick={onDelete}>
        <Trash2 />
      </button>
    </>
  );

  return (
    <Modal
      title={t('记忆')}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t('取消')}
          </button>
          <button className="btn primary" disabled={!memory || busy} onClick={() => void save()}>
            {t('保存')}
          </button>
        </>
      }
    >
      <div className="mem-page">
        <div className="mem-tabs" role="tablist">
          {SCOPES.map((scope) => (
            <button key={scope} role="tab" aria-selected={tab === scope} className={`mem-tab ${tab === scope ? 'on' : ''}`} onClick={() => setTab(scope)}>
              {SCOPE_ICON[scope]}
              {scope === 'user' ? t('偏好') : scope === 'series' ? t('系列') : t('这块画布')}
            </button>
          ))}
        </div>
        {memory && (
          <>
            {SCOPES.map((scope) => {
              if (scope !== tab) return null;
              const m = memory[scope];
              if (scope === 'series' && !memory.seriesInfo) {
                return (
                  <section key={scope} className="mem-pane">
                    <div className="mem-inline">
                      <Dropdown
                        value=""
                        title={t('加入系列')}
                        options={[{ value: '', label: t('加入系列') }, ...seriesList.map((s) => ({ value: s.id, label: s.name }))]}
                        onChange={(id) => id && void moveToSeries(id)}
                      />
                      <input className="mem-input mem-grow" value={newSeries} maxLength={60} placeholder={t('新建系列')} onChange={(ev) => setNewSeries(ev.target.value)} />
                      <button className="btn ghost small" disabled={busy || !newSeries.trim()} onClick={() => void createSeries()}>
                        <Plus /> {t('新建并加入')}
                      </button>
                    </div>
                  </section>
                );
              }
              const used = activeSize(m.entries);
              const near = nearDuplicates(m.entries);
              const active = m.entries.map((e, i) => ({ e, i })).filter(({ e }) => isActiveMemory(e));
              const history = m.entries.map((e, i) => ({ e, i })).filter(({ e }) => !isActiveMemory(e));
              const entities = (m.entities ?? []).map((e, i) => ({ e, i }));
              const live = entities.filter(({ e }) => isActiveEntity(e));
              const archived = entities.filter(({ e }) => !isActiveEntity(e));
              return (
                <section key={scope} className="mem-pane">
                  <div className="mem-bar">
                    <span className={`mem-size ${used > MEMORY_LIMIT[scope] ? 'over' : ''}`}>{t('{used}/{limit} 字', { used, limit: MEMORY_LIMIT[scope] })}</span>
                    <label className="mem-auto">
                      <input type="checkbox" checked={m.auto} onChange={(e) => change(scope, { auto: e.target.checked })} />
                      <span>{t('让助手自动记')}</span>
                    </label>
                  </div>
                  {scope === 'series' && memory.seriesInfo && (
                    <div className="mem-note">
                      <span>
                        {t('属于「{name}」，和 {n} 块画布共享：{boards}', {
                          name: memory.seriesInfo.name,
                          n: memory.seriesInfo.projects.length,
                          boards: memory.seriesInfo.projects.map((p) => p.name).join(t('、')),
                        })}
                      </span>
                      <button className="btn ghost small" disabled={busy} onClick={() => void moveToSeries(null)}>
                        {t('退出系列')}
                      </button>
                    </div>
                  )}
                  {scope === 'series' && promotions.length > 0 && (
                    <div className="mem-promos">
                      <div className="mem-note">{t('这几条在多块画布上分别记过：提升到系列后，系列里的画布都会用，不用各记一份。')}</div>
                      {promotions.map((candidate) => (
                        <div key={`${candidate.text}-${candidate.at}`} className="mem-card mem-promo">
                          <div className="mem-row">
                            <span className="mem-meta">
                              {TYPE_LABEL[candidate.type]} · {t('出现在：{boards}', { boards: candidate.boards.map((b) => b.name).join(t('、')) })}
                            </span>
                            <button className="btn ghost small" disabled={busy} onClick={() => promote(candidate)}>
                              {t('提升到系列')}
                            </button>
                          </div>
                          <div className="mem-old-line">{candidate.text}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {scope !== 'user' && (
                    <div className="mem-sub">
                      <div className="mem-sub-head">
                        <b>{t('设定条目')}</b>
                        <span className="mem-size">{t('{n}/{limit} 个', { n: live.length, limit: MAX_ENTITIES })}</span>
                      </div>
                      <div className="mem-help">{t('只有名字和简介会进提示词。')}</div>
                      {!live.length && <div className="mem-empty">{t('还没有设定条目')}</div>}
                      {live.map(({ e, i }) => (
                        <div key={e.id || `entity-${i}`} className="mem-card">
                          <div className="mem-row">
                            <span className="mem-dd mem-type">
                              <Dropdown
                                value={e.kind}
                                options={ENTITY_KINDS.map((kind) => ({ value: kind, label: ENTITY_KIND_LABEL[kind] }))}
                                onChange={(kind) => editEntity(scope, i, { kind })}
                              />
                            </span>
                            <input
                              className="mem-input mem-name"
                              value={e.name}
                              maxLength={ENTITY_NAME_CHARS}
                              placeholder={t('名字，比如：林晚')}
                              onChange={(ev) => editEntity(scope, i, { name: ev.target.value })}
                            />
                            <span className="mem-meta">{e.at ? `${e.by === 'user' ? t('你写的') : t('助手记的')} · ${when(e.at)}` : t('新的')}</span>
                            {icons(Boolean(e.pinned), () => editEntity(scope, i, { pinned: !e.pinned }), () => removeEntity(scope, i))}
                          </div>
                          <textarea
                            className="mem-body"
                            value={e.summary}
                            rows={2}
                            maxLength={ENTITY_SUMMARY_CHARS}
                            placeholder={t('一句简介，一眼能认出它是什么')}
                            onChange={(ev) => editEntity(scope, i, { summary: ev.target.value })}
                          />
                          {e.refs.length > 0 && (
                            <div className="mem-refs">
                              <span className="mem-refs-label">{t('关联')}</span>
                              {e.refs.map((ref, j) => {
                                const at = refOf(ref);
                                return (
                                  <span
                                    key={`${ref.itemId ?? ref.assetId}-${j}`}
                                    className="mem-ref"
                                    title={[ref.itemId && t('节点 {id}', { id: ref.itemId }), ref.assetId && t('素材 {id}', { id: ref.assetId })]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  >
                                    {at.url && <img src={at.url} alt="" />}
                                    {at.name}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                      <button className="mem-add" disabled={live.length >= MAX_ENTITIES} onClick={() => addEntity(scope)}>
                        <Plus /> {t('添加设定条目')}
                      </button>
                    </div>
                  )}
                  {!active.length && <div className="mem-empty">{t('还没有记下任何东西')}</div>}
                  {active.map(({ e, i }) => {
                    const origin = originOf(e);
                    const clash = near.get(i);
                    return (
                      <div key={e.id || `new-${i}`} className="mem-card">
                        <div className="mem-row">
                          <span className="mem-dd mem-type">
                            <Dropdown
                              value={e.type}
                              options={MEMORY_TYPES[scope].map((type) => ({ value: type, label: TYPE_LABEL[type] }))}
                              onChange={(type) => edit(scope, i, { type })}
                            />
                          </span>
                          {scope !== 'user' && live.length > 0 && (
                            <span className="mem-dd mem-link">
                              <Dropdown
                                value={e.entityId ?? ''}
                                options={[
                                  { value: '', label: t('不挂到条目') },
                                  ...live.map(({ e: entity }) => ({ value: entity.id, label: `${ENTITY_KIND_LABEL[entity.kind]} · ${entity.name}` })),
                                ]}
                                onChange={(id) => edit(scope, i, { entityId: id || undefined })}
                              />
                            </span>
                          )}
                          <span className="mem-meta">
                            {e.at ? `${e.by === 'user' ? t('你写的') : t('助手记的')} · ${origin.source} · ${when(e.at)}` : t('新的')}
                            {e.at && e.by === 'assistant' ? ` · ${t('可信度 {n}%', { n: origin.certainty })}` : ''}
                            {e.invalidAt ? ` · ${t('已失效')}` : ''}
                          </span>
                          {icons(Boolean(e.pinned), () => edit(scope, i, { pinned: !e.pinned }), () => remove(scope, i))}
                        </div>
                        <textarea className="mem-body" value={e.text} rows={2} maxLength={ENTRY_CHARS} placeholder={t('记什么，一句话')} onChange={(ev) => edit(scope, i, { text: ev.target.value })} />
                        <input className="mem-why" value={e.why ?? ''} maxLength={ENTRY_CHARS} placeholder={t('原因（可选）')} onChange={(ev) => edit(scope, i, { why: ev.target.value })} />
                        {clash && (
                          <div className="mem-conflict">
                            <span>{t('可能和「{text}」重复（{sim}% 相近）', { text: clash.text, sim: Math.round(clash.sim * 100) })}</span>
                            <button className="btn ghost small" disabled={busy} onClick={() => archiveOlder(scope, clash.index)}>
                              {t('保留较新的，归档旧的')}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <button
                    className="mem-add"
                    onClick={() =>
                      change(scope, {
                        entries: [...m.entries, { id: '', type: MEMORY_TYPES[scope][0], text: '', at: 0, by: 'user', pinned: false, source: { kind: 'user' } }],
                      })
                    }
                  >
                    <Plus /> {t('添加一条')}
                  </button>
                  {(history.length > 0 || archived.length > 0) && (
                    <details className="mem-history">
                      <summary>{t('历史（{n} 条，不发给助手）', { n: history.length + archived.length })}</summary>
                      {archived.map(({ e, i }) => (
                        <div key={e.id || `old-entity-${i}`} className="mem-card mem-old">
                          <div className="mem-row">
                            <span className="mem-meta">
                              {ENTITY_KIND_LABEL[e.kind]} · {t('已归档')} · {when(e.at)}
                            </span>
                            <button className="mem-icon danger" title={t('删除')} onClick={() => removeEntity(scope, i)}>
                              <Trash2 />
                            </button>
                          </div>
                          <div className="mem-old-line">{e.name}</div>
                          {e.summary && <div className="mem-old-line">{e.summary}</div>}
                        </div>
                      ))}
                      {history.map(({ e, i }) => (
                        <div key={e.id || `old-${i}`} className="mem-card mem-old">
                          <div className="mem-row">
                            <span className="mem-meta">
                              {TYPE_LABEL[e.type]} · {e.archived ? t('已归档') : t('已失效')} · {when(e.at)}
                            </span>
                            <button className="mem-icon danger" title={t('删除')} onClick={() => remove(scope, i)}>
                              <Trash2 />
                            </button>
                          </div>
                          <div className="mem-old-line">{e.text}</div>
                          {e.why && <div className="mem-old-line">{e.why}</div>}
                        </div>
                      ))}
                    </details>
                  )}
                </section>
              );
            })}
          </>
        )}
      </div>
    </Modal>
  );
}

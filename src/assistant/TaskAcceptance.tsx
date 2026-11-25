import { useState } from 'react';
import type { AgentTaskGraph } from '../../shared/types';
import { api } from '../lib/api';
import { t } from '../i18n';
import { toast } from '../store';
import { revealItems } from '../canvas/view';

/** Human judgments are sent directly to the local API, never synthesized by the model. */
export function TaskAcceptance({ graph, projectId, sessionId, running, changed }: {
  graph: AgentTaskGraph | null; projectId: string; sessionId: string; running: boolean;
  changed: (graph: AgentTaskGraph) => void;
}) {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState('');
  const tasks = graph?.tasks.filter((task) => ['reviewing', 'completed'].includes(task.status) && task.acceptanceCriteria.some((criterion) => criterion.validator?.kind === 'user')) ?? [];
  if (!graph || !tasks.length) return null;
  async function feedback(taskId: string, criterionId: string, verdict: 'pass' | 'fail') {
    if (!graph || pending) return;
    const signature = graph.tasks.find((task) => task.id === taskId)?.reviewSignatures?.[criterionId];
    if (!signature) return;
    setPending(true);
    try {
      changed(await api.taskFeedback(projectId, taskId, { sessionId, revision: graph.revision, criterionId, signature, verdict, note: note.trim() || (verdict === 'pass' ? t('认可当前结果') : t('需要修改')) }));
      setNote('');
      toast(t('反馈已记录，发送消息继续'));
    } catch (error) { toast((error as Error).message, 'error'); }
    finally { setPending(false); }
  }
  return <section className="agent-acceptance" aria-label={t('用户验收')}>
    <b>{t('用户验收')}</b>
    <div className="agent-acceptance-list">
      {tasks.map((task) => <div key={task.id}>
        <button className="agent-acceptance-target" onClick={() => revealItems(task.outputs)}>{task.objective}</button>
        {task.acceptanceCriteria.filter((criterion) => criterion.validator?.kind === 'user').map((criterion) => <div className="agent-acceptance-row" key={criterion.id}>
          <span>{criterion.description}</span>
          <button disabled={running || pending || !task.reviewSignatures?.[criterion.id]} onClick={() => void feedback(task.id, criterion.id, 'pass')}>{t('认可当前结果')}</button>
          <button disabled={running || pending || !task.reviewSignatures?.[criterion.id]} onClick={() => void feedback(task.id, criterion.id, 'fail')}>{t('需要修改')}</button>
        </div>)}
      </div>)}
    </div>
    <input aria-label={t('验收备注')} placeholder={t('验收备注（可选）')} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} disabled={pending} />
  </section>;
}

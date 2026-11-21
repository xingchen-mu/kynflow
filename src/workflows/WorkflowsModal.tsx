import { Download, FileJson, Pencil, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { msg } from '../../shared/i18n';
import type { CustomWorkflow, WorkflowCapability, WorkflowInputType } from '../../shared/types';
import { loadWorkflows } from './actions';
import { api } from '../lib/api';
import { unavailableReason } from '../generation/models';
import { setComposer, toast, useStore } from '../store';
import { openGenerator } from '../generation/openGenerator';
import { kindLabel } from '../canvas/items';
import { rich, t } from '../i18n';
import { Modal } from '../components/Modal';

const close = () => useStore.setState({ modal: null });
const CAPABILITY_LABELS: Record<WorkflowCapability, string> = {
  text_to_image: msg('文生图'),
  image_edit: msg('图生图/编辑'),
  inpaint: msg('局部重绘'),
  upscale: msg('放大'),
  remove_background: msg('抠图'),
  text_to_video: msg('文生视频'),
  image_to_video: msg('图生视频'),
  video_edit: msg('视频编辑'),
  text_to_audio: msg('文生音频'),
  text_to_3d: msg('文生 3D'),
  text_to_document: msg('文生文本'),
  other: msg('其它'),
};
const CAPABILITY_SOURCE = { declared: msg('用户确认'), inferred: msg('自动推断'), degraded: msg('节点信息不完整') } as const;
const COST_LABEL = { low: msg('低成本'), medium: msg('中成本'), high: msg('高成本') } as const;

function capabilitySummary(wf: CustomWorkflow) {
  const info = wf.capability;
  if (!info) return t('能力未标注');
  const parts = [t(CAPABILITY_LABELS[info.capability]), t(CAPABILITY_SOURCE[info.source])];
  if (info.cost) parts.push(t(COST_LABEL[info.cost]));
  if (info.expected_seconds) parts.push(t('预计 GPU {n} 秒', { n: info.expected_seconds }));
  return parts.join(' · ');
}

function inputSummary(wf: CustomWorkflow) {
  const count = (type: WorkflowInputType) => wf.inputs.filter((i) => i.type === type).length;
  const parts: string[] = [];
  if (count('prompt')) parts.push(t('提示词'));
  const images = count('image');
  const videos = count('video');
  const minImages = wf.capability?.constraints.min_images ?? wf.inputs.filter((i) => i.type === 'image' && !i.optional).length;
  const minVideos = wf.capability?.constraints.min_videos ?? wf.inputs.filter((i) => i.type === 'video' && !i.optional).length;
  if (images) parts.push(images === minImages ? t('{n} 张图', { n: images }) : t('图片 {min}–{max} 张', { min: minImages, max: images }));
  if (videos) parts.push(videos === minVideos ? t('{n} 个视频', { n: videos }) : t('视频 {min}–{max} 个', { min: minVideos, max: videos }));
  if (count('mask')) parts.push(t('蒙版'));
  if (wf.capability?.constraints.controls_aspect) parts.push(t('可调比例'));
  const params = wf.inputs.filter((i) => ['number', 'text', 'select', 'boolean'].includes(i.type)).length;
  if (params) parts.push(t('{n} 个参数', { n: params }));
  return parts.join(' · ') || t('无输入');
}

function exportWorkflow(wf: CustomWorkflow) {
  const data = {
    format: 'infinode/workflow',
    version: 1,
    name: wf.name,
    description: wf.description,
    kind: wf.kind,
    graph: wf.graph,
    inputs: wf.inputs,
    outputs: wf.outputs,
    ...(wf.capability?.source === 'declared' ? { capability: wf.capability } : {}),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${wf.name.replace(/[\\/:*?"<>|]+/g, '_')}.infinode.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importFile(file: File) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    toast(t('{name} 不是有效的 JSON', { name: file.name }), 'error');
    return;
  }
  try {
    const draft = await api.draftWorkflow(parsed, file.name);
    useStore.setState({ modal: { type: 'editor', draft } });
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

export function WorkflowsModal() {
  const workflows = useStore((s) => s.workflows);
  const caps = useStore((s) => s.caps);
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const edit = async (wf: CustomWorkflow) => {
    try {
      useStore.setState({ modal: { type: 'editor', draft: await api.workflowDraft(wf.id), id: wf.id } });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const remove = async (wf: CustomWorkflow) => {
    if (!confirm(t('删除工作流「{name}」？画布上已经生成的内容不受影响。', { name: t(wf.name) }))) return;
    await api.deleteWorkflow(wf.id);
    await loadWorkflows();
  };
  const use = (wf: CustomWorkflow) => {
    setComposer({ mode: wf.kind, workflowId: wf.id });
    close();
    openGenerator();
  };

  return (
    <Modal
      title={t('我的工作流')}
      onClose={close}
      wide
      footer={
        <>
          <span className="m-help">{t('支持 ComfyUI「导出 (API)」的 JSON，和这里导出的 .infinode.json')}</span>
          <button className="btn primary" onClick={() => input.current?.click()}>
            <Upload /> {t('导入工作流')}
          </button>
        </>
      }
    >
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importFile(f);
        }}
      />
      <div
        className={`wf-drop ${dragging ? 'on' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) void importFile(f);
        }}
        onClick={() => input.current?.click()}
      >
        <FileJson />
        <div>
          <b>{t('把工作流 JSON 拖到这里')}</b>{t('，或点击选择文件')}
          <small>{t('在 ComfyUI 中打开工作流 → 菜单「工作流 / Workflow」→「导出 (API) / Export (API)」')}</small>
        </div>
      </div>

      {workflows.length === 0 ? (
        <div className="m-help wf-empty">
          {t('还没有导入的工作流。导入后会出现在生成节点的模型列表里，选中画布上的图片即可作为它的输入。')}
          <br />
          {rich(t('小技巧：在 ComfyUI 里把节点标题改成 {0}、{1}、{2}、{3}、{4}、{5}，导入时会按标题识别。'), [
            <code>@prompt</code>,
            <code>@image</code>,
            <code>{t('@image:人物')}</code>,
            <code>@negative</code>,
            <code>@seed</code>,
            <code>@output</code>,
          ])}
        </div>
      ) : (
        <div className="wf-list">
          {workflows.map((wf) => {
            const missing = caps?.features[`custom:${wf.id}`];
            const bad = caps?.comfyOnline && missing && missing.length > 0;
            return (
              <div key={wf.id} className="wf-row">
                <div className="wf-main">
                  <div className="wf-name">
                    {t(wf.name)}
                    <span className="badge">{kindLabel(wf.kind)}</span>
                  </div>
                  <div className="wf-meta">{capabilitySummary(wf)} · {inputSummary(wf)}</div>
                  {bad && <div className="wf-bad">{unavailableReason(missing!)}</div>}
                </div>
                <button className="btn ghost small" onClick={() => use(wf)} disabled={Boolean(bad)}>
                  {t('使用')}
                </button>
                <button className="icon-btn" title={t('编辑映射')} onClick={() => void edit(wf)}>
                  <Pencil />
                </button>
                <button className="icon-btn" title={t('导出分享')} onClick={() => exportWorkflow(wf)}>
                  <Download />
                </button>
                <button className="icon-btn danger" title={t('删除')} onClick={() => void remove(wf)}>
                  <Trash2 />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

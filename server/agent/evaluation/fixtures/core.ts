import type { AgentBenchmarkCase, BenchmarkStep } from '../types.ts';

const budget = { toolCalls: 18, modelCalls: 20, tokens: 160000, durationMs: 120000, generations: 4 };
const step = (tool: string, args: Record<string, unknown>): BenchmarkStep => ({ tool, args });
const workflows = (capability: string, images = 1) => step('list_workflows', { capability, image_count: images, video_count: 0 });
const run = (workflow_id: string, extra: Record<string, unknown> = {}) => step('run_workflow', { workflow_id, image_ids: ['image-a'], ...extra });
const wait = () => step('wait_for_items', { ids: ['$generated'], timeout_seconds: 10 });
const checks = (workflow: string) => [
  { kind: 'tool' as const, tools: ['run_workflow'], where: { workflow_id: workflow, image_ids: ['image-a'] }, min: 1 },
  { kind: 'generation' as const, min: 1, max: 1, reference: 'image-a' },
  { kind: 'preserve' as const, ids: ['image-a', 'image-b', 'image-c'] },
];

/** Authored expected behavior is fixed independently of live model responses. No generated quality labels. */
export const CORE_BENCHMARK_CASES: AgentBenchmarkCase[] = [
  { id: 'intent-upscale', dimension: 'intent', request: '把选中的图片用超分工作流放大 2 倍，保持原有内容，不要重新生图。', selection: ['image-a'], checks: checks('eval-upscale'), script: [workflows('upscale'), run('eval-upscale', { params: { scale: 2 } }), wait()], scriptedAnswer: '已按原图做两倍超分，没有重新创作。', budget },
  { id: 'intent-remove-background', dimension: 'intent', request: '去掉选中图片的背景，只保留主体，使用抠图工作流。', selection: ['image-a'], checks: checks('eval-remove-bg'), script: [workflows('remove_background'), run('eval-remove-bg'), wait()], scriptedAnswer: '已去除背景并保留主体。', budget },
  { id: 'selection-no-substitute', dimension: 'tool_selection', setup: 'upscale_only', request: '保持选中的商品不变，把背景换成海边。如果没有编辑能力就说明缺什么，不要拿超分工作流代替。', selection: ['image-a'], checks: [
    { kind: 'tool', tools: ['list_workflows'], min: 1 },
    { kind: 'generation', min: 0, max: 0 }, { kind: 'response', pattern: '没有|缺少|不支持|导入|无法' },
  ], script: [workflows('image_edit')], scriptedAnswer: '没有可用的图片编辑工作流，需要先导入支持参考图编辑的工作流。', budget },
  { id: 'selection-two-references', dimension: 'tool_selection', request: '将选中的两张图一起作为参考，用支持两张输入的编辑工作流生成一张新图，保留两张参考的元素。', selection: ['image-a', 'image-b'], checks: [
    { kind: 'tool', tools: ['run_workflow'], where: { workflow_id: 'eval-edit-two', image_ids: ['image-a', 'image-b'] }, min: 1 }, { kind: 'generation', min: 1, max: 1 },
  ], script: [workflows('image_edit', 2), run('eval-edit-two', { image_ids: ['image-a', 'image-b'], prompt: '同时保留图1和图2的元素' }), wait()], scriptedAnswer: '已使用两张参考图。', budget },
  { id: 'parameters-fast-square', dimension: 'parameters', request: '用 Z-Image 快速画一张正方形橙色杯子草图，1k 即可，不需要参考图。', selection: [], checks: [
    { kind: 'tool', tools: ['generate_image'], where: { model: 'zimage', aspect: '1:1', quality: '1k' }, min: 1 }, { kind: 'generation', min: 1, max: 1 },
  ], script: [step('generate_image', { model: 'zimage', prompt: 'An orange cup on a plain background.', aspect: '1:1', quality: '1k' }), wait()], scriptedAnswer: '已生成一张正方形草图。', budget },
  { id: 'parameters-edit-aspect', dimension: 'parameters', request: '把选中的图片用编辑工作流改成 16:9 横版，保留原图主体，背景改为浅灰。', selection: ['image-a'], checks: [
    { kind: 'tool', tools: ['run_workflow'], where: { workflow_id: 'eval-edit-one', image_ids: ['image-a'], aspect: '16:9' }, min: 1 }, { kind: 'generation', min: 1, max: 1, reference: 'image-a' },
  ], script: [workflows('image_edit'), run('eval-edit-one', { aspect: '16:9', prompt: '保留主体，将背景换成浅灰' }), wait()], scriptedAnswer: '已制作 16:9 横版。', budget },
  { id: 'visual-left-right', dimension: 'visual', request: '看看选中的图片，画面左侧和右侧分别是什么颜色的方块？只检查，不修改。', selection: ['image-a'], checks: [
    { kind: 'tool', tools: ['view_images', 'review_items'], where: { ids: ['image-a'] }, min: 1 }, { kind: 'response', pattern: '左[\\s\\S]{0,20}红|红[\\s\\S]{0,20}左' }, { kind: 'response', pattern: '右[\\s\\S]{0,20}蓝|蓝[\\s\\S]{0,20}右' }, { kind: 'generation', min: 0, max: 0 },
  ], script: [step('view_images', { ids: ['image-a'] })], scriptedAnswer: '左侧是红色方块，右侧是蓝色方块。', budget },
  { id: 'visual-compare-shapes', dimension: 'visual', request: '比较选中的两张图：主体的形状相同吗？请描述差别，只检查不生成。', selection: ['image-a', 'image-b'], checks: [
    { kind: 'tool', tools: ['view_images', 'review_items'], min: 1 }, { kind: 'response', pattern: '不同|不相同|不一致|不一样|有差异' }, { kind: 'response', pattern: '圆' }, { kind: 'response', pattern: '方' }, { kind: 'generation', min: 0, max: 0 },
  ], script: [step('view_images', { ids: ['image-a', 'image-b'] })], scriptedAnswer: '形状不同，第一张是方块，第二张是圆形。', budget },
  { id: 'correction-spatial-layout', dimension: 'self_correction', setup: 'composition_failure', request: '第二张图站位错误。用第一张底图标出左右站位后，再用编辑工作流重做第二张；带上 retry_of，保留旧图。', selection: ['image-a', 'image-b'], checks: [
    { kind: 'tool', tools: ['mark_layout'], where: { id: 'image-a' }, min: 1 }, { kind: 'tool', tools: ['run_workflow', 'generate_image'], where: { retry_of: 'image-b' }, min: 1 }, { kind: 'preserve', ids: ['image-a', 'image-b', 'image-c'] },
  ], script: [step('view_images', { ids: ['image-a'] }), step('mark_layout', { id: 'image-a', boxes: [{ who: '左侧主体', x: 0.1, y: 0.2, w: 0.3, h: 0.7 }, { who: '右侧主体', x: 0.6, y: 0.2, w: 0.3, h: 0.7 }], name: '修复站位' }), workflows('image_edit', 2), run('eval-edit-two', { image_ids: ['image-a', '$layout'], prompt: '按图2的布局保留图1的画面，主体分别在左右两侧', retry_of: 'image-b' }), wait()], scriptedAnswer: '已标记站位并针对第二张重做。', budget },
  { id: 'correction-exact-text', dimension: 'self_correction', setup: 'text_failure', request: '选中图的文字错了，应为 MOON。先把 text_wrong 检查结论写回，再用原图参考修正文字并关联 retry_of；不要只换 seed。', selection: ['image-b'], checks: [
    { kind: 'tool', tools: ['record_review'], where: { 'entries.0.reason': 'text_wrong' }, min: 1 }, { kind: 'tool', tools: ['run_workflow', 'generate_image'], where: { retry_of: 'image-b', prompt: { pattern: 'MOON' } }, min: 1 },
  ], script: [step('record_review', { entries: [{ id: 'image-b', verdict: 'fail', reason: 'text_wrong', note: '文字应为 MOON' }] }), workflows('image_edit'), run('eval-edit-one', { image_ids: ['image-b'], prompt: '保留图中主体，将文字准确改为 MOON', retry_of: 'image-b' }), wait()], scriptedAnswer: '已记录文字错误并按 MOON 修正。', budget },
  { id: 'planning-before-generation', dimension: 'planning', request: '先为三镜头产品广告列出剧本、分镜、关键帧和视频的制作步骤，只做计划，不生成。', selection: [], checks: [
    { kind: 'tool', tools: ['update_todos', 'update_task_graph', 'present_plan'], min: 1 }, { kind: 'generation', min: 0, max: 0 },
  ], script: [step('update_todos', { todos: ['剧本', '分镜', '关键帧', '视频'].map((content) => ({ content, status: 'pending' })) })], scriptedAnswer: '先确认剧本，再做分镜、关键帧和视频。', budget },
  { id: 'planning-shared-reference', dimension: 'planning', request: '以选中的原图为统一参考，批量生成三张同产品宣传图，分别是主视觉、细节图和场景图。每张都必须使用原图，不需要视频。', selection: ['image-a'], checks: [
    { kind: 'generation', min: 3, max: 3, reference: 'image-a' }, { kind: 'preserve', ids: ['image-a', 'image-b', 'image-c'] },
  ], script: [step('batch_generate_images', { model: 'qwen', jobs: ['主视觉', '细节图', '场景图'].map((name) => ({ name, prompt: `保留图1的产品，制作${name}`, reference_ids: ['image-a'] })) }), wait()], scriptedAnswer: '三张图都使用同一产品参考。', budget },
  { id: 'context-selective-edit', dimension: 'context', request: '只把第三个镜头重命名为「月台」，其它节点内容、名称、位置都不要改。', selection: ['image-c'], checks: [
    { kind: 'rename', names: { 'image-c': '月台' } }, { kind: 'preserve', ids: ['image-a', 'image-b', 'note-script'] }, { kind: 'generation', min: 0, max: 0 },
  ], script: [step('update_items', { changes: [{ id: 'image-c', name: '月台' }] })], scriptedAnswer: '只修改了第三个镜头的名称。', budget },
  { id: 'context-long-script', dimension: 'context', setup: 'long_note', request: '读取分镜表的完整文本，找到 S03 的对白，把原句单独写成备注。不要改分镜表和其它镜头。', selection: ['note-script'], checks: [
    { kind: 'tool', tools: ['read_board'], where: { ids: { includes: 'note-script' } }, min: 1 }, { kind: 'tool', tools: ['write_note'], where: { content: { pattern: '晚风会带你回家' } }, min: 1 }, { kind: 'preserve', ids: ['image-a', 'image-b', 'image-c', 'note-script'] },
  ], script: [step('read_board', { ids: ['note-script'] }), step('write_note', { title: 'S03 对白', content: '晚风会带你回家。' })], scriptedAnswer: '已提取 S03 的原始对白。', budget },
  { id: 'memory-preference', dimension: 'memory', setup: 'preference', request: '按我以前确认的产品背景颜色偏好，快速生成一张杯子草图，使用 Z-Image。', selection: [], checks: [
    { kind: 'tool', tools: ['generate_image'], where: { prompt: { pattern: '蓝|冷色|blue|cool' }, model: 'zimage' }, min: 1 }, { kind: 'generation', min: 1, max: 1 },
  ], script: [step('generate_image', { model: 'zimage', prompt: 'A cup against a cool blue background.', aspect: '1:1', quality: '1k' }), wait()], scriptedAnswer: '沿用之前确认的冷蓝背景。', budget },
  { id: 'memory-character-retrieval', dimension: 'memory', setup: 'character', request: '先检索林晚的角色记忆，告诉我她外套是什么颜色，不要生成。', selection: [], checks: [
    { kind: 'tool', tools: ['search_memory', 'read_memory'], min: 1 }, { kind: 'response', pattern: '深蓝|藏蓝' }, { kind: 'generation', min: 0, max: 0 },
  ], script: [step('search_memory', { query: '林晚 外套', scope: 'board' })], scriptedAnswer: '林晚穿深蓝色外套。', budget },
  { id: 'recovery-out-of-memory', dimension: 'recovery', setup: 'oom', request: '先用 Qwen 生成一张杯子。如果显存不足，只换低显存的 Z-Image 重试一次，不要重复原模型和参数。', selection: [], checks: [
    { kind: 'recovery', firstModel: 'qwen', nextModel: 'zimage' }, { kind: 'generation', min: 2, max: 2, allowFailures: true },
  ], script: [step('generate_image', { model: 'qwen', prompt: 'A cup on a table.', quality: '1k' }), wait(), step('generate_image', { model: 'zimage', prompt: 'A cup on a table.', quality: '1k' }), wait()], scriptedAnswer: 'Qwen 显存不足后，已换 Z-Image 完成一次重试。', budget },
  { id: 'recovery-offline', dimension: 'recovery', setup: 'offline', request: '生成一张杯子。如果现在连不上 ComfyUI，就说明连接问题并停止，不要连续重试。', selection: [], checks: [
    { kind: 'generation', min: 0, max: 0 }, { kind: 'tool', tools: ['generate_image', 'run_workflow'], min: 1, max: 1, outcome: 'error' }, { kind: 'response', pattern: '连接|连不上|离线|不可用' },
  ], script: [step('generate_image', { prompt: 'A cup.' })], scriptedAnswer: '目前连不上 ComfyUI，请恢复连接后继续。', budget },
  { id: 'efficiency-selected-only', dimension: 'efficiency', request: '只看当前选中的图片，告诉我左右方块颜色。不要看其它图片、不要生成，也不用写备注。', selection: ['image-a'], checks: [
    { kind: 'tool', tools: ['view_images', 'review_items'], where: { ids: ['image-a'] }, min: 1, max: 1 }, { kind: 'generation', min: 0, max: 0 },
  ], script: [step('view_images', { ids: ['image-a'] })], scriptedAnswer: '左红右蓝。', budget: { ...budget, toolCalls: 4 } },
  { id: 'efficiency-batch-rename', dimension: 'efficiency', request: '把三个镜头依次命名为 S01、S02、S03，用一次批量更新完成，不改内容、不生成。', selection: ['image-a', 'image-b', 'image-c'], checks: [
    { kind: 'tool', tools: ['update_items'], min: 1, max: 1 }, { kind: 'rename', names: { 'image-a': 'S01', 'image-b': 'S02', 'image-c': 'S03' } }, { kind: 'generation', min: 0, max: 0 },
  ], script: [step('update_items', { changes: ['a', 'b', 'c'].map((id, i) => ({ id: `image-${id}`, name: `S0${i + 1}` })) })], scriptedAnswer: '已一次批量更新三个镜头名称。', budget: { ...budget, toolCalls: 4 } },
];

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentTaskGraph, CanvasItem, VisualCriterion } from '../shared/types.ts';
import { visualCriteria } from '../server/agent/visual-criteria.ts';
import { parseStructuredCritique } from '../server/agent/visual-critic.ts';
import { DEFECT_CATEGORIES, REPAIR_STRATEGIES } from '../server/agent/visual-repairs.ts';
import { buildFocusedContext, relevantExcerpt } from '../server/agent/context.ts';
import { compareEnhancements, type EnhancementReport } from '../server/agent/evaluation/comparison.ts';
import type { BenchmarkResult } from '../server/agent/evaluation/types.ts';

const criteria: VisualCriterion[] = [
  { id: 'cup', dimension: 'identity', description: '保留橙色杯子形状与杯把', threshold: 85 },
  { id: 'blue', dimension: 'instruction', description: '只把背景改成低饱和浅蓝', threshold: 80 },
];
const options = { criteria, objective: '编辑产品图', referenceIds: ['original'], model: 'test/reviewer' };
const response = (patch: Record<string, unknown> = {}) => JSON.stringify({ checks: [
  { criterionId: 'cup', score: 96, evidence: '杯身、杯把弧度与原图一致', visibility: 'observed' },
  { criterionId: 'blue', score: 72, evidence: '背景是高饱和蓝色', visibility: 'observed', defects: [{ category: 'color_mismatch', evidence: '背景蓝色明显偏饱和', region: { x: 0, y: 0, w: 1, h: 0.4 } }], ...patch },
], diagnosis: '杯子保持，背景色未达要求' });

test('independent visual criteria retain distinct requirements within one dimension', () => {
  const result = visualCriteria({ instruction: 80, quality: 75 }, [{ id: 'text', description: '文字是 MOON', dimension: 'instruction', threshold: 95 }, { id: 'bg', description: '背景为灰色', dimension: 'instruction', threshold: 80 }]);
  assert.equal(result.filter((criterion) => criterion.dimension === 'instruction').length, 2);
  assert.deepEqual(result.slice(0, 2).map((criterion) => criterion.threshold), [95, 80]);
  assert.ok(result.some((criterion) => criterion.dimension === 'quality'));
  assert.throws(() => visualCriteria({}, [criteria[0], criteria[0]]), /唯一/);
});

test('a failed visual item produces a targeted repair that preserves successful conditions', () => {
  const result = parseStructuredCritique(response(), options);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.checks![0].verdict, 'pass');
  assert.equal(result.defects![0].category, 'color_mismatch');
  assert.equal(result.repairPlan![0].action, 'reference_edit');
  assert.equal(result.repairPlan![0].requiresReference, true);
  assert.deepEqual(result.repairPlan![0].preserve, ['保留橙色杯子形状与杯把']);
  assert.deepEqual(result.repairPlan![0].verify, ['blue']);
  assert.equal(result.repairPlan![0].seedOnlyAllowed, false);
});

test('high scores with missing visual evidence cannot pass or trigger blind regeneration', () => {
  const result = parseStructuredCritique(response({ score: 100, visibility: 'unobservable', defects: [] }), options);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.defects![0].category, 'insufficient_evidence');
  assert.equal(result.repairPlan![0].action, 'inspect_more');
});

test('sparse video frames cannot satisfy a whole-media temporal requirement', () => {
  const criteria: VisualCriterion[] = [{ id: 'motion', dimension: 'temporal', description: '整段视频无跳帧和闪烁', threshold: 80 }];
  const text = JSON.stringify({ checks: [{ criterionId: 'motion', score: 99, visibility: 'observed', evidence: '首中尾三帧清晰' }], diagnosis: '仅看到了抽样帧' });
  const result = parseStructuredCritique(text, { ...options, criteria, coverage: 'sampled_video' });
  assert.equal(result.verdict, 'fail');
  assert.equal(result.checks![0].visibility, 'unobservable');
  assert.equal(result.repairPlan![0].action, 'inspect_more');
  const sampled = parseStructuredCritique(text, { ...options, criteria: [{ ...criteria[0], scope: 'sampled_frames' }], coverage: 'sampled_video' });
  assert.equal(sampled.verdict, 'pass', 'explicit sampled-frame checks keep their limited scope');
});

test('critic results reject omitted, repeated, invented checks and impossible defect locations', () => {
  const raw = JSON.parse(response());
  for (const checks of [raw.checks.slice(0, 1), [raw.checks[0], raw.checks[0]], [raw.checks[0], { ...raw.checks[1], criterionId: 'invented' }]]) assert.throws(() => parseStructuredCritique(JSON.stringify({ ...raw, checks }), options));
  assert.throws(() => parseStructuredCritique(response({ defects: [{ category: 'color_mismatch', evidence: '蓝色', region: { x: 0.9, y: 0, w: 0.5, h: 1 } }] }), options), /区域/);
  assert.throws(() => parseStructuredCritique(response({ defects: [{ category: 'unknown', evidence: '未知' }] }), options), /分类/);
});

test('each defect category has an actionable strategy and none recommends seed-only retry', () => {
  for (const category of DEFECT_CATEGORIES) assert.ok(REPAIR_STRATEGIES[category].instruction.length > 20);
  assert.equal(REPAIR_STRATEGIES.text_error.action, 'reference_edit');
  assert.equal(REPAIR_STRATEGIES.layout_mismatch.action, 'layout_guide');
  assert.equal(REPAIR_STRATEGIES.temporal_discontinuity.action, 'inspect_more');
});

test('context prioritizes an executing task and late relevant assets over unrelated ready tasks', () => {
  const task = (id: string, status: 'ready' | 'running') => ({ id, objective: `目标 ${id}`, status, inputs: [id], outputs: [], dependencies: [], acceptanceCriteria: [{ id: 'keep', description: '保持原有主体' }], evidence: [], attempts: 1, maxAttempts: 2 });
  const graph: AgentTaskGraph = { version: 1, revision: 4, objective: '广告', tasks: [...Array.from({ length: 30 }, (_, i) => task(`unrelated-${i}`, 'ready')), task('active', 'running')] };
  const items: CanvasItem[] = graph.tasks.map((task) => ({ id: task.id, kind: 'text', text: task.id === 'active' ? '原始主体：橙色杯子' : 'unrelated-secret', x: 0, y: 0, w: 10, h: 10, createdAt: 1 }));
  const result = buildFocusedContext({ graph, items, skills: [], experiences: [], budget: 1800 }, (item) => item.id);
  assert.equal(result.focusTaskId, 'active');
  assert.deepEqual(result.itemIds, ['active']);
  assert.match(result.text, /橙色杯子/);
  assert.doesNotMatch(result.text, /unrelated-secret/);
  assert.ok(result.characters <= 1800);
});

test('context extracts a relevant late script line and makes budget omissions explicit', () => {
  const text = '无关开场资料\n'.repeat(1000) + 'S03 对白：晚风会带你回家。\n' + '无关后记\n'.repeat(1000);
  assert.match(relevantExcerpt(text, '请提取 S03 的对白', 200), /晚风会带你回家/);
  const graph: AgentTaskGraph = { version: 1, revision: 0, objective: '', tasks: [] };
  const items: CanvasItem[] = [{ id: 'script', kind: 'text', text, x: 0, y: 0, w: 10, h: 10, createdAt: 1 }];
  const result = buildFocusedContext({ graph, items, skills: [{ id: 'large', text: '技能说明'.repeat(500) }], experiences: [], selection: ['script'], intent: '提取 S03 对白', budget: 1400 }, () => '分镜表');
  assert.match(result.text, /晚风会带你回家/);
  assert.ok(result.omittedSections.length > 0);
  assert.match(result.text, /预算内未展示/);
  assert.ok(result.text.length <= 1400);
  assert.equal(buildFocusedContext({ graph, items, skills: [], experiences: [], budget: 0 }, () => '').text, '');
});

const benchmark = (passed: boolean): BenchmarkResult => ({ id: 'same-case', dimension: 'context', profile: 'enhanced', mode: 'live', model: 'same/model', status: passed ? 'passed' : 'failed', passed, failures: [], checks: [], runIds: [], promptVersions: [], metrics: { inputTokens: 100, outputTokens: 10, paidTokens: 110, cost: 0, toolCalls: 2, toolErrors: 0, modelCalls: 1, generations: 0, retries: 0, gpuSeconds: 0, userInterventions: 0, durationMs: 1 } });
const report = (enhancement: string): EnhancementReport => ({ revision: 'same-clean-sha', sourceDirty: false, fixtureVersion: 'fixed-fixtures', environment: { enhancement, model: 'same/model', mode: 'live' }, results: [benchmark(true)] });

test('paired enhancements reject dirty source, changed fixtures or models instead of inventing improvements', () => {
  const before = report('legacy');
  const after = report('targeted');
  assert.equal(compareEnhancements(before, after).pairedCases, 1);
  for (const changed of [{ ...after, sourceDirty: true }, { ...after, fixtureVersion: 'changed' }, { ...after, environment: { ...after.environment, model: 'other/model' } }]) {
    const result = compareEnhancements(before, changed);
    assert.equal(result.comparable, false);
    assert.equal(result.pairedCases, 0);
  }
});

test('paired comparisons retain actual regressions and exclude blocked measurements', () => {
  const before = report('legacy');
  const after = { ...report('targeted'), results: [benchmark(false)] };
  assert.equal(compareEnhancements(before, after).regressed, 1);
  after.results[0].status = 'blocked';
  assert.equal(compareEnhancements(before, after).pairedCases, 0);
});

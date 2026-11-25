import { createHash } from 'node:crypto';
import type { AgentAcceptanceCriterion, AgentTask, AgentValidationResult, CanvasItem } from '../../shared/types.ts';
import { assetVersions } from './asset-version.ts';

export interface ValidationRequest { task: AgentTask; criterion: AgentAcceptanceCriterion; items: Map<string, CanvasItem>; readable: (item: CanvasItem) => Promise<boolean> }
export interface Validator {
  id: string;
  supports(criterion: AgentAcceptanceCriterion): boolean;
  validate(request: ValidationRequest): Promise<Pick<AgentValidationResult, 'verdict' | 'evidence' | 'repairHint'>>;
}
export function validationSignature(task: AgentTask, criterion: AgentAcceptanceCriterion, items: Map<string, CanvasItem>): string {
  return createHash('sha256').update(JSON.stringify({ task: task.id, attempt: task.attempts, objective: task.objective, criterion, outputs: assetVersions(task.outputs, items), inputs: assetVersions(task.inputs, items) })).digest('hex');
}
export function currentValidation(task: AgentTask, criterion: AgentAcceptanceCriterion, items: Map<string, CanvasItem>, results = criterion.validator?.kind === 'user' ? task.userValidation : task.validation): AgentValidationResult | undefined {
  return results?.find((result) => result.criterionId === criterion.id && result.version === 'harness-v1' && result.signature === validationSignature(task, criterion, items));
}

/** Deliberately bounded JSON Schema subset. Unsupported keywords produce unknown, never pass. */
export function schemaVerdict(value: unknown, schema: Record<string, unknown>, depth = 0): 'pass' | 'fail' | 'unknown' {
  if (depth > 16 || Object.keys(schema).some((key) => !['type', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'description', 'title'].includes(key))) return 'unknown';
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || Number(schema[key]) < 0)) return 'unknown';
  for (const key of ['minimum', 'maximum']) if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) return 'unknown';
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && (!schema.additionalProperties || typeof schema.additionalProperties !== 'object' || Array.isArray(schema.additionalProperties))) return 'unknown';
  const type = schema.type;
  if (type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(type))) return 'unknown';
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (type !== undefined && !(type === 'integer' ? Number.isInteger(value) : actual === type)) return 'fail';
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value)))) return 'fail';
  if (typeof value === 'number' && (!Number.isFinite(value) || (typeof schema.minimum === 'number' && value < schema.minimum) || (typeof schema.maximum === 'number' && value > schema.maximum))) return 'fail';
  if (typeof value === 'string' && ((typeof schema.minLength === 'number' && value.length < schema.minLength) || (typeof schema.maxLength === 'number' && value.length > schema.maxLength))) return 'fail';
  const verdicts: ('pass' | 'fail' | 'unknown')[] = [];
  if (Array.isArray(value)) {
    if ((typeof schema.minItems === 'number' && value.length < schema.minItems) || (typeof schema.maxItems === 'number' && value.length > schema.maxItems)) return 'fail';
    if (schema.items !== undefined) {
      if (!schema.items || typeof schema.items !== 'object' || Array.isArray(schema.items)) return 'unknown';
      verdicts.push(...value.map((entry) => schemaVerdict(entry, schema.items as Record<string, unknown>, depth + 1)));
    }
  } else if (value && typeof value === 'object') {
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(value, key)))) return 'fail';
    if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) return 'unknown';
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, entry] of Object.entries(value)) {
      if (properties[key]) verdicts.push(typeof properties[key] === 'object' && !Array.isArray(properties[key]) ? schemaVerdict(entry, properties[key], depth + 1) : 'unknown');
      else if (schema.additionalProperties === false) return 'fail';
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') verdicts.push(schemaVerdict(entry, schema.additionalProperties as Record<string, unknown>, depth + 1));
    }
  }
  return verdicts.includes('fail') ? 'fail' : verdicts.includes('unknown') ? 'unknown' : 'pass';
}

export class ValidatorRegistry {
  constructor(private validators: Validator[]) {
    if (new Set(validators.map((v) => v.id)).size !== validators.length) throw new Error('Duplicate validator');
  }
  async validate(task: AgentTask, items: CanvasItem[], readable: ValidationRequest['readable']): Promise<AgentValidationResult[]> {
    const known = new Map(items.map((item) => [item.id, item]));
    return Promise.all(task.acceptanceCriteria.map(async (criterion) => {
      const validator = this.validators.find((entry) => entry.supports(criterion));
      let result: Pick<AgentValidationResult, 'verdict' | 'evidence' | 'repairHint'>;
      try { result = validator ? await validator.validate({ task, criterion, items: known, readable }) : { verdict: 'unknown', evidence: ['没有支持该验收条件的验证器'] }; }
      catch { result = { verdict: 'unknown', evidence: ['验证器未能读取或确认结果'], repairHint: '补充证据后重新验证；不要直接重复生成' }; }
      return { ...result, criterionId: criterion.id, validator: validator?.id ?? 'unsupported', version: 'harness-v1', signature: validationSignature(task, criterion, known), at: Date.now() };
    }));
  }
}

export const defaultValidators = (visualPass: (task: AgentTask, criterion: AgentAcceptanceCriterion, items: Map<string, CanvasItem>) => boolean) => new ValidatorRegistry([
  { id: 'user', supports: (c) => c.validator?.kind === 'user', async validate({ task, criterion, items }) {
    const existing = currentValidation(task, criterion, items, task.userValidation);
    return existing ? { verdict: existing.verdict, evidence: existing.evidence } : { verdict: 'unknown', evidence: ['等待用户对当前输出明确反馈'], repairHint: '请求用户验收当前版本' };
  } },
  { id: 'visual', supports: (c) => Boolean(c.dimension), async validate({ task, criterion, items }) {
    if (visualPass(task, criterion, items)) return { verdict: 'pass', evidence: task.outputs.map((id) => items.get(id)?.critic?.checks?.find((check) => check.id === criterion.id)?.evidence ?? '独立视觉审查通过') };
    const observedFailure = task.outputs.some((id) => items.get(id)?.critic?.checks?.some((check) => check.id === criterion.id && check.visibility === 'observed' && check.verdict === 'fail'));
    return { verdict: observedFailure ? 'fail' : 'unknown', evidence: ['独立审查未通过或证据范围、素材版本不匹配'], repairHint: observedFailure ? '只修复已确认缺陷，保留其余约束并复核' : '补充参考或检查更多帧，证据不足不触发重新生成' };
  } },
  { id: 'artifact', supports: () => true, async validate({ task, criterion, items, readable }) {
    if (!task.outputs.length) return { verdict: 'fail', evidence: ['没有输出'] };
    for (const id of task.outputs) {
      const item = items.get(id);
      if (!item || item.error || !(await readable(item))) return { verdict: 'fail', evidence: [`输出不可读取：${id}`] };
      const rule = criterion.validator;
      if (rule?.kind === 'schema') {
        let value: unknown;
        try { value = JSON.parse(item.text ?? ''); } catch { return { verdict: 'fail', evidence: [`输出不是 JSON：${id}`] }; }
        const verdict = schemaVerdict(value, rule.schema);
        if (verdict !== 'pass') return { verdict, evidence: [`JSON 结构验证 ${verdict}：${id}`] };
      }
      if (rule?.kind === 'media') {
        const asset = item.asset;
        if (!asset) return { verdict: 'unknown', evidence: [`缺少媒体元数据：${id}`] };
        const checks: [number | undefined, number | undefined, 'min' | 'max' | 'aspect'][] = [[asset.width, rule.minWidth, 'min'], [asset.height, rule.minHeight, 'min'], [asset.duration, rule.minDuration, 'min'], [asset.duration, rule.maxDuration, 'max'], [asset.height ? asset.width / asset.height : undefined, rule.aspect, 'aspect']];
        for (const [actual, target, mode] of checks) if (target !== undefined) {
          if (actual === undefined || !Number.isFinite(actual)) return { verdict: 'unknown', evidence: [`媒体元数据不足：${id}`] };
          if (mode === 'min' ? actual < target : mode === 'max' ? actual > target : Math.abs(actual - target) > 0.01) return { verdict: 'fail', evidence: [`媒体规格不匹配：${id}，实际=${actual}，要求=${target}`] };
        }
      }
    }
    return { verdict: 'pass', evidence: [criterion.validator ? '已检查当前输出结构或媒体规格；不代表主观质量' : '输出存在且可读；描述性要求仍需所提交的逐条证据'] };
  } },
]);

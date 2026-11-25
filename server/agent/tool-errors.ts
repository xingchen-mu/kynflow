import { redactTraceText } from './trace/redact.ts';
import type { ToolErrorCode, ToolFailure } from '../../shared/types.ts';
export type { ToolErrorCode, ToolFailure } from '../../shared/types.ts';

const recovery: Record<ToolErrorCode, ToolFailure['recovery']> = {
  INVALID_ARGUMENT: 'fix_arguments', CAPABILITY_UNAVAILABLE: 'change_strategy', MODEL_NOT_INSTALLED: 'ask_user', OUT_OF_MEMORY: 'change_strategy', TIMEOUT: 'check_existing', PERMISSION_DENIED: 'ask_user', BUDGET_EXCEEDED: 'ask_user', EXECUTION_FAILED: 'check_existing', CANCELLED: 'stop', CONNECTION_UNAVAILABLE: 'wait_for_connection', STALE_STATE: 'check_existing', SUBMISSION_UNCONFIRMED: 'check_existing',
};

export class ToolExecutionError extends Error {
  constructor(readonly code: ToolErrorCode, message: string, readonly retryable = false) { super(message); this.name = 'ToolExecutionError'; }
}

/** Typed failures take precedence; compatibility classification covers existing tool implementations. */
export function toolFailure(error: unknown): ToolFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const code = error instanceof ToolExecutionError ? error.code
    : /budget|预算|上限/i.test(raw) ? 'BUDGET_EXCEEDED'
    : /out of memory|显存不足|OutOfMemory/i.test(raw) ? 'OUT_OF_MEMORY'
    : /abort|cancel|取消/i.test(raw) ? 'CANCELLED'
    : /timeout|timed out|超时/i.test(raw) ? 'TIMEOUT'
    : /unauthorized|forbidden|permission|权限|无权|401|403/i.test(raw) ? 'PERMISSION_DENIED'
    : /connect|offline|连接|离线|ECONN/i.test(raw) ? 'CONNECTION_UNAVAILABLE'
    : /revision|已失效|较早的任务|已更新|重复提交/i.test(raw) ? 'STALE_STATE'
    : /model.*(?:missing|not installed)|模型.*(?:缺少|未安装)/i.test(raw) ? 'MODEL_NOT_INSTALLED'
    : /capability|不可用|不支持|没有可用|缺少.*(?:节点|工作流)/i.test(raw) ? 'CAPABILITY_UNAVAILABLE'
    : /invalid|参数|schema|必须|需要.*id|没有 id 为/i.test(raw) ? 'INVALID_ARGUMENT' : 'EXECUTION_FAILED';
  return { code, message: redactTraceText(raw, 1000), retryable: error instanceof ToolExecutionError ? error.retryable : false, recovery: recovery[code] };
}

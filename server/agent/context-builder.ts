import { createHash } from 'node:crypto';
import { ToolExecutionError } from './tool-errors.ts';

export interface ContextBlock {
  source: string;
  version?: string;
  content: string;
  tokenCount: number;
  relevance: number;
  required: boolean;
}
export interface ContextRequest {
  query: string;
  contextWindow: number;
  reserves: { system: number; tools: number; history: number; images: number; output: number };
  maxTokens?: number;
}
export interface ContextProvider {
  id: string;
  priority: number;
  retrieve(request: ContextRequest): Promise<ContextBlock[]>;
}
/** Conservative UTF-8 byte estimate, not a tokenizer or a provider billing counter. */
export const estimateContextTokens = (text: string) => Buffer.byteLength(text, 'utf8') + 16;
export function contextBlock(source: string, content: string, required = false, relevance = 1): ContextBlock {
  return { source, content, required, relevance, tokenCount: estimateContextTokens(content), version: createHash('sha256').update(content).digest('hex').slice(0, 16) };
}

export class ContextBuilder {
  constructor(private providers: ContextProvider[]) {
    if (new Set(providers.map((p) => p.id)).size !== providers.length) throw new Error('Duplicate context provider');
  }
  async build(request: ContextRequest) {
    const values = [request.contextWindow, ...Object.values(request.reserves), request.maxTokens ?? Infinity];
    if (values.some((n) => Number.isNaN(n) || n < 0) || !Number.isFinite(request.contextWindow) || Object.values(request.reserves).some((n) => !Number.isFinite(n))) throw new Error('Invalid context budget');
    const reserved = Object.values(request.reserves).reduce((n, value) => n + value, 0);
    if (reserved > request.contextWindow) throw new ToolExecutionError('BUDGET_EXCEEDED', '系统、工具、历史与输出预留已超过上下文窗口；请先整理对话或减少输入');
    const budget = Math.max(0, Math.min(request.maxTokens ?? Infinity, request.contextWindow - reserved));
    const batches = await Promise.all(this.providers.map(async (provider) => ({ provider, blocks: await provider.retrieve(request) })));
    const candidates = batches.flatMap(({ provider, blocks }) => blocks.map((block, index) => ({ block, priority: provider.priority, index })))
      .sort((a, b) => Number(b.block.required) - Number(a.block.required) || b.priority - a.priority || b.block.relevance - a.block.relevance || a.index - b.index);
    const blocks: ContextBlock[] = [];
    const omitted: string[] = [];
    const seen = new Set<string>();
    let tokens = 0;
    for (const { block } of candidates) {
      if (!Number.isFinite(block.tokenCount) || block.tokenCount < 0 || !Number.isFinite(block.relevance)) throw new Error('Invalid context block');
      const key = `${block.source}:${block.version ?? block.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Re-estimate framing and never trust a provider's undercount.
      const size = Math.max(block.tokenCount, estimateContextTokens(block.content)) + 2;
      if (tokens + size > budget) {
        if (block.required) throw new ToolExecutionError('BUDGET_EXCEEDED', '上下文预算不足以保留任务硬性约束；请压缩历史或减少任务范围，不能省略验收标准');
        omitted.push(block.source);
      } else { blocks.push(block); tokens += size; }
    }
    return { text: blocks.map((b) => b.content).join('\n\n'), blocks, omitted, tokens, budget, reserved, estimator: 'utf8-bytes-v1' as const };
  }
}

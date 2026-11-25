import type { CanvasTool } from './tools.ts';

export interface ToolMetadata {
  name: string;
  category: 'canvas' | 'harness' | 'memory' | 'generation';
  capabilities: string[];
  sideEffect: 'read' | 'write' | 'generation' | 'destructive';
  timeoutMs: number;
  /** Only read operations can be assumed safe to repeat without an operation identity. */
  idempotent: boolean;
  requiresApproval: boolean;
}
export function toolMetadata(tool: CanvasTool): ToolMetadata {
  const generation = Boolean(tool.prompts);
  return { name: tool.name, category: generation ? 'generation' : /memory|entit/.test(tool.name) ? 'memory' : /task_graph|skill|critic|experience|validat/.test(tool.name) ? 'harness' : 'canvas',
    capabilities: [tool.name, ...(tool.vision ? ['vision'] : [])], sideEffect: tool.destructive ? 'destructive' : generation ? 'generation' : tool.readOnly ? 'read' : 'write',
    timeoutMs: /wait_for|video|concat|audio/.test(tool.name) ? 600000 : tool.vision ? 120000 : 180000,
    idempotent: Boolean(tool.readOnly), requiresApproval: Boolean(tool.approve) };
}
/** Cancellation is cooperative: do not release a write reservation while the tool is still running. */
export function toolSignal(tool: CanvasTool, signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any([...signals.filter((signal): signal is AbortSignal => Boolean(signal)), AbortSignal.timeout(toolMetadata(tool).timeoutMs)]);
}

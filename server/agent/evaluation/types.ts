import type { AgentHarnessProfile, AgentRunTrace, CanvasItem, Task, TraceValue } from '../../../shared/types.ts';

export const CAPABILITY_DIMENSIONS = ['intent', 'tool_selection', 'parameters', 'visual', 'self_correction', 'planning', 'context', 'memory', 'recovery', 'efficiency'] as const;
export type CapabilityDimension = typeof CAPABILITY_DIMENSIONS[number];
export interface BenchmarkStep { tool: string; args: Record<string, unknown> }
export type BenchmarkCheck =
  | { kind: 'tool'; tools: string[]; where?: Record<string, TraceValue>; min?: number; max?: number; outcome?: 'success' | 'error' }
  | { kind: 'response'; pattern: string }
  | { kind: 'plan'; orderedTerms: string[] }
  | { kind: 'preserve'; ids: string[] }
  | { kind: 'rename'; names: Record<string, string> }
  | { kind: 'generation'; min: number; max: number; reference?: string; allowFailures?: boolean }
  | { kind: 'recovery'; firstModel: string; nextModel: string };
export interface AgentBenchmarkCase {
  id: string;
  dimension: CapabilityDimension;
  request: string;
  selection: string[];
  setup?: 'long_note' | 'preference' | 'character' | 'composition_failure' | 'text_failure' | 'oom' | 'offline' | 'upscale_only';
  checks: BenchmarkCheck[];
  script: BenchmarkStep[];
  scriptedAnswer: string;
  budget: { toolCalls: number; modelCalls: number; tokens: number; durationMs: number; generations: number };
}
export interface BenchmarkObservation {
  traces: AgentRunTrace[];
  before: CanvasItem[];
  after: CanvasItem[];
  tasks: Task[];
  error?: string;
}
export interface BenchmarkResult {
  id: string;
  dimension: CapabilityDimension;
  profile: AgentHarnessProfile;
  mode: 'scripted' | 'live';
  passed: boolean;
  status: 'passed' | 'failed' | 'blocked';
  blockReason?: string;
  failures: string[];
  checks: { index: number; kind: string; passed: boolean; detail: string }[];
  metrics: { inputTokens: number; outputTokens: number; paidTokens: number; cost: number; toolCalls: number; toolErrors: number; modelCalls: number; generations: number; retries: number; gpuSeconds: number; userInterventions: number; durationMs: number };
  runIds: string[];
  promptVersions: string[];
  model: string;
}

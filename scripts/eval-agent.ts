import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AgentTaskGraph, AgentTraceEvent } from '../shared/types.ts';
import { evaluateAgentTrace, type AgentEvaluationCase } from '../server/agent/evaluation.ts';

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
};
const fixture = JSON.parse(await readFile(new URL('../test/fixtures/agent-benchmarks.json', import.meta.url), 'utf8')) as {
  version: number; environment: Record<string, string>; cases: AgentEvaluationCase[];
};
const output = resolve(value('--output') ?? 'output/agent-evaluation.json');
const tracePath = value('--trace');
let results: ReturnType<typeof evaluateAgentTrace>[];
let environment: Record<string, unknown> = { ...fixture.environment, node: process.version, platform: process.platform, arch: process.arch };
let regressionExit = 0;
if (tracePath) {
  const trace = JSON.parse(await readFile(resolve(tracePath), 'utf8')) as { model: string; truncated?: boolean; events: AgentTraceEvent[] };
  if (trace.truncated) throw new Error('The trace was truncated; use a fresh conversation for a complete benchmark.');
  if (!Array.isArray(trace.events)) throw new Error('Trace must contain an events array');
  const caseId = value('--case');
  const spec = fixture.cases.find((c) => c.id === caseId);
  if (!spec) throw new Error(`Choose --case from: ${fixture.cases.map((c) => c.id).join(', ')}`);
  const graphPath = value('--graph');
  const graph = graphPath ? JSON.parse(await readFile(resolve(graphPath), 'utf8')) as AgentTaskGraph : undefined;
  results = [evaluateAgentTrace(spec, trace.events, graph)];
  environment = { node: process.version, model: trace.model, source: 'exported runtime trace', comfyUI: 'not supplied', gpu: 'not supplied' };
} else {
  const temporary = await mkdtemp(join(tmpdir(), 'kynflow-agent-eval-'));
  try {
    const reportFile = join(temporary, 'cases.json');
    regressionExit = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--test', 'test/eval.test.ts', 'test/agent-harness.test.ts', 'test/agent.test.ts', 'test/agent-runtime-control.test.ts', 'test/task-recovery.test.ts', 'test/harness-foundation.test.ts', 'test/agent-trace.test.ts'], {
        stdio: 'inherit', env: { ...process.env, AGENT_EVAL_REPORT: reportFile },
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
    results = JSON.parse(await readFile(reportFile, 'utf8').catch(() => '[]'));
    const missing = fixture.cases.filter((c) => !results.some((r) => r.id === c.id));
    if (missing.length) throw new Error(`Benchmark cases did not finish: ${missing.map((c) => c.id).join(', ')}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
let revision = 'unknown';
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* source archive */ }
const passed = regressionExit === 0 && results.every((result) => result.passed);
const report = { version: fixture.version, at: new Date().toISOString(), revision, environment, passed, results };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Agent evaluation ${passed ? 'passed' : 'failed'}: ${results.filter((r) => r.passed).length}/${results.length} cases. Report: ${output}`);
console.log('Scripted fixtures verify harness behavior. They do not establish gains in model reasoning or visual quality.');
if (!passed) process.exitCode = 1;

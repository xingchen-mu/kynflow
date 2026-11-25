import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CORE_BENCHMARK_CASES } from '../server/agent/evaluation/fixtures/core.ts';
import { benchmarkSummary, compareBenchmark } from '../server/agent/evaluation/metrics.ts';
import type { BenchmarkResult } from '../server/agent/evaluation/types.ts';
import { SettingsStore } from '../server/settings.ts';
import { redactTraceText } from '../server/agent/trace/redact.ts';
import { MOCK_PROTOCOL_VERSION, MOCK_PROTOCOL_INSTRUCTIONS } from '../server/agent/evaluation/protocol.ts';

const args = process.argv.slice(2);
const value = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const mode = value('--mode') ?? 'scripted';
const profile = value('--profile') ?? 'enhanced';
const contextMode = value('--context') ?? 'providers';
if (!['focused', 'providers'].includes(contextMode)) throw new Error('Use --context focused|providers');
const enhancement = value('--enhancement') ?? 'targeted';
if (!['legacy', 'targeted'].includes(enhancement)) throw new Error('Use --enhancement legacy|targeted');
if (!['scripted', 'live'].includes(mode) || !['baseline', 'enhanced', 'both'].includes(profile)) throw new Error('Use --mode scripted|live and --profile baseline|enhanced|both');
const profiles = profile === 'both' ? ['baseline', 'enhanced'] as const : [profile as 'baseline' | 'enhanced'];
const cases = CORE_BENCHMARK_CASES.filter((item) => !value('--case') || item.id === value('--case'));
if (!cases.length) throw new Error('Unknown benchmark case');
const output = resolve(value('--output') ?? 'output/agent-benchmark.json');
const artifactDirectory = join(dirname(output), `${basename(output, '.json')}-traces`);
await mkdir(artifactDirectory, { recursive: true });
const settings = new SettingsStore();
await settings.init();
const cfg = settings.agentConfig();
let revision = 'unknown';
let sourceDirty = false;
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* source archive */ }
try { sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()); } catch { /* source archive */ }
const results: BenchmarkResult[] = [];
let configurationBlock: string | undefined;
const startedAt = new Date().toISOString();
for (const currentProfile of profiles) for (const spec of cases) {
  if (configurationBlock) {
    results.push({ id: spec.id, dimension: spec.dimension, profile: currentProfile, mode: mode as 'live' | 'scripted', passed: false, status: 'blocked', blockReason: configurationBlock, failures: [], checks: [], runIds: [], promptVersions: [], model: cfg.model,
      metrics: { inputTokens: 0, outputTokens: 0, paidTokens: 0, cost: 0, toolCalls: 0, toolErrors: 0, modelCalls: 0, generations: 0, retries: 0, gpuSeconds: 0, userInterventions: 0, durationMs: 0 } });
    console.log(`BLOCKED ${currentProfile}/${spec.id}: model configuration`);
    continue;
  }
  const directory = await mkdtemp(join(tmpdir(), 'kynflow-benchmark-'));
  console.log(`Running ${mode}/${currentProfile}/${spec.id}`);
  try {
    const worker = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/agent-benchmark-worker.ts', spec.id, mode, currentProfile, enhancement, contextMode], {
        env: { ...process.env, DATA_DIR: directory, AGENT_MODEL: cfg.model, AGENT_BASE_URL: cfg.baseUrl ?? '', AGENT_API_KEY: cfg.apiKey ?? process.env.AGENT_API_KEY ?? '', AGENT_VISION: cfg.vision ? '1' : '0', AGENT_THINKING: cfg.thinking ?? 'off', AGENT_CONTEXT_WINDOW: String(cfg.contextWindow ?? 128000), AGENT_REASONING: cfg.reasoning ? '1' : '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), spec.budget.durationMs + 20000);
      child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-6_000_000); });
      child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-20000); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    });
    const line = worker.stdout.split('\n').find((item) => item.startsWith('BENCHMARK_RESULT '));
    if (!line) throw new Error(redactTraceText(worker.stderr || worker.stdout || `Worker exited ${worker.code}`));
    const payload = JSON.parse(line.slice('BENCHMARK_RESULT '.length));
    const result = payload.result as BenchmarkResult;
    results.push(result);
    if (result.status === 'blocked') configurationBlock = result.blockReason;
    await writeFile(join(artifactDirectory, `${currentProfile}-${spec.id}.json`), JSON.stringify(payload, null, 2) + '\n');
    console.log(`${result.status.toUpperCase()} ${currentProfile}/${spec.id}: ${result.metrics.toolCalls} tools, ${result.metrics.inputTokens + result.metrics.outputTokens} tokens${result.blockReason ? `; ${result.blockReason}` : result.failures.length ? `; ${result.failures.join('; ')}` : ''}`);
  } catch (error) {
    const reason = redactTraceText((error as Error).message);
    results.push({ id: spec.id, dimension: spec.dimension, profile: currentProfile, mode: mode as 'live' | 'scripted', passed: false, status: 'blocked', blockReason: `Runner error: ${reason}`, failures: [], checks: [], runIds: [], promptVersions: [], model: cfg.model,
      metrics: { inputTokens: 0, outputTokens: 0, paidTokens: 0, cost: 0, toolCalls: 0, toolErrors: 0, modelCalls: 0, generations: 0, retries: 0, gpuSeconds: 0, userInterventions: 0, durationMs: 0 } });
    console.log(`BLOCKED ${currentProfile}/${spec.id}: ${reason}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const report = { version: 2, startedAt, finishedAt: new Date().toISOString(), revision, sourceDirty, traceArtifacts: basename(artifactDirectory),
  fixtureVersion: createHash('sha256').update(JSON.stringify({ cases: CORE_BENCHMARK_CASES, protocol: MOCK_PROTOCOL_VERSION, instructions: MOCK_PROTOCOL_INSTRUCTIONS })).digest('hex'),
  environment: { mode, enhancement, contextMode, protocol: MOCK_PROTOCOL_VERSION, model: mode === 'scripted' ? 'benchmark/scripted-v1' : cfg.model, node: process.version, pi: '1.4.0', comfyUI: 'mock-v2 (real HTTP, TaskManager, uploaded inputs and sized outputs)', gpu: 'none', visualInputs: 'authored color/shape fixtures; generated visual quality is not scored', cost: 'provider catalog estimate; custom endpoint prices may be unknown' },
  summaries: Object.fromEntries(profiles.map((current) => [current, benchmarkSummary(results.filter((result) => result.profile === current))])), comparison: compareBenchmark(results), results,
  interpretation: mode === 'scripted' ? 'Protocol regressions with scripted model decisions; no claim about model ability.' : 'Live model decisions on fixed mock-environment tasks; visual perception covers simple authored shapes, not generated aesthetics or character identity. Ablation is a single sample per case, not causal proof.',
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
const markdown = `# Agent benchmark\n\nMode: ${mode}. Revision: ${revision}. GPU: none.\n\n${report.interpretation}\n\n| Profile | Passed | Cases | Assessed | Blocked | Pass rate | Input tokens | Output tokens | Tool calls |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${Object.entries(report.summaries).map(([name, summary]) => `| ${name} | ${summary.passed} | ${summary.cases} | ${summary.assessed} | ${summary.blocked} | ${summary.passRate === null ? 'unmeasured' : (summary.passRate * 100).toFixed(1) + '%'} | ${summary.usage.inputTokens} | ${summary.usage.outputTokens} | ${summary.usage.toolCalls} |`).join('\n')}\n\nPaired cases: ${report.comparison.pairedCases}; improved: ${report.comparison.improved}; regressed: ${report.comparison.regressed}.\n\n| Case | Dimension | Profile | Status | Findings |\n| --- | --- | --- | --- | --- |\n${results.map((result) => `| ${result.id} | ${result.dimension} | ${result.profile} | ${result.status} | ${(result.blockReason ? [result.blockReason] : result.failures).join('; ').replaceAll('|', '/')} |`).join('\n')}\n`;
await writeFile(output.replace(/\.json$/, '') + '.md', markdown);
console.log(`Benchmark report: ${output}`);
if (results.some((result) => result.status === 'blocked')) process.exitCode = 2;
else if (results.some((result) => !result.passed)) process.exitCode = 1;

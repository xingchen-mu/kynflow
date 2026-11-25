// DATA_DIR and model settings are supplied by the parent; no production projects are opened.
import { CORE_BENCHMARK_CASES } from '../server/agent/evaluation/fixtures/core.ts';
import { runBenchmarkCase } from '../server/agent/evaluation/runner.ts';
import { redactTraceText } from '../server/agent/trace/redact.ts';

const [caseId, mode, profile, enhancement = 'targeted'] = process.argv.slice(2);
const spec = CORE_BENCHMARK_CASES.find((item) => item.id === caseId);
if (!spec || (mode !== 'scripted' && mode !== 'live') || (profile !== 'baseline' && profile !== 'enhanced') || !['legacy', 'targeted'].includes(enhancement)) throw new Error('Invalid benchmark worker options');
try {
  const result = await runBenchmarkCase(spec, { mode, profile, enhancement: enhancement as 'legacy' | 'targeted' });
  process.stdout.write(`BENCHMARK_RESULT ${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`BENCHMARK_ERROR ${redactTraceText((error as Error).message)}\n`);
  process.exitCode = 1;
}

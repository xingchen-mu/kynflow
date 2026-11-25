import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { compareEnhancements, type EnhancementReport } from '../server/agent/evaluation/comparison.ts';
import { gpuReportPath } from '../server/agent/evaluation/gpu-report.ts';

const args = process.argv.slice(2);
const value = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const mode = value('--mode') ?? 'scripted';
if (!['scripted', 'live'].includes(mode)) throw new Error('Use --mode scripted|live');
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Commit changes before a paired comparison; source must remain fixed');
const output = gpuReportPath(value('--output') ?? 'output/agent-enhancement-comparison.json');
await mkdir(dirname(output), { recursive: true });
const reports: EnhancementReport[] = [];
const paths: string[] = [];
for (const enhancement of ['legacy', 'targeted']) {
  const path = join(dirname(output), `${basename(output, '.json')}-${enhancement}.json`);
  console.log(`Comparing stage-one/stage-two: ${enhancement}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/benchmark-agent.ts', '--mode', mode, '--profile', 'enhanced', '--enhancement', enhancement, '--output', path], { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', () => resolve()); // Assertion failures remain in the report; do not hide regressions.
  });
  reports.push(JSON.parse(await readFile(path, 'utf8')) as EnhancementReport);
  paths.push(path);
}
const comparison = compareEnhancements(reports[0], reports[1]);
const report = { version: 1, at: new Date().toISOString(), mode, reports: paths, comparison,
  interpretation: 'Stage-one retained critic/context versus targeted package on one clean checkout. Single sample per case; model aliases may change. Mock outputs test tool decisions, not generated visual quality. Cost and creative success require separate GPU/user evidence.' };
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Enhancement comparison: ${output}; pairs=${comparison.pairedCases}, improved=${comparison.improved}, regressed=${comparison.regressed}, token delta=${comparison.totalTokensDelta}`);
if (!comparison.comparable || comparison.excludedControlCases) process.exitCode = 2;
else if (comparison.regressed) process.exitCode = 1;

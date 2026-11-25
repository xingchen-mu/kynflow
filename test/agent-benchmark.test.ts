// The real canvas tools + TaskManager against a loopback HTTP ComfyUI fixture. No keys or GPU.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'kynflow-benchmark-test-'));
const { CORE_BENCHMARK_CASES } = await import('../server/agent/evaluation/fixtures/core.ts');
const { runBenchmarkCase } = await import('../server/agent/evaluation/runner.ts');

test('all twenty authored cases execute against Mock ComfyUI with baseline and enhanced tools', { timeout: 120000 }, async (t) => {
  t.after(() => rmSync(process.env.DATA_DIR!, { recursive: true, force: true }));
  for (const profile of ['baseline', 'enhanced'] as const) for (const spec of CORE_BENCHMARK_CASES) {
    await t.test(`${profile}: ${spec.id}`, async () => {
      const { result, observation, mockRequests } = await runBenchmarkCase(spec, { mode: 'scripted', profile });
      assert.deepEqual(result.failures, []);
      assert.equal(result.status, 'passed');
      assert.ok(observation.traces.every((trace) => trace.generationEnvironment === 'mock' && trace.profile === profile));
      assert.equal(mockRequests, observation.tasks.filter((task) => task.promptId).length);
      if (spec.setup === 'offline') assert.equal(mockRequests, 0);
    });
  }
  await t.test('unavailable editing also blocks the built-in Qwen reference tool', async () => {
    const spec = { ...CORE_BENCHMARK_CASES[0], setup: 'upscale_only' as const,
      script: [{ tool: 'generate_image', args: { prompt: 'change background', reference_ids: ['image-a'], aspect: '1:1' } }] };
    const { observation, mockRequests } = await runBenchmarkCase(spec, { mode: 'scripted', profile: 'baseline' });
    assert.equal(mockRequests, 0);
    assert.equal(observation.tasks.length, 0);
    assert.ok(observation.traces.flatMap((trace) => trace.events).some((event) => event.type === 'tool_end' && event.tool === 'generate_image' && event.ok === false));
  });
});

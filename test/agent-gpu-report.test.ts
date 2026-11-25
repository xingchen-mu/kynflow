import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gpuReportLabel, gpuReportPath } from '../server/agent/evaluation/gpu-report.ts';

test('GPU telemetry destinations are JSON files and device labels reject payloads and unbounded data', () => {
  assert.ok(gpuReportPath('output/test.json').endsWith('/output/test.json'));
  for (const path of ['output/test.js', 'output/test.sh', 'output/test.json.js']) assert.throws(() => gpuReportPath(path), /json/);
  assert.equal(gpuReportLabel('NVIDIA RTX A6000'), 'NVIDIA RTX A6000');
  assert.equal(gpuReportLabel('cuda:0 NVIDIA RTX A6000 : cudaMallocAsync'), 'cuda:0 NVIDIA RTX A6000 : cudaMallocAsync');
  assert.equal(gpuReportLabel('0.41.2'), '0.41.2');
  assert.equal(gpuReportLabel(undefined), undefined);
  for (const value of ['GPU\n', '<script>alert(1)</script>', 'x'.repeat(129), {}, '']) assert.throws(() => gpuReportLabel(value), /Invalid/);
});

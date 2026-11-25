import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GpuSubmissionBudget } from '../server/agent/evaluation/gpu-budget.ts';

test('real GPU evaluation cannot submit without a phase budget', async () => {
  const budget = new GpuSubmissionBudget();
  let submitted = false;
  await assert.rejects(() => budget.submit(async () => { submitted = true; }), /预算/);
  assert.equal(submitted, false);
});

test('one permitted real GPU attempt is reserved before asynchronous submission', async () => {
  const budget = new GpuSubmissionBudget();
  budget.start(1);
  let release!: () => void;
  const first = budget.submit(() => new Promise<void>((resolve) => { release = resolve; }));
  await assert.rejects(() => budget.submit(async () => {}), /预算/);
  assert.throws(() => budget.start(1), /in flight/);
  release(); await first;
  budget.start(0);
  await assert.rejects(() => budget.submit(async () => {}), /预算/);
});

test('a failed real GPU submission still consumes its attempt and cannot loop', async () => {
  const budget = new GpuSubmissionBudget();
  budget.start(1);
  await assert.rejects(() => budget.submit(async () => { throw new Error('backend failed'); }), /backend/);
  await assert.rejects(() => budget.submit(async () => {}), /预算/);
  assert.throws(() => budget.start(-1), /Invalid/);
});

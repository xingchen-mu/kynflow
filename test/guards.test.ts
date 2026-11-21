import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasTools } from '../server/agent/tools.ts';
import { type EditClipCheck, editIssues, stabilityIssues } from '../server/agent/guards.ts';
import { frameDistance } from '../server/agent/media.ts';

test('frameDistance tells the same picture from a different one', () => {
  assert.equal(frameDistance([0, 0.5, 1], [0, 0.5, 1]), 0);
  assert.equal(frameDistance([0, 0], [1, 1]), 1, 'black against white');
  assert.equal(frameDistance([0.2, 0.4], [0.2, 0.6]), 0.1);
  assert.equal(frameDistance([], [1]), 1, 'nothing to compare is a difference');
});

test('the stability precheck blocks fine hand work under complex camera work', () => {
  const issues = stabilityIssues('The camera pushes in and pans right at slow speed as he buttons his coat.');
  assert.deepEqual(issues.map((i) => i.risk), ['hands']);
  assert.match(issues[0].detail, /buttons/);
  assert.match(issues[0].camera, /pushes in/);
});

test('the stability precheck blocks a large movement under complex camera work', () => {
  const issues = stabilityIssues('The camera arcs around him as he jumps onto the table.');
  assert.deepEqual(issues.map((i) => i.risk), ['motion']);
});

test('the stability precheck leaves ordinary shots alone', () => {
  assert.deepEqual(stabilityIssues('The camera holds a static shot as he buttons his coat.'), []);
  assert.deepEqual(stabilityIssues('The camera pushes in with small amplitude at slow speed toward his hands.'), []);
  assert.deepEqual(stabilityIssues('The camera pushes in with small amplitude at slow speed. He stumbles back, nearly dropping the phone.'), []);
});

test('the edit gate blocks an audible clip with no lines', () => {
  const clip: EditClipCheck = { name: 'S02', duration: 5, start: 0, end: 5, hasAudio: true, spans: [{ start: 1, end: 2.4 }], lines: 0 };
  assert.deepEqual(editIssues([clip]), [{ kind: 'missing-lines', name: 'S02', span: { start: 1, end: 2.4 } }]);
});

test('the edit gate blocks a trim that cuts 0.3 s or more of sound', () => {
  const cut = editIssues([{ name: 'S03', duration: 5, start: 0, end: 2.5, hasAudio: true, spans: [{ start: 2.2, end: 2.8 }], lines: 1 }]);
  assert.equal(cut.length, 1);
  assert.equal(cut[0].kind, 'cut-sound');
  if (cut[0].kind === 'cut-sound') {
    assert.equal(cut[0].lost, 0.3);
    assert.deepEqual(cut[0].keep, { from: 0, to: 2.5 });
  }
  assert.deepEqual(editIssues([{ name: 'S03', duration: 5, start: 0, end: 2.6, hasAudio: true, spans: [{ start: 2.2, end: 2.8 }], lines: 1 }]), []);
});

test('the edit gate leaves silent clips and fully kept sound alone', () => {
  assert.deepEqual(editIssues([{ name: 'S04', duration: 5, start: 0, end: 5, hasAudio: true, spans: [], lines: 0 }]), []);
  assert.deepEqual(editIssues([{ name: 'S05', duration: 5, start: 0, end: 5, hasAudio: true, spans: [{ start: 1, end: 2 }], lines: 1 }]), []);
});

test('batch_generate_videos refuses a risky shot before queueing it', async () => {
  const deps = {
    projects: {
      get: async () => ({ id: 'board00001', name: 't', items: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 0, updatedAt: 0 }),
    },
  } as unknown as Parameters<typeof canvasTools>[0];
  const submit = canvasTools(deps, {} as Parameters<typeof canvasTools>[1]).find((t) => t.name === 'batch_generate_videos')!;
  await assert.rejects(
    () => submit.run({ jobs: [{ prompt: 'The camera pushes in and pans right as he buttons his coat.', first_frame_id: 'img1' }] }, { projectId: 'board00001' }),
    /稳定性预检没通过[\s\S]*buttons/,
  );
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CustomWorkflow } from '../shared/types.ts';
import { WorkflowFormatError, detectWorkflow, parseWorkflowJson } from '../server/workflows/custom.ts';
import { describeCapability, matchesCapability, resolveCapability } from '../server/workflows/capability.ts';
import { RequestError, buildWorkflow } from '../server/workflows/index.ts';

const file = (name: string, width = 1024, height = 1024) => ({ comfyName: name, width, height });
const nodesOf = (graph: Record<string, { class_type: string }>) => Object.values(graph).map((n) => n.class_type);
const textOf = (graph: Record<string, { inputs: Record<string, unknown> }>) => JSON.stringify(Object.values(graph).map((n) => n.inputs));
const preset = (name: string) => {
  const p = JSON.parse(readFileSync(new URL(`../presets/${name}.json`, import.meta.url), 'utf8'));
  return { id: `tpl_${p.id}`, name: p.name, kind: p.kind, graph: p.graph, inputs: p.inputs, outputs: p.outputs, createdAt: 0, updatedAt: 0 } as CustomWorkflow;
};

test('text to image follows the aspect ratio at about one megapixel', () => {
  const wf = buildWorkflow({ op: 'image.generate', model: 'qwen', prompt: '一只猫', aspect: '16:9', quality: '1k' }, { images: [] }, 42, () => undefined);
  assert.equal(wf.expected.kind, 'image');
  const { width, height } = wf.expected;
  assert.ok(Math.abs(width / height - 16 / 9) < 0.05 && width % 32 === 0 && height % 32 === 0);
  assert.ok(Math.abs((width * height) / 2 ** 20 - 1) < 0.15);
  assert.ok(wf.outputNodes.length > 0);
});

test('reference images are wired in and 图1 becomes the model tag', () => {
  const wf = buildWorkflow(
    { op: 'image.generate', model: 'qwen', prompt: '把图1的人放进图2', aspect: 'auto', quality: '1k', images: ['a', 'b'] },
    { images: [file('a.png'), file('b.png')] },
    1,
    () => undefined,
  );
  const text = textOf(wf.graph);
  assert.ok(text.includes('a.png') && text.includes('b.png'));
  assert.ok(text.includes('<image1>') && text.includes('<image2>'));
});

test('MiniMax reference video uses its node and <Picture n> tags', () => {
  const wf = buildWorkflow(
    { op: 'video.generate', model: 'minimax-ref', prompt: '@图1 在走路', aspect: '16:9', quality: '480p', duration: 5, images: ['a'] },
    { images: [file('a.png', 1376, 768)] },
    1,
    () => undefined,
  );
  assert.equal(wf.expected.kind, 'video');
  assert.ok(nodesOf(wf.graph).includes('MiniMaxH3ReferenceToVideo'));
  assert.ok(textOf(wf.graph).includes('<Picture 1>'));
});

test('bad requests fail before anything is queued', () => {
  assert.throws(() => buildWorkflow({ op: 'image.generate', model: 'qwen', prompt: ' ', aspect: '1:1', quality: '1k' }, { images: [] }, 1, () => undefined), RequestError);
  assert.throws(() => buildWorkflow({ op: 'image.generate', model: 'qwen', prompt: 'x', aspect: '50:1', quality: '1k' }, { images: [] }, 1, () => undefined), RequestError);
  assert.throws(() => buildWorkflow({ op: 'video.generate', model: 'minimax-ref', prompt: 'x', aspect: '16:9', quality: '480p', duration: 5 }, { images: [] }, 1, () => undefined), RequestError);
});

test('an imported workflow gets the prompt, seed and a new shape with the same pixel budget', () => {
  const wf = preset('qwen-image-2512');
  const built = buildWorkflow({ op: 'custom', workflow: wf.id, prompt: '海边的灯塔', aspect: '16:9' }, { images: [], videos: [] }, 7, () => wf);
  const input = (type: string) => wf.inputs.find((i) => i.type === type)!;
  const value = (type: string) => built.graph[input(type).node].inputs[input(type).field];
  assert.equal(value('prompt'), '海边的灯塔');
  assert.equal(value('seed'), 7);
  const w = Number(value('width'));
  const h = Number(value('height'));
  const base = Number(wf.graph[input('width').node].inputs[input('width').field]) * Number(wf.graph[input('height').node].inputs[input('height').field]);
  assert.ok(Math.abs(w / h - 16 / 9) < 0.05);
  assert.ok(Math.abs((w * h) / base - 1) < 0.1);
  // The stored workflow is not changed by a run.
  assert.notEqual(wf.graph[input('prompt').node].inputs[input('prompt').field], '海边的灯塔');
});

test('importing finds the prompt and the output of an exported graph', () => {
  const wf = preset('qwen-image-2512');
  const { graph } = parseWorkflowJson(wf.graph);
  const draft = detectWorkflow(graph);
  assert.equal(draft.workflow.kind, 'image');
  assert.ok(draft.workflow.inputs.some((i) => i.type === 'prompt'));
  assert.ok(draft.workflow.outputs.length > 0);
});

test('a UI-format workflow (not "Export (API)") is refused with a hint', () => {
  assert.throws(() => parseWorkflowJson({ nodes: [], links: [], version: 0.4 }), WorkflowFormatError);
});

const graphOf = (classes: string[]) =>
  Object.fromEntries(classes.map((c, i) => [String(i + 1), { class_type: c, inputs: {} }]));
const made = (
  kind: 'image' | 'video',
  inputs: CustomWorkflow['inputs'],
  classes: string[] = ['KSampler'],
): Pick<CustomWorkflow, 'kind' | 'inputs' | 'outputs' | 'graph'> => ({ kind, inputs, outputs: ['1'], graph: graphOf(classes) as CustomWorkflow['graph'] });
const slot = (type: CustomWorkflow['inputs'][number]['type'], optional = false) => ({
  id: `${type}1`,
  type,
  node: '1',
  field: 'x',
  label: type,
  optional,
});

test('capability follows the input mapping', () => {
  assert.equal(describeCapability(made('image', [slot('prompt')])).capability, 'text_to_image');
  assert.equal(describeCapability(made('image', [slot('prompt'), slot('image')])).capability, 'image_edit');
  assert.equal(describeCapability(made('image', [slot('image'), slot('mask')])).capability, 'inpaint');
  assert.equal(describeCapability(made('video', [slot('prompt')])).capability, 'text_to_video');
  assert.equal(describeCapability(made('video', [slot('prompt'), slot('image')])).capability, 'image_to_video');
  assert.equal(describeCapability(made('video', [slot('video'), slot('image')])).capability, 'video_edit');
});

test('a graph whose class names give it away is classified by that, not by inputs', () => {
  const upscale = describeCapability(made('image', [slot('image')], ['LoadImage', 'SeedVR2Upscale', 'SaveImage']));
  assert.equal(upscale.capability, 'upscale');
  const cutout = describeCapability(made('image', [slot('image')], ['LoadImage', 'RemoveBackground', 'SaveImage']));
  assert.equal(cutout.capability, 'remove_background');
});

test('constraints say what a run needs before it is attempted', () => {
  const c = describeCapability(made('image', [slot('prompt'), slot('image'), slot('image', true), slot('width'), slot('height')])).constraints;
  assert.equal(c.requires_image, true);
  assert.equal(c.min_images, 1);
  assert.equal(c.max_images, 2);
  assert.equal(c.min_videos, 0);
  assert.equal(c.controls_aspect, true);
  assert.equal(c.requires_prompt, true);
  assert.equal(c.requires_mask, false);
  const optionalOnly = describeCapability(made('image', [slot('image', true)])).constraints;
  assert.equal(optionalOnly.requires_image, false);
  // A prompt with a default does not have to be supplied.
  const defaults = describeCapability(made('image', [{ ...slot('prompt'), default: 'a cat' }])).constraints;
  assert.equal(defaults.requires_prompt, false);
});

test('missing node metadata is recorded instead of being passed off as verified', () => {
  const wf = made('image', [slot('prompt'), slot('image')]);
  assert.equal(describeCapability(wf).source, 'degraded');
  const full = describeCapability(wf, { KSampler: {} });
  assert.equal(full.source, 'inferred');
  assert.equal(full.constraints.unverified_nodes, undefined);
  // The loader's class type is unknown to the server: still usable, but marked.
  const partial = describeCapability(made('image', [slot('image')], ['LoadImage', 'MysteryNode']), { LoadImage: {} });
  assert.equal(partial.source, 'degraded');
  assert.deepEqual(partial.constraints.unverified_nodes, ['MysteryNode']);
});

test('selection isolates capabilities and enforces the real input counts', () => {
  const edit = { ...made('image', [slot('prompt'), slot('image'), slot('image', true)]) } as CustomWorkflow;
  edit.capability = describeCapability(edit);
  const textImage = { ...made('image', [slot('prompt')]) } as CustomWorkflow;
  textImage.capability = describeCapability(textImage);
  const imageVideo = { ...made('video', [slot('prompt'), slot('image')]) } as CustomWorkflow;
  imageVideo.capability = describeCapability(imageVideo);
  const textVideo = { ...made('video', [slot('prompt')]) } as CustomWorkflow;
  textVideo.capability = describeCapability(textVideo);

  assert.equal(matchesCapability(edit, {}), true);
  assert.equal(matchesCapability(edit, { capability: 'image_edit', image_count: 1 }), true);
  assert.equal(matchesCapability(edit, { capability: 'image_edit', image_count: 2 }), true);
  assert.equal(matchesCapability(edit, { capability: 'image_edit', image_count: 0 }), false);
  assert.equal(matchesCapability(edit, { capability: 'image_edit', image_count: 3 }), false);
  assert.equal(matchesCapability(edit, { capability: 'text_to_video', image_count: 1 }), false);
  assert.equal(matchesCapability(textImage, { capability: 'text_to_image', image_count: 1 }), false);
  assert.equal(matchesCapability(imageVideo, { capability: 'image_to_video', image_count: 1 }), true);
  assert.equal(matchesCapability(edit, { capability: 'image_to_video', image_count: 1 }), false);
  assert.equal(matchesCapability(edit, { needs: 'image' }), true);
  assert.equal(matchesCapability(textVideo, { needs: 'image' }), false);
  assert.equal(matchesCapability(textVideo, { needs: 'mask' }), false);
  assert.equal(matchesCapability(edit, { video_count: 1 }), false);
});

test('selection filters unsupported aspect ratios without rejecting auto', () => {
  const fixed = { ...made('image', [slot('prompt')]) } as CustomWorkflow;
  fixed.capability = describeCapability(fixed);
  const sized = { ...made('image', [slot('prompt'), slot('width'), slot('height')]) } as CustomWorkflow;
  sized.capability = describeCapability(sized);
  const dropdown = { ...made('image', [slot('prompt'), slot('aspect')]) } as CustomWorkflow;
  dropdown.capability = describeCapability(dropdown);

  assert.equal(matchesCapability(fixed, { aspect: '16:9' }), false);
  assert.equal(matchesCapability(fixed, { aspect: 'auto' }), true);
  assert.equal(matchesCapability(sized, { aspect: '16:9' }), true);
  assert.equal(matchesCapability(dropdown, { aspect: '9:16' }), true);
});

test('old saved capabilities fall back to input mappings for minimum counts', () => {
  const legacy = { ...made('image', [slot('prompt'), slot('image'), slot('image', true)]) } as CustomWorkflow;
  const described = describeCapability(legacy);
  const { min_images: _images, min_videos: _videos, ...constraints } = described.constraints;
  legacy.capability = { ...described, constraints };

  assert.equal(matchesCapability(legacy, { image_count: 0 }), false);
  assert.equal(matchesCapability(legacy, { image_count: 1 }), true);
  assert.equal(matchesCapability(legacy, { image_count: 2 }), true);
  assert.equal(matchesCapability(legacy, { image_count: 3 }), false);
});

test('declarations override only author fields while constraints are recomputed', () => {
  const wf = made('image', [slot('prompt'), slot('image'), slot('image', true)]);
  const inferred = describeCapability(wf, { KSampler: {} });
  const declared = resolveCapability(wf, { KSampler: {} }, {
    ...inferred,
    capability: 'text_to_video',
    source: 'declared',
    cost: 'high',
    expected_seconds: 95,
    constraints: { ...inferred.constraints, min_images: 0, max_images: 99, controls_aspect: true },
  });

  assert.equal(declared.capability, 'text_to_video');
  assert.equal(declared.source, 'declared');
  assert.equal(declared.cost, 'high');
  assert.equal(declared.expected_seconds, 95);
  assert.equal(declared.constraints.min_images, 1);
  assert.equal(declared.constraints.max_images, 2);
  assert.equal(declared.constraints.controls_aspect, false);
});

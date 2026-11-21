// What a workflow can do, so the agent picks one by capability instead of by name.
//
// Derived from the mapping the import already produced (kind / inputs / outputs) plus weak
// evidence from node class names. Node metadata (/object_info) is optional: when it is missing,
// the result is marked 'degraded' instead of being presented as verified.

import type {
  CustomWorkflow,
  WorkflowCapability,
  WorkflowCapabilityInfo,
  WorkflowConstraints,
  WorkflowLike,
} from '../../shared/types.ts';

type Describable = Pick<CustomWorkflow, 'kind' | 'inputs' | 'outputs' | 'graph'>;

const REMOVE_BG = /RemoveBackground|RemoveBg|RemBg|BiRefNet|BriaRemove/i;
const UPSCALE = /Upscal|SeedVR|ESRGAN|SwinIR|RealESRGAN/i;

/** Class names are only a hint; the input mapping stays the primary signal. */
function classify(wf: Describable, classes: string[], evidence: string[]): WorkflowCapability {
  const images = wf.inputs.filter((i) => i.type === 'image');
  const videos = wf.inputs.filter((i) => i.type === 'video');
  const masks = wf.inputs.filter((i) => i.type === 'mask');
  const hasPrompt = wf.inputs.some((i) => i.type === 'prompt');
  const has = (re: RegExp) => classes.some((c) => re.test(c));

  if (has(REMOVE_BG)) {
    evidence.push('class:remove_background');
    return 'remove_background';
  }
  if (has(UPSCALE) && !hasPrompt && !videos.length) {
    evidence.push('class:upscale');
    return 'upscale';
  }
  if (wf.kind === 'audio') {
    evidence.push('audio_output');
    return 'text_to_audio';
  }
  if (wf.kind === 'model3d') {
    evidence.push('3d_output');
    return 'text_to_3d';
  }
  if (wf.kind === 'document') {
    evidence.push('document_output');
    return 'text_to_document';
  }
  if (wf.kind === 'video') {
    if (videos.length) {
      evidence.push('video_input');
      return 'video_edit';
    }
    if (images.length) {
      evidence.push('image_input');
      return 'image_to_video';
    }
    evidence.push('video_output');
    return 'text_to_video';
  }
  if (masks.length) {
    evidence.push('mask_input');
    return 'inpaint';
  }
  if (images.length) {
    evidence.push('image_input');
    return 'image_edit';
  }
  evidence.push('image_output');
  return 'text_to_image';
}

/**
 * Capability + constraints for a workflow.
 *
 * `info` is the server's /object_info map. Pass it when the workflow was just imported or saved;
 * without it the description is still usable but marked 'degraded'.
 */
export function describeCapability(wf: Describable, info?: Record<string, unknown>): WorkflowCapabilityInfo {
  const classes = [...new Set(Object.values(wf.graph).map((n) => n.class_type))];
  const evidence: string[] = [];
  const capability = classify(wf, classes, evidence);

  const images = wf.inputs.filter((i) => i.type === 'image');
  const videos = wf.inputs.filter((i) => i.type === 'video');
  const masks = wf.inputs.filter((i) => i.type === 'mask');
  const unverified = info ? classes.filter((c) => !info[c]) : [];

  const constraints: WorkflowConstraints = {
    requires_image: images.some((i) => !i.optional),
    requires_mask: masks.length > 0,
    min_images: images.filter((i) => !i.optional).length,
    min_videos: videos.filter((i) => !i.optional).length,
    max_images: images.length,
    max_videos: videos.length,
    controls_aspect:
      (wf.inputs.some((i) => i.type === 'width') && wf.inputs.some((i) => i.type === 'height')) ||
      wf.inputs.some((i) => i.type === 'aspect'),
    requires_prompt: wf.inputs.some((i) => i.type === 'prompt' && !String(i.default ?? '').trim()),
    ...(unverified.length ? { unverified_nodes: unverified } : {}),
  };

  return {
    capability,
    // 'declared' is reserved for a capability an author states explicitly; we only infer today.
    source: info && !unverified.length ? 'inferred' : 'degraded',
    constraints,
    evidence,
  };
}

/** Overlay author choices on a freshly inferred description; stale constraints never survive. */
export function resolveCapability(wf: Describable, info: Record<string, unknown> | undefined, declared?: WorkflowCapabilityInfo): WorkflowCapabilityInfo {
  const inferred = describeCapability(wf, info);
  if (declared?.source !== 'declared') return inferred;
  return {
    ...inferred,
    capability: declared.capability,
    source: 'declared',
    ...(declared.cost ? { cost: declared.cost } : {}),
    ...(declared.expected_seconds !== undefined ? { expected_seconds: declared.expected_seconds } : {}),
  };
}

export interface CapabilityQuery {
  capability?: string;
  /** Keep only workflows that accept this kind of input. */
  needs?: 'image' | 'video' | 'mask';
  image_count?: number;
  video_count?: number;
  aspect?: string;
}

/** Selection filter used by list_workflows. Workflows without a capability never match a filter. */
export function matchesCapability(wf: WorkflowLike, want: CapabilityQuery): boolean {
  const filtered = want.capability || want.needs || want.image_count !== undefined || want.video_count !== undefined || (want.aspect && want.aspect !== 'auto');
  if (!filtered) return true;
  const info = wf.capability;
  if (!info) return false;
  const c = info.constraints;
  const minImages = c.min_images ?? wf.inputs.filter((i) => i.type === 'image' && !i.optional).length;
  const minVideos = c.min_videos ?? wf.inputs.filter((i) => i.type === 'video' && !i.optional).length;
  if (want.capability && info.capability !== want.capability) return false;
  if (want.needs === 'image' && !c.max_images) return false;
  if (want.needs === 'video' && !c.max_videos) return false;
  if (want.needs === 'mask' && !c.requires_mask) return false;
  if (want.image_count !== undefined && (want.image_count < minImages || want.image_count > c.max_images)) return false;
  if (want.video_count !== undefined && (want.video_count < minVideos || want.video_count > c.max_videos)) return false;
  if (want.aspect && want.aspect !== 'auto' && !c.controls_aspect) return false;
  return true;
}

export const CAPABILITIES: WorkflowCapability[] = [
  'text_to_image',
  'image_edit',
  'inpaint',
  'upscale',
  'remove_background',
  'text_to_video',
  'image_to_video',
  'video_edit',
  'other',
];

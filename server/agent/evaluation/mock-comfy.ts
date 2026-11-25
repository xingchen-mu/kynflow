import sharp from 'sharp';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ComfyApiGraph, CustomWorkflow, WorkflowCapability, WorkflowInput } from '../../../shared/types.ts';
import type { ComfyEvent, HistoryEntry } from '../../comfy/client.ts';

export function benchmarkWorkflows(): CustomWorkflow[] {
  return [
    ['eval-upscale', '图像超分辨率', 'upscale', 1, false],
    ['eval-remove-bg', '主体抠图', 'remove_background', 1, false],
    ['eval-edit-one', '单参考图编辑', 'image_edit', 1, true],
    ['eval-edit-two', '双参考图编辑', 'image_edit', 2, true],
  ].map(([id, name, capability, count, prompt]) => {
    const imageCount = Number(count);
    const inputs: WorkflowInput[] = Array.from({ length: imageCount }, (_, index) => ({ id: `image${index + 1}`, label: `Image ${index + 1}`, type: 'image', node: String(index + 1), field: 'image' }));
    const graph: ComfyApiGraph = Object.fromEntries(inputs.map((input) => [input.node, { class_type: 'LoadImage', inputs: { image: '' } }]));
    graph.operation = { class_type: 'BenchmarkOperation', inputs: { operation: capability, image: ['1', 0], prompt: '', width: 512, height: 512, scale: 2 } };
    graph.output = { class_type: 'SaveImage', inputs: { images: ['operation', 0], filename_prefix: 'benchmark' } };
    if (prompt) inputs.push({ id: 'prompt', label: 'Prompt', type: 'prompt', node: 'operation', field: 'prompt' });
    inputs.push({ id: 'width', label: 'Width', type: 'width', node: 'operation', field: 'width' }, { id: 'height', label: 'Height', type: 'height', node: 'operation', field: 'height' });
    if (capability === 'upscale') inputs.push({ id: 'scale', label: 'Scale', type: 'number', node: 'operation', field: 'scale', default: 2, min: 1, max: 4 });
    return { id: String(id), name: String(name), kind: 'image', graph, inputs, outputs: ['output'], createdAt: 1, updatedAt: 1,
      capability: { capability: capability as WorkflowCapability, source: 'declared', evidence: ['benchmark fixture'], constraints: { requires_image: true, requires_mask: false, min_images: imageCount, min_videos: 0, max_images: imageCount, max_videos: 0, controls_aspect: true, requires_prompt: Boolean(prompt) } } };
  });
}

/** Real HTTP protocol and real TaskManager; graphs are recorded and never executed on a GPU. */
export class MockComfyServer {
  private server = createServer((request, response) => { void this.handle(request, response).catch(() => { response.writeHead(500); response.end(); }); });
  private history = new Map<string, HistoryEntry>();
  private media = new Map<string, Buffer>();
  private uploads = new Map<string, Buffer>();
  private timers = new Set<NodeJS.Timeout>();
  readonly submissions: { id: string; graph: ComfyApiGraph }[] = [];
  url = '';
  onEvent: (event: ComfyEvent) => void = () => {};
  constructor(private image: Buffer, private failFirst = false) {}

  async start() {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Mock ComfyUI did not start');
    this.url = `http://127.0.0.1:${address.port}`;
  }

  private async body(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4_000_000) throw new Error('Mock request too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  private later(callback: () => void, ms: number) {
    const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, ms);
    this.timers.add(timer);
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    if (url.pathname === '/system_stats') return json({ system: { comfyui_version: 'mock-v2' }, devices: [] });
    if (url.pathname === '/object_info') return json({});
    if (url.pathname === '/queue') return json({ queue_running: [], queue_pending: [] });
    if (url.pathname === '/upload/image') {
      const bytes = await this.body(request);
      const form = await new Response(new Uint8Array(bytes), { headers: { 'content-type': String(request.headers['content-type']) } }).formData();
      const file = form.get('image');
      if (!file || typeof file === 'string') throw new Error('Mock upload requires an image');
      const name = `input-${this.uploads.size}.png`;
      this.uploads.set(`benchmark/${name}`, Buffer.from(await file.arrayBuffer()));
      return json({ name, subfolder: 'benchmark', type: 'input' });
    }
    if (url.pathname === '/view') { response.setHeader('content-type', 'image/png'); response.end(this.media.get(url.searchParams.get('filename') ?? '') ?? this.image); return; }
    if (url.pathname.startsWith('/history/')) { const id = url.pathname.slice('/history/'.length); return json(this.history.has(id) ? { [id]: this.history.get(id) } : {}); }
    if (url.pathname === '/prompt' && request.method === 'POST') {
      const body = JSON.parse((await this.body(request)).toString('utf8')) as { prompt_id: string; prompt: ComfyApiGraph };
      const failed = this.failFirst && this.submissions.length === 0;
      this.submissions.push({ id: body.prompt_id, graph: body.prompt });
      const outputName = `output-${this.submissions.length}.png`;
      this.media.set(outputName, await this.render(body.prompt));
      json({ prompt_id: body.prompt_id, number: this.submissions.length });
      this.later(() => this.onEvent({ type: 'execution_start', data: { prompt_id: body.prompt_id } }), 15);
      this.later(() => {
        const error = { prompt_id: body.prompt_id, node_type: 'KSampler', exception_message: 'CUDA out of memory' };
        const outputs = Object.fromEntries(Object.entries(body.prompt).filter(([, node]) => /SaveImage|PreviewImage/.test(node.class_type)).map(([id]) => [id, { images: [{ filename: outputName, subfolder: '', type: 'output' }] }]));
        this.history.set(body.prompt_id, { prompt: [], outputs, status: { completed: true, status_str: failed ? 'error' : 'success', messages: failed ? [['execution_error', error]] : [] } });
        this.onEvent({ type: failed ? 'execution_error' : 'execution_success', data: failed ? error : { prompt_id: body.prompt_id } });
      }, 60);
      return;
    }
    if (url.pathname === '/interrupt') return json({});
    response.writeHead(404); response.end();
  }

  private async render(graph: ComfyApiGraph): Promise<Buffer> {
    const operation = Object.values(graph).find((node) => node.class_type === 'BenchmarkOperation')?.inputs;
    const load = Object.values(graph).find((node) => node.class_type === 'LoadImage')?.inputs.image;
    const source = typeof load === 'string' ? this.uploads.get(load) ?? this.image : this.image;
    const meta = await sharp(source).metadata();
    const latent = Object.values(graph).find((node) => /Empty.*Latent/.test(node.class_type))?.inputs;
    let width = Number(operation?.width ?? latent?.width ?? meta.width);
    let height = Number(operation?.height ?? latent?.height ?? meta.height);
    if (operation?.operation === 'upscale') { width = Number(meta.width) * Number(operation.scale ?? 2); height = Number(meta.height) * Number(operation.scale ?? 2); }
    if (operation?.operation === 'remove_background') { width = Number(meta.width); height = Number(meta.height); }
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 16777216) throw new Error('Mock dimensions outside fixture limits');
    // Only protocol semantics are simulated. These pixels cannot establish editing or aesthetic quality.
    let output = sharp(source).resize(width, height, { fit: 'fill' });
    if (operation?.operation === 'remove_background') output = output.ensureAlpha();
    return output.png().toBuffer();
  }

  async close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}

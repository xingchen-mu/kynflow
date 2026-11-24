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
    graph.operation = { class_type: 'BenchmarkOperation', inputs: { image: ['1', 0], prompt: '', width: 512, height: 512, scale: 2 } };
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
    return Buffer.concat(chunks).toString('utf8');
  }

  private later(callback: () => void, ms: number) {
    const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, ms);
    this.timers.add(timer);
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    if (url.pathname === '/system_stats') return json({ system: { comfyui_version: 'mock-v1' }, devices: [] });
    if (url.pathname === '/object_info') return json({});
    if (url.pathname === '/queue') return json({ queue_running: [], queue_pending: [] });
    if (url.pathname === '/upload/image') { await this.body(request); return json({ name: 'input.png', subfolder: 'benchmark', type: 'input' }); }
    if (url.pathname === '/view') { response.setHeader('content-type', 'image/png'); response.end(this.image); return; }
    if (url.pathname.startsWith('/history/')) { const id = url.pathname.slice('/history/'.length); return json(this.history.has(id) ? { [id]: this.history.get(id) } : {}); }
    if (url.pathname === '/prompt' && request.method === 'POST') {
      const body = JSON.parse(await this.body(request)) as { prompt_id: string; prompt: ComfyApiGraph };
      const failed = this.failFirst && this.submissions.length === 0;
      this.submissions.push({ id: body.prompt_id, graph: body.prompt });
      json({ prompt_id: body.prompt_id, number: this.submissions.length });
      this.later(() => this.onEvent({ type: 'execution_start', data: { prompt_id: body.prompt_id } }), 15);
      this.later(() => {
        const error = { prompt_id: body.prompt_id, node_type: 'KSampler', exception_message: 'CUDA out of memory' };
        const outputs = Object.fromEntries(Object.entries(body.prompt).filter(([, node]) => /SaveImage|PreviewImage/.test(node.class_type)).map(([id]) => [id, { images: [{ filename: 'output.png', subfolder: '', type: 'output' }] }]));
        this.history.set(body.prompt_id, { prompt: [], outputs, status: { completed: true, status_str: failed ? 'error' : 'success', messages: failed ? [['execution_error', error]] : [] } });
        this.onEvent({ type: failed ? 'execution_error' : 'execution_success', data: failed ? error : { prompt_id: body.prompt_id } });
      }, 60);
      return;
    }
    if (url.pathname === '/interrupt') return json({});
    response.writeHead(404); response.end();
  }

  async close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}

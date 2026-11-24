import { Hono } from 'hono';
import { RequestError } from '../workflows/index.ts';
import { t } from '../i18n.ts';
import type { Services } from '../services.ts';
import { isLocal } from '../http/local.ts';
import { detectExtensions } from '../agent/extensions.ts';

export function registerAgentRoutes(app: Hono, { agent, projects, series }: Pick<Services, 'agent' | 'projects' | 'series'>) {
  // The agent spends the owner's API credits: only this machine may use it, even with the canvas shared on the LAN.
  app.use('/api/agent/*', async (c, next) => {
    if (!isLocal(c)) return c.json({ error: t('画布助手只能在运行服务的这台电脑上使用') }, 403);
    await next();
  });
  app.get('/api/agent/status', (c) => c.json(agent.status));
  // Before /api/agent/:projectId, which would take "extensions" for a board id.
  app.get('/api/agent/extensions', (c) => c.json(detectExtensions()));
  // Before /api/agent/:projectId, which would take "commands" for a board id.
  app.get('/api/agent/commands', async (c) => c.json(await agent.commands()));
  app.get('/api/agent/skills', async (c) => c.json(await agent.listSkills()));
  app.put('/api/agent/commands', async (c) => c.json(await agent.saveCommands(await c.req.json())));
  app.get('/api/agent/:projectId', async (c) => c.json(await agent.view(c.req.param('projectId'))));
  app.get('/api/agent/:projectId/task-graph', async (c) => c.json(await agent.taskGraph(c.req.param('projectId'))));
  app.get('/api/agent/:projectId/trace', async (c) => c.json(await agent.trace(c.req.param('projectId'))));
  app.get('/api/agent/:projectId/experiences', async (c) => c.json(await agent.experiences(c.req.param('projectId'))));
  app.post('/api/agent/:projectId/experiences/:id/confirm', async (c) => {
    const body = await c.req.json<{ outcome?: unknown }>();
    if (body.outcome !== 'success' && body.outcome !== 'failure') throw new RequestError(t('请求格式错误'));
    return c.json(await agent.confirmExperience(c.req.param('projectId'), c.req.param('id'), body.outcome));
  });
  app.get('/api/agent/:projectId/sessions', async (c) => c.json(await agent.listSessions(c.req.param('projectId'))));
  app.post('/api/agent/:projectId/sessions', async (c) => c.json(await agent.newSession(c.req.param('projectId'))));
  app.post('/api/agent/:projectId/sessions/:sessionId/open', async (c) =>
    c.json(await agent.openSession(c.req.param('projectId'), c.req.param('sessionId'))),
  );
  app.patch('/api/agent/:projectId/sessions/:sessionId', async (c) => {
    const body = await c.req.json<{ title?: string }>();
    return c.json(await agent.renameSession(c.req.param('projectId'), c.req.param('sessionId'), String(body.title ?? '')));
  });
  app.delete('/api/agent/:projectId/sessions/:sessionId', async (c) =>
    c.json(await agent.deleteSession(c.req.param('projectId'), c.req.param('sessionId'))),
  );
  app.post('/api/agent/:projectId', async (c) => {
    const body = await c.req.json<{ text?: string; selection?: string[]; view?: { x: number; y: number } }>();
    await agent.send(c.req.param('projectId'), {
      text: typeof body.text === 'string' ? body.text : '',
      selection: Array.isArray(body.selection) ? body.selection.filter((id) => typeof id === 'string') : [],
      view: body.view,
    });
    return c.json({ ok: true });
  });
  app.post('/api/agent/:projectId/abort', async (c) => {
    await agent.abort(c.req.param('projectId'));
    return c.json({ ok: true });
  });
  app.post('/api/agent/:projectId/condense', async (c) => {
    const body = await c.req.json<{ focus?: unknown }>().catch(() => ({}) as { focus?: unknown });
    await agent.condense(c.req.param('projectId'), typeof body.focus === 'string' ? body.focus : undefined);
    return c.json({ ok: true });
  });
  app.get('/api/agent/:projectId/memory', async (c) => {
    const projectId = c.req.param('projectId');
    const memories = await agent.memories(projectId);
    const project = await projects.get(projectId);
    if (!project?.seriesId) return c.json(memories);
    const [seriesInfo, all] = await Promise.all([series.get(project.seriesId), projects.list()]);
    return c.json({
      ...memories,
      seriesInfo: {
        id: project.seriesId,
        name: seriesInfo?.name ?? '',
        projects: all.filter((p) => p.seriesId === project.seriesId).map((p) => ({ id: p.id, name: p.name })),
      },
    });
  });
  app.get('/api/agent/:projectId/memory/promotions', async (c) => c.json(await agent.promotionCandidates(c.req.param('projectId'))));
  app.put('/api/agent/:projectId/memory', async (c) => {
    const body = await c.req.json<{ scope?: unknown; memory?: unknown }>();
    if (body.scope !== 'series' && body.scope !== 'board' && body.scope !== 'user') throw new RequestError(t('请求格式错误'));
    return c.json(await agent.saveMemory(c.req.param('projectId'), body.scope, body.memory));
  });
  app.post('/api/agent/:projectId/answer', async (c) => {
    const body = await c.req.json<{ id?: unknown; answer?: unknown }>();
    if (typeof body.id !== 'string' || typeof body.answer !== 'string') throw new RequestError(t('请求格式错误'));
    await agent.answer(c.req.param('projectId'), body.id, body.answer);
    return c.json({ ok: true });
  });
  app.post('/api/agent/:projectId/plan', async (c) => {
    const body = await c.req.json<{ on?: unknown }>();
    if (typeof body.on !== 'boolean') throw new RequestError(t('请求格式错误'));
    await agent.setPlan(c.req.param('projectId'), body.on);
    return c.json({ ok: true });
  });
  app.post('/api/agent/:projectId/rewind', async (c) => {
    const body = await c.req.json<{ id?: unknown }>();
    if (typeof body.id !== 'string') throw new RequestError(t('请求格式错误'));
    return c.json(await agent.rewind(c.req.param('projectId'), body.id));
  });
  app.post('/api/agent/:projectId/approve', async (c) => {
    const body = await c.req.json<{ id?: unknown; ok?: unknown; prompts?: unknown }>();
    if (typeof body.id !== 'string') throw new RequestError(t('请求格式错误'));
    const prompts = Array.isArray(body.prompts) ? body.prompts.map((p) => (typeof p === 'string' ? p : '')) : undefined;
    await agent.approve(c.req.param('projectId'), body.id, body.ok === true, prompts);
    return c.json({ ok: true });
  });
  app.delete('/api/agent/:projectId', async (c) => {
    await agent.clear(c.req.param('projectId'));
    return c.json({ ok: true });
  });
}

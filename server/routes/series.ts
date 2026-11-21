import { Hono } from 'hono';
import { RequestError } from '../workflows/index.ts';
import { t } from '../i18n.ts';
import type { Services } from '../services.ts';

export function registerSeriesRoutes(app: Hono, { series }: Pick<Services, 'series'>) {
  app.get('/api/series', async (c) => c.json(await series.list()));
  app.post('/api/series', async (c) => {
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
    if (body.name !== undefined && typeof body.name !== 'string') throw new RequestError(t('请求格式错误'));
    return c.json(await series.create(typeof body.name === 'string' ? body.name : undefined));
  });
}

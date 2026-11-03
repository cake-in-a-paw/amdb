import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../../platform/http/app-env';
import { createApi, ErrorSchema, json } from '../../platform/http/openapi';
import { rateLimit } from '../../platform/http/rate-limit';
import {
  MySubmissionsQuery,
  MySubmissionsSchema,
  SubmissionCreatedSchema,
  SubmissionDetailSchema,
  SubmissionInput,
} from './schemas';
import type { ChangesService } from './service';

const createSubmissionRoute = createRoute({
  method: 'post',
  path: '/api/submissions',
  request: { body: { content: { 'application/json': { schema: SubmissionInput } }, required: true } },
  responses: {
    201: json(SubmissionCreatedSchema, 'Created'),
    400: json(ErrorSchema, 'Invalid submission'),
    429: json(ErrorSchema, 'Rate limited'),
  },
});

const getSubmissionRoute = createRoute({
  method: 'get',
  path: '/api/submissions/{id}',
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: json(SubmissionDetailSchema), 404: json(ErrorSchema, 'Not found') },
});

const mySubmissionsRoute = createRoute({
  method: 'get',
  path: '/api/me/submissions',
  request: { query: MySubmissionsQuery },
  responses: { 200: json(MySubmissionsSchema), 400: json(ErrorSchema, 'No identity') },
});

const ANON_LIMIT = 20;
const ANON_WINDOW_MS = 60 * 60 * 1000;

/** The client's address as the first `x-forwarded-for` entry; absent when no proxy set it. */
const clientIp = (c: Context<AppEnv>) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null;

export function changesRoutes(changes: ChangesService) {
  const app = createApi();

  // Anonymous submissions only, per anon token and per client IP.
  const anonPost = (bucket: (c: Context<AppEnv>) => string | null) => (c: Context<AppEnv>) =>
    c.req.method === 'POST' && c.var.actor.kind === 'anon' ? bucket(c) : null;
  app.use(
    '/api/submissions',
    rateLimit({
      limit: ANON_LIMIT,
      windowMs: ANON_WINDOW_MS,
      key: anonPost((c) => (c.var.actor.kind === 'anon' ? `hash:${c.var.actor.anonHash}` : null)),
    }),
    rateLimit({
      limit: ANON_LIMIT,
      windowMs: ANON_WINDOW_MS,
      key: anonPost((c) => {
        const ip = clientIp(c);
        return ip ? `ip:${ip}` : null;
      }),
    }),
  );

  app.openapi(createSubmissionRoute, async (c) => {
    const created = await changes.createSubmission(c.var.actor, c.req.valid('json'));
    return c.json(created, 201);
  });

  app.openapi(getSubmissionRoute, async (c) => {
    const { submission, changes: rows } = await changes.getSubmission(c.var.actor, c.req.valid('param').id);
    return c.json(
      {
        id: submission.id,
        note: submission.note,
        createdAt: submission.createdAt.toISOString(),
        authorUserId: submission.authorUserId,
        changes: rows.map((r) => ({
          id: r.id,
          seq: r.seq,
          op: r.op,
          kind: r.kind,
          entityId: r.entityId,
          relationId: r.relationId,
          status: r.status,
          reason: r.reason,
          payload: r.payload,
          base: r.base,
          dependsOn: r.dependsOn,
        })),
      },
      200,
    );
  });

  app.openapi(mySubmissionsRoute, async (c) => {
    const page = await changes.listMine(c.var.actor, c.req.valid('query'));
    return c.json(
      {
        items: page.items.map((s) => ({
          id: s.id,
          note: s.note,
          createdAt: s.createdAt.toISOString(),
          changes: s.changes.map(({ id, seq, op, kind, status }) => ({ id, seq, op, kind, status })),
        })),
        nextCursor: page.nextCursor,
      },
      200,
    );
  });

  return app;
}

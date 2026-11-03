import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../../platform/http/app-env';
import { createApi, ErrorSchema, json } from '../../platform/http/openapi';
import { rateLimit } from '../../platform/http/rate-limit';
import {
  ApproveInput,
  ChangeIdParam,
  MySubmissionsQuery,
  MySubmissionsSchema,
  QueueQuery,
  QueueSchema,
  RejectInput,
  ResubmitInput,
  ReviewedSchema,
  SubmissionCreatedSchema,
  SubmissionDetailSchema,
  SubmissionInput,
} from './schemas';
import type { ChangesService } from './service';

type ChangeRecord = Awaited<ReturnType<ChangesService['getSubmission']>>['changes'][number];

/** A change row as the API shows it to its author and to moderators. */
const changeView = (r: ChangeRecord) => ({
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
});

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

const queueRoute = createRoute({
  method: 'get',
  path: '/api/moderation/queue',
  request: { query: QueueQuery },
  responses: { 200: json(QueueSchema), 404: json(ErrorSchema, 'Not found') },
});

const approveRoute = createRoute({
  method: 'post',
  path: '/api/changes/{id}/approve',
  request: {
    params: ChangeIdParam,
    body: { content: { 'application/json': { schema: ApproveInput } }, required: false },
  },
  responses: {
    200: json(ReviewedSchema),
    400: json(ErrorSchema, 'Invalid edit'),
    404: json(ErrorSchema, 'Not found'),
    409: json(ErrorSchema, 'Already reviewed, stale, or waiting on a dependency'),
    501: json(ErrorSchema, 'Not implemented'),
  },
});

const rejectRoute = createRoute({
  method: 'post',
  path: '/api/changes/{id}/reject',
  request: {
    params: ChangeIdParam,
    body: { content: { 'application/json': { schema: RejectInput } }, required: true },
  },
  responses: {
    200: json(ReviewedSchema),
    400: json(ErrorSchema, 'Invalid request'),
    404: json(ErrorSchema, 'Not found'),
    409: json(ErrorSchema, 'Already reviewed, or live changes build on it'),
  },
});

const resubmitRoute = createRoute({
  method: 'post',
  path: '/api/changes/{id}/resubmit',
  request: {
    params: ChangeIdParam,
    body: { content: { 'application/json': { schema: ResubmitInput } }, required: false },
  },
  responses: {
    201: json(SubmissionCreatedSchema, 'Created'),
    400: json(ErrorSchema, 'Invalid change'),
    404: json(ErrorSchema, 'Not found'),
    409: json(ErrorSchema, 'Not rejected, or already resubmitted'),
  },
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
        changes: rows.map(changeView),
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

  app.openapi(queueRoute, async (c) => {
    const page = await changes.queue(c.var.actor, c.req.valid('query'));
    const now = Date.now();
    return c.json(
      {
        items: page.items.map(({ change, authorUserId }) => ({
          change: {
            ...changeView(change),
            submissionId: change.submissionId,
            createdAt: change.createdAt.toISOString(),
          },
          submission: {
            id: change.submissionId,
            author: authorUserId ? { userId: authorUserId } : ('anonymous' as const),
          },
          ageSeconds: Math.max(0, Math.floor((now - change.createdAt.getTime()) / 1000)),
        })),
        nextCursor: page.nextCursor,
      },
      200,
    );
  });

  app.openapi(approveRoute, async (c) => {
    const result = await changes.approve(c.var.actor, c.req.valid('param').id, c.req.valid('json') ?? {});
    return c.json(result, 200);
  });

  app.openapi(rejectRoute, async (c) => {
    const result = await changes.reject(c.var.actor, c.req.valid('param').id, c.req.valid('json').reason);
    return c.json(result, 200);
  });

  app.openapi(resubmitRoute, async (c) => {
    const created = await changes.resubmit(c.var.actor, c.req.valid('param').id, c.req.valid('json') ?? {});
    return c.json(created, 201);
  });

  return app;
}

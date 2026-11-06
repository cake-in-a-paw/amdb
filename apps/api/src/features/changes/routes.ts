import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../../platform/http/app-env';
import { createApi, ErrorSchema, json, RedirectSchema } from '../../platform/http/openapi';
import { clientIp, rateLimit } from '../../platform/http/rate-limit';
import { reviewAuthor } from './author';
import {
  ApproveInput,
  ChangeDetailSchema,
  ChangeIdParam,
  ClaimedSchema,
  HistoryParams,
  HistoryQuery,
  HistorySchema,
  MyPendingQuery,
  MyPendingSchema,
  MySubmissionsQuery,
  MySubmissionsSchema,
  QueueQuery,
  QueueSchema,
  RedactedSchema,
  RedactedValue,
  RedactInput,
  RejectInput,
  ResubmitInput,
  ReviewedSchema,
  SubmissionCreatedSchema,
  SubmissionDetailSchema,
  SubmissionInput,
} from './schemas';
import type { ChangesService } from './service';

type ChangeRecord = Awaited<ReturnType<ChangesService['getSubmission']>>['changes'][number];

/** `base` split into the values still held and the keys a redaction erased. */
function baseView(base: Record<string, unknown> | null) {
  const entries = Object.entries(base ?? {});
  const erased = entries.filter(([, v]) => RedactedValue.safeParse(v).success);
  return {
    base: base && Object.fromEntries(entries.filter(([, v]) => !RedactedValue.safeParse(v).success)),
    redactedBaseFields: erased.map(([k]) => k),
  };
}

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
  redacted: r.redactedAt !== null,
  redactionReason: r.redactionReason,
  payload: r.payload,
  ...baseView(r.base),
  dependsOn: r.dependsOn,
});

const createSubmissionRoute = createRoute({
  method: 'post',
  path: '/api/submissions',
  request: { body: { content: { 'application/json': { schema: SubmissionInput } }, required: true } },
  responses: {
    201: json(SubmissionCreatedSchema, 'Created'),
    400: json(ErrorSchema, 'Invalid submission'),
    409: json(ErrorSchema, 'Duplicate slug or external id (duplicate_slug, duplicate_external_id)'),
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
  // With no identity (signed out, no token), the list is empty.
  responses: { 200: json(MySubmissionsSchema) },
});

const myPendingRoute = createRoute({
  method: 'get',
  path: '/api/me/pending',
  request: { query: MyPendingQuery },
  responses: { 200: json(MyPendingSchema) },
});

const getChangeRoute = createRoute({
  method: 'get',
  path: '/api/changes/{id}',
  request: { params: ChangeIdParam },
  responses: { 200: json(ChangeDetailSchema), 404: json(ErrorSchema, 'Not found') },
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
    body: { content: { 'application/json': { schema: ResubmitInput } }, required: true },
  },
  responses: {
    201: json(SubmissionCreatedSchema, 'Created'),
    400: json(ErrorSchema, 'Invalid change, or no CC0 agreement'),
    404: json(ErrorSchema, 'Not found'),
    409: json(
      ErrorSchema,
      'Not rejected, already resubmitted, or a duplicate slug or external id (duplicate_slug, duplicate_external_id)',
    ),
  },
});

const revertRoute = createRoute({
  method: 'post',
  path: '/api/changes/{id}/revert',
  request: { params: ChangeIdParam },
  responses: {
    200: json(ReviewedSchema),
    404: json(ErrorSchema, 'Not found'),
    409: json(ErrorSchema, 'Not live, already reverted, or later changes depend on it'),
  },
});

const redactRoute = createRoute({
  method: 'post',
  path: '/api/admin/changes/{id}/redact',
  request: {
    params: ChangeIdParam,
    body: { content: { 'application/json': { schema: RedactInput } }, required: true },
  },
  responses: {
    200: json(RedactedSchema),
    400: json(ErrorSchema, 'Invalid request'),
    404: json(ErrorSchema, 'Not found'),
    409: json(ErrorSchema, 'Already removed, a revert, or its content is live and removeEntity is not set'),
  },
});

const claimRoute = createRoute({
  method: 'post',
  path: '/api/me/claim-anonymous',
  responses: {
    200: json(ClaimedSchema),
    400: json(ErrorSchema, 'No anonymous token'),
    401: json(ErrorSchema, 'Not signed in'),
  },
});

const historyRoute = createRoute({
  method: 'get',
  path: '/api/entities/{id}/history',
  request: { params: HistoryParams, query: HistoryQuery },
  responses: {
    200: json(HistorySchema),
    308: {
      ...json(RedirectSchema, 'The id was merged into another entity; follow `Location`'),
      headers: z.object({ Location: z.string() }),
    },
    404: json(ErrorSchema, 'Not found'),
    410: json(ErrorSchema, 'Removed'),
  },
});

const ANON_LIMIT = 20;
const ANON_WINDOW_MS = 60 * 60 * 1000;

export interface ChangesRoutesOptions {
  /** How many proxies in front of the API append to `x-forwarded-for` (see `clientIp`). */
  trustedProxyHops: number;
}

export function changesRoutes(changes: ChangesService, { trustedProxyHops }: ChangesRoutesOptions) {
  const app = createApi();

  // Anonymous submissions and resubmits, per anonymous token and per client address. Tokens are free to mint,
  // so the address is the limit that holds; requests without a trustworthy one share a bucket.
  const anonPost = (bucket: (c: Context<AppEnv>) => string) => (c: Context<AppEnv>) =>
    c.req.method === 'POST' && c.var.actor.kind === 'anon' ? bucket(c) : null;
  const limits = [
    rateLimit({
      limit: ANON_LIMIT,
      windowMs: ANON_WINDOW_MS,
      key: anonPost((c) => (c.var.actor.kind === 'anon' ? `hash:${c.var.actor.anonHash}` : 'hash:none')),
    }),
    rateLimit({
      limit: ANON_LIMIT,
      windowMs: ANON_WINDOW_MS,
      key: anonPost((c) => `ip:${clientIp(c, trustedProxyHops) ?? 'unknown'}`),
    }),
  ];
  // A resubmit is a submission too, so it draws on the same buckets.
  app.use('/api/submissions', ...limits);
  app.use('/api/changes/:id/resubmit', ...limits);

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

  app.openapi(getChangeRoute, async (c) => {
    const change = await changes.getChange(c.var.actor, c.req.valid('param').id);
    return c.json({ ...changeView(change), submissionId: change.submissionId }, 200);
  });

  app.openapi(myPendingRoute, async (c) => {
    return c.json({ count: await changes.countMyPending(c.var.actor, c.req.valid('query').entityId) }, 200);
  });

  app.openapi(mySubmissionsRoute, async (c) => {
    const page = await changes.listMine(c.var.actor, c.req.valid('query'));
    return c.json(
      {
        items: page.items.map((s) => ({
          id: s.id,
          note: s.note,
          createdAt: s.createdAt.toISOString(),
          changes: s.changes.map(({ id, seq, op, kind, entityId, status }) => ({
            id,
            seq,
            op,
            kind,
            entityId,
            status,
          })),
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
        items: page.items.map(({ change, authorUserId, authorHandle }) => ({
          change: {
            ...changeView(change),
            submissionId: change.submissionId,
            createdAt: change.createdAt.toISOString(),
          },
          submission: {
            id: change.submissionId,
            author: reviewAuthor(authorUserId, authorHandle),
          },
          ageSeconds: Math.max(0, Math.floor((now - change.createdAt.getTime()) / 1000)),
        })),
        nextCursor: page.nextCursor,
      },
      200,
    );
  });

  app.openapi(approveRoute, async (c) => {
    const result = await changes.approve(c.var.actor, c.req.valid('param').id, c.req.valid('json'));
    return c.json(result, 200);
  });

  app.openapi(rejectRoute, async (c) => {
    const result = await changes.reject(c.var.actor, c.req.valid('param').id, c.req.valid('json').reason);
    return c.json(result, 200);
  });

  app.openapi(resubmitRoute, async (c) => {
    const created = await changes.resubmit(c.var.actor, c.req.valid('param').id, c.req.valid('json'));
    return c.json(created, 201);
  });

  app.openapi(revertRoute, async (c) => {
    const result = await changes.revert(c.var.actor, c.req.valid('param').id);
    return c.json(result, 200);
  });

  app.openapi(redactRoute, async (c) => {
    const result = await changes.redact(c.var.actor, c.req.valid('param').id, c.req.valid('json'));
    return c.json(result, 200);
  });

  app.openapi(claimRoute, async (c) => {
    const result = await changes.claimAnonymous(c.var.actor, c.req.header('x-amdb-anon'));
    return c.json(result, 200);
  });

  app.openapi(historyRoute, async (c) => {
    const page = await changes.history(c.req.valid('param').id, c.req.valid('query'));
    if ('redirectTo' in page) {
      return c.json(page, 308, { Location: `/api/entities/${page.redirectTo}/history` });
    }
    return c.json(page, 200);
  });

  return app;
}

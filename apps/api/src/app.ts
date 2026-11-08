import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  STATES,
  actionBodySchema,
  actionParamSchema,
  ocrMetaSchema,
  otpRequestSchema,
  otpVerifySchema, refreshSchema,
  staffLoginSchema,
  vendorDraftSchema,
  type UserDTO,
} from '@vo/shared';
import Fastify, { type FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearer, verifyToken } from './auth.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { AppError, badRequest, unauthorized } from './errors.js';
import type { Mailer } from './integrations/mailer.js';
import type { SapClient } from './integrations/sap.js';
import * as auth from './services/auth.js';
import { Worker } from './jobs/worker.js';
import * as vendors from './services/vendors.js';
import { sniffFileType, type FileStorage } from './storage.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserDTO;
  }
}

export interface AppDeps {
  cfg: Config;
  db: Db;
  storage: FileStorage;
  sap: SapClient;
  mailer: Mailer;
  backoffBaseMs?: number;
}

export async function buildApp(deps: AppDeps) {
  const { cfg, db } = deps;
  const app = Fastify({
    logger:
      cfg.NODE_ENV === 'test'
        ? false
        : {
            level: cfg.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            ...(cfg.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
          },
    bodyLimit: 1_000_000,
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const worker = new Worker({ ...deps, backoffBaseMs: deps.backoffBaseMs ?? 2000 }, app.log, cfg.WORKER_POLL_MS);
  app.decorate('worker', worker);

  await app.register(cors, { origin: cfg.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true });
  await app.register(multipart, { limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 20 } });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Vendor Onboarding API', version: '0.1.0' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // ── error handling: one consistent error shape for the client ──
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError)
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (hasZodFastifySchemaValidationErrors(err))
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: err.validation },
      });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: err.issues } });
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: `Max upload is ${cfg.MAX_UPLOAD_MB} MB` } });
    if (e.statusCode && e.statusCode < 500)
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message ?? 'Bad request' } });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  // ── auth ──
  const PUBLIC = new Set(['/api/health', '/api/auth/login', '/api/auth/code', '/api/auth/code/verify', '/api/auth/refresh', '/api/auth/logout']);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/') || PUBLIC.has(path)) return;
    const token = bearer(req.headers.authorization);
    if (!token) throw unauthorized();
    req.user = verifyToken(token, cfg.JWT_SECRET);
  });

  app.get('/api/health', { schema: { hide: true } }, async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  // ── sign in ──
  const authDeps = { db, cfg, mailer: deps.mailer };
  const limit = auth.rateLimiter(cfg.NODE_ENV === 'test' ? 1000 : 20, 60_000);
  const authTags = ['auth'];

  app.post('/api/auth/login', { schema: { tags: authTags, body: staffLoginSchema } }, async (req) => {
    limit(`login:${req.ip}`);
    return auth.staffLogin(authDeps, req.body.email, req.body.password);
  });
  app.post('/api/auth/code', { schema: { tags: authTags, body: otpRequestSchema } }, async (req) => {
    limit(`code:${req.ip}`);
    return auth.requestCode(authDeps, req.body.email);
  });
  app.post('/api/auth/code/verify', { schema: { tags: authTags, body: otpVerifySchema } }, async (req) => {
    limit(`verify:${req.ip}`);
    return auth.verifyCode(authDeps, req.body.email, req.body.code);
  });

  app.post('/api/auth/refresh', { schema: { tags: authTags, body: refreshSchema } }, async (req) => {
    limit(`refresh:${req.ip}`);
    return auth.refresh(authDeps, req.body.refreshToken);
  });
  app.post('/api/auth/logout', { schema: { tags: authTags, body: refreshSchema } }, async (req) => {
    await auth.logout(authDeps, req.body.refreshToken);
    return { ok: true };
  });

  app.get('/api/me', { schema: { tags: authTags } }, async (req) => auth.session(authDeps, req.user));

  // ── vendors ──
  const idParam = z.object({ id: z.string().uuid() });
  const tags = ['vendors'];

  app.get('/api/stats', { schema: { tags } }, async (req) => vendors.stats(deps, req.user));

  app.get(
    '/api/vendors',
    {
      schema: {
        tags,
        querystring: z.object({
          state: z.enum(STATES).optional(),
          q: z.string().trim().max(100).optional(),
          queue: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => vendors.listVendors(deps, req.user, req.query),
  );

  app.post(
    '/api/vendors',
    { schema: { tags, body: z.object({ profile: vendorDraftSchema.default({}) }) } },
    async (req, reply) => reply.status(201).send(await vendors.createVendor(deps, req.user, req.body.profile)),
  );

  app.get('/api/vendors/:id', { schema: { tags, params: idParam } }, async (req) =>
    vendors.getVendor(deps, req.user, req.params.id),
  );

  app.patch(
    '/api/vendors/:id',
    {
      schema: {
        tags,
        params: idParam,
        body: z.object({ profile: vendorDraftSchema, version: z.number().int().optional() }),
      },
    },
    async (req) => vendors.updateDraft(deps, req.user, req.params.id, req.body.profile, req.body.version),
  );

  app.get('/api/vendors/:id/events', { schema: { tags, params: idParam } }, async (req) =>
    vendors.listEvents(deps, req.user, req.params.id),
  );

  app.post(
    '/api/vendors/:id/actions/:action',
    {
      schema: {
        tags,
        params: idParam.extend({ action: actionParamSchema }),
        body: actionBodySchema.default({}),
      },
    },
    async (req) => vendors.performAction(deps, req.user, req.params.id, req.params.action, req.body),
  );

  // ── documents ──
  const docParams = idParam.extend({ key: z.string().regex(/^[a-z_]{2,40}$/) });

  /**
   * Multipart upload: a `fields` part (JSON object of document fields) and an optional
   * `file` part. The file type is sniffed from its bytes, not trusted from the client.
   */
  app.put('/api/vendors/:id/documents/:key', { schema: { tags, params: docParams, consumes: ['multipart/form-data'] } }, async (req) => {
    if (!req.isMultipart()) throw badRequest('Expected multipart/form-data');
    let fields: Record<string, unknown> = {};
    let ocr: vendors.UploadInput['ocr'];
    let file: vendors.UploadInput['file'];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (!buffer.length) continue;
        const sniffed = sniffFileType(buffer);
        if (!sniffed) throw badRequest('Only PDF, PNG, JPEG or WEBP files are accepted');
        file = { buffer, name: part.filename || `upload${sniffed.ext}`, mime: sniffed.mime, ext: sniffed.ext };
      } else if (part.fieldname === 'ocr') {
        const parsed = ocrMetaSchema.safeParse((() => {
          try {
            return JSON.parse(String(part.value));
          } catch {
            return null;
          }
        })());
        if (!parsed.success) throw badRequest('`ocr` must describe the OCR result');
        ocr = parsed.data;
      } else if (part.fieldname === 'fields') {
        try {
          const parsed: unknown = JSON.parse(String(part.value));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
          else throw new Error();
        } catch {
          throw badRequest('`fields` must be a JSON object');
        }
      }
    }
    return vendors.upsertDocument(deps, req.user, req.params.id, req.params.key, { fields, file, ocr });
  });

  app.delete('/api/vendors/:id/documents/:key', { schema: { tags, params: docParams } }, async (req) =>
    vendors.deleteDocument(deps, req.user, req.params.id, req.params.key),
  );

  app.get('/api/vendors/:id/documents/:key/file', { schema: { tags, params: docParams } }, async (req, reply) => {
    const f = await vendors.getDocumentFile(deps, req.user, req.params.id, req.params.key);
    return reply
      .header('Content-Type', f.mime)
      .header('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=300')
      .send(f.stream);
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  if (cfg.WORKER_ENABLED) app.addHook('onReady', async () => worker.start());
  app.addHook('onClose', async () => worker.stop());

  return Object.assign(app, { worker });
}

export type App = Awaited<ReturnType<typeof buildApp>>;

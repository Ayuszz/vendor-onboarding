import { z } from 'zod';

/**
 * All configuration comes from the environment and is validated once at boot,
 * so a misconfigured deploy fails fast instead of at the first request.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  /** Postgres connection string. When empty, an embedded Postgres (PGlite) is used. */
  DATABASE_URL: z.string().optional().default(''),
  /** Where the embedded database lives. Use "memory://" for an ephemeral DB. */
  PGLITE_DIR: z.string().default('./.data/pglite'),

  UPLOAD_DIR: z.string().default('./.data/uploads'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),

  AUTH_MODE: z.enum(['dev', 'jwt']).default('dev'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 3600),

  /**
   * How vendor sign-in codes are delivered.
   * smtp    = real email through your mail server (required in production)
   * console = nothing is sent; in development the email is printed to the *server* terminal only
   */
  MAILER: z.enum(['smtp', 'console']).default('console'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  MAIL_FROM: z.string().optional().default(''),
  /**
   * Local testing only: also return the sign-in code to the browser so you can sign in
   * without an inbox. Never enable on a shared or public server. Refused in production.
   */
  DEV_SHOW_OTP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** "mock" simulates SAP locally; "service_layer" talks to SAP Business One Service Layer. */
  SAP_MODE: z.enum(['mock', 'service_layer']).default('mock'),
  SAP_BASE_URL: z.string().optional().default(''),
  SAP_COMPANY_DB: z.string().optional().default(''),
  SAP_USERNAME: z.string().optional().default(''),
  SAP_PASSWORD: z.string().optional().default(''),
  SAP_CARD_CODE_PREFIX: z.string().max(4).default('V'),
  SAP_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),

  WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.AUTH_MODE === 'dev')
    throw new Error('AUTH_MODE=dev is not allowed in production');
  if (cfg.NODE_ENV === 'production' && cfg.DEV_SHOW_OTP)
    throw new Error('DEV_SHOW_OTP must be false in production: sign-in codes may only be delivered by email');
  if (cfg.DEV_SHOW_OTP && !['127.0.0.1', 'localhost', '::1'].includes(cfg.HOST))
    throw new Error('DEV_SHOW_OTP only works when HOST is 127.0.0.1 or localhost; a hosted server must email the code');
  if (cfg.NODE_ENV === 'production' && cfg.MAILER !== 'smtp')
    throw new Error('MAILER=smtp is required in production so vendors receive their sign-in codes');
  if (cfg.MAILER === 'smtp' && (!cfg.SMTP_HOST || !cfg.MAIL_FROM))
    throw new Error('MAILER=smtp requires SMTP_HOST and MAIL_FROM');
  if (cfg.SAP_MODE === 'service_layer' && (!cfg.SAP_BASE_URL || !cfg.SAP_USERNAME || !cfg.SAP_PASSWORD))
    throw new Error('SAP_MODE=service_layer requires SAP_BASE_URL, SAP_USERNAME and SAP_PASSWORD');
  return cfg;
}

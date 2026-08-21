import { z } from 'zod';

/**
 * Environment contract. Validated once at startup; the process refuses to boot
 * with an unusable configuration. There are NO insecure production fallbacks:
 * a missing required production value is a hard failure, and optional
 * integrations (email, storage) simply stay unavailable until configured.
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  APP_BASE_URL: z.string().url().default('http://localhost:5000'),

  DATABASE_URL: z.string().min(1).optional(),
  TEST_DATABASE_URL: z.string().min(1).optional(),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),

  DEPLOYMENT_MODE: z.literal('single_company').default('single_company'),
  PRIMARY_ORGANIZATION_ID: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  BOOTSTRAP_OWNER_EMAIL: z
    .string()
    .email()
    .optional()
    .or(z.literal('').transform(() => undefined)),

  CLERK_PUBLISHABLE_KEY: z
    .string()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  CLERK_SECRET_KEY: z
    .string()
    .optional()
    .or(z.literal('').transform(() => undefined)),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  APP_STORAGE_BUCKET_ID: z
    .string()
    .optional()
    .or(z.literal('').transform(() => undefined)),

  /**
   * local = first-party email+password (no external identity service).
   * clerk = Clerk via keys below. Unset = Clerk if keys exist, else the
   * fail-closed "not configured" mode.
   */
  AUTH_PROVIDER: z
    .enum(['clerk', 'local'])
    .optional()
    .or(z.literal('').transform(() => undefined)),

  EMAIL_PROVIDER: z
    .enum(['resend'])
    .optional()
    .or(z.literal('').transform(() => undefined)),
  EMAIL_FROM: z
    .string()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  EMAIL_REPLY_TO: z
    .string()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  RESEND_API_KEY: z
    .string()
    .optional()
    .or(z.literal('').transform(() => undefined)),

  SCHEDULED_JOB_SECRET: z
    .string()
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${detail}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required in production');
    if (!env.CLERK_SECRET_KEY || !env.CLERK_PUBLISHABLE_KEY) {
      // Production runs, but authentication-dependent surfaces fail closed and
      // /health/ready reports the missing provider. No fallback login exists.
    }
  }
  if (env.NODE_ENV === 'test') {
    if (!env.TEST_DATABASE_URL) {
      throw new Error('TEST_DATABASE_URL is required when NODE_ENV=test');
    }
    if (env.DATABASE_URL && env.TEST_DATABASE_URL === env.DATABASE_URL) {
      throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL');
    }
    if (env.MIGRATION_DATABASE_URL && env.TEST_DATABASE_URL === env.MIGRATION_DATABASE_URL) {
      throw new Error('TEST_DATABASE_URL must not equal MIGRATION_DATABASE_URL');
    }
    if (!/(test)/i.test(env.TEST_DATABASE_URL)) {
      throw new Error('TEST_DATABASE_URL must reference an explicitly test-named database');
    }
  }
  return env;
}

export function getEnv(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Test-only: reset the cached environment (used by env unit tests). */
export function resetEnvCacheForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetEnvCacheForTests is test-only');
  }
  cached = null;
}

/** The database URL the running application should use. */
export function runtimeDatabaseUrl(env: Env = getEnv()): string {
  if (env.NODE_ENV === 'test') {
    if (!env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL missing');
    return env.TEST_DATABASE_URL;
  }
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  return env.DATABASE_URL;
}

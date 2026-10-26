import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(8790),
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MODEL_LAB_DB_PATH: z.string().optional().or(z.literal('')),

  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_BASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().optional(),
  JUDGE_PROVIDER: z.string().optional(),
  JUDGE_MODEL: z.string().optional(),

  EVAL_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
  EVAL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(60000),
  EVAL_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  EVAL_MAX_ITEMS_PER_RUN: z.coerce.number().int().min(1).max(2000).default(200),
  EVAL_DEFAULT_BUDGET_USD: z.coerce.number().min(0).default(2),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(10).default(240),
  MAX_JSON_BODY_BYTES: z.coerce.number().int().min(1024).default(262144),
  ALLOWED_PROVIDER_HOSTS: z.string().optional().or(z.literal('')),
  ALLOW_LOOPBACK_PROVIDER: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  PUBLIC_SITE_URL: z.string().default('http://127.0.0.1:5199'),

  // --- access control -------------------------------------------------------
  /** Shared password for the whole app. Empty means "no gate", which is only
   *  allowed on a loopback bind or with MODEL_LAB_ALLOW_ANONYMOUS=true. */
  MODEL_LAB_ACCESS_TOKEN: z.string().optional().default(''),
  /** Explicit opt-out of the "refuse to start exposed and unauthenticated" check. */
  MODEL_LAB_ALLOW_ANONYMOUS: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  /** Adds `Secure` to the session cookie. Set this whenever the app is served over TLS. */
  MODEL_LAB_COOKIE_SECURE: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Credentials are resolved per provider at request time, never persisted. */
/**
 * Credentials are resolved in `server/credentials.ts`, which prefers the
 * encrypted key stored from the UI and falls back to these environment values.
 * The functions here only expose what the bootstrap phase needs.
 */

/**
 * Environment base URL for a provider kind, or null when unset.
 * Used at boot to pin provider rows that have no UI-configured override.
 */
export function envBaseUrlFor(kind: string): string | null {
  if (kind === 'openai') return env.OPENAI_BASE_URL || null;
  if (kind === 'deepseek') return env.DEEPSEEK_BASE_URL || null;
  if (kind === 'openai-compatible') return env.OPENAI_COMPATIBLE_BASE_URL || null;
  return null;
}

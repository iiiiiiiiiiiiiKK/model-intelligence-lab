/**
 * Credential resolution.
 *
 * Precedence, highest first:
 *   1. The provider row's encrypted key (entered in the UI).
 *   2. The matching environment variable (`OPENAI_API_KEY`, …), so an operator
 *      can still bootstrap a deployment entirely from `.env`.
 *
 * The plaintext key never leaves this module except as the `Authorization`
 * header of an outbound provider request. It is not returned by any route, not
 * logged, and not stored in a run snapshot or a report.
 */
import { getRow } from './db';
import { decryptSecret, DecryptError, keyHint, envKeyHint } from './security/secrets';
import { env } from './config';
import { ApiError } from './errors';

export type CredentialSource = 'database' | 'environment' | 'none';

export interface ResolvedCredential {
  value: string | null;
  source: CredentialSource;
  /** Safe display hint such as `••••abcd`. Never the key itself. */
  hint: string | null;
}

interface ProviderCredentialRow {
  id: string;
  kind: string;
  config: string;
  api_key_ciphertext: string | null;
  api_key_hint: string | null;
}

/** Environment variable name for a provider kind, for display purposes only. */
export function envVarNameFor(kind: string): string | null {
  switch (kind) {
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'deepseek':
      return 'DEEPSEEK_API_KEY';
    case 'openai-compatible':
      return 'OPENAI_COMPATIBLE_API_KEY';
    default:
      return null;
  }
}

function envValueFor(kind: string): string | null {
  switch (kind) {
    case 'openai':
      return env.OPENAI_API_KEY || null;
    case 'deepseek':
      return env.DEEPSEEK_API_KEY || null;
    case 'openai-compatible':
      return env.OPENAI_COMPATIBLE_API_KEY || null;
    default:
      return null;
  }
}

function registryKeyOf(row: ProviderCredentialRow): string {
  try {
    return (JSON.parse(row.config) as { registryKey?: string }).registryKey ?? row.kind;
  } catch {
    return row.kind;
  }
}

/** Resolves the credential for a provider row id. */
export function resolveCredentialForProvider(providerId: string): ResolvedCredential {
  const row = getRow<ProviderCredentialRow>(
    'SELECT id, kind, config, api_key_ciphertext, api_key_hint FROM model_providers WHERE id = ?',
    providerId,
  );
  if (!row) return { value: null, source: 'none', hint: null };

  if (row.api_key_ciphertext) {
    try {
      const value = decryptSecret(row.api_key_ciphertext);
      return { value, source: 'database', hint: row.api_key_hint ?? keyHint(value) };
    } catch (error) {
      // A stored key that cannot be decrypted must fail loudly rather than
      // silently falling back to a different credential.
      throw new ApiError(
        'PROVIDER_NOT_CONFIGURED',
        error instanceof DecryptError
          ? error.message
          : 'The stored provider credential cannot be decrypted.',
      );
    }
  }

  // Environment fallback, keyed by the registry key so a seeded built-in row
  // still finds its variable.
  const envValue = envValueFor(registryKeyOf(row)) ?? envValueFor(row.kind);
  if (envValue) {
    return { value: envValue, source: 'environment', hint: envKeyHint(envValue) };
  }
  return { value: null, source: 'none', hint: null };
}

/** Resolves by provider kind, for the seeded built-ins. */
export function resolveCredentialForKind(kind: string): ResolvedCredential {
  const row = getRow<{ id: string }>(
    'SELECT id FROM model_providers WHERE kind = ? ORDER BY is_builtin DESC, created_at LIMIT 1',
    kind,
  );
  if (row) return resolveCredentialForProvider(row.id);
  const envValue = envValueFor(kind);
  if (envValue) return { value: envValue, source: 'environment', hint: envKeyHint(envValue) };
  return { value: null, source: 'none', hint: null };
}

/**
 * Resolves the credential a run should use, given its snapshotted provider id
 * and kind. Prefers the row, falls back to kind-scoped env configuration.
 */
export function resolveRunCredential(providerId: string, providerKind: string): ResolvedCredential {
  const byId = resolveCredentialForProvider(providerId);
  if (byId.value) return byId;
  const byKind = resolveCredentialForKind(providerKind);
  return byKind.value ? byKind : byId;
}

/** True when at least one provider can actually be called. */
export function anyProviderConfigured(): boolean {
  const rows = getRow<{ c: number }>(
    'SELECT COUNT(*) AS c FROM model_providers WHERE api_key_ciphertext IS NOT NULL',
  );
  if ((rows?.c ?? 0) > 0) return true;
  return Boolean(env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY || env.OPENAI_COMPATIBLE_API_KEY);
}

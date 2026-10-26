/**
 * Provider management: create, edit, delete, credential, connectivity test.
 *
 * This is the API behind the Settings → Providers screen, so a user can point
 * the lab at a relay or a self-hosted gateway without editing `.env`.
 *
 * Security invariants enforced here:
 *   - A key is accepted on write, encrypted immediately, and NEVER read back.
 *     The only thing returned about it is a masked hint.
 *   - Deleting a provider with runs or models is refused; the caller must
 *     disable it or delete the dependants first, so history is not silently lost.
 *   - Base URLs are validated by the same SSRF guard used for real calls.
 *   - The connectivity test performs a real request, so "connected" is earned.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { db, newId, nowIso, getRow, getRows } from '../db';
import { listProviders, getProvider } from '../db/mappers';
import { ApiError } from '../errors';
import { resolveCredentialForProvider, envVarNameFor } from '../credentials';
import { encryptSecret, keyHint, DecryptError } from '../security/secrets';
import { assertSafeProviderUrl, SsrfError } from '../security/ssrf';
import { env } from '../config';

export const providersRouter = Router();

const KINDS = ['openai', 'deepseek', 'openai-compatible', 'anthropic', 'custom'] as const;

async function validateBaseUrl(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new ApiError('VALIDATION_FAILED', 'Base URL is required.');
  try {
    const normalised = await assertSafeProviderUrl(trimmed);
    return normalised;
  } catch (error) {
    if (error instanceof SsrfError) {
      throw new ApiError('VALIDATION_FAILED', `Base URL rejected: ${error.message}`, {
        hint:
          'Use https:// for public endpoints. For a self-hosted gateway on this machine or a private network, set ALLOW_LOOPBACK_PROVIDER=true in .env and restart.',
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

providersRouter.get('/providers', (_req: Request, res: Response) => {
  const providers = listProviders();
  res.json({
    providers,
    kinds: KINDS,
    // Surfaced so the UI can explain the env fallback without leaking values.
    envFallback: {
      openai: Boolean(env.OPENAI_API_KEY),
      deepseek: Boolean(env.DEEPSEEK_API_KEY),
      'openai-compatible': Boolean(env.OPENAI_COMPATIBLE_API_KEY),
    },
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

const createSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(KINDS).default('openai-compatible'),
  baseUrl: z.string().min(1).max(500),
  apiKey: z.string().min(1).max(500).optional(),
  enabled: z.boolean().default(true),
});

providersRouter.post('/providers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid provider payload', parsed.error.flatten());
    }

    const baseUrl = await validateBaseUrl(parsed.data.baseUrl);
    const now = nowIso();
    const id = newId();

    const duplicate = getRow<{ id: string }>(
      'SELECT id FROM model_providers WHERE lower(name) = lower(?)',
      parsed.data.name,
    );
    if (duplicate) {
      throw new ApiError('CONFLICT', `A provider named "${parsed.data.name}" already exists.`);
    }

    const ciphertext = parsed.data.apiKey ? encryptSecret(parsed.data.apiKey.trim()) : null;
    const hint = parsed.data.apiKey ? keyHint(parsed.data.apiKey.trim()) : null;

    db.prepare(
      `INSERT INTO model_providers
        (id, kind, name, base_url, enabled, config, has_credential, api_key_ciphertext, api_key_hint, base_url_override, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(
      id,
      parsed.data.kind,
      parsed.data.name.trim(),
      baseUrl,
      parsed.data.enabled ? 1 : 0,
      JSON.stringify({}),
      ciphertext ? 1 : 0,
      ciphertext,
      hint,
      now,
      now,
    );

    res.status(201).json({ provider: getProvider(id) });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  baseUrl: z.string().min(1).max(500).optional(),
  enabled: z.boolean().optional(),
  /** `null` removes the stored key; a string replaces it; omitted keeps it. */
  apiKey: z.string().min(1).max(500).nullable().optional(),
});

providersRouter.patch('/providers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = getProvider(req.params.id);
    if (!provider) throw new ApiError('NOT_FOUND', 'Provider not found');

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid provider update', parsed.error.flatten());
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (parsed.data.name !== undefined) {
      const clash = getRow<{ id: string }>(
        'SELECT id FROM model_providers WHERE lower(name) = lower(?) AND id != ?',
        parsed.data.name,
        provider.id,
      );
      if (clash) throw new ApiError('CONFLICT', `A provider named "${parsed.data.name}" already exists.`);
      updates.push('name = ?');
      values.push(parsed.data.name.trim());
    }

    if (parsed.data.baseUrl !== undefined) {
      const baseUrl = await validateBaseUrl(parsed.data.baseUrl);
      updates.push('base_url = ?', 'base_url_override = 1');
      values.push(baseUrl);
    }

    if (parsed.data.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(parsed.data.enabled ? 1 : 0);
    }

    if (parsed.data.apiKey === null) {
      updates.push('api_key_ciphertext = NULL', 'api_key_hint = NULL', 'has_credential = 0');
    } else if (typeof parsed.data.apiKey === 'string') {
      const trimmed = parsed.data.apiKey.trim();
      updates.push('api_key_ciphertext = ?', 'api_key_hint = ?', 'has_credential = 1');
      values.push(encryptSecret(trimmed), keyHint(trimmed));
    }

    if (updates.length === 0) throw new ApiError('BAD_REQUEST', 'No fields to update.');

    updates.push('updated_at = ?');
    values.push(nowIso(), provider.id);
    db.prepare(`UPDATE model_providers SET ${updates.join(', ')} WHERE id = ?`).run(...(values as never[]));

    res.json({ provider: getProvider(provider.id) });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

providersRouter.delete('/providers/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = getProvider(req.params.id);
    if (!provider) throw new ApiError('NOT_FOUND', 'Provider not found');
    if (provider.isBuiltin) {
      throw new ApiError(
        'FORBIDDEN',
        'Built-in providers cannot be deleted. Edit them, clear the key, or disable them instead.',
      );
    }

    const modelCount = getRow<{ c: number }>(
      'SELECT COUNT(*) AS c FROM models WHERE provider_id = ?',
      provider.id,
    );
    if ((modelCount?.c ?? 0) > 0) {
      throw new ApiError(
        'CONFLICT',
        `This provider still has ${modelCount?.c} registered model(s). Delete or move them first, so past runs keep their meaning.`,
      );
    }

    db.prepare('DELETE FROM model_providers WHERE id = ?').run(provider.id);
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// connectivity test (real request, no key echoed)
// ---------------------------------------------------------------------------

providersRouter.post('/providers/:id/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = getProvider(req.params.id);
    if (!provider) throw new ApiError('NOT_FOUND', 'Provider not found');

    // An unsaved key can be tested before committing it.
    const candidateKey =
      typeof req.body?.apiKey === 'string' && req.body.apiKey.trim().length > 0
        ? req.body.apiKey.trim()
        : null;

    let key = candidateKey;
    if (!key) {
      try {
        key = resolveCredentialForProvider(provider.id).value;
      } catch (error) {
        if (error instanceof DecryptError || (error as { code?: string }).code === 'PROVIDER_NOT_CONFIGURED') {
          throw error;
        }
        throw error;
      }
    }
    if (!key) {
      throw new ApiError(
        'PROVIDER_NOT_CONFIGURED',
        'No API key to test. Enter a key first, or set one in .env.',
      );
    }

    let origin: string;
    try {
      origin = await assertSafeProviderUrl(provider.baseUrl);
    } catch (error) {
      throw new ApiError('VALIDATION_FAILED', `Base URL rejected: ${(error as Error).message}`);
    }

    const started = Date.now();
    let status: number | null = null;
    let message = '';
    let modelCount: number | null = null;
    let sampleModels: string[] = [];

    try {
      const response = await fetch(`${origin}/models`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      status = response.status;
      const text = await response.text();

      if (!response.ok) {
        // Never echo the provider body verbatim: it can contain a key fragment.
        message =
          response.status === 401 || response.status === 403
            ? '认证失败：密钥无效或没有权限。'
            : response.status === 404
              ? '路径不存在：Base URL 可能缺少 /v1 或写错了。'
              : `服务商返回 HTTP ${response.status}。`;
      } else {
        try {
          const payload = JSON.parse(text) as { data?: unknown[]; models?: unknown[] };
          const list = (payload.data ?? payload.models ?? []) as Array<
            string | { id?: string; name?: string }
          >;
          sampleModels = list
            .map((entry) => (typeof entry === 'string' ? entry : entry.id ?? entry.name ?? ''))
            .filter(Boolean)
            .slice(0, 30);
          modelCount = list.length;
        } catch {
          modelCount = null;
        }
        message =
          modelCount === null
            ? '连接成功（该服务商未返回模型列表，这通常不影响调用）。'
            : `连接成功，发现 ${modelCount} 个可用模型。`;
      }
    } catch (error) {
      message =
        (error as Error).name === 'TimeoutError'
          ? '连接超时（20 秒）。'
          : `连接失败：${(error as Error).message}`;
    }

    const latencyMs = Date.now() - started;
    const ok = status !== null && status >= 200 && status < 300;

    res.status(200).json({
      result: { ok, status, latencyMs, message, modelCount, sampleModels },
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// model discovery (real request, used to register models with one click)
// ---------------------------------------------------------------------------

providersRouter.get('/providers/:id/models', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = getProvider(req.params.id);
    if (!provider) throw new ApiError('NOT_FOUND', 'Provider not found');

    const resolved = resolveCredentialForProvider(provider.id);
    if (!resolved.value) {
      throw new ApiError('PROVIDER_NOT_CONFIGURED', 'No API key configured for this provider.');
    }

    const origin = await assertSafeProviderUrl(provider.baseUrl);
    const response = await fetch(`${origin}/models`, {
      headers: { authorization: `Bearer ${resolved.value}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      throw new ApiError(
        'PROVIDER_ERROR',
        `Provider returned HTTP ${response.status} when listing models.`,
        undefined,
        response.status >= 500,
      );
    }
    const payload = (await response.json()) as { data?: unknown[]; models?: unknown[] };
    const list = (payload.data ?? payload.models ?? []) as Array<string | { id?: string; name?: string }>;
    const ids = list
      .map((entry) => (typeof entry === 'string' ? entry : entry.id ?? entry.name ?? ''))
      .filter(Boolean);

    const registered = new Set(
      getRows<{ model_id: string }>('SELECT model_id FROM models WHERE provider_id = ?', provider.id).map(
        (row) => row.model_id,
      ),
    );

    res.json({
      models: ids.map((id) => ({ id, registered: registered.has(id) })),
      total: ids.length,
    });
  } catch (error) {
    next(error);
  }
});

/** Bulk-register discovered models for a provider. */
providersRouter.post('/providers/:id/models', (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = getProvider(req.params.id);
    if (!provider) throw new ApiError('NOT_FOUND', 'Provider not found');

    const schema = z.object({ modelIds: z.array(z.string().min(1).max(200)).min(1).max(200) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid model list', parsed.error.flatten());
    }

    const now = nowIso();
    const insert = db.prepare(
      `INSERT INTO models (id, provider_id, model_id, display_name, known_versions, version_verification, metadata, status, is_demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', 'unknown', '{}', ?, 0, ?, ?)
       ON CONFLICT(provider_id, model_id) DO NOTHING`,
    );

    let created = 0;
    for (const modelId of parsed.data.modelIds) {
      const changes = insert.run(
        newId(),
        provider.id,
        modelId.trim(),
        modelId.trim(),
        provider.hasCredential ? 'connected' : 'registered',
        now,
        now,
      ).changes;
      created += Number(changes ?? 0);
    }

    res.status(201).json({ created, requested: parsed.data.modelIds.length });
  } catch (error) {
    next(error);
  }
});

/** Which environment variables exist, for the settings explainer. */
providersRouter.get('/providers/env-status', (_req: Request, res: Response) => {
  res.json({
    variables: KINDS.map((kind) => ({
      kind,
      name: envVarNameFor(kind),
      present: Boolean(envVarNameFor(kind) && process.env[envVarNameFor(kind)!]),
    })),
    note: 'Environment variables are a fallback for headless deployments. A key saved here always takes precedence.',
  });
});

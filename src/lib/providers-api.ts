/**
 * Provider management client calls.
 * Kept beside the main api client but in its own module because the provider
 * surface is large enough to deserve its own file.
 */
import type { ProviderSummary, ProviderTestResult } from '../../shared/types';
import type { ApiResult } from './api';

async function request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* non-JSON body */
      }
    }
    if (!response.ok) {
      const body = parsed as { error?: { code?: string; message?: string; retryable?: boolean } } | null;
      return {
        ok: false,
        error: {
          code: body?.error?.code ?? `HTTP_${response.status}`,
          message: body?.error?.message ?? `Request failed with status ${response.status}.`,
          status: response.status,
          retryable: body?.error?.retryable ?? response.status >= 500,
        },
      };
    }
    return { ok: true, data: parsed as T };
  } catch (error) {
    const name = (error as Error).name;
    return {
      ok: false,
      error: {
        code: name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
        message: name === 'AbortError' ? 'The request timed out.' : 'Cannot reach the server.',
        status: 0,
        retryable: true,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ProviderListResponse {
  providers: ProviderSummary[];
  kinds: string[];
  envFallback: Record<string, boolean>;
}

export const providersApi = {
  list: () => request<ProviderListResponse>('/api/providers'),

  create: (body: {
    name: string;
    kind: string;
    baseUrl: string;
    apiKey?: string;
    enabled?: boolean;
  }) => request<{ provider: ProviderSummary }>('/api/providers', { method: 'POST', body: JSON.stringify(body) }),

  update: (
    id: string,
    body: { name?: string; baseUrl?: string; enabled?: boolean; apiKey?: string | null },
  ) =>
    request<{ provider: ProviderSummary }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  remove: (id: string) =>
    request<{ deleted: boolean }>(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Performs a real request against the provider. Never sends the key back. */
  test: (id: string, apiKey?: string) =>
    request<{ result: ProviderTestResult }>(`/api/providers/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: JSON.stringify(apiKey ? { apiKey } : {}),
    }),

  discoverModels: (id: string) =>
    request<{ models: Array<{ id: string; registered: boolean }>; total: number }>(
      `/api/providers/${encodeURIComponent(id)}/models`,
    ),

  registerModels: (id: string, modelIds: string[]) =>
    request<{ created: number; requested: number }>(
      `/api/providers/${encodeURIComponent(id)}/models`,
      { method: 'POST', body: JSON.stringify({ modelIds }) },
    ),

  envStatus: () =>
    request<{
      variables: Array<{ kind: string; name: string | null; present: boolean }>;
      note: string;
    }>('/api/providers/env-status'),
};

/**
 * Typed API client.
 *
 * Every call returns a discriminated result so the UI can render a specific
 * error state instead of a generic alert. Network failures, HTTP errors and
 * malformed bodies are all surfaced — never silently swallowed.
 */
import type {
  ApiErrorBody,
  AuthStatus,
  Benchmark,
  BenchmarkItem,
  BenchmarkVersion,
  CommunitySubmission,
  CompareResponse,
  EvaluationProgress,
  EvaluationResult,
  EvaluationRun,
  HealthStatus,
  Model,
  ModelDetail,
  ProviderSummary,
  RegressionEvent,
  RegressionReport,
  Report,
  UserSettings,
} from '../../shared/types';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiFailure };

export interface ApiFailure {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  details?: unknown;
}

const TIMEOUT_MS = 25000;

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = TIMEOUT_MS,
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
        if (!response.ok) {
          return {
            ok: false,
            error: {
              code: 'BAD_RESPONSE',
              message: `Server returned ${response.status} with a non-JSON body.`,
              status: response.status,
              retryable: response.status >= 500,
            },
          };
        }
      }
    }

    if (!response.ok) {
      const body = parsed as ApiErrorBody | null;

      // A 500 with no JSON body is what the Vite dev proxy returns when the API
      // process is not running. Reporting it as `HTTP_500` sends people hunting
      // for a code bug, so it gets its own code and an actionable message.
      if (!body?.error && response.status >= 500) {
        return {
          ok: false,
          error: {
            code: 'BACKEND_UNAVAILABLE',
            message:
              'The API server is not responding. Start it with `npm run dev` (or `npm run dev:api`) in the project directory, then retry.',
            status: response.status,
            retryable: true,
          },
        };
      }

      return {
        ok: false,
        error: {
          code: body?.error?.code ?? `HTTP_${response.status}`,
          message: body?.error?.message ?? `Request failed with status ${response.status}.`,
          status: response.status,
          retryable: body?.error?.retryable ?? response.status >= 500,
          details: body?.error?.details,
        },
      };
    }

    return { ok: true, data: parsed as T };
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'AbortError') {
      return {
        ok: false,
        error: {
          code: 'TIMEOUT',
          message: 'The request timed out.',
          status: 0,
          retryable: true,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'NETWORK_ERROR',
        message: 'Cannot reach the server.',
        status: 0,
        retryable: true,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });
const patch = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// typed endpoints
// ---------------------------------------------------------------------------

export const api = {
  health: () => get<HealthStatus>('/api/health'),

  // --- auth ----------------------------------------------------------------
  authStatus: () => get<AuthStatus>('/api/auth/status'),
  login: (token: string) => post<{ authenticated: boolean }>('/api/auth/login', { token }),
  logout: () => post<{ authenticated: boolean }>('/api/auth/logout', {}),

  overview: () =>
    get<{
      counts: {
        models: number;
        evaluatedModels: number;
        trackedModels: number;
        benchmarks: number;
        benchmarkItems: number;
        realRuns: number;
        demoRuns: number;
      };
      recentRuns: EvaluationRun[];
      recentEvents: RegressionEvent[];
      trend: Array<{ modelId: string; displayName: string; points: Array<{ at: string; score: number }> }>;
      dimensionAverages: Record<string, number>;
      providerReadiness: Array<{ name: string; kind: string; hasCredential: boolean }>;
    }>('/api/overview'),

  providers: () => get<{ providers: ProviderSummary[] }>('/api/providers'),

  models: (params?: { search?: string; providerId?: string; status?: string }) => {
    const query = new URLSearchParams();
    if (params?.search) query.set('search', params.search);
    if (params?.providerId) query.set('providerId', params.providerId);
    if (params?.status) query.set('status', params.status);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return get<{ models: Model[]; total: number }>(`/api/models${suffix}`);
  },

  model: (id: string) =>
    get<{
      model: ModelDetail;
      /** Third-party reference scores. Never part of this deployment's results. */
      external?: {
        matched: { modelRef: string; name: string; vendor: string } | null;
        scores: Array<{
          metric: string;
          category: string;
          value: number;
          unit: string;
          source: string;
          observedAt: string;
        }>;
        disclaimer: string;
      };
    }>(`/api/models/${encodeURIComponent(id)}`),

  createModel: (body: {
    providerId: string;
    modelId: string;
    displayName: string;
    knownVersions?: string[];
  }) => post<{ model: ModelDetail }>('/api/models', body),

  benchmarks: (dimension?: string) =>
    get<{
      benchmarks: Benchmark[];
      dimensions: string[];
      scorerTypes: string[];
      datasetMeta: { source: string; sourceLicense: string; scorerVersion: string };
    }>(`/api/benchmarks${dimension ? `?dimension=${encodeURIComponent(dimension)}` : ''}`),

  benchmark: (id: string) =>
    get<{ benchmark: Benchmark; items: BenchmarkItem[] }>(`/api/benchmarks/${encodeURIComponent(id)}`),

  benchmarkVersions: (id: string) =>
    get<{ versions: BenchmarkVersion[] }>(`/api/benchmarks/${encodeURIComponent(id)}/versions`),

  createBenchmarkVersion: (
    id: string,
    body: {
      version: string;
      notes: string;
      items: Array<{
        externalKey: string;
        dimension: string;
        question: string;
        reference?: string | null;
        scorerType: string;
        scorerConfig: Record<string, unknown>;
        difficulty: 'easy' | 'medium' | 'hard';
      }>;
      setAsCurrent?: boolean;
    },
  ) => post<{ version: BenchmarkVersion; itemCount: number }>(`/api/benchmarks/${encodeURIComponent(id)}/versions`, body),

  validateItem: (body: {
    scorerType: string;
    scorerConfig: Record<string, unknown>;
    reference?: string | null;
    question: string;
    response: string;
  }) =>
    post<{ result: { score: number; breakdown: Record<string, unknown> }; passThreshold: number }>(
      '/api/benchmarks/validate-item',
      body,
    ),

  runs: (params?: { limit?: number; modelId?: string; includeDemo?: boolean }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.modelId) query.set('modelId', params.modelId);
    if (params?.includeDemo) query.set('includeDemo', 'true');
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return get<{ runs: EvaluationRun[]; total: number }>(`/api/evaluations${suffix}`);
  },

  run: (id: string) => get<{ run: EvaluationRun; progress: EvaluationProgress }>(`/api/evaluations/${id}`),

  runProgress: (id: string) =>
    get<{ progress: EvaluationProgress; status: string }>(`/api/evaluations/${id}/progress`),

  runResults: (id: string, params?: { dimension?: string; status?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.dimension) query.set('dimension', params.dimension);
    if (params?.status) query.set('status', params.status);
    if (params?.limit) query.set('limit', String(params.limit));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return get<{ run: EvaluationRun; results: EvaluationResult[]; total: number }>(
      `/api/evaluations/${id}/results${suffix}`,
    );
  },

  createEvaluation: (body: {
    modelId: string;
    benchmarkId?: string;
    benchmarkVersionId?: string;
    params?: Record<string, unknown>;
    itemLimit?: number;
    idempotencyKey?: string;
    notes?: string;
  }) => post<{ run: EvaluationRun; reused: boolean }>('/api/evaluations', body),

  cancelEvaluation: (id: string) =>
    post<{ cancelled: boolean; run: EvaluationRun }>(`/api/evaluations/${id}/cancel`, {}),

  estimate: (items: number, maxTokens: number) =>
    get<{
      items: number;
      promptTokens: number;
      completionTokens: number;
      maxItemsPerRun: number;
      defaultBudgetUsd: number;
      note: string;
    }>(`/api/evaluations/estimate?items=${items}&maxTokens=${maxTokens}`),

  compare: (runIds: string[]) => get<CompareResponse>(`/api/compare?runIds=${runIds.join(',')}`),

  pairwise: (baselineRunId: string, comparisonRunId: string) =>
    get<{ report: RegressionReport }>(
      `/api/compare/pairwise?baselineRunId=${baselineRunId}&comparisonRunId=${comparisonRunId}`,
    ),

  regressionCandidates: (modelId: string) =>
    get<{
      runs: Array<{
        id: string;
        createdAt: string;
        benchmarkVersion: string;
        benchmarkVersionId: string;
        status: string;
        overallScore: number | null;
        sampleCount: number;
      }>;
    }>(`/api/regression/candidates?modelId=${encodeURIComponent(modelId)}`),

  compareRuns: (baselineRunId: string, comparisonRunId: string) =>
    post<{ report: RegressionReport }>('/api/regression/compare', { baselineRunId, comparisonRunId }),

  regressionEvents: (limit = 50) =>
    get<{ events: RegressionEvent[]; total: number }>(`/api/regression-events?limit=${limit}`),

  reports: () => get<{ reports: Report[]; total: number }>('/api/reports'),

  report: (publicId: string, token?: string) =>
    get<{ report: Report; results: EvaluationResult[]; shareToken: string | null }>(
      `/api/reports/${encodeURIComponent(publicId)}${token ? `?token=${encodeURIComponent(token)}` : ''}`,
    ),

  createReport: (body: {
    runId: string;
    visibility: 'public' | 'private';
    title: string;
    summary: string;
    language: 'zh-CN' | 'en';
  }) => post<{ report: Report; reused: boolean }>('/api/reports', body),

  updateReport: (
    publicId: string,
    body: { visibility?: 'public' | 'private'; title?: string; summary?: string },
    token?: string,
  ) =>
    patch<{ report: Report }>(
      `/api/reports/${encodeURIComponent(publicId)}${token ? `?token=${encodeURIComponent(token)}` : ''}`,
      body,
    ),

  settings: () => get<{ settings: UserSettings }>('/api/settings'),

  updateSettings: (body: Partial<UserSettings>) => patch<{ settings: UserSettings }>('/api/settings', body),

  providerStatus: () =>
    get<{
      providers: Array<{
        id: string;
        name: string;
        kind: string;
        enabled: boolean;
        hasCredential: boolean;
        credentialSource: 'database' | 'environment' | 'none';
        credentialHint: string | null;
        credentialSourceName: string | null;
        baseUrl: string;
        isBuiltin: boolean;
        modelCount: number;
      }>;
      note: string;
    }>('/api/settings/provider-status'),

  catalog: (params?: { vendor?: string; search?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.vendor) query.set('vendor', params.vendor);
    if (params?.search) query.set('search', params.search);
    if (params?.limit) query.set('limit', String(params.limit));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return get<{
      models: Array<{
        id: string;
        name: string;
        vendor: string;
        contextLength: number | null;
        inputPerMillion: number | null;
        outputPerMillion: number | null;
        createdAt: string | null;
        arenaElo: number | null;
        arenaCategories: Array<{ category: string; elo: number; rank: number | null }>;
        aaIntelligenceIndex: number | null;
        aaCodingIndex: number | null;
        aaAgenticIndex: number | null;
        inputModalities: string[];
        description: string;
        importedAt: string;
        references: Array<{
          metric: string;
          category: string;
          value: number;
          unit: string;
          source: string;
          observedAt: string;
        }>;
        registeredModelId: string | null;
      }>;
      vendors: Array<{ vendor: string; count: number }>;
      lastImport: { importedAt: string; status: string; modelsSeen: number; message: string | null } | null;
      source: { id: string; url: string; disclaimer: string };
      total: number;
    }>(`/api/catalog${suffix}`);
  },

  importCatalog: () =>
    post<{
      result: {
        ok: boolean;
        modelsSeen: number;
        modelsNew: number;
        scoresWritten: number;
        importedAt: string;
        coverage: { arena: number; artificialAnalysis: number; pricing: number };
        message: string;
      };
    }>('/api/catalog/import', {}),

  registerCatalogModel: (catalogId: string, providerId: string) =>
    post<{ created: boolean; modelId: string }>(
      `/api/catalog/${encodeURIComponent(catalogId)}/register`,
      { providerId },
    ),

  community: () =>
    get<{
      submissions: CommunitySubmission[];
      publicReports: Array<{
        publicId: string;
        runId: string;
        title: string;
        summary: string;
        language: string;
        createdAt: string;
      }>;
    }>('/api/community'),

  submitCommunityItem: (body: {
    kind?: 'item' | 'report' | 'note';
    title: string;
    body: string;
    dimension?: string | null;
    reference?: string | null;
    author?: string;
  }) => post<{ submission: CommunitySubmission; note: string }>('/api/community/submissions', body),
};

export function errorMessage(error: ApiFailure): string {
  switch (error.code) {
    case 'NETWORK_ERROR':
      return 'state.errorNetwork';
    case 'TIMEOUT':
      return 'state.errorTimeout';
    case 'FORBIDDEN':
      return 'state.errorForbidden';
    case 'NOT_FOUND':
      return 'state.errorNotFound';
    case 'UNAUTHENTICATED':
      return 'auth.required';
    default:
      return error.message || 'state.errorUnexpected';
  }
}

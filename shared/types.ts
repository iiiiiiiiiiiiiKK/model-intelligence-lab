/**
 * Canonical domain contract shared by the server, the React app and the tests.
 * Keep in sync with the schema in `server/db/index.ts`.
 */

export type Locale = 'zh-CN' | 'en';

export type ProviderKind =
  | 'openai-compatible'
  | 'openai'
  | 'deepseek'
  | 'anthropic'
  | 'custom';

export type ModelStatus = 'registered' | 'connected' | 'evaluated' | 'tracked';

export type BenchmarkDimension =
  | 'reasoning'
  | 'coding'
  | 'instruction-following'
  | 'factuality'
  | 'stability'
  | 'behavior';

export type BenchmarkVisibility = 'public' | 'private';

export type ScorerType =
  | 'exact-match'
  | 'normalized-match'
  | 'numeric-tolerance'
  | 'json-schema'
  | 'rule-based'
  | 'unit-test'
  | 'llm-judge'
  | 'human';

export type Difficulty = 'easy' | 'medium' | 'hard';

export type EvaluationStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial-failure'
  | 'failed'
  | 'cancelled';

export type ResultStatus = 'scored' | 'error' | 'timeout' | 'cancelled';

export type RegressionConclusion =
  | 'significant-regression'
  | 'significant-improvement'
  | 'no-significant-change'
  | 'inconclusive'
  | 'not-comparable'
  | 'insufficient-data'
  | 'execution-failed';

export type ReportVisibility = 'public' | 'private';

export type VersionVerification = 'verified' | 'unverified' | 'unknown';

export type CredentialSource = 'database' | 'environment' | 'none';

export interface ProviderSummary {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  enabled: boolean;
  /** Whether a credential is resolvable (from the database or the environment). */
  hasCredential: boolean;
  /** Where that credential comes from. Never the credential itself. */
  credentialSource: CredentialSource;
  /** Masked hint such as `••••abcd`, or null when nothing is stored. */
  credentialHint: string | null;
  /** True when the base URL was set explicitly rather than inherited. */
  customBaseUrl: boolean;
  /** Built-in rows cannot be deleted, only edited or disabled. */
  isBuiltin: boolean;
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Result of a real connectivity probe against a provider. */
export interface ProviderTestResult {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  message: string;
  modelCount: number | null;
  sampleModels: string[];
}

export interface Model {
  id: string;
  providerId: string;
  providerName: string;
  providerKind: ProviderKind;
  providerHasCredential: boolean;
  modelId: string;
  displayName: string;
  knownVersions: string[];
  versionVerification: VersionVerification;
  metadata: Record<string, unknown>;
  status: ModelStatus;
  isDemo: boolean;
  lastEvaluatedAt: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelScoreSummary {
  overall: number | null;
  dimensions: Record<string, number | null>;
  sampleSize: number;
}

export interface ModelDetail extends Model {
  latestRun: EvaluationRun | null;
  scoreSummary: ModelScoreSummary;
  history: Array<{
    runId: string;
    createdAt: string;
    overall: number | null;
    status: EvaluationStatus;
    benchmarkVersion: string;
  }>;
}

export interface ScorerConfig {
  type: ScorerType;
  version: string;
  config: Record<string, unknown>;
  rationale?: string;
  judgeModel?: string | null;
}

export interface BenchmarkItem {
  id: string;
  externalKey: string;
  dimension: BenchmarkDimension;
  question: string;
  reference: string | null;
  scorer: ScorerConfig;
  difficulty: Difficulty;
  source: string;
  sourceLicense: string;
  visibility: BenchmarkVisibility;
}

export interface BenchmarkVersion {
  id: string;
  benchmarkId: string;
  version: string;
  contentHash: string;
  scorerVersion: string;
  published: boolean;
  itemCount: number;
  notes: string;
  createdAt: string;
  dimensionCounts: Record<string, number>;
}

export interface Benchmark {
  id: string;
  name: string;
  description: string;
  visibility: BenchmarkVisibility;
  dimensions: BenchmarkDimension[];
  currentVersionId: string | null;
  currentVersion: string | null;
  itemCount: number;
  isDemo: boolean;
  versions: BenchmarkVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationParams {
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  retries: number;
  concurrency: number;
  budgetUsd: number;
  systemPrompt: string | null;
}

export interface ModelSnapshot {
  modelId: string;
  providerId: string;
  providerKind: ProviderKind;
  providerName: string;
  baseUrl: string;
  modelDbId: string;
  displayName: string;
  knownVersions: string[];
  versionVerification: VersionVerification;
}

export interface EvaluationRun {
  id: string;
  modelId: string;
  modelDisplayName: string;
  providerName: string;
  benchmarkId: string;
  benchmarkName: string;
  benchmarkVersionId: string;
  benchmarkVersion: string;
  status: EvaluationStatus;
  params: EvaluationParams;
  modelSnapshot: ModelSnapshot;
  sampleCount: number;
  successCount: number;
  failCount: number;
  timeoutCount: number;
  scores: Record<string, number>;
  overallScore: number | null;
  totalLatencyMs: number;
  totalTokens: number;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  errorSummary: Record<string, number> | null;
  cancelRequested: boolean;
  isDemo: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  reportId: string | null;
}

export interface EvaluationResult {
  id: string;
  runId: string;
  itemId: string;
  externalKey: string;
  dimension: BenchmarkDimension;
  question: string;
  reference: string | null;
  scorerType: ScorerType;
  rawResponse: string | null;
  normalizedResponse: string | null;
  score: number;
  scoreBreakdown: Record<string, unknown> | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  status: ResultStatus;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
}

export interface EvaluationProgress {
  runId: string;
  status: EvaluationStatus;
  total: number;
  completed: number;
  failed: number;
  cancelRequested: boolean;
  lastError: string | null;
  updatedAt: string;
}

export interface RegressionDimensionResult {
  dimension: BenchmarkDimension | null;
  baselineScore: number;
  currentScore: number;
  delta: number;
  relativeDelta: number | null;
  sampleSize: number;
  confidenceInterval: [number, number] | null;
  statistic: string | null;
  statisticValue: number | null;
  pValue: number | null;
  adjustedPValue: number | null;
  method: string;
  conclusion: RegressionConclusion;
  counts: {
    bothCorrect: number;
    baselineOnlyCorrect: number;
    comparisonOnlyCorrect: number;
    bothIncorrect: number;
  } | null;
  baselineInterval: [number, number] | null;
  currentInterval: [number, number] | null;
}

export interface RegressionReport {
  modelId: string;
  modelDisplayName: string;
  baselineRunId: string;
  comparisonRunId: string;
  benchmarkVersion: string;
  comparable: boolean;
  comparabilityIssues: string[];
  overall: RegressionDimensionResult;
  dimensions: RegressionDimensionResult[];
  eventIds: string[];
  createdAt: string;
}

export interface RegressionEvent {
  id: string;
  modelId: string;
  modelDisplayName: string;
  benchmarkVersionId: string;
  baselineRunId: string;
  comparisonRunId: string;
  dimension: BenchmarkDimension | null;
  baselineScore: number;
  currentScore: number;
  delta: number;
  relativeDelta: number | null;
  sampleSize: number;
  confidenceInterval: [number, number] | null;
  statistic: string | null;
  pValue: number | null;
  conclusion: RegressionConclusion;
  acknowledged: boolean;
  createdAt: string;
}

export interface Report {
  id: string;
  publicId: string;
  runId: string;
  visibility: ReportVisibility;
  title: string;
  summary: string;
  language: Locale;
  createdAt: string;
  run: EvaluationRun | null;
}

export interface UserSettings {
  language: Locale;
  defaultModelId: string | null;
  defaultBenchmarkId: string | null;
  defaultBudgetUsd: number;
  reportVisibility: ReportVisibility;
  notifications: {
    regressionAlerts: boolean;
    runCompleted: boolean;
  };
  updatedAt: string;
}

export interface CommunitySubmission {
  id: string;
  kind: 'item' | 'report' | 'note';
  title: string;
  body: string;
  dimension: BenchmarkDimension | null;
  reference: string | null;
  author: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  services: {
    database: 'ok' | 'down';
    providers: Record<string, 'ok' | 'unconfigured'>;
  };
  version: string;
  uptimeSeconds: number;
  demoDataPresent: boolean;
  /** True when the instance is behind an access token. */
  authRequired?: boolean;
}

/** Combined answer from `GET /api/auth/status`. */
export interface AuthStatus {
  /** Whether a token is configured at all, i.e. whether the gate is active. */
  required: boolean;
  /** Whether this browser already holds a valid session. */
  authenticated: boolean;
}

export interface CompareEntry {
  runId: string;
  modelId: string;
  modelDisplayName: string;
  providerName: string;
  benchmarkVersion: string;
  status: EvaluationStatus;
  overallScore: number | null;
  dimensions: Record<string, number>;
  successRate: number;
  errorRate: number;
  avgLatencyMs: number;
  totalCostUsd: number;
  sampleCount: number;
  comparable: boolean;
  comparabilityIssues: string[];
}

export interface CompareResponse {
  entries: CompareEntry[];
  items: Array<{
    itemId: string;
    dimension: BenchmarkDimension;
    question: string;
    results: Record<string, { score: number; status: ResultStatus }>;
  }>;
  alignmentNotes: string[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
  };
}

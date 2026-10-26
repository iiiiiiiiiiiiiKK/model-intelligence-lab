import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  FlaskConical,
  KeyRound,
  PlayCircle,
  StopCircle,
  XCircle,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { api, type ApiFailure } from '../lib/api';
import { useApi, usePolling } from '../hooks/useApi';
import { EmptyState, ErrorState, LoadingBlock, Spinner } from '../components/ui/States';
import {
  Callout,
  DimensionLabel,
  PageHeader,
  Pill,
  ScoreBar,
  Section,
  StatusBadge,
} from '../components/ui/Primitives';
import {
  formatCurrencyUsd,
  formatDate,
  formatLatency,
  formatNumber,
  formatScore,
  truncateText,
} from '../lib/format';
import type { EvaluationProgress, EvaluationResult, EvaluationRun } from '../../shared/types';

const ACTIVE_STATES = ['queued', 'running'];

export default function LabPage() {
  const { t, locale } = useI18n();
  const [searchParams] = useSearchParams();
  const prefillModel = searchParams.get('model') ?? '';
  const prefillRun = searchParams.get('run') ?? '';

  const models = useApi(() => api.models(), []);
  const benchmarks = useApi(() => api.benchmarks(), []);
  const settings = useApi(() => api.settings(), []);

  const [modelId, setModelId] = useState(prefillModel);
  const [benchmarkId, setBenchmarkId] = useState('');
  const [itemLimit, setItemLimit] = useState(20);
  const [temperature, setTemperature] = useState(0);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [timeoutMs, setTimeoutMs] = useState(60000);
  const [retries, setRetries] = useState(2);
  const [concurrency, setConcurrency] = useState(3);
  const [budgetUsd, setBudgetUsd] = useState(2);
  const [systemPrompt, setSystemPrompt] = useState('');

  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [progress, setProgress] = useState<EvaluationProgress | null>(null);
  const [results, setResults] = useState<EvaluationResult[]>([]);
  const [starting, setStarting] = useState(false);
  const [createError, setCreateError] = useState<ApiFailure | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reportState, setReportState] = useState<{ loading: boolean; publicId: string | null; error: string | null }>({
    loading: false,
    publicId: null,
    error: null,
  });
  const idempotencyKey = useRef<string>(
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `key-${Date.now()}`,
  );

  // Apply defaults from settings once loaded (never overwrite a user choice).
  useEffect(() => {
    if (!settings.data) return;
    setBenchmarkId((current) => current || settings.data!.settings.defaultBenchmarkId || '');
    setModelId((current) => current || settings.data!.settings.defaultModelId || '');
    setBudgetUsd((current) => (current === 2 ? settings.data!.settings.defaultBudgetUsd : current));
  }, [settings.data]);

  // Pick a sane default model once the model list arrives.
  useEffect(() => {
    if (modelId) return;
    const list = models.data?.models ?? [];
    const preferred = list.find((m) => m.providerHasCredential) ?? list[0];
    if (preferred) setModelId(preferred.id);
  }, [models.data, modelId]);

  useEffect(() => {
    if (benchmarkId) return;
    const list = benchmarks.data?.benchmarks ?? [];
    if (list[0]) setBenchmarkId(list[0].id);
  }, [benchmarks.data, benchmarkId]);

  const selectedModel = (models.data?.models ?? []).find((m) => m.id === modelId) ?? null;
  const selectedBenchmark = (benchmarks.data?.benchmarks ?? []).find((b) => b.id === benchmarkId) ?? null;
  const maxItems = selectedBenchmark?.itemCount ?? 0;

  // Restore a run from the URL (e.g. after a reload or a shared link).
  useEffect(() => {
    if (!prefillRun) return;
    let mounted = true;
    void api.run(prefillRun).then((result) => {
      if (!mounted || !result.ok) return;
      setRun(result.data.run);
      setProgress(result.data.progress);
    });
    return () => {
      mounted = false;
    };
  }, [prefillRun]);

  // Resume the most recent unfinished run on first load.
  useEffect(() => {
    if (prefillRun) return;
    let mounted = true;
    void api.runs({ limit: 10 }).then((result) => {
      if (!mounted || !result.ok) return;
      const unfinished = result.data.runs.find((entry) => ACTIVE_STATES.includes(entry.status));
      if (unfinished) {
        setRun(unfinished);
        void api.run(unfinished.id).then((detail) => {
          if (mounted && detail.ok) setProgress(detail.data.progress);
        });
      }
    });
    return () => {
      mounted = false;
    };
  }, [prefillRun]);

  const refreshRun = useCallback(async () => {
    if (!run) return;
    const detail = await api.run(run.id);
    if (!detail.ok) return;
    setRun(detail.data.run);
    setProgress(detail.data.progress);
    if (!ACTIVE_STATES.includes(detail.data.run.status)) {
      const resultList = await api.runResults(run.id, { limit: 500 });
      if (resultList.ok) setResults(resultList.data.results);
    }
  }, [run]);
  const isActive = run ? ACTIVE_STATES.includes(run.status) : false;
  usePolling(() => void refreshRun(), isActive ? 1600 : null);

  // Load final results whenever a run reaches a terminal state.
  const runId = run?.id;
  const runStatus = run?.status;
  useEffect(() => {
    if (!runId || !runStatus || ACTIVE_STATES.includes(runStatus)) return;
    void api.runResults(runId, { limit: 500 }).then((result) => {
      if (result.ok) setResults(result.data.results);
    });
  }, [runId, runStatus]);

  const estimate = useApi(
    () => api.estimate(Math.max(1, Math.min(itemLimit, maxItems || itemLimit)), maxTokens),
    [itemLimit, maxTokens, maxItems],
  );

  const canRun = Boolean(selectedModel && selectedBenchmark && selectedModel.providerHasCredential && !starting && !isActive);

  const startEvaluation = async () => {
    if (!selectedModel || !selectedBenchmark) return;
    setStarting(true);
    setCreateError(null);
    setResults([]);
    setReportState({ loading: false, publicId: null, error: null });

    const response = await api.createEvaluation({
      modelId: selectedModel.id,
      benchmarkId: selectedBenchmark.id,
      itemLimit: Math.max(1, Math.min(itemLimit, maxItems || itemLimit)),
      params: {
        temperature,
        maxTokens,
        timeoutMs,
        retries,
        concurrency,
        budgetUsd,
        systemPrompt: systemPrompt.trim() ? systemPrompt.trim() : null,
      },
      // The idempotency key is stable per form session, so a double click or a
      // locale switch mid-submit cannot create a second run.
      idempotencyKey: idempotencyKey.current,
    });

    if (response.ok) {
      setRun(response.data.run);
      setProgress(null);
      void api.run(response.data.run.id).then((detail) => {
        if (detail.ok) setProgress(detail.data.progress);
      });
    } else {
      setCreateError(response.error);
    }
    setStarting(false);
  };

  const cancelEvaluation = async () => {
    if (!run) return;
    if (!window.confirm(t('lab.cancelConfirm'))) return;
    setCancelling(true);
    const result = await api.cancelEvaluation(run.id);
    if (result.ok) {
      setRun(result.data.run);
      await refreshRun();
    }
    setCancelling(false);
  };

  const createReport = async () => {
    if (!run) return;
    setReportState({ loading: true, publicId: null, error: null });
    const result = await api.createReport({
      runId: run.id,
      visibility: settings.data?.settings.reportVisibility ?? 'private',
      title: `${run.modelDisplayName} · ${run.benchmarkVersion}`,
      summary: '',
      language: locale,
    });
    if (result.ok) {
      setReportState({ loading: false, publicId: result.data.report.publicId, error: null });
    } else {
      setReportState({ loading: false, publicId: null, error: result.error.message });
    }
  };

  const stats = useMemo(() => {
    if (!run) return null;
    const executed = run.successCount + run.failCount + run.timeoutCount;
    return {
      executed,
      successRate: executed > 0 ? run.successCount / executed : 0,
      avgLatency: executed > 0 ? run.totalLatencyMs / executed : 0,
    };
  }, [run]);

  return (
    <div className="space-y-5">
      <PageHeader title={t('lab.title')} description={t('lab.subtitle')} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        {/* configuration */}
        <div className="space-y-5">
          <Section title={t('lab.step.selectModel')}>
            {models.error ? (
              <ErrorState error={models.error} onRetry={models.reload} compact />
            ) : models.initialLoading ? (
              <LoadingBlock />
            ) : (
              <div className="space-y-3">
                <label className="block space-y-1.5">
                  <span className="lab-label">{t('lab.model')}</span>
                  <select
                    value={modelId}
                    onChange={(event) => {
                      setModelId(event.target.value);
                      idempotencyKey.current = crypto.randomUUID();
                      setCreateError(null);
                    }}
                    className="lab-input text-sm"
                    disabled={isActive}
                  >
                    <option value="">{t('lab.selectPlaceholder')}</option>
                    {(models.data?.models ?? []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName} · {model.providerName}
                        {model.providerHasCredential ? '' : ` (${t('home.readiness.missing')})`}
                      </option>
                    ))}
                  </select>
                </label>

                {selectedModel ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Pill tone={selectedModel.providerHasCredential ? 'accent' : 'warn'}>
                      <KeyRound className="h-3 w-3" aria-hidden="true" />
                      {selectedModel.providerHasCredential ? t('home.readiness.configured') : t('home.readiness.missing')}
                    </Pill>
                    <Pill tone="neutral">{selectedModel.versionVerification === 'unknown' ? t('models.versionUnknown') : selectedModel.versionVerification}</Pill>
                    <span className="font-mono text-2xs text-lab-faint">{selectedModel.modelId}</span>
                  </div>
                ) : null}

                {selectedModel && !selectedModel.providerHasCredential ? (
                  <Callout tone="warn" icon={<KeyRound className="h-4 w-4" />}>
                    {t('lab.noCredential')}{' '}
                    <Link to="/settings" className="lab-link">
                      {t('lab.noCredentialCta')}
                    </Link>
                  </Callout>
                ) : null}
              </div>
            )}
          </Section>

          <Section title={t('lab.step.selectBenchmark')}>
            {benchmarks.error ? (
              <ErrorState error={benchmarks.error} onRetry={benchmarks.reload} compact />
            ) : benchmarks.initialLoading ? (
              <LoadingBlock />
            ) : (
              <div className="space-y-3">
                <label className="block space-y-1.5">
                  <span className="lab-label">{t('lab.benchmark')}</span>
                  <select
                    value={benchmarkId}
                    onChange={(event) => setBenchmarkId(event.target.value)}
                    className="lab-input text-sm"
                    disabled={isActive}
                  >
                    <option value="">{t('lab.selectPlaceholder')}</option>
                    {(benchmarks.data?.benchmarks ?? []).map((benchmark) => (
                      <option key={benchmark.id} value={benchmark.id}>
                        {benchmark.name} ({benchmark.currentVersion})
                      </option>
                    ))}
                  </select>
                </label>
                {selectedBenchmark ? (
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap gap-1.5">
                      {selectedBenchmark.dimensions.map((dimension) => (
                        <Pill key={dimension} tone="neutral">
                          {t(`dimension.${dimension}` as never)}
                        </Pill>
                      ))}
                    </div>
                    <p className="text-2xs text-lab-faint">
                      {t('benchmarks.col.items')}: {formatNumber(selectedBenchmark.itemCount, locale)} ·{' '}
                      {t('lab.benchmarkVersion')}: <span className="font-mono">{selectedBenchmark.currentVersion}</span>
                    </p>
                  </div>
                ) : null}
              </div>
            )}
          </Section>

          <Section title={t('lab.step.configure')}>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="lab-label">{t('lab.itemLimit')}</span>
                <input
                  type="number"
                  min={1}
                  max={maxItems || 200}
                  value={itemLimit}
                  onChange={(event) => setItemLimit(Number(event.target.value))}
                  className="lab-input font-mono text-sm"
                  disabled={isActive}
                />
              </label>
              <label className="block space-y-1">
                <span className="lab-label">{t('lab.temperature')}</span>
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(event) => setTemperature(Number(event.target.value))}
                  className="lab-input font-mono text-sm"
                  disabled={isActive}
                />
              </label>
              <label className="block space-y-1">
                <span className="lab-label">{t('lab.maxTokens')}</span>
                <input
                  type="number"
                  min={16}
                  max={16384}
                  step={64}
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(Number(event.target.value))}
                  className="lab-input font-mono text-sm"
                  disabled={isActive}
                />
              </label>
              <label className="block space-y-1">
                <span className="lab-label">{t('lab.timeout')}</span>
                <input
                  type="number"
                  min={1000}
                  max={600000}
                  step={1000}
                  value={timeoutMs}
                  onChange={(event) => setTimeoutMs(Number(event.target.value))}
                  className="lab-input font-mono text-sm"
                  disabled={isActive}
                />
              </label>
              <label className="block space-y-1">
                <span className="lab-label">{t('lab.retries')}</span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={retries}
                  onChange={(event) => setRetries(Number(event.target.value))}
                  className="lab-input font-mono text-sm"
                  disabled={isActive}
                />
              </label>
              <label className="block space-y-1">
                <span className="lab-label">{t('lab.concurrency')}</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={concurrency}
                  onChange={(event) => setConcurrency(Number(event.target.value))}
                  className="lab-input font-mono text-sm"
                  disabled={isActive}
                />
              </label>
              <label className="col-span-2 block space-y-1">
                <span className="lab-label">{t('lab.systemPrompt')}</span>
                <textarea
                  rows={2}
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  placeholder={t('lab.systemPromptHint')}
                  className="lab-input resize-y font-mono text-xs"
                  disabled={isActive}
                  maxLength={4000}
                />
              </label>
            </div>
          </Section>

          <Section title={t('lab.step.budget')}>
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="lab-label">{t('lab.budget')}</span>
                <input
                  type="number"
                  min={0}
                  max={1000}
                  step={0.5}
                  value={budgetUsd}
                  onChange={(event) => setBudgetUsd(Number(event.target.value))}
                  className="lab-input font-mono text-sm"
                  disabled={isActive}
                />
                <span className="block text-2xs text-lab-faint">{t('lab.budgetHint')}</span>
              </label>

              {estimate.data ? (
                <dl className="space-y-1 rounded-lab border border-lab-border bg-lab-surface px-3 py-2.5 text-2xs">
                  <div className="flex justify-between">
                    <dt className="text-lab-faint">{t('lab.estimateItems')}</dt>
                    <dd className="font-mono text-lab-text">{formatNumber(estimate.data.items, locale)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-lab-faint">{t('lab.estimatePromptTokens')}</dt>
                    <dd className="font-mono text-lab-text">{formatNumber(estimate.data.promptTokens, locale)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-lab-faint">{t('lab.estimateCompletionTokens')}</dt>
                    <dd className="font-mono text-lab-text">{formatNumber(estimate.data.completionTokens, locale)}</dd>
                  </div>
                  <p className="pt-1 text-2xs leading-snug text-lab-faint">{t('lab.estimateNote')}</p>
                </dl>
              ) : null}

              <button
                type="button"
                className="lab-btn-primary w-full"
                onClick={startEvaluation}
                disabled={!canRun}
              >
                {starting ? <Spinner /> : <PlayCircle className="h-4 w-4" aria-hidden="true" />}
                {starting ? t('lab.starting') : t('lab.confirmRun')}
              </button>

              {createError ? (
                <ErrorState error={createError} compact />
              ) : null}

              {!selectedModel?.providerHasCredential && selectedModel ? (
                <p className="text-2xs text-lab-faint">{t('lab.noCredential')}</p>
              ) : null}
            </div>
          </Section>
        </div>

        {/* execution */}
        <div className="space-y-5">
          {!run ? (
            <Section title={t('lab.step.run')}>
              <EmptyState
                icon={<FlaskConical className="h-5 w-5" />}
                title={t('state.noData')}
                description={t('lab.subtitle')}
              />
            </Section>
          ) : (
            <>
              <Section
                title={t('lab.progress')}
                actions={
                  <>
                    <StatusBadge status={run.status} />
                    {isActive ? (
                      <button
                        type="button"
                        className="lab-btn-danger text-xs"
                        onClick={cancelEvaluation}
                        disabled={cancelling}
                      >
                        <StopCircle className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('lab.cancelRun')}
                      </button>
                    ) : null}
                  </>
                }
              >
                <div className="space-y-3">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="text-sm font-medium text-lab-text">{run.modelDisplayName}</span>
                    <span className="font-mono text-2xs text-lab-faint">{run.benchmarkName} · {run.benchmarkVersion}</span>
                    <span className="text-2xs text-lab-faint">{formatDate(run.createdAt, locale)}</span>
                  </div>

                  {progress ? (
                    <div className="space-y-1.5">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-lab-hover">
                        <div
                          className={`h-full rounded-full transition-[width] duration-500 ${
                            run.status === 'failed' ? 'bg-[#FF7474]' : 'bg-[#B5E94B]'
                          }`}
                          style={{
                            width: `${
                              progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0
                            }%`,
                          }}
                        />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-lab-faint">
                        <span>
                          {t('lab.progressOf', { done: progress.completed, total: progress.total })}
                          {progress.failed > 0 ? ` · ${t('state.failed')}: ${progress.failed}` : ''}
                        </span>
                        {progress.lastError ? (
                          <span className="max-w-full truncate text-[#FF7474]" title={progress.lastError}>
                            {truncateText(progress.lastError, 90)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {isActive ? (
                    <Callout tone="neutral">{t('lab.runningHint')}</Callout>
                  ) : run.status === 'partial-failure' ? (
                    <Callout tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
                      {t('lab.partialHint')}
                    </Callout>
                  ) : run.status === 'failed' ? (
                    <Callout tone="danger" icon={<XCircle className="h-4 w-4" />}>
                      {run.notes || t('state.failed')}
                    </Callout>
                  ) : run.status === 'completed' ? (
                    <Callout tone="accent" icon={<CheckCircle2 className="h-4 w-4" />}>
                      {t('lab.completedHint')}
                    </Callout>
                  ) : null}

                  {run.notes && run.status !== 'failed' ? (
                    <p className="text-2xs text-lab-faint">{run.notes}</p>
                  ) : null}
                </div>
              </Section>

              {stats && stats.executed > 0 ? (
                <Section title={t('lab.results')}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div>
                      <div className="lab-label">{t('compare.overall')}</div>
                      <div className="font-mono text-xl text-[#B5E94B]">{formatScore(run.overallScore, locale)}</div>
                    </div>
                    <div>
                      <div className="lab-label">{t('compare.successRate')}</div>
                      <div className="font-mono text-xl text-lab-text">
                        {formatNumber(stats.successRate * 100, locale, 0)}%
                      </div>
                    </div>
                    <div>
                      <div className="lab-label">{t('compare.latency')}</div>
                      <div className="font-mono text-xl text-lab-cyan">{formatLatency(stats.avgLatency, locale)}</div>
                    </div>
                    <div>
                      <div className="lab-label">{t('compare.cost')}</div>
                      <div className="font-mono text-xl text-lab-text">
                        {formatCurrencyUsd(run.estimatedCostUsd, locale)}
                      </div>
                      <div className="text-2xs text-lab-faint">{t('misc.estimate')}</div>
                    </div>
                  </div>

                  {Object.keys(run.scores).length > 0 ? (
                    <div className="mt-4 space-y-2.5">
                      {Object.entries(run.scores).map(([dimension, score]) => (
                        <div key={dimension}>
                          <div className="mb-1 flex items-center justify-between text-xs">
                            <DimensionLabel dimension={dimension as never} />
                            <span className="font-mono">{formatScore(score, locale)}</span>
                          </div>
                          <ScoreBar value={score} />
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {run.errorSummary && Object.keys(run.errorSummary).length > 0 ? (
                    <div className="mt-4">
                      <div className="lab-label mb-1">{t('state.partialFailure')}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(run.errorSummary).map(([kind, count]) => (
                          <Pill key={kind} tone="danger">
                            {kind}: {count}
                          </Pill>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {!isActive && run.status !== 'failed' ? (
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-lab-border pt-3">
                      <button
                        type="button"
                        className="lab-btn-secondary text-xs"
                        onClick={createReport}
                        disabled={reportState.loading}
                      >
                        {reportState.loading ? <Spinner /> : <FileText className="h-3.5 w-3.5" aria-hidden="true" />}
                        {t('lab.createReport')}
                      </button>
                      {reportState.publicId ? (
                        <Link to={`/reports/${reportState.publicId}`} className="lab-btn-ghost text-xs text-[#B5E94B]">
                          {t('lab.openReport')}
                        </Link>
                      ) : null}
                      {reportState.error ? (
                        <span className="text-2xs text-[#FF7474]">{reportState.error}</span>
                      ) : null}
                    </div>
                  ) : null}
                </Section>
              ) : null}

              {results.length > 0 ? (
                <Section title={t('lab.results')} description={t('misc.ofTotal', { total: results.length })}>
                  <ul className="max-h-[600px] space-y-2 overflow-y-auto">
                    {results.map((result) => (
                      <li key={result.id} className="rounded-lab border border-lab-border bg-lab-surface p-3">
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <span className="font-mono text-2xs text-lab-faint">{result.externalKey}</span>
                          <Pill tone="neutral">{t(`dimension.${result.dimension}` as never)}</Pill>
                          {result.status === 'scored' ? (
                            <Pill tone={result.score >= 0.75 ? 'accent' : result.score > 0 ? 'warn' : 'danger'}>
                              {formatScore(result.score, locale)}
                            </Pill>
                          ) : (
                            <Pill tone="danger">{t('state.failed')}</Pill>
                          )}
                          {result.latencyMs !== null ? (
                            <span className="text-2xs text-lab-faint">{formatLatency(result.latencyMs, locale)}</span>
                          ) : null}
                        </div>
                        <p className="text-xs leading-relaxed text-lab-text">{result.question}</p>
                        <div className="mt-1.5 space-y-0.5 text-2xs">
                          {result.reference ? (
                            <p className="text-lab-muted">
                              <span className="text-lab-faint">{t('benchmarks.col.reference')}: </span>
                              <span className="font-mono">{truncateText(result.reference, 160)}</span>
                            </p>
                          ) : null}
                          <p className="break-words text-lab-muted">
                            <span className="text-lab-faint">{t('misc.response')}: </span>
                            <span className="font-mono">
                              {truncateText(result.rawResponse ?? result.errorMessage, 320)}
                            </span>
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

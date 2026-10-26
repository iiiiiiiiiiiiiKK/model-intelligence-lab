import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, Download, Lock, Share2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { api, type ApiFailure } from '../lib/api';
import { ErrorState, LoadingBlock } from '../components/ui/States';
import {
  Callout,
  DemoBadge,
  DemoRunBanner,
  DimensionLabel,
  KeyValue,
  PageHeader,
  Pill,
  ScoreBar,
  Section,
  Stat,
  StatusBadge,
} from '../components/ui/Primitives';
import { formatCurrencyUsd, formatDate, formatLatency, formatNumber, formatScore, truncateText } from '../lib/format';
import type { EvaluationResult, Report } from '../../shared/types';

export default function ReportDetailPage() {
  const { publicId = '' } = useParams();
  const { t, locale } = useI18n();
  const [token, setToken] = useState(() => new URLSearchParams(window.location.search).get('token') ?? '');
  const [tokenInput, setTokenInput] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [results, setResults] = useState<EvaluationResult[]>([]);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void api.report(publicId, token || undefined).then((result) => {
      if (!mounted) return;
      if (result.ok) {
        setReport(result.data.report);
        setResults(result.data.results);
        setError(null);
      } else {
        setError(result.error);
      }
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [publicId, token]);

  const copyShare = async () => {
    const url = `${window.location.origin}/reports/${publicId}${token ? `?token=${token}` : ''}`;
    try {
      await navigator.clipboard.writeText(url);
      setFeedback(t('reports.linkCopied'));
      setTimeout(() => setFeedback(null), 2500);
    } catch {
      window.prompt(t('reports.copyLink'), url);
    }
  };

  const exportJson = async () => {
    setActionError(null);
    try {
      const response = await fetch(
        `/api/reports/${encodeURIComponent(publicId)}/export${token ? `?token=${encodeURIComponent(token)}` : ''}`,
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setActionError(body?.error?.message ?? `Export failed (${response.status})`);
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${publicId}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setFeedback(t('action.download'));
      setTimeout(() => setFeedback(null), 2500);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const toggleVisibility = async () => {
    if (!report) return;
    setActionError(null);
    const next = report.visibility === 'public' ? 'private' : 'public';
    const result = await api.updateReport(publicId, { visibility: next }, token || undefined);
    if (result.ok) {
      setReport(result.data.report);
      setFeedback(t('action.saved'));
      setTimeout(() => setFeedback(null), 2500);
    } else {
      setActionError(result.error.message);
    }
  };

  if (loading) return <LoadingBlock />;

  if (error) {
    if (error.code === 'FORBIDDEN') {
      return (
        <div className="space-y-4">
          <Link to="/reports" className="lab-btn-ghost -ml-2 text-xs">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {t('nav.reports')}
          </Link>
          <div className="mx-auto max-w-md">
            <Section title={t('reports.private')}>
              <div className="space-y-3">
                <p className="flex items-center gap-2 text-sm text-lab-text">
                  <Lock className="h-4 w-4 text-[#F3B66D]" aria-hidden="true" />
                  {t('reports.privateNotice')}
                </p>
                <label className="block space-y-1">
                  <span className="lab-label">{t('reports.tokenRequired')}</span>
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={(event) => setTokenInput(event.target.value)}
                    className="lab-input font-mono text-xs"
                    autoComplete="off"
                  />
                </label>
                <button
                  type="button"
                  className="lab-btn-primary w-full text-xs"
                  onClick={() => setToken(tokenInput.trim())}
                  disabled={!tokenInput.trim()}
                >
                  {t('reports.unlock')}
                </button>
              </div>
            </Section>
          </div>
        </div>
      );
    }
    return <ErrorState error={error} />;
  }

  if (!report) return <ErrorState error={{ code: 'NOT_FOUND', message: t('reports.notFound'), status: 404, retryable: false }} />;

  const run = report.run;
  const failures = results.filter((r) => r.status !== 'scored' || r.score < 0.75);

  return (
    <div className="space-y-5">
      <div>
        <Link to="/reports" className="lab-btn-ghost -ml-2 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t('nav.reports')}
        </Link>
      </div>

      <PageHeader
        title={report.title}
        description={`${report.publicId} · ${formatDate(report.createdAt, locale)}`}
        badge={
          <>
            <Pill tone={report.visibility === 'public' ? 'accent' : 'neutral'}>
              {report.visibility === 'public' ? t('reports.public') : t('reports.private')}
            </Pill>
            {run?.isDemo ? <DemoBadge /> : null}
          </>
        }
        actions={
          <>
            <button type="button" className="lab-btn-secondary text-xs" onClick={copyShare}>
              <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t('reports.copyLink')}
            </button>
            <button type="button" className="lab-btn-secondary text-xs" onClick={exportJson}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {t('reports.exportJson')}
            </button>
            <button type="button" className="lab-btn-ghost text-xs" onClick={toggleVisibility}>
              {report.visibility === 'public' ? <Lock className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
              {report.visibility === 'public' ? t('reports.private') : t('reports.public')}
            </button>
          </>
        }
      />

      {feedback ? (
        <p className="text-xs text-[#B5E94B]" role="status">
          {feedback}
        </p>
      ) : null}
      {actionError ? <Callout tone="danger">{actionError}</Callout> : null}
      {run?.isDemo ? <DemoRunBanner /> : null}

      {run ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label={t('compare.overall')}
              value={formatScore(run.overallScore, locale)}
              tone="accent"
              hint={run.benchmarkVersion}
            />
            <Stat
              label={t('compare.samples')}
              value={formatNumber(run.sampleCount, locale)}
              hint={`${t('state.failed')}: ${run.failCount + run.timeoutCount}`}
            />
            <Stat
              label={t('compare.successRate')}
              value={
                run.sampleCount > 0 ? `${formatNumber((run.successCount / run.sampleCount) * 100, locale, 0)}%` : '—'
              }
              tone="cyan"
            />
            <Stat
              label={t('compare.cost')}
              value={formatCurrencyUsd(run.estimatedCostUsd, locale)}
              hint={t('misc.estimate')}
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Section title={t('reports.runInfo')}>
              <dl className="divide-y divide-lab-border/50">
                <KeyValue label={t('misc.model')}>
                  <Link to={`/models/${run.modelId}`} className="lab-link">
                    {run.modelDisplayName}
                  </Link>{' '}
                  <span className="text-2xs text-lab-faint">({run.providerName})</span>
                </KeyValue>
                <KeyValue label={t('modelDetail.benchmarkVersion')}>
                  <span className="font-mono text-xs">{run.benchmarkVersion}</span>
                </KeyValue>
                <KeyValue label={t('misc.status')}>
                  <StatusBadge status={run.status} />
                </KeyValue>
                <KeyValue label={t('lab.temperature')}>
                  <span className="font-mono text-xs">{run.params.temperature}</span>
                </KeyValue>
                <KeyValue label={t('lab.maxTokens')}>
                  <span className="font-mono text-xs">{run.params.maxTokens}</span>
                </KeyValue>
                <KeyValue label={t('lab.timeout')}>
                  <span className="font-mono text-xs">{run.params.timeoutMs} ms</span>
                </KeyValue>
                <KeyValue label={t('lab.systemPrompt')}>
                  {run.params.systemPrompt ? (
                    <span className="font-mono text-2xs">{truncateText(run.params.systemPrompt, 200)}</span>
                  ) : (
                    <span className="text-lab-faint">{t('misc.none')}</span>
                  )}
                </KeyValue>
                <KeyValue label={t('models.versionVerification')}>                  <span className="font-mono text-xs">{run.modelSnapshot.versionVerification}</span>
                </KeyValue>
                <KeyValue label={t('misc.time')}>{formatDate(run.createdAt, locale)}</KeyValue>
              </dl>
            </Section>

            <Section title={t('compare.dimensions')}>
              {Object.keys(run.scores).length === 0 ? (
                <p className="py-6 text-center text-xs text-lab-muted">{t('state.noData')}</p>
              ) : (
                <div className="space-y-3">
                  {Object.entries(run.scores).map(([dimension, score]) => (
                    <div key={dimension}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <DimensionLabel dimension={dimension as never} />
                        <span className="font-mono text-lab-text">{formatScore(score, locale)}</span>
                      </div>
                      <ScoreBar value={score} />
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>

          {failures.length > 0 ? (
            <Section title={t('reports.failureCases')} description={t('misc.ofTotal', { total: failures.length })}>
              <ul className="max-h-[480px] space-y-2 overflow-y-auto">
                {failures.slice(0, 40).map((result) => (
                  <li key={result.id} className="rounded-lab border border-lab-border bg-lab-surface p-3">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="font-mono text-2xs text-lab-faint">{result.externalKey}</span>
                      <DimensionLabel dimension={result.dimension} />
                      <Pill tone={result.status === 'scored' ? 'warn' : 'danger'}>
                        {result.status === 'scored' ? formatScore(result.score, locale) : t('state.failed')}
                      </Pill>
                      <span className="text-2xs text-lab-faint">{formatLatency(result.latencyMs, locale)}</span>
                    </div>
                    <p className="text-xs text-lab-text">{result.question}</p>
                    {result.reference ? (
                      <p className="mt-1 text-2xs text-lab-muted">
                        <span className="text-lab-faint">{t('benchmarks.col.reference')}: </span>
                        <span className="font-mono">{truncateText(result.reference, 200)}</span>
                      </p>
                    ) : null}
                    <p className="mt-1 break-words text-2xs text-lab-muted">
                      <span className="text-lab-faint">{t('misc.response')}: </span>
                      <span className="font-mono">{truncateText(result.rawResponse ?? result.errorMessage, 320)}</span>
                    </p>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title={t('reports.disclaimer')}>
            <p className="text-xs leading-relaxed text-lab-muted">{t('reports.disclaimer')}</p>
            <p className="mt-2 font-mono text-2xs text-lab-faint">
              {t('modelDetail.benchmarkVersion')}: {run.benchmarkVersion} · samples: {run.sampleCount} · items
              included: {results.length}
            </p>
          </Section>
        </>
      ) : (
        <Callout tone="warn">{t('reports.notFound')}</Callout>
      )}
    </div>
  );
}

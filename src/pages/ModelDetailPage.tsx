import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, FlaskConical, Info } from 'lucide-react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { ErrorState, LoadingBlock } from '../components/ui/States';
import {
  Callout,
  KeyValue,
  PageHeader,
  Pill,
  ScoreBar,
  Section,
  Stat,
  StatusBadge,
} from '../components/ui/Primitives';
/** Human labels for the third-party metrics shown on this page. */
const EXTERNAL_METRIC_LABEL: Record<string, string> = {
  'arena-elo': 'Arena Elo',
  'intelligence-index': 'AA Intelligence Index',
  'coding-index': 'AA Coding Index',
  'agentic-index': 'AA Agentic Index',
};

import { TrendChart } from '../components/charts/Charts';
import { formatCurrencyUsd, formatDate, formatLatency, formatNumber, formatScore, truncateText } from '../lib/format';

export default function ModelDetailPage() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const model = useApi(() => api.model(id), [id]);
  const results = useApi(
    () => (model.data?.model.latestRun ? api.runResults(model.data.model.latestRun.id, { limit: 200 }) : Promise.resolve({ ok: true as const, data: { run: null as never, results: [], total: 0 } })),
    [model.data?.model.latestRun?.id],
  );

  if (model.error) return <ErrorState error={model.error} onRetry={model.reload} />;
  if (model.initialLoading || !model.data) return <LoadingBlock />;

  const detail = model.data.model;
  const latest = detail.latestRun;
  const failures = (results.data?.results ?? []).filter((r) => r.status !== 'scored' || r.score < 0.75);

  return (
    <div className="space-y-5">
      <div>
        <Link to="/models" className="lab-btn-ghost -ml-2 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t('nav.models')}
        </Link>
      </div>

      <PageHeader
        title={detail.displayName}
        description={`${detail.providerName} · ${detail.modelId}`}
        badge={
          <Pill
            tone={
              detail.versionVerification === 'verified'
                ? 'accent'
                : detail.versionVerification === 'unverified'
                  ? 'warn'
                  : 'neutral'
            }
          >
            {detail.versionVerification === 'verified'
              ? t('models.versionVerified')
              : detail.versionVerification === 'unverified'
                ? t('models.versionUnverified')
                : t('models.versionUnknown')}
          </Pill>
        }
        actions={
          <>
            <Link to={`/lab?model=${detail.id}`} className="lab-btn-primary text-xs">
              <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
              {t('modelDetail.runOnModel')}
            </Link>
            {latest?.reportId ? (
              <Link to={`/reports`} className="lab-btn-secondary text-xs">
                {t('modelDetail.viewReport')}
              </Link>
            ) : null}
          </>
        }
      />

      {detail.versionVerification !== 'verified' ? (
        <Callout tone="warn" icon={<Info className="h-4 w-4" />}>
          {t('models.versionNote')}
        </Callout>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t('compare.overall')}
          value={formatScore(detail.scoreSummary.overall, locale)}
          hint={latest ? formatDate(latest.createdAt, locale) : t('modelDetail.noRuns')}
          tone={detail.scoreSummary.overall === null ? 'muted' : 'accent'}
        />
        <Stat
          label={t('modelDetail.sampleSize')}
          value={formatNumber(detail.scoreSummary.sampleSize, locale)}
          hint={latest ? `${t('modelDetail.benchmarkVersion')}: ${latest.benchmarkVersion}` : undefined}
        />
        <Stat
          label={t('modelDetail.latency')}
          value={
            latest && latest.successCount > 0
              ? formatLatency(latest.totalLatencyMs / (latest.successCount + latest.failCount + latest.timeoutCount), locale)
              : '—'
          }
          tone="cyan"
        />
        <Stat
          label={t('modelDetail.cost')}
          value={latest ? formatCurrencyUsd(latest.estimatedCostUsd, locale) : '—'}
          hint={t('misc.estimate')}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Section title={t('modelDetail.basicInfo')}>
          <dl className="divide-y divide-lab-border/50">
            <KeyValue label={t('modelDetail.provider')}>{detail.providerName}</KeyValue>
            <KeyValue label={t('modelDetail.modelId')}>
              <span className="font-mono text-xs">{detail.modelId}</span>
            </KeyValue>
            <KeyValue label={t('models.col.status')}>
              <Pill tone={detail.runCount >= 2 ? 'accent' : 'neutral'}>
                {detail.runCount >= 2 ? t('models.status.tracked') : detail.runCount === 1 ? t('models.status.evaluated') : t('models.status.registered')}
              </Pill>
            </KeyValue>
            <KeyValue label={t('modelDetail.knownVersions')}>
              {detail.knownVersions.length > 0 ? (
                <span className="font-mono text-xs">{detail.knownVersions.join(', ')}</span>
              ) : (
                <span className="text-lab-faint">{t('misc.unknown')}</span>
              )}
            </KeyValue>
            <KeyValue label={t('models.col.runs')}>{formatNumber(detail.runCount, locale)}</KeyValue>
            <KeyValue label={t('models.col.lastRun')}>
              {detail.lastEvaluatedAt ? formatDate(detail.lastEvaluatedAt, locale) : t('misc.none')}
            </KeyValue>
          </dl>
        </Section>

        <Section title={t('modelDetail.dimensionScores')} description={latest ? `${t('modelDetail.latestRun')} · ${latest.benchmarkVersion}` : t('modelDetail.noRuns')}>
          {Object.keys(detail.scoreSummary.dimensions).length === 0 ? (
            <p className="py-6 text-center text-xs text-lab-muted">{t('modelDetail.noRuns')}</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(detail.scoreSummary.dimensions).map(([dimension, score]) => (
                <div key={dimension}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-lab-muted">{t(`dimension.${dimension}` as never)}</span>
                    <span className="font-mono text-lab-text">{formatScore(score, locale)}</span>
                  </div>
                  <ScoreBar value={score} />
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      {model.data?.external && (model.data.external.matched || model.data.external.scores.length > 0) ? (
        <Section
          title={t('modelDetail.externalTitle')}
          description={t('modelDetail.externalBody')}
        >
          {(() => {
            const external = model.data!.external!;
            const overall = external.scores.filter((score) => score.category === 'overall');
            const categories = external.scores.filter((score) => score.category !== 'overall');
            if (external.scores.length === 0) {
              return <p className="py-4 text-center text-xs text-lab-muted">{t('modelDetail.noExternal')}</p>;
            }
            return (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone="demo">{t('catalog.externalNote')}</Pill>
                  <span className="font-mono text-2xs text-lab-faint">{external.matched?.modelRef}</span>
                </div>
                <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {overall.map((score) => (
                    <div
                      key={`overall-${score.metric}`}
                      className="rounded-lab border border-lab-border bg-lab-surface px-3 py-2"
                    >
                      <dt className="text-2xs uppercase tracking-wide text-lab-faint">
                        {EXTERNAL_METRIC_LABEL[score.metric] ?? score.metric}
                      </dt>
                      <dd className="mt-1 font-mono text-lg text-[#5DDBCA]">
                        {score.metric === 'arena-elo'
                          ? formatNumber(score.value, locale)
                          : formatNumber(score.value, locale, 1)}
                      </dd>
                      <dd className="text-2xs text-lab-faint">
                        {score.source} · {formatDate(score.observedAt, locale)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {categories.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {categories.slice(0, 12).map((score) => (
                      <Pill key={`cat-${score.metric}-${score.category}`} tone="neutral">
                        {score.category}: {formatNumber(score.value, locale)}
                      </Pill>
                    ))}
                  </div>
                ) : null}
                <p className="text-2xs leading-relaxed text-lab-faint">{external.disclaimer}</p>
              </div>
            );
          })()}
        </Section>
      ) : null}

      <Section title={t('modelDetail.history')} description={t('home.empty.trend')}>
        <TrendChart
          series={[
            {
              modelId: detail.id,
              displayName: detail.displayName,
              points: detail.history.filter((h) => h.overall !== null).map((h) => ({ at: h.createdAt, score: h.overall as number })),
            },
          ]}
        />
      </Section>

      <Section title={t('modelDetail.runs')}>
        {detail.history.length === 0 ? (
          <p className="py-6 text-center text-xs text-lab-muted">{t('modelDetail.noRuns')}</p>
        ) : (
          <div className="lab-scroll -mx-4">
            <table className="lab-table">
              <caption className="sr-only-focusable">{t('modelDetail.runs')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('misc.time')}</th>
                  <th scope="col">{t('modelDetail.benchmarkVersion')}</th>
                  <th scope="col">{t('misc.status')}</th>
                  <th scope="col" className="text-right">{t('compare.overall')}</th>
                  <th scope="col" className="text-right">{t('misc.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.history
                  .slice()
                  .reverse()
                  .map((entry) => (
                    <tr key={entry.runId}>
                      <td className="whitespace-nowrap text-xs text-lab-muted">{formatDate(entry.createdAt, locale)}</td>
                      <td className="font-mono text-xs text-lab-muted">{entry.benchmarkVersion}</td>
                      <td>
                        <StatusBadge status={entry.status} />
                      </td>
                      <td className="text-right font-mono text-xs">{formatScore(entry.overall, locale)}</td>
                      <td className="text-right">
                        <Link to={`/lab?run=${entry.runId}`} className="lab-btn-ghost px-2 text-2xs">
                          {t('action.details')}
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </Link>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title={t('modelDetail.failureCases')}
        description={latest ? `${t('modelDetail.latestRun')} · ${t('misc.ofTotal', { total: results.data?.results.length ?? 0 })}` : undefined}
      >
        {failures.length === 0 ? (
          <p className="py-6 text-center text-xs text-lab-muted">{t('modelDetail.noFailures')}</p>
        ) : (
          <ul className="space-y-2">
            {failures.slice(0, 10).map((failure) => (
              <li key={failure.id} className="rounded-lab border border-lab-border bg-lab-surface p-3">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-2xs text-lab-faint">{failure.externalKey}</span>
                  <Pill tone="neutral">{t(`dimension.${failure.dimension}` as never)}</Pill>
                  <Pill tone={failure.status === 'scored' ? 'warn' : 'danger'}>
                    {failure.status === 'scored' ? formatScore(failure.score, locale) : t('state.failed')}
                  </Pill>
                </div>
                <p className="text-xs text-lab-text">{failure.question}</p>
                {failure.reference ? (
                  <p className="mt-1.5 text-2xs text-lab-muted">
                    <span className="text-lab-faint">{t('benchmarks.col.reference')}: </span>
                    <span className="font-mono">{truncateText(failure.reference, 200)}</span>
                  </p>
                ) : null}
                <p className="mt-1 break-words text-2xs text-lab-muted">
                  <span className="text-lab-faint">{t('misc.response')}: </span>
                  <span className="font-mono">{truncateText(failure.rawResponse ?? failure.errorMessage, 300)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

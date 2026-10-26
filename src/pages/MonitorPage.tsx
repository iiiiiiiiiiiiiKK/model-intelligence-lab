import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, FlaskConical, Play, ShieldAlert } from 'lucide-react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { EmptyState, ErrorState, LoadingBlock, SkeletonRows } from '../components/ui/States';
import {
  Callout,
  ConclusionBadge,
  DimensionLabel,
  KeyValue,
  PageHeader,
  Pill,
  ScoreBar,
  Section,
  Stat,
} from '../components/ui/Primitives';
import { ComparisonBars } from '../components/charts/Charts';
import {
  formatDate,
  formatNumber,
  formatPercent,
  formatScore,
  formatSigned,
} from '../lib/format';
import type { RegressionReport } from '../../shared/types';

export default function MonitorPage() {
  const { t, locale } = useI18n();
  const models = useApi(() => api.models({ status: 'evaluated' }), []);
  const events = useApi(() => api.regressionEvents(50), []);

  const [modelId, setModelId] = useState('');
  const [baselineRunId, setBaselineRunId] = useState('');
  const [comparisonRunId, setComparisonRunId] = useState('');
  const [report, setReport] = useState<RegressionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const candidates = useApi(
    () => (modelId ? api.regressionCandidates(modelId) : Promise.resolve({ ok: true as const, data: { runs: [] } })),
    [modelId],
  );

  const evaluatedModels = useMemo(() => (models.data?.models ?? []).filter((m) => m.runCount > 0), [models.data]);

  useEffect(() => {
    if (modelId || evaluatedModels.length === 0) return;
    setModelId(evaluatedModels[0].id);
  }, [evaluatedModels, modelId]);

  // Preselect the two most recent runs so the page is useful immediately.
  useEffect(() => {
    const runs = candidates.data?.runs ?? [];
    if (runs.length >= 2 && !baselineRunId && !comparisonRunId) {
      setComparisonRunId(runs[0].id);
      setBaselineRunId(runs[1].id);
    }
  }, [candidates.data, baselineRunId, comparisonRunId]);

  useEffect(() => {
    setBaselineRunId('');
    setComparisonRunId('');
    setReport(null);
    setError(null);
  }, [modelId]);

  const runComparison = async () => {
    if (!baselineRunId || !comparisonRunId) return;
    setLoading(true);
    setError(null);
    const result = await api.compareRuns(baselineRunId, comparisonRunId);
    if (result.ok) setReport(result.data.report);
    else setError(result.error.message);
    setLoading(false);
  };

  const runs = candidates.data?.runs ?? [];
  const modelEvents = (events.data?.events ?? []).filter((event) => (modelId ? event.modelId === modelId : true));

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('monitor.title')}
        description={t('monitor.subtitle')}
        actions={
          <Link to="/lab" className="lab-btn-secondary text-xs">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
            {t('action.runEvaluation')}
          </Link>
        }
      />

      <Callout tone="warn" icon={<ShieldAlert className="h-4 w-4" />}>
        {t('monitor.caveat')}
      </Callout>

      <Section title={t('monitor.selectModel')}>
        {models.error ? (
          <ErrorState error={models.error} onRetry={models.reload} />
        ) : models.initialLoading ? (
          <LoadingBlock />
        ) : evaluatedModels.length === 0 ? (
          <EmptyState
            title={t('monitor.noBaseline')}
            description={t('monitor.needTwoRuns')}
            action={
              <Link to="/lab" className="lab-btn-primary text-xs">
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                {t('monitor.noBaselineCta')}
              </Link>
            }
          />
        ) : (
          <div className="space-y-3">
            <label className="block space-y-1.5">
              <span className="lab-label">{t('monitor.selectModel')}</span>
              <select
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                className="lab-input text-sm sm:max-w-sm"
              >
                {evaluatedModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName} · {model.providerName} ({model.runCount} runs)
                  </option>
                ))}
              </select>
            </label>

            {runs.length < 2 ? (
              <Callout tone="neutral">
                {t('monitor.needTwoRuns')}{' '}
                <Link to="/lab" className="lab-link">
                  {t('monitor.noBaselineCta')}
                </Link>
              </Callout>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1.5">
                  <span className="lab-label">{t('monitor.selectBaseline')}</span>
                  <select
                    value={baselineRunId}
                    onChange={(event) => setBaselineRunId(event.target.value)}
                    className="lab-input font-mono text-xs"
                  >
                    <option value="">{t('lab.selectPlaceholder')}</option>
                    {runs.map((run) => (
                      <option key={run.id} value={run.id}>
                        {formatDate(run.createdAt, locale)} · {run.benchmarkVersion} · {formatScore(run.overallScore, locale)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1.5">
                  <span className="lab-label">{t('monitor.selectComparison')}</span>
                  <select
                    value={comparisonRunId}
                    onChange={(event) => setComparisonRunId(event.target.value)}
                    className="lab-input font-mono text-xs"
                  >
                    <option value="">{t('lab.selectPlaceholder')}</option>
                    {runs.map((run) => (
                      <option key={run.id} value={run.id}>
                        {formatDate(run.createdAt, locale)} · {run.benchmarkVersion} · {formatScore(run.overallScore, locale)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <button
              type="button"
              className="lab-btn-primary text-xs"
              onClick={runComparison}
              disabled={loading || !baselineRunId || !comparisonRunId || baselineRunId === comparisonRunId}
            >
              <Activity className="h-3.5 w-3.5" aria-hidden="true" />
              {loading ? t('monitor.running') : t('monitor.runComparison')}
            </button>

            {baselineRunId && comparisonRunId && baselineRunId === comparisonRunId ? (
              <p className="text-2xs text-[#F3B66D]">{t('monitor.selectComparison')} ≠ {t('monitor.selectBaseline')}</p>
            ) : null}

            {error ? <Callout tone="danger">{error}</Callout> : null}
          </div>
        )}
      </Section>

      {report ? (
        <>
          {!report.comparable ? (
            <Callout tone="warn" title={t('monitor.notComparableReason')}>
              <div className="flex flex-wrap gap-1.5">
                {report.comparabilityIssues.map((issue) => (
                  <Pill key={issue} tone="warn">
                    {issue}
                  </Pill>
                ))}
              </div>
            </Callout>
          ) : null}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label={t('monitor.baselineScore')}
              value={formatScore(report.overall.baselineScore, locale)}
              tone="cyan"
              hint={formatDate(
                runs.find((r) => r.id === baselineRunId)?.createdAt ?? null,
                locale,
              )}
            />
            <Stat
              label={t('monitor.currentScore')}
              value={formatScore(report.overall.currentScore, locale)}
              tone="accent"
              hint={formatDate(
                runs.find((r) => r.id === comparisonRunId)?.createdAt ?? null,
                locale,
              )}
            />
            <Stat
              label={t('monitor.delta')}
              value={formatSigned(report.overall.delta, locale)}
              tone={report.overall.delta < 0 ? 'danger' : report.overall.delta > 0 ? 'accent' : 'muted'}
              hint={
                report.overall.relativeDelta !== null
                  ? `${t('monitor.relativeDelta')}: ${formatPercent(report.overall.relativeDelta, locale)}`
                  : undefined
              }
            />
            <Stat
              label={t('monitor.sampleSize')}
              value={formatNumber(report.overall.sampleSize, locale)}
              hint={`${t('monitor.pValue')}: ${report.overall.pValue === null ? '—' : report.overall.pValue.toFixed(4)}`}
            />
          </div>

          <Section title={t('monitor.conclusion')}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <ConclusionBadge conclusion={report.overall.conclusion} large />
                <span className="text-2xs text-lab-faint">{report.benchmarkVersion}</span>
              </div>
              <dl className="divide-y divide-lab-border/50">
                <KeyValue label={t('monitor.method')}>{report.overall.method}</KeyValue>
                <KeyValue label={t('monitor.threshold')}>α = 0.05 (Holm-corrected across dimensions)</KeyValue>
                <KeyValue label={t('monitor.confidenceInterval')}>
                  {report.overall.confidenceInterval
                    ? `[${formatScore(report.overall.confidenceInterval[0], locale)}, ${formatScore(report.overall.confidenceInterval[1], locale)}]`
                    : t('misc.na')}
                </KeyValue>
                <KeyValue label={t('monitor.discordant')}>
                  {report.overall.counts ? (
                    <div className="flex flex-wrap gap-1.5">
                      <Pill tone="accent">
                        {t('monitor.bothCorrect')}: {report.overall.counts.bothCorrect}
                      </Pill>
                      <Pill tone="danger">
                        {t('monitor.baselineOnly')}: {report.overall.counts.baselineOnlyCorrect}
                      </Pill>
                      <Pill tone="cyan">
                        {t('monitor.comparisonOnly')}: {report.overall.counts.comparisonOnlyCorrect}
                      </Pill>
                      <Pill tone="neutral">
                        {t('monitor.bothIncorrect')}: {report.overall.counts.bothIncorrect}
                      </Pill>
                    </div>
                  ) : (
                    t('misc.na')
                  )}
                </KeyValue>
                <KeyValue label={t('monitor.caveat')}>
                  <span className="text-2xs text-lab-muted">{t('misc.disclaimerShort')}</span>
                </KeyValue>
              </dl>
            </div>
          </Section>

          <div className="grid gap-5 xl:grid-cols-2">
            <Section title={t('monitor.dimensionBreakdown')}>
              <div className="lab-scroll -mx-4">
                <table className="lab-table text-xs">
                  <caption className="sr-only-focusable">{t('monitor.dimensionBreakdown')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('misc.dimension')}</th>
                      <th scope="col" className="text-right">{t('monitor.baselineScore')}</th>
                      <th scope="col" className="text-right">{t('monitor.currentScore')}</th>
                      <th scope="col" className="text-right">{t('monitor.delta')}</th>
                      <th scope="col" className="text-right">p</th>
                      <th scope="col" className="text-right">{t('monitor.conclusion')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.dimensions.map((entry) => (
                      <tr key={entry.dimension ?? 'overall'}>
                        <th scope="row" className="px-3 py-2 text-left text-xs font-normal text-lab-muted">
                          <DimensionLabel dimension={entry.dimension} />
                        </th>
                        <td className="text-right font-mono text-lab-muted">{formatScore(entry.baselineScore, locale)}</td>
                        <td className="text-right font-mono">{formatScore(entry.currentScore, locale)}</td>
                        <td
                          className={`text-right font-mono ${
                            entry.delta < 0 ? 'text-[#FF7474]' : entry.delta > 0 ? 'text-[#B5E94B]' : 'text-lab-muted'
                          }`}
                        >
                          {formatSigned(entry.delta, locale)}
                        </td>
                        <td className="text-right font-mono text-lab-muted">
                          {entry.adjustedPValue !== null
                            ? entry.adjustedPValue.toFixed(4)
                            : entry.pValue !== null
                              ? entry.pValue.toFixed(4)
                              : '—'}
                        </td>
                        <td className="text-right">
                          <ConclusionBadge conclusion={entry.conclusion} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section title={t('monitor.dimensionBreakdown')}>
              <ComparisonBars
                baseline={Object.fromEntries(report.dimensions.filter((d) => d.dimension).map((d) => [d.dimension as string, d.baselineScore]))}
                current={Object.fromEntries(report.dimensions.filter((d) => d.dimension).map((d) => [d.dimension as string, d.currentScore]))}
                baselineLabel={t('monitor.baseline')}
                currentLabel={t('monitor.latest')}
              />
            </Section>
          </div>

          {report.dimensions.some((d) => d.conclusion === 'significant-regression') ? (
            <Section title={t('monitor.failureCases')}>
              <ul className="space-y-1.5">
                {report.dimensions
                  .filter((d) => d.conclusion === 'significant-regression')
                  .map((entry) => (
                    <li
                      key={entry.dimension ?? 'overall'}
                      className="flex items-center justify-between gap-3 rounded-lab border border-lab-border bg-lab-surface px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <DimensionLabel dimension={entry.dimension} />
                        <span className="text-2xs text-lab-faint">
                          {entry.counts ? `${entry.counts.baselineOnlyCorrect} / ${entry.sampleSize}` : ''}
                        </span>
                      </div>
                      <span className="font-mono text-xs text-[#FF7474]">{formatSigned(entry.delta, locale)}</span>
                    </li>
                  ))}
              </ul>
            </Section>
          ) : null}
        </>
      ) : null}

      <Section title={t('monitor.eventHistory')} description={t('monitor.alertNote')}>
        {events.error ? (
          <ErrorState error={events.error} onRetry={events.reload} compact />
        ) : events.initialLoading ? (
          <SkeletonRows rows={3} />
        ) : modelEvents.length === 0 ? (
          <EmptyState title={t('monitor.noEvents')} description={t('monitor.needTwoRuns')} />
        ) : (
          <div className="lab-scroll -mx-4">
            <table className="lab-table text-xs">
              <caption className="sr-only-focusable">{t('monitor.eventHistory')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('misc.time')}</th>
                  <th scope="col">{t('misc.model')}</th>
                  <th scope="col">{t('misc.dimension')}</th>
                  <th scope="col" className="text-right">{t('monitor.delta')}</th>
                  <th scope="col" className="text-right">n</th>
                  <th scope="col" className="text-right">{t('monitor.conclusion')}</th>
                </tr>
              </thead>
              <tbody>
                {modelEvents.slice(0, 20).map((event) => (
                  <tr key={event.id}>
                    <td className="whitespace-nowrap text-lab-muted">{formatDate(event.createdAt, locale)}</td>
                    <td className="truncate text-lab-text">{event.modelDisplayName}</td>
                    <td className="text-lab-muted">
                      <DimensionLabel dimension={event.dimension} />
                    </td>
                    <td
                      className={`text-right font-mono ${
                        event.delta < 0 ? 'text-[#FF7474]' : event.delta > 0 ? 'text-[#B5E94B]' : 'text-lab-muted'
                      }`}
                    >
                      {formatSigned(event.delta, locale)}
                    </td>
                    <td className="text-right font-mono text-lab-muted">{event.sampleSize}</td>
                    <td className="text-right">
                      <ConclusionBadge conclusion={event.conclusion} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {report ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {[report.overall, ...report.dimensions.filter((d) => d.dimension)].slice(0, 2).map((entry) => (
            <div key={entry.dimension ?? 'overall'} className="lab-card p-3">
              <div className="mb-1 flex items-center justify-between">
                <DimensionLabel dimension={entry.dimension} />
                <span className="font-mono text-2xs text-lab-faint">{formatScore(entry.currentScore, locale)}</span>
              </div>
              <ScoreBar value={entry.currentScore} compare={entry.baselineScore} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

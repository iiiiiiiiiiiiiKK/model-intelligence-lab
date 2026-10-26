import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, GitCompare, FlaskConical } from 'lucide-react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { EmptyState, ErrorState, LoadingBlock, SkeletonRows } from '../components/ui/States';
import { Callout, ConclusionBadge, PageHeader, Pill, Section, StatusBadge } from '../components/ui/Primitives';
import { ComparisonBars } from '../components/charts/Charts';
import { formatCurrencyUsd, formatDate, formatLatency, formatNumber, formatPercent, formatScore } from '../lib/format';
import type { RegressionReport } from '../../shared/types';

export default function ComparePage() {
  const { t, locale } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const runs = useApi(() => api.runs({ limit: 50 }), []);

  const initialIds = useMemo(() => {
    const raw = searchParams.get('runs');
    return raw ? raw.split(',').filter(Boolean) : [];
  }, [searchParams]);

  const [selected, setSelected] = useState<string[]>(initialIds);
  const [pairwise, setPairwise] = useState<RegressionReport | null>(null);
  const [pairwiseError, setPairwiseError] = useState<string | null>(null);
  const [pairwiseLoading, setPairwiseLoading] = useState(false);

  const availableRuns = runs.data?.runs ?? [];

  useEffect(() => {
    if (selected.length > 0) {
      setSearchParams({ runs: selected.join(',') }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  }, [selected, setSearchParams]);

  const comparison = useApi(
    () => (selected.length >= 2 ? api.compare(selected) : Promise.resolve({ ok: true as const, data: { entries: [], items: [], alignmentNotes: [] } })),
    [selected.join(',')],
  );

  const toggleRun = (runId: string) => {
    setSelected((previous) => {
      if (previous.includes(runId)) return previous.filter((id) => id !== runId);
      if (previous.length >= 4) return previous;
      return [...previous, runId];
    });
    setPairwise(null);
    setPairwiseError(null);
  };

  const runPairwise = async () => {
    if (selected.length < 2) return;
    setPairwiseLoading(true);
    setPairwiseError(null);
    const result = await api.pairwise(selected[0], selected[1]);
    if (result.ok) setPairwise(result.data.report);
    else setPairwiseError(result.error.message);
    setPairwiseLoading(false);
  };

  const entries = comparison.data?.entries ?? [];
  const hasIncomparable = entries.some((entry) => !entry.comparable);

  return (
    <div className="space-y-5">
      <PageHeader title={t('compare.title')} description={t('compare.subtitle')} />

      <Section
        title={t('compare.selectRuns')}
        description={t('misc.ofTotal', { total: availableRuns.length })}
      >
        {runs.error ? (
          <ErrorState error={runs.error} onRetry={runs.reload} />
        ) : runs.initialLoading ? (
          <SkeletonRows rows={3} />
        ) : availableRuns.length === 0 ? (
          <EmptyState
            title={t('compare.noRuns')}
            action={
              <Link to="/lab" className="lab-btn-primary text-xs">
                <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
                {t('action.runEvaluation')}
              </Link>
            }
          />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {availableRuns.slice(0, 24).map((run) => {
              const isSelected = selected.includes(run.id);
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => toggleRun(run.id)}
                    aria-pressed={isSelected}
                    className={`w-full rounded-lab border px-3 py-2.5 text-left transition-colors duration-fast ${
                      isSelected
                        ? 'border-[#B5E94B]/50 bg-[#B5E94B]/10'
                        : 'border-lab-border bg-lab-surface hover:border-lab-border-strong hover:bg-lab-hover'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium text-lab-text">{run.modelDisplayName}</span>
                      <StatusBadge status={run.status} />
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-2xs text-lab-faint">
                      <span className="truncate font-mono">{run.benchmarkVersion}</span>
                      <span className="shrink-0 font-mono text-lab-text">{formatScore(run.overallScore, locale)}</span>
                    </div>
                    <div className="mt-0.5 text-2xs text-lab-faint">{formatDate(run.createdAt, locale)}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {selected.length > 0 && selected.length < 2 ? (
          <p className="mt-3 text-xs text-lab-muted">{t('compare.needTwo')}</p>
        ) : null}
      </Section>

      {hasIncomparable ? (
        <Callout tone="warn" title={t('compare.notComparable')} icon={<AlertTriangle className="h-4 w-4" />}>
          <ul className="list-inside list-disc space-y-0.5">
            {(comparison.data?.alignmentNotes ?? []).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {comparison.error ? <ErrorState error={comparison.error} onRetry={comparison.reload} /> : null}

      {entries.length >= 2 ? (
        <>
          <Section title={t('compare.dimensions')}>
            <div className="lab-scroll -mx-4">
              <table className="lab-table">
                <caption className="sr-only-focusable">{t('compare.dimensions')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('misc.dimension')}</th>
                    {entries.map((entry, index) => (
                      <th key={entry.runId} scope="col" className="text-right">
                        <span className="block max-w-[140px] truncate">{entry.modelDisplayName}</span>
                        <span className="mt-0.5 block text-[10px] font-normal normal-case text-lab-faint">
                          {t('compare.column', { index: index + 1 })} · {entry.benchmarkVersion}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-lab-raised/40">
                    <th scope="row" className="px-3 py-2.5 text-left text-xs font-medium text-lab-text">
                      {t('compare.overall')}
                    </th>
                    {entries.map((entry) => (
                      <td key={entry.runId} className="text-right font-mono text-sm text-[#B5E94B]">
                        {formatScore(entry.overallScore, locale)}
                      </td>
                    ))}
                  </tr>
                  {[...new Set(entries.flatMap((entry) => Object.keys(entry.dimensions)))].map((dimension) => (
                    <tr key={dimension}>
                      <th scope="row" className="px-3 py-2 text-left text-xs font-normal text-lab-muted">
                        {t(`dimension.${dimension}` as never)}
                      </th>
                      {entries.map((entry) => (
                        <td key={entry.runId} className="text-right font-mono text-xs text-lab-text">
                          {entry.dimensions[dimension] !== undefined ? formatScore(entry.dimensions[dimension], locale) : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <th scope="row" className="px-3 py-2 text-left text-xs font-normal text-lab-muted">
                      {t('compare.successRate')}
                    </th>
                    {entries.map((entry) => (
                      <td key={entry.runId} className="text-right font-mono text-xs text-lab-text">
                        {formatPercent(entry.successRate, locale)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row" className="px-3 py-2 text-left text-xs font-normal text-lab-muted">
                      {t('compare.errorRate')}
                    </th>
                    {entries.map((entry) => (
                      <td key={entry.runId} className="text-right font-mono text-xs text-lab-text">
                        {formatPercent(entry.errorRate, locale)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row" className="px-3 py-2 text-left text-xs font-normal text-lab-muted">
                      {t('compare.latency')}
                    </th>
                    {entries.map((entry) => (
                      <td key={entry.runId} className="text-right font-mono text-xs text-lab-text">
                        {formatLatency(entry.avgLatencyMs, locale)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row" className="px-3 py-2 text-left text-xs font-normal text-lab-muted">
                      {t('compare.cost')}
                    </th>
                    {entries.map((entry) => (
                      <td key={entry.runId} className="text-right font-mono text-xs text-lab-text">
                        {formatCurrencyUsd(entry.totalCostUsd, locale)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row" className="px-3 py-2 text-left text-xs font-normal text-lab-muted">
                      {t('compare.samples')}
                    </th>
                    {entries.map((entry) => (
                      <td key={entry.runId} className="text-right font-mono text-xs text-lab-muted">
                        {formatNumber(entry.sampleCount, locale)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row" className="px-3 py-2 text-left text-xs font-normal text-lab-muted">
                      {t('compare.alignmentNotes')}
                    </th>
                    {entries.map((entry) => (
                      <td key={entry.runId} className="text-right">
                        {entry.comparable ? (
                          <Pill tone="accent">{t('misc.yes')}</Pill>
                        ) : (
                          <Pill tone="warn">{entry.comparabilityIssues.join(', ')}</Pill>
                        )}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>

          <div className="grid gap-5 xl:grid-cols-2">
            <Section title={t('compare.dimensions')}>
              <ComparisonBars
                baseline={entries[0]?.dimensions ?? {}}
                current={entries[1]?.dimensions ?? {}}
                baselineLabel={entries[0]?.modelDisplayName ?? ''}
                currentLabel={entries[1]?.modelDisplayName ?? ''}
              />
            </Section>

            <Section
              title={t('compare.pairwise')}
              description={`${t('compare.selectBaseline')}: ${entries[0]?.modelDisplayName ?? ''} → ${t('compare.selectComparison')}: ${entries[1]?.modelDisplayName ?? ''}`}
            >
              <div className="space-y-3">
                <button
                  type="button"
                  className="lab-btn-primary text-xs"
                  onClick={runPairwise}
                  disabled={pairwiseLoading || selected.length < 2}
                >
                  <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
                  {pairwiseLoading ? t('monitor.running') : t('compare.runTest')}
                </button>

                {pairwiseError ? <Callout tone="danger">{pairwiseError}</Callout> : null}

                {pairwise ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <ConclusionBadge conclusion={pairwise.overall.conclusion} large />
                      <span className="font-mono text-xs text-lab-muted">
                        Δ {formatScore(pairwise.overall.delta, locale)} · n={pairwise.overall.sampleSize}
                      </span>
                    </div>
                    {pairwise.comparabilityIssues.length > 0 ? (
                      <Callout tone="warn">{pairwise.comparabilityIssues.join(', ')}</Callout>
                    ) : null}
                    <table className="lab-table text-xs">
                      <thead>
                        <tr>
                          <th scope="col">{t('misc.dimension')}</th>
                          <th scope="col" className="text-right">{t('monitor.delta')}</th>
                          <th scope="col" className="text-right">{t('monitor.pValue')}</th>
                          <th scope="col" className="text-right">{t('monitor.conclusion')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pairwise.dimensions.map((entry) => (
                          <tr key={entry.dimension ?? 'overall'}>
                            <td>{entry.dimension ? t(`dimension.${entry.dimension}` as never) : t('misc.total')}</td>
                            <td className={`text-right font-mono ${entry.delta < 0 ? 'text-[#FF7474]' : entry.delta > 0 ? 'text-[#B5E94B]' : ''}`}>
                              {formatScore(entry.delta, locale)}
                            </td>
                            <td className="text-right font-mono text-lab-muted">
                              {entry.pValue === null ? '—' : entry.pValue.toFixed(4)}
                            </td>
                            <td className="text-right">
                              <ConclusionBadge conclusion={entry.conclusion} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            </Section>
          </div>

          <Section title={t('compare.perItem')} description={t('misc.ofTotal', { total: comparison.data?.items.length ?? 0 })}>
            {comparison.loading && !comparison.data ? (
              <LoadingBlock />
            ) : (
              <div className="lab-scroll -mx-4 max-h-[560px] overflow-y-auto">
                <table className="lab-table text-xs">
                  <caption className="sr-only-focusable">{t('compare.perItem')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('benchmarks.col.key')}</th>
                      <th scope="col">{t('misc.dimension')}</th>
                      <th scope="col">{t('misc.question')}</th>
                      {entries.map((entry) => (
                        <th key={entry.runId} scope="col" className="text-right">
                          <span className="block max-w-[110px] truncate">{entry.modelDisplayName}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(comparison.data?.items ?? []).slice(0, 200).map((item) => (
                      <tr key={item.itemId}>
                        <td className="whitespace-nowrap font-mono text-2xs text-lab-faint">{item.itemId}</td>
                        <td className="whitespace-nowrap text-2xs text-lab-muted">{t(`dimension.${item.dimension}` as never)}</td>
                        <td className="max-w-[360px] text-2xs text-lab-muted">
                          <span className="line-clamp-2">{item.question}</span>
                        </td>
                        {entries.map((entry) => {
                          const value = item.results[entry.runId];
                          return (
                            <td key={entry.runId} className="text-right">
                              {!value ? (
                                <span className="text-lab-faint">—</span>
                              ) : value.status !== 'scored' ? (
                                <Pill tone="danger">{t('state.failed')}</Pill>
                              ) : (
                                <span
                                  className={`font-mono ${
                                    value.score >= 0.75 ? 'text-[#B5E94B]' : value.score > 0 ? 'text-[#F3B66D]' : 'text-[#FF7474]'
                                  }`}
                                >
                                  {formatScore(value.score, locale, 2)}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      ) : null}
    </div>
  );
}

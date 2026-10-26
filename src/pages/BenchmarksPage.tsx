import { useMemo, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FileUp, Info } from 'lucide-react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { EmptyState, ErrorState, LoadingBlock, SkeletonRows } from '../components/ui/States';
import {
  Callout,
  DemoBadge,
  DimensionLabel,
  PageHeader,
  Pill,
  ScorerLabel,
  Section,
} from '../components/ui/Primitives';
import { formatDate, formatNumber, truncateText } from '../lib/format';
import type { BenchmarkItem } from '../../shared/types';

export default function BenchmarksPage() {
  const { t, locale } = useI18n();
  const benchmarks = useApi(() => api.benchmarks(), []);
  const [activeId, setActiveId] = useState<string>('');
  const [dimensionFilter, setDimensionFilter] = useState<string>('');

  const list = useMemo(() => benchmarks.data?.benchmarks ?? [], [benchmarks.data]);
  const active = useMemo(() => {
    if (list.length === 0) return null;
    return list.find((b) => b.id === activeId) ?? list[0];
  }, [list, activeId]);

  const detail = useApi(
    () => (active ? api.benchmark(active.id) : Promise.resolve({ ok: true as const, data: { benchmark: null as never, items: [] } })),
    [active?.id],
  );

  const items: BenchmarkItem[] = detail.data?.items ?? [];
  const filtered = dimensionFilter ? items.filter((item) => item.dimension === dimensionFilter) : items;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('benchmarks.title')}
        description={t('benchmarks.subtitle')}
        actions={<Pill tone="neutral">{t('benchmarks.scorerNote')}</Pill>}
      />

      {benchmarks.error ? (
        <ErrorState error={benchmarks.error} onRetry={benchmarks.reload} />
      ) : benchmarks.initialLoading ? (
        <SkeletonRows rows={3} />
      ) : list.length === 0 ? (
        <div className="lab-card">
          <EmptyState title={t('benchmarks.empty')} icon={<BookOpen className="h-5 w-5" />} />
        </div>
      ) : (
        <>
          <Section title={t('benchmarks.list')} description={t('misc.ofTotal', { total: list.length })}>
            <div className="space-y-2">
              {list.map((benchmark) => {
                const isActive = benchmark.id === active?.id;
                return (
                  <button
                    key={benchmark.id}
                    type="button"
                    onClick={() => {
                      setActiveId(benchmark.id);
                      setDimensionFilter('');
                    }}
                    aria-expanded={isActive}
                    className={`w-full rounded-lab border px-3.5 py-3 text-left transition-colors duration-fast ${
                      isActive
                        ? 'border-[#B5E94B]/40 bg-[#B5E94B]/[0.06]'
                        : 'border-lab-border bg-lab-surface hover:bg-lab-hover'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {isActive ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#B5E94B]" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-lab-faint" aria-hidden="true" />
                          )}
                          <span className="text-sm font-medium text-lab-text">{benchmark.name}</span>
                          {benchmark.isDemo ? <DemoBadge /> : null}
                          <Pill tone={benchmark.visibility === 'public' ? 'accent' : 'neutral'}>
                            {benchmark.visibility === 'public' ? t('reports.public') : t('reports.private')}
                          </Pill>
                        </div>
                        <p className="line-clamp-2 pl-5 text-xs leading-relaxed text-lab-muted">
                          {benchmark.description}
                        </p>
                      </div>
                      <div className="shrink-0 space-y-1 text-right">
                        <div className="font-mono text-sm text-lab-text">{formatNumber(benchmark.itemCount, locale)}</div>
                        <div className="font-mono text-2xs text-lab-faint">v{benchmark.currentVersion ?? '—'}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </Section>

          {active ? (
            <>
              <Section
                title={t('benchmarks.versions')}
                description={`${active.name} · ${t('benchmarks.col.source')}: model-lab-first-party`}
              >
                <div className="lab-scroll -mx-4">
                  <table className="lab-table text-xs">
                    <caption className="sr-only-focusable">{t('benchmarks.versions')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('benchmarks.col.version')}</th>
                        <th scope="col">{t('benchmarks.col.items')}</th>
                        <th scope="col">{t('benchmarks.col.dimensions')}</th>
                        <th scope="col">{t('misc.status')}</th>
                        <th scope="col">{t('reports.col.created')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {active.versions.map((version) => (
                        <tr key={version.id}>
                          <td className="font-mono">
                            v{version.version}
                            {version.id === active.currentVersionId ? (
                              <Pill tone="accent" className="ml-2">
                                {t('benchmarks.published')}
                              </Pill>
                            ) : null}
                          </td>
                          <td className="font-mono">{formatNumber(version.itemCount, locale)}</td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {Object.entries(version.dimensionCounts).map(([dimension, count]) => (
                                <Pill key={dimension} tone="neutral">
                                  {t(`dimension.${dimension}` as never)} {count}
                                </Pill>
                              ))}
                            </div>
                          </td>
                          <td>
                            <Pill tone={version.published ? 'accent' : 'muted'}>
                              {version.published ? t('benchmarks.published') : t('benchmarks.unpublished')}
                            </Pill>
                          </td>
                          <td className="whitespace-nowrap text-lab-muted">{formatDate(version.createdAt, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <Callout tone="neutral" icon={<Info className="h-4 w-4" />}>
                    {t('benchmarks.importHint')}
                  </Callout>
                  <Callout tone="warn">
                    {t('benchmarks.scorerNote')} {t('settings.notImplemented')}: LLM judge and human review scorers
                    are defined in the scoring interface but no reviewer workflow is wired up, so items using them
                    score 0 by default.
                  </Callout>
                </div>
              </Section>

              <Section
                title={t('benchmarks.items')}
                description={t('misc.ofTotal', { total: filtered.length })}
                actions={
                  <label className="flex items-center gap-1.5">
                    <span className="lab-label">{t('benchmarks.filterDimension')}</span>
                    <select
                      value={dimensionFilter}
                      onChange={(event) => setDimensionFilter(event.target.value)}
                      className="lab-input w-auto appearance-none py-1 text-2xs"
                    >
                      <option value="">{t('misc.all')}</option>
                      {(benchmarks.data?.dimensions ?? []).map((dimension) => (
                        <option key={dimension} value={dimension}>
                          {t(`dimension.${dimension}` as never)}
                        </option>
                      ))}
                    </select>
                  </label>
                }
              >
                {detail.error ? (
                  <ErrorState error={detail.error} onRetry={detail.reload} compact />
                ) : detail.initialLoading ? (
                  <LoadingBlock />
                ) : filtered.length === 0 ? (
                  <EmptyState title={t('benchmarks.emptyItems')} />
                ) : (
                  <div className="lab-scroll -mx-4 max-h-[720px] overflow-y-auto">
                    <table className="lab-table text-xs">
                      <caption className="sr-only-focusable">{t('benchmarks.items')}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('benchmarks.col.key')}</th>
                          <th scope="col">{t('benchmarks.col.dimension')}</th>
                          <th scope="col">{t('benchmarks.col.difficulty')}</th>
                          <th scope="col">{t('benchmarks.col.scorer')}</th>
                          <th scope="col">{t('benchmarks.col.question')}</th>
                          <th scope="col">{t('benchmarks.col.reference')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.slice(0, 300).map((item) => (
                          <tr key={item.id}>
                            <td className="whitespace-nowrap font-mono text-2xs text-lab-faint">{item.externalKey}</td>
                            <td className="whitespace-nowrap text-2xs">
                              <DimensionLabel dimension={item.dimension} />
                            </td>
                            <td className="whitespace-nowrap text-2xs text-lab-muted">
                              {t(`difficulty.${item.difficulty}` as never)}
                            </td>
                            <td className="whitespace-nowrap text-2xs text-lab-muted">
                              <ScorerLabel type={item.scorer.type} />
                              <span className="ml-1 font-mono text-[10px] text-lab-faint">v{item.scorer.version}</span>
                            </td>
                            <td className="max-w-[420px] text-2xs text-lab-text">
                              <span className="line-clamp-3 whitespace-pre-wrap">{item.question}</span>
                            </td>
                            <td className="max-w-[200px] font-mono text-2xs text-lab-muted">
                              {item.reference ? truncateText(item.reference, 120) : <span className="text-lab-faint">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            </>
          ) : null}
        </>
      )}

      <Callout tone="neutral" icon={<FileUp className="h-4 w-4" />}>
        {t('benchmarks.importFormat')} {t('benchmarks.importHint')}
      </Callout>
    </div>
  );
}

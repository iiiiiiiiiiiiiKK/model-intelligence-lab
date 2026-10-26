import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, BookOpen, FlaskConical, KeyRound, PlayCircle } from 'lucide-react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { DataState, EmptyState, ErrorState, SkeletonRows } from '../components/ui/States';
import {
  Callout,
  ConclusionBadge,
  Pill,
  ScoreBar,
  Section,
  Stat,
  StatusBadge,
} from '../components/ui/Primitives';
import { DimensionChart, TrendChart } from '../components/charts/Charts';
import { formatDate, formatNumber, formatScore } from '../lib/format';

export default function HomePage() {
  const { t, locale } = useI18n();
  const overview = useApi(() => api.overview(), []);

  return (
    <div className="space-y-6">
      {/* hero */}
      <section className="lab-card relative overflow-hidden px-5 py-7 sm:px-7 sm:py-9">
        <div
          className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full opacity-40"
          style={{ background: 'radial-gradient(circle, rgba(181,233,75,0.14), transparent 70%)' }}
          aria-hidden="true"
        />
        <div className="relative max-w-3xl space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="accent">{t('app.name')}</Pill>
            <span className="font-mono text-2xs text-lab-faint">Model Intelligence Lab</span>
          </div>
          <h1 className="text-2xl font-semibold leading-tight tracking-tight text-lab-text sm:text-[32px]">
            {t('home.hero.title')}
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-lab-muted">{t('home.hero.body')}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Link to="/lab" className="lab-btn-primary">
              <PlayCircle className="h-4 w-4" aria-hidden="true" />
              {t('home.hero.ctaPrimary')}
            </Link>
            <Link to="/benchmarks" className="lab-btn-secondary">
              <BookOpen className="h-4 w-4" aria-hidden="true" />
              {t('home.hero.ctaSecondary')}
            </Link>
          </div>
        </div>
      </section>

      {/* metrics */}
      {overview.error && !overview.data ? (
        <ErrorState error={overview.error} onRetry={overview.reload} />
      ) : overview.initialLoading ? (
        <SkeletonRows rows={2} />
      ) : overview.data ? (
        <>
          {overview.data.counts.realRuns === 0 && overview.data.counts.demoRuns > 0 ? (
            <Callout tone="demo" title={t('demo.badge')} icon={<AlertTriangle className="h-4 w-4" />}>
              {t('demo.banner')}
            </Callout>
          ) : null}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label={t('home.metric.runs')}
              value={formatNumber(overview.data.counts.realRuns, locale)}
              hint={overview.data.counts.demoRuns > 0 ? `${t('demo.badge')}: ${overview.data.counts.demoRuns}` : undefined}
              tone={overview.data.counts.realRuns > 0 ? 'accent' : 'muted'}
            />
            <Stat
              label={t('home.metric.models')}
              value={formatNumber(overview.data.counts.models, locale)}
              hint={`${t('home.metric.evaluated')}: ${overview.data.counts.evaluatedModels}`}
            />
            <Stat
              label={t('home.metric.tracked')}
              value={formatNumber(overview.data.counts.trackedModels, locale)}
              hint={t('monitor.subtitle')}
              tone={overview.data.counts.trackedModels > 0 ? 'cyan' : 'muted'}
            />
            <Stat
              label={t('home.metric.benchmarks')}
              value={formatNumber(overview.data.counts.benchmarks, locale)}
              hint={`${t('home.metric.items')}: ${formatNumber(overview.data.counts.benchmarkItems, locale)}`}
            />
          </div>

          {/* provider readiness */}
          <Section title={t('home.section.readiness')}>
            <ul className="grid gap-2 sm:grid-cols-3">
              {overview.data.providerReadiness.map((provider) => (
                <li
                  key={provider.name}
                  className="flex items-center justify-between gap-2 rounded-lab border border-lab-border bg-lab-surface px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <KeyRound
                      className={`h-3.5 w-3.5 shrink-0 ${provider.hasCredential ? 'text-[#B5E94B]' : 'text-lab-faint'}`}
                      aria-hidden="true"
                    />
                    <span className="truncate text-xs text-lab-text">{provider.name}</span>
                  </div>
                  <Pill tone={provider.hasCredential ? 'accent' : 'warn'}>
                    {provider.hasCredential ? t('home.readiness.configured') : t('home.readiness.missing')}
                  </Pill>
                </li>
              ))}
            </ul>
            {overview.data.providerReadiness.every((p) => !p.hasCredential) ? (
              <div className="mt-3">
                <Callout tone="warn">
                  {t('settings.credentialHint')}{' '}
                  <Link to="/settings" className="lab-link">
                    {t('home.readiness.configure')}
                  </Link>
                </Callout>
              </div>
            ) : null}
          </Section>

          {/* recent runs + trend */}
          <div className="grid gap-6 xl:grid-cols-2">
            <Section
              title={t('home.section.recentRuns')}
              actions={
                <Link to="/lab" className="lab-btn-ghost text-xs">
                  {t('action.runEvaluation')}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              }
            >
              {overview.data.recentRuns.length === 0 ? (
                <EmptyState
                  title={t('home.empty.runs')}
                  description={t('app.description')}
                  action={
                    <Link to="/lab" className="lab-btn-primary text-xs">
                      <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('home.empty.runsCta')}
                    </Link>
                  }
                />
              ) : (
                <ul className="divide-y divide-lab-border/60">
                  {overview.data.recentRuns.slice(0, 6).map((run) => (
                    <li key={run.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/models/${run.modelId}`}
                            className="truncate text-sm text-lab-text hover:text-[#B5E94B]"
                          >
                            {run.modelDisplayName}
                          </Link>
                          <StatusBadge status={run.status} />
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-lab-faint">
                          <span>{run.providerName}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{run.benchmarkVersion}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatDate(run.createdAt, locale)}</span>
                        </div>
                      </div>
                      <div className="w-20 shrink-0 text-right">
                        <div className="font-mono text-sm text-lab-text">{formatScore(run.overallScore, locale)}</div>
                        <ScoreBar value={run.overallScore} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={t('home.section.trend')} description={t('home.empty.trend')}>
              <TrendChart series={overview.data.trend} />
            </Section>
          </div>

          {/* events + dimension averages */}
          <div className="grid gap-6 xl:grid-cols-2">
            <Section
              title={t('home.section.events')}
              actions={
                <Link to="/monitor" className="lab-btn-ghost text-xs">
                  {t('nav.monitor')}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              }
            >
              {overview.data.recentEvents.length === 0 ? (
                <EmptyState title={t('home.empty.events')} description={t('monitor.noBaseline')} />
              ) : (
                <ul className="space-y-2">
                  {overview.data.recentEvents.slice(0, 5).map((event) => (
                    <li
                      key={event.id}
                      className="flex items-start justify-between gap-3 rounded-lab border border-lab-border bg-lab-surface px-3 py-2.5"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <ConclusionBadge conclusion={event.conclusion} />
                          <span className="truncate text-xs text-lab-text">{event.modelDisplayName}</span>
                        </div>
                        <div className="text-2xs text-lab-faint">
                          {formatDate(event.createdAt, locale)} · n={event.sampleSize}
                          {event.dimension ? ` · ${t(`dimension.${event.dimension}` as never)}` : ''}
                        </div>
                      </div>
                      <div
                        className={`shrink-0 font-mono text-xs ${
                          event.delta < 0 ? 'text-[#FF7474]' : event.delta > 0 ? 'text-[#B5E94B]' : 'text-lab-muted'
                        }`}
                      >
                        {event.delta > 0 ? '+' : ''}
                        {formatScore(event.delta, locale)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={t('home.dimensionProfile')}>
              <DimensionChart values={overview.data.dimensionAverages} />
            </Section>
          </div>
        </>
      ) : (
        <DataState state={overview}>{() => null}</DataState>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Lock, LockOpen, Share2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/States';
import { Callout, DemoBadge, PageHeader, Pill, Section, Stat } from '../components/ui/Primitives';
import { formatCurrencyUsd, formatDate, formatLatency, formatNumber, formatScore } from '../lib/format';

export default function ReportsPage() {
  const { t, locale } = useI18n();
  const reports = useApi(() => api.reports(), []);
  const [copied, setCopied] = useState<string | null>(null);

  const list = reports.data?.reports ?? [];

  const copyShareLink = async (publicId: string) => {
    const url = `${window.location.origin}/reports/${publicId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(publicId);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard is unavailable (insecure context or denied permission): surface
      // the URL so the user can copy it manually rather than pretending it worked.
      window.prompt(t('reports.copyLink'), url);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader title={t('reports.title')} description={t('reports.subtitle')} />

      <Callout tone="neutral">{t('reports.disclaimer')}</Callout>

      <Section title={t('reports.list')} description={t('misc.ofTotal', { total: list.length })}>
        {reports.error ? (
          <ErrorState error={reports.error} onRetry={reports.reload} />
        ) : reports.initialLoading ? (
          <SkeletonRows rows={4} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-5 w-5" />}
            title={t('reports.empty')}
            action={
              <Link to="/lab" className="lab-btn-primary text-xs">
                {t('action.runEvaluation')}
              </Link>
            }
          />
        ) : (
          <div className="space-y-2">
            {list.map((report) => (
              <article key={report.id} className="rounded-lab border border-lab-border bg-lab-surface p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/reports/${report.publicId}`}
                        className="text-sm font-medium text-lab-text hover:text-[#B5E94B]"
                      >
                        {report.title}
                      </Link>
                      <Pill tone={report.visibility === 'public' ? 'accent' : 'neutral'}>
                        {report.visibility === 'public' ? (
                          <LockOpen className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <Lock className="h-3 w-3" aria-hidden="true" />
                        )}
                        {report.visibility === 'public' ? t('reports.public') : t('reports.private')}
                      </Pill>
                      {report.run?.isDemo ? <DemoBadge /> : null}
                      <Pill tone="muted">{report.language === 'en' ? 'English' : '简体中文'}</Pill>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-lab-faint">
                      <span className="font-mono">{report.publicId}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatDate(report.createdAt, locale)}</span>
                      {report.run ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{report.run.modelDisplayName}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{report.run.benchmarkVersion}</span>
                        </>
                      ) : null}
                    </div>
                    {report.summary ? (
                      <p className="line-clamp-2 text-xs text-lab-muted">{report.summary}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <div className="text-right">
                      <div className="font-mono text-sm text-[#B5E94B]">
                        {formatScore(report.run?.overallScore ?? null, locale)}
                      </div>
                      <div className="text-2xs text-lab-faint">
                        n={formatNumber(report.run?.sampleCount ?? 0, locale)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="lab-btn-ghost px-2"
                      onClick={() => void copyShareLink(report.publicId)}
                      aria-label={t('reports.copyLink')}
                      title={t('reports.copyLink')}
                    >
                      <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <Link to={`/reports/${report.publicId}`} className="lab-btn-ghost px-2 text-2xs">
                      {t('reports.open')}
                    </Link>
                  </div>
                </div>
                {copied === report.publicId ? (
                  <p className="mt-2 text-2xs text-[#B5E94B]">{t('reports.linkCopied')}</p>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </Section>

      {list.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={t('reports.list')} value={formatNumber(list.length, locale)} />
          <Stat
            label={t('reports.public')}
            value={formatNumber(list.filter((r) => r.visibility === 'public').length, locale)}
            tone="accent"
          />
          <Stat
            label={t('reports.private')}
            value={formatNumber(list.filter((r) => r.visibility === 'private').length, locale)}
            tone="muted"
          />
          <Stat
            label={t('compare.samples')}
            value={formatNumber(
              list.reduce((acc, report) => acc + (report.run?.sampleCount ?? 0), 0),
              locale,
            )}
            tone="cyan"
          />
        </div>
      ) : null}

      <Section title={t('reports.statistics')}>
        <div className="lab-scroll -mx-4">
          <table className="lab-table text-xs">
            <caption className="sr-only-focusable">{t('reports.statistics')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('reports.col.run')}</th>
                <th scope="col">{t('reports.col.model')}</th>
                <th scope="col" className="text-right">{t('compare.overall')}</th>
                <th scope="col" className="text-right">{t('compare.samples')}</th>
                <th scope="col" className="text-right">{t('compare.latency')}</th>
                <th scope="col" className="text-right">{t('compare.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {list
                .filter((report) => report.run)
                .slice(0, 20)
                .map((report) => (
                  <tr key={`${report.id}-stats`}>
                    <td className="font-mono text-2xs text-lab-faint">{report.run!.id.slice(0, 8)}</td>
                    <td className="text-lab-text">{report.run!.modelDisplayName}</td>
                    <td className="text-right font-mono">{formatScore(report.run!.overallScore, locale)}</td>
                    <td className="text-right font-mono text-lab-muted">{report.run!.sampleCount}</td>
                    <td className="text-right font-mono text-lab-muted">
                      {formatLatency(
                        report.run!.sampleCount > 0 ? report.run!.totalLatencyMs / report.run!.sampleCount : null,
                        locale,
                      )}
                    </td>
                    <td className="text-right font-mono text-lab-muted">
                      {formatCurrencyUsd(report.run!.estimatedCostUsd, locale)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

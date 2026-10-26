import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Send, ShieldCheck } from 'lucide-react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/States';
import { Callout, PageHeader, Pill, Section } from '../components/ui/Primitives';
import { formatDate } from '../lib/format';

export default function CommunityPage() {
  const { t, locale } = useI18n();
  const community = useApi(() => api.community(), []);
  const [form, setForm] = useState({ title: '', body: '', reference: '', dimension: '', author: '' });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setResult(null);
    const response = await api.submitCommunityItem({
      kind: 'item',
      title: form.title.trim(),
      body: form.body.trim(),
      reference: form.reference.trim() || null,
      dimension: form.dimension || null,
      author: form.author.trim() || undefined,
    });
    if (response.ok) {
      setResult({ ok: true, message: t('community.submitted') });
      setForm({ title: '', body: '', reference: '', dimension: '', author: '' });
      community.reload();
    } else {
      setResult({ ok: false, message: response.error.message });
    }
    setSubmitting(false);
  };

  const submissions = community.data?.submissions ?? [];
  const publicReports = community.data?.publicReports ?? [];

  return (
    <div className="space-y-5">
      <PageHeader title={t('community.title')} description={t('community.subtitle')} />

      <div className="grid gap-5 xl:grid-cols-2">
        <Section title={t('community.publicReports')} description={t('misc.ofTotal', { total: publicReports.length })}>
          {community.error ? (
            <ErrorState error={community.error} onRetry={community.reload} />
          ) : community.initialLoading ? (
            <SkeletonRows rows={3} />
          ) : publicReports.length === 0 ? (
            <EmptyState icon={<Globe className="h-5 w-5" />} title={t('community.emptyReports')} description={t('reports.empty')} />
          ) : (
            <ul className="space-y-2">
              {publicReports.map((report) => (
                <li key={report.publicId} className="rounded-lab border border-lab-border bg-lab-surface p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <Link
                        to={`/reports/${report.publicId}`}
                        className="block truncate text-sm text-lab-text hover:text-[#B5E94B]"
                      >
                        {report.title}
                      </Link>
                      <div className="text-2xs text-lab-faint">{formatDate(report.createdAt, locale)}</div>
                      {report.summary ? (
                        <p className="line-clamp-2 text-2xs text-lab-muted">{report.summary}</p>
                      ) : null}
                    </div>
                    <Pill tone="accent">{t('reports.public')}</Pill>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t('community.submitTitle')} description={t('community.reviewHint')}>
          <form onSubmit={submit} className="space-y-3">
            <label className="block space-y-1">
              <span className="lab-label">{t('community.titleField')}</span>
              <input
                type="text"
                required
                minLength={3}
                maxLength={200}
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                className="lab-input text-sm"
              />
            </label>
            <label className="block space-y-1">
              <span className="lab-label">{t('community.bodyField')}</span>
              <textarea
                required
                minLength={3}
                maxLength={8000}
                rows={4}
                value={form.body}
                onChange={(event) => setForm({ ...form, body: event.target.value })}
                className="lab-input resize-y text-sm"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="lab-label">{t('community.dimensionField')}</span>
                <select
                  value={form.dimension}
                  onChange={(event) => setForm({ ...form, dimension: event.target.value })}
                  className="lab-input text-xs"
                >
                  <option value="">{t('misc.none')}</option>
                  {['reasoning', 'coding', 'instruction-following', 'factuality', 'stability', 'behavior'].map((dimension) => (
                    <option key={dimension} value={dimension}>
                      {t(`dimension.${dimension}` as never)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="lab-label">{t('community.authorField')}</span>
                <input
                  type="text"
                  maxLength={80}
                  value={form.author}
                  onChange={(event) => setForm({ ...form, author: event.target.value })}
                  className="lab-input text-sm"
                />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="lab-label">{t('community.referenceField')}</span>
              <input
                type="text"
                maxLength={4000}
                value={form.reference}
                onChange={(event) => setForm({ ...form, reference: event.target.value })}
                className="lab-input font-mono text-xs"
              />
            </label>
            <button type="submit" className="lab-btn-primary text-xs" disabled={submitting}>
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              {submitting ? t('community.submitting') : t('community.submitAction')}
            </button>
            {result ? (
              <p className={result.ok ? 'text-2xs text-[#B5E94B]' : 'text-2xs text-[#FF7474]'} role="status">
                {result.message}
              </p>
            ) : null}
          </form>
        </Section>
      </div>

      <Section title={t('community.submissions')} description={t('misc.ofTotal', { total: submissions.length })}>
        {community.initialLoading ? (
          <SkeletonRows rows={3} />
        ) : submissions.length === 0 ? (
          <EmptyState title={t('community.emptySubmissions')} />
        ) : (
          <ul className="space-y-2">
            {submissions.map((submission) => (
              <li key={submission.id} className="rounded-lab border border-lab-border bg-lab-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-sm text-lab-text">{submission.title}</span>
                    <Pill
                      tone={
                        submission.status === 'approved' ? 'accent' : submission.status === 'rejected' ? 'danger' : 'warn'
                      }
                    >
                      {submission.status === 'approved'
                        ? t('community.approved')
                        : submission.status === 'rejected'
                          ? t('community.rejected')
                          : t('community.pending')}
                    </Pill>
                    {submission.dimension ? (
                      <Pill tone="neutral">{t(`dimension.${submission.dimension}` as never)}</Pill>
                    ) : null}
                  </div>
                  <span className="text-2xs text-lab-faint">
                    {submission.author} · {formatDate(submission.createdAt, locale)}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-3 text-xs text-lab-muted">{submission.body}</p>
                {submission.reviewNote ? (
                  <p className="mt-1 text-2xs text-lab-faint">
                    {t('community.reviewNote')}: {submission.reviewNote}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Callout tone="neutral" icon={<ShieldCheck className="h-4 w-4" />}>
        {t('community.reviewHint')}
      </Callout>
      {submissions.some((s) => s.status === 'pending') ? (
        <p className="text-2xs text-lab-faint">
          {t('settings.notImplemented')}: {t('community.pending')} · {submissions.filter((s) => s.status === 'pending').length}
        </p>
      ) : null}
    </div>
  );
}

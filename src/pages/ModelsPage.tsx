import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Filter, KeyRound, Plus, Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/States';
import { Callout, PageHeader, Pill, Section } from '../components/ui/Primitives';
import { formatDate } from '../lib/format';
import type { ModelStatus } from '../../shared/types';

const STATUS_TONE: Record<ModelStatus, 'neutral' | 'cyan' | 'accent' | 'warn'> = {
  registered: 'neutral',
  connected: 'cyan',
  evaluated: 'accent',
  tracked: 'accent',
};

export default function ModelsPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [providerId, setProviderId] = useState('');
  const [status, setStatus] = useState('');

  const providers = useApi(() => api.providers(), []);
  const models = useApi(
    () => api.models({ search: search || undefined, providerId: providerId || undefined, status: status || undefined }),
    [search, providerId, status],
  );

  const [selected, setSelected] = useState<string[]>([]);

  const derived = useMemo(() => {
    const list = models.data?.models ?? [];
    // "Tracked" means at least two comparable runs, which the API already counts;
    // the badge here derives the display status from real run counts.
    return list.map((model) => {
      const displayStatus: ModelStatus =
        model.runCount >= 2 ? 'tracked' : model.runCount === 1 ? 'evaluated' : model.providerHasCredential ? 'connected' : 'registered';
      return { ...model, displayStatus };
    });
  }, [models.data]);

  const toggleSelected = (id: string) => {
    setSelected((previous) =>
      previous.includes(id) ? previous.filter((entry) => entry !== id) : previous.length >= 6 ? previous : [...previous, id],
    );
  };

  const hasFilters = Boolean(search || providerId || status);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('models.title')}
        description={t('models.subtitle')}
        actions={
          <>
            {selected.length >= 2 ? (
              <button
                type="button"
                className="lab-btn-secondary text-xs"
                onClick={() => navigate(`/compare?models=${selected.join(',')}`)}
              >
                {t('models.compareSelected', { count: selected.length })}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
            <Link to="/lab" className="lab-btn-primary text-xs">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('action.runEvaluation')}
            </Link>
          </>
        }
      />

      {/* filters */}
      <div className="lab-card flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-lab-faint" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('models.search')}
            aria-label={t('models.search')}
            className="lab-input pl-8 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only-focusable" htmlFor="provider-filter">
            {t('models.filterProvider')}
          </label>
          <div className="relative">
            <Filter className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-lab-faint" aria-hidden="true" />
            <select
              id="provider-filter"
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              className="lab-input w-full appearance-none pl-8 pr-7 text-xs sm:w-44"
            >
              <option value="">{t('models.filterProvider')}: {t('models.all')}</option>
              {(providers.data?.providers ?? []).map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>
          <label className="sr-only-focusable" htmlFor="status-filter">
            {t('models.filterStatus')}
          </label>
          <select
            id="status-filter"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="lab-input w-full appearance-none text-xs sm:w-36"
          >
            <option value="">{t('models.filterStatus')}: {t('models.all')}</option>
            <option value="registered">{t('models.status.registered')}</option>
            <option value="connected">{t('models.status.connected')}</option>
            <option value="evaluated">{t('models.status.evaluated')}</option>
            <option value="tracked">{t('models.status.tracked')}</option>
          </select>
          {hasFilters ? (
            <button
              type="button"
              className="lab-btn-ghost px-2"
              onClick={() => {
                setSearch('');
                setProviderId('');
                setStatus('');
              }}
              aria-label={t('action.clear')}
              title={t('action.clear')}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      <Callout tone="neutral">{t('models.catalogNote')}</Callout>

      {models.error ? (
        <ErrorState error={models.error} onRetry={models.reload} />
      ) : models.initialLoading ? (
        <SkeletonRows rows={6} />
      ) : derived.length === 0 ? (
        <div className="lab-card">
          <EmptyState
            title={hasFilters ? t('models.emptyFiltered') : t('models.empty')}
            description={hasFilters ? undefined : t('app.description')}
            action={
              hasFilters ? (
                <button
                  type="button"
                  className="lab-btn-secondary text-xs"
                  onClick={() => {
                    setSearch('');
                    setProviderId('');
                    setStatus('');
                  }}
                >
                  {t('action.clear')}
                </button>
              ) : null
            }
          />
        </div>
      ) : (
        <div className="lab-card overflow-hidden">
          <div className="lab-scroll">
            <table className="lab-table">
              <caption className="sr-only-focusable">{t('models.title')}</caption>
              <thead>
                <tr>
                  <th scope="col" className="w-8">
                    <span className="sr-only-focusable">{t('action.select')}</span>
                  </th>
                  <th scope="col">{t('models.col.model')}</th>
                  <th scope="col">{t('models.col.provider')}</th>
                  <th scope="col">{t('models.col.status')}</th>
                  <th scope="col" className="text-right">{t('models.col.runs')}</th>
                  <th scope="col">{t('models.col.lastRun')}</th>
                  <th scope="col" className="text-right">{t('models.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {derived.map((model) => (
                  <tr key={model.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.includes(model.id)}
                        onChange={() => toggleSelected(model.id)}
                        aria-label={`${t('models.selectForCompare')}: ${model.displayName}`}
                        className="h-3.5 w-3.5 cursor-pointer accent-[#B5E94B]"
                      />
                    </td>
                    <td>
                      <div className="space-y-0.5">
                        <Link to={`/models/${model.id}`} className="font-medium text-lab-text hover:text-[#B5E94B]">
                          {model.displayName}
                        </Link>
                        <div className="font-mono text-2xs text-lab-faint">{model.modelId}</div>
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-lab-muted">{model.providerName}</span>
                        {model.providerHasCredential ? (
                          <KeyRound className="h-3 w-3 text-[#B5E94B]" aria-label={t('home.readiness.configured')} />
                        ) : (
                          <KeyRound className="h-3 w-3 text-lab-faint" aria-label={t('home.readiness.missing')} />
                        )}
                      </div>
                    </td>
                    <td>
                      <Pill tone={STATUS_TONE[model.displayStatus]}>{t(`models.status.${model.displayStatus}` as never)}</Pill>
                    </td>
                    <td className="text-right font-mono text-xs text-lab-muted">{model.runCount}</td>
                    <td className="whitespace-nowrap text-2xs text-lab-faint">
                      {model.lastEvaluatedAt ? formatDate(model.lastEvaluatedAt, locale) : '—'}
                    </td>
                    <td className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Link to={`/models/${model.id}`} className="lab-btn-ghost px-2 text-2xs">
                          {t('action.details')}
                        </Link>
                        <Link to={`/lab?model=${model.id}`} className="lab-btn-ghost px-2 text-2xs">
                          {t('action.run')}
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Section title={t('models.versionNote')}>
        <div className="space-y-2">
          <Callout tone="warn">{t('models.versionNote')}</Callout>
          {(models.data?.models ?? []).some((m) => !m.providerHasCredential) ? (
            <Callout tone="neutral" icon={<KeyRound className="h-4 w-4" />}>
              {t('models.noCredentialHint')}{' '}
              <Link to="/settings" className="lab-link">
                {t('settings.providers')}
              </Link>
            </Callout>
          ) : null}
        </div>
      </Section>

      {models.loading && models.data ? (
        <p className="text-2xs text-lab-faint" role="status">
          {t('state.loading')}
        </p>
      ) : null}
      <p className="sr-only-focusable" aria-live="polite">
        {models.data ? t('misc.ofTotal', { total: derived.length }) : ''}
      </p>
    </div>
  );
}

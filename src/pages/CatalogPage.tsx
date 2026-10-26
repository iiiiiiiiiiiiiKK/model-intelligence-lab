import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, ExternalLink, Filter, Info, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/States';
import { Callout, PageHeader, Section, Stat } from '../components/ui/Primitives';
import { formatDate, formatNumber } from '../lib/format';

export default function CatalogPage() {
  const { t, locale } = useI18n();
  const [vendor, setVendor] = useState('');
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [registeringId, setRegisteringId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const catalog = useApi(() => api.catalog({ vendor: vendor || undefined, search: search || undefined }), [vendor, search]);
  const providers = useApi(() => api.providers(), []);

  const models = useMemo(() => catalog.data?.models ?? [], [catalog.data]);
  const vendors = useMemo(() => catalog.data?.vendors ?? [], [catalog.data]);
  const lastImport = catalog.data?.lastImport ?? null;

  const stats = useMemo(() => {
    let arena = 0;
    let index = 0;
    for (const model of models) {
      if (model.arenaElo !== null) arena += 1;
      if (model.aaIntelligenceIndex !== null) index += 1;
    }
    return { arena, index };
  }, [models]);

  const runImport = async () => {
    setImporting(true);
    setMessage(null);
    const result = await api.importCatalog();
    setImporting(false);
    if (result.ok) {
      setMessage({
        ok: true,
        text: t('catalog.importSuccess', {
          models: result.data.result.modelsSeen,
          scores: result.data.result.scoresWritten,
        }),
      });
      catalog.reload();
    } else {
      setMessage({ ok: false, text: t('catalog.importFailed', { message: result.error.message }) });
    }
  };

  const register = async (catalogId: string) => {
    const providerId = providers.data?.providers?.[0]?.id;
    if (!providerId) {
      setMessage({ ok: false, text: t('catalog.chooseProvider') });
      return;
    }
    setRegisteringId(catalogId);
    const result = await api.registerCatalogModel(catalogId, providerId);
    setRegisteringId(null);
    if (result.ok) {
      setMessage({ ok: true, text: t('catalog.registerSuccess', { name: catalogId }) });
      catalog.reload();
    } else {
      setMessage({ ok: false, text: result.error.message });
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('catalog.title')}
        description={t('catalog.subtitle')}
        actions={
          <button type="button" className="lab-btn-primary text-xs" onClick={runImport} disabled={importing}>
            {importing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {importing ? t('catalog.importing') : lastImport ? t('catalog.refresh') : t('catalog.import')}
          </button>
        }
      />

      <Callout tone="warn" icon={<Info className="h-4 w-4" />} title={t('catalog.disclaimer')}>
        {t('catalog.disclaimerBody')}
      </Callout>

      {message ? (
        <p className={message.ok ? 'text-xs text-[#B5E94B]' : 'text-xs text-[#FF7474]'} role="status">
          {message.text}
        </p>
      ) : null}

      {lastImport ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={t('catalog.total')} value={formatNumber(models.length, locale)} tone="accent" />
          <Stat label={t('catalog.vendors')} value={formatNumber(vendors.length, locale)} />
          <Stat label={t('catalog.withElo')} value={formatNumber(stats.arena, locale)} tone="cyan" />
          <Stat label={t('catalog.withIndex')} value={formatNumber(stats.index, locale)} tone="cyan" />
        </div>
      ) : null}

      <div className="lab-card flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-lab-faint" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('catalog.search')}
            aria-label={t('catalog.search')}
            className="lab-input pl-8 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 shrink-0 text-lab-faint" aria-hidden="true" />
          <select
            value={vendor}
            onChange={(event) => setVendor(event.target.value)}
            className="lab-input w-full appearance-none text-xs sm:w-52"
            aria-label={t('catalog.filterVendor')}
          >
            <option value="">{t('catalog.allVendors')}</option>
            {vendors.map((entry) => (
              <option key={entry.vendor} value={entry.vendor}>
                {entry.vendor} ({entry.count})
              </option>
            ))}
          </select>
          {search || vendor ? (
            <button
              type="button"
              className="lab-btn-ghost px-2"
              onClick={() => {
                setSearch('');
                setVendor('');
              }}
              aria-label={t('action.clear')}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      <Section
        title={t('catalog.title')}
        description={t('catalog.compareHint')}
        actions={
          lastImport ? (
            <span className="text-2xs text-lab-faint">
              {t('catalog.lastImport', { time: formatDate(lastImport.importedAt, locale) })}
            </span>
          ) : null
        }
      >
        {catalog.error ? (
          <ErrorState error={catalog.error} onRetry={catalog.reload} />
        ) : catalog.initialLoading ? (
          <SkeletonRows rows={6} />
        ) : models.length === 0 ? (
          <EmptyState
            icon={<Download className="h-5 w-5" />}
            title={lastImport ? t('catalog.emptyFiltered') : t('catalog.empty')}
            action={
              !lastImport ? (
                <button type="button" className="lab-btn-primary text-xs" onClick={runImport} disabled={importing}>
                  {importing ? t('catalog.importing') : t('catalog.import')}
                </button>
              ) : null
            }
          />
        ) : (
          <div className="lab-scroll -mx-4">
            <table className="lab-table text-xs">
              <caption className="sr-only-focusable">{t('catalog.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('catalog.col.model')}</th>
                  <th scope="col">{t('catalog.col.vendor')}</th>
                  <th scope="col" className="text-right">{t('catalog.col.context')}</th>
                  <th scope="col" className="text-right">{t('catalog.col.price')}</th>
                  <th scope="col" className="text-right">{t('catalog.col.elo')}</th>
                  <th scope="col" className="text-right">{t('catalog.col.index')}</th>
                  <th scope="col" className="text-right">{t('catalog.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id}>
                    <td>
                      <div className="space-y-0.5">
                        <span className="text-lab-text">{model.name}</span>
                        <div className="font-mono text-2xs text-lab-faint">{model.id}</div>
                      </div>
                    </td>
                    <td className="text-lab-muted">{model.vendor}</td>
                    <td className="text-right font-mono text-lab-muted">
                      {model.contextLength === null
                        ? '—'
                        : model.contextLength >= 1000
                          ? `${formatNumber(model.contextLength / 1000, locale, 0)}k`
                          : formatNumber(model.contextLength, locale)}
                    </td>
                    <td className="whitespace-nowrap text-right font-mono text-lab-muted">
                      {model.inputPerMillion === null ? '—' : `$${model.inputPerMillion}/${model.outputPerMillion ?? '—'}`}
                    </td>
                    <td className="text-right font-mono">
                      {model.arenaElo === null ? (
                        <span className="text-lab-faint">—</span>
                      ) : (
                        <span className="text-[#5DDBCA]">{formatNumber(model.arenaElo, locale)}</span>
                      )}
                    </td>
                    <td className="text-right font-mono">
                      {model.aaIntelligenceIndex === null ? (
                        <span className="text-lab-faint">—</span>
                      ) : (
                        <span className="text-[#B5E94B]">{formatNumber(model.aaIntelligenceIndex, locale, 1)}</span>
                      )}
                    </td>
                    <td className="text-right">
                      {model.registeredModelId ? (
                        <Link to={`/models/${model.registeredModelId}`} className="lab-btn-ghost px-2 text-2xs text-[#B5E94B]">
                          {t('catalog.registered')}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className="lab-btn-ghost px-2 text-2xs"
                          onClick={() => void register(model.id)}
                          disabled={registeringId === model.id}
                        >
                          {registeringId === model.id ? (
                            <RefreshCw className="h-3 w-3 animate-spin" />
                          ) : (
                            <Plus className="h-3 w-3" />
                          )}
                          {registeringId === model.id ? t('catalog.registering') : t('catalog.register')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Callout tone="neutral" icon={<ExternalLink className="h-4 w-4" />}>
        {t('catalog.registerHint')}{' '}
        <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer noopener" className="lab-link">
          openrouter.ai/models
        </a>
      </Callout>
    </div>
  );
}

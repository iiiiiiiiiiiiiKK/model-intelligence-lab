import { useEffect, useState } from 'react';
import { Check, Globe, Save } from 'lucide-react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { ErrorState, LoadingBlock } from '../components/ui/States';
import { ProviderManager } from '../components/ProviderManager';
import { PageHeader, Pill, Section } from '../components/ui/Primitives';

export default function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  const settings = useApi(() => api.settings(), []);
  const models = useApi(() => api.models(), []);
  const benchmarks = useApi(() => api.benchmarks(), []);

  const [form, setForm] = useState<{
    defaultBudgetUsd: number;
    reportVisibility: 'public' | 'private';
    defaultModelId: string;
    defaultBenchmarkId: string;
    regressionAlerts: boolean;
    runCompleted: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    const current = settings.data.settings;
    setForm({
      defaultBudgetUsd: current.defaultBudgetUsd,
      reportVisibility: current.reportVisibility,
      defaultModelId: current.defaultModelId ?? '',
      defaultBenchmarkId: current.defaultBenchmarkId ?? '',
      regressionAlerts: current.notifications.regressionAlerts,
      runCompleted: current.notifications.runCompleted,
    });
  }, [settings.data]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setStatus(null);
    const result = await api.updateSettings({
      language: locale,
      defaultBudgetUsd: form.defaultBudgetUsd,
      reportVisibility: form.reportVisibility,
      defaultModelId: form.defaultModelId || null,
      defaultBenchmarkId: form.defaultBenchmarkId || null,
      notifications: {
        regressionAlerts: form.regressionAlerts,
        runCompleted: form.runCompleted,
      },
    });
    setStatus(
      result.ok
        ? { ok: true, message: t('settings.savedToast') }
        : { ok: false, message: result.error.message || t('settings.saveFailed') },
    );
    setSaving(false);
  };

  if (settings.error) return <ErrorState error={settings.error} onRetry={settings.reload} />;
  if (settings.initialLoading || !form) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />

      <Section title={t('settings.language')} description={t('settings.languageHint')}>
        <div className="flex flex-wrap gap-2">
          {(['zh-CN', 'en'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setLocale(option)}
              aria-pressed={locale === option}
              className={`flex items-center gap-2 rounded-lab border px-3.5 py-2 text-sm transition-colors duration-fast ${
                locale === option
                  ? 'border-[#B5E94B]/50 bg-[#B5E94B]/10 text-[#B5E94B]'
                  : 'border-lab-border bg-lab-surface text-lab-muted hover:bg-lab-hover hover:text-lab-text'
              }`}
            >
              <Globe className="h-3.5 w-3.5" aria-hidden="true" />
              {option === 'zh-CN' ? t('lang.zh') : t('lang.en')}
              {locale === option ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      </Section>

      <ProviderManager />

      <Section title={t('settings.apiKeysTitle')}>
        <p className="text-xs leading-relaxed text-lab-muted">{t('settings.apiKeysBody')}</p>
        <pre className="mt-2 overflow-x-auto rounded-sm bg-lab-bg px-2.5 py-2 font-mono text-[11px] leading-relaxed text-lab-muted">
{`# 可选：无界面的自动化部署可以在 .env 中提供兜底配置
OPENAI_COMPATIBLE_BASE_URL=https://api.example.com/v1
OPENAI_COMPATIBLE_API_KEY=sk-...
MODEL_LAB_SECRET=<至少 32 字符，用于加密存储的密钥>`}
        </pre>
      </Section>

      <div className="grid gap-5 xl:grid-cols-2">
        <Section title={t('settings.defaults')}>
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="lab-label">{t('settings.defaultModel')}</span>
              <select
                value={form.defaultModelId}
                onChange={(event) => setForm({ ...form, defaultModelId: event.target.value })}
                className="lab-input text-sm"
              >
                <option value="">{t('misc.none')}</option>
                {(models.data?.models ?? []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName} · {model.providerName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="lab-label">{t('settings.defaultBenchmark')}</span>
              <select
                value={form.defaultBenchmarkId}
                onChange={(event) => setForm({ ...form, defaultBenchmarkId: event.target.value })}
                className="lab-input text-sm"
              >
                <option value="">{t('misc.none')}</option>
                {(benchmarks.data?.benchmarks ?? []).map((benchmark) => (
                  <option key={benchmark.id} value={benchmark.id}>
                    {benchmark.name} (v{benchmark.currentVersion})
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="lab-label">{t('settings.defaultBudget')}</span>
              <input
                type="number"
                min={0}
                max={1000}
                step={0.5}
                value={form.defaultBudgetUsd}
                onChange={(event) => setForm({ ...form, defaultBudgetUsd: Number(event.target.value) })}
                className="lab-input font-mono text-sm"
              />
            </label>
          </div>
        </Section>

        <Section title={t('settings.privacy')}>
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="lab-label">{t('settings.reportVisibility')}</span>
              <select
                value={form.reportVisibility}
                onChange={(event) => setForm({ ...form, reportVisibility: event.target.value as 'public' | 'private' })}
                className="lab-input text-sm"
              >
                <option value="private">{t('reports.private')}</option>
                <option value="public">{t('reports.public')}</option>
              </select>
            </label>

            <fieldset className="space-y-2 rounded-lab border border-lab-border bg-lab-surface px-3 py-2.5">
              <legend className="lab-label px-1">{t('settings.notifications')}</legend>
              <label className="flex items-start gap-2 text-xs text-lab-text">
                <input
                  type="checkbox"
                  checked={form.regressionAlerts}
                  onChange={(event) => setForm({ ...form, regressionAlerts: event.target.checked })}
                  className="mt-0.5 h-3.5 w-3.5 accent-[#B5E94B]"
                />
                {t('settings.notifyRegression')}
              </label>
              <label className="flex items-start gap-2 text-xs text-lab-text">
                <input
                  type="checkbox"
                  checked={form.runCompleted}
                  onChange={(event) => setForm({ ...form, runCompleted: event.target.checked })}
                  className="mt-0.5 h-3.5 w-3.5 accent-[#B5E94B]"
                />
                {t('settings.notifyCompleted')}
              </label>
              <p className="pt-1 text-2xs text-lab-faint">
                <Pill tone="warn" className="mr-1.5">
                  {t('settings.notImplemented')}
                </Pill>
                {t('settings.emailNotImplemented')}
              </p>
            </fieldset>
          </div>
        </Section>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="lab-btn-primary text-xs" onClick={save} disabled={saving}>
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
          {saving ? t('action.saving') : t('action.save')}
        </button>
        {status ? (
          <span className={status.ok ? 'text-xs text-[#B5E94B]' : 'text-xs text-[#FF7474]'} role="status">
            {status.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}

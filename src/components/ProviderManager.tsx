import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { providersApi } from '../lib/providers-api';
import { Callout, Pill, Section } from './ui/Primitives';
import { ErrorState, SkeletonRows } from './ui/States';
import type { ProviderSummary, ProviderTestResult } from '../../shared/types';

const KIND_LABEL: Record<string, string> = {
  'openai-compatible': 'OpenAI 兼容 / relay',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  anthropic: 'Anthropic',
  custom: 'Custom',
};

const SOURCE_TONE = {
  database: 'accent',
  environment: 'cyan',
  none: 'warn',
} as const;

interface FormState {
  name: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  kind: 'openai-compatible',
  baseUrl: '',
  apiKey: '',
  enabled: true,
};

export function ProviderManager() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
  const [error, setError] = useState<{ code: string; message: string; status: number; retryable: boolean } | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  // create form
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // per-provider transient UI state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [testResult, setTestResult] = useState<Record<string, ProviderTestResult | null>>({});
  const [discovered, setDiscovered] = useState<Record<string, Array<{ id: string; registered: boolean }> | null>>(
    {},
  );

  const load = async () => {
    const result = await providersApi.list();
    if (result.ok) {
      setProviders(result.data.providers);
      setError(null);
    } else {
      setError(result.error);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const flash = (ok: boolean, text: string) => {
    setToast({ ok, text });
    setTimeout(() => setToast(null), 4200);
  };

  const createProvider = async () => {
    if (!form.name.trim() || !form.baseUrl.trim()) {
      setFormError('名称和接口地址都不能为空');
      return;
    }
    setSaving(true);
    setFormError(null);
    const result = await providersApi.create({
      name: form.name.trim(),
      kind: form.kind,
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim() || undefined,
      enabled: form.enabled,
    });
    setSaving(false);
    if (result.ok) {
      setCreating(false);
      setForm(EMPTY_FORM);
      await load();
      flash(true, t('settings.providerAdded'));
    } else {
      setFormError(result.error.message);
    }
  };

  const startEdit = (provider: ProviderSummary) => {
    setEditingId(provider.id);
    setEditForm({
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      apiKey: '',
      enabled: provider.enabled,
    });
    setTestResult((previous) => ({ ...previous, [provider.id]: null }));
  };

  const saveEdit = async (provider: ProviderSummary) => {
    setSaving(true);
    const payload: { name?: string; baseUrl?: string; enabled?: boolean; apiKey?: string } = {
      name: editForm.name.trim(),
      baseUrl: editForm.baseUrl.trim(),
      enabled: editForm.enabled,
    };
    if (editForm.apiKey.trim()) payload.apiKey = editForm.apiKey.trim();

    const result = await providersApi.update(provider.id, payload);
    setSaving(false);
    if (result.ok) {
      setEditingId(null);
      await load();
      flash(true, t('settings.providerSaved'));
    } else {
      flash(false, result.error.message);
    }
  };

  const clearKey = async (provider: ProviderSummary) => {
    if (!window.confirm(t('settings.clearKeyConfirm'))) return;
    setBusyId(provider.id);
    const result = await providersApi.update(provider.id, { apiKey: null });
    setBusyId(null);
    if (result.ok) {
      await load();
      flash(true, t('settings.keyCleared'));
    } else {
      flash(false, result.error.message);
    }
  };

  const deleteProvider = async (provider: ProviderSummary) => {
    if (!window.confirm(t('settings.deleteConfirm', { name: provider.name }))) return;
    setBusyId(provider.id);
    const result = await providersApi.remove(provider.id);
    setBusyId(null);
    if (result.ok) {
      await load();
      flash(true, t('settings.providerDeleted'));
    } else {
      flash(false, result.error.message);
    }
  };

  const testConnection = async (provider: ProviderSummary, apiKey?: string) => {
    setBusyId(provider.id);
    const result = await providersApi.test(provider.id, apiKey);
    setBusyId(null);
    if (result.ok) {
      setTestResult((previous) => ({ ...previous, [provider.id]: result.data.result }));
    } else {
      setTestResult((previous) => ({
        ...previous,
        [provider.id]: {
          ok: false,
          status: null,
          latencyMs: null,
          message: result.error.message,
          modelCount: null,
          sampleModels: [],
        },
      }));
    }
  };

  const discover = async (provider: ProviderSummary) => {
    setBusyId(provider.id);
    const result = await providersApi.discoverModels(provider.id);
    setBusyId(null);
    if (result.ok) {
      setDiscovered((previous) => ({ ...previous, [provider.id]: result.data.models }));
    } else {
      flash(false, result.error.message);
    }
  };

  const registerAll = async (provider: ProviderSummary) => {
    const list = discovered[provider.id] ?? [];
    const pending = list.filter((model) => !model.registered).map((model) => model.id);
    if (pending.length === 0) return;
    setBusyId(provider.id);
    const result = await providersApi.registerModels(provider.id, pending);
    setBusyId(null);
    if (result.ok) {
      await discover(provider);
      await load();
      flash(true, t('settings.registerResult', { created: result.data.created, requested: result.data.requested }));
    } else {
      flash(false, result.error.message);
    }
  };

  const sorted = useMemo(
    () => (providers ?? []).slice().sort((a, b) => Number(b.isBuiltin) - Number(a.isBuiltin)),
    [providers],
  );

  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (providers === null) return <SkeletonRows rows={3} />;

  return (
    <Section
      title={t('settings.providers')}
      description={t('settings.credentialHint')}
      actions={
        <button
          type="button"
          className="lab-btn-primary text-xs"
          onClick={() => {
            setCreating((value) => !value);
            setFormError(null);
          }}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t('settings.addProvider')}
        </button>
      }
    >
      <div className="space-y-3">
        <Callout tone="neutral" icon={<KeyRound className="h-4 w-4" />}>
          {t('settings.securityNote')} {t('settings.envFallbackNote')}
        </Callout>

        {toast ? (
          <p className={toast.ok ? 'text-xs text-[#B5E94B]' : 'text-xs text-[#FF7474]'} role="status">
            {toast.text}
          </p>
        ) : null}

        {/* create form */}
        {creating ? (
          <div className="rounded-lab border border-[#B5E94B]/30 bg-[#B5E94B]/[0.04] p-3.5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-lab-text">{t('settings.addProviderTitle')}</h3>
              <button
                type="button"
                className="lab-btn-ghost px-1.5"
                onClick={() => setCreating(false)}
                aria-label={t('action.close')}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <ProviderForm
              value={form}
              onChange={setForm}
              onSubmit={createProvider}
              submitting={saving}
              submitLabel={t('settings.addProvider')}
              error={formError}
              showKind
            />
          </div>
        ) : null}

        {sorted.length === 0 ? (
          <p className="py-6 text-center text-xs text-lab-muted">{t('settings.noProviders')}</p>
        ) : (
          <ul className="space-y-2">
            {sorted.map((provider) => {
              const isEditing = editingId === provider.id;
              const result = testResult[provider.id];
              const models = discovered[provider.id];
              const isBusy = busyId === provider.id;

              return (
                <li key={provider.id} className="rounded-lab border border-lab-border bg-lab-surface">
                  <div className="flex flex-wrap items-start justify-between gap-2 p-3">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Server className="h-3.5 w-3.5 shrink-0 text-lab-faint" aria-hidden="true" />
                        <span className="text-sm font-medium text-lab-text">{provider.name}</span>
                        <Pill tone={provider.isBuiltin ? 'neutral' : 'accent'}>
                          {provider.isBuiltin ? t('settings.builtinBadge') : t('settings.customBadge')}
                        </Pill>
                        <Pill tone={provider.enabled ? 'cyan' : 'muted'}>
                          {provider.enabled ? t('settings.enabled') : t('settings.disabled')}
                        </Pill>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
                        <span className="font-mono text-lab-faint">{provider.baseUrl}</span>
                        <span className="text-lab-faint">{KIND_LABEL[provider.kind] ?? provider.kind}</span>
                        <span className="text-lab-faint">
                          {t('settings.modelCount', { count: provider.modelCount })}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill tone={SOURCE_TONE[provider.credentialSource]}>
                          <KeyRound className="h-3 w-3" aria-hidden="true" />
                          {provider.credentialSource === 'database'
                            ? t('settings.credential.fromDatabase')
                            : provider.credentialSource === 'environment'
                              ? t('settings.credential.fromEnvironment')
                              : t('settings.credential.none')}
                          {provider.credentialHint ? (
                            <span className="ml-1 font-mono">{provider.credentialHint}</span>
                          ) : null}
                        </Pill>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        className="lab-btn-secondary text-2xs"
                        onClick={() => void testConnection(provider, isEditing ? editForm.apiKey : undefined)}
                        disabled={isBusy || (!provider.hasCredential && !(isEditing && editForm.apiKey.trim()))}
                        title={
                          !provider.hasCredential && !(isEditing && editForm.apiKey.trim())
                            ? t('settings.noCredentialToTest')
                            : t('settings.testConnection')
                        }
                      >
                        {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />}
                        {isBusy ? t('settings.testing') : t('settings.testConnection')}
                      </button>
                      <button
                        type="button"
                        className="lab-btn-ghost text-2xs"
                        onClick={() => void discover(provider)}
                        disabled={isBusy || !provider.hasCredential}
                      >
                        <RefreshCw className="h-3 w-3" aria-hidden="true" />
                        {t('settings.discoverModels')}
                      </button>
                      <button
                        type="button"
                        className="lab-btn-ghost text-2xs"
                        onClick={() => (isEditing ? setEditingId(null) : startEdit(provider))}
                      >
                        {isEditing ? <X className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        {isEditing ? t('action.cancel') : t('settings.editProvider')}
                      </button>
                      {!provider.isBuiltin ? (
                        <button
                          type="button"
                          className="lab-btn-ghost px-1.5 text-2xs text-[#FF7474]"
                          onClick={() => void deleteProvider(provider)}
                          disabled={isBusy || provider.modelCount > 0}
                          title={
                            provider.modelCount > 0 ? t('settings.deleteBlockedByModels') : t('settings.deleteProvider')
                          }
                          aria-label={t('settings.deleteProvider')}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {/* test result */}
                  {result ? (
                    <div className="border-t border-lab-border/60 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2 text-2xs">
                        {result.ok ? (
                          <Check className="h-3 w-3 text-[#B5E94B]" aria-hidden="true" />
                        ) : (
                          <X className="h-3 w-3 text-[#FF7474]" aria-hidden="true" />
                        )}
                        <span className={result.ok ? 'text-[#B5E94B]' : 'text-[#FF7474]'}>
                          {result.ok
                            ? t('settings.testSuccess', { message: result.message })
                            : t('settings.testFailed', { message: result.message })}
                        </span>
                        {result.latencyMs !== null ? (
                          <span className="text-lab-faint">{t('settings.testLatency', { ms: result.latencyMs })}</span>
                        ) : null}
                      </div>
                      {result.sampleModels.length > 0 ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {result.sampleModels.slice(0, 12).map((model) => (
                            <Pill key={model} tone="neutral">
                              {model}
                            </Pill>
                          ))}
                          {result.sampleModels.length > 12 ? (
                            <Pill tone="muted">+{result.sampleModels.length - 12}</Pill>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* discovered models */}
                  {models ? (
                    <div className="border-t border-lab-border/60 px-3 py-2">
                      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-2xs text-lab-muted">
                          {t('settings.discoveredModels', { count: models.length })}
                        </span>
                        <button
                          type="button"
                          className="lab-btn-secondary text-2xs"
                          onClick={() => void registerAll(provider)}
                          disabled={isBusy || models.every((model) => model.registered)}
                        >
                          {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                          {isBusy ? t('settings.registering') : t('settings.registerAll')}
                        </button>
                      </div>
                      <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
                        {models.slice(0, 80).map((model) => (
                          <Pill key={model.id} tone={model.registered ? 'accent' : 'neutral'}>
                            {model.registered ? <Check className="h-2.5 w-2.5" aria-hidden="true" /> : null}
                            {model.id}
                          </Pill>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* edit form */}
                  {isEditing ? (
                    <div className="border-t border-lab-border/60 bg-lab-raised/40 p-3">
                      <ProviderForm
                        value={editForm}
                        onChange={setEditForm}
                        onSubmit={() => void saveEdit(provider)}
                        submitting={saving}
                        submitLabel={t('settings.saveProvider')}
                        isEdit
                        onClearKey={provider.hasCredential ? () => void clearKey(provider) : undefined}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// form
// ---------------------------------------------------------------------------

function ProviderForm({
  value,
  onChange,
  onSubmit,
  submitting,
  submitLabel,
  error,
  showKind = false,
  isEdit = false,
  onClearKey,
}: {
  value: FormState;
  onChange: (next: FormState) => void;
  onSubmit: () => void;
  submitting: boolean;
  submitLabel: string;
  error?: string | null;
  showKind?: boolean;
  isEdit?: boolean;
  onClearKey?: () => void;
}) {
  const { t } = useI18n();
  const [advanced, setAdvanced] = useState(false);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="lab-label">{t('settings.providerName')}</span>
          <input
            type="text"
            required
            maxLength={120}
            value={value.name}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
            placeholder={t('settings.providerNameHint')}
            className="lab-input text-sm"
          />
        </label>

        {showKind ? (
          <label className="block space-y-1">
            <span className="lab-label">{t('settings.providerKind')}</span>
            <select
              value={value.kind}
              onChange={(event) => onChange({ ...value, kind: event.target.value })}
              className="lab-input appearance-none text-sm"
            >
              <option value="openai-compatible">OpenAI 兼容 / relay</option>
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="custom">Custom</option>
            </select>
            <span className="block text-2xs text-lab-faint">{t('settings.providerKindHint')}</span>
          </label>
        ) : null}
      </div>

      <label className="block space-y-1">
        <span className="lab-label">{t('settings.baseUrl')}</span>
        <input
          type="url"
          required
          maxLength={500}
          value={value.baseUrl}
          onChange={(event) => onChange({ ...value, baseUrl: event.target.value })}
          placeholder="https://api.example.com/v1"
          className="lab-input font-mono text-xs"
          spellCheck={false}
        />
        <span className="block text-2xs text-lab-faint">{t('settings.baseUrlHint')}</span>
      </label>

      <label className="block space-y-1">
        <span className="lab-label">{t('settings.apiKey')}</span>
        <input
          type="password"
          maxLength={500}
          value={value.apiKey}
          onChange={(event) => onChange({ ...value, apiKey: event.target.value })}
          placeholder={isEdit ? t('settings.apiKeyReplacePlaceholder') : t('settings.apiKeyPlaceholder')}
          className="lab-input font-mono text-xs"
          autoComplete="new-password"
          spellCheck={false}
        />
        <span className="block text-2xs text-lab-faint">{t('settings.apiKeyHint')}</span>
      </label>

      {isEdit ? (
        <>
          <button
            type="button"
            className="text-2xs text-lab-faint underline-offset-2 hover:text-lab-muted hover:underline"
            onClick={() => setAdvanced((previous) => !previous)}
          >
            <ChevronDown
              className={`mr-1 inline h-3 w-3 transition-transform ${advanced ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
            {value.enabled ? t('settings.disable') : t('settings.enable')}
          </button>
          {advanced ? (
            <label className="flex items-center gap-2 text-xs text-lab-text">
              <input
                type="checkbox"
                checked={value.enabled}
                onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
                className="h-3.5 w-3.5 accent-[#B5E94B]"
              />
              {t('settings.enabled')}
            </label>
          ) : null}
        </>
      ) : null}

      {error ? <p className="text-2xs text-[#FF7474]">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="lab-btn-primary text-xs" disabled={submitting}>
          {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          {submitting ? t('action.saving') : submitLabel}
        </button>
        {onClearKey ? (
          <button type="button" className="lab-btn-danger text-2xs" onClick={onClearKey}>
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            {t('settings.clearKey')}
          </button>
        ) : null}
      </div>
    </form>
  );
}

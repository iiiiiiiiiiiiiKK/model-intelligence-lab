import { useCallback, useEffect, useState } from 'react';
import { Lock, LogIn, LogOut } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../i18n';

/**
 * Sign-in gate.
 *
 * Renders nothing when the instance has no access token configured, so the
 * default single-machine setup is byte-for-byte the same as before this existed.
 * When a token *is* configured and there is no session, it replaces the whole app
 * with a single sign-in form: there is nothing meaningful to show behind it, and
 * every API call would fail anyway.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<'loading' | 'open' | 'locked' | 'unreachable'>('loading');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    const result = await api.authStatus();
    if (!result.ok) {
      // A 401 here means the gate is up and we have no session — which is the
      // normal locked state, not a failure worth showing as an error.
      if (result.error.code === 'UNAUTHENTICATED') {
        setState('locked');
        return;
      }
      // Anything else (backend down, network) must not silently show the app,
      // and must not pretend to be a login problem either.
      setState('unreachable');
      setError(result.error.message);
      return;
    }
    setState(result.data.required && !result.data.authenticated ? 'locked' : 'open');
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || token.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const result = await api.login(token.trim());
    setBusy(false);
    if (result.ok) {
      setToken('');
      setState('open');
      // The first render after login may have mounted pages that already asked
      // for data and got a 401, so reload once to start from a clean slate.
      window.location.reload();
      return;
    }
    setError(result.error.code === 'UNAUTHENTICATED' ? t('auth.wrongToken') : result.error.message);
  };

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-lab-page">
        <p className="text-xs text-lab-faint">{t('state.loading')}</p>
      </div>
    );
  }

  if (state === 'open') return <>{children}</>;

  if (state === 'unreachable') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-lab-page px-4">
        <div className="lab-card w-full max-w-md space-y-3 p-6">
          <h1 className="text-sm font-semibold text-lab-text">{t('auth.cannotReach')}</h1>
          <p className="text-xs text-lab-muted">{error}</p>
          <button type="button" className="lab-btn-secondary text-xs" onClick={() => void check()}>
            {t('action.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-lab-page px-4">
      <form onSubmit={submit} className="lab-card w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-lab-accent" aria-hidden="true" />
          <h1 className="text-sm font-semibold text-lab-text">{t('auth.title')}</h1>
        </div>

        <p className="text-xs leading-relaxed text-lab-muted">{t('auth.intro')}</p>

        <div className="space-y-1.5">
          <label htmlFor="access-token" className="text-2xs uppercase tracking-wide text-lab-faint">
            {t('auth.tokenLabel')}
          </label>
          <input
            id="access-token"
            type="password"
            autoComplete="current-password"
            className="lab-input"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t('auth.tokenPlaceholder')}
            autoFocus
          />
        </div>

        {error ? (
          <p role="alert" className="text-xs text-[#FF7474]">
            {error}
          </p>
        ) : null}

        <button type="submit" className="lab-btn-primary w-full justify-center text-xs" disabled={busy}>
          <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
          {busy ? t('auth.signingIn') : t('auth.signIn')}
        </button>

        <p className="text-2xs leading-relaxed text-lab-faint">{t('auth.hint')}</p>
      </form>
    </div>
  );
}

/**
 * Sign-out control for the sidebar.
 *
 * Visibility is passed in rather than fetched: the Layout already polls
 * `/api/health`, which reports `authRequired`, so a second identical request per
 * mount would be wasted work and one more thing that can fail independently.
 */
export function SignOutButton({ show }: { show: boolean }) {
  const { t } = useI18n();
  if (!show) return null;

  return (
    <button
      type="button"
      className="lab-btn-ghost w-full justify-start text-xs"
      onClick={async () => {
        await api.logout();
        window.location.reload();
      }}
    >
      <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
      {t('auth.signOut')}
    </button>
  );
}

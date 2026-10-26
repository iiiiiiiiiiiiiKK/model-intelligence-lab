import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw, ShieldAlert, WifiOff } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { ApiFailure } from '../../lib/api';

export function Spinner({ className = '' }: { className?: string }) {
  return <Loader2 className={`h-4 w-4 animate-spin ${className}`} aria-hidden="true" />;
}

export function LoadingBlock({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 px-4 py-8 text-sm text-lab-muted" role="status" aria-live="polite">
      <Spinner />
      <span>{label ?? t('state.loadingData')}</span>
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="h-9 animate-pulse rounded-lab bg-lab-hover/60"
          style={{ animationDelay: `${index * 80}ms` }}
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="rounded-full border border-lab-border bg-lab-raised p-3 text-lab-faint" aria-hidden="true">
        {icon ?? <Inbox className="h-5 w-5" />}
      </div>
      <div className="max-w-md space-y-1.5">
        <p className="text-sm font-medium text-lab-text">{title ?? t('state.noData')}</p>
        {description ? <p className="text-xs leading-relaxed text-lab-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

const FRIENDLY: Record<string, string> = {
  NETWORK_ERROR: 'state.errorNetwork',
  TIMEOUT: 'state.errorTimeout',
  FORBIDDEN: 'state.errorForbidden',
  NOT_FOUND: 'state.errorNotFound',
  PROVIDER_NOT_CONFIGURED: 'state.noCredential',
  BACKEND_UNAVAILABLE: 'state.backendUnavailable',
};

export function ErrorState({
  error,
  onRetry,
  compact = false,
}: {
  error: ApiFailure;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const friendlyKey = FRIENDLY[error.code];
  const isNetwork = error.code === 'NETWORK_ERROR';
  const isForbidden = error.code === 'FORBIDDEN';
  const Icon = isNetwork ? WifiOff : isForbidden ? ShieldAlert : AlertTriangle;

  return (
    <div
      className={`flex flex-col items-start gap-3 rounded-lab border border-lab-danger/30 bg-lab-danger/5 ${
        compact ? 'px-3 py-2.5' : 'px-4 py-5'
      }`}
      role="alert"
    >
      <div className="flex w-full items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-lab-danger" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium text-lab-text">{t('state.error')}</p>
          <p className="break-words text-xs leading-relaxed text-lab-muted">
            {friendlyKey ? t(friendlyKey as never) : error.message}
          </p>
          {error.code && error.code !== 'NETWORK_ERROR' ? (
            <p className="font-mono text-2xs text-lab-faint">{error.code}</p>
          ) : null}
        </div>
        {onRetry && error.retryable ? (
          <button type="button" className="lab-btn-secondary shrink-0 text-xs" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('action.retry')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Wraps a data region and picks the right visual state. */
export function DataState<T>({
  state,
  children,
  emptyWhen,
  empty,
  skeletonRows = 4,
}: {
  state: { data: T | null; error: ApiFailure | null; loading: boolean; initialLoading: boolean; reload: () => void };
  children: (data: T) => ReactNode;
  emptyWhen?: (data: T) => boolean;
  empty?: ReactNode;
  skeletonRows?: number;
}) {
  if (state.error && !state.data) {
    return <ErrorState error={state.error} onRetry={state.reload} />;
  }
  if (state.initialLoading && !state.data) {
    return <SkeletonRows rows={skeletonRows} />;
  }
  if (!state.data) {
    return <>{empty ?? <EmptyState />}</>;
  }
  if (emptyWhen?.(state.data) && empty) {
    return <>{empty}</>;
  }
  return <>{children(state.data)}</>;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiFailure, ApiResult } from '../lib/api';

export interface AsyncState<T> {
  data: T | null;
  error: ApiFailure | null;
  loading: boolean;
  /** True only on the very first load, so we can show a skeleton instead of a spinner. */
  initialLoading: boolean;
  reload: () => void;
  setData: (updater: T | ((previous: T | null) => T | null)) => void;
}

/**
 * Small data-fetching hook with explicit loading/error/reload state.
 * Request identity is tracked so a slow earlier response cannot overwrite a
 * newer one (the classic stale-response bug).
 */
export function useApi<T>(fetcher: () => Promise<ApiResult<T>>, deps: unknown[] = []): AsyncState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const requestId = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const current = ++requestId.current;
    let cancelled = false;
    setLoading(true);

    void fetcherRef.current().then((result) => {
      if (cancelled || current !== requestId.current) return;
      if (result.ok) {
        setDataState(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
      setLoading(false);
      setInitialLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const setData = useCallback((updater: T | ((previous: T | null) => T | null)) => {
    setDataState((previous) =>
      typeof updater === 'function' ? (updater as (p: T | null) => T | null)(previous) : updater,
    );
  }, []);

  return { data, error, loading, initialLoading, reload, setData };
}

/** Polls an endpoint on an interval, pausing while the tab is hidden. */
export function usePolling(callback: () => void, intervalMs: number | null): void {
  const saved = useRef(callback);
  saved.current = callback;

  useEffect(() => {
    if (intervalMs === null) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => saved.current(), intervalMs);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        saved.current();
        start();
      }
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { zh } from './zh';
import { en } from './en';
import type { Locale } from '../../shared/types';

export type MessageKey = keyof typeof zh;

const CATALOGS: Record<Locale, Record<MessageKey, string>> = { 'zh-CN': zh, en };

const STORAGE_KEY = 'model-lab.locale';
const DEFAULT_LOCALE: Locale = 'zh-CN';

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Raw key lookup that falls back to the key, for dynamic keys from the API. */
  tf: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function readStoredLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en') return stored;
  } catch {
    /* localStorage unavailable (private mode) — fall back to the default */
  }
  return null;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // Locale lives in React state, so switching it re-renders the tree without
  // unmounting it. In-flight runs, form values and selections are preserved.
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale() ?? DEFAULT_LOCALE);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, [locale]);

  // Keep the server-side user setting in sync without ever blocking the UI.
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    void fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: next }),
    }).catch(() => {
      /* The local preference is authoritative for the UI; a failed sync is not fatal. */
    });
  }, []);

  const value = useMemo<I18nValue>(() => {
    const catalog = CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE];
    const lookup = (key: string): string =>
      (catalog as Record<string, string>)[key] ?? (CATALOGS[DEFAULT_LOCALE] as Record<string, string>)[key] ?? key;
    return {
      locale,
      setLocale,
      t: (key, vars) => interpolate(lookup(key), vars),
      tf: (key, vars) => interpolate(lookup(key), vars),
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>');
  return context;
}

export { DEFAULT_LOCALE };

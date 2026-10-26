/**
 * Locale-aware formatting helpers.
 *
 * Model IDs, code, hashes and raw model output are *never* localized — they are
 * passed through verbatim. Only dates, numbers and percentages go through
 * Intl with the active locale.
 */
import type { Locale } from '../../shared/types';

const INTL_LOCALE: Record<Locale, string> = {
  'zh-CN': 'zh-CN',
  en: 'en-US',
};

export function formatDate(iso: string | null, locale: Locale): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatDateShort(iso: string | null, locale: Locale): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatNumber(value: number | null, locale: Locale, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Scores are shown as 0–1 with three decimals, plus an optional percent view. */
export function formatScore(value: number | null, locale: Locale, digits = 3): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatPercent(value: number | null, locale: Locale, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatCurrencyUsd(value: number | null, locale: Locale): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const digits = value > 0 && value < 0.01 ? 5 : value < 1 ? 4 : 2;
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatLatency(ms: number | null, locale: Locale): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${formatNumber(Math.round(ms), locale)} ms`;
  return `${formatNumber(ms / 1000, locale, 2)} s`;
}

export function formatTokens(value: number | null, locale: Locale): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 1000) return formatNumber(value, locale);
  return `${formatNumber(value / 1000, locale, 1)}k`;
}

export function formatSigned(value: number | null, locale: Locale, digits = 3): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const formatted = formatNumber(Math.abs(value), locale, digits);
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `−${formatted}`;
  return formatted;
}

/** Truncates long model output for table cells without altering stored data. */
export function truncateText(value: string | null, max = 160): string {
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

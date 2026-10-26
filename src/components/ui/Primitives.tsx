import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type {
  BenchmarkDimension,
  EvaluationStatus,
  RegressionConclusion,
  ScorerType,
} from '../../../shared/types';

// ---------------------------------------------------------------------------
// Demo badge — always visible, never passive text.
// ---------------------------------------------------------------------------

export function DemoBadge({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border border-[#C79BF2]/40 bg-[#C79BF2]/10 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-[#C79BF2] ${className}`}
      title={t('demo.excluded')}
    >
      {t('demo.badge')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Demo banner
// ---------------------------------------------------------------------------

export function DemoRunBanner() {
  const { t } = useI18n();
  return (
    <div className="flex items-start gap-3 rounded-lab border border-[#C79BF2]/30 bg-[#C79BF2]/[0.06] px-3.5 py-3">
      <span className="mt-0.5 shrink-0">
        <DemoBadge />
      </span>
      <p className="text-xs leading-relaxed text-lab-muted">{t('demo.banner')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic pill
// ---------------------------------------------------------------------------

type Tone = 'neutral' | 'accent' | 'cyan' | 'warn' | 'danger' | 'demo' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-lab-border bg-lab-raised text-lab-muted',
  accent: 'border-[#B5E94B]/40 bg-[#B5E94B]/10 text-[#B5E94B]',
  cyan: 'border-[#5DDBCA]/40 bg-[#5DDBCA]/10 text-[#5DDBCA]',
  warn: 'border-[#F3B66D]/40 bg-[#F3B66D]/10 text-[#F3B66D]',
  danger: 'border-[#FF7474]/40 bg-[#FF7474]/12 text-[#FF7474]',
  demo: 'border-[#C79BF2]/40 bg-[#C79BF2]/10 text-[#C79BF2]',
  muted: 'border-transparent bg-transparent text-lab-faint',
};

export function Pill({
  children,
  tone = 'neutral',
  className = '',
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-2xs font-medium ${TONE_CLASS[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<EvaluationStatus, Tone> = {
  draft: 'neutral',
  queued: 'warn',
  running: 'cyan',
  completed: 'accent',
  'partial-failure': 'warn',
  failed: 'danger',
  cancelled: 'muted',
};

const STATUS_KEY: Record<EvaluationStatus, string> = {
  draft: 'state.draft',
  queued: 'state.queued',
  running: 'state.running',
  completed: 'state.completed',
  'partial-failure': 'state.partialFailure',
  failed: 'state.failed',
  cancelled: 'state.cancelled',
};

export function StatusBadge({ status }: { status: EvaluationStatus }) {
  const { t } = useI18n();
  return (
    <Pill tone={STATUS_TONE[status] ?? 'neutral'}>
      {status === 'running' ? (
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#5DDBCA] opacity-70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#5DDBCA]" />
        </span>
      ) : null}
      {t(STATUS_KEY[status] as never)}
    </Pill>
  );
}

// ---------------------------------------------------------------------------
// Conclusion
// ---------------------------------------------------------------------------

const CONCLUSION_TONE: Record<RegressionConclusion, Tone> = {
  'significant-regression': 'danger',
  'significant-improvement': 'accent',
  'no-significant-change': 'neutral',
  inconclusive: 'warn',
  'not-comparable': 'warn',
  'insufficient-data': 'muted',
  'execution-failed': 'danger',
};

export function ConclusionBadge({
  conclusion,
  large = false,
}: {
  conclusion: RegressionConclusion;
  large?: boolean;
}) {
  const { t } = useI18n();
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-2 py-0.5 font-medium ${TONE_CLASS[CONCLUSION_TONE[conclusion]]} ${
        large ? 'text-xs' : 'text-2xs'
      }`}
    >
      {t(`conclusion.${conclusion}` as never)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Dimension
// ---------------------------------------------------------------------------

export function DimensionLabel({ dimension }: { dimension: BenchmarkDimension | null }) {
  const { t } = useI18n();
  if (!dimension) return <span className="text-lab-muted">{t('misc.total')}</span>;
  return <span>{t(`dimension.${dimension}` as never)}</span>;
}

export function ScorerLabel({ type }: { type: ScorerType }) {
  const { t } = useI18n();
  return <span>{t(`scorer.${type}` as never)}</span>;
}

// ---------------------------------------------------------------------------
// Score display
// ---------------------------------------------------------------------------

export function ScoreBar({
  value,
  label,
  compare,
  max = 1,
}: {
  value: number | null;
  label?: string;
  compare?: number | null;
  max?: number;
}) {
  const pct = value === null ? 0 : Math.max(0, Math.min(1, value / max)) * 100;
  const comparePct = compare == null ? null : Math.max(0, Math.min(1, compare / max)) * 100;
  const tone =
    value === null
      ? 'bg-lab-faint/30'
      : value >= 0.8
        ? 'bg-[#B5E94B]'
        : value >= 0.5
          ? 'bg-[#5DDBCA]'
          : 'bg-[#F3B66D]';

  return (
    <div className="space-y-1">
      {label ? <div className="text-2xs text-lab-muted">{label}</div> : null}
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-lab-hover">
        <div className={`h-full rounded-full transition-[width] duration-300 ${tone}`} style={{ width: `${pct}%` }} />
        {comparePct !== null ? (
          <div
            className="absolute top-0 h-full w-px bg-lab-text/60"
            style={{ left: `${comparePct}%` }}
            title={`baseline ${compare}`}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  badge,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 border-b border-lab-border pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-lab-text sm:text-2xl">{title}</h1>
          {badge}
        </div>
        {description ? <p className="max-w-2xl text-sm leading-relaxed text-lab-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className = '',
  bare = false,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bare?: boolean;
}) {
  return (
    <section className={`${bare ? '' : 'lab-card'} ${className}`}>
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-lab-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-lab-text">{title}</h2>
            {description ? <p className="mt-0.5 text-xs leading-relaxed text-lab-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={title ? 'p-4' : 'p-4'}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'accent' | 'cyan' | 'warn' | 'danger' | 'muted';
}) {
  const valueTone =
    tone === 'accent'
      ? 'text-[#B5E94B]'
      : tone === 'cyan'
        ? 'text-[#5DDBCA]'
        : tone === 'warn'
          ? 'text-[#F3B66D]'
          : tone === 'danger'
            ? 'text-[#FF7474]'
            : tone === 'muted'
              ? 'text-lab-faint'
              : 'text-lab-text';

  return (
    <div className="lab-card px-4 py-3.5">
      <div className="lab-label">{label}</div>
      <div className={`mt-1.5 font-mono text-2xl font-semibold leading-none tracking-tight ${valueTone}`}>
        {value}
      </div>
      {hint ? <div className="mt-1.5 text-2xs leading-snug text-lab-faint">{hint}</div> : null}
    </div>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-2xs text-lab-faint sm:w-40 sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-lab-text">{children}</dd>
    </div>
  );
}

export function Callout({
  tone = 'neutral',
  title,
  children,
  icon,
}: {
  tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'demo';
  title?: string;
  children: ReactNode;
  icon?: ReactNode;
}) {
  const styles: Record<string, string> = {
    neutral: 'border-lab-border bg-lab-raised',
    accent: 'border-[#B5E94B]/30 bg-[#B5E94B]/[0.06]',
    warn: 'border-[#F3B66D]/30 bg-[#F3B66D]/[0.06]',
    danger: 'border-[#FF7474]/30 bg-[#FF7474]/[0.06]',
    demo: 'border-[#C79BF2]/30 bg-[#C79BF2]/[0.06]',
  };
  return (
    <div className={`flex items-start gap-3 rounded-lab border px-3.5 py-3 ${styles[tone]}`}>
      {icon ? <div className="mt-0.5 shrink-0 text-lab-muted">{icon}</div> : null}
      <div className="min-w-0 space-y-1 text-xs leading-relaxed text-lab-muted">
        {title ? <p className="text-sm font-medium text-lab-text">{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

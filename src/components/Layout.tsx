import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { SignOutButton } from './AuthGate';
import {
  Activity,
  BarChart3,
  Beaker,
  BookOpen,
  Library,
  ChevronLeft,
  FlaskConical,
  Globe,
  Home,
  Menu,
  Scale,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import type { HealthStatus } from '../../shared/types';

interface NavItem {
  to: string;
  labelKey: string;
  icon: typeof Home;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', labelKey: 'nav.home', icon: Home, end: true },
  { to: '/models', labelKey: 'nav.models', icon: BarChart3 },
  { to: '/compare', labelKey: 'nav.compare', icon: Scale },
  { to: '/lab', labelKey: 'nav.lab', icon: FlaskConical },
  { to: '/monitor', labelKey: 'nav.monitor', icon: Activity },
  { to: '/catalog', labelKey: 'nav.catalog', icon: Library },
  { to: '/benchmarks', labelKey: 'nav.benchmarks', icon: BookOpen },
  { to: '/reports', labelKey: 'nav.reports', icon: Beaker },
  { to: '/community', labelKey: 'nav.community', icon: Globe },
  { to: '/settings', labelKey: 'nav.settings', icon: SettingsIcon },
];

const COLLAPSE_KEY = 'model-lab.nav-collapsed';

function useHealth() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  useEffect(() => {
    let mounted = true;
    const load = () => {
      void api.health().then((result) => {
        if (!mounted) return;
        if (result.ok) setHealth(result.data);
        else setHealth(null);
      });
    };
    load();
    const timer = setInterval(load, 45000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);
  return health;
}

function LanguageSwitch({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="flex items-center gap-1 rounded-lab border border-lab-border bg-lab-raised p-0.5" role="group" aria-label={t('lang.label')}>
      <Globe className="ml-1.5 h-3.5 w-3.5 shrink-0 text-lab-faint" aria-hidden="true" />
      {(['zh-CN', 'en'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setLocale(option)}
          aria-pressed={locale === option}
          aria-label={t('lang.switchTo', { lang: option === 'zh-CN' ? t('lang.zh') : t('lang.en') })}
          className={`rounded-sm px-2 py-1 text-2xs font-medium transition-colors duration-fast ${
            locale === option
              ? 'bg-[#B5E94B]/15 text-[#B5E94B]'
              : 'text-lab-muted hover:bg-lab-hover hover:text-lab-text'
          }`}
          title={t('lang.switchTo', { lang: option === 'zh-CN' ? t('lang.zh') : t('lang.en') })}
        >
          {compact ? (option === 'zh-CN' ? '中' : 'EN') : option === 'zh-CN' ? t('lang.zh') : t('lang.en')}
        </button>
      ))}
    </div>
  );
}

function HealthDot({ health }: { health: HealthStatus | null }) {
  const { t } = useI18n();
  const state = !health ? 'down' : health.status;
  const color = state === 'ok' ? 'bg-[#B5E94B]' : state === 'degraded' ? 'bg-[#F3B66D]' : 'bg-[#FF7474]';
  const label =
    state === 'ok'
      ? 'API OK'
      : state === 'degraded'
        ? t('state.noCredential')
        : t('state.offline');
  return (
    <div className="flex items-center gap-1.5" title={`${label} · ${health?.version ?? ''}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} aria-hidden="true" />
      <span className="text-2xs text-lab-faint">{label}</span>
    </div>
  );
}

export default function Layout() {
  const { t } = useI18n();
  const location = useLocation();
  const health = useHealth();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Trap scroll behind the mobile drawer.
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mobileOpen]);

  const navItems = useMemo(() => NAV, []);

  return (
    <div className="relative z-10 flex min-h-screen bg-lab-bg text-lab-text">
      {/* desktop sidebar */}
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-lab-border bg-lab-surface transition-[width] duration-200 md:flex ${
          collapsed ? 'w-[68px]' : 'w-[220px]'
        }`}
      >
        <div className={`flex h-14 items-center gap-2 border-b border-lab-border ${collapsed ? 'justify-center px-2' : 'px-4'}`}>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lab border border-[#B5E94B]/30 bg-[#B5E94B]/10">
            <FlaskConical className="h-3.5 w-3.5 text-[#B5E94B]" aria-hidden="true" />
          </div>
          {!collapsed ? (
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold leading-tight text-lab-text">{t('app.name')}</div>
              <div className="truncate font-mono text-[10px] leading-tight text-lab-faint">model-lab</div>
            </div>
          ) : null}
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label={t('nav.primary')}>
          <ul className="space-y-0.5">
            {navItems.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `group flex items-center gap-2.5 rounded-lab px-2.5 py-2 text-sm transition-colors duration-fast ${
                      isActive
                        ? 'bg-[#B5E94B]/10 text-[#B5E94B]'
                        : 'text-lab-muted hover:bg-lab-hover hover:text-lab-text'
                    } ${collapsed ? 'justify-center' : ''}`
                  }
                  title={collapsed ? t(item.labelKey as never) : undefined}
                >
                  <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {!collapsed ? <span className="truncate">{t(item.labelKey as never)}</span> : null}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className={`border-t border-lab-border p-2 ${collapsed ? 'space-y-2' : 'space-y-2.5'}`}>
          {!collapsed ? <LanguageSwitch /> : <LanguageSwitch compact />}
          {!collapsed ? <SignOutButton show={health?.authRequired === true} /> : null}
          <div className={collapsed ? 'flex justify-center' : 'flex items-center justify-between px-1'}>
            <HealthDot health={health} />
            <button
              type="button"
              onClick={() => setCollapsed((value) => !value)}
              className="rounded-sm p-1 text-lab-faint hover:bg-lab-hover hover:text-lab-text"
              aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
              title={collapsed ? t('nav.expand') : t('nav.collapse')}
            >
              <ChevronLeft className={`h-3.5 w-3.5 transition-transform ${collapsed ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>

      {/* mobile top bar */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-lab-border bg-lab-surface/95 px-3 backdrop-blur md:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-lab border border-lab-border p-1.5 text-lab-muted hover:bg-lab-hover hover:text-lab-text"
            aria-label={t('nav.openMenu')}
            aria-expanded={mobileOpen}
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FlaskConical className="h-4 w-4 shrink-0 text-[#B5E94B]" aria-hidden="true" />
            <span className="truncate text-sm font-semibold">{t('app.name')}</span>
          </div>
          <LanguageSwitch compact />
        </header>

        {/* mobile drawer */}
        {mobileOpen ? (
          <div className="fixed inset-0 z-50 md:hidden">
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => setMobileOpen(false)}
              aria-hidden="true"
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t('nav.primary')}
              className="absolute inset-y-0 left-0 flex w-[268px] max-w-[86vw] flex-col border-r border-lab-border bg-lab-surface"
            >
              <div className="flex h-14 items-center justify-between border-b border-lab-border px-3">
                <div className="flex items-center gap-2">
                  <FlaskConical className="h-4 w-4 text-[#B5E94B]" aria-hidden="true" />
                  <span className="text-sm font-semibold">{t('app.name')}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileOpen(false)}
                  className="rounded-sm p-1.5 text-lab-muted hover:bg-lab-hover hover:text-lab-text"
                  aria-label={t('nav.closeMenu')}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label={t('nav.primary')}>
                <ul className="space-y-0.5">
                  {navItems.map((item) => (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.end}
                        onClick={() => setMobileOpen(false)}
                        className={({ isActive }) =>
                          `flex items-center gap-2.5 rounded-lab px-3 py-2.5 text-sm transition-colors ${
                            isActive
                              ? 'bg-[#B5E94B]/10 text-[#B5E94B]'
                              : 'text-lab-muted hover:bg-lab-hover hover:text-lab-text'
                          }`
                        }
                      >
                        <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">{t(item.labelKey as never)}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="border-t border-lab-border p-3">
                <LanguageSwitch />
                <div className="mt-2.5 space-y-1.5">
                  <HealthDot health={health} />
                  <SignOutButton show={health?.authRequired === true} />
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <main className="min-w-0 flex-1 px-3 py-5 sm:px-5 sm:py-6 lg:px-7">
          <div className="mx-auto w-full max-w-[1440px]">
            <Outlet />
          </div>
        </main>

        <footer className="border-t border-lab-border px-3 py-4 text-2xs text-lab-faint sm:px-5 lg:px-7">
          <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {t('app.name')} · {t('misc.version', { version: health?.version ?? '0.1.0' })}
            </span>
            <span>{t('misc.footer')}</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

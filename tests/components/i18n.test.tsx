import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider, useI18n } from '../../src/i18n';
import { formatDate, formatScore, formatPercent } from '../../src/lib/format';

const FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true } as const;
const DASH = '\u2014';

function LocaleProbe() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="home-label">{t('nav.home')}</span>
      <span data-testid="run-label">{t('action.runEvaluation')}</span>
      <span data-testid="empty-label">{t('state.noData')}</span>
      <span data-testid="interpolated">{t('misc.ofTotal', { total: 7 })}</span>
      <button type="button" onClick={() => setLocale('zh-CN')}>
        set-zh
      </button>
      <button type="button" onClick={() => setLocale('en')}>
        set-en
      </button>
    </div>
  );
}

function MissingKeyProbe() {
  const { tf } = useI18n();
  return <span data-testid="missing">{tf('totally.unknown.key')}</span>;
}

function StatefulProbe() {
  const { setLocale } = useI18n();
  const [value, setValue] = useState('');
  const [switches, setSwitches] = useState(0);

  return (
    <div>
      <input aria-label="input" value={value} onChange={(event) => setValue(event.target.value)} />
      <span data-testid="switch-count">{switches}</span>
      <button
        type="button"
        onClick={() => {
          setLocale('en');
          setSwitches((count) => count + 1);
        }}
      >
        switch
      </button>
    </div>
  );
}

function renderProbe() {
  return render(
    <MemoryRouter future={FUTURE}>
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('i18n', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // The provider syncs the locale to the server; keep that call inert but real.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ settings: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to Simplified Chinese on first visit', () => {
    renderProbe();
    expect(screen.getByTestId('locale').textContent).toBe('zh-CN');
    expect(screen.getByTestId('home-label').textContent).toBe('首页');
    expect(screen.getByTestId('empty-label').textContent).toBe('暂无数据');
  });

  it('switches every label to English', async () => {
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByText('set-en'));

    expect(screen.getByTestId('locale').textContent).toBe('en');
    expect(screen.getByTestId('home-label').textContent).toBe('Overview');
    expect(screen.getByTestId('run-label').textContent).toBe('Run Evaluation');
    expect(screen.getByTestId('empty-label').textContent).toBe('No Data Available');
    // Interpolated messages keep their substitution after a switch.
    expect(screen.getByTestId('interpolated').textContent).toBe('7 total');
  });

  it('persists the choice to localStorage', async () => {
    const user = userEvent.setup();
    renderProbe();
    await user.click(screen.getByText('set-en'));
    await waitFor(() => expect(window.localStorage.getItem('model-lab.locale')).toBe('en'));
  });

  it('restores a stored locale on mount', () => {
    window.localStorage.setItem('model-lab.locale', 'en');
    renderProbe();
    expect(screen.getByTestId('locale').textContent).toBe('en');
    expect(screen.getByTestId('home-label').textContent).toBe('Overview');
  });

  it('ignores an unsupported stored locale', () => {
    window.localStorage.setItem('model-lab.locale', 'fr');
    renderProbe();
    expect(screen.getByTestId('locale').textContent).toBe('zh-CN');
  });

  it('sets the document lang attribute', async () => {
    const user = userEvent.setup();
    renderProbe();
    await user.click(screen.getByText('set-en'));
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
  });

  it('syncs the locale to the server without blocking the UI', async () => {
    const user = userEvent.setup();
    renderProbe();
    await user.click(screen.getByText('set-en'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(init?.body)).toContain('"language":"en"');
  });

  it('falls back to the key when a message is missing', () => {
    window.localStorage.setItem('model-lab.locale', 'en');
    render(
      <MemoryRouter future={FUTURE}>
        <I18nProvider>
          <MissingKeyProbe />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('missing').textContent).toBe('totally.unknown.key');
  });

  it('keeps component state across a locale switch', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter future={FUTURE}>
        <I18nProvider>
          <StatefulProbe />
        </I18nProvider>
      </MemoryRouter>,
    );

    const input = screen.getByLabelText('input');
    await user.type(input, 'kept value');
    expect((input as HTMLInputElement).value).toBe('kept value');

    await user.click(screen.getByText('switch'));

    // Same DOM node, same value: the tree re-rendered, it was not remounted.
    const after = screen.getByLabelText('input') as HTMLInputElement;
    expect(after.value).toBe('kept value');
    expect(screen.getByTestId('switch-count').textContent).toBe('1');
  });

  it('only talks to the settings endpoint when the locale changes', async () => {
    const user = userEvent.setup();
    renderProbe();
    await user.click(screen.getByText('set-en'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    // A locale switch must never create an evaluation or a report.
    const urls = vi.mocked(globalThis.fetch).mock.calls.map(([input]) => String(input));
    expect(urls.every((url) => url.includes('/api/settings'))).toBe(true);
  });
});

describe('message catalog parity', () => {
  it('has the same key set in both languages', async () => {
    const { zh } = await import('../../src/i18n/zh');
    const { en } = await import('../../src/i18n/en');
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('has no empty message values', async () => {
    const { zh } = await import('../../src/i18n/zh');
    const { en } = await import('../../src/i18n/en');
    for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) {
      expect(String(value).trim().length, `empty message for ${key}`).toBeGreaterThan(0);
    }
  });

  it('covers every navigation entry in both languages', async () => {
    const { zh } = await import('../../src/i18n/zh');
    const { en } = await import('../../src/i18n/en');
    const navKeys = Object.keys(zh).filter((key) => key.startsWith('nav.'));
    expect(navKeys.length).toBeGreaterThanOrEqual(9);
    for (const key of navKeys) {
      expect((zh as Record<string, string>)[key]).toBeTruthy();
      expect((en as Record<string, string>)[key]).toBeTruthy();
    }
  });

  it('translates every dimension and conclusion label', async () => {
    const { zh } = await import('../../src/i18n/zh');
    const { en } = await import('../../src/i18n/en');
    const required = [
      'dimension.reasoning',
      'dimension.coding',
      'dimension.instruction-following',
      'dimension.factuality',
      'dimension.stability',
      'dimension.behavior',
      'conclusion.significant-regression',
      'conclusion.significant-improvement',
      'conclusion.no-significant-change',
      'conclusion.inconclusive',
      'conclusion.not-comparable',
      'conclusion.insufficient-data',
      'conclusion.execution-failed',
    ];
    for (const key of required) {
      expect((zh as Record<string, string>)[key], key).toBeTruthy();
      expect((en as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});

describe('locale-aware formatting', () => {
  it('formats scores with a fixed number of decimals', () => {
    expect(formatScore(0.8123, 'en', 3)).toBe('0.812');
    expect(formatScore(null, 'en')).toBe(DASH);
  });

  it('formats percentages per locale', () => {
    expect(formatPercent(0.5, 'en', 0)).toBe('50%');
    expect(formatPercent(0.5, 'zh-CN', 0)).toContain('50');
  });

  it('formats dates without throwing on bad input', () => {
    expect(formatDate(null, 'zh-CN')).toBe(DASH);
    expect(formatDate('not-a-date', 'en')).toBe(DASH);
    expect(formatDate('2024-05-01T10:00:00.000Z', 'en')).toMatch(/2024/);
  });
});

describe('routing shell', () => {
  it('renders the matching route only', () => {
    render(
      <MemoryRouter initialEntries={['/settings']} future={FUTURE}>
        <Routes>
          <Route path="/" element={<div>home page</div>} />
          <Route path="/settings" element={<div>settings page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('settings page')).toBeInTheDocument();
    expect(screen.queryByText('home page')).not.toBeInTheDocument();
  });
});

describe('table accessibility', () => {
  it('exposes captions and headers in rendered tables', () => {
    render(
      <table>
        <caption>Models</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>GPT</td>
          </tr>
        </tbody>
      </table>,
    );
    const table = screen.getByRole('table');
    expect(within(table).getByText('Models')).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
  });
});

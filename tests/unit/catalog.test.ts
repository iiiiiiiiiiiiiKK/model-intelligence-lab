// @vitest-environment node
/**
 * Catalog selection and matching.
 *
 * The selector decides what a user sees when they browse for a model, so it is
 * tested against a synthetic payload that exercises every rule: variant suffixes,
 * non-chat output, mirror vendors, per-vendor caps and ranking preference for
 * third-party-scored models.
 */
import { describe, expect, it } from 'vitest';
import {
  isChatModel,
  isVariant,
  rankScore,
  selectCatalog,
  toCatalogEntry,
  vendorOf,
  VENDOR_CAPS,
} from '../../server/catalog/select';
import { matchCatalogEntry, normalizeModelName } from '../../server/catalog/match';

const model = (overrides: Record<string, unknown> = {}) => ({
  id: 'openai/gpt-test',
  name: 'OpenAI: GPT Test',
  created: 1_700_000_000,
  context_length: 128000,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: '0.000002', completion: '0.00001' },
  ...overrides,
});

describe('model predicates', () => {
  it('treats text-output models as chat models', () => {
    expect(isChatModel(model())).toBe(true);
  });

  it('rejects image-only output', () => {
    expect(
      isChatModel({ architecture: { output_modalities: ['image'] } }),
    ).toBe(false);
  });

  it('assumes chat when the field is missing', () => {
    expect(isChatModel({})).toBe(true);
  });

  it('detects deployment variants', () => {
    expect(isVariant('openai/gpt-x:batch')).toBe(true);
    expect(isVariant('openai/gpt-x:free')).toBe(true);
    expect(isVariant('openai/gpt-x:thinking')).toBe(true);
    expect(isVariant('openai/gpt-x')).toBe(false);
    // A colon that is part of a model version is not a variant marker.
    expect(isVariant('deepseek/deepseek-v4.1-flash-1017')).toBe(false);
  });

  it('extracts the vendor slug', () => {
    expect(vendorOf('anthropic/claude-x')).toBe('anthropic');
    expect(vendorOf('no-slash')).toBe('other');
  });
});

describe('toCatalogEntry', () => {
  it('converts per-token prices to per-million', () => {
    const entry = toCatalogEntry(model())!;
    expect(entry.inputPerMillion).toBeCloseTo(2, 6);
    expect(entry.outputPerMillion).toBeCloseTo(10, 6);
  });

  it('keeps null when pricing is absent', () => {
    const entry = toCatalogEntry(model({ pricing: undefined }))!;
    expect(entry.inputPerMillion).toBeNull();
    expect(entry.outputPerMillion).toBeNull();
  });

  it('picks the general arena Elo when present', () => {
    const entry = toCatalogEntry(
      model({
        benchmarks: {
          design_arena: [
            { arena: 'models', category: 'codecategories', elo: 1300 },
            { arena: 'models', category: 'overall', elo: 1400 },
          ],
        },
      }),
    )!;
    expect(entry.arenaElo).toBe(1400);
    expect(entry.arenaCategories).toHaveLength(2);
  });

  it('falls back to the best category when no overall arena exists', () => {
    const entry = toCatalogEntry(
      model({
        benchmarks: { design_arena: [{ arena: 'models', category: 'website', elo: 1350 }] },
      }),
    )!;
    expect(entry.arenaElo).toBe(1350);
  });

  it('returns null Elo when no arena data exists', () => {
    expect(toCatalogEntry(model())!.arenaElo).toBeNull();
  });

  it('reads the Artificial Analysis indices', () => {
    const entry = toCatalogEntry(
      model({
        benchmarks: {
          artificial_analysis: { intelligence_index: 55.1, coding_index: 48, agentic_index: 40 },
        },
      }),
    )!;
    expect(entry.aaIntelligenceIndex).toBe(55.1);
    expect(entry.aaCodingIndex).toBe(48);
    expect(entry.aaAgenticIndex).toBe(40);
  });

  it('rejects a row without an id', () => {
    expect(toCatalogEntry({ name: 'no id' })).toBeNull();
  });
});

describe('rankScore', () => {
  it('prefers a model with a higher index', () => {
    const a = toCatalogEntry(model({ id: 'openai/a', benchmarks: { artificial_analysis: { intelligence_index: 50 } } }))!;
    const b = toCatalogEntry(model({ id: 'openai/b', benchmarks: { artificial_analysis: { intelligence_index: 30 } } }))!;
    expect(rankScore(a)).toBeGreaterThan(rankScore(b));
  });

  it('uses Elo as a secondary signal', () => {
    const a = toCatalogEntry(model({ id: 'openai/a', benchmarks: { design_arena: [{ arena: 'models', category: 'overall', elo: 1450 }] } }))!;
    const b = toCatalogEntry(model({ id: 'openai/b', benchmarks: { design_arena: [{ arena: 'models', category: 'overall', elo: 1200 }] } }))!;
    expect(rankScore(a)).toBeGreaterThan(rankScore(b));
  });

  it('never throws on missing data', () => {
    const entry = toCatalogEntry(model({ created: undefined, pricing: undefined }))!;
    expect(Number.isFinite(rankScore(entry))).toBe(true);
  });
});

describe('selectCatalog', () => {
  const payload = {
    data: [
      model({ id: 'openai/gpt-a', benchmarks: { artificial_analysis: { intelligence_index: 50 } } }),
      model({ id: 'openai/gpt-a:batch' }), // variant
      model({ id: 'openai/gpt-b', benchmarks: { artificial_analysis: { intelligence_index: 40 } } }),
      model({ id: '~openai/gpt-c' }), // mirror
      model({ id: 'unknownvendor/x' }), // vendor not in the allow-list
      model({ id: 'anthropic/claude-a', benchmarks: { artificial_analysis: { intelligence_index: 55 } } }),
      model({ id: 'image/only', architecture: { output_modalities: ['image'] } }),
    ],
  };

  it('keeps only allow-listed vendors', () => {
    const { selected } = selectCatalog(payload);
    expect(selected.map((entry) => entry.id).sort()).toEqual(['anthropic/claude-a', 'openai/gpt-a', 'openai/gpt-b']);
  });

  it('counts what it skipped', () => {
    const { skipped } = selectCatalog(payload);
    expect(skipped.variants).toBe(1);
    expect(skipped.mirror).toBe(1);
    expect(skipped.nonChat).toBe(1);
  });

  it('orders higher-ranked models first inside a vendor', () => {
    const { selected } = selectCatalog(payload);
    const openai = selected.filter((entry) => entry.vendor === 'openai');
    expect(openai[0].id).toBe('openai/gpt-a');
  });

  it('respects the per-vendor cap', () => {
    const many = {
      data: Array.from({ length: 40 }, (_, index) =>
        model({ id: `openai/m${index}`, benchmarks: { artificial_analysis: { intelligence_index: index } } }),
      ),
    };
    const { selected } = selectCatalog(many);
    const cap = VENDOR_CAPS.find((entry) => entry.vendor === 'openai')!.cap;
    expect(selected).toHaveLength(cap);
    // The highest-index models survive.
    expect(selected[0].id).toBe('openai/m39');
  });

  it('handles an empty payload', () => {
    const { selected, skipped } = selectCatalog({});
    expect(selected).toHaveLength(0);
    expect(skipped.variants).toBe(0);
  });

  it('produces deterministic output for the same input', () => {
    const a = selectCatalog(payload).selected.map((entry) => entry.id);
    const b = selectCatalog(payload).selected.map((entry) => entry.id);
    expect(a).toEqual(b);
  });
});

describe('catalog matching', () => {
  const index = [
    { modelRef: 'anthropic/claude-sonnet-5.5', vendor: 'anthropic', name: 'Anthropic: Claude Sonnet 5.5' },
    { modelRef: 'deepseek/deepseek-v4.1-flash', vendor: 'deepseek', name: 'DeepSeek: V4.1 Flash' },
    { modelRef: 'openai/gpt-4o-mini', vendor: 'openai', name: 'OpenAI: GPT-4o mini' },
  ];

  it('normalizes vendor prefixes, separators and decorations', () => {
    expect(normalizeModelName('Anthropic: Claude Sonnet 5.5')).toBe(normalizeModelName('claude-sonnet-5.5'));
    expect(normalizeModelName('openai/gpt-4o-mini')).toBe(normalizeModelName('gpt-4o-mini'));
  });

  it('matches an exact full reference', () => {
    expect(matchCatalogEntry('anthropic/claude-sonnet-5.5', index)?.modelRef).toBe(
      'anthropic/claude-sonnet-5.5',
    );
  });

  it('matches a bare slug against the catalog suffix', () => {
    expect(matchCatalogEntry('deepseek-v4.1-flash', index)?.modelRef).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('matches across punctuation differences', () => {
    expect(matchCatalogEntry('gpt-4o-mini', index)?.modelRef).toBe('openai/gpt-4o-mini');
  });

  it('returns null for an unknown model rather than guessing', () => {
    expect(matchCatalogEntry('totally-different-model', index)).toBeNull();
  });

  it('returns null for an empty id', () => {
    expect(matchCatalogEntry('', index)).toBeNull();
    expect(matchCatalogEntry('   ', index)).toBeNull();
  });

  it('refuses ambiguous matches', () => {
    const ambiguous = [
      { modelRef: 'a/gpt-4o', vendor: 'a', name: 'A' },
      { modelRef: 'b/gpt-4o', vendor: 'b', name: 'B' },
    ];
    // The bare slug matches the suffix of two entries: no confident answer.
    expect(matchCatalogEntry('gpt-4o', ambiguous)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  binomialPmf,
  chiSquareSurvival,
  holmCorrection,
  mcnemarTest,
  pairedDifference,
  wilsonInterval,
  zFor,
} from '../../server/stats';

const counts = (bothCorrect: number, b: number, c: number, bothIncorrect: number) => ({
  bothCorrect,
  baselineOnlyCorrect: b,
  comparisonOnlyCorrect: c,
  bothIncorrect,
});

describe('McNemar test', () => {
  it('returns p=1 when every pair agrees', () => {
    const result = mcnemarTest(counts(10, 0, 0, 5));
    expect(result.discordant).toBe(0);
    expect(result.pValue).toBe(1);
  });

  it('flags a lopsided discordant split as significant', () => {
    // 12 regressions, 0 improvements -> strongly one-sided.
    const result = mcnemarTest(counts(30, 12, 0, 8));
    expect(result.discordant).toBe(12);
    expect(result.pValue).toBeLessThan(0.01);
  });

  it('does not flag a balanced split', () => {
    const result = mcnemarTest(counts(30, 6, 6, 8));
    expect(result.pValue).toBeGreaterThan(0.05);
  });

  it('is symmetric in b and c', () => {
    const a = mcnemarTest(counts(10, 9, 2, 5));
    const b = mcnemarTest(counts(10, 2, 9, 5));
    expect(a.pValue).toBeCloseTo(b.pValue, 10);
  });

  it('produces a p-value inside [0,1]', () => {
    for (const [bc, b, c, bi] of [
      [0, 1, 1, 0],
      [5, 3, 1, 0],
      [50, 20, 18, 12],
    ]) {
      const result = mcnemarTest(counts(bc, b, c, bi));
      expect(result.pValue).toBeGreaterThanOrEqual(0);
      expect(result.pValue).toBeLessThanOrEqual(1);
    }
  });

  it('uses the exact method for small samples', () => {
    expect(mcnemarTest(counts(5, 4, 1, 2)).method).toBe('mcnemar-exact');
  });
});

describe('binomial pmf', () => {
  it('sums to 1 over the support', () => {
    const total = Array.from({ length: 9 }, (_, k) => binomialPmf(8, k, 0.5)).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('matches known values', () => {
    expect(binomialPmf(4, 0, 0.5)).toBeCloseTo(1 / 16, 12);
    expect(binomialPmf(4, 2, 0.5)).toBeCloseTo(6 / 16, 12);
  });
});

describe('chi-square survival', () => {
  it('is 0.05-ish at the 95th percentile of chi2(1)', () => {
    expect(chiSquareSurvival(3.841, 1)).toBeCloseTo(0.05, 1);
  });

  it('is 1 at zero', () => {
    expect(chiSquareSurvival(0, 1)).toBe(1);
  });
});

describe('Wilson interval', () => {
  it('brackets the point estimate', () => {
    const interval = wilsonInterval(8, 10);
    expect(interval.low).toBeLessThan(0.8);
    expect(interval.high).toBeGreaterThan(0.8);
  });

  it('never leaves [0,1]', () => {
    for (const [s, n] of [
      [0, 5],
      [5, 5],
      [1, 3],
    ]) {
      const interval = wilsonInterval(s, n);
      expect(interval.low).toBeGreaterThanOrEqual(0);
      expect(interval.high).toBeLessThanOrEqual(1);
    }
  });

  it('narrows as the sample grows', () => {
    const small = wilsonInterval(5, 10);
    const large = wilsonInterval(500, 1000);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });
});

describe('paired difference', () => {
  it('returns an insufficient marker with no data', () => {
    expect(pairedDifference([], []).method).toBe('insufficient');
  });

  it('reports zero delta for identical scores', () => {
    const result = pairedDifference([1, 0, 1, 1], [1, 0, 1, 1]);
    expect(result.delta).toBe(0);
    expect(result.n).toBe(4);
  });

  it('detects a consistent drop', () => {
    const baseline = Array.from({ length: 40 }, () => 1);
    const current = [...Array(30).fill(1), ...Array(10).fill(0)];
    const result = pairedDifference(baseline, current);
    expect(result.delta).toBeCloseTo(-0.25, 6);
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.method).toBe('paired-t');
  });

  it('truncates to the shorter series', () => {
    const result = pairedDifference([1, 1, 1], [1, 1]);
    expect(result.n).toBe(2);
  });
});

describe('Holm correction', () => {
  it('leaves a single p-value unchanged', () => {
    expect(holmCorrection([0.02])).toEqual([0.02]);
  });

  it('is monotone and never reduces below the raw value', () => {
    const raw = [0.01, 0.04, 0.03, 0.2];
    const adjusted = holmCorrection(raw);
    adjusted.forEach((value, index) => {
      expect(value).toBeGreaterThanOrEqual(raw[index]);
      expect(value).toBeLessThanOrEqual(1);
    });
  });

  it('is less strict than Bonferroni', () => {
    const raw = [0.01, 0.02, 0.03];
    const adjusted = holmCorrection(raw);
    const bonferroni = raw.map((p) => p * 3);
    adjusted.forEach((value, index) => expect(value).toBeLessThanOrEqual(bonferroni[index] + 1e-12));
  });
});

describe('critical values', () => {
  it('increases with confidence level', () => {
    expect(zFor(0.8)).toBeLessThan(zFor(0.9));
    expect(zFor(0.9)).toBeLessThan(zFor(0.95));
    expect(zFor(0.95)).toBeLessThan(zFor(0.99));
  });
});

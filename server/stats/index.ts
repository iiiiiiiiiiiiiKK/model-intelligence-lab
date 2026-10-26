/**
 * Statistics used by the regression detector.
 *
 * Design notes
 * ------------
 * Binary item correctness is compared with an exact McNemar test on the
 * discordant pairs of *paired* items (same item id in both runs). Continuous
 * per-item scores use a paired t-test when n is large enough, and a normal
 * approximation on the paired differences otherwise, always reporting an
 * explicit uncertainty interval so the UI never shows a bare point estimate.
 *
 * Nothing here claims causality or vendor intent: the output is an *observed*
 * difference plus a measure of how surprising it would be under the null
 * hypothesis of no change.
 */

export interface PairedCounts {
  bothCorrect: number;
  baselineOnlyCorrect: number;
  comparisonOnlyCorrect: number;
  bothIncorrect: number;
}

export interface McnemarResult {
  method: 'mcnemar-exact' | 'mcnemar-chi2';
  statistic: number | null;
  pValue: number;
  discordant: number;
  counts: PairedCounts;
}

/** Two-sided binomial test on the discordant pairs (exact McNemar). */
export function mcnemarTest(counts: PairedCounts): McnemarResult {
  const b = counts.baselineOnlyCorrect;
  const c = counts.comparisonOnlyCorrect;
  const n = b + c;

  if (n === 0) {
    return { method: 'mcnemar-exact', statistic: null, pValue: 1, discordant: 0, counts };
  }

  if (n <= 1000) {
    // exact binomial: P(X <= min(b,c)) * 2, capped at 1
    const k = Math.min(b, c);
    let tail = 0;
    for (let i = 0; i <= k; i++) tail += binomialPmf(n, i, 0.5);
    return {
      method: 'mcnemar-exact',
      statistic: null,
      pValue: Math.min(1, tail * 2),
      discordant: n,
      counts,
    };
  }

  // continuity-corrected chi-square approximation for very large samples
  const chi2 = Math.pow(Math.abs(b - c) - 1, 2) / n;
  return {
    method: 'mcnemar-chi2',
    statistic: chi2,
    pValue: chiSquareSurvival(chi2, 1),
    discordant: n,
    counts,
  };
}

export function binomialPmf(n: number, k: number, p: number): number {
  if (k < 0 || k > n) return 0;
  const logC = logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
  return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/** Lanczos approximation of ln Γ(x). */
export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const xm = x - 1;
  let a = c[0];
  const t = xm + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (xm + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Upper-tail probability of the chi-square distribution (Wilson–Hilferty). */
export function chiSquareSurvival(x: number, df: number): number {
  if (x <= 0) return 1;
  // Wilson–Hilferty normal approximation, adequate for df=1..10
  const h = 2 / (9 * df);
  const z = (Math.cbrt(x / df) - (1 - h)) / Math.sqrt(h);
  return 1 - normalCdf(z);
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Abramowitz & Stegun 7.1.26 error function approximation. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export interface Interval {
  low: number;
  high: number;
  level: number;
}

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(successes: number, n: number, level = 0.95): Interval {
  if (n === 0) return { low: 0, high: 1, level };
  const z = zFor(level);
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = phat + (z * z) / (2 * n);
  const spread = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
  return {
    low: Math.max(0, (centre - spread) / denom),
    high: Math.min(1, (centre + spread) / denom),
    level,
  };
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function sampleSd(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Two-sided critical value, normal approximation (z_{1-α/2}). */
export function zFor(level = 0.95): number {
  // Keys are normalised to two decimals so 0.8 and 0.80 resolve identically.
  const table: Record<string, number> = {
    '0.80': 1.2815515655446004,
    '0.85': 1.4395314709384563,
    '0.90': 1.6448536269514722,
    '0.95': 1.959963984540054,
    '0.98': 2.3263478740408408,
    '0.99': 2.5758293035489004,
  };
  const key = level.toFixed(2);
  if (table[key] !== undefined) return table[key];
  // Fall back to the inverse normal CDF so intermediate levels stay accurate.
  return inverseNormalCdf(1 - (1 - level) / 2);
}

/** Acklam's rational approximation of the standard normal quantile function. */
export function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1 || !Number.isFinite(p)) {
    return p <= 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

export interface PairedDiffResult {
  n: number;
  meanBaseline: number;
  meanComparison: number;
  delta: number;
  sdDiff: number;
  standardError: number;
  tStatistic: number | null;
  pValue: number | null;
  method: 'paired-t' | 'normal-approx' | 'insufficient';
  interval: Interval | null;
}

/** Paired comparison of continuous per-item scores. */
export function pairedDifference(
  baseline: number[],
  comparison: number[],
  level = 0.95,
): PairedDiffResult {
  const n = Math.min(baseline.length, comparison.length);
  if (n === 0) {
    return {
      n: 0,
      meanBaseline: 0,
      meanComparison: 0,
      delta: 0,
      sdDiff: 0,
      standardError: 0,
      tStatistic: null,
      pValue: null,
      method: 'insufficient',
      interval: null,
    };
  }

  const diffs: number[] = [];
  for (let i = 0; i < n; i++) diffs.push(comparison[i] - baseline[i]);

  const meanBaseline = mean(baseline.slice(0, n));
  const meanComparison = mean(comparison.slice(0, n));
  const delta = meanComparison - meanBaseline;
  const sdDiff = sampleSd(diffs);
  const se = n > 0 ? sdDiff / Math.sqrt(n) : 0;
  const z = zFor(level);

  if (n < 2 || sdDiff === 0) {
    return {
      n,
      meanBaseline,
      meanComparison,
      delta,
      sdDiff,
      standardError: se,
      tStatistic: null,
      pValue: n >= 2 ? (delta === 0 ? 1 : 0) : null,
      method: n >= 2 ? 'normal-approx' : 'insufficient',
      interval: n >= 2 ? { low: delta, high: delta, level } : null,
    };
  }

  const t = delta / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(t)));
  return {
    n,
    meanBaseline,
    meanComparison,
    delta,
    sdDiff,
    standardError: se,
    tStatistic: t,
    pValue,
    method: n >= 30 ? 'paired-t' : 'normal-approx',
    interval: { low: delta - z * se, high: delta + z * se, level },
  };
}

/** Holm–Bonferroni correction for multiple dimension comparisons. */
export function holmCorrection(pValues: number[]): number[] {
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const m = pValues.length;
  const adjusted = new Array<number>(m).fill(1);
  let running = 0;
  indexed.forEach((entry, rank) => {
    const value = Math.min(1, (m - rank) * entry.p);
    running = Math.max(running, value);
    adjusted[entry.i] = Math.min(1, running);
  });
  return adjusted;
}

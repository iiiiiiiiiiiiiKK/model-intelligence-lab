/**
 * Pure aggregation helpers shared by server and client.
 * Kept free of database imports so it can be unit-tested in any environment.
 */
import type { BenchmarkDimension } from './types';
import { DIMENSION_WEIGHTS } from './constants';

/**
 * Weighted overall score.
 *
 * Dimensions that are absent from `scores` are excluded and the remaining
 * weights are renormalised, so a partial run is not punished with implicit
 * zeros. If no known dimension is present, the result is `null` rather than 0 —
 * the UI must show "no data", not a fabricated score.
 */
export function computeOverall(scores: Record<string, number>): number | null {
  let weighted = 0;
  let totalWeight = 0;
  for (const [dimension, value] of Object.entries(scores)) {
    const weight = DIMENSION_WEIGHTS[dimension as BenchmarkDimension];
    if (!weight || !Number.isFinite(value)) continue;
    weighted += weight * value;
    totalWeight += weight;
  }
  if (totalWeight === 0) return null;
  return Number((weighted / totalWeight).toFixed(4));
}

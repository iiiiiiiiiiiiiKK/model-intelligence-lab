import type { BenchmarkDimension, ScorerType } from './types';

export const DIMENSIONS: BenchmarkDimension[] = [
  'reasoning',
  'coding',
  'instruction-following',
  'factuality',
  'stability',
  'behavior',
];

export const SCORER_TYPES: ScorerType[] = [
  'exact-match',
  'normalized-match',
  'numeric-tolerance',
  'json-schema',
  'rule-based',
  'unit-test',
  'llm-judge',
  'human',
];

export const APP_VERSION = '0.1.0';

/** Dimension weights used for the overall score. Behaviour is subjective, so it
 *  carries less weight and is always shown separately in the UI. */
export const DIMENSION_WEIGHTS: Record<BenchmarkDimension, number> = {
  reasoning: 0.22,
  coding: 0.22,
  'instruction-following': 0.18,
  factuality: 0.18,
  stability: 0.12,
  behavior: 0.08,
};

export const DEFAULT_EVAL_PARAMS = {
  temperature: 0,
  maxTokens: 1024,
  timeoutMs: 60000,
  retries: 2,
  concurrency: 3,
  budgetUsd: 2,
  systemPrompt: null as string | null,
};

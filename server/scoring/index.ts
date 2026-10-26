/**
 * Scorer registry.
 *
 * Every scorer is a pure function of (item, model output) -> score in [0,1]
 * plus a machine-readable breakdown. Scorers never mutate global state and
 * never execute untrusted code: `unit-test` scoring is intentionally *not*
 * implemented as arbitrary code execution. Items that declare it are scored by
 * structural checks only, and the UI labels them as "structural check" so the
 * limitation is visible instead of silently pretending to run sandboxed tests.
 */
import type { ScorerConfig, ScorerType } from '../../shared/types';

export interface ScorerInput {
  question: string;
  reference: string | null;
  response: string;
  scorer: ScorerConfig;
}

export interface ScorerOutput {
  score: number;
  normalized: string;
  breakdown: Record<string, unknown>;
}

export type ScorerFn = (input: ScorerInput) => ScorerOutput;

export const SCORER_REGISTRY_VERSION = '1.1.0';

const TRIM_PREAMBLE = /^(?:final answer|answer|答案|正确答案)\s*[:：]\s*/i;

export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n/g, '\n')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Extracts the first balanced JSON object/array from free-form text. */
export function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.search(/[[{]/);
    if (start === -1) continue;
    const openChar = candidate[start];
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === openChar) depth++;
      else if (ch === closeChar) {
        depth--;
        if (depth === 0) {
          const slice = candidate.slice(start, i + 1);
          try {
            JSON.parse(slice);
            return slice;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Parses a bare JSON scalar (3, true, null, "x"). Used as a fallback when a
 * schema expects a primitive and the model answered without braces.
 */
export function parseScalarJson(text: string): string | null {
  if (text.length === 0 || text.length > 200) return null;
  try {
    const value = JSON.parse(text);
    if (value === null || ['number', 'boolean', 'string'].includes(typeof value)) {
      return text;
    }
  } catch {
    /* not a scalar literal */
  }
  return null;
}

export function extractNumber(text: string): number | null {
  const cleaned = text.replace(/,/g, '');
  const match = cleaned.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Individual scorers
// ---------------------------------------------------------------------------

const exactMatch: ScorerFn = ({ reference, response }) => {
  const ref = stripWrappingQuotes(reference ?? '');
  const normalized = response.replace(TRIM_PREAMBLE, '').trim();
  const pass = ref.length > 0 && normalized === ref;
  return {
    score: pass ? 1 : 0,
    normalized,
    breakdown: { strategy: 'exact', expected: ref, pass },
  };
};

const normalizedMatch: ScorerFn = ({ reference, response }) => {
  const ref = normalizeText(stripWrappingQuotes(reference ?? ''));
  const normalized = normalizeText(response.replace(TRIM_PREAMBLE, ''));
  if (ref.length === 0) {
    return { score: 0, normalized, breakdown: { strategy: 'normalized', reason: 'no-reference' } };
  }
  if (normalized === ref) {
    return { score: 1, normalized, breakdown: { strategy: 'normalized', match: 'equal' } };
  }
  // Accept answers that embed the reference as a whole token sequence, which is
  // common for chat models that add a short explanation.
  const contains = normalized.includes(ref);
  const refTokens = ref.split(' ').filter(Boolean);
  const tokenHit =
    refTokens.length > 0 &&
    refTokens.every((token) => new RegExp(`(^|[^a-z0-9])${escapeRegex(token)}([^a-z0-9]|$)`, 'i').test(normalized));
  const score = contains ? 0.9 : tokenHit ? 0.75 : 0;
  return {
    score,
    normalized,
    breakdown: { strategy: 'normalized', match: contains ? 'contains' : tokenHit ? 'tokens' : 'none' },
  };
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const numericTolerance: ScorerFn = ({ reference, response, scorer }) => {
  const tolerance = Number(scorer.config.tolerance ?? 1e-6);
  const expected = extractNumber(reference ?? '');
  const actual = extractNumber(response);
  if (expected === null) {
    return { score: 0, normalized: response.trim(), breakdown: { reason: 'no-reference-number' } };
  }
  if (actual === null) {
    return {
      score: 0,
      normalized: response.trim(),
      breakdown: { reason: 'no-number-in-response', expected },
    };
  }
  const diff = Math.abs(actual - expected);
  const pass = diff <= tolerance;
  return {
    score: pass ? 1 : 0,
    normalized: String(actual),
    breakdown: { strategy: 'numeric', expected, actual, diff, tolerance, pass },
  };
};

function validateSchema(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = [];

  if (schema.type) {
    const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const expected = schema.type;
    const matches =
      expected === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : expected === 'number'
          ? typeof value === 'number'
          : actualType === expected;
    if (!matches) {
      errors.push(`${path}: expected ${expected}, got ${actualType}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${path}: value not in enum`);
  }

  if (schema.type === 'object' || schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: missing required property`);
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errors.push(...validateSchema(obj[key], subSchema, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) errors.push(`${path}.${key}: unexpected property`);
      }
    }
  }

  if (schema.type === 'array') {
    const arr = value as unknown[];
    if (schema.minItems !== undefined && arr.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && arr.length > schema.maxItems) {
      errors.push(`${path}: expected at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      arr.forEach((entry, index) => errors.push(...validateSchema(entry, schema.items!, `${path}[${index}]`)));
    }
  }

  if (schema.type === 'string') {
    const str = value as string;
    if (schema.minLength !== undefined && str.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && str.length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(str)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }

  return errors;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean;
}

const jsonSchemaScorer: ScorerFn = ({ response, scorer }) => {
  const schema = (scorer.config.schema as JsonSchema | undefined) ?? { type: 'object' };
  const trimmed = response.trim();
  // Scalars (numbers, booleans, null, quoted strings) have no braces or
  // brackets, so fall back to parsing the trimmed response directly.
  const json = extractJson(response) ?? parseScalarJson(trimmed);
  if (!json) {
    return { score: 0, normalized: trimmed, breakdown: { reason: 'no-json-found' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      score: 0,
      normalized: json,
      breakdown: { reason: 'invalid-json', message: (err as Error).message },
    };
  }
  const errors = validateSchema(parsed, schema);
  return {
    score: errors.length === 0 ? 1 : 0,
    normalized: JSON.stringify(parsed),
    breakdown: { strategy: 'json-schema', valid: errors.length === 0, errors },
  };
};

const ruleBased: ScorerFn = ({ response, scorer }) => {
  const rules = (scorer.config.rules as RuleSpec[] | undefined) ?? [];
  const checks = rules.map((rule) => {
    const value = rule.caseSensitive ? response : response.toLowerCase();
    const target = rule.caseSensitive ? String(rule.value) : String(rule.value).toLowerCase();
    let pass = false;
    switch (rule.kind) {
      case 'contains':
        pass = value.includes(target);
        break;
      case 'not-contains':
        pass = !value.includes(target);
        break;
      case 'starts-with':
        pass = value.trimStart().startsWith(target);
        break;
      case 'ends-with':
        pass = value.trimEnd().endsWith(target);
        break;
      case 'regex':
        pass = new RegExp(String(rule.value), rule.caseSensitive ? '' : 'i').test(response);
        break;
      case 'min-words':
        pass = countWords(response) >= Number(rule.value);
        break;
      case 'max-words':
        pass = countWords(response) <= Number(rule.value);
        break;
      case 'min-chars':
        pass = response.trim().length >= Number(rule.value);
        break;
      case 'max-chars':
        pass = response.trim().length <= Number(rule.value);
        break;
      case 'contains-any':
        pass = (Array.isArray(rule.value) ? rule.value : [rule.value]).some((candidate) =>
          value.includes(
            rule.caseSensitive ? String(candidate) : String(candidate).toLowerCase(),
          ),
        );
        break;
      case 'not-contains-any':
        pass = !(Array.isArray(rule.value) ? rule.value : [rule.value]).some((candidate) =>
          value.includes(
            rule.caseSensitive ? String(candidate) : String(candidate).toLowerCase(),
          ),
        );
        break;
      case 'sentence-count': {
        const sentences = response
          .split(/[.!?。！？]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        pass = sentences.length === Number(rule.value);
        break;
      }
      case 'json-field-count': {
        const json = extractJson(response);
        if (!json) {
          pass = false;
        } else {
          try {
            const parsed = JSON.parse(json) as Record<string, unknown>;
            pass = Object.keys(parsed).length === Number(rule.value);
          } catch {
            pass = false;
          }
        }
        break;
      }
      default:
        pass = false;
    }
    return { ...rule, pass };
  });

  const total = checks.length;
  const passed = checks.filter((c) => c.pass).length;
  return {
    score: total === 0 ? 0 : passed / total,
    normalized: response.trim(),
    breakdown: {
      strategy: 'rules',
      passed,
      total,
      failures: checks.filter((c) => !c.pass).map((c) => ({ kind: c.kind, value: c.value })),
    },
  };
};

export interface RuleSpec {
  kind:
    | 'contains'
    | 'not-contains'
    | 'contains-any'
    | 'not-contains-any'
    | 'starts-with'
    | 'ends-with'
    | 'regex'
    | 'min-words'
    | 'max-words'
    | 'min-chars'
    | 'max-chars'
    | 'sentence-count'
    | 'json-field-count';
  value: string | number | string[];
  caseSensitive?: boolean;
}

export function countWords(value: string): number {
  const cjk = (value.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = value
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk > 0 ? cjk + latin : latin;
}

/**
 * `unit-test` items cannot be executed without a sandbox, so we run a
 * structural check instead: the response must contain a code block and the
 * expected identifier. The score is capped below 1 and the breakdown records
 * `executed: false` so reports stay honest.
 */
const unitTestStructural: ScorerFn = ({ response, scorer }) => {
  const requiredIdentifiers = (scorer.config.requiredIdentifiers as string[] | undefined) ?? [];
  const hasCodeBlock = /```[\s\S]*?```/.test(response);
  const hits = requiredIdentifiers.filter((id) => response.includes(id));
  const identifierScore = requiredIdentifiers.length === 0 ? 1 : hits.length / requiredIdentifiers.length;
  const score = (hasCodeBlock ? 1 : 0) * identifierScore * 0.5;
  return {
    score,
    normalized: response.trim(),
    breakdown: {
      strategy: 'unit-test-structural',
      executed: false,
      note: 'No sandboxed code execution is available; scored by structural checks only.',
      hasCodeBlock,
      matchedIdentifiers: hits,
      requiredIdentifiers,
    },
  };
};

/**
 * LLM judge is only used when a reference answer exists and the judge provider
 * is configured. The judge is asked for a strict JSON verdict. It is explicitly
 * labelled uncalibrated in the UI and never presented as ground truth.
 */
const llmJudgeScorer: ScorerFn = ({ response, reference, question, scorer }) => {
  const judged = scorer.config.judgeResult as
    | { score: number; rationale: string; judgeModel: string; provider: string }
    | undefined;
  if (!judged) {
    return {
      score: 0,
      normalized: response.trim(),
      breakdown: {
        strategy: 'llm-judge',
        error: 'judge-not-executed',
        note: 'No judge verdict was recorded for this item.',
      },
    };
  }
  return {
    score: Math.max(0, Math.min(1, judged.score)),
    normalized: response.trim(),
    breakdown: {
      strategy: 'llm-judge',
      calibrated: false,
      judgeModel: judged.judgeModel,
      provider: judged.provider,
      rationale: judged.rationale,
      question,
      reference,
    },
  };
};

const humanReview: ScorerFn = ({ response, scorer }) => {
  const verdict = scorer.config.humanVerdict as
    | { score: number; reviewer: string; note: string }
    | undefined;
  if (!verdict) {
    return {
      score: 0,
      normalized: response.trim(),
      breakdown: {
        strategy: 'human',
        pending: true,
        note: 'Awaiting human review; not counted as correct.',
      },
    };
  }
  return {
    score: Math.max(0, Math.min(1, verdict.score)),
    normalized: response.trim(),
    breakdown: { strategy: 'human', reviewer: verdict.reviewer, note: verdict.note },
  };
};

const noop: ScorerFn = ({ response }) => ({
  score: 0,
  normalized: response.trim(),
  breakdown: { strategy: 'unsupported', note: 'Unsupported scorer type.' },
});

const REGISTRY: Record<ScorerType, ScorerFn> = {
  'exact-match': exactMatch,
  'normalized-match': normalizedMatch,
  'numeric-tolerance': numericTolerance,
  'json-schema': jsonSchemaScorer,
  'rule-based': ruleBased,
  'unit-test': unitTestStructural,
  'llm-judge': llmJudgeScorer,
  human: humanReview,
};

export function getScorer(type: ScorerType): ScorerFn {
  return REGISTRY[type] ?? noop;
}

export function scoreResponse(input: ScorerInput): ScorerOutput {
  const scorer = getScorer(input.scorer.type);
  const result = scorer(input);
  return {
    score: Number.isFinite(result.score) ? Math.max(0, Math.min(1, result.score)) : 0,
    normalized: result.normalized,
    breakdown: {
      ...result.breakdown,
      scorerType: input.scorer.type,
      scorerVersion: input.scorer.version,
      registryVersion: SCORER_REGISTRY_VERSION,
    },
  };
}

/** Pass threshold used to binarize item correctness for McNemar testing. */
export const PASS_THRESHOLD = 0.75;

export function isPass(score: number): boolean {
  return score >= PASS_THRESHOLD;
}

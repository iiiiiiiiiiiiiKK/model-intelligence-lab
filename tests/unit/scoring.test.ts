import { describe, expect, it } from 'vitest';
import {
  extractJson,
  extractNumber,
  isPass,
  normalizeText,
  scoreResponse,
  countWords,
  PASS_THRESHOLD,
} from '../../server/scoring';
import type { ScorerType } from '../../shared/types';

function score(
  type: ScorerType,
  response: string,
  reference: string | null,
  config: Record<string, unknown> = {},
) {
  return scoreResponse({
    question: 'q',
    reference,
    response,
    scorer: { type, version: '1.0.0', config },
  });
}

describe('normalizeText', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeText('  Hello   World \n')).toBe('hello world');
  });

  it('normalizes full-width characters', () => {
    expect(normalizeText('ＡＢＣ')).toBe('abc');
  });

  it('unifies curly quotes', () => {
    expect(normalizeText('“hi”')).toBe('"hi"');
  });
});

describe('extractNumber', () => {
  it('finds a plain integer', () => {
    expect(extractNumber('The answer is 42')).toBe(42);
  });

  it('handles thousands separators', () => {
    expect(extractNumber('1,234')).toBe(1234);
  });

  it('handles negatives and decimals', () => {
    expect(extractNumber('result: -14')).toBe(-14);
    expect(extractNumber('0.1071')).toBeCloseTo(0.1071, 6);
  });

  it('returns null when no number is present', () => {
    expect(extractNumber('no digits here')).toBeNull();
  });
});

describe('extractJson', () => {
  it('pulls JSON out of a fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('finds a bare object', () => {
    expect(extractJson('answer: {"a":1} done')).toBe('{"a":1}');
  });

  it('handles nested braces inside strings', () => {
    const input = '{"a":"}{"}';
    expect(extractJson(input)).toBe(input);
  });

  it('returns null when no valid JSON exists', () => {
    expect(extractJson('{not json}')).toBeNull();
  });
});

describe('exact-match scorer', () => {
  it('accepts an exact answer', () => {
    expect(score('exact-match', '663', '663').score).toBe(1);
  });

  it('rejects extra prose', () => {
    expect(score('exact-match', 'The answer is 663', '663').score).toBe(0);
  });

  it('strips a leading "Answer:" label', () => {
    expect(score('exact-match', 'Answer: 663', '663').score).toBe(1);
  });

  it('is case sensitive', () => {
    expect(score('exact-match', 'yes', 'Yes').score).toBe(0);
  });

  it('scores 0 with no reference', () => {
    expect(score('exact-match', 'anything', null).score).toBe(0);
  });
});

describe('normalized-match scorer', () => {
  it('ignores case and whitespace', () => {
    expect(score('normalized-match', '  tokyo  ', 'Tokyo').score).toBe(1);
  });

  it('gives partial credit when the reference is embedded', () => {
    const result = score('normalized-match', 'The capital is Tokyo.', 'Tokyo');
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(1);
  });

  it('scores 0 for an unrelated answer', () => {
    expect(score('normalized-match', 'Kyoto', 'Tokyo').score).toBe(0);
  });

  it('scores 0 with no reference', () => {
    expect(score('normalized-match', 'anything', null).score).toBe(0);
  });
});

describe('numeric-tolerance scorer', () => {
  it('accepts an equal number', () => {
    expect(score('numeric-tolerance', '80', '80').score).toBe(1);
  });

  it('respects the tolerance window', () => {
    expect(score('numeric-tolerance', '0.1071', '0.1071', { tolerance: 0.0001 }).score).toBe(1);
    expect(score('numeric-tolerance', '0.12', '0.1071', { tolerance: 0.0001 }).score).toBe(0);
  });

  it('extracts a number from prose', () => {
    expect(score('numeric-tolerance', 'It is 663 dollars', '663').score).toBe(1);
  });

  it('scores 0 when the response has no number', () => {
    expect(score('numeric-tolerance', 'many', '663').score).toBe(0);
  });

  it('scores 0 when the reference has no number', () => {
    expect(score('numeric-tolerance', '663', null).score).toBe(0);
  });
});

describe('json-schema scorer', () => {
  const schemaConfig = {
    schema: {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', enum: ['ok'] } },
      additionalProperties: false,
    },
  };

  it('accepts a conforming object', () => {
    expect(score('json-schema', '{"status":"ok"}', null, schemaConfig).score).toBe(1);
  });

  it('accepts JSON inside a code fence', () => {
    expect(score('json-schema', '```json\n{"status":"ok"}\n```', null, schemaConfig).score).toBe(1);
  });

  it('rejects a missing required field', () => {
    const result = score('json-schema', '{"other":1}', null, schemaConfig);
    expect(result.score).toBe(0);
    expect(JSON.stringify(result.breakdown)).toContain('missing required property');
  });

  it('rejects an enum mismatch', () => {
    expect(score('json-schema', '{"status":"bad"}', null, schemaConfig).score).toBe(0);
  });

  it('rejects additional properties when disallowed', () => {
    expect(score('json-schema', '{"status":"ok","extra":1}', null, schemaConfig).score).toBe(0);
  });

  it('rejects non-JSON output', () => {
    expect(score('json-schema', 'sure, ok', null, schemaConfig).score).toBe(0);
  });

  it('validates array length constraints', () => {
    const arraySchema = { schema: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer' } } };
    expect(score('json-schema', '[1,2]', null, arraySchema).score).toBe(1);
    expect(score('json-schema', '[1]', null, arraySchema).score).toBe(0);
    expect(score('json-schema', '[1,2,3]', null, arraySchema).score).toBe(0);
  });

  it('validates integer vs number types', () => {
    const integerSchema = { schema: { type: 'integer' } };
    expect(score('json-schema', '3', null, integerSchema).score).toBe(1);
    expect(score('json-schema', '3.5', null, integerSchema).score).toBe(0);
  });
});

describe('rule-based scorer', () => {
  it('scores the fraction of satisfied rules', () => {
    const result = score('rule-based', 'short text here', null, {
      rules: [
        { kind: 'min-words', value: 2 },
        { kind: 'max-words', value: 3 },
        { kind: 'contains', value: 'absent' },
      ],
    });
    expect(result.score).toBeCloseTo(2 / 3, 6);
  });

  it('supports regex rules', () => {
    expect(
      score('rule-based', 'The number 17 is prime', null, {
        rules: [{ kind: 'regex', value: '\\b(11|13|17|19)\\b' }],
      }).score,
    ).toBe(1);
  });

  it('supports sentence counting', () => {
    expect(score('rule-based', 'One sentence.', null, { rules: [{ kind: 'sentence-count', value: 1 }] }).score).toBe(1);
    expect(
      score('rule-based', 'One sentence. Two sentences.', null, { rules: [{ kind: 'sentence-count', value: 1 }] }).score,
    ).toBe(0);
  });

  it('scores 0 with no rules', () => {
    expect(score('rule-based', 'anything', null, { rules: [] }).score).toBe(0);
  });

  it('handles JSON field counting', () => {
    expect(
      score('rule-based', '{"a":1,"b":2}', null, { rules: [{ kind: 'json-field-count', value: 2 }] }).score,
    ).toBe(1);
  });

  it('reports failures in the breakdown', () => {
    const result = score('rule-based', 'no', null, { rules: [{ kind: 'contains', value: 'yes' }] });
    expect(result.score).toBe(0);
    expect(JSON.stringify(result.breakdown)).toContain('contains');
  });
});

describe('unit-test structural scorer', () => {
  it('never claims to have executed code', () => {
    const result = score('unit-test', '```python\ndef add(a,b):\n  return a+b\n```', null, {
      requiredIdentifiers: ['def add', 'return'],
    });
    expect((result.breakdown as { executed: boolean }).executed).toBe(false);
  });

  it('caps the score at 0.5 because nothing was executed', () => {
    const result = score('unit-test', '```python\ndef add(a,b):\n  return a+b\n```', null, {
      requiredIdentifiers: ['def add', 'return'],
    });
    expect(result.score).toBeLessThanOrEqual(0.5);
  });

  it('scores 0 without a code block', () => {
    expect(score('unit-test', 'def add return', null, { requiredIdentifiers: ['def add'] }).score).toBe(0);
  });
});

describe('unconfigured scorers', () => {
  it('llm-judge scores 0 and records why', () => {
    const result = score('llm-judge', 'a response', 'a reference');
    expect(result.score).toBe(0);
    expect(JSON.stringify(result.breakdown)).toContain('judge-not-executed');
  });

  it('human review scores 0 while pending', () => {
    const result = score('human', 'a response', null);
    expect(result.score).toBe(0);
    expect(JSON.stringify(result.breakdown)).toContain('pending');
  });
});

describe('score clamping', () => {
  it('always returns a score in [0,1]', () => {
    const result = score('rule-based', 'x', null, {
      rules: [{ kind: 'contains', value: '' }],
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('records the scorer version in the breakdown', () => {
    const result = score('exact-match', 'a', 'a');
    expect((result.breakdown as { scorerVersion: string }).scorerVersion).toBe('1.0.0');
  });
});

describe('pass threshold', () => {
  it('treats 0.75 and above as a pass', () => {
    expect(isPass(0.75)).toBe(true);
    expect(isPass(1)).toBe(true);
  });

  it('treats below 0.75 as a fail', () => {
    expect(isPass(0.74999)).toBe(false);
    expect(isPass(0)).toBe(false);
  });

  it('uses a documented constant', () => {
    expect(PASS_THRESHOLD).toBe(0.75);
  });
});

describe('countWords', () => {
  it('counts latin words', () => {
    expect(countWords('one two three')).toBe(3);
  });

  it('counts CJK characters individually', () => {
    expect(countWords('你好世界')).toBe(4);
  });
});

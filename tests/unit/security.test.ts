import { describe, expect, it } from 'vitest';
import { isBlockedAddress, isPrivateIpv4, isPrivateIpv6, redactSecrets } from '../../server/security/ssrf';
import { computeOverall } from '../../shared/aggregate';
import { CORE_DATASET, SMOKE_DATASET_KEYS } from '../../server/benchmarks/dataset';

describe('SSRF address classification', () => {
  it('blocks loopback', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.255.255.254')).toBe(true);
  });

  it('blocks private ranges', () => {
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('172.16.5.4')).toBe(true);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
  });

  it('blocks link-local and cloud metadata', () => {
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
  });

  it('blocks IPv6 loopback and unique-local', () => {
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('fd00::1')).toBe(true);
    expect(isBlockedAddress('fc00::abcd')).toBe(true);
  });

  it('blocks IPv4-mapped loopback', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('allows public addresses', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('rejects non-IP input', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
  });

  it('classifies 0.0.0.0/8 as private', () => {
    expect(isPrivateIpv4('0.0.0.0')).toBe(true);
    expect(isPrivateIpv4('0.255.1.2')).toBe(true);
  });

  it('classifies 100.64/10 carrier-grade NAT as private', () => {
    expect(isPrivateIpv4('100.64.0.1')).toBe(true);
    expect(isPrivateIpv4('100.128.0.1')).toBe(false);
  });

  it('classifies multicast IPv6 as private', () => {
    expect(isPrivateIpv6('ff02::1')).toBe(true);
  });
});

describe('secret redaction', () => {
  it('removes OpenAI-style keys', () => {
    const output = redactSecrets('using sk-abcdefghijklmnop now');
    expect(output).not.toContain('sk-abcdefghijklmnop');
    expect(output).toContain('[redacted-key]');
  });

  it('removes bearer tokens', () => {
    const output = redactSecrets('Authorization: Bearer abcdef123456789');
    expect(output).not.toContain('abcdef123456789');
  });

  it('removes api_key assignments', () => {
    expect(redactSecrets('api_key: supersecretvalue')).not.toContain('supersecretvalue');
  });

  it('leaves ordinary text intact', () => {
    const text = 'The model returned 42 for the arithmetic item.';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('overall score aggregation', () => {
  it('returns null with no dimensions', () => {
    expect(computeOverall({})).toBeNull();
  });

  it('returns the single dimension value alone', () => {
    expect(computeOverall({ reasoning: 0.8 })).toBeCloseTo(0.8, 6);
  });

  it('renormalises over present dimensions', () => {
    const result = computeOverall({ reasoning: 1, coding: 1 });
    expect(result).toBeCloseTo(1, 6);
  });

  it('weights behaviour less than reasoning', () => {
    const reasoningOnly = computeOverall({ reasoning: 1, behavior: 0 });
    const behaviorOnly = computeOverall({ reasoning: 0, behavior: 1 });
    expect(reasoningOnly!).toBeGreaterThan(behaviorOnly!);
  });

  it('ignores unknown dimension keys', () => {
    expect(computeOverall({ nonsense: 1 })).toBeNull();
  });

  it('ignores non-finite values', () => {
    expect(computeOverall({ reasoning: Number.NaN })).toBeNull();
  });
});

describe('first-party benchmark dataset integrity', () => {
  it('ships between 100 and 200 items', () => {
    expect(CORE_DATASET.length).toBeGreaterThanOrEqual(100);
    expect(CORE_DATASET.length).toBeLessThanOrEqual(200);
  });

  it('has unique item keys', () => {
    const keys = CORE_DATASET.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers all six dimensions', () => {
    const dimensions = new Set(CORE_DATASET.map((item) => item.dimension));
    for (const dimension of [
      'reasoning',
      'coding',
      'instruction-following',
      'factuality',
      'stability',
      'behavior',
    ]) {
      expect(dimensions.has(dimension as never)).toBe(true);
    }
  });

  it('gives every item either a reference answer or a scorer config', () => {
    for (const item of CORE_DATASET) {
      const hasReference = item.reference !== null && item.reference.length > 0;
      const hasConfig = Object.keys(item.scorerConfig).length > 0;
      expect(hasReference || hasConfig, `item ${item.key} has neither`).toBe(true);
    }
  });

  it('never uses a scorer that cannot grade without a reference', () => {
    for (const item of CORE_DATASET) {
      if (item.scorerType === 'numeric-tolerance' || item.scorerType === 'normalized-match') {
        expect(item.reference, `${item.key} needs a reference`).not.toBeNull();
      }
    }
  });

  it('declares a reference for every exact-match item', () => {
    for (const item of CORE_DATASET.filter((entry) => entry.scorerType === 'exact-match')) {
      expect(item.reference, `${item.key}`).not.toBeNull();
    }
  });

  it('has a smoke subset that exists in the dataset', () => {
    const keys = new Set(CORE_DATASET.map((item) => item.key));
    for (const key of SMOKE_DATASET_KEYS) {
      expect(keys.has(key), `smoke key ${key} missing`).toBe(true);
    }
  });

  it('marks unit-test items as non-executing', () => {
    for (const item of CORE_DATASET.filter((entry) => entry.scorerType === 'unit-test')) {
      expect(item.scorerConfig.executed).toBe(false);
    }
  });

  it('never claims llm-judge or human ground truth in seed items', () => {
    for (const item of CORE_DATASET) {
      expect(item.scorerType).not.toBe('llm-judge');
      expect(item.scorerType).not.toBe('human');
    }
  });
});

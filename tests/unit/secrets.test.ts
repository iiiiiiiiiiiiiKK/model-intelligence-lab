// @vitest-environment node
/**
 * Credential encryption.
 *
 * These tests assert the properties that matter: the ciphertext does not contain
 * the plaintext, tampering is detected, a wrong key fails loudly, and the hint
 * never reveals more than the last four characters.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-secrets-'));
process.env.NODE_ENV = 'test';
process.env.MODEL_LAB_DB_PATH = path.join(tmpDir, 'secrets.db');
delete process.env.MODEL_LAB_SECRET;

type Secrets = typeof import('../../server/security/secrets');
let secrets: Secrets;
let db: typeof import('../../server/db');

const KEY = 'sk-test-abcdefghijklmnopqrstuvwxyz-1234';

beforeAll(async () => {
  // Importing the db module creates the data directory the key file lives in.
  db = await import('../../server/db');
  secrets = await import('../../server/security/secrets');
});

afterAll(() => {
  // The SQLite file must be closed before the temp directory can be removed on
  // Windows, and the key file carries an owner-only mode that can resist
  // deletion briefly. Clean-up is best effort: a leftover temp dir is harmless
  // and must not turn a passing suite into a failure.
  try {
    db?.db?.close();
  } catch {
    /* already closed */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* best effort on Windows file locking */
  }
});

describe('encrypt / decrypt round trip', () => {
  it('recovers the exact plaintext', () => {
    expect(secrets.decryptSecret(secrets.encryptSecret(KEY))).toBe(KEY);
  });

  it('handles unicode and long values', () => {
    const value = `密钥-🔑-${'x'.repeat(400)}`;
    expect(secrets.decryptSecret(secrets.encryptSecret(value))).toBe(value);
  });

  it('produces a versioned, four-part envelope', () => {
    const ciphertext = secrets.encryptSecret(KEY);
    const parts = ciphertext.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    // iv (12 bytes) and tag (16 bytes) as base64.
    expect(Buffer.from(parts[1], 'base64')).toHaveLength(12);
    expect(Buffer.from(parts[2], 'base64')).toHaveLength(16);
  });

  it('never embeds the plaintext in the ciphertext', () => {
    const ciphertext = secrets.encryptSecret(KEY);
    expect(ciphertext).not.toContain(KEY);
    expect(ciphertext).not.toContain('abcdefghij');
  });

  it('uses a fresh IV so equal inputs differ', () => {
    const a = secrets.encryptSecret(KEY);
    const b = secrets.encryptSecret(KEY);
    expect(a).not.toBe(b);
    // Both still decrypt to the same value.
    expect(secrets.decryptSecret(a)).toBe(KEY);
    expect(secrets.decryptSecret(b)).toBe(KEY);
  });
});

describe('integrity', () => {
  it('rejects a tampered ciphertext body', () => {
    const ciphertext = secrets.encryptSecret(KEY);
    const parts = ciphertext.split(':');
    const body = Buffer.from(parts[3], 'base64');
    body[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], body.toString('base64')].join(':');
    expect(() => secrets.decryptSecret(tampered)).toThrow(secrets.DecryptError);
  });

  it('rejects a tampered auth tag', () => {
    const ciphertext = secrets.encryptSecret(KEY);
    const parts = ciphertext.split(':');
    const tag = Buffer.from(parts[2], 'base64');
    tag[0] ^= 0xff;
    const tampered = [parts[0], parts[1], tag.toString('base64'), parts[3]].join(':');
    expect(() => secrets.decryptSecret(tampered)).toThrow(secrets.DecryptError);
  });

  it('rejects an unrecognised envelope', () => {
    expect(() => secrets.decryptSecret(KEY)).toThrow(secrets.DecryptError);
    expect(() => secrets.decryptSecret('v2:a:b:c')).toThrow(secrets.DecryptError);
    expect(() => secrets.decryptSecret('v1:abc:def')).toThrow(secrets.DecryptError);
  });

  it('does not leak the ciphertext in the error message', () => {
    const ciphertext = secrets.encryptSecret(KEY);
    const parts = ciphertext.split(':');
    parts[3] = 'AAAA';
    try {
      secrets.decryptSecret(parts.join(':'));
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(KEY);
      expect((error as Error).message).not.toContain('AAAA');
      // The message tells the operator what to do.
      expect((error as Error).message).toMatch(/re-enter|MODEL_LAB_SECRET/i);
    }
  });
});

describe('master key handling', () => {
  it('creates a key file next to the database on first use', () => {
    secrets.getMasterKey();
    const keyFile = path.join(tmpDir, '.master-key');
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(fs.readFileSync(keyFile)).toHaveLength(32);
  });

  it('reuses the same key across calls', () => {
    const a = secrets.getMasterKey();
    const b = secrets.getMasterKey();
    expect(a.equals(b)).toBe(true);
  });

  it('fails to decrypt data produced under a different master key', () => {
    const ciphertext = secrets.encryptSecret(KEY);

    // Simulate an operator changing MODEL_LAB_SECRET.
    const original = process.env.MODEL_LAB_SECRET;
    process.env.MODEL_LAB_SECRET = 'a-completely-different-secret-value-32ch';
    secrets.resetMasterKeyCache();
    try {
      expect(() => secrets.decryptSecret(ciphertext)).toThrow(secrets.DecryptError);
    } finally {
      if (original === undefined) delete process.env.MODEL_LAB_SECRET;
      else process.env.MODEL_LAB_SECRET = original;
      secrets.resetMasterKeyCache();
    }
  });

  it('derives a key from MODEL_LAB_SECRET when it is set', () => {
    const original = process.env.MODEL_LAB_SECRET;
    process.env.MODEL_LAB_SECRET = 'operator-provided-secret-at-least-32-characters';
    secrets.resetMasterKeyCache();
    try {
      const key = secrets.getMasterKey();
      expect(key).toHaveLength(32);
      const ciphertext = secrets.encryptSecret(KEY);
      expect(secrets.decryptSecret(ciphertext)).toBe(KEY);
    } finally {
      if (original === undefined) delete process.env.MODEL_LAB_SECRET;
      else process.env.MODEL_LAB_SECRET = original;
      secrets.resetMasterKeyCache();
    }
  });

  it('ignores a too-short MODEL_LAB_SECRET and falls back to the key file', () => {
    const original = process.env.MODEL_LAB_SECRET;
    process.env.MODEL_LAB_SECRET = 'short';
    secrets.resetMasterKeyCache();
    try {
      // No throw; a 32-byte key is still produced.
      expect(secrets.getMasterKey()).toHaveLength(32);
    } finally {
      if (original === undefined) delete process.env.MODEL_LAB_SECRET;
      else process.env.MODEL_LAB_SECRET = original;
      secrets.resetMasterKeyCache();
    }
  });
});

describe('display hints', () => {
  it('keeps only the last four characters', () => {
    expect(secrets.keyHint(KEY)).toBe('••••1234');
  });

  it('reveals nothing for short keys', () => {
    expect(secrets.keyHint('short')).toBe('••••');
    expect(secrets.keyHint('')).toBe('••••');
  });

  it('returns null for a missing environment value', () => {
    expect(secrets.envKeyHint(undefined)).toBeNull();
    expect(secrets.envKeyHint('')).toBeNull();
  });

  it('never returns more than four real characters', () => {
    const hint = secrets.keyHint('sk-proj-verylongkeyvalue-ABCD');
    const realCharacters = hint.replace(/•/g, '');
    expect(realCharacters.length).toBeLessThanOrEqual(4);
  });
});

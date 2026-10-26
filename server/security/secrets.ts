/**
 * Credential encryption at rest.
 *
 * API keys are entered in the UI, so they have to be stored *somewhere*. They
 * are never stored in plaintext:
 *
 *   ciphertext = AES-256-GCM(masterKey, key)
 *   stored     = "v1:<iv b64>:<tag b64>:<ciphertext b64>"
 *
 * The 256-bit master key comes from `MODEL_LAB_SECRET` when set. Otherwise a
 * random key is generated once and written to `data/.master-key` with owner-only
 * permissions.
 *
 * **What this protects against, stated plainly:** a leaked database file, a
 * shared backup, a report export, an API response or a log line. It does *not*
 * protect against an attacker who already has read access to the whole data
 * directory, because the key file sits next to the database. For stronger
 * separation, set `MODEL_LAB_SECRET` from a real secret manager and keep it out
 * of the data volume.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dbFilePath } from '../db';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'v1';

let cachedKey: Buffer | null = null;

function masterKeyPath(): string {
  return path.join(path.dirname(dbFilePath), '.master-key');
}

/** Resolves the master key, generating and persisting one on first use. */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.MODEL_LAB_SECRET;
  if (fromEnv && fromEnv.trim().length >= 32) {
    // Derive a fixed-length key from the operator-provided secret.
    cachedKey = scryptSync(fromEnv.trim(), 'model-lab.credential.v1', 32);
    return cachedKey;
  }

  const keyFile = masterKeyPath();
  try {
    const existing = fs.readFileSync(keyFile);
    if (existing.length === 32) {
      cachedKey = existing;
      return cachedKey;
    }
  } catch {
    /* not created yet */
  }

  const generated = randomBytes(32);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  try {
    // Best effort on POSIX; Windows inherits the directory ACL.
    fs.chmodSync(keyFile, 0o600);
  } catch {
    /* ignore */
  }
  cachedKey = generated;
  return cachedKey;
}

/** Test hook: drops the cached key so a new environment can be picked up. */
export function resetMasterKeyCache(): void {
  cachedKey = null;
}

export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptError';
  }
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new DecryptError('Unrecognised ciphertext format.');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptError('Ciphertext is malformed.');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, getMasterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // Wrong master key or tampered ciphertext. Never echo the value.
    throw new DecryptError(
      'Cannot decrypt this credential. The master key changed (check MODEL_LAB_SECRET) — re-enter the key.',
    );
  }
}

/**
 * A safe display hint. Only the last four characters are kept, and only when
 * the key is long enough that this reveals nothing useful.
 */
export function keyHint(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length < 12) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

/** A hint derived from ciphertext alone, for rows whose key is env-provided. */
export function envKeyHint(value: string | undefined | null): string | null {
  if (!value) return null;
  return keyHint(value);
}

/**
 * Outbound request guards.
 *
 * Model provider base URLs are user-supplied, which makes them an SSRF vector.
 * `assertSafeProviderUrl` rejects non-HTTPS schemes, loopback / private /
 * link-local / metadata addresses and anything outside an optional allow-list.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { env } from '../config';

export class SsrfError extends Error {
  code = 'SSRF_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

export function isPrivateIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return BLOCKED_V4.some(([base, bits]) => {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (baseValue & mask) >>> 0;
  });
}

export function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80')) return true; // link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
  if (normalized.startsWith('ff')) return true; // multicast
  // IPv4-mapped ::ffff:a.b.c.d
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true; // not an IP at all -> refuse
}

/**
 * Validates and normalizes a provider base URL. Returns the origin-qualified
 * base URL (no trailing slash) that callers may safely fetch.
 *
 * `ALLOW_LOOPBACK_PROVIDER=true` is an explicit opt-in for self-hosted gateways
 * (Ollama, vLLM, LM Studio, a local reverse proxy). It permits plain HTTP and
 * loopback/private targets, which weakens SSRF protection — so it defaults to
 * false and is refused in production unless the operator sets it deliberately.
 */
export async function assertSafeProviderUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid provider URL: ${rawUrl}`);
  }

  const allowLocal = env.ALLOW_LOOPBACK_PROVIDER === true;

  if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:')) {
    throw new SsrfError('Provider URL must use HTTPS unless ALLOW_LOOPBACK_PROVIDER=true.');
  }
  if (url.username || url.password) {
    throw new SsrfError('Provider URL must not embed credentials.');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (!allowLocal && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal'))) {
    throw new SsrfError(`Blocked provider host: ${hostname}`);
  }

  const allowList = (env.ALLOWED_PROVIDER_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (allowList.length > 0 && !allowList.includes(hostname)) {
    throw new SsrfError(`Provider host is not in ALLOWED_PROVIDER_HOSTS: ${hostname}`);
  }

  if (net.isIP(hostname)) {
    if (!allowLocal && isBlockedAddress(hostname)) {
      throw new SsrfError(`Blocked provider IP address: ${hostname}`);
    }
  } else if (allowList.length === 0 && !allowLocal) {
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new SsrfError(`Cannot resolve provider host: ${hostname}`);
    }
    if (addresses.length === 0) {
      throw new SsrfError(`Provider host did not resolve: ${hostname}`);
    }
    for (const entry of addresses) {
      if (isBlockedAddress(entry.address)) {
        throw new SsrfError(
          `Provider host resolves to a blocked address: ${hostname} -> ${entry.address}`,
        );
      }
    }
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Strips credentials and long tokens from text before it reaches logs. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '[redacted-key]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key["'\s:=]+)[A-Za-z0-9._-]{8,}/gi, '$1[redacted]');
}

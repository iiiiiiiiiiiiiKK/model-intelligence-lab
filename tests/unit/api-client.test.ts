import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { api } from '../../src/lib/api';

/**
 * Regression tests for the "HTTP_500" report.
 *
 * When the API process is not running, the Vite dev proxy answers with a bare
 * `500` and an empty body. The client used to surface that as `HTTP_500`, which
 * looks like an application bug; it must instead say the backend is unreachable
 * and tell the user what to do.
 */

function mockFetch(status: number, body: string) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(body, { status, headers: { 'content-type': 'text/plain' } }),
  );
}

describe('backend availability mapping', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a bodyless 500 to BACKEND_UNAVAILABLE', async () => {
    mockFetch(500, '');
    const result = await api.models();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('BACKEND_UNAVAILABLE');
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toMatch(/api server is not responding/i);
    expect(result.error.message).toMatch(/npm run dev/);
  });

  it('does not surface the raw status as the code', async () => {
    mockFetch(500, '');
    const result = await api.models();
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).not.toBe('HTTP_500');
    expect(result.error.message).not.toBe('Request failed with status 500.');
  });

  it('also covers 502 and 503 with no body, which proxies emit during restarts', async () => {
    for (const status of [502, 503]) {
      vi.restoreAllMocks();
      mockFetch(status, '');
      const result = await api.models();
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code, `status ${status}`).toBe('BACKEND_UNAVAILABLE');
    }
  });

  it('keeps a real server error code when the API returns its JSON envelope', async () => {
    const envelope = JSON.stringify({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.', retryable: false },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(envelope, { status: 500, headers: { 'content-type': 'application/json' } }),
    );
    const result = await api.models();
    if (result.ok) throw new Error('expected failure');
    // The API is alive and answered; its own code is more useful than a guess.
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toBe('An unexpected server error occurred.');
  });

  it('still reports validation failures normally', async () => {
    const envelope = JSON.stringify({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid evaluation payload', retryable: false },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(envelope, { status: 422, headers: { 'content-type': 'application/json' } }),
    );
    const result = await api.createEvaluation({ modelId: 'x' });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(result.error.retryable).toBe(false);
  });

  it('reports a network failure distinctly from a backend 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await api.models();
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('NETWORK_ERROR');
    expect(result.error.code).not.toBe('BACKEND_UNAVAILABLE');
  });

  it('reports a timeout distinctly', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort);
    const result = await api.models();
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('TIMEOUT');
  });
});

/**
 * Integration tests for the safe fetcher.
 *
 * Uses a local fixture server for deterministic results.
 * Does NOT make any requests to the public internet.
 *
 * Tests:
 * - Successful HTML fetch
 * - Redirect following (with SSRF check on each hop)
 * - Redirect to private IP is blocked
 * - Redirect loop is stopped at MAX_REDIRECTS
 * - 404 and 500 responses
 * - Non-HTML content type rejection
 * - Timeout handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { safeFetch } from '../../src/crawler/fetcher.js';
import { startFixtureServer, FixtureServer } from '../fixtures/fixtureServer.js';

// Note: SSRF_ALLOWED_HOSTS=localhost is set in tests/setup.ts so the fixture
// server (which runs on localhost) passes the SSRF check during tests.

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await startFixtureServer();
});

afterAll(async () => {
  await fixture.stop();
});

describe('safeFetch — successful fetch', () => {
  it('fetches an HTML page successfully', async () => {
    const result = await safeFetch(`${fixture.baseUrl}/page-a`);
    expect(result.status).toBe('ok');
    expect(result.httpStatus).toBe(200);
    expect(result.body).toContain('Page A');
    expect(result.body).toContain('<title>');
    expect(result.attempts).toBe(1);
  });

  it('follows a redirect and returns the final page', async () => {
    // /page-b → 301 → /page-a
    const result = await safeFetch(`${fixture.baseUrl}/page-b`);
    expect(result.status).toBe('ok');
    expect(result.httpStatus).toBe(200);
    expect(result.redirectChain).toHaveLength(1);
    expect(result.redirectChain[0]).toContain('/page-b');
    expect(result.url).toContain('/page-a');
  });
});

describe('safeFetch — SSRF protection', () => {
  it('blocks direct request to loopback IP', async () => {
    const result = await safeFetch('http://127.0.0.1:1/');
    expect(result.status).toBe('ssrf_blocked');
    expect(result.error).toMatch(/loopback|blocked|unsafe/i);
  });

  it('blocks direct request to private IP 192.168.x.x', async () => {
    const result = await safeFetch('http://192.168.1.100/');
    expect(result.status).toBe('ssrf_blocked');
  });

  it('blocks redirect to private IP 192.168.1.1', async () => {
    // fixture /redirect-to-private → 301 → http://192.168.1.1/
    const result = await safeFetch(`${fixture.baseUrl}/redirect-to-private`);
    expect(result.status).toBe('ssrf_blocked');
    expect(result.error).toMatch(/192\.168|unsafe|blocked/i);
  });

  it('blocks AWS metadata endpoint 169.254.169.254', async () => {
    const result = await safeFetch('http://169.254.169.254/latest/meta-data/');
    expect(result.status).toBe('ssrf_blocked');
  });

  it('blocks URL with embedded credentials', async () => {
    const result = await safeFetch('http://user:pass@example.com/');
    expect(result.status).toBe('ssrf_blocked');
  });
});

describe('safeFetch — redirect limits', () => {
  it('stops after MAX_REDIRECTS hops (redirect loop)', async () => {
    const result = await safeFetch(`${fixture.baseUrl}/loop-a`);
    expect(result.status).toBe('redirect_limit');
  });
});

describe('safeFetch — HTTP error responses', () => {
  it('returns http_error for 404', async () => {
    const result = await safeFetch(`${fixture.baseUrl}/not-found`);
    expect(result.status).toBe('http_error');
    expect(result.httpStatus).toBe(404);
  });

  it('returns http_error for 500', async () => {
    const result = await safeFetch(`${fixture.baseUrl}/server-error`, { maxRetries: 0 });
    expect(result.status).toBe('http_error');
    expect(result.httpStatus).toBe(500);
  });
});

describe('safeFetch — content type', () => {
  it('rejects non-HTML content type (PDF)', async () => {
    const result = await safeFetch(`${fixture.baseUrl}/document.pdf`);
    expect(result.status).toBe('unsupported_content_type');
    expect(result.contentType).toContain('application/pdf');
  });
});

describe('safeFetch — timeout', () => {
  it('times out on a slow response', async () => {
    const result = await safeFetch(`${fixture.baseUrl}/slow`, {
      timeoutMs: 200,
      maxRetries: 0,
    });
    expect(result.status).toBe('timeout');
  }, 5000);

  it('times out when body delivery stalls after response headers', async () => {
    const result = await safeFetch(`${fixture.baseUrl}/slow-body`, {
      timeoutMs: 200,
      maxRetries: 0,
    });
    expect(result.status).toBe('timeout');
  }, 5000);
});

describe('safeFetch — retry behavior', () => {
  it('reports retries_exhausted after all retries on 500', async () => {
    const result = await safeFetch(`${fixture.baseUrl}/server-error`, {
      maxRetries: 1, // 2 total attempts
    });
    // 500 is a 5xx → transient, will retry
    expect(['retries_exhausted', 'http_error']).toContain(result.status);
    expect(result.attempts).toBeGreaterThan(1);
  }, 30000);
});

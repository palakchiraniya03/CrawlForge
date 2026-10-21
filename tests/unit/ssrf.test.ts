/**
 * Unit tests for SSRF protection.
 *
 * Tests cover:
 * - IPv4 loopback, private ranges (10.x, 172.16.x, 192.168.x)
 * - Link-local (169.254.x.x — includes AWS metadata endpoint)
 * - IPv4-mapped IPv6 addresses
 * - IPv6 loopback, unique-local, link-local
 * - Public IP addresses (should pass)
 * - URL-level checks (credentials, bad protocols, embedded IPs)
 */

import { describe, it, expect } from 'vitest';
import { isIpSafe, checkUrlSafe } from '../../src/security/ssrf.js';

describe('isIpSafe — IPv4 blocked ranges', () => {
  it('blocks loopback 127.0.0.1', () => {
    expect(isIpSafe('127.0.0.1').safe).toBe(false);
  });

  it('blocks loopback 127.0.0.2', () => {
    expect(isIpSafe('127.0.0.2').safe).toBe(false);
  });

  it('blocks RFC 1918 — 10.0.0.1', () => {
    expect(isIpSafe('10.0.0.1').safe).toBe(false);
  });

  it('blocks RFC 1918 — 10.255.255.255', () => {
    expect(isIpSafe('10.255.255.255').safe).toBe(false);
  });

  it('blocks RFC 1918 — 172.16.0.1', () => {
    expect(isIpSafe('172.16.0.1').safe).toBe(false);
  });

  it('blocks RFC 1918 — 172.31.255.255', () => {
    expect(isIpSafe('172.31.255.255').safe).toBe(false);
  });

  it('allows 172.32.0.0 (outside 172.16/12)', () => {
    expect(isIpSafe('172.32.0.0').safe).toBe(true);
  });

  it('blocks RFC 1918 — 192.168.1.1', () => {
    expect(isIpSafe('192.168.1.1').safe).toBe(false);
  });

  it('blocks link-local 169.254.0.1', () => {
    expect(isIpSafe('169.254.0.1').safe).toBe(false);
  });

  it('blocks AWS metadata endpoint 169.254.169.254', () => {
    expect(isIpSafe('169.254.169.254').safe).toBe(false);
  });

  it('blocks shared address space 100.64.0.1 (RFC 6598)', () => {
    expect(isIpSafe('100.64.0.1').safe).toBe(false);
  });

  it('blocks multicast 224.0.0.1', () => {
    expect(isIpSafe('224.0.0.1').safe).toBe(false);
  });

  it('blocks broadcast 255.255.255.255', () => {
    expect(isIpSafe('255.255.255.255').safe).toBe(false);
  });

  it('allows a public IP 8.8.8.8', () => {
    expect(isIpSafe('8.8.8.8').safe).toBe(true);
  });

  it('allows a public IP 1.1.1.1', () => {
    expect(isIpSafe('1.1.1.1').safe).toBe(true);
  });

  it('allows a public IP 93.184.216.34 (example.com)', () => {
    expect(isIpSafe('93.184.216.34').safe).toBe(true);
  });

  it('rejects an invalid IP string', () => {
    expect(isIpSafe('not-an-ip').safe).toBe(false);
  });
});

describe('isIpSafe — IPv6 blocked ranges', () => {
  it('blocks IPv6 loopback ::1', () => {
    expect(isIpSafe('::1').safe).toBe(false);
  });

  it('blocks IPv6 link-local fe80::1', () => {
    expect(isIpSafe('fe80::1').safe).toBe(false);
  });

  it('blocks unique-local fc00::1', () => {
    expect(isIpSafe('fc00::1').safe).toBe(false);
  });

  it('blocks unique-local fd00::1', () => {
    expect(isIpSafe('fd00::1').safe).toBe(false);
  });

  it('blocks IPv4-mapped IPv6 ::ffff:192.168.1.1', () => {
    const result = isIpSafe('::ffff:192.168.1.1');
    expect(result.safe).toBe(false);
  });

  it('blocks IPv4-mapped IPv6 ::ffff:127.0.0.1', () => {
    expect(isIpSafe('::ffff:127.0.0.1').safe).toBe(false);
  });

  it('blocks documentation address 2001:db8::1', () => {
    expect(isIpSafe('2001:db8::1').safe).toBe(false);
  });

  it('blocks multicast ff02::1', () => {
    expect(isIpSafe('ff02::1').safe).toBe(false);
  });

  it('allows a public IPv6 2001:4860:4860::8888 (Google DNS)', () => {
    // 2001:4860:: is NOT in the blocked 2001::/23 range used for IETF assignments
    // (IETF assignments are 2001:0000::/23 = 2001:0000:: to 2001:01ff::)
    // 2001:4860:: is outside this range
    const result = isIpSafe('2001:4860:4860::8888');
    expect(result.safe).toBe(true);
  });
});

describe('checkUrlSafe — URL-level checks', () => {
  it('blocks URLs with embedded credentials', async () => {
    const result = await checkUrlSafe('http://user:pass@example.com/');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/credentials/i);
  });

  it('blocks non-http protocols', async () => {
    const result = await checkUrlSafe('ftp://example.com/file');
    expect(result.safe).toBe(false);
  });

  it('blocks file:// protocol', async () => {
    const result = await checkUrlSafe('file:///etc/passwd');
    expect(result.safe).toBe(false);
  });

  it('blocks URL with loopback IP in host', async () => {
    const result = await checkUrlSafe('http://127.0.0.1/admin');
    expect(result.safe).toBe(false);
  });

  it('blocks unusual IP formats — hex, dword, octal for loopback', async () => {
    expect((await checkUrlSafe('http://0x7f000001/')).safe).toBe(false);
    expect((await checkUrlSafe('http://2130706433/')).safe).toBe(false);
    expect((await checkUrlSafe('http://0177.0.0.1/')).safe).toBe(false);
  });

  it('blocks URL with private IP 192.168.1.1', async () => {
    const result = await checkUrlSafe('http://192.168.1.1/');
    expect(result.safe).toBe(false);
  });

  it('blocks URL with AWS metadata IP', async () => {
    const result = await checkUrlSafe('http://169.254.169.254/latest/meta-data/');
    expect(result.safe).toBe(false);
  });

  it('rejects invalid URLs', async () => {
    const result = await checkUrlSafe('not-a-url');
    expect(result.safe).toBe(false);
  });
});

describe('SSRF_ALLOWED_HOSTS production safety guarantees', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSsrfHosts = process.env.SSRF_ALLOWED_HOSTS;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.SSRF_ALLOWED_HOSTS = originalSsrfHosts;
  });

  it('unconditionally blocks localhost in production even if SSRF_ALLOWED_HOSTS is set', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SSRF_ALLOWED_HOSTS = 'localhost';

    const result = await checkUrlSafe('http://localhost/admin');
    expect(result.safe).toBe(false);
  });

  it('does NOT allow IP literals (127.0.0.1, 169.254.169.254) even when localhost is in SSRF_ALLOWED_HOSTS', async () => {
    delete process.env.NODE_ENV;
    process.env.SSRF_ALLOWED_HOSTS = 'localhost';

    const loopback = await checkUrlSafe('http://127.0.0.1/');
    expect(loopback.safe).toBe(false);

    const metadata = await checkUrlSafe('http://169.254.169.254/');
    expect(metadata.safe).toBe(false);
  });
});

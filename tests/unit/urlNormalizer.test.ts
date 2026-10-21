import { describe, it, expect } from 'vitest';
import { normalizeUrl, resolveLinks } from '../../src/utils/urlNormalizer.js';

describe('normalizeUrl', () => {
  it('lowercases scheme and host', () => {
    const r = normalizeUrl('HTTP://Example.COM/path');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('http://example.com/path');
  });

  it('removes default http port 80', () => {
    const r = normalizeUrl('http://example.com:80/path');
    expect(r.normalized).toBe('http://example.com/path');
  });

  it('removes default https port 443', () => {
    const r = normalizeUrl('https://example.com:443/path');
    expect(r.normalized).toBe('https://example.com/path');
  });

  it('keeps non-default port', () => {
    const r = normalizeUrl('http://example.com:8080/path');
    expect(r.normalized).toBe('http://example.com:8080/path');
  });

  it('sorts query parameters', () => {
    const r = normalizeUrl('http://example.com/?z=1&a=2');
    expect(r.normalized).toBe('http://example.com/?a=2&z=1');
  });

  it('removes fragment', () => {
    const r = normalizeUrl('http://example.com/page#section');
    expect(r.normalized).toBe('http://example.com/page');
  });

  it('removes trailing slash', () => {
    const r = normalizeUrl('http://example.com/path/');
    expect(r.normalized).toBe('http://example.com/path');
  });

  it('keeps root slash', () => {
    const r = normalizeUrl('http://example.com/');
    expect(r.valid).toBe(true);
    // root path is just the origin
    expect(r.normalized).toMatch(/^http:\/\/example\.com/);
  });

  it('rejects non-http protocols', () => {
    const r = normalizeUrl('ftp://example.com/file');
    expect(r.valid).toBe(false);
  });

  it('rejects URLs with embedded credentials', () => {
    const r = normalizeUrl('http://user:pass@example.com/page');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/credentials/i);
  });

  it('rejects invalid URLs', () => {
    const r = normalizeUrl('not-a-url');
    expect(r.valid).toBe(false);
  });

  it('resolves relative URL against base', () => {
    const r = normalizeUrl('/about', 'http://example.com/');
    expect(r.valid).toBe(true);
    expect(r.normalized).toContain('example.com/about');
  });

  it('resolves relative href from deep path', () => {
    const r = normalizeUrl('../contact', 'http://example.com/blog/post');
    expect(r.valid).toBe(true);
    expect(r.normalized).toContain('example.com/contact');
  });
});

describe('resolveLinks', () => {
  it('deduplicates and resolves hrefs', () => {
    const hrefs = ['/page', '/page', '/about', 'javascript:void(0)', 'mailto:x@y.com'];
    const results = resolveLinks(hrefs, 'http://example.com');
    expect(results).toHaveLength(2);
    expect(results).toContain('http://example.com/page');
    expect(results).toContain('http://example.com/about');
  });

  it('skips empty hrefs', () => {
    expect(resolveLinks(['', '  '], 'http://example.com')).toHaveLength(0);
  });
});

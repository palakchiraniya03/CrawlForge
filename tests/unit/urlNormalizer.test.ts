
import { describe, it, expect } from 'vitest';
import { normalizeUrl, resolveLinks } from '../../src/utils/urlNormalizer';

describe('normalizeUrl', () => {
  it('lowercases scheme and host', () => {
    const result = normalizeUrl('HTTPS://EXAMPLE.COM/Path');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('https://example.com/Path');
  });

  it('removes default http port 80', () => {
    const result = normalizeUrl('http://example.com:80/page');
    expect(result.normalized).toBe('http://example.com/page');
  });

  it('removes default https port 443', () => {
    const result = normalizeUrl('https://example.com:443/page');
    expect(result.normalized).toBe('https://example.com/page');
  });

  it('keeps non-default port', () => {
    const result = normalizeUrl('http://example.com:8080/page');
    expect(result.normalized).toBe('http://example.com:8080/page');
  });

  it('sorts query parameters', () => {
    const result = normalizeUrl('https://example.com/page?z=2&a=1');
    expect(result.normalized).toBe('https://example.com/page?a=1&z=2');
  });

  it('removes fragment', () => {
    const result = normalizeUrl('https://example.com/page#section');
    expect(result.normalized).toBe('https://example.com/page');
  });

  it('removes trailing slash', () => {
    const result = normalizeUrl('https://example.com/page/');
    expect(result.normalized).toBe('https://example.com/page');
  });

  it('keeps root slash', () => {
    const result = normalizeUrl('https://example.com/');
    expect(result.normalized).toBe('https://example.com/');
  });

  it('rejects non-http protocols', () => {
    const result = normalizeUrl('ftp://example.com/file');
    expect(result.valid).toBe(false);
  });

  it('rejects URLs with embedded credentials', () => {
    const result = normalizeUrl('https://user:pass@example.com/page');
    expect(result.valid).toBe(false);
  });

  it('rejects invalid URLs', () => {
    const result = normalizeUrl('not a valid URL');
    expect(result.valid).toBe(false);
  });

  it('resolves relative URL against base', () => {
    const result = normalizeUrl('/about', 'https://example.com');
    expect(result.normalized).toBe('https://example.com/about');
  });

  it('resolves relative href from deep path', () => {
    const result = normalizeUrl('../about', 'https://example.com/docs/guide/');
    expect(result.normalized).toBe('https://example.com/docs/about');
  });

  it('preserves case-sensitive path characters', () => {
    const result = normalizeUrl('https://example.com/Docs/GetStarted');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('https://example.com/Docs/GetStarted');
  });

  it('preserves case-sensitive query parameter values', () => {
    const result = normalizeUrl('https://example.com/page?Token=AbC123');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('https://example.com/page?Token=AbC123');
  });
});

describe('resolveLinks', () => {
  it('deduplicates and resolves hrefs', () => {
    const result = resolveLinks(
      ['/about', 'https://example.com/about', '/contact'],
      'https://example.com'
    );

    expect(result).toEqual([
      'https://example.com/about',
      'https://example.com/contact',
    ]);
  });

  it('skips empty hrefs', () => {
    const result = resolveLinks(
      ['', '   ', 'javascript:void(0)', 'mailto:test@example.com', '/about'],
      'https://example.com'
    );

    expect(result).toEqual(['https://example.com/about']);
  });
});

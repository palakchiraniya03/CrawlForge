
/**
 * Unit tests for the HTML content extractor.
 */

import { describe, it, expect } from 'vitest';
import { extractContent } from '../../src/crawler/extractor.js';

const BASE = 'http://example.com/';

describe('extractContent', () => {
  it('extracts title', () => {
    const html = `<html><head><title>My Page</title></head><body><p>Hello</p></body></html>`;
    const { title } = extractContent(html, BASE);
    expect(title).toBe('My Page');
  });

  it('returns empty string for missing title', () => {
    const html = `<html><body><p>No title</p></body></html>`;
    expect(extractContent(html, BASE).title).toBe('');
  });

  it('extracts canonical URL', () => {
    const html = `<html><head><link rel="canonical" href="http://example.com/canonical"/></head><body>x</body></html>`;
    expect(extractContent(html, BASE).canonicalUrl).toBe('http://example.com/canonical');
  });

  it('resolves relative canonical URL', () => {
    const html = `<html><head><link rel="canonical" href="/page"/></head><body>x</body></html>`;
    expect(extractContent(html, BASE).canonicalUrl).toBe('http://example.com/page');
  });

  it('returns null canonical when not present', () => {
    expect(extractContent('<html><body>x</body></html>', BASE).canonicalUrl).toBeNull();
  });

  it('extracts text content', () => {
    const html = `<html><body><h1>Heading</h1><p>Paragraph content</p></body></html>`;
    const { textContent } = extractContent(html, BASE);
    expect(textContent).toContain('Heading');
    expect(textContent).toContain('Paragraph content');
  });

  it('strips script and style content from text', () => {
    const html = `<html><body><script>var x = 1;</script><style>.a{color:red}</style><p>Real content</p></body></html>`;
    const { textContent } = extractContent(html, BASE);
    expect(textContent).toContain('Real content');
    expect(textContent).not.toContain('var x');
    expect(textContent).not.toContain('color:red');
  });

  it('extracts and resolves outgoing links', () => {
    const html = `<html><body>
      <a href="/page-a">A</a>
      <a href="http://example.com/page-b">B</a>
      <a href="http://other.com/page">Other</a>
    </body></html>`;
    const { outgoingLinks } = extractContent(html, BASE);
    expect(outgoingLinks).toContain('http://example.com/page-a');
    expect(outgoingLinks).toContain('http://example.com/page-b');
    expect(outgoingLinks).toContain('http://other.com/page');
  });

  it('extracts links inside navigation and sidebar elements', () => {
    const html = `<html><body>
      <nav><a href="/docs/intro">Introduction</a></nav>
      <aside><a href="/docs/advanced">Advanced Guide</a></aside>
      <main><a href="/main-content">Main Content</a></main>
    </body></html>`;

    const { outgoingLinks, textContent } = extractContent(html, BASE);

    expect(outgoingLinks).toContain('http://example.com/docs/intro');
    expect(outgoingLinks).toContain('http://example.com/docs/advanced');
    expect(outgoingLinks).toContain('http://example.com/main-content');

    expect(textContent).not.toContain('Introduction');
    expect(textContent).not.toContain('Advanced Guide');
    expect(textContent).toContain('Main Content');
  });

  it('deduplicates links', () => {
    const html = `<html><body>
      <a href="/page">Link 1</a>
      <a href="/page">Link 2</a>
    </body></html>`;
    const { outgoingLinks } = extractContent(html, BASE);
    const pageLinks = outgoingLinks.filter(l => l.includes('/page'));
    expect(pageLinks).toHaveLength(1);
  });

  it('skips javascript: and mailto: links', () => {
    const html = `<html><body>
      <a href="javascript:void(0)">JS</a>
      <a href="mailto:test@test.com">Mail</a>
    </body></html>`;
    const { outgoingLinks } = extractContent(html, BASE);
    expect(outgoingLinks).toHaveLength(0);
  });
});

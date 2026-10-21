/**
 * Page content extractor using Cheerio.
 *
 * Extracts:
 * - Page title (from <title> tag)
 * - Canonical URL (from <link rel="canonical">)
 * - Readable text content (stripping scripts, styles, nav, header, footer)
 * - Outgoing links (all <a href> values, resolved against the page URL)
 */

import * as cheerio from 'cheerio';
import { resolveLinks } from '../utils/urlNormalizer.js';

export interface ExtractedContent {
  title: string;
  canonicalUrl: string | null;
  textContent: string;
  outgoingLinks: string[];
}

/**
 * Extract structured content from raw HTML.
 *
 * @param html - Raw HTML string
 * @param pageUrl - The URL of the page (used to resolve relative links)
 */
export function extractContent(html: string, pageUrl: string): ExtractedContent {
  const $ = cheerio.load(html);

  // Extract title
  const title = $('title').first().text().trim() || '';

  // Extract canonical URL
  const canonicalHref = $('link[rel="canonical"]').attr('href') ?? null;
  let canonicalUrl: string | null = null;
  if (canonicalHref) {
    try {
      canonicalUrl = new URL(canonicalHref, pageUrl).toString();
    } catch {
      canonicalUrl = null;
    }
  }

  // Remove noise elements before extracting text
  $('script, style, noscript, nav, header, footer, aside, [aria-hidden="true"]').remove();
  $('[style*="display:none"], [style*="display: none"], [hidden]').remove();

  // Extract visible text
  const textContent = $('body')
    .text()
    .replace(/\s+/g, ' ')
    .trim();

  // Extract and resolve outgoing links
  const hrefs: string[] = [];
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href');
    if (href) hrefs.push(href);
  });

  const outgoingLinks = resolveLinks(hrefs, pageUrl);

  return { title, canonicalUrl, textContent, outgoingLinks };
}

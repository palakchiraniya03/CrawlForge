/**
 * Content hashing utilities for incremental crawling.
 *
 * Produces a stable, deterministic SHA-256 hash of extracted page content.
 * Normalizes internal whitespace so insignificant whitespace variations do not
 * trigger spurious version increments.
 */

import { createHash } from 'crypto';

/**
 * Compute a deterministic SHA-256 hash of title and text content.
 *
 * @param title - Extracted page title
 * @param textContent - Extracted readable text content
 */
export function computeContentHash(title: string, textContent: string): string {
  const normalizedTitle = title.trim();
  const normalizedText = textContent.replace(/\s+/g, ' ').trim();
  const payload = `${normalizedTitle}\n${normalizedText}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Unit tests for content hashing and normalization.
 */

import { describe, it, expect } from 'vitest';
import { computeContentHash } from '../../src/utils/contentHash.js';

describe('computeContentHash', () => {
  it('computes a deterministic 64-character hex SHA-256 hash', () => {
    const hash = computeContentHash('My Title', 'Page body text.');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // Determinism
    expect(computeContentHash('My Title', 'Page body text.')).toBe(hash);
  });

  it('normalizes internal whitespace so insignificant whitespace changes do not change hash', () => {
    const h1 = computeContentHash('Title', 'Paragraph one.   Paragraph   two.\n\nParagraph three.');
    const h2 = computeContentHash('Title', 'Paragraph one. Paragraph two. Paragraph three.');
    const h3 = computeContentHash('  Title  ', 'Paragraph one. \t Paragraph two. \n Paragraph three.');
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
  });

  it('produces different hash when title changes', () => {
    const h1 = computeContentHash('Title 1', 'Identical content.');
    const h2 = computeContentHash('Title 2', 'Identical content.');
    expect(h1).not.toBe(h2);
  });

  it('produces different hash when body text changes', () => {
    const h1 = computeContentHash('Title', 'Original text.');
    const h2 = computeContentHash('Title', 'Updated text with changes.');
    expect(h1).not.toBe(h2);
  });
});

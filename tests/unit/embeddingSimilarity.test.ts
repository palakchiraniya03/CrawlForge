import { describe, it, expect } from 'vitest';
import {
  dotProduct,
  vectorMagnitude,
  cosineSimilarity,
  normalizeVector,
} from '../../src/embeddings/similarity.js';

describe('Vector Similarity Math — dotProduct', () => {
  it('computes dot product of identical vectors correctly', () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    expect(dotProduct(a, b)).toBe(1 * 1 + 2 * 2 + 3 * 3); // 14
  });

  it('computes dot product of orthogonal vectors as 0', () => {
    const a = [1, 0];
    const b = [0, 1];
    expect(dotProduct(a, b)).toBe(0);
  });

  it('computes negative dot product for opposing vectors', () => {
    const a = [1, 2];
    const b = [-1, -2];
    expect(dotProduct(a, b)).toBe(-5);
  });

  it('throws error when vector dimensions mismatch', () => {
    const a = [1, 2];
    const b = [1, 2, 3];
    expect(() => dotProduct(a, b)).toThrow(/Vector length mismatch/);
  });
});

describe('Vector Similarity Math — vectorMagnitude', () => {
  it('calculates Euclidean norm correctly (3-4-5 triangle)', () => {
    expect(vectorMagnitude([3, 4])).toBe(5);
  });

  it('calculates zero magnitude for zero vector', () => {
    expect(vectorMagnitude([0, 0, 0])).toBe(0);
  });

  it('calculates 1.0 magnitude for unit vectors', () => {
    expect(vectorMagnitude([1, 0, 0])).toBe(1);
    expect(vectorMagnitude([0, 1, 0])).toBe(1);
  });
});

describe('Vector Similarity Math — cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('returns 1.0 for collinear vectors of different magnitudes', () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns -1.0 for directly opposite vectors', () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('returns 0 if either vector has zero magnitude', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('throws error if dimensions do not match', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/Vector dimension mismatch/);
  });

  it('clamps results within [-1, 1] range', () => {
    const sim = cosineSimilarity([1, 1], [1, 1]);
    expect(sim).toBeLessThanOrEqual(1);
    expect(sim).toBeGreaterThanOrEqual(-1);
  });
});

describe('Vector Similarity Math — normalizeVector', () => {
  it('normalizes vector to unit length', () => {
    const v = [3, 4];
    const norm = normalizeVector(v);
    expect(norm[0]).toBeCloseTo(0.6, 5);
    expect(norm[1]).toBeCloseTo(0.8, 5);
    expect(vectorMagnitude(norm)).toBeCloseTo(1.0, 5);
  });

  it('returns unchanged copy for zero vector', () => {
    const v = [0, 0, 0];
    const norm = normalizeVector(v);
    expect(norm).toEqual([0, 0, 0]);
  });
});

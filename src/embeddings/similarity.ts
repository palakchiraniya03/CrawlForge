/**
 * Vector similarity math utilities for semantic search.
 */

/**
 * Compute the dot product between two vectors.
 */
export function dotProduct(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Compute the Euclidean norm (L2 magnitude) of a vector.
 */
export function vectorMagnitude(a: number[]): number {
  let sumSq = 0;
  for (let i = 0; i < a.length; i++) {
    sumSq += a[i] * a[i];
  }
  return Math.sqrt(sumSq);
}

/**
 * Compute the cosine similarity between two vectors.
 * Returns a value between -1.0 and 1.0 (typically 0.0 to 1.0 for embeddings).
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch in cosine similarity: ${a.length} vs ${b.length}`);
  }

  const magA = vectorMagnitude(a);
  const magB = vectorMagnitude(b);

  if (magA === 0 || magB === 0) {
    return 0;
  }

  const dot = dotProduct(a, b);
  const sim = dot / (magA * magB);

  // Clamp within [-1, 1] to guard against floating-point precision inaccuracies
  return Math.max(-1, Math.min(1, sim));
}

/**
 * Normalize a vector to unit length (L2 norm = 1).
 */
export function normalizeVector(v: number[]): number[] {
  const mag = vectorMagnitude(v);
  if (mag === 0) {
    return v.slice();
  }
  return v.map(x => x / mag);
}

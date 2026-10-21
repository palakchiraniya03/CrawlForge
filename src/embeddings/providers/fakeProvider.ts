import type { EmbeddingProvider } from '../types.js';
import { normalizeVector } from '../similarity.js';

/**
 * Deterministic fake embedding provider for offline unit and integration tests.
 *
 * Properties:
 * - 100% deterministic (same text always produces the exact same vector).
 * - Maps conceptually related synonyms into correlated vector dimensions.
 * - Requires zero network I/O, zero model downloads, and zero external dependencies.
 * - Always returns unit-normalized vectors.
 */
export class DeterministicFakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'test-fake';
  readonly dimensions: number;

  private static readonly CLUSTERS: Record<string, number[]> = {
    // Web crawling cluster -> dimensions 0, 1
    crawler: [0, 1],
    crawl: [0, 1],
    crawling: [0, 1],
    spider: [0, 1],
    scraping: [0, 1],
    scraper: [0, 1],
    frontier: [0, 1],
    harvest: [0, 1],

    // Search and retrieval cluster -> dimensions 4, 5
    search: [4, 5],
    engine: [4, 5],
    indexing: [4, 5],
    index: [4, 5],
    query: [4, 5],
    retrieval: [4, 5],
    bm25: [4, 5],
    ranking: [4, 5],

    // Food and baking cluster -> dimensions 8, 9
    bread: [8, 9],
    sourdough: [8, 9],
    baking: [8, 9],
    bake: [8, 9],
    flour: [8, 9],
    yeast: [8, 9],
    dough: [8, 9],
    recipe: [8, 9],
    culinary: [8, 9],

    // Astronomy and science cluster -> dimensions 12, 13
    astronomy: [12, 13],
    stars: [12, 13],
    galaxies: [12, 13],
    galaxy: [12, 13],
    telescope: [12, 13],
    space: [12, 13],
    cosmos: [12, 13],
  };

  constructor(dimensions: number = 16) {
    this.dimensions = Math.max(16, dimensions);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async embedText(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0);

    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(t => t.length > 0);

    if (tokens.length === 0) {
      // Small base uniform vector if completely empty
      return normalizeVector(new Array<number>(this.dimensions).fill(1 / Math.sqrt(this.dimensions)));
    }

    for (const token of tokens) {
      // Check if token matches known semantic cluster
      const clusterDims = DeterministicFakeEmbeddingProvider.CLUSTERS[token];
      if (clusterDims) {
        for (const dim of clusterDims) {
          if (dim < this.dimensions) {
            vector[dim] += 2.0;
          }
        }
      } else {
        // General hash projection for unknown words
        const hash = this.simpleHash(token);
        const dim = Math.abs(hash) % this.dimensions;
        vector[dim] += 0.3;
      }
    }

    return normalizeVector(vector);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embedText(t)));
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }
}

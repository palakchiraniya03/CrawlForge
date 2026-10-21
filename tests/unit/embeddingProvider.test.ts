import { describe, it, expect } from 'vitest';
import { UnconfiguredEmbeddingProvider } from '../../src/embeddings/providers/unconfiguredProvider.js';
import { DeterministicFakeEmbeddingProvider } from '../../src/embeddings/providers/fakeProvider.js';
import { LocalHttpEmbeddingProvider } from '../../src/embeddings/providers/localHttpProvider.js';
import { cosineSimilarity, vectorMagnitude } from '../../src/embeddings/similarity.js';

describe('UnconfiguredEmbeddingProvider', () => {
  const provider = new UnconfiguredEmbeddingProvider();

  it('has name unconfigured and 0 dimensions', () => {
    expect(provider.name).toBe('unconfigured');
    expect(provider.dimensions).toBe(0);
  });

  it('reports unavailable', async () => {
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it('throws descriptive error on embedText', async () => {
    await expect(provider.embedText('test')).rejects.toThrow(
      /Semantic search is unavailable: no embedding provider is configured/,
    );
  });
});

describe('DeterministicFakeEmbeddingProvider', () => {
  it('instantiates with custom or default dimensions', () => {
    const defaultProvider = new DeterministicFakeEmbeddingProvider();
    expect(defaultProvider.dimensions).toBe(16);

    const customProvider = new DeterministicFakeEmbeddingProvider(32);
    expect(customProvider.dimensions).toBe(32);
  });

  it('reports available', async () => {
    const provider = new DeterministicFakeEmbeddingProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('produces identical vectors deterministically for identical text', async () => {
    const provider = new DeterministicFakeEmbeddingProvider();
    const v1 = await provider.embedText('web crawler architecture with frontier');
    const v2 = await provider.embedText('web crawler architecture with frontier');
    expect(v1).toEqual(v2);
  });

  it('produces unit-normalized vectors (magnitude close to 1.0)', async () => {
    const provider = new DeterministicFakeEmbeddingProvider();
    const v = await provider.embedText('baking sourdough bread with yeast');
    const mag = vectorMagnitude(v);
    expect(mag).toBeCloseTo(1.0, 5);
  });

  it('handles empty text gracefully without NaN', async () => {
    const provider = new DeterministicFakeEmbeddingProvider();
    const v = await provider.embedText('');
    expect(v.length).toBe(16);
    expect(v.every(n => !isNaN(n))).toBe(true);
  });

  it('reflects semantic cluster correlation (synonyms correlate, unrelated diverge)', async () => {
    const provider = new DeterministicFakeEmbeddingProvider();
    const vCrawler = await provider.embedText('crawler spider');
    const vScraper = await provider.embedText('scraper harvest');
    const vBread = await provider.embedText('bread sourdough flour');

    const simSynonyms = cosineSimilarity(vCrawler, vScraper);
    const simUnrelated = cosineSimilarity(vCrawler, vBread);

    expect(simSynonyms).toBeGreaterThan(0.7);
    expect(simUnrelated).toBeLessThan(0.3);
  });
});

describe('LocalHttpEmbeddingProvider', () => {
  it('instantiates with specified options or defaults', () => {
    const provider = new LocalHttpEmbeddingProvider({
      endpoint: 'http://localhost:11434/api/embeddings',
      model: 'all-minilm',
      timeoutMs: 1000,
    });
    expect(provider.name).toBe('local-http');
    expect(provider.dimensions).toBe(384);
  });

  it('returns false for isAvailable when service endpoint is unreachable', async () => {
    const provider = new LocalHttpEmbeddingProvider({
      endpoint: 'http://127.0.0.1:59999/unreachable',
      timeoutMs: 500,
    });
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it('throws descriptive error on embedText when service is unreachable', async () => {
    const provider = new LocalHttpEmbeddingProvider({
      endpoint: 'http://127.0.0.1:59999/unreachable',
      timeoutMs: 500,
    });
    await expect(provider.embedText('test text')).rejects.toThrow(/Local embedding provider request failed/);
  });
});

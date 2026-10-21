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
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('instantiates with dimensions 0 when unknown, or respects explicit dimensions', () => {
    const unknownProvider = new LocalHttpEmbeddingProvider({
      endpoint: 'http://localhost:11434/api/embed',
      model: 'nomic-embed-text:latest',
    });
    expect(unknownProvider.name).toBe('local-http');
    expect(unknownProvider.dimensions).toBe(0);

    const explicitProvider = new LocalHttpEmbeddingProvider({
      endpoint: 'http://localhost:11434/api/embed',
      model: 'nomic-embed-text:latest',
      dimensions: 768,
    });
    expect(explicitProvider.dimensions).toBe(768);
  });

  it('supports Ollama /api/embed format and dynamically updates dimensions', async () => {
    const mockVector = new Array(768).fill(0.05);
    let capturedBody: any;

    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          model: 'nomic-embed-text:latest',
          embeddings: [mockVector],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const provider = new LocalHttpEmbeddingProvider({
      endpoint: 'http://localhost:11434/api/embed',
      model: 'nomic-embed-text:latest',
    });

    expect(provider.dimensions).toBe(0);

    const vector = await provider.embedText('semantic text embedding');
    expect(capturedBody).toEqual({
      model: 'nomic-embed-text:latest',
      input: 'semantic text embedding',
    });
    expect(vector).toHaveLength(768);
    expect(vector[0]).toBe(0.05);
    expect(provider.dimensions).toBe(768);
  });

  it('supports legacy Ollama /api/embeddings format', async () => {
    const mockVector = [0.1, 0.2, 0.3, 0.4];
    let capturedBody: any;

    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          embedding: mockVector,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const provider = new LocalHttpEmbeddingProvider({
      endpoint: 'http://localhost:11434/api/embeddings',
      model: 'all-minilm',
    });

    const vector = await provider.embedText('legacy format test');
    expect(capturedBody).toEqual({
      model: 'all-minilm',
      prompt: 'legacy format test',
    });
    expect(vector).toEqual(mockVector);
    expect(provider.dimensions).toBe(4);
  });

  it('supports OpenAI / LocalAI /v1/embeddings format', async () => {
    const mockVector = [0.7, 0.8];
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          data: [{ embedding: mockVector }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const provider = new LocalHttpEmbeddingProvider({
      endpoint: 'http://localhost:8080/v1/embeddings',
      model: 'text-embedding-ada-002',
    });

    const vector = await provider.embedText('openai format');
    expect(vector).toEqual(mockVector);
    expect(provider.dimensions).toBe(2);
  });

  it('validates returned vector is nonempty and contains only finite numbers', async () => {
    // 1. Empty embeddings array
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const provider1 = new LocalHttpEmbeddingProvider();
    await expect(provider1.embedText('test')).rejects.toThrow(/must be a non-empty array of finite numbers/);

    // 2. Vector with NaN
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[0.1, NaN, 0.3]] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const provider2 = new LocalHttpEmbeddingProvider();
    await expect(provider2.embedText('test')).rejects.toThrow(/must be a non-empty array of finite numbers/);

    // 3. Vector with Infinity
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[0.1, Infinity, 0.3]] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const provider3 = new LocalHttpEmbeddingProvider();
    await expect(provider3.embedText('test')).rejects.toThrow(/must be a non-empty array of finite numbers/);

    // 4. Vector with non-number values
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[0.1, 'invalid', 0.3]] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const provider4 = new LocalHttpEmbeddingProvider();
    await expect(provider4.embedText('test')).rejects.toThrow(/must be a non-empty array of finite numbers/);
  });

  it('handles provider HTTP errors and response-embedded error messages', async () => {
    // HTTP 404 with error detail
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'model "unknown-model" not found' }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const provider1 = new LocalHttpEmbeddingProvider();
    await expect(provider1.embedText('test')).rejects.toThrow(/Local embedding provider HTTP error: 404 Not Found: model "unknown-model" not found/);

    // HTTP 200 with error property
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'context length exceeded' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const provider2 = new LocalHttpEmbeddingProvider();
    await expect(provider2.embedText('test')).rejects.toThrow(/Local embedding provider error: context length exceeded/);
  });

  it('isAvailable sends compatible ping and returns true on valid response', async () => {
    let capturedBodyEmbed: any;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBodyEmbed = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 });
    });

    const providerEmbed = new LocalHttpEmbeddingProvider({
      endpoint: 'http://localhost:11434/api/embed',
      model: 'nomic-embed-text:latest',
    });

    const available = await providerEmbed.isAvailable();
    expect(available).toBe(true);
    expect(capturedBodyEmbed).toEqual({
      model: 'nomic-embed-text:latest',
      input: 'ping',
    });
    expect(providerEmbed.dimensions).toBe(2);

    // Legacy endpoint verification
    let capturedBodyLegacy: any;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBodyLegacy = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 });
    });

    const providerLegacy = new LocalHttpEmbeddingProvider({
      endpoint: 'http://localhost:11434/api/embeddings',
      model: 'all-minilm',
    });

    const legacyAvailable = await providerLegacy.isAvailable();
    expect(legacyAvailable).toBe(true);
    expect(capturedBodyLegacy).toEqual({
      model: 'all-minilm',
      prompt: 'ping',
    });
    expect(providerLegacy.dimensions).toBe(3);
  });

  it('returns false for isAvailable when service is unreachable or errors', async () => {
    // Unreachable network endpoint
    const providerUnreachable = new LocalHttpEmbeddingProvider({
      endpoint: 'http://127.0.0.1:59999/unreachable',
      timeoutMs: 500,
    });
    const available = await providerUnreachable.isAvailable();
    expect(available).toBe(false);

    // Provider returns HTTP 500
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );
    const providerError = new LocalHttpEmbeddingProvider();
    expect(await providerError.isAvailable()).toBe(false);
  });

  it('throws descriptive error on embedText when service is unreachable', async () => {
    const provider = new LocalHttpEmbeddingProvider({
      endpoint: 'http://127.0.0.1:59999/unreachable',
      timeoutMs: 500,
    });
    await expect(provider.embedText('test text')).rejects.toThrow(/Local embedding provider request failed/);
  });
});

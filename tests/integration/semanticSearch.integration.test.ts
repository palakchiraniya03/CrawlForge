import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { PageStore } from '../../src/db/pageStore.js';
import { SearchIndexer } from '../../src/search/indexer.js';
import { SearchService } from '../../src/search/searchService.js';
import { EmbeddingService } from '../../src/embeddings/embeddingService.js';
import { DeterministicFakeEmbeddingProvider } from '../../src/embeddings/providers/fakeProvider.js';
import { UnconfiguredEmbeddingProvider } from '../../src/embeddings/providers/unconfiguredProvider.js';

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const TEST_DB = 'crawlforge_test_semantic_search';

let client: MongoClient;
let db: Db;
let pageStore: PageStore;
let indexer: SearchIndexer;
let embeddingService: EmbeddingService;
let searchService: SearchService;
let fakeProvider: DeterministicFakeEmbeddingProvider;

beforeAll(async () => {
  client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(TEST_DB);

  pageStore = new PageStore(db);
  await pageStore.init();

  indexer = new SearchIndexer(db);
  await indexer.init();

  fakeProvider = new DeterministicFakeEmbeddingProvider(16);
  embeddingService = new EmbeddingService(db, fakeProvider);
  await embeddingService.init();

  searchService = new SearchService(db, indexer, embeddingService);
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  await pageStore.drop();
  await pageStore.init();
  await indexer.drop();
  await indexer.init();
  await embeddingService.drop();
  await embeddingService.init();
});

describe('SearchService — Semantic Search', () => {
  beforeEach(async () => {
    // Seed three distinct pages
    await pageStore.savePage({
      url: 'http://example.com/crawler-doc',
      origin: 'http://example.com',
      title: 'Web Crawler Architecture',
      textContent: 'High throughput crawler spider queue frontier.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    await pageStore.savePage({
      url: 'http://example.com/baking-doc',
      origin: 'http://example.com',
      title: 'Artisan Sourdough Bread',
      textContent: 'Baking sourdough bread with organic flour yeast and dough recipe.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    await pageStore.savePage({
      url: 'http://example.com/astronomy-doc',
      origin: 'http://example.com',
      title: 'Deep Space Astronomy',
      textContent: 'Telescope observations of distant stars and galaxies in cosmos.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    await indexer.indexAll();
    await embeddingService.backfill();
  });

  it('ranks conceptually related document highest in semantic mode', async () => {
    // "harvest scraping" is in the crawler cluster (dims 0, 1)
    const result = await searchService.search('harvest scraping', { mode: 'semantic' });

    expect(result.mode).toBe('semantic');
    expect(result.total).toBeGreaterThan(0);
    expect(result.results[0].url).toBe('http://example.com/crawler-doc');
    expect(result.results[0].score).toBeGreaterThan(0);
    expect(result.results[0].semanticScore).toBeDefined();
  });

  it('ranks culinary document highest for baking query in semantic mode', async () => {
    const result = await searchService.search('culinary bake', { mode: 'semantic' });

    expect(result.mode).toBe('semantic');
    expect(result.total).toBeGreaterThan(0);
    expect(result.results[0].url).toBe('http://example.com/baking-doc');
  });

  it('handles empty query gracefully returning 0 results', async () => {
    const result = await searchService.search('   ', { mode: 'semantic' });
    expect(result.total).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('respects limit and offset in semantic search', async () => {
    const resPage1 = await searchService.search('science astronomy', { mode: 'semantic', limit: 1, offset: 0 });
    const resPage2 = await searchService.search('science astronomy', { mode: 'semantic', limit: 1, offset: 1 });

    expect(resPage1.results).toHaveLength(1);
    expect(resPage2.results).toHaveLength(1);
    expect(resPage1.results[0].url).not.toBe(resPage2.results[0].url);
  });

  it('excludes stale embeddings from semantic search results', async () => {
    // Update crawler-doc content without re-embedding
    await pageStore.savePage({
      url: 'http://example.com/crawler-doc',
      origin: 'http://example.com',
      title: 'Changed Topic',
      textContent: 'Completely different content now.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const result = await searchService.search('spider crawler', { mode: 'semantic' });
    const crawlerFound = result.results.some(r => r.url === 'http://example.com/crawler-doc');
    expect(crawlerFound).toBe(false);
  });
});

describe('SearchService — Hybrid Retrieval (RRF)', () => {
  beforeEach(async () => {
    // Document A: Matches both lexical ("spider") and semantic (crawler cluster)
    await pageStore.savePage({
      url: 'http://example.com/page-both',
      origin: 'http://example.com',
      title: 'Spider Web Crawler',
      textContent: 'Spider frontier crawler scraper.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    // Document B: Matches lexical ("spider") but different semantics
    await pageStore.savePage({
      url: 'http://example.com/page-lexical-only',
      origin: 'http://example.com',
      title: 'Spider Insect Biology',
      textContent: 'Spider arachnid biology and silk spinning.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    // Document C: Matches semantic cluster (harvest scraper) without exact keyword "spider"
    await pageStore.savePage({
      url: 'http://example.com/page-semantic-only',
      origin: 'http://example.com',
      title: 'Harvest Scraping Tool',
      textContent: 'Harvest scraping tool with automated scheduler.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    await indexer.indexAll();
    await embeddingService.backfill();
  });

  it('fuses lexical and semantic results and assigns source attributes', async () => {
    const result = await searchService.search('spider', { mode: 'hybrid' });

    expect(result.mode).toBe('hybrid');
    expect(result.total).toBeGreaterThanOrEqual(2);

    // URL deduplication: every URL appears at most once
    const urls = result.results.map(r => r.url);
    const uniqueUrls = new Set(urls);
    expect(urls.length).toBe(uniqueUrls.size);

    // Check source attribution
    const pageBoth = result.results.find(r => r.url === 'http://example.com/page-both');
    expect(pageBoth).toBeDefined();
    expect(pageBoth?.source).toBe('both');
    expect(pageBoth?.lexicalScore).toBeDefined();
    expect(pageBoth?.semanticScore).toBeDefined();
  });

  it('breaks ties deterministically on URL for equal RRF scores', async () => {
    // Two documents with identical lexical and semantic ranks
    await pageStore.savePage({
      url: 'http://example.com/zeta',
      origin: 'http://example.com',
      title: 'Galaxies Cosmos',
      textContent: 'Telescope stars cosmos galaxies.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });
    await pageStore.savePage({
      url: 'http://example.com/alpha',
      origin: 'http://example.com',
      title: 'Galaxies Cosmos',
      textContent: 'Telescope stars cosmos galaxies.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    await indexer.indexAll();
    await embeddingService.backfill();

    const result = await searchService.search('galaxies', { mode: 'hybrid' });
    const alphaIdx = result.results.findIndex(r => r.url === 'http://example.com/alpha');
    const zetaIdx = result.results.findIndex(r => r.url === 'http://example.com/zeta');

    if (alphaIdx !== -1 && zetaIdx !== -1) {
      expect(alphaIdx).toBeLessThan(zetaIdx);
    }
  });

  it('falls back to lexical search when embedding service has unconfigured provider', async () => {
    const unconfiguredProvider = new UnconfiguredEmbeddingProvider();
    const fallbackEmbeddingService = new EmbeddingService(db, unconfiguredProvider);
    const fallbackSearchService = new SearchService(db, indexer, fallbackEmbeddingService);

    const result = await fallbackSearchService.search('spider', { mode: 'hybrid' });
    expect(result.mode).toBe('hybrid');
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('fell back to lexical BM25');
    expect(result.total).toBeGreaterThan(0);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { SearchIndexer } from '../../src/search/indexer.js';
import { SearchService } from '../../src/search/searchService.js';
import { computeContentHash } from '../../src/utils/contentHash.js';
import { PageDoc } from '../../src/db/pageSchema.js';

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const TEST_DB = 'crawlforge_test_search_service';

let client: MongoClient;
let db: Db;
let indexer: SearchIndexer;
let searchService: SearchService;

beforeAll(async () => {
  client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(TEST_DB);
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  indexer = new SearchIndexer(db);
  await indexer.drop();
  await indexer.init();

  searchService = new SearchService(db, indexer);
});

async function seedFixtureDocuments() {
  const docs: PageDoc[] = [
    {
      url: 'http://localhost:3000/crawler',
      origin: 'http://localhost:3000',
      title: 'TypeScript Web Crawler Architecture',
      textContent:
        'Building a safe, scalable web crawler using TypeScript and Node.js. Covers URL frontier, SSRF security, robots.txt compliance, and incremental recrawling mechanisms.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash(
        'TypeScript Web Crawler Architecture',
        'Building a safe, scalable web crawler using TypeScript and Node.js. Covers URL frontier, SSRF security, robots.txt compliance, and incremental recrawling mechanisms.',
      ),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    },
    {
      url: 'http://localhost:3000/search-engine',
      origin: 'http://localhost:3000',
      title: 'Search Engine Optimization and Information Retrieval',
      textContent:
        'A comprehensive guide to building a search engine. Explains inverted index data structures, term frequency, document frequency, and BM25 ranking algorithms for information retrieval.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash(
        'Search Engine Optimization and Information Retrieval',
        'A comprehensive guide to building a search engine. Explains inverted index data structures, term frequency, document frequency, and BM25 ranking algorithms for information retrieval.',
      ),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    },
    {
      url: 'http://localhost:3000/baking',
      origin: 'http://localhost:3000',
      title: 'Artisan Sourdough Bread Baking',
      textContent:
        'A step-by-step masterclass on sourdough bread baking. Learn about organic flour, wild yeast hydration, fermentation timing, and baking techniques in a hot Dutch oven.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash(
        'Artisan Sourdough Bread Baking',
        'A step-by-step masterclass on sourdough bread baking. Learn about organic flour, wild yeast hydration, fermentation timing, and baking techniques in a hot Dutch oven.',
      ),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    },
  ];

  for (const doc of docs) {
    await indexer.indexPage(doc);
  }
}

describe('SearchService — BM25 Scoring and Ranking', () => {
  beforeEach(async () => {
    await seedFixtureDocuments();
  });

  it('ranks relevant documents above unrelated documents', async () => {
    const result = await searchService.search('crawler');

    expect(result.total).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe('http://localhost:3000/crawler');
    expect(result.results[0].title).toBe('TypeScript Web Crawler Architecture');
    expect(result.results[0].score).toBeGreaterThan(0);
    expect(result.results[0].snippet).toContain('crawler');
  });

  it('ranks document with more query term occurrences higher in BM25', async () => {
    const result = await searchService.search('search engine');

    // Both crawler and search-engine docs may match, but search-engine doc must rank first
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.results[0].url).toBe('http://localhost:3000/search-engine');
    expect(result.results[0].score).toBeGreaterThan(0);

    // Unrelated baking doc must not be in results
    const urls = result.results.map(r => r.url);
    expect(urls).not.toContain('http://localhost:3000/baking');
  });

  it('finds baking bread document on food query', async () => {
    const result = await searchService.search('sourdough bread yeast');

    expect(result.total).toBe(1);
    expect(result.results[0].url).toBe('http://localhost:3000/baking');
    expect(result.results[0].score).toBeGreaterThan(0);
    expect(result.results[0].snippet.toLowerCase()).toContain('sourdough');
  });

  it('ranks title matches higher than body-only matches for equal-length documents due to title boost', async () => {
    // Doc A: Title contains keyword 'database'
    const docA: PageDoc = {
      url: 'http://localhost:3000/title-match',
      origin: 'http://localhost:3000',
      title: 'Database Architecture Systems',
      textContent: 'Modern backend programming techniques and engineering fundamentals.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash('Database Architecture Systems', 'Modern backend programming techniques and engineering fundamentals.'),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    // Doc B: Body contains keyword 'database' once; title does not
    const docB: PageDoc = {
      url: 'http://localhost:3000/body-match',
      origin: 'http://localhost:3000',
      title: 'Modern Architecture Systems',
      textContent: 'Database backend programming techniques and engineering fundamentals.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash('Modern Architecture Systems', 'Database backend programming techniques and engineering fundamentals.'),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    await indexer.indexPage(docA);
    await indexer.indexPage(docB);

    const result = await searchService.search('database');
    expect(result.results.length).toBeGreaterThanOrEqual(2);

    // Doc A has title match (boost 2) -> must rank above Doc B (body match, count 1)
    expect(result.results[0].url).toBe('http://localhost:3000/title-match');
    expect(result.results[1].url).toBe('http://localhost:3000/body-match');
    expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
  });
});

describe('SearchService — Query Edge Cases', () => {
  beforeEach(async () => {
    await seedFixtureDocuments();
  });

  it('returns empty results for empty or whitespace query', async () => {
    const r1 = await searchService.search('');
    expect(r1.total).toBe(0);
    expect(r1.results).toHaveLength(0);

    const r2 = await searchService.search('     ');
    expect(r2.total).toBe(0);
    expect(r2.results).toHaveLength(0);
  });

  it('returns empty results for query consisting only of stop words', async () => {
    const res = await searchService.search('the and of in on with a');
    expect(res.total).toBe(0);
    expect(res.results).toHaveLength(0);
  });

  it('handles unknown search terms gracefully without errors', async () => {
    const res = await searchService.search('supercalifragilisticexpialidocious');
    expect(res.total).toBe(0);
    expect(res.results).toHaveLength(0);
  });

  it('handles search when index is completely empty', async () => {
    await indexer.drop();
    await indexer.init();

    const res = await searchService.search('crawler');
    expect(res.total).toBe(0);
    expect(res.results).toHaveLength(0);
  });
});

describe('SearchService — Pagination and Snippets', () => {
  beforeEach(async () => {
    // Seed 5 pages matching the term 'article'
    for (let i = 1; i <= 5; i++) {
      const doc: PageDoc = {
        url: `http://localhost:3000/page-${i}`,
        origin: 'http://localhost:3000',
        title: `Article Number ${i}`,
        textContent: `This is an indexed article content document number ${i} discussing web topics.`,
        outgoingLinks: [],
        httpStatus: 200,
        contentType: 'text/html',
        contentHash: computeContentHash(`Article Number ${i}`, `Content ${i}`),
        version: 1,
        firstCrawledAt: new Date(),
        lastCrawledAt: new Date(),
        lastChangedAt: new Date(),
      };
      await indexer.indexPage(doc);
    }
  });

  it('respects limit and offset parameters', async () => {
    // First page: limit 2, offset 0
    const page1 = await searchService.search('article', { limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.results).toHaveLength(2);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);

    // Second page: limit 2, offset 2
    const page2 = await searchService.search('article', { limit: 2, offset: 2 });
    expect(page2.total).toBe(5);
    expect(page2.results).toHaveLength(2);
    expect(page2.offset).toBe(2);

    // Third page: limit 2, offset 4
    const page3 = await searchService.search('article', { limit: 2, offset: 4 });
    expect(page3.total).toBe(5);
    expect(page3.results).toHaveLength(1);

    // Past end: offset 10
    const emptyPage = await searchService.search('article', { limit: 2, offset: 10 });
    expect(emptyPage.total).toBe(5);
    expect(emptyPage.results).toHaveLength(0);

    // Verify disjoint results between page 1 and page 2
    const urls1 = page1.results.map(r => r.url);
    const urls2 = page2.results.map(r => r.url);
    for (const u of urls1) {
      expect(urls2).not.toContain(u);
    }
  });

  it('produces formatted snippets with keyword highlighted in context', async () => {
    const res = await searchService.search('article', { limit: 1 });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].snippet).toBeDefined();
    expect(res.results[0].snippet.toLowerCase()).toContain('article');
  });

  it('uses URL-based secondary sort to ensure deterministic pagination for identical BM25 scores', async () => {
    // Drop and reinitialize to have only two identical score documents
    await indexer.drop();
    await indexer.init();

    const identicalContent = 'Identical body text content about robotics.';
    const hash = computeContentHash('Robotics Manual', identicalContent);

    // Two documents with identical title and text, but distinct URLs
    const docB: PageDoc = {
      url: 'http://localhost:3000/robotics-beta',
      origin: 'http://localhost:3000',
      title: 'Robotics Manual',
      textContent: identicalContent,
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: hash,
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    const docA: PageDoc = {
      url: 'http://localhost:3000/robotics-alpha',
      origin: 'http://localhost:3000',
      title: 'Robotics Manual',
      textContent: identicalContent,
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: hash,
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    // Index beta first, then alpha
    await indexer.indexPage(docB);
    await indexer.indexPage(docA);

    // Search for 'robotics'
    const fullResult = await searchService.search('robotics');
    expect(fullResult.total).toBe(2);
    // Scores must be identical
    expect(fullResult.results[0].score).toBe(fullResult.results[1].score);

    // Secondary sort: alpha must precede beta alphabetically
    expect(fullResult.results[0].url).toBe('http://localhost:3000/robotics-alpha');
    expect(fullResult.results[1].url).toBe('http://localhost:3000/robotics-beta');

    // Deterministic pagination across page boundaries
    const page1 = await searchService.search('robotics', { limit: 1, offset: 0 });
    const page2 = await searchService.search('robotics', { limit: 1, offset: 1 });

    expect(page1.results[0].url).toBe('http://localhost:3000/robotics-alpha');
    expect(page2.results[0].url).toBe('http://localhost:3000/robotics-beta');
  });
});

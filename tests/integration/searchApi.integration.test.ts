import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { Server } from 'http';
import { createApp } from '../../src/app.js';
import { PageStore } from '../../src/db/pageStore.js';
import { SearchIndexer } from '../../src/search/indexer.js';

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const TEST_DB = 'crawlforge_test_search_api';

let client: MongoClient;
let db: Db;
let server: Server;
let baseUrl: string;
let pageStore: PageStore;
let indexer: SearchIndexer;

beforeAll(async () => {
  client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(TEST_DB);

  pageStore = new PageStore(db);
  await pageStore.init();

  indexer = new SearchIndexer(db);
  await indexer.init();

  const app = createApp(db);

  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        baseUrl = `http://localhost:${address.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  await pageStore.drop();
  await pageStore.init();
  await indexer.drop();
  await indexer.init();
});

describe('Search API — GET /api/search', () => {
  beforeEach(async () => {
    // Seed and index a page
    await pageStore.savePage({
      url: 'http://localhost:3000/crawler-page',
      origin: 'http://localhost:3000',
      title: 'Web Crawler Architecture',
      textContent: 'TypeScript safe crawler with frontier and indexing.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });
    await indexer.indexAll();
  });

  it('returns 200 with ranked results and expected JSON structure', async () => {
    const res = await fetch(`${baseUrl}/api/search?q=crawler`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.query).toBe('crawler');
    expect(data.total).toBe(1);
    expect(data.limit).toBe(10);
    expect(data.offset).toBe(0);
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results).toHaveLength(1);

    const hit = data.results[0];
    expect(hit.url).toBe('http://localhost:3000/crawler-page');
    expect(hit.title).toBe('Web Crawler Architecture');
    expect(typeof hit.score).toBe('number');
    expect(hit.score).toBeGreaterThan(0);
    expect(typeof hit.snippet).toBe('string');
    expect(hit.snippet.toLowerCase()).toContain('crawler');

    // Confirm internal database fields (_id, contentHash, etc.) are NOT exposed
    expect(hit._id).toBeUndefined();
    expect(hit.contentHash).toBeUndefined();
    expect(hit.textContent).toBeUndefined();
  });

  it('validates required q parameter and returns 400 when missing', async () => {
    const res = await fetch(`${baseUrl}/api/search`);
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.status).toBe('error');
    expect(data.message).toContain('Query parameter "q" is required');
  });

  it('validates limit parameter and rejects invalid inputs with 400', async () => {
    const invalidLimits = ['0', '-5', '101', 'abc'];
    for (const lim of invalidLimits) {
      const res = await fetch(`${baseUrl}/api/search?q=crawler&limit=${lim}`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.status).toBe('error');
      expect(data.message).toContain('Invalid limit parameter');
    }
  });

  it('validates offset parameter and rejects negative or non-integer values with 400', async () => {
    const invalidOffsets = ['-1', 'xyz'];
    for (const off of invalidOffsets) {
      const res = await fetch(`${baseUrl}/api/search?q=crawler&offset=${off}`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.status).toBe('error');
      expect(data.message).toContain('Invalid offset parameter');
    }
  });

  it('handles empty query and stop words returning 200 with 0 results', async () => {
    const res = await fetch(`${baseUrl}/api/search?q=the+and+of`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.total).toBe(0);
    expect(data.results).toEqual([]);
  });

  it('supports pagination via limit and offset', async () => {
    // Seed another page
    await pageStore.savePage({
      url: 'http://localhost:3000/page-2',
      origin: 'http://localhost:3000',
      title: 'Crawler Page Two',
      textContent: 'Another crawler document.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });
    await indexer.indexAll();

    const page1 = await (await fetch(`${baseUrl}/api/search?q=crawler&limit=1&offset=0`)).json();
    expect(page1.total).toBe(2);
    expect(page1.results).toHaveLength(1);

    const page2 = await (await fetch(`${baseUrl}/api/search?q=crawler&limit=1&offset=1`)).json();
    expect(page2.total).toBe(2);
    expect(page2.results).toHaveLength(1);
    expect(page2.results[0].url).not.toBe(page1.results[0].url);
  });
});

describe('Indexing API — POST /api/index & GET /api/index/stats', () => {
  it('indexes all existing pages in the database when body is empty', async () => {
    await pageStore.savePage({
      url: 'http://localhost:3000/batch-1',
      origin: 'http://localhost:3000',
      title: 'Batch One',
      textContent: 'First document text.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    await pageStore.savePage({
      url: 'http://localhost:3000/batch-2',
      origin: 'http://localhost:3000',
      title: 'Batch Two',
      textContent: 'Second document text.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const postRes = await fetch(`${baseUrl}/api/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(postRes.status).toBe(200);
    const postData = await postRes.json();
    expect(postData.status).toBe('ok');
    expect(postData.total).toBe(2);
    expect(postData.indexed).toBe(2);

    // Verify stats endpoint reflects indexed pages
    const statsRes = await fetch(`${baseUrl}/api/index/stats`);
    expect(statsRes.status).toBe(200);
    const statsData = await statsRes.json();
    expect(statsData.status).toBe('ok');
    expect(statsData.totalDocs).toBe(2);
    expect(statsData.totalPostings).toBeGreaterThan(0);
  });

  it('indexes a single page when url is provided in body', async () => {
    await pageStore.savePage({
      url: 'http://localhost:3000/single-target',
      origin: 'http://localhost:3000',
      title: 'Single Target',
      textContent: 'Single document text content.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const res = await fetch(`${baseUrl}/api/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:3000/single-target' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.url).toBe('http://localhost:3000/single-target');
    expect(data.outcome).toBe('indexed');
  });

  it('returns 404 when requested URL is not found in stored pages', async () => {
    const res = await fetch(`${baseUrl}/api/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:3000/unknown-url' }),
    });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.status).toBe('error');
    expect(data.message).toContain('Page not found in storage');
  });
});

describe('Search API — Milestone 5 Modes & Embeddings', () => {
  it('validates mode parameter and rejects invalid mode with 400', async () => {
    const res = await fetch(`${baseUrl}/api/search?q=crawler&mode=vector_unsupported`);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.status).toBe('error');
    expect(data.message).toContain('Invalid mode parameter');
  });

  it('falls back to lexical search with warning when mode=hybrid and provider is unconfigured', async () => {
    await pageStore.savePage({
      url: 'http://localhost:3000/hybrid-test',
      origin: 'http://localhost:3000',
      title: 'Hybrid Fallback Test',
      textContent: 'TypeScript safe crawler with frontier.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });
    await indexer.indexAll();

    const res = await fetch(`${baseUrl}/api/search?q=crawler&mode=hybrid`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mode).toBe('hybrid');
    expect(data.warning).toBeDefined();
    expect(data.warning).toContain('fell back to lexical BM25');
    expect(data.results.length).toBeGreaterThan(0);
  });

  it('returns 503 when mode=semantic and provider is unconfigured', async () => {
    const res = await fetch(`${baseUrl}/api/search?q=crawler&mode=semantic`);
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.status).toBe('error');
    expect(data.message).toContain('unavailable');
  });

  it('provides embedding status via GET /api/embeddings/status', async () => {
    const res = await fetch(`${baseUrl}/api/embeddings/status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.provider).toBeDefined();
    expect(data.counts).toBeDefined();
    expect(typeof data.counts.totalPages).toBe('number');
  });
});

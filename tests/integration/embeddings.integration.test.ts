import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { EmbeddingService } from '../../src/embeddings/embeddingService.js';
import { DeterministicFakeEmbeddingProvider } from '../../src/embeddings/providers/fakeProvider.js';
import { PageStore } from '../../src/db/pageStore.js';
import { PAGE_EMBEDDINGS_COLLECTION } from '../../src/embeddings/embeddingSchema.js';

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const TEST_DB = 'crawlforge_test_embeddings';

let client: MongoClient;
let db: Db;
let embeddingService: EmbeddingService;
let pageStore: PageStore;
let fakeProvider: DeterministicFakeEmbeddingProvider;

beforeAll(async () => {
  client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(TEST_DB);

  pageStore = new PageStore(db);
  await pageStore.init();

  fakeProvider = new DeterministicFakeEmbeddingProvider(16);
  embeddingService = new EmbeddingService(db, fakeProvider);
  await embeddingService.init();
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  await pageStore.drop();
  await pageStore.init();
  await embeddingService.drop();
  await embeddingService.init();
});

describe('EmbeddingService — Text Preparation', () => {
  it('combines title and body text cleanly', () => {
    const text = embeddingService.prepareText('Page Title', 'This is the page body content.');
    expect(text).toBe('Page Title. This is the page body content.');
  });

  it('handles empty title or body gracefully', () => {
    expect(embeddingService.prepareText(undefined, 'Body only')).toBe('Body only');
    expect(embeddingService.prepareText('Title only', undefined)).toBe('Title only.');
  });

  it('truncates text to maxChars limit', () => {
    const longBody = 'a '.repeat(1000);
    const text = embeddingService.prepareText('Title', longBody, 50);
    expect(text.length).toBeLessThanOrEqual(50);
  });
});

describe('EmbeddingService — Generation and Idempotency', () => {
  it('generates and persists an embedding for a page', async () => {
    const saveResult = await pageStore.savePage({
      url: 'http://example.com/spider',
      origin: 'http://example.com',
      title: 'Web Spider',
      textContent: 'Web crawler spider frontier and indexing.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const page = await db.collection('pages').findOne({ url: 'http://example.com/spider' });
    expect(page).not.toBeNull();

    const genResult = await embeddingService.generateEmbedding(page as any);
    expect(genResult.outcome).toBe('generated');
    expect(genResult.url).toBe('http://example.com/spider');

    const embDoc = await db.collection(PAGE_EMBEDDINGS_COLLECTION).findOne({ url: 'http://example.com/spider' });
    expect(embDoc).not.toBeNull();
    expect(embDoc?.contentHash).toBe(saveResult.contentHash);
    expect(embDoc?.provider).toBe('test-fake');
    expect(embDoc?.dimensions).toBe(16);
    expect(Array.isArray(embDoc?.vector)).toBe(true);
    expect(embDoc?.vector).toHaveLength(16);
  });

  it('skips regeneration when content hash and provider are unchanged (idempotent)', async () => {
    await pageStore.savePage({
      url: 'http://example.com/spider',
      origin: 'http://example.com',
      title: 'Web Spider',
      textContent: 'Web crawler spider frontier.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const page = (await db.collection('pages').findOne({ url: 'http://example.com/spider' })) as any;
    const r1 = await embeddingService.generateEmbedding(page);
    expect(r1.outcome).toBe('generated');

    const r2 = await embeddingService.generateEmbedding(page);
    expect(r2.outcome).toBe('unchanged');
  });

  it('regenerates embedding when force option is set to true', async () => {
    await pageStore.savePage({
      url: 'http://example.com/spider',
      origin: 'http://example.com',
      title: 'Web Spider',
      textContent: 'Web crawler spider frontier.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const page = (await db.collection('pages').findOne({ url: 'http://example.com/spider' })) as any;
    await embeddingService.generateEmbedding(page);

    const rForce = await embeddingService.generateEmbedding(page, { force: true });
    expect(rForce.outcome).toBe('generated');
  });

  it('updates embedding when page contentHash changes', async () => {
    await pageStore.savePage({
      url: 'http://example.com/spider',
      origin: 'http://example.com',
      title: 'Web Spider',
      textContent: 'Original content.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    let page = (await db.collection('pages').findOne({ url: 'http://example.com/spider' })) as any;
    await embeddingService.generateEmbedding(page);

    // Save updated version of page
    await pageStore.savePage({
      url: 'http://example.com/spider',
      origin: 'http://example.com',
      title: 'Web Spider Updated',
      textContent: 'Updated new text content for spider.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    page = (await db.collection('pages').findOne({ url: 'http://example.com/spider' })) as any;
    const rUpdate = await embeddingService.generateEmbedding(page);
    expect(rUpdate.outcome).toBe('generated');

    const embDoc = await db.collection(PAGE_EMBEDDINGS_COLLECTION).findOne({ url: 'http://example.com/spider' });
    expect(embDoc?.contentHash).toBe(page.contentHash);
  });
});

describe('EmbeddingService — generateEmbeddingForUrl and Backfill', () => {
  it('returns not_found when URL does not exist in pages collection', async () => {
    const res = await embeddingService.generateEmbeddingForUrl('http://example.com/missing');
    expect(res.outcome).toBe('not_found');
  });

  it('generates embedding by URL when page exists', async () => {
    await pageStore.savePage({
      url: 'http://example.com/bread',
      origin: 'http://example.com',
      title: 'Sourdough Bread',
      textContent: 'Flour yeast and baking recipes.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const res = await embeddingService.generateEmbeddingForUrl('http://example.com/bread');
    expect(res.outcome).toBe('generated');
    expect(res.url).toBe('http://example.com/bread');
  });

  it('backfills embeddings across all pages in database', async () => {
    await pageStore.savePage({
      url: 'http://example.com/p1',
      origin: 'http://example.com',
      title: 'Page 1',
      textContent: 'Content 1',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });
    await pageStore.savePage({
      url: 'http://example.com/p2',
      origin: 'http://example.com',
      title: 'Page 2',
      textContent: 'Content 2',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const result = await embeddingService.backfill();
    expect(result.total).toBe(2);
    expect(result.generated).toBe(2);
    expect(result.unchanged).toBe(0);
    expect(result.errors).toBe(0);

    // Second backfill should be completely unchanged
    const result2 = await embeddingService.backfill();
    expect(result2.total).toBe(2);
    expect(result2.generated).toBe(0);
    expect(result2.unchanged).toBe(2);
  });
});

describe('EmbeddingService — Stale Embeddings & Status Reporting', () => {
  it('excludes stale embeddings whose contentHash does not match current page', async () => {
    await pageStore.savePage({
      url: 'http://example.com/page1',
      origin: 'http://example.com',
      title: 'Page 1',
      textContent: 'Initial text.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const page = (await db.collection('pages').findOne({ url: 'http://example.com/page1' })) as any;
    await embeddingService.generateEmbedding(page);

    // Initially candidate is valid
    let candidates = await embeddingService.getValidCandidateEmbeddings();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].url).toBe('http://example.com/page1');

    // Page updates content in pages collection without re-running embedding
    await pageStore.savePage({
      url: 'http://example.com/page1',
      origin: 'http://example.com',
      title: 'Page 1 Changed',
      textContent: 'Drastically changed text.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    // Old embedding is now stale -> excluded from search candidates
    candidates = await embeddingService.getValidCandidateEmbeddings();
    expect(candidates).toHaveLength(0);

    // Status reports 1 stale embedding and 1 missing embedding
    const status = await embeddingService.getStatus();
    expect(status.counts.totalPages).toBe(1);
    expect(status.counts.totalEmbeddings).toBe(1);
    expect(status.counts.validEmbeddings).toBe(0);
    expect(status.counts.staleEmbeddings).toBe(1);
    expect(status.counts.missingEmbeddings).toBe(1);
  });
});

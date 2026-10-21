import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { SearchIndexer } from '../../src/search/indexer.js';
import { PageStore } from '../../src/db/pageStore.js';
import { computeContentHash } from '../../src/utils/contentHash.js';
import { PageDoc } from '../../src/db/pageSchema.js';

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const TEST_DB = 'crawlforge_test_search_indexer';

let client: MongoClient;
let db: Db;
let indexer: SearchIndexer;
let pageStore: PageStore;

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

  pageStore = new PageStore(db);
  await pageStore.drop();
  await pageStore.init();
});

describe('SearchIndexer — Indexing Individual Pages', () => {
  it('indexes a page, storing terms in inverted_index and metadata in indexed_pages', async () => {
    const page: PageDoc = {
      url: 'http://localhost:3000/doc-1',
      origin: 'http://localhost:3000',
      title: 'Web Crawler Guide',
      textContent: 'Build a safe web crawler using TypeScript and Node.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash('Web Crawler Guide', 'Build a safe web crawler using TypeScript and Node.'),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    const result = await indexer.indexPage(page);
    expect(result.outcome).toBe('indexed');
    expect(result.url).toBe('http://localhost:3000/doc-1');
    expect(result.termsCount).toBeGreaterThan(0);

    // Verify postings in inverted_index
    const postings = await db
      .collection('inverted_index')
      .find({ url: 'http://localhost:3000/doc-1' })
      .toArray();

    expect(postings.length).toBe(result.termsCount);

    // Check term boost: 'crawler' appeared in title and body -> boosted frequency
    const crawlerPosting = postings.find(p => p.term === 'crawler');
    expect(crawlerPosting).toBeDefined();
    // In title (boost 2) + body (count 1) = 3
    expect(crawlerPosting!.termFrequency).toBe(3);

    // Verify document manifest in indexed_pages
    const manifest = await db
      .collection('indexed_pages')
      .findOne({ url: 'http://localhost:3000/doc-1' });

    expect(manifest).not.toBeNull();
    expect(manifest!.title).toBe('Web Crawler Guide');
    expect(manifest!.contentHash).toBe(page.contentHash);
    expect(manifest!.distinctTerms).toBe(result.termsCount);
    expect(manifest!.docLength).toBeGreaterThan(0);
  });

  it('skips re-indexing when content hash has not changed (idempotent)', async () => {
    const page: PageDoc = {
      url: 'http://localhost:3000/doc-static',
      origin: 'http://localhost:3000',
      title: 'Static Page',
      textContent: 'Static content that does not change.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash('Static Page', 'Static content that does not change.'),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    // First indexing
    const res1 = await indexer.indexPage(page);
    expect(res1.outcome).toBe('indexed');

    // Second indexing with same contentHash
    const res2 = await indexer.indexPage(page);
    expect(res2.outcome).toBe('unchanged');

    // Number of postings in inverted_index should not duplicate
    const count = await db
      .collection('inverted_index')
      .countDocuments({ url: 'http://localhost:3000/doc-static' });

    expect(count).toBe(res1.termsCount);
  });

  it('purges obsolete terms when page content changes on update', async () => {
    // 1. Initial version contains 'dinosaur' and 'jurassic'
    const pageV1: PageDoc = {
      url: 'http://localhost:3000/dynamic-doc',
      origin: 'http://localhost:3000',
      title: 'Prehistoric Life',
      textContent: 'Dinosaur fossils from the jurassic period.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash('Prehistoric Life', 'Dinosaur fossils from the jurassic period.'),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    await indexer.indexPage(pageV1);

    const dinoPosting = await db.collection('inverted_index').findOne({
      url: 'http://localhost:3000/dynamic-doc',
      term: 'dinosaur',
    });
    expect(dinoPosting).not.toBeNull();

    // 2. Updated version replaces text completely with astronomy content
    const pageV2: PageDoc = {
      url: 'http://localhost:3000/dynamic-doc',
      origin: 'http://localhost:3000',
      title: 'Astronomy Guide',
      textContent: 'Telescopes observing distant galaxies and stars.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash('Astronomy Guide', 'Telescopes observing distant galaxies and stars.'),
      version: 2,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    const res2 = await indexer.indexPage(pageV2);
    expect(res2.outcome).toBe('indexed');

    // 3. Obsolete terms ('dinosaur', 'jurassic') must be gone from inverted index
    const obsoleteDino = await db.collection('inverted_index').findOne({
      url: 'http://localhost:3000/dynamic-doc',
      term: 'dinosaur',
    });
    const obsoleteJurassic = await db.collection('inverted_index').findOne({
      url: 'http://localhost:3000/dynamic-doc',
      term: 'jurassic',
    });
    expect(obsoleteDino).toBeNull();
    expect(obsoleteJurassic).toBeNull();

    // 4. New terms ('telescopes', 'galaxies') must be present
    const galaxyPosting = await db.collection('inverted_index').findOne({
      url: 'http://localhost:3000/dynamic-doc',
      term: 'galaxies',
    });
    expect(galaxyPosting).not.toBeNull();
  });

  it('allows force re-indexing even when content is unchanged', async () => {
    const page: PageDoc = {
      url: 'http://localhost:3000/force-doc',
      origin: 'http://localhost:3000',
      title: 'Force Title',
      textContent: 'Force content.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash('Force Title', 'Force content.'),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    await indexer.indexPage(page);
    const resForce = await indexer.indexPage(page, { force: true });
    expect(resForce.outcome).toBe('indexed');
  });

  it('deletes a page and all its postings cleanly', async () => {
    const page: PageDoc = {
      url: 'http://localhost:3000/delete-doc',
      origin: 'http://localhost:3000',
      title: 'To Be Deleted',
      textContent: 'Ephemeral text.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash('To Be Deleted', 'Ephemeral text.'),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    await indexer.indexPage(page);
    expect(await db.collection('inverted_index').countDocuments({ url: page.url })).toBeGreaterThan(0);

    const deleted = await indexer.deletePageFromIndex(page.url);
    expect(deleted).toBe(true);

    expect(await db.collection('inverted_index').countDocuments({ url: page.url })).toBe(0);
    expect(await db.collection('indexed_pages').countDocuments({ url: page.url })).toBe(0);
  });
});

describe('SearchIndexer — Batch Indexing Existing Pages', () => {
  it('indexes all pages currently stored in the pages collection', async () => {
    // Seed 3 pages in PageStore
    await pageStore.savePage({
      url: 'http://localhost:3000/p1',
      origin: 'http://localhost:3000',
      title: 'First Page',
      textContent: 'Content for first page.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    await pageStore.savePage({
      url: 'http://localhost:3000/p2',
      origin: 'http://localhost:3000',
      title: 'Second Page',
      textContent: 'Content for second page.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    await pageStore.savePage({
      url: 'http://localhost:3000/p3',
      origin: 'http://localhost:3000',
      title: 'Third Page',
      textContent: 'Content for third page.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    // Run indexAll
    const summary = await indexer.indexAll();
    expect(summary.total).toBe(3);
    expect(summary.indexed).toBe(3);
    expect(summary.unchanged).toBe(0);
    expect(summary.errors).toBe(0);

    const stats = await indexer.getIndexStats();
    expect(stats.totalDocs).toBe(3);
    expect(stats.totalPostings).toBeGreaterThan(0);
    expect(stats.avgDocLength).toBeGreaterThan(0);

    // Running indexAll a second time skips already indexed documents
    const summary2 = await indexer.indexAll();
    expect(summary2.total).toBe(3);
    expect(summary2.indexed).toBe(0);
    expect(summary2.unchanged).toBe(3);
  });

  it('indexes a single existing page by its URL', async () => {
    await pageStore.savePage({
      url: 'http://localhost:3000/target-page',
      origin: 'http://localhost:3000',
      title: 'Target Page',
      textContent: 'Target text content.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const res = await indexer.indexPageByUrl('http://localhost:3000/target-page');
    expect(res.outcome).toBe('indexed');
    expect(res.url).toBe('http://localhost:3000/target-page');

    // Non-existent page returns not_found
    const missing = await indexer.indexPageByUrl('http://localhost:3000/does-not-exist');
    expect(missing.outcome).toBe('not_found');
  });
});

describe('SearchIndexer — Recovery from Partial Failures', () => {
  it('cleans up previous partial state upon re-indexing', async () => {
    const page: PageDoc = {
      url: 'http://localhost:3000/partial-doc',
      origin: 'http://localhost:3000',
      title: 'Partial Doc',
      textContent: 'Text to index partially.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash('Partial Doc', 'Text to index partially.'),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    // Pre-insert a stale/dangling posting (simulating interrupted write)
    await db.collection('inverted_index').insertOne({
      term: 'corruptedterm',
      url: page.url,
      termFrequency: 99,
      docLength: 5,
    });

    // Re-index page: indexPage begins with deleteMany({ url })
    const res = await indexer.indexPage(page, { force: true });
    expect(res.outcome).toBe('indexed');

    // The stale corrupted posting must have been wiped
    const corrupted = await db.collection('inverted_index').findOne({
      url: page.url,
      term: 'corruptedterm',
    });
    expect(corrupted).toBeNull();
  });

  it('purges partial state when invertedIndexCol.insertMany fails, leaving system clean for recovery', async () => {
    const page: PageDoc = {
      url: 'http://localhost:3000/fail-insert-doc',
      origin: 'http://localhost:3000',
      title: 'Fail Insert Doc',
      textContent: 'Database write will fail during insertion.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash('Fail Insert Doc', 'Database write will fail during insertion.'),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    const invertedCol = (indexer as unknown as { invertedIndexCol: { insertMany: unknown } }).invertedIndexCol;
    const spy = vi
      .spyOn(invertedCol, 'insertMany')
      .mockRejectedValueOnce(new Error('Simulated network failure on insertMany'));

    await expect(indexer.indexPage(page)).rejects.toThrow('Simulated network failure on insertMany');

    spy.mockRestore();

    // Verify cleanup: no partial postings and no manifest exist
    const postingsCount = await db.collection('inverted_index').countDocuments({ url: page.url });
    const manifest = await db.collection('indexed_pages').findOne({ url: page.url });
    expect(postingsCount).toBe(0);
    expect(manifest).toBeNull();

    // Re-indexing succeeds cleanly
    const recovery = await indexer.indexPage(page);
    expect(recovery.outcome).toBe('indexed');

    const recoveredPostings = await db.collection('inverted_index').countDocuments({ url: page.url });
    expect(recoveredPostings).toBeGreaterThan(0);
  });

  it('purges partial state when indexedPagesCol.updateOne fails, leaving system clean for recovery', async () => {
    const page: PageDoc = {
      url: 'http://localhost:3000/fail-manifest-doc',
      origin: 'http://localhost:3000',
      title: 'Fail Manifest Doc',
      textContent: 'Manifest write will fail during updateOne.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash('Fail Manifest Doc', 'Manifest write will fail during updateOne.'),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    const indexedPagesCol = (indexer as unknown as { indexedPagesCol: { updateOne: unknown } }).indexedPagesCol;
    const spy = vi
      .spyOn(indexedPagesCol, 'updateOne')
      .mockRejectedValueOnce(new Error('Simulated disk full on indexed_pages updateOne'));

    await expect(indexer.indexPage(page)).rejects.toThrow('Simulated disk full on indexed_pages updateOne');

    spy.mockRestore();

    // Verify cleanup
    const postingsCount = await db.collection('inverted_index').countDocuments({ url: page.url });
    const manifest = await db.collection('indexed_pages').findOne({ url: page.url });
    expect(postingsCount).toBe(0);
    expect(manifest).toBeNull();

    // Re-indexing succeeds cleanly
    const recovery = await indexer.indexPage(page);
    expect(recovery.outcome).toBe('indexed');
  });

  it('serializes concurrent indexPage calls to the same URL without duplicate key errors', async () => {
    const page: PageDoc = {
      url: 'http://localhost:3000/concurrent-index',
      origin: 'http://localhost:3000',
      title: 'Concurrent Indexing Page',
      textContent: 'Testing concurrent indexPage calls.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      contentHash: computeContentHash('Concurrent Indexing Page', 'Testing concurrent indexPage calls.'),
      version: 1,
      firstCrawledAt: new Date(),
      lastCrawledAt: new Date(),
      lastChangedAt: new Date(),
    };

    const [r1, r2] = await Promise.all([
      indexer.indexPage(page, { force: true }),
      indexer.indexPage(page, { force: true }),
    ]);

    expect(r1.outcome).toBe('indexed');
    // Second call is serialized; can be indexed or unchanged
    expect(['indexed', 'unchanged']).toContain(r2.outcome);

    const manifestCount = await db.collection('indexed_pages').countDocuments({ url: page.url });
    expect(manifestCount).toBe(1);
  });
});

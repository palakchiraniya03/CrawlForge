/**
 * Integration tests for PageStore persistent storage and versioning in MongoDB.
 *
 * Tests:
 * - First-time storage (v1 creation in pages and page_versions)
 * - Unique index on URL
 * - Unchanged content detection via SHA-256 content hash (no new version)
 * - Changed content detection (monotonically increments version counter and appends to page_versions)
 * - HTTP 304 Not Modified handling without data loss
 * - Historical version retrieval and ordering
 * - Handling pages without HTTP validators (ETag / Last-Modified missing)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { PageStore } from '../../src/db/pageStore.js';

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const TEST_DB = 'crawlforge_test_page_store';

let client: MongoClient;
let db: Db;
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
  pageStore = new PageStore(db);
  await pageStore.drop();
  await pageStore.init();
});

describe('PageStore — First-time page storage', () => {
  it('creates page record and initial version document (v1)', async () => {
    const result = await pageStore.savePage({
      url: 'http://localhost:3000/page-1',
      origin: 'http://localhost:3000',
      title: 'Initial Title',
      textContent: 'Initial body content.',
      outgoingLinks: ['http://localhost:3000/page-2'],
      httpStatus: 200,
      contentType: 'text/html',
      etag: '"v1-etag"',
      lastModified: 'Wed, 21 Oct 2026 10:00:00 GMT',
    });

    expect(result.outcome).toBe('created');
    expect(result.version).toBe(1);
    expect(result.isNewVersion).toBe(true);
    expect(result.contentHash).toHaveLength(64);

    // Verify stored page document
    const page = await pageStore.getPage('http://localhost:3000/page-1');
    expect(page).not.toBeNull();
    expect(page!.version).toBe(1);
    expect(page!.title).toBe('Initial Title');
    expect(page!.textContent).toBe('Initial body content.');
    expect(page!.outgoingLinks).toEqual(['http://localhost:3000/page-2']);
    expect(page!.etag).toBe('"v1-etag"');
    expect(page!.firstCrawledAt).toBeInstanceOf(Date);
    expect(page!.lastCrawledAt).toBeInstanceOf(Date);
    expect(page!.lastChangedAt).toBeInstanceOf(Date);

    // Verify initial version document
    const versions = await pageStore.getVersions('http://localhost:3000/page-1');
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].title).toBe('Initial Title');
    expect(versions[0].textContent).toBe('Initial body content.');
  });
});

describe('PageStore — Unchanged content handling', () => {
  it('does NOT create a new version when content hash is unchanged', async () => {
    // Crawl 1
    await pageStore.savePage({
      url: 'http://localhost:3000/page-static',
      origin: 'http://localhost:3000',
      title: 'Static Page',
      textContent: 'Static content that never changes.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      etag: '"v1"',
    });

    // Crawl 2: same content (e.g. server lacks 304 support but content is unchanged)
    const result2 = await pageStore.savePage({
      url: 'http://localhost:3000/page-static',
      origin: 'http://localhost:3000',
      title: 'Static Page',
      textContent: 'Static content that never changes.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      etag: '"v1"',
    });

    expect(result2.outcome).toBe('unchanged');
    expect(result2.version).toBe(1);
    expect(result2.isNewVersion).toBe(false);

    // Version collection must still only have 1 version
    const versionCount = await pageStore.getVersionCount('http://localhost:3000/page-static');
    expect(versionCount).toBe(1);

    // Total distinct pages must be 1
    const pageCount = await pageStore.getPageCount();
    expect(pageCount).toBe(1);
  });
});

describe('PageStore — Changed content handling', () => {
  it('increments version to 2 and appends to page_versions when content changes', async () => {
    // Version 1
    await pageStore.savePage({
      url: 'http://localhost:3000/page-dynamic',
      origin: 'http://localhost:3000',
      title: 'Original Title',
      textContent: 'Version 1 body text.',
      outgoingLinks: ['http://localhost:3000/link-a'],
      httpStatus: 200,
      contentType: 'text/html',
    });

    // Version 2: updated content
    const result2 = await pageStore.savePage({
      url: 'http://localhost:3000/page-dynamic',
      origin: 'http://localhost:3000',
      title: 'Updated Title',
      textContent: 'Version 2 body text with major revisions.',
      outgoingLinks: ['http://localhost:3000/link-b'],
      httpStatus: 200,
      contentType: 'text/html',
    });

    expect(result2.outcome).toBe('updated');
    expect(result2.version).toBe(2);
    expect(result2.isNewVersion).toBe(true);

    // Current page snapshot reflects Version 2
    const current = await pageStore.getPage('http://localhost:3000/page-dynamic');
    expect(current!.version).toBe(2);
    expect(current!.title).toBe('Updated Title');
    expect(current!.textContent).toBe('Version 2 body text with major revisions.');
    expect(current!.outgoingLinks).toEqual(['http://localhost:3000/link-b']);

    // History contains both versions
    const versions = await pageStore.getVersions('http://localhost:3000/page-dynamic');
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(2);
    expect(versions[0].title).toBe('Updated Title');
    expect(versions[1].version).toBe(1);
    expect(versions[1].title).toBe('Original Title');
  });
});

describe('PageStore — HTTP 304 Not Modified handling', () => {
  it('preserves existing content and version while updating lastCrawledAt timestamp on 304', async () => {
    // Initial 200
    await pageStore.savePage({
      url: 'http://localhost:3000/conditional',
      origin: 'http://localhost:3000',
      title: 'Conditional Page',
      textContent: 'Important original content that must not be erased.',
      outgoingLinks: ['http://localhost:3000/sub'],
      httpStatus: 200,
      contentType: 'text/html',
      etag: '"etag-xyz"',
    });

    const initialPage = await pageStore.getPage('http://localhost:3000/conditional');
    const initialCrawledAt = initialPage!.lastCrawledAt.getTime();

    // Small delay to ensure timestamp progression
    await new Promise(r => setTimeout(r, 10));

    // Recrawl receives 304 Not Modified
    const result304 = await pageStore.savePage({
      url: 'http://localhost:3000/conditional',
      origin: 'http://localhost:3000',
      title: '',
      textContent: '',
      outgoingLinks: [],
      httpStatus: 304,
      contentType: '',
      etag: '"etag-xyz"',
      is304: true,
    });

    expect(result304.outcome).toBe('not_modified_304');
    expect(result304.version).toBe(1);
    expect(result304.isNewVersion).toBe(false);

    // Verify existing content was NOT erased
    const pageAfter = await pageStore.getPage('http://localhost:3000/conditional');
    expect(pageAfter!.title).toBe('Conditional Page');
    expect(pageAfter!.textContent).toBe('Important original content that must not be erased.');
    expect(pageAfter!.outgoingLinks).toEqual(['http://localhost:3000/sub']);
    expect(pageAfter!.version).toBe(1);
    expect(pageAfter!.lastCrawledAt.getTime()).toBeGreaterThan(initialCrawledAt);

    // Versions collection remains unchanged
    const versions = await pageStore.getVersions('http://localhost:3000/conditional');
    expect(versions).toHaveLength(1);
  });
});

describe('PageStore — Missing HTTP validators', () => {
  it('handles servers that do not send ETag or Last-Modified using content hash', async () => {
    const res = await pageStore.savePage({
      url: 'http://localhost:3000/no-validators',
      origin: 'http://localhost:3000',
      title: 'No Validators',
      textContent: 'Content without headers.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    expect(res.outcome).toBe('created');
    const page = await pageStore.getPage('http://localhost:3000/no-validators');
    expect(page!.etag).toBeUndefined();
    expect(page!.lastModified).toBeUndefined();
    expect(page!.contentHash).toBeDefined();
  });

  it('unsets etag and lastModified when a subsequent recrawl (HTTP 200) omits validators', async () => {
    // 1. Initial crawl with validators
    await pageStore.savePage({
      url: 'http://localhost:3000/drop-validators',
      origin: 'http://localhost:3000',
      title: 'Original Title',
      textContent: 'Original content.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      etag: '"initial-etag"',
      lastModified: 'Wed, 21 Oct 2026 10:00:00 GMT',
    });

    const pageBefore = await pageStore.getPage('http://localhost:3000/drop-validators');
    expect(pageBefore!.etag).toBe('"initial-etag"');
    expect(pageBefore!.lastModified).toBe('Wed, 21 Oct 2026 10:00:00 GMT');

    // 2. Recrawl receives HTTP 200 with changed content and NO validators
    const recrawl = await pageStore.savePage({
      url: 'http://localhost:3000/drop-validators',
      origin: 'http://localhost:3000',
      title: 'Updated Title',
      textContent: 'Updated content without validators.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    expect(recrawl.outcome).toBe('updated');
    expect(recrawl.version).toBe(2);

    const pageAfter = await pageStore.getPage('http://localhost:3000/drop-validators');
    expect(pageAfter!.etag).toBeUndefined();
    expect(pageAfter!.lastModified).toBeUndefined();

    // Raw document in MongoDB must not have null or empty-string properties
    const rawDoc = await db.collection('pages').findOne({ url: 'http://localhost:3000/drop-validators' });
    expect('etag' in rawDoc!).toBe(false);
    expect('lastModified' in rawDoc!).toBe(false);
  });

  it('unsets validators on HTTP 200 even when content hash is unchanged', async () => {
    // Initial crawl with ETag
    await pageStore.savePage({
      url: 'http://localhost:3000/drop-validators-unchanged',
      origin: 'http://localhost:3000',
      title: 'Static Page',
      textContent: 'Static content.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
      etag: '"static-etag"',
    });

    // Recrawl with identical content but server dropped the ETag header
    const recrawl = await pageStore.savePage({
      url: 'http://localhost:3000/drop-validators-unchanged',
      origin: 'http://localhost:3000',
      title: 'Static Page',
      textContent: 'Static content.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    expect(recrawl.outcome).toBe('unchanged');
    const page = await pageStore.getPage('http://localhost:3000/drop-validators-unchanged');
    expect(page!.etag).toBeUndefined();

    const rawDoc = await db.collection('pages').findOne({ url: 'http://localhost:3000/drop-validators-unchanged' });
    expect('etag' in rawDoc!).toBe(false);
  });
});

describe('PageStore — Concurrent page saves', () => {
  it('handles concurrent initial inserts for the same URL safely without duplicate key errors', async () => {
    const p1 = pageStore.savePage({
      url: 'http://localhost:3000/concurrent-initial',
      origin: 'http://localhost:3000',
      title: 'Initial A',
      textContent: 'Body content A',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const p2 = pageStore.savePage({
      url: 'http://localhost:3000/concurrent-initial',
      origin: 'http://localhost:3000',
      title: 'Initial B',
      textContent: 'Body content B',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.outcome, r2.outcome]).toContain('created');

    const pageCount = await db.collection('pages').countDocuments({ url: 'http://localhost:3000/concurrent-initial' });
    expect(pageCount).toBe(1);

    const page = await pageStore.getPage('http://localhost:3000/concurrent-initial');
    expect(page).not.toBeNull();
    const versions = await pageStore.getVersions('http://localhost:3000/concurrent-initial');
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(page!.version).toBe(versions[0].version);
  });

  it('handles concurrent updates to the same URL without race conditions or lost updates', async () => {
    // Seed v1
    await pageStore.savePage({
      url: 'http://localhost:3000/concurrent-updates',
      origin: 'http://localhost:3000',
      title: 'Version 1',
      textContent: 'Version 1 body.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    // 3 concurrent updates with distinct contents
    const u1 = pageStore.savePage({
      url: 'http://localhost:3000/concurrent-updates',
      origin: 'http://localhost:3000',
      title: 'Version 2',
      textContent: 'Version 2 content.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const u2 = pageStore.savePage({
      url: 'http://localhost:3000/concurrent-updates',
      origin: 'http://localhost:3000',
      title: 'Version 3',
      textContent: 'Version 3 content.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const u3 = pageStore.savePage({
      url: 'http://localhost:3000/concurrent-updates',
      origin: 'http://localhost:3000',
      title: 'Version 4',
      textContent: 'Version 4 content.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const results = await Promise.all([u1, u2, u3]);
    expect(results).toHaveLength(3);

    const page = await pageStore.getPage('http://localhost:3000/concurrent-updates');
    expect(page!.version).toBe(4);

    const versions = await pageStore.getVersions('http://localhost:3000/concurrent-updates');
    expect(versions).toHaveLength(4);
    expect(versions.map(v => v.version)).toEqual([4, 3, 2, 1]);
  });

  it('handles concurrent updates across distinct PageStore instances via optimistic concurrency control', async () => {
    // Create two separate store instances (simulating separate processes with independent mutexes)
    const storeA = new PageStore(db);
    await storeA.init();
    const storeB = new PageStore(db);
    await storeB.init();

    const testUrl = 'http://localhost:3000/concurrent-cross-instance';

    // Seed v1
    await storeA.savePage({
      url: testUrl,
      origin: 'http://localhost:3000',
      title: 'V1',
      textContent: 'Original content.',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    // Run simultaneous updates through storeA and storeB
    const [resA, resB] = await Promise.all([
      storeA.savePage({
        url: testUrl,
        origin: 'http://localhost:3000',
        title: 'V2 from A',
        textContent: 'Updated by instance A.',
        outgoingLinks: [],
        httpStatus: 200,
        contentType: 'text/html',
      }),
      storeB.savePage({
        url: testUrl,
        origin: 'http://localhost:3000',
        title: 'V2 from B',
        textContent: 'Updated by instance B.',
        outgoingLinks: [],
        httpStatus: 200,
        contentType: 'text/html',
      }),
    ]);

    expect(resA.outcome).toBe('updated');
    expect(resB.outcome).toBe('updated');
    const versions = await storeA.getVersions(testUrl);
    expect(versions).toHaveLength(3);
    expect(versions.map(v => v.version)).toEqual([3, 2, 1]);

    const page = await storeA.getPage(testUrl);
    expect(page!.version).toBe(3);
  });
});

describe('PageStore — Consistency & failure handling', () => {
  it('rolls back initial page creation if history insertion throws a non-duplicate error', async () => {
    const testUrl = 'http://localhost:3000/fail-initial-history';
    const versionsCol = (pageStore as unknown as { versionsCol: { insertOne: unknown } }).versionsCol;

    const spy = vi
      .spyOn(versionsCol, 'insertOne')
      .mockRejectedValueOnce(new Error('Simulated database crash during history insert'));

    await expect(
      pageStore.savePage({
        url: testUrl,
        origin: 'http://localhost:3000',
        title: 'Initial Title',
        textContent: 'Initial Content',
        outgoingLinks: [],
        httpStatus: 200,
        contentType: 'text/html',
      }),
    ).rejects.toThrow('Simulated database crash during history insert');

    spy.mockRestore();

    // Verify consistency: pages document was rolled back (deleted)
    const page = await pageStore.getPage(testUrl);
    expect(page).toBeNull();

    // Verify no orphaned version history exists
    const versions = await pageStore.getVersions(testUrl);
    expect(versions).toHaveLength(0);
  });

  it('rolls back page update to previous version if history insertion throws a non-duplicate error', async () => {
    const testUrl = 'http://localhost:3000/fail-update-history';

    // 1. Initial crawl: creates v1 cleanly
    await pageStore.savePage({
      url: testUrl,
      origin: 'http://localhost:3000',
      title: 'Original Title v1',
      textContent: 'Original Content v1',
      outgoingLinks: ['http://localhost:3000/link1'],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const pageBefore = await pageStore.getPage(testUrl);
    expect(pageBefore!.version).toBe(1);

    // 2. Simulate failure during v2 history insert
    const versionsCol = (pageStore as unknown as { versionsCol: { insertOne: unknown } }).versionsCol;
    const spy = vi
      .spyOn(versionsCol, 'insertOne')
      .mockRejectedValueOnce(new Error('Simulated disk full error on page_versions'));

    await expect(
      pageStore.savePage({
        url: testUrl,
        origin: 'http://localhost:3000',
        title: 'Updated Title v2',
        textContent: 'Updated Content v2 with brand new body',
        outgoingLinks: ['http://localhost:3000/link2'],
        httpStatus: 200,
        contentType: 'text/html',
      }),
    ).rejects.toThrow('Simulated disk full error on page_versions');

    spy.mockRestore();

    // Verify consistency: pages snapshot was rolled back to v1
    const pageAfter = await pageStore.getPage(testUrl);
    expect(pageAfter!.version).toBe(1);
    expect(pageAfter!.title).toBe('Original Title v1');
    expect(pageAfter!.textContent).toBe('Original Content v1');
    expect(pageAfter!.outgoingLinks).toEqual(['http://localhost:3000/link1']);

    // History collection must still contain only v1
    const versions = await pageStore.getVersions(testUrl);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].title).toBe('Original Title v1');
  });

  it('accepts duplicate key on history record only when version and contentHash match', async () => {
    const testUrl = 'http://localhost:3000/history-dup-match';

    // Seed v1
    await pageStore.savePage({
      url: testUrl,
      origin: 'http://localhost:3000',
      title: 'V1 Title',
      textContent: 'V1 Content',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    // Compute expected contentHash for v2
    const { computeContentHash } = await import('../../src/utils/contentHash.js');
    const v2Hash = computeContentHash('V2 Title', 'V2 Content');

    // Pre-seed matching history record for v2 (e.g. from prior partial idempotent retry)
    const page = await pageStore.getPage(testUrl);
    await db.collection('page_versions').insertOne({
      pageId: page!._id!,
      url: testUrl,
      version: 2,
      title: 'V2 Title',
      textContent: 'V2 Content',
      contentHash: v2Hash,
      httpStatus: 200,
      crawledAt: new Date(),
    });

    // Now save v2 — insertOne in versionsCol will throw duplicate key, but match will be verified
    const result = await pageStore.savePage({
      url: testUrl,
      origin: 'http://localhost:3000',
      title: 'V2 Title',
      textContent: 'V2 Content',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    expect(result.outcome).toBe('updated');
    expect(result.version).toBe(2);

    const updatedPage = await pageStore.getPage(testUrl);
    expect(updatedPage!.version).toBe(2);

    const versions = await pageStore.getVersions(testUrl);
    expect(versions).toHaveLength(2);
    expect(versions.map(v => v.version)).toEqual([2, 1]);
  });

  it('rejects and rolls back when history duplicate key has mismatched contentHash', async () => {
    const testUrl = 'http://localhost:3000/history-dup-mismatch';

    // Seed v1
    await pageStore.savePage({
      url: testUrl,
      origin: 'http://localhost:3000',
      title: 'Original Title',
      textContent: 'Original Content',
      outgoingLinks: [],
      httpStatus: 200,
      contentType: 'text/html',
    });

    const page = await pageStore.getPage(testUrl);

    // Pre-seed conflicting history record for v2 with an invalid/mismatched contentHash
    await db.collection('page_versions').insertOne({
      pageId: page!._id!,
      url: testUrl,
      version: 2,
      title: 'Conflicting Unknown Title',
      textContent: 'Conflicting Content',
      contentHash: 'mismatched_corrupted_hash_99999999999999999999999999999999',
      httpStatus: 200,
      crawledAt: new Date(),
    });

    // Save v2 with different content — should detect the conflict, rollback pages, and throw
    await expect(
      pageStore.savePage({
        url: testUrl,
        origin: 'http://localhost:3000',
        title: 'Intended V2 Title',
        textContent: 'Intended V2 Content',
        outgoingLinks: [],
        httpStatus: 200,
        contentType: 'text/html',
      }),
    ).rejects.toThrow(/Version conflict: page_versions already contains version 2/);

    // Verify pages document was rolled back to v1
    const pageAfter = await pageStore.getPage(testUrl);
    expect(pageAfter!.version).toBe(1);
    expect(pageAfter!.title).toBe('Original Title');
  });
});

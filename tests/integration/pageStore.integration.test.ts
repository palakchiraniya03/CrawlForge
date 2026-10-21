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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
});

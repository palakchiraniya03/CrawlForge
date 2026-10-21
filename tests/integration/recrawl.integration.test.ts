/**
 * End-to-end integration tests for incremental recrawling, HTTP 304 validators,
 * content-change versioning, and worker crash recovery.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { Frontier } from '../../src/frontier/frontier.js';
import { PageStore } from '../../src/db/pageStore.js';
import { CrawlerWorker } from '../../src/crawler/worker.js';
import { clearRobotsCache } from '../../src/crawler/robotsCache.js';
import { startFixtureServer, FixtureServer } from '../fixtures/fixtureServer.js';

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const TEST_DB = 'crawlforge_test_recrawl';

let client: MongoClient;
let db: Db;
let frontier: Frontier;
let pageStore: PageStore;
let fixture: FixtureServer;

beforeAll(async () => {
  client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(TEST_DB);

  fixture = await startFixtureServer();
});

afterAll(async () => {
  await fixture.stop();
  await db.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  frontier = new Frontier(db);
  await frontier.drop();
  await frontier.init();

  pageStore = new PageStore(db);
  await pageStore.drop();
  await pageStore.init();

  clearRobotsCache();
  fixture.resetRoutes();
});

describe('Incremental Recrawling — Conditional Requests (HTTP 304)', () => {
  it('sends If-None-Match, receives 304, and preserves content without creating new version', async () => {
    const worker = new CrawlerWorker(frontier, pageStore);
    const targetUrl = `${fixture.baseUrl}/conditional-etag`;

    // 1. Initial crawl: should receive 200 and store v1
    await frontier.addUrl(targetUrl, 0);
    const crawl1 = await worker.processNext();
    expect(crawl1).not.toBeNull();
    expect(crawl1!.status).toBe('done');
    expect(crawl1!.httpStatus).toBe(200);
    expect(crawl1!.version).toBe(1);
    expect(crawl1!.isNewVersion).toBe(true);

    const page1 = await pageStore.getPage(targetUrl);
    expect(page1).not.toBeNull();
    expect(page1!.etag).toBe('"etag-v1"');
    expect(page1!.version).toBe(1);

    // 2. Schedule incremental recrawl (re-add to frontier)
    // Note: Frontier allows re-adding once marked done or we reset status for recrawl
    await db.collection('frontier_urls').updateOne(
      { url: targetUrl },
      { $set: { status: 'pending' }, $unset: { lease_expires_at: '' } },
    );

    // Worker claims job, checks pageStore for existing ETag, and sends If-None-Match
    const crawl2 = await worker.processNext();
    expect(crawl2).not.toBeNull();
    expect(crawl2!.status).toBe('done');
    expect(crawl2!.httpStatus).toBe(304);
    expect(crawl2!.is304).toBe(true);
    expect(crawl2!.version).toBe(1);
    expect(crawl2!.isNewVersion).toBe(false);

    // Verify existing content and single version in database
    const page2 = await pageStore.getPage(targetUrl);
    expect(page2!.textContent).toContain('ETag content');
    expect(page2!.version).toBe(1);

    const versions = await pageStore.getVersions(targetUrl);
    expect(versions).toHaveLength(1);
  });

  it('sends If-Modified-Since, receives 304, and updates lastCrawledAt without data loss', async () => {
    const worker = new CrawlerWorker(frontier, pageStore);
    const targetUrl = `${fixture.baseUrl}/conditional-modified`;

    // Initial crawl
    await frontier.addUrl(targetUrl, 0);
    const crawl1 = await worker.processNext();
    expect(crawl1!.httpStatus).toBe(200);
    expect(crawl1!.version).toBe(1);

    const pageBefore = await pageStore.getPage(targetUrl);
    const firstCrawlTime = pageBefore!.lastCrawledAt.getTime();

    await new Promise(r => setTimeout(r, 15));

    // Recrawl with conditional If-Modified-Since
    await db.collection('frontier_urls').updateOne(
      { url: targetUrl },
      { $set: { status: 'pending' }, $unset: { lease_expires_at: '' } },
    );

    const crawl2 = await worker.processNext();
    expect(crawl2!.httpStatus).toBe(304);
    expect(crawl2!.is304).toBe(true);

    const pageAfter = await pageStore.getPage(targetUrl);
    expect(pageAfter!.textContent).toContain('Modified content');
    expect(pageAfter!.lastCrawledAt.getTime()).toBeGreaterThan(firstCrawlTime);
  });
});

describe('Incremental Recrawling — Content Changes & Versioning', () => {
  it('creates Version 2 when page content changes on the remote server', async () => {
    const worker = new CrawlerWorker(frontier, pageStore);
    const targetUrl = `${fixture.baseUrl}/page-a`;

    // Initial crawl of Page A
    await frontier.addUrl(targetUrl, 0);
    const crawl1 = await worker.processNext();
    expect(crawl1!.version).toBe(1);
    expect(crawl1!.extracted?.textContent).toContain('Some content on page A.');

    // Simulate website update: new content on /page-a
    fixture.setRoute('/page-a', {
      status: 200,
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><head><title>Page A - Updated Edition</title></head><body>
        <h1>Page A (Revised)</h1>
        <p>Brand new article content published in version two.</p>
      </body></html>`,
    });

    // Schedule recrawl
    await db.collection('frontier_urls').updateOne(
      { url: targetUrl },
      { $set: { status: 'pending' }, $unset: { lease_expires_at: '' } },
    );

    const crawl2 = await worker.processNext();
    expect(crawl2!.httpStatus).toBe(200);
    expect(crawl2!.outcome).toBe('updated');
    expect(crawl2!.version).toBe(2);
    expect(crawl2!.isNewVersion).toBe(true);

    // Verify current page document has v2
    const current = await pageStore.getPage(targetUrl);
    expect(current!.version).toBe(2);
    expect(current!.title).toBe('Page A - Updated Edition');
    expect(current!.textContent).toContain('Brand new article content');

    // Verify historical versions collection contains v2 and v1
    const versions = await pageStore.getVersions(targetUrl);
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(2);
    expect(versions[0].title).toBe('Page A - Updated Edition');
    expect(versions[1].version).toBe(1);
    expect(versions[1].title).toBe('Page A');
  });

  it('keeps Version 1 when content is unchanged even without 304 support', async () => {
    const worker = new CrawlerWorker(frontier, pageStore);
    const targetUrl = `${fixture.baseUrl}/page-a`;

    // Initial crawl
    await frontier.addUrl(targetUrl, 0);
    await worker.processNext();

    // Recrawl with identical content (server returns 200 with identical body)
    await db.collection('frontier_urls').updateOne(
      { url: targetUrl },
      { $set: { status: 'pending' }, $unset: { lease_expires_at: '' } },
    );

    const crawl2 = await worker.processNext();
    expect(crawl2!.httpStatus).toBe(200);
    expect(crawl2!.outcome).toBe('unchanged');
    expect(crawl2!.version).toBe(1);
    expect(crawl2!.isNewVersion).toBe(false);

    // Version collection must remain at 1
    const versions = await pageStore.getVersions(targetUrl);
    expect(versions).toHaveLength(1);
  });
});

describe('Worker Recovery — Crashed process & abandoned leases', () => {
  it('recovers abandoned claimed jobs after worker crash or process restart', async () => {
    // 1. Worker 1 claims a job
    await frontier.addUrl(`${fixture.baseUrl}/page-a`, 0);
    const claimedJob = await frontier.claimNext();
    expect(claimedJob).not.toBeNull();
    expect(claimedJob!.status).toBe('claimed');

    // 2. Simulate worker crash: lease expires in the past
    const expiredTimestamp = new Date(Date.now() - 1000);
    await db.collection('frontier_urls').updateOne(
      { _id: claimedJob!._id },
      { $set: { lease_expires_at: expiredTimestamp } },
    );

    // 3. Process restart / recovery routine runs
    const recoveredCount = await frontier.recoverPendingWork(new Date());
    expect(recoveredCount).toBe(1);

    // Verify status was restored to 'pending'
    const doc = await db.collection('frontier_urls').findOne({ _id: claimedJob!._id });
    expect(doc?.status).toBe('pending');
    expect(doc?.lease_expires_at).toBeUndefined();

    // 4. Worker 2 starts up, claims the recovered job, and successfully completes it
    const worker2 = new CrawlerWorker(frontier, pageStore);
    const result = await worker2.processNext();
    expect(result).not.toBeNull();
    expect(result!.status).toBe('done');
    expect(result!.url).toBe(`${fixture.baseUrl}/page-a`);

    // Verify final state is done
    const finalDoc = await db.collection('frontier_urls').findOne({ _id: claimedJob!._id });
    expect(finalDoc?.status).toBe('done');
  });
});

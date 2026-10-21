/**
 * End-to-end integration test for the CrawlerWorker.
 *
 * Verifies:
 * - Seeding and crawling pages from local fixture server
 * - Content extraction (title, text, outgoing links)
 * - Automatic link enqueuing into MongoDB frontier
 * - Scope filtering (out-of-scope links not enqueued)
 * - Deduplication of discovered links
 * - Disallowed paths blocked by robots.txt
 * - Redirect following
 * - Frontier status transitions (pending -> claimed -> done/failed)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { Frontier } from '../../src/frontier/frontier.js';
import { CrawlerWorker } from '../../src/crawler/worker.js';
import { clearRobotsCache } from '../../src/crawler/robotsCache.js';
import { startFixtureServer, FixtureServer } from '../fixtures/fixtureServer.js';

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const TEST_DB = 'crawlforge_test_crawler_worker';

let client: MongoClient;
let db: Db;
let frontier: Frontier;
let worker: CrawlerWorker;
let fixture: FixtureServer;

beforeAll(async () => {
  client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(TEST_DB);

  frontier = new Frontier(db);
  await frontier.drop();
  await frontier.init();

  worker = new CrawlerWorker(frontier);
  fixture = await startFixtureServer();
  clearRobotsCache();
});

afterAll(async () => {
  await fixture.stop();
  await db.dropDatabase();
  await client.close();
});

describe('CrawlerWorker end-to-end crawl', () => {
  it('crawls root page and enqueues discovered in-scope links', async () => {
    // Seed with fixture root
    const added = await frontier.addUrl(`${fixture.baseUrl}/`, 0);
    expect(added).toBe(true);

    const result = await worker.processNext();
    expect(result).not.toBeNull();
    expect(result!.status).toBe('done');
    expect(result!.httpStatus).toBe(200);
    expect(result!.extracted?.title).toBe('Fixture Home');
    expect(result!.extracted?.textContent).toContain('Home');

    // /page-a, /page-b, /secret should be added;
    // duplicate /page-a is deduplicated;
    // js/mailto links ignored;
    // external out-of-scope link is ignored.
    expect(result!.linksEnqueued).toBeGreaterThanOrEqual(2);

    // Verify /page-a is in frontier
    const isPageAKnown = await frontier.isKnown(`${fixture.baseUrl}/page-a`);
    expect(isPageAKnown).toBe(true);

    // Verify out-of-scope link was NOT added to frontier
    const isExternalKnown = await frontier.isKnown('http://external-not-allowed.com/page');
    expect(isExternalKnown).toBe(false);
  });

  it('crawls page-a and handles links back to root without infinite loop', async () => {
    const result = await worker.processNext();
    expect(result).not.toBeNull();
    expect(result!.status).toBe('done');
    expect(result!.extracted?.title).toBe('Page A');
    // Root was already known, so no new links enqueued
    expect(result!.linksEnqueued).toBe(0);
  });

  it('handles redirects safely during crawl', async () => {
    // /page-b redirects to /page-a
    const result = await worker.processNext();
    expect(result).not.toBeNull();
    expect(result!.status).toBe('done');
    expect(result!.httpStatus).toBe(200);
    expect(result!.extracted?.title).toBe('Page A');
  });

  it('blocks crawling pages disallowed by robots.txt and persists robots_blocked', async () => {
    // /secret is in the frontier because it was linked on the home page
    const result = await worker.processNext();
    expect(result).not.toBeNull();
    expect(result!.status).toBe('robots_blocked');
    expect(result!.error).toMatch(/robots\.txt/i);

    // Verify frontier recorded robots_blocked as a distinct terminal status
    const blockedDocs = await frontier.listByStatus('robots_blocked');
    expect(blockedDocs).toHaveLength(1);
    expect(blockedDocs[0].url).toContain('/secret');
    expect(blockedDocs[0].status).toBe('robots_blocked');
    expect(blockedDocs[0].error_message).toMatch(/robots/i);

    // Verify it is NOT recorded as a transient 'failed' job
    const failedDocs = await frontier.listByStatus('failed');
    expect(failedDocs).toHaveLength(0);

    // Verify stats report robots_blocked consistently
    const stats = await frontier.getStats();
    expect(stats['robots_blocked']).toBe(1);
    expect(stats['done']).toBe(3);
    expect(stats['failed']).toBeUndefined();

    // Verify detailed stats distinguish scope
    const detailed = await frontier.getDetailedStats(fixture.baseUrl);
    expect(detailed.scope).toBe('origin');
    expect(detailed.origin).toBe(fixture.baseUrl);
    expect(detailed.counts['robots_blocked']).toBe(1);
    expect(detailed.counts['done']).toBe(3);
    expect(detailed.total).toBe(4);
  });

  it('returns null when frontier queue is exhausted', async () => {
    const result = await worker.processNext();
    expect(result).toBeNull();
  });
});

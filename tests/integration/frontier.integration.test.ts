/**
 * Integration tests for the URL frontier with a real MongoDB connection.
 *
 * Tests:
 * - URL deduplication (duplicate add returns false)
 * - Scope filtering (out-of-scope URLs rejected)
 * - Atomic job claiming
 * - markDone / markFailed state transitions
 * - Lease expiry and recovery of abandoned jobs
 * - BFS ordering (depth ordering)
 * - Retry scheduling
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { Frontier } from '../../src/frontier/frontier.js';

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const TEST_DB = 'crawlforge_test_frontier';

// Note: ALLOWED_DOMAINS=localhost is set in tests/setup.ts

let client: MongoClient;
let db: Db;
let frontier: Frontier;

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
  // Start each test with a clean frontier
  frontier = new Frontier(db);
  await frontier.drop();  // drop() handles uninitialized col internally
  await frontier.init();
});

describe('Frontier.addUrl', () => {
  it('adds a new URL and returns true', async () => {
    const added = await frontier.addUrl('http://localhost:3001/page', 0);
    expect(added).toBe(true);
  });

  it('returns false for duplicate URL (normalized)', async () => {
    await frontier.addUrl('http://localhost:3001/page', 0);
    const added = await frontier.addUrl('http://localhost:3001/page#fragment', 0); // same after normalization
    expect(added).toBe(false);
  });

  it('returns false for URL with different query order (normalized)', async () => {
    await frontier.addUrl('http://localhost:3001/page?z=1&a=2', 0);
    const added = await frontier.addUrl('http://localhost:3001/page?a=2&z=1', 0);
    expect(added).toBe(false);
  });

  it('rejects out-of-scope URLs', async () => {
    const added = await frontier.addUrl('http://external-site.com/page', 0);
    expect(added).toBe(false);
  });

  it('rejects invalid URLs', async () => {
    const added = await frontier.addUrl('not-a-url', 0);
    expect(added).toBe(false);
  });
});

describe('Frontier.claimNext', () => {
  it('returns null when queue is empty', async () => {
    const job = await frontier.claimNext();
    expect(job).toBeNull();
  });

  it('claims a pending job and sets status to claimed', async () => {
    await frontier.addUrl('http://localhost:3001/page', 0);
    const job = await frontier.claimNext();
    expect(job).not.toBeNull();
    expect(job!.status).toBe('claimed');
    expect(job!.url).toBe('http://localhost:3001/page');
    expect(job!.lease_expires_at).toBeInstanceOf(Date);
  });

  it('does not double-claim the same job', async () => {
    await frontier.addUrl('http://localhost:3001/page', 0);
    const job1 = await frontier.claimNext();
    const job2 = await frontier.claimNext(); // queue now empty
    expect(job1).not.toBeNull();
    expect(job2).toBeNull();
  });

  it('prefers shallower depth (BFS ordering)', async () => {
    await frontier.addUrl('http://localhost:3001/deep', 3);
    await frontier.addUrl('http://localhost:3001/shallow', 0);
    await frontier.addUrl('http://localhost:3001/mid', 1);

    const j1 = await frontier.claimNext();
    const j2 = await frontier.claimNext();
    const j3 = await frontier.claimNext();

    expect(j1!.depth).toBe(0);
    expect(j2!.depth).toBe(1);
    expect(j3!.depth).toBe(3);
  });

  it('recovers a job with expired lease', async () => {
    await frontier.addUrl('http://localhost:3001/page', 0);
    // Claim it, then manually expire the lease
    await frontier.claimNext();
    // Force-expire all leases
    await frontier.expireAllLeases();
    // Should now be re-claimable
    const job = await frontier.claimNext();
    expect(job).not.toBeNull();
    expect(job!.url).toBe('http://localhost:3001/page');
  });
});

describe('Frontier.markDone', () => {
  it('marks a claimed job as done', async () => {
    await frontier.addUrl('http://localhost:3001/page', 0);
    await frontier.claimNext();
    await frontier.markDone('http://localhost:3001/page');

    const stats = await frontier.getStats();
    expect(stats['done']).toBe(1);
    expect(stats['claimed']).toBeUndefined();
  });

  it('sets last_crawled_at timestamp', async () => {
    const before = new Date();
    await frontier.addUrl('http://localhost:3001/ts-page', 0);
    await frontier.claimNext();
    await frontier.markDone('http://localhost:3001/ts-page');

    const docs = await frontier.listByStatus('done');
    expect(docs[0].last_crawled_at).toBeDefined();
    expect(docs[0].last_crawled_at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});

describe('Frontier.markFailed', () => {
  it('decrements retries and sets failed status', async () => {
    // maxRetries defaults to 3
    await frontier.addUrl('http://localhost:3001/page', 0);
    await frontier.claimNext();
    await frontier.markFailed('http://localhost:3001/page', 'Test error');

    const docs = await frontier.listByStatus('failed');
    expect(docs).toHaveLength(1);
    expect(docs[0].error_message).toBe('Test error');
    expect(docs[0].next_retry_at).toBeInstanceOf(Date);
  });

  it('sets permanent error when retries exhausted', async () => {
    await frontier.addUrl('http://localhost:3001/exhaust', 0);

    // We need to drive the doc through all retries until retries_left === 0.
    // After each markFailed, the doc moves to 'failed' with a future next_retry_at.
    // We manually patch next_retry_at to the past so claimNext picks it up again.
    const url = 'http://localhost:3001/exhaust';
    const col = (frontier as unknown as { col: import('mongodb').Collection }).col;

    const maxRetries = parseInt(process.env.CRAWL_MAX_RETRIES ?? '3', 10);

    for (let i = 0; i <= maxRetries; i++) {
      // Make any failed doc immediately retriable
      await col.updateMany(
        { status: 'failed' },
        { $set: { next_retry_at: new Date(0) } },
      );
      const job = await frontier.claimNext();
      if (!job) break;
      await frontier.markFailed(url, 'Simulated error');
    }

    const stats = await frontier.getStats();
    expect(stats['error']).toBe(1);
    expect(stats['failed']).toBeUndefined();
  });
});

describe('Frontier.isKnown', () => {
  it('returns true for known URLs', async () => {
    await frontier.addUrl('http://localhost:3001/known', 0);
    expect(await frontier.isKnown('http://localhost:3001/known')).toBe(true);
  });

  it('returns false for unknown URLs', async () => {
    expect(await frontier.isKnown('http://localhost:3001/unknown')).toBe(false);
  });
});

describe('Frontier.markRobotsBlocked', () => {
  it('marks job as robots_blocked and removes it from claim queue permanently', async () => {
    await frontier.addUrl('http://localhost:3001/disallowed', 0);
    const job = await frontier.claimNext();
    expect(job).not.toBeNull();

    await frontier.markRobotsBlocked('http://localhost:3001/disallowed', 'Disallowed by robots.txt');

    const docs = await frontier.listByStatus('robots_blocked');
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe('robots_blocked');
    expect(docs[0].error_message).toBe('Disallowed by robots.txt');
    expect(docs[0].last_crawled_at).toBeInstanceOf(Date);

    // Verify it is NOT retried or re-claimed
    const nextJob = await frontier.claimNext();
    expect(nextJob).toBeNull();
  });
});

describe('Frontier.claimNext with origin filter', () => {
  it('claims only jobs matching the requested origin', async () => {
    // Port numbers distinguish origins on localhost
    await frontier.addUrl('http://localhost:3001/page-1', 0);
    await frontier.addUrl('http://localhost:3002/page-2', 0);

    const job3002 = await frontier.claimNext('http://localhost:3002');
    expect(job3002).not.toBeNull();
    expect(job3002!.url).toBe('http://localhost:3002/page-2');

    // Next claim for 3002 should be empty
    const empty3002 = await frontier.claimNext('http://localhost:3002');
    expect(empty3002).toBeNull();

    // 3001 is still pending
    const job3001 = await frontier.claimNext('http://localhost:3001');
    expect(job3001).not.toBeNull();
    expect(job3001!.url).toBe('http://localhost:3001/page-1');
  });
});

describe('Frontier.getStats', () => {
  it('returns correct counts per status', async () => {
    await frontier.addUrl('http://localhost:3001/p1', 0);
    await frontier.addUrl('http://localhost:3001/p2', 0);
    await frontier.addUrl('http://localhost:3001/p3', 0);
    await frontier.claimNext();

    const stats = await frontier.getStats();
    expect(stats['pending']).toBe(2);
    expect(stats['claimed']).toBe(1);
  });

  it('filters stats by origin vs returning global collection totals', async () => {
    await frontier.addUrl('http://localhost:3001/a', 0);
    await frontier.addUrl('http://localhost:3001/b', 0);
    await frontier.addUrl('http://localhost:3002/c', 0);

    // Global totals: 3 pending
    const globalStats = await frontier.getStats();
    expect(globalStats['pending']).toBe(3);

    // Scoped to 3001: 2 pending
    const scoped3001 = await frontier.getStats('http://localhost:3001');
    expect(scoped3001['pending']).toBe(2);

    // Scoped to 3002: 1 pending
    const scoped3002 = await frontier.getStats('http://localhost:3002');
    expect(scoped3002['pending']).toBe(1);

    // Detailed stats include scope metadata
    const detailed = await frontier.getDetailedStats('http://localhost:3001');
    expect(detailed.scope).toBe('origin');
    expect(detailed.origin).toBe('http://localhost:3001');
    expect(detailed.total).toBe(2);
  });
});

describe('Frontier startup recovery', () => {
  it('automatically recovers expired leases to pending on init() without altering active unexpired leases', async () => {
    // 1. Add two URLs and claim both
    await frontier.addUrl('http://localhost:3001/expired', 0);
    await frontier.addUrl('http://localhost:3001/active', 0);

    const job1 = await frontier.claimNext();
    const job2 = await frontier.claimNext();

    expect(job1).not.toBeNull();
    expect(job2).not.toBeNull();

    // 2. Set job1's lease into the past (crashed worker), job2's lease into the future (active worker)
    const past = new Date(Date.now() - 5000);
    const future = new Date(Date.now() + 60000);

    const col = db.collection('frontier_urls');
    await col.updateOne({ url: job1!.url }, { $set: { lease_expires_at: past } });
    await col.updateOne({ url: job2!.url }, { $set: { lease_expires_at: future } });

    // 3. New frontier instance starts up (simulating application/worker restart)
    const restartedFrontier = new Frontier(db);
    await restartedFrontier.init();

    // 4. Verify job1 is now restored to 'pending', while job2 remains 'claimed' with unexpired lease
    const doc1 = await col.findOne({ url: job1!.url });
    const doc2 = await col.findOne({ url: job2!.url });

    expect(doc1?.status).toBe('pending');
    expect(doc1?.lease_expires_at).toBeUndefined();

    expect(doc2?.status).toBe('claimed');
    expect(doc2?.lease_expires_at).toBeDefined();
  });
});

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
});

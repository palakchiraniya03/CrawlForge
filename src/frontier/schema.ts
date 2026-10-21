/**
 * MongoDB frontier schema and index definitions.
 *
 * Collection: frontier_urls
 *
 * Documents represent discovered URLs and their crawl state.
 * The state machine is:
 *
 *   pending → claimed → done
 *                    ↘ robots_blocked (permanent policy block, no retries)
 *                    ↘ failed (transient, retryable with retries_left)
 *                    ↘ error  (permanent failure / retries exhausted)
 *
 * Lease expiry: if a claimed job isn't completed within LEASE_DURATION_MS,
 * it can be reclaimed by another worker (recovery from crashes).
 */

import type { Db, Collection } from 'mongodb';

export const COLLECTION_NAME = 'frontier_urls';
export const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

export type CrawlStatus =
  | 'pending'
  | 'claimed'
  | 'done'
  | 'failed'
  | 'error'
  | 'robots_blocked';

export interface FrontierDoc {
  _id?: import('mongodb').ObjectId;
  url: string;             // Normalized URL (unique key)
  status: CrawlStatus;
  origin: string;          // e.g. "http://localhost:3001"
  depth: number;           // Crawl depth from seed
  retries_left: number;    // Remaining retry attempts
  discovered_at: Date;
  last_crawled_at?: Date;
  next_retry_at?: Date;    // When to retry (for failed status)
  lease_expires_at?: Date; // Set when status = 'claimed'
  error_message?: string;
  http_status?: number;
}

/**
 * Initialize the frontier collection with all required indexes.
 * Idempotent — safe to call on every startup.
 */
export async function initFrontierCollection(db: Db): Promise<Collection<FrontierDoc>> {
  const col = db.collection<FrontierDoc>(COLLECTION_NAME);

  // Unique index on URL for deduplication
  await col.createIndex({ url: 1 }, { unique: true, name: 'url_unique' });

  // Index for claiming pending jobs (status + depth for BFS ordering)
  await col.createIndex(
    { status: 1, depth: 1, discovered_at: 1 },
    { name: 'claim_pending' },
  );

  // Index for recovering expired leases
  await col.createIndex(
    { status: 1, lease_expires_at: 1 },
    { name: 'lease_expiry', sparse: true },
  );

  // Index for retry scheduling
  await col.createIndex(
    { status: 1, next_retry_at: 1 },
    { name: 'retry_schedule', sparse: true },
  );

  // Index for per-origin operations (pacing, listing)
  await col.createIndex({ origin: 1, status: 1 }, { name: 'origin_status' });

  return col;
}

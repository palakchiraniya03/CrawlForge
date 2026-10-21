/**
 * URL frontier — persistent queue for crawl jobs backed by MongoDB.
 *
 * Key properties:
 * - Deduplication via unique index on normalized URL.
 * - Atomic job claiming using findOneAndUpdate (no double-claiming).
 * - Lease expiry: crashed/slow workers' jobs are automatically reclaimable.
 * - BFS ordering by depth, then discovery time.
 * - Retry scheduling with next_retry_at timestamps.
 */

import type { Collection, Db } from 'mongodb';
import { normalizeUrl } from '../utils/urlNormalizer.js';
import {
  FrontierDoc,
  CrawlStatus,
  COLLECTION_NAME,
  LEASE_DURATION_MS,
  initFrontierCollection,
} from './schema.js';
import { config } from '../config/env.js';

export interface FrontierStatsSummary {
  /** 'global' indicates collection-wide totals; 'origin' indicates counts filtered by origin. */
  scope: 'global' | 'origin';
  origin?: string;
  counts: Record<CrawlStatus | string, number>;
  total: number;
}

export class Frontier {
  private col!: Collection<FrontierDoc>;

  constructor(private readonly db: Db) {}

  async init(): Promise<void> {
    this.col = await initFrontierCollection(this.db);
    // Recover any abandoned or expired claims left from a crashed or killed process on startup
    await this.recoverPendingWork();
  }

  /**
   * Add a URL to the frontier if it hasn't been seen before.
   * Silently ignores duplicates (idempotent).
   * Returns true if the URL was newly added, false if it was already known.
   *
   * Only adds URLs whose origin is in the allowed domain list.
   */
  async addUrl(rawUrl: string, depth: number = 0): Promise<boolean> {
    const { normalized, valid } = normalizeUrl(rawUrl);
    if (!valid) return false;

    // Scope check: only crawl URLs whose hostname matches an allowed domain.
    // Port is intentionally NOT checked — ALLOWED_DOMAINS lists hostnames, not
    // full origins, so the same hostname on different ports is permitted.
    // This allows the test fixture (localhost:dynamic-port) to match "localhost".
    let hostname: string;
    let origin: string;
    try {
      const parsed = new URL(normalized);
      hostname = parsed.hostname;
      origin = parsed.origin;
    } catch {
      return false;
    }

    const isAllowed = config.crawl.allowedDomains.some(allowed => {
      const allowedHost = allowed.startsWith('http') ? new URL(allowed).hostname : allowed;
      return hostname === allowedHost || hostname.endsWith(`.${allowedHost}`);
    });

    if (!isAllowed) return false;

    const doc: Omit<FrontierDoc, '_id'> = {
      url: normalized,
      status: 'pending',
      origin,
      depth,
      retries_left: config.crawl.maxRetries,
      discovered_at: new Date(),
    };

    try {
      await this.col.insertOne(doc as FrontierDoc);
      return true;
    } catch (err: unknown) {
      // Duplicate key → URL already known
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  }

  /**
   * Atomically claim one pending job for processing.
   * Also recovers jobs with expired leases (crashed workers).
   * Returns null if the queue is empty.
   *
   * @param origin - Optional origin filter (e.g. "http://localhost:3000").
   * If provided, only claims jobs matching this origin.
   * If omitted, claims the shallowest pending job across the entire frontier.
   */
  async claimNext(origin?: string): Promise<FrontierDoc | null> {
    const now = new Date();
    const leaseExpiry = new Date(now.getTime() + LEASE_DURATION_MS);

    // Try to claim a pending job OR an expired-lease job
    const query: Record<string, unknown> = {
      $or: [
        { status: 'pending' },
        { status: 'failed', next_retry_at: { $lte: now } },
        // Recover abandoned claims with expired leases
        { status: 'claimed', lease_expires_at: { $lt: now } },
      ],
    };

    if (origin) {
      query.origin = origin;
    }

    const result = await this.col.findOneAndUpdate(
      query,
      {
        $set: {
          status: 'claimed',
          lease_expires_at: leaseExpiry,
        },
      },
      {
        sort: { depth: 1, discovered_at: 1 }, // BFS: shallowest first
        returnDocument: 'after',
      },
    );

    return result ?? null;
  }

  /**
   * Mark a job as successfully completed.
   */
  async markDone(url: string): Promise<void> {
    const { normalized } = normalizeUrl(url);
    await this.col.updateOne(
      { url: normalized },
      {
        $set: {
          status: 'done',
          last_crawled_at: new Date(),
        },
        $unset: { lease_expires_at: '', next_retry_at: '', error_message: '' },
      },
    );
  }

  /**
   * Mark a job as permanently blocked by robots.txt.
   * Unlike transient failures (status='failed'), robots_blocked is not retried.
   */
  async markRobotsBlocked(url: string, reason = 'Disallowed by robots.txt'): Promise<void> {
    const { normalized } = normalizeUrl(url);
    await this.col.updateOne(
      { url: normalized },
      {
        $set: {
          status: 'robots_blocked',
          error_message: reason,
          last_crawled_at: new Date(),
        },
        $unset: { lease_expires_at: '', next_retry_at: '' },
      },
    );
  }

  /**
   * Mark a job as failed. If retries remain, schedule a retry with backoff.
   * Otherwise mark as permanently errored.
   */
  async markFailed(url: string, errorMessage: string, httpStatus?: number): Promise<void> {
    const { normalized } = normalizeUrl(url);
    const doc = await this.col.findOne({ url: normalized });
    if (!doc) return;

    const retriesLeft = doc.retries_left - 1;

    if (retriesLeft > 0) {
      // Exponential backoff: 1min, 2min, 4min
      const attempt = config.crawl.maxRetries - retriesLeft;
      const backoffMs = Math.min(60_000 * Math.pow(2, attempt - 1), 30 * 60_000);
      const nextRetryAt = new Date(Date.now() + backoffMs);

      await this.col.updateOne(
        { url: normalized },
        {
          $set: {
            status: 'failed',
            error_message: errorMessage,
            http_status: httpStatus,
            retries_left: retriesLeft,
            next_retry_at: nextRetryAt,
          },
          $unset: { lease_expires_at: '' },
        },
      );
    } else {
      await this.col.updateOne(
        { url: normalized },
        {
          $set: {
            status: 'error',
            error_message: errorMessage,
            http_status: httpStatus,
            retries_left: 0,
          },
          $unset: { lease_expires_at: '', next_retry_at: '' },
        },
      );
    }
  }

  /**
   * Return counts by status for monitoring.
   *
   * IMPORTANT: When called without arguments, this returns global collection totals
   * across ALL origins and crawl runs. To get counts scoped to a specific origin or
   * crawl run, pass the `origin` parameter (e.g. "http://localhost:3000").
   *
   * @param origin - Optional origin filter.
   */
  async getStats(origin?: string): Promise<Record<CrawlStatus | string, number>> {
    const pipeline: import('mongodb').Document[] = [];
    if (origin) {
      pipeline.push({ $match: { origin } });
    }
    pipeline.push({ $group: { _id: '$status', count: { $sum: 1 } } });

    const rows = await this.col.aggregate<{ _id: string; count: number }>(pipeline).toArray();
    const stats: Record<string, number> = {};
    for (const row of rows) {
      stats[row._id] = row.count;
    }
    return stats;
  }

  /**
   * Return a detailed stats summary including scope metadata ('global' vs 'origin')
   * and total document count, preventing ambiguity between global and run-scoped statistics.
   */
  async getDetailedStats(origin?: string): Promise<FrontierStatsSummary> {
    const counts = await this.getStats(origin);
    const total = Object.values(counts).reduce((acc, c) => acc + c, 0);
    return {
      scope: origin ? 'origin' : 'global',
      origin,
      counts,
      total,
    };
  }

  /**
   * Check if a URL is already known to the frontier (any status).
   */
  async isKnown(rawUrl: string): Promise<boolean> {
    const { normalized, valid } = normalizeUrl(rawUrl);
    if (!valid) return false;
    const count = await this.col.countDocuments({ url: normalized });
    return count > 0;
  }

  /**
   * List URLs by status (for API endpoints). Bounded to 100.
   */
  async listByStatus(status: CrawlStatus, limit = 100): Promise<FrontierDoc[]> {
    return this.col.find({ status }).sort({ discovered_at: -1 }).limit(limit).toArray();
  }

  /**
   * Reset abandoned or expired claims back to 'pending'.
   * Called on process restart or periodically to recover jobs left in 'claimed' state
   * by a crashed or killed worker process.
   *
   * @param before - Only recover claims whose lease expired before this timestamp (defaults to now).
   */
  async recoverPendingWork(before: Date = new Date()): Promise<number> {
    const result = await this.col.updateMany(
      {
        status: 'claimed',
        lease_expires_at: { $lte: before },
      },
      {
        $set: { status: 'pending' },
        $unset: { lease_expires_at: '' },
      },
    );
    return result.modifiedCount;
  }

  /**
   * Forcibly expire all leases (for testing / manual recovery).
   */
  async expireAllLeases(): Promise<number> {
    const result = await this.col.updateMany(
      { status: 'claimed' },
      [
        {
          $set: {
            status: 'pending',
            lease_expires_at: '$$REMOVE',
          },
        },
      ],
    );
    return result.modifiedCount;
  }

  /**
   * Drop the frontier collection (for tests only).
   */
  async drop(): Promise<void> {
    if (!this.col) {
      // Not yet initialized — initialize first so we have a handle to drop
      this.col = await initFrontierCollection(this.db);
    }
    await this.col.drop().catch(() => { /* ignore if not exists */ });
    // Reset col so init() re-creates indexes cleanly
    this.col = undefined as unknown as Collection<FrontierDoc>;
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: number }).code === 11000
  );
}

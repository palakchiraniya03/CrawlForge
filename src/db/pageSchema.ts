/**
 * MongoDB schemas and indexes for persistent page storage and version history.
 *
 * Architecture:
 * - `pages` collection: Current/latest snapshot of every discovered and crawled page.
 *   Enforces unique URL identity.
 * - `page_versions` collection: Immutable append-only log of content versions.
 *   Avoids unbounded arrays inside the `pages` document (protecting against MongoDB 16MB document limit).
 */

import type { Db, Collection, ObjectId } from 'mongodb';

export const PAGES_COLLECTION = 'pages';
export const PAGE_VERSIONS_COLLECTION = 'page_versions';

export interface PageDoc {
  _id?: ObjectId;
  url: string;               // Normalized URL (unique identity)
  origin: string;            // Origin (e.g. http://localhost:3000)
  title: string;
  textContent: string;
  outgoingLinks: string[];
  httpStatus: number;
  contentType: string;
  contentHash: string;       // SHA-256 of extracted readable content
  etag?: string;             // HTTP ETag validator
  lastModified?: string;     // HTTP Last-Modified validator
  version: number;           // Monotonically increasing version counter, starts at 1
  firstCrawledAt: Date;
  lastCrawledAt: Date;
  lastChangedAt: Date;
}

export interface PageVersionDoc {
  _id?: ObjectId;
  pageId: ObjectId;          // Foreign key reference to pages._id
  url: string;
  version: number;
  title: string;
  textContent: string;
  contentHash: string;
  httpStatus: number;
  crawledAt: Date;
}

/**
 * Initialize collections and indexes for pages and page versions.
 * Idempotent — safe to execute on application startup.
 */
export async function initPageCollections(db: Db): Promise<{
  pagesCol: Collection<PageDoc>;
  versionsCol: Collection<PageVersionDoc>;
}> {
  const pagesCol = db.collection<PageDoc>(PAGES_COLLECTION);
  const versionsCol = db.collection<PageVersionDoc>(PAGE_VERSIONS_COLLECTION);

  // Unique index on URL to prevent duplicate page records
  await pagesCol.createIndex({ url: 1 }, { unique: true, name: 'page_url_unique' });

  // Index on origin for origin-scoped operations
  await pagesCol.createIndex({ origin: 1 }, { name: 'page_origin' });

  // Index on contentHash for fast deduplication / similarity checks
  await pagesCol.createIndex({ contentHash: 1 }, { name: 'page_content_hash' });

  // Index on lastCrawledAt for recrawl scheduling
  await pagesCol.createIndex({ lastCrawledAt: -1 }, { name: 'page_last_crawled' });

  // Page versions indexes:
  // Unique compound index on { url, version } to enforce strict monotonic version identity
  await versionsCol.createIndex({ url: 1, version: 1 }, { unique: true, name: 'version_url_unique' });

  // Index on pageId and version for version history queries
  await versionsCol.createIndex({ pageId: 1, version: -1 }, { name: 'version_page_history' });

  // Index on crawledAt for temporal audits
  await versionsCol.createIndex({ crawledAt: -1 }, { name: 'version_crawled_at' });

  return { pagesCol, versionsCol };
}

/**
 * Page store — persistent document storage and versioning for CrawlForge.
 *
 * Enforces:
 * 1. Idempotent storage and uniqueness on normalized URLs.
 * 2. Content hash tracking via SHA-256 to avoid spurious version increments.
 * 3. HTTP validator tracking (ETag, Last-Modified) and HTTP 304 handling without losing content.
 * 4. Separate collections for pages and page versions, avoiding unbounded document arrays.
 */

import { ObjectId, type Db, type Collection } from 'mongodb';
import { normalizeUrl } from '../utils/urlNormalizer.js';
import { computeContentHash } from '../utils/contentHash.js';
import {
  PageDoc,
  PageVersionDoc,
  initPageCollections,
} from './pageSchema.js';

export type PageSaveOutcome = 'created' | 'unchanged' | 'updated' | 'not_modified_304';

export interface SavePageInput {
  url: string;
  origin: string;
  title: string;
  textContent: string;
  outgoingLinks: string[];
  httpStatus: number;
  contentType: string;
  etag?: string;
  lastModified?: string;
  is304?: boolean;
}

export interface SavePageResult {
  outcome: PageSaveOutcome;
  pageId: ObjectId;
  url: string;
  version: number;
  isNewVersion: boolean;
  contentHash: string;
}

export class PageStore {
  private pagesCol!: Collection<PageDoc>;
  private versionsCol!: Collection<PageVersionDoc>;

  constructor(private readonly db: Db) {}

  async init(): Promise<void> {
    const { pagesCol, versionsCol } = await initPageCollections(this.db);
    this.pagesCol = pagesCol;
    this.versionsCol = versionsCol;
  }

  /**
   * Save a crawled page.
   * - If first crawl: inserts into `pages` (v1) and `page_versions` (v1).
   * - If 304 Not Modified: updates `lastCrawledAt` without altering content or creating a version.
   * - If 200 with unchanged content hash: updates `lastCrawledAt` and validators without creating a version.
   * - If 200 with changed content hash: updates `pages` with incremented version counter and inserts a new `page_versions` record.
   */
  async savePage(input: SavePageInput): Promise<SavePageResult> {
    const { normalized, valid } = normalizeUrl(input.url);
    if (!valid) {
      throw new Error(`Invalid URL for page storage: ${input.url}`);
    }

    const existing = await this.pagesCol.findOne({ url: normalized });
    const now = new Date();

    // Case 1: HTTP 304 Not Modified
    if (input.is304 || input.httpStatus === 304) {
      if (!existing) {
        throw new Error(`Received HTTP 304 for previously unseen URL: ${normalized}`);
      }

      const updateFields: Partial<PageDoc> = {
        lastCrawledAt: now,
        httpStatus: 304,
      };
      if (input.etag) updateFields.etag = input.etag;
      if (input.lastModified) updateFields.lastModified = input.lastModified;

      await this.pagesCol.updateOne({ _id: existing._id }, { $set: updateFields });

      return {
        outcome: 'not_modified_304',
        pageId: existing._id!,
        url: normalized,
        version: existing.version,
        isNewVersion: false,
        contentHash: existing.contentHash,
      };
    }

    // Case 2 & 3: Standard response (HTTP 200)
    const contentHash = computeContentHash(input.title, input.textContent);

    if (!existing) {
      // First-time crawl: create v1
      const pageId = new ObjectId();
      const newPageDoc: PageDoc = {
        _id: pageId,
        url: normalized,
        origin: input.origin,
        title: input.title,
        textContent: input.textContent,
        outgoingLinks: input.outgoingLinks,
        httpStatus: input.httpStatus,
        contentType: input.contentType,
        contentHash,
        ...(input.etag ? { etag: input.etag } : {}),
        ...(input.lastModified ? { lastModified: input.lastModified } : {}),
        version: 1,
        firstCrawledAt: now,
        lastCrawledAt: now,
        lastChangedAt: now,
      };

      await this.pagesCol.insertOne(newPageDoc);

      const initialVersionDoc: PageVersionDoc = {
        pageId,
        url: normalized,
        version: 1,
        title: input.title,
        textContent: input.textContent,
        contentHash,
        httpStatus: input.httpStatus,
        crawledAt: now,
      };

      await this.versionsCol.insertOne(initialVersionDoc);

      return {
        outcome: 'created',
        pageId,
        url: normalized,
        version: 1,
        isNewVersion: true,
        contentHash,
      };
    }

    // Existing page: check if extracted content has changed
    if (existing.contentHash === contentHash) {
      // Content hash is identical: no new version created
      const updateFields: Partial<PageDoc> = {
        lastCrawledAt: now,
        httpStatus: input.httpStatus,
        outgoingLinks: input.outgoingLinks,
        contentType: input.contentType,
      };
      if (input.etag) updateFields.etag = input.etag;
      if (input.lastModified) updateFields.lastModified = input.lastModified;

      await this.pagesCol.updateOne({ _id: existing._id }, { $set: updateFields });

      return {
        outcome: 'unchanged',
        pageId: existing._id!,
        url: normalized,
        version: existing.version,
        isNewVersion: false,
        contentHash,
      };
    }

    // Content hash differs: create next version (v2, v3, ...)
    const nextVersion = existing.version + 1;

    await this.pagesCol.updateOne(
      { _id: existing._id },
      {
        $set: {
          title: input.title,
          textContent: input.textContent,
          outgoingLinks: input.outgoingLinks,
          httpStatus: input.httpStatus,
          contentType: input.contentType,
          contentHash,
          etag: input.etag,
          lastModified: input.lastModified,
          version: nextVersion,
          lastCrawledAt: now,
          lastChangedAt: now,
        },
      },
    );

    const newVersionDoc: PageVersionDoc = {
      pageId: existing._id!,
      url: normalized,
      version: nextVersion,
      title: input.title,
      textContent: input.textContent,
      contentHash,
      httpStatus: input.httpStatus,
      crawledAt: now,
    };

    await this.versionsCol.insertOne(newVersionDoc);

    return {
      outcome: 'updated',
      pageId: existing._id!,
      url: normalized,
      version: nextVersion,
      isNewVersion: true,
      contentHash,
    };
  }

  /**
   * Retrieve the current page record by normalized URL.
   */
  async getPage(rawUrl: string): Promise<PageDoc | null> {
    const { normalized, valid } = normalizeUrl(rawUrl);
    if (!valid) return null;
    return this.pagesCol.findOne({ url: normalized });
  }

  /**
   * Retrieve the current page record by MongoDB ObjectId.
   */
  async getPageById(id: ObjectId | string): Promise<PageDoc | null> {
    const objId = typeof id === 'string' ? new ObjectId(id) : id;
    return this.pagesCol.findOne({ _id: objId });
  }

  /**
   * Retrieve all historical versions for a URL, sorted from latest to earliest.
   */
  async getVersions(rawUrl: string): Promise<PageVersionDoc[]> {
    const { normalized, valid } = normalizeUrl(rawUrl);
    if (!valid) return [];
    return this.versionsCol.find({ url: normalized }).sort({ version: -1 }).toArray();
  }

  /**
   * Retrieve a specific version number of a page.
   */
  async getVersion(rawUrl: string, version: number): Promise<PageVersionDoc | null> {
    const { normalized, valid } = normalizeUrl(rawUrl);
    if (!valid) return null;
    return this.versionsCol.findOne({ url: normalized, version });
  }

  /**
   * Get total number of distinct stored pages, optionally filtered by origin.
   */
  async getPageCount(origin?: string): Promise<number> {
    const filter = origin ? { origin } : {};
    return this.pagesCol.countDocuments(filter);
  }

  /**
   * Get total number of stored version documents.
   */
  async getVersionCount(rawUrl?: string): Promise<number> {
    if (rawUrl) {
      const { normalized, valid } = normalizeUrl(rawUrl);
      if (!valid) return 0;
      return this.versionsCol.countDocuments({ url: normalized });
    }
    return this.versionsCol.countDocuments();
  }

  /**
   * Drop collections (for testing only).
   */
  async drop(): Promise<void> {
    await this.db.collection('pages').drop().catch(() => {});
    await this.db.collection('page_versions').drop().catch(() => {});
  }
}

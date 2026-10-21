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

export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();

  /**
   * Run a task exclusively for a specific key.
   * Tasks for the same key are executed sequentially in strict FIFO order.
   * Tasks for different keys proceed concurrently.
   */
  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const currentTail = this.chains.get(key) ?? Promise.resolve();

    const taskPromise = currentTail.then(
      () => task(),
      () => task(), // run even if previous task rejected
    );

    const nextTail = taskPromise.then(
      () => {},
      () => {},
    );

    this.chains.set(key, nextTail);

    nextTail.then(() => {
      if (this.chains.get(key) === nextTail) {
        this.chains.delete(key);
      }
    });

    return taskPromise;
  }
}

export class PageStore {
  private pagesCol!: Collection<PageDoc>;
  private versionsCol!: Collection<PageVersionDoc>;
  private mutex = new KeyedMutex();

  constructor(private readonly db: Db) {}

  async init(): Promise<void> {
    const { pagesCol, versionsCol } = await initPageCollections(this.db);
    this.pagesCol = pagesCol;
    this.versionsCol = versionsCol;
  }

  /**
   * Save a crawled page.
   * - Serialized per normalized URL via KeyedMutex to prevent in-process race conditions.
   * - Uses optimistic concurrency control and duplicate key handling for cross-process safety.
   * - If first crawl: inserts into `pages` (v1) and `page_versions` (v1).
   * - If 304 Not Modified: updates `lastCrawledAt` without altering content or creating a version.
   * - If 200 with unchanged content hash: updates `lastCrawledAt` and validators without creating a version.
   * - If 200 with changed content hash: updates `pages` with incremented version counter and inserts a new `page_versions` record.
   * - Properly unsets validators (ETag/Last-Modified) if a server drops them on 200 responses.
   */
  async savePage(input: SavePageInput): Promise<SavePageResult> {
    const { normalized, valid } = normalizeUrl(input.url);
    if (!valid) {
      throw new Error(`Invalid URL for page storage: ${input.url}`);
    }

    return this.mutex.runExclusive(normalized, () =>
      this._savePageInternal(normalized, input),
    );
  }

  private async _savePageInternal(
    normalized: string,
    input: SavePageInput,
    attempt = 1,
  ): Promise<SavePageResult> {
    const MAX_SAVE_ATTEMPTS = 3;
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
      // RFC 7232: 304 confirms cached validators remain valid unless updated by response
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

      try {
        await this.pagesCol.insertOne(newPageDoc);
      } catch (err: unknown) {
        if (isDuplicateKeyError(err) && attempt < MAX_SAVE_ATTEMPTS) {
          return this._savePageInternal(normalized, input, attempt + 1);
        }
        throw err;
      }

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

      try {
        await this.versionsCol.insertOne(initialVersionDoc);
      } catch (err: unknown) {
        if (isDuplicateKeyError(err)) {
          // Verify that existing history record matches intended version and content
          const existingHistory = await this.versionsCol.findOne({
            url: normalized,
            version: 1,
          });
          if (existingHistory && existingHistory.contentHash === contentHash) {
            return {
              outcome: 'created',
              pageId,
              url: normalized,
              version: 1,
              isNewVersion: true,
              contentHash,
            };
          }
          // Content mismatch on duplicate key: rollback inserted page and throw
          await this.pagesCol.deleteOne({ _id: pageId, version: 1 }).catch(() => {});
          throw new Error(
            `Version conflict: page_versions already contains version 1 for ${normalized} with different content`,
          );
        }

        // Non-duplicate error: rollback inserted page and rethrow
        await this.pagesCol.deleteOne({ _id: pageId, version: 1 }).catch(() => {});
        throw err;
      }

      return {
        outcome: 'created',
        pageId,
        url: normalized,
        version: 1,
        isNewVersion: true,
        contentHash,
      };
    }

    // Existing page: handle validator updates / unsets
    const setFields: Record<string, unknown> = {
      lastCrawledAt: now,
      httpStatus: input.httpStatus,
      outgoingLinks: input.outgoingLinks,
      contentType: input.contentType,
    };
    const unsetFields: Record<string, string> = {};

    if (input.etag) {
      setFields.etag = input.etag;
    } else if (existing.etag) {
      unsetFields.etag = '';
    }

    if (input.lastModified) {
      setFields.lastModified = input.lastModified;
    } else if (existing.lastModified) {
      unsetFields.lastModified = '';
    }

    // Existing page: check if extracted content has changed
    if (existing.contentHash === contentHash) {
      // Content hash is identical: no new version created
      const updateDoc: Record<string, unknown> = { $set: setFields };
      if (Object.keys(unsetFields).length > 0) {
        updateDoc.$unset = unsetFields;
      }

      await this.pagesCol.updateOne({ _id: existing._id }, updateDoc);

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

    setFields.title = input.title;
    setFields.textContent = input.textContent;
    setFields.contentHash = contentHash;
    setFields.version = nextVersion;
    setFields.lastChangedAt = now;

    const updateDoc: Record<string, unknown> = { $set: setFields };
    if (Object.keys(unsetFields).length > 0) {
      updateDoc.$unset = unsetFields;
    }

    // Optimistic concurrency control: atomically match version
    const updateResult = await this.pagesCol.findOneAndUpdate(
      { _id: existing._id, version: existing.version },
      updateDoc,
      { returnDocument: 'after' },
    );

    if (!updateResult) {
      // Concurrent write updated the document version first; retry
      if (attempt < MAX_SAVE_ATTEMPTS) {
        return this._savePageInternal(normalized, input, attempt + 1);
      }
      throw new Error(`Concurrent modification conflict updating URL: ${normalized}`);
    }

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

    try {
      await this.versionsCol.insertOne(newVersionDoc);
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        // Verify that existing history record matches intended version and content
        const existingHistory = await this.versionsCol.findOne({
          url: normalized,
          version: nextVersion,
        });
        if (existingHistory && existingHistory.contentHash === contentHash) {
          return {
            outcome: 'updated',
            pageId: existing._id!,
            url: normalized,
            version: nextVersion,
            isNewVersion: true,
            contentHash,
          };
        }
        // Content mismatch on duplicate key: rollback pages document to previous state
        await this.pagesCol.replaceOne(
          { _id: existing._id, version: nextVersion },
          existing,
        ).catch(() => {});
        throw new Error(
          `Version conflict: page_versions already contains version ${nextVersion} for ${normalized} with different content`,
        );
      }

      // Non-duplicate error: rollback pages document to previous state and rethrow
      await this.pagesCol.replaceOne(
        { _id: existing._id, version: nextVersion },
        existing,
      ).catch(() => {});
      throw err;
    }

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

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: number }).code === 11000
  );
}

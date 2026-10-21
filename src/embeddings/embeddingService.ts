/**
 * Embedding Service — Manages generation, storage, validity, and status of page embeddings.
 *
 * Responsibilities:
 * - Content-hash validation: Stale embeddings (where page content changed) are excluded.
 * - Idempotency: Unchanged content is not re-embedded unless forced.
 * - Persistent storage in dedicated `page_embeddings` collection.
 * - Controlled batch backfilling for stored pages.
 * - Extraction of valid non-stale candidate vectors for semantic similarity search.
 */

import type { Db, Collection } from 'mongodb';
import { normalizeUrl } from '../utils/urlNormalizer.js';
import {
  PageEmbeddingDoc,
  PAGE_EMBEDDINGS_COLLECTION,
  initEmbeddingCollections,
} from './embeddingSchema.js';
import type { EmbeddingProvider, EmbeddingStatus, EmbeddingBackfillResult } from './types.js';
import { PageDoc, PAGES_COLLECTION } from '../db/pageSchema.js';
import { INDEXED_PAGES_COLLECTION, IndexedPageDoc } from '../search/indexSchema.js';

export interface ValidCandidateEmbedding {
  url: string;
  vector: number[];
  title: string;
  snippetText: string;
  contentHash: string;
}

export class EmbeddingService {
  private embeddingsCol!: Collection<PageEmbeddingDoc>;
  private pagesCol: Collection<PageDoc>;
  private indexedPagesCol: Collection<IndexedPageDoc>;

  constructor(
    private readonly db: Db,
    public provider: EmbeddingProvider,
  ) {
    this.pagesCol = this.db.collection<PageDoc>(PAGES_COLLECTION);
    this.indexedPagesCol = this.db.collection<IndexedPageDoc>(INDEXED_PAGES_COLLECTION);
  }

  async init(): Promise<void> {
    const { embeddingsCol } = await initEmbeddingCollections(this.db);
    this.embeddingsCol = embeddingsCol;
  }

  /**
   * Prepare text for embedding from page title and body content.
   * Limits text length to prevent memory exhaustion and model context overflow.
   */
  prepareText(title: string | undefined, textContent: string | undefined, maxChars = 1000): string {
    const cleanTitle = (title ?? '').trim();
    const cleanBody = (textContent ?? '').replace(/\s+/g, ' ').trim();
    const combined = cleanTitle ? `${cleanTitle}. ${cleanBody}` : cleanBody;
    return combined.slice(0, maxChars).trim();
  }

  /**
   * Generate and persist an embedding for a page.
   * Idempotent: Skips if embedding for the current contentHash and provider already exists.
   */
  async generateEmbedding(
    page: PageDoc,
    options: { force?: boolean } = {},
  ): Promise<{ outcome: 'generated' | 'unchanged'; url: string }> {
    const { normalized, valid } = normalizeUrl(page.url);
    if (!valid) {
      throw new Error(`Invalid URL for embedding generation: ${page.url}`);
    }

    const force = options.force ?? false;
    const existing = await this.embeddingsCol.findOne({ url: normalized });

    if (!force && existing && existing.contentHash === page.contentHash && existing.provider === this.provider.name) {
      return { outcome: 'unchanged', url: normalized };
    }

    const text = this.prepareText(page.title, page.textContent);
    const vector = await this.provider.embedText(text);

    const now = new Date();
    await this.embeddingsCol.updateOne(
      { url: normalized },
      {
        $set: {
          url: normalized,
          contentHash: page.contentHash,
          provider: this.provider.name,
          dimensions: vector.length,
          vector,
          textLength: text.length,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true },
    );

    return { outcome: 'generated', url: normalized };
  }

  /**
   * Generate an embedding for a page by its URL.
   */
  async generateEmbeddingForUrl(
    rawUrl: string,
    options: { force?: boolean } = {},
  ): Promise<{ outcome: 'generated' | 'unchanged' | 'not_found'; url: string }> {
    const { normalized, valid } = normalizeUrl(rawUrl);
    if (!valid) {
      throw new Error(`Invalid URL for embedding generation: ${rawUrl}`);
    }

    const page = await this.pagesCol.findOne({ url: normalized });
    if (!page) {
      return { outcome: 'not_found', url: normalized };
    }

    const result = await this.generateEmbedding(page, options);
    return { outcome: result.outcome, url: normalized };
  }

  /**
   * Backfill embeddings for all stored pages.
   */
  async backfill(options: { force?: boolean } = {}): Promise<EmbeddingBackfillResult> {
    const cursor = this.pagesCol.find({});
    let total = 0;
    let generated = 0;
    let unchanged = 0;
    let errors = 0;

    for await (const page of cursor) {
      total++;
      try {
        const result = await this.generateEmbedding(page, options);
        if (result.outcome === 'generated') {
          generated++;
        } else {
          unchanged++;
        }
      } catch (err) {
        console.error(`Failed to generate embedding for page ${page.url}:`, err);
        errors++;
      }
    }

    return { total, generated, unchanged, errors };
  }

  /**
   * Retrieve valid candidate embeddings whose contentHash matches the current page version.
   * Excludes stale embeddings and deleted pages.
   */
  async getValidCandidateEmbeddings(): Promise<ValidCandidateEmbedding[]> {
    // Join page_embeddings with indexed_pages (or pages fallback) to verify contentHash match
    const pipeline: import('mongodb').Document[] = [
      {
        $lookup: {
          from: PAGES_COLLECTION,
          localField: 'url',
          foreignField: 'url',
          as: 'pageDoc',
        },
      },
      { $unwind: '$pageDoc' },
      // Exclude stale embeddings where current page contentHash has drifted
      {
        $match: {
          $expr: { $eq: ['$contentHash', '$pageDoc.contentHash'] },
        },
      },
      {
        $project: {
          _id: 0,
          url: 1,
          vector: 1,
          title: '$pageDoc.title',
          snippetText: '$pageDoc.textContent',
          contentHash: 1,
        },
      },
    ];

    const results = await this.embeddingsCol.aggregate<ValidCandidateEmbedding>(pipeline).toArray();
    return results;
  }

  /**
   * Report detailed status of embeddings and synchronization.
   */
  async getStatus(): Promise<EmbeddingStatus> {
    const available = await this.provider.isAvailable();
    const totalPages = await this.pagesCol.countDocuments();
    const totalEmbeddings = await this.embeddingsCol.countDocuments();

    // Count valid embeddings matching current page contentHash
    const validCandidates = await this.getValidCandidateEmbeddings();
    const validEmbeddings = validCandidates.length;
    const staleEmbeddings = Math.max(0, totalEmbeddings - validEmbeddings);
    const missingEmbeddings = Math.max(0, totalPages - validEmbeddings);

    return {
      provider: {
        name: this.provider.name,
        available,
        dimensions: this.provider.dimensions,
      },
      counts: {
        totalPages,
        totalEmbeddings,
        validEmbeddings,
        staleEmbeddings,
        missingEmbeddings,
      },
    };
  }

  /**
   * Drop embedding collection (for tests only).
   */
  async drop(): Promise<void> {
    await this.db.collection(PAGE_EMBEDDINGS_COLLECTION).drop().catch(() => {});
  }
}

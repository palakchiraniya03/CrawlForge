/**
 * Search Indexer — builds and synchronizes the inverted index from stored pages.
 *
 * Enforces:
 * 1. Consistent tokenization and stop-word filtering.
 * 2. Idempotent indexing: unchanged content (matching contentHash) is skipped.
 * 3. Complete purging of obsolete terms when page content changes.
 * 4. Tracking of term frequencies and document lengths for BM25 calculation.
 * 5. Standalone operation decoupled from the crawling pipeline.
 */

import type { Db, Collection } from 'mongodb';
import { normalizeUrl } from '../utils/urlNormalizer.js';
import { KeyedMutex } from '../db/pageStore.js';
import { tokenize, computeTermFrequencies } from './tokenizer.js';
import {
  InvertedIndexDoc,
  IndexedPageDoc,
  initSearchCollections,
} from './indexSchema.js';
import { PageDoc, PAGES_COLLECTION } from '../db/pageSchema.js';

export type IndexOutcome = 'indexed' | 'unchanged' | 'not_found';

export interface IndexPageResult {
  outcome: IndexOutcome;
  url: string;
  termsCount: number;
  docLength: number;
}

export interface IndexAllResult {
  total: number;
  indexed: number;
  unchanged: number;
  errors: number;
}

export interface IndexStats {
  totalDocs: number;
  totalPostings: number;
  avgDocLength: number;
}

export interface IndexOptions {
  force?: boolean;
  titleBoost?: number;
  stopWords?: Set<string>;
}

export class SearchIndexer {
  private invertedIndexCol!: Collection<InvertedIndexDoc>;
  private indexedPagesCol!: Collection<IndexedPageDoc>;
  private pagesCol: Collection<PageDoc>;
  private mutex = new KeyedMutex();

  constructor(private readonly db: Db) {
    this.pagesCol = this.db.collection<PageDoc>(PAGES_COLLECTION);
  }

  async init(): Promise<void> {
    const { invertedIndexCol, indexedPagesCol } = await initSearchCollections(this.db);
    this.invertedIndexCol = invertedIndexCol;
    this.indexedPagesCol = indexedPagesCol;
  }

  /**
   * Index a page from its PageDoc representation.
   * Serialized per URL via KeyedMutex to prevent in-process race conditions.
   *
   * Failure Safety:
   * If insertion into inverted_index or updating indexed_pages fails, any partially
   * written postings and manifest records are purged. This guarantees that a failed
   * index operation does not leave inconsistent or phantom postings in the index, and
   * ensures subsequent indexAll() or indexPage() calls treat the document as unindexed
   * and rebuild it cleanly.
   *
   * Ranking Trade-off (Title Boost & Document Length):
   * `docLength` measures the true physical token count of the document (|D| = titleTokens + textTokens),
   * while `titleBoost` increases the term frequency f(q, D) for title occurrences (default: 2x).
   * This ensures that title matches receive higher relevance scoring without artificially inflating
   * the document length penalty in the BM25 denominator.
   */
  async indexPage(page: PageDoc, options: IndexOptions = {}): Promise<IndexPageResult> {
    const { normalized, valid } = normalizeUrl(page.url);
    if (!valid) {
      throw new Error(`Invalid URL for indexing: ${page.url}`);
    }

    return this.mutex.runExclusive(normalized, () =>
      this._indexPageInternal(normalized, page, options),
    );
  }

  private async _indexPageInternal(
    normalized: string,
    page: PageDoc,
    options: IndexOptions,
  ): Promise<IndexPageResult> {
    const titleBoost = options.titleBoost ?? 2;
    const force = options.force ?? false;

    // Check if page is already indexed and unchanged
    const existing = await this.indexedPagesCol.findOne({ url: normalized });
    if (!force && existing && existing.contentHash === page.contentHash) {
      return {
        outcome: 'unchanged',
        url: normalized,
        termsCount: existing.distinctTerms,
        docLength: existing.docLength,
      };
    }

    // Tokenize title and text content
    const titleTokens = tokenize(page.title, { stopWords: options.stopWords });
    const textTokens = tokenize(page.textContent, { stopWords: options.stopWords });

    // Document length: true physical token count (|D|)
    const totalTokensCount = titleTokens.length + textTokens.length;
    const docLength = Math.max(1, totalTokensCount);

    // Compute term frequencies with title boost
    const tfMap = new Map<string, number>();

    // Title terms (boosted)
    for (const token of titleTokens) {
      tfMap.set(token, (tfMap.get(token) ?? 0) + titleBoost);
    }

    // Body terms
    for (const token of textTokens) {
      tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
    }

    // Prepare postings documents
    const postings: InvertedIndexDoc[] = Array.from(tfMap.entries()).map(([term, tf]) => ({
      term,
      url: normalized,
      termFrequency: tf,
      docLength,
    }));

    const snippetText = page.textContent ? page.textContent.slice(0, 500) : page.title;

    try {
      // Step 1: Purge any previous postings for this URL to eliminate obsolete terms
      await this.invertedIndexCol.deleteMany({ url: normalized });

      // Step 2: Insert replacement postings
      if (postings.length > 0) {
        await this.invertedIndexCol.insertMany(postings, { ordered: false });
      }

      // Step 3: Upsert the page manifest in indexed_pages
      await this.indexedPagesCol.updateOne(
        { url: normalized },
        {
          $set: {
            url: normalized,
            contentHash: page.contentHash,
            title: page.title,
            docLength,
            distinctTerms: postings.length,
            snippetText,
            indexedAt: new Date(),
            version: page.version,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      // Compensating recovery on failure:
      // In standalone MongoDB, clean up partial state to ensure no dangling postings
      // or out-of-sync manifest entries remain.
      await this.invertedIndexCol.deleteMany({ url: normalized }).catch(() => {});
      await this.indexedPagesCol.deleteOne({ url: normalized }).catch(() => {});
      throw err;
    }

    return {
      outcome: 'indexed',
      url: normalized,
      termsCount: postings.length,
      docLength,
    };
  }

  /**
   * Index a page by its URL, fetching its stored representation from MongoDB.
   */
  async indexPageByUrl(rawUrl: string, options: IndexOptions = {}): Promise<IndexPageResult> {
    const { normalized, valid } = normalizeUrl(rawUrl);
    if (!valid) {
      throw new Error(`Invalid URL for indexing: ${rawUrl}`);
    }

    const page = await this.pagesCol.findOne({ url: normalized });
    if (!page) {
      return {
        outcome: 'not_found',
        url: normalized,
        termsCount: 0,
        docLength: 0,
      };
    }

    return this.indexPage(page, options);
  }

  /**
   * Index all pages stored in the `pages` collection.
   * Processes all documents idempotently.
   */
  async indexAll(options: IndexOptions = {}): Promise<IndexAllResult> {
    const cursor = this.pagesCol.find({});
    let total = 0;
    let indexed = 0;
    let unchanged = 0;
    let errors = 0;

    for await (const page of cursor) {
      total++;
      try {
        const result = await this.indexPage(page, options);
        if (result.outcome === 'indexed') {
          indexed++;
        } else if (result.outcome === 'unchanged') {
          unchanged++;
        }
      } catch (err) {
        console.error(`Failed to index page ${page.url}:`, err);
        errors++;
      }
    }

    return { total, indexed, unchanged, errors };
  }

  /**
   * Remove a page and all its postings from the search index.
   */
  async deletePageFromIndex(rawUrl: string): Promise<boolean> {
    const { normalized, valid } = normalizeUrl(rawUrl);
    if (!valid) return false;

    await this.invertedIndexCol.deleteMany({ url: normalized });
    const result = await this.indexedPagesCol.deleteOne({ url: normalized });
    return result.deletedCount > 0;
  }

  /**
   * Get global stats about the search index.
   */
  async getIndexStats(): Promise<IndexStats> {
    const totalDocs = await this.indexedPagesCol.countDocuments();
    const totalPostings = await this.invertedIndexCol.countDocuments();

    if (totalDocs === 0) {
      return { totalDocs: 0, totalPostings: 0, avgDocLength: 0 };
    }

    const pipeline = [
      {
        $group: {
          _id: null,
          totalLength: { $sum: '$docLength' },
        },
      },
    ];

    const aggResult = await this.indexedPagesCol.aggregate<{ totalLength: number }>(pipeline).toArray();
    const totalLength = aggResult[0]?.totalLength ?? 0;
    const avgDocLength = totalLength / totalDocs;

    return {
      totalDocs,
      totalPostings,
      avgDocLength: parseFloat(avgDocLength.toFixed(2)),
    };
  }

  /**
   * Drop search collections (for tests only).
   */
  async drop(): Promise<void> {
    await this.db.collection('inverted_index').drop().catch(() => {});
    await this.db.collection('indexed_pages').drop().catch(() => {});
  }
}

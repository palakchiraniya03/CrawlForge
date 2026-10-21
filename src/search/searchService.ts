/**
 * BM25 Search Service — Lexical search and document ranking for CrawlForge.
 *
 * Implements:
 * 1. Consistent query normalization & tokenization matching the indexer.
 * 2. Candidate retrieval via inverted index (avoiding full-table scans).
 * 3. BM25 Robertson-Spärck Jones ranking:
 *    - Term frequency saturation via k1 (default 1.2)
 *    - Document length normalization via b (default 0.75)
 *    - Non-negative IDF: ln(1 + (N - n(q) + 0.5) / (n(q) + 0.5))
 * 4. Graceful handling of stop-words, empty queries, and unknown terms.
 * 5. Validated pagination (limit, offset) and context snippet extraction.
 */

import type { Db, Collection } from 'mongodb';
import { tokenize, extractSnippet, DEFAULT_STOP_WORDS } from './tokenizer.js';
import {
  InvertedIndexDoc,
  IndexedPageDoc,
  INVERTED_INDEX_COLLECTION,
  INDEXED_PAGES_COLLECTION,
} from './indexSchema.js';
import { SearchIndexer } from './indexer.js';

export const DEFAULT_K1 = 1.2;
export const DEFAULT_B = 0.75;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;

export interface SearchOptions {
  limit?: number;
  offset?: number;
  k1?: number;
  b?: number;
  stopWords?: Set<string>;
}

export interface SearchHit {
  url: string;
  title: string;
  score: number;
  snippet: string;
}

export interface SearchResult {
  query: string;
  total: number;
  limit: number;
  offset: number;
  results: SearchHit[];
}

export class SearchService {
  private invertedIndexCol: Collection<InvertedIndexDoc>;
  private indexedPagesCol: Collection<IndexedPageDoc>;

  constructor(
    private readonly db: Db,
    private readonly indexer: SearchIndexer,
  ) {
    this.invertedIndexCol = this.db.collection<InvertedIndexDoc>(INVERTED_INDEX_COLLECTION);
    this.indexedPagesCol = this.db.collection<IndexedPageDoc>(INDEXED_PAGES_COLLECTION);
  }

  /**
   * Search indexed documents using BM25 ranking.
   */
  async search(rawQuery: string, options: SearchOptions = {}): Promise<SearchResult> {
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, options.offset ?? 0);
    const k1 = options.k1 ?? DEFAULT_K1;
    const b = options.b ?? DEFAULT_B;
    const stopWords = options.stopWords ?? DEFAULT_STOP_WORDS;

    // Normalize and tokenize search query
    const queryTokens = tokenize(rawQuery, { stopWords });

    // Handle empty query or query containing only stop words
    if (queryTokens.length === 0) {
      return {
        query: rawQuery,
        total: 0,
        limit,
        offset,
        results: [],
      };
    }

    // Deduplicate query terms for IDF lookup
    const uniqueTerms = Array.from(new Set(queryTokens));

    // Get collection corpus statistics (N and avgdl)
    const stats = await this.indexer.getIndexStats();
    const N = stats.totalDocs;
    const avgdl = stats.avgDocLength;

    if (N === 0 || avgdl === 0) {
      return {
        query: rawQuery,
        total: 0,
        limit,
        offset,
        results: [],
      };
    }

    // Retrieve candidate postings from the inverted index
    const postings = await this.invertedIndexCol
      .find({ term: { $in: uniqueTerms } })
      .toArray();

    if (postings.length === 0) {
      return {
        query: rawQuery,
        total: 0,
        limit,
        offset,
        results: [],
      };
    }

    // Group postings by term to determine document frequency n(q)
    const termPostingsMap = new Map<string, InvertedIndexDoc[]>();
    for (const posting of postings) {
      const list = termPostingsMap.get(posting.term) ?? [];
      list.push(posting);
      termPostingsMap.set(posting.term, list);
    }

    // Accumulate BM25 score for each matching document
    const docScores = new Map<string, number>();

    for (const term of uniqueTerms) {
      const termPostings = termPostingsMap.get(term);
      if (!termPostings || termPostings.length === 0) continue;

      const n_q = termPostings.length;
      // Robertson-Spärck Jones IDF (strictly positive variant)
      const idf = Math.log(1 + (N - n_q + 0.5) / (n_q + 0.5));

      for (const posting of termPostings) {
        const tf = posting.termFrequency;
        const D = posting.docLength;

        // BM25 term score component
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (D / avgdl));
        const termScore = idf * (numerator / denominator);

        docScores.set(posting.url, (docScores.get(posting.url) ?? 0) + termScore);
      }
    }

    // Rank candidates by total BM25 score descending, with deterministic secondary sort on URL
    const rankedCandidates = Array.from(docScores.entries())
      .map(([url, score]) => ({ url, score: parseFloat(score.toFixed(4)) }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.url.localeCompare(b.url);
      });

    const total = rankedCandidates.length;

    // Apply pagination
    const paginated = rankedCandidates.slice(offset, offset + limit);

    if (paginated.length === 0) {
      return {
        query: rawQuery,
        total,
        limit,
        offset,
        results: [],
      };
    }

    // Fetch document metadata for the current page only
    const paginatedUrls = paginated.map(p => p.url);
    const docs = await this.indexedPagesCol
      .find({ url: { $in: paginatedUrls } })
      .toArray();

    const docMap = new Map<string, IndexedPageDoc>(docs.map(d => [d.url, d]));

    const results: SearchHit[] = paginated.map(item => {
      const doc = docMap.get(item.url);
      const title = doc?.title || item.url;
      const snippet = extractSnippet(doc?.snippetText, queryTokens);

      return {
        url: item.url,
        title,
        score: item.score,
        snippet,
      };
    });

    return {
      query: rawQuery,
      total,
      limit,
      offset,
      results,
    };
  }
}

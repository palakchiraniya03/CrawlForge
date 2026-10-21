/**
 * Search Service — Lexical (BM25), Semantic (Cosine Similarity), and Hybrid (RRF) Retrieval.
 *
 * Implements:
 * 1. Mode selection: 'lexical' | 'semantic' | 'hybrid' (default: 'lexical').
 * 2. Lexical search via BM25 Robertson-Spärck Jones ranking.
 * 3. Semantic search via vector embeddings and cosine similarity against non-stale documents.
 * 4. Hybrid retrieval via Reciprocal Rank Fusion (RRF) with URL deduplication.
 * 5. Deterministic tie-breaking on normalized URLs across all modes.
 * 6. Backward-compatible response shape with transparent mode and score metadata.
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
import { EmbeddingService } from '../embeddings/embeddingService.js';
import { cosineSimilarity } from '../embeddings/similarity.js';

export const DEFAULT_K1 = 1.2;
export const DEFAULT_B = 0.75;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;
export const DEFAULT_RRF_K = 60;

export type SearchMode = 'lexical' | 'semantic' | 'hybrid';

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  offset?: number;
  k1?: number;
  b?: number;
  stopWords?: Set<string>;
  rrfK?: number;
  weightLexical?: number;
  weightSemantic?: number;
}

export interface SearchHit {
  url: string;
  title: string;
  score: number;
  snippet: string;
  source?: 'lexical' | 'semantic' | 'both';
  lexicalScore?: number;
  semanticScore?: number;
  lexicalRank?: number;
  semanticRank?: number;
}

export interface SearchResult {
  query: string;
  mode: SearchMode;
  total: number;
  limit: number;
  offset: number;
  results: SearchHit[];
  warning?: string;
}

interface RankedCandidate {
  url: string;
  score: number;
  title?: string;
  snippetText?: string;
}

export class SearchService {
  private invertedIndexCol: Collection<InvertedIndexDoc>;
  private indexedPagesCol: Collection<IndexedPageDoc>;

  constructor(
    private readonly db: Db,
    private readonly indexer: SearchIndexer,
    private readonly embeddingService?: EmbeddingService,
  ) {
    this.invertedIndexCol = this.db.collection<InvertedIndexDoc>(INVERTED_INDEX_COLLECTION);
    this.indexedPagesCol = this.db.collection<IndexedPageDoc>(INDEXED_PAGES_COLLECTION);
  }

  /**
   * Main entry point for search execution across all modes.
   */
  async search(rawQuery: string, options: SearchOptions = {}): Promise<SearchResult> {
    const mode = options.mode ?? 'lexical';

    switch (mode) {
      case 'semantic':
        return this.searchSemantic(rawQuery, options);
      case 'hybrid':
        return this.searchHybrid(rawQuery, options);
      case 'lexical':
      default:
        return this.searchLexical(rawQuery, options);
    }
  }

  /**
   * Lexical search using BM25 ranking.
   */
  async searchLexical(rawQuery: string, options: SearchOptions = {}): Promise<SearchResult> {
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, options.offset ?? 0);
    const stopWords = options.stopWords ?? DEFAULT_STOP_WORDS;

    const queryTokens = tokenize(rawQuery, { stopWords });
    if (queryTokens.length === 0) {
      return { query: rawQuery, mode: 'lexical', total: 0, limit, offset, results: [] };
    }

    const ranked = await this.getLexicalCandidates(rawQuery, options);
    const total = ranked.length;
    const paginated = ranked.slice(offset, offset + limit);

    if (paginated.length === 0) {
      return { query: rawQuery, mode: 'lexical', total, limit, offset, results: [] };
    }

    const docMap = await this.fetchMetadataMap(paginated.map(p => p.url));
    const results: SearchHit[] = paginated.map(item => {
      const doc = docMap.get(item.url);
      const title = doc?.title || item.url;
      const snippet = extractSnippet(doc?.snippetText, queryTokens);
      return {
        url: item.url,
        title,
        score: item.score,
        snippet,
        source: 'lexical',
        lexicalScore: item.score,
      };
    });

    return { query: rawQuery, mode: 'lexical', total, limit, offset, results };
  }

  /**
   * Semantic search using vector cosine similarity.
   */
  async searchSemantic(rawQuery: string, options: SearchOptions = {}): Promise<SearchResult> {
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, options.offset ?? 0);
    const stopWords = options.stopWords ?? DEFAULT_STOP_WORDS;

    if (!rawQuery || !rawQuery.trim()) {
      return { query: rawQuery, mode: 'semantic', total: 0, limit, offset, results: [] };
    }

    if (!this.embeddingService) {
      throw new Error('Semantic search is unavailable: EmbeddingService is not configured.');
    }

    const available = await this.embeddingService.provider.isAvailable();
    if (!available) {
      throw new Error(`Semantic search is unavailable: embedding provider "${this.embeddingService.provider.name}" is not ready.`);
    }

    const ranked = await this.getSemanticCandidates(rawQuery, options);
    const total = ranked.length;
    const paginated = ranked.slice(offset, offset + limit);

    if (paginated.length === 0) {
      return { query: rawQuery, mode: 'semantic', total, limit, offset, results: [] };
    }

    const queryTokens = tokenize(rawQuery, { stopWords });
    const results: SearchHit[] = paginated.map(item => {
      const snippet = extractSnippet(item.snippetText, queryTokens);
      return {
        url: item.url,
        title: item.title || item.url,
        score: item.score,
        snippet,
        source: 'semantic',
        semanticScore: item.score,
      };
    });

    return { query: rawQuery, mode: 'semantic', total, limit, offset, results };
  }

  /**
   * Hybrid retrieval combining Lexical BM25 and Semantic Similarity via Reciprocal Rank Fusion (RRF).
   */
  async searchHybrid(rawQuery: string, options: SearchOptions = {}): Promise<SearchResult> {
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, options.offset ?? 0);
    const stopWords = options.stopWords ?? DEFAULT_STOP_WORDS;
    const queryTokens = tokenize(rawQuery, { stopWords });

    if (!rawQuery || !rawQuery.trim() || queryTokens.length === 0) {
      return { query: rawQuery, mode: 'hybrid', total: 0, limit, offset, results: [] };
    }

    // Check if semantic search is available; gracefully fall back to lexical if not
    const isSemanticAvailable = this.embeddingService ? await this.embeddingService.provider.isAvailable() : false;
    if (!this.embeddingService || !isSemanticAvailable) {
      const lexicalResult = await this.searchLexical(rawQuery, options);
      return {
        ...lexicalResult,
        mode: 'hybrid',
        warning: 'Semantic provider is unavailable; fell back to lexical BM25 retrieval.',
      };
    }

    const rrfK = options.rrfK ?? DEFAULT_RRF_K;
    const wLex = options.weightLexical ?? 1.0;
    const wSem = options.weightSemantic ?? 1.0;

    // Retrieve candidates from both systems
    const [lexicalCandidates, semanticCandidates] = await Promise.all([
      this.getLexicalCandidates(rawQuery, options),
      this.getSemanticCandidates(rawQuery, options),
    ]);

    // Reciprocal Rank Fusion Map: URL -> Fusion Info
    interface FusedEntry {
      url: string;
      rrfScore: number;
      title: string;
      snippetText: string;
      lexicalScore?: number;
      semanticScore?: number;
      lexicalRank?: number;
      semanticRank?: number;
    }

    const fusionMap = new Map<string, FusedEntry>();

    // 1. Process Lexical Candidates
    for (let i = 0; i < lexicalCandidates.length; i++) {
      const cand = lexicalCandidates[i];
      const rank = i + 1;
      const rrfContribution = wLex / (rrfK + rank);

      fusionMap.set(cand.url, {
        url: cand.url,
        rrfScore: rrfContribution,
        title: cand.title ?? cand.url,
        snippetText: cand.snippetText ?? '',
        lexicalScore: cand.score,
        lexicalRank: rank,
      });
    }

    // 2. Process Semantic Candidates
    for (let j = 0; j < semanticCandidates.length; j++) {
      const cand = semanticCandidates[j];
      const rank = j + 1;
      const rrfContribution = wSem / (rrfK + rank);

      const existing = fusionMap.get(cand.url);
      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.semanticScore = cand.score;
        existing.semanticRank = rank;
        if (!existing.snippetText && cand.snippetText) {
          existing.snippetText = cand.snippetText;
        }
      } else {
        fusionMap.set(cand.url, {
          url: cand.url,
          rrfScore: rrfContribution,
          title: cand.title ?? cand.url,
          snippetText: cand.snippetText ?? '',
          semanticScore: cand.score,
          semanticRank: rank,
        });
      }
    }

    // 3. Sort by fused RRF score descending, with deterministic secondary sort on URL
    const fusedList = Array.from(fusionMap.values()).sort((a, b) => {
      if (b.rrfScore !== a.rrfScore) {
        return b.rrfScore - a.rrfScore;
      }
      return a.url.localeCompare(b.url);
    });

    const total = fusedList.length;
    const paginated = fusedList.slice(offset, offset + limit);

    // Fetch any missing titles/snippets for documents that only came from semantic
    const missingMetadataUrls = paginated.filter(p => !p.title || !p.snippetText).map(p => p.url);
    const metaMap = missingMetadataUrls.length > 0 ? await this.fetchMetadataMap(missingMetadataUrls) : new Map();

    const results: SearchHit[] = paginated.map(item => {
      const meta = metaMap.get(item.url);
      const title = item.title || meta?.title || item.url;
      const snippetText = item.snippetText || meta?.snippetText || '';
      const snippet = extractSnippet(snippetText, queryTokens);

      let source: 'lexical' | 'semantic' | 'both' = 'both';
      if (item.lexicalRank !== undefined && item.semanticRank === undefined) {
        source = 'lexical';
      } else if (item.lexicalRank === undefined && item.semanticRank !== undefined) {
        source = 'semantic';
      }

      return {
        url: item.url,
        title,
        score: parseFloat(item.rrfScore.toFixed(6)),
        snippet,
        source,
        lexicalScore: item.lexicalScore,
        semanticScore: item.semanticScore,
        lexicalRank: item.lexicalRank,
        semanticRank: item.semanticRank,
      };
    });

    return { query: rawQuery, mode: 'hybrid', total, limit, offset, results };
  }

  /**
   * Internal candidate generation for BM25.
   */
  private async getLexicalCandidates(rawQuery: string, options: SearchOptions): Promise<RankedCandidate[]> {
    const k1 = options.k1 ?? DEFAULT_K1;
    const b = options.b ?? DEFAULT_B;
    const stopWords = options.stopWords ?? DEFAULT_STOP_WORDS;
    const queryTokens = tokenize(rawQuery, { stopWords });

    if (queryTokens.length === 0) return [];

    const uniqueTerms = Array.from(new Set(queryTokens));
    const stats = await this.indexer.getIndexStats();
    const N = stats.totalDocs;
    const avgdl = stats.avgDocLength;

    if (N === 0 || avgdl === 0) return [];

    const postings = await this.invertedIndexCol
      .find({ term: { $in: uniqueTerms } })
      .toArray();

    if (postings.length === 0) return [];

    const termPostingsMap = new Map<string, InvertedIndexDoc[]>();
    for (const posting of postings) {
      const list = termPostingsMap.get(posting.term) ?? [];
      list.push(posting);
      termPostingsMap.set(posting.term, list);
    }

    const docScores = new Map<string, number>();

    for (const term of uniqueTerms) {
      const termPostings = termPostingsMap.get(term);
      if (!termPostings || termPostings.length === 0) continue;

      const n_q = termPostings.length;
      const idf = Math.log(1 + (N - n_q + 0.5) / (n_q + 0.5));

      for (const posting of termPostings) {
        const tf = posting.termFrequency;
        const D = posting.docLength;
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (D / avgdl));
        const termScore = idf * (numerator / denominator);

        docScores.set(posting.url, (docScores.get(posting.url) ?? 0) + termScore);
      }
    }

    return Array.from(docScores.entries())
      .map(([url, score]) => ({ url, score: parseFloat(score.toFixed(4)) }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.url.localeCompare(b.url);
      });
  }

  /**
   * Internal candidate generation for Semantic Search.
   */
  private async getSemanticCandidates(rawQuery: string, _options: SearchOptions): Promise<RankedCandidate[]> {
    if (!this.embeddingService) return [];

    const queryVector = await this.embeddingService.provider.embedText(rawQuery.trim());
    const validCandidates = await this.embeddingService.getValidCandidateEmbeddings();

    if (validCandidates.length === 0) return [];

    return validCandidates
      .map(cand => ({
        url: cand.url,
        score: parseFloat(cosineSimilarity(queryVector, cand.vector).toFixed(4)),
        title: cand.title,
        snippetText: cand.snippetText,
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.url.localeCompare(b.url);
      });
  }

  private async fetchMetadataMap(urls: string[]): Promise<Map<string, IndexedPageDoc>> {
    if (urls.length === 0) return new Map();
    const docs = await this.indexedPagesCol.find({ url: { $in: urls } }).toArray();
    return new Map(docs.map(d => [d.url, d]));
  }
}

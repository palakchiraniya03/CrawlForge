/**
 * MongoDB schemas and indexes for the CrawlForge search index.
 *
 * Architecture:
 * - `inverted_index`: Postings list mapping `(term, url)` to term frequency and document length.
 *   Enforces uniqueness on `{ term, url }`.
 * - `indexed_pages`: Manifest of indexed documents, tracking contentHash, document length,
 *   and short snippet text for fast search snippet rendering without reading full page documents.
 */

import type { Db, Collection, ObjectId } from 'mongodb';

export const INVERTED_INDEX_COLLECTION = 'inverted_index';
export const INDEXED_PAGES_COLLECTION = 'indexed_pages';

export interface InvertedIndexDoc {
  _id?: ObjectId;
  term: string;              // Normalized term
  url: string;               // Normalized page URL
  termFrequency: number;     // tf: frequency of term in this document
  docLength: number;         // |D|: total token count in this document
}

export interface IndexedPageDoc {
  _id?: ObjectId;
  url: string;               // Normalized URL (unique)
  contentHash: string;       // Page content hash when indexed
  title: string;             // Page title
  docLength: number;         // Total tokens in page
  distinctTerms: number;     // Number of distinct terms indexed
  snippetText: string;       // First ~500 chars for fast snippet rendering
  indexedAt: Date;           // Timestamp when index was created / updated
  version: number;           // Page version number when indexed
}

export async function initSearchCollections(db: Db): Promise<{
  invertedIndexCol: Collection<InvertedIndexDoc>;
  indexedPagesCol: Collection<IndexedPageDoc>;
}> {
  const invertedIndexCol = db.collection<InvertedIndexDoc>(INVERTED_INDEX_COLLECTION);
  const indexedPagesCol = db.collection<IndexedPageDoc>(INDEXED_PAGES_COLLECTION);

  // Inverted index indexes:
  // 1. Term lookup for candidate retrieval
  await invertedIndexCol.createIndex({ term: 1 }, { name: 'inv_term' });

  // 2. URL lookup for purging obsolete terms on page re-index / delete
  await invertedIndexCol.createIndex({ url: 1 }, { name: 'inv_url' });

  // 3. Unique compound index to guarantee idempotent postings
  await invertedIndexCol.createIndex(
    { term: 1, url: 1 },
    { unique: true, name: 'inv_term_url_unique' },
  );

  // Indexed pages manifest indexes:
  // 1. Unique URL identity
  await indexedPagesCol.createIndex({ url: 1 }, { unique: true, name: 'idx_page_url_unique' });

  // 2. Content hash lookup for skipping unchanged documents
  await indexedPagesCol.createIndex({ contentHash: 1 }, { name: 'idx_page_content_hash' });

  return { invertedIndexCol, indexedPagesCol };
}

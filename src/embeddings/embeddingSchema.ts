import type { Db, Collection, ObjectId } from 'mongodb';

export const PAGE_EMBEDDINGS_COLLECTION = 'page_embeddings';

export interface PageEmbeddingDoc {
  _id?: ObjectId;
  url: string;               // Normalized URL (unique identity)
  contentHash: string;       // SHA-256 hash of page content when embedding was created
  provider: string;          // Identifier of provider used (e.g., 'test-fake', 'ollama')
  dimensions: number;        // Vector dimensions
  vector: number[];          // Floating point embedding vector
  textLength: number;        // Length of prepared text
  model?: string;            // Optional model name
  createdAt: Date;
  updatedAt: Date;
}

export async function initEmbeddingCollections(db: Db): Promise<{
  embeddingsCol: Collection<PageEmbeddingDoc>;
}> {
  const embeddingsCol = db.collection<PageEmbeddingDoc>(PAGE_EMBEDDINGS_COLLECTION);

  // Unique index on URL — exactly one active embedding document per URL
  await embeddingsCol.createIndex({ url: 1 }, { unique: true, name: 'embedding_url_unique' });

  // Index on contentHash for fast validity checking against latest page version
  await embeddingsCol.createIndex({ contentHash: 1 }, { name: 'embedding_content_hash' });

  // Index on provider for provider-specific queries or migrations
  await embeddingsCol.createIndex({ provider: 1 }, { name: 'embedding_provider' });

  return { embeddingsCol };
}

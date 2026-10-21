/**
 * Type definitions for CrawlForge embeddings and semantic search.
 */

export interface EmbeddingProvider {
  /** Identifier name of this provider (e.g., 'unconfigured', 'ollama', 'test-fake') */
  readonly name: string;

  /** Dimensionality of the output embedding vectors */
  readonly dimensions: number;

  /** Check if the provider is currently available and ready to generate embeddings */
  isAvailable(): Promise<boolean>;

  /** Generate an embedding vector for a single text input */
  embedText(text: string): Promise<number[]>;

  /** Generate embedding vectors for multiple texts (optional batch optimization) */
  embedBatch?(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingCounts {
  totalPages: number;
  totalEmbeddings: number;
  validEmbeddings: number;
  staleEmbeddings: number;
  missingEmbeddings: number;
}

export interface EmbeddingStatus {
  provider: {
    name: string;
    available: boolean;
    dimensions: number;
  };
  counts: EmbeddingCounts;
}

export interface EmbeddingBackfillResult {
  total: number;
  generated: number;
  unchanged: number;
  errors: number;
}

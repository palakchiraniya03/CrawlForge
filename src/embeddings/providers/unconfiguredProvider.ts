import type { EmbeddingProvider } from '../types.js';

export class UnconfiguredEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'unconfigured';
  readonly dimensions = 0;

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async embedText(_text: string): Promise<number[]> {
    throw new Error(
      'Semantic search is unavailable: no embedding provider is configured. Set EMBEDDING_PROVIDER in environment variables.',
    );
  }
}

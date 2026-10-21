import type { EmbeddingProvider } from './types.js';
import { UnconfiguredEmbeddingProvider } from './providers/unconfiguredProvider.js';
import { LocalHttpEmbeddingProvider } from './providers/localHttpProvider.js';
import { DeterministicFakeEmbeddingProvider } from './providers/fakeProvider.js';
import { config } from '../config/env.js';

export function createEmbeddingProvider(type?: string): EmbeddingProvider {
  const providerType = (type || config.embedding.provider || 'unconfigured').toLowerCase();

  switch (providerType) {
    case 'local-http':
    case 'ollama':
      return new LocalHttpEmbeddingProvider({
        endpoint: config.embedding.endpoint,
        model: config.embedding.model,
      });
    case 'fake':
    case 'test-fake':
      return new DeterministicFakeEmbeddingProvider();
    case 'unconfigured':
    case 'none':
    default:
      return new UnconfiguredEmbeddingProvider();
  }
}

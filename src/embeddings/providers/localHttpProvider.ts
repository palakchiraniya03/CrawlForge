import type { EmbeddingProvider } from '../types.js';

export interface LocalHttpProviderOptions {
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Provider that connects to a local embedding HTTP service (such as Ollama or LocalAI).
 *
 * Example Ollama endpoint: http://localhost:11434/api/embeddings
 * Body format: { model: 'all-minilm', prompt: '...' }
 */
export class LocalHttpEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local-http';
  readonly dimensions: number;
  private endpoint: string;
  private model: string;
  private timeoutMs: number;

  constructor(options: LocalHttpProviderOptions = {}) {
    this.endpoint = options.endpoint || process.env.EMBEDDING_ENDPOINT || 'http://localhost:11434/api/embeddings';
    this.model = options.model || process.env.EMBEDDING_MODEL || 'all-minilm';
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.dimensions = 384; // standard for all-minilm; dynamic on first fetch
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);

      // Lightweight test call
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: 'ping' }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      return res.ok;
    } catch {
      return false;
    }
  }

  async embedText(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`Local embedding provider request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`Local embedding provider HTTP error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { embedding?: number[]; data?: Array<{ embedding: number[] }> };
    const vector = data.embedding || data.data?.[0]?.embedding;

    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error('Local embedding provider returned invalid vector format');
    }

    return vector;
  }
}

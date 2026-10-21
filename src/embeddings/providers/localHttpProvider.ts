import type { EmbeddingProvider } from '../types.js';

export interface LocalHttpProviderOptions {
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  dimensions?: number;
}

/**
 * Validates that an object is a non-empty array consisting only of finite numbers.
 */
function isValidVector(v: unknown): v is number[] {
  if (!Array.isArray(v) || v.length === 0) {
    return false;
  }
  for (let i = 0; i < v.length; i++) {
    const val = v[i];
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      return false;
    }
  }
  return true;
}

/**
 * Provider that connects to a local embedding HTTP service (such as Ollama or LocalAI).
 *
 * Supported formats:
 * 1. Current Ollama /api/embed:
 *    POST http://localhost:11434/api/embed
 *    Body: { model: '...', input: '...' }
 *    Response: { model: '...', embeddings: [[...]] }
 *
 * 2. Legacy Ollama /api/embeddings:
 *    POST http://localhost:11434/api/embeddings
 *    Body: { model: '...', prompt: '...' }
 *    Response: { embedding: [...] }
 *
 * 3. OpenAI / LocalAI standard /v1/embeddings:
 *    POST http://localhost:8080/v1/embeddings
 *    Body: { model: '...', input: '...' }
 *    Response: { data: [{ embedding: [...] }] }
 */
export class LocalHttpEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local-http';
  private _dimensions: number;
  private endpoint: string;
  private model: string;
  private timeoutMs: number;

  constructor(options: LocalHttpProviderOptions = {}) {
    this.endpoint = options.endpoint || process.env.EMBEDDING_ENDPOINT || 'http://localhost:11434/api/embed';
    this.model = options.model || process.env.EMBEDDING_MODEL || 'nomic-embed-text:latest';
    this.timeoutMs = options.timeoutMs ?? (process.env.EMBEDDING_TIMEOUT_MS ? parseInt(process.env.EMBEDDING_TIMEOUT_MS, 10) : 5000);
    this._dimensions = options.dimensions ?? (process.env.EMBEDDING_DIMENSIONS ? parseInt(process.env.EMBEDDING_DIMENSIONS, 10) : 0);
  }

  get dimensions(): number {
    return this._dimensions;
  }

  /**
   * Determine whether this endpoint targets legacy Ollama /api/embeddings.
   */
  private isLegacyEmbeddingsEndpoint(): boolean {
    return this.endpoint.includes('/api/embeddings');
  }

  /**
   * Construct request payload compatible with the endpoint.
   */
  private buildRequestBody(text: string): Record<string, unknown> {
    if (this.isLegacyEmbeddingsEndpoint()) {
      return { model: this.model, prompt: text };
    }
    return { model: this.model, input: text };
  }

  /**
   * Extract a candidate embedding vector from various supported response formats.
   */
  private extractVector(data: unknown): number[] | null {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const obj = data as Record<string, unknown>;

    // 1. Ollama /api/embed format: { embeddings: number[][] | number[] }
    if (Array.isArray(obj.embeddings) && obj.embeddings.length > 0) {
      const first = obj.embeddings[0];
      if (Array.isArray(first)) {
        return first as number[];
      }
      if (typeof first === 'number') {
        return obj.embeddings as number[];
      }
    }

    // 2. Legacy Ollama /api/embeddings format: { embedding: number[] }
    if (Array.isArray(obj.embedding)) {
      return obj.embedding as number[];
    }

    // 3. OpenAI / LocalAI /v1/embeddings format: { data: [{ embedding: number[] }] }
    if (Array.isArray(obj.data) && obj.data.length > 0) {
      const item = obj.data[0] as Record<string, unknown> | undefined;
      if (item && Array.isArray(item.embedding)) {
        return item.embedding as number[];
      }
    }

    return null;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 2000));

      const payload = this.buildRequestBody('ping');
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (!res.ok) {
        return false;
      }

      const data = await res.json().catch(() => null);
      if (!data || typeof data !== 'object') {
        return false;
      }

      if ('error' in data && (data as any).error) {
        return false;
      }

      const vector = this.extractVector(data);
      if (vector && isValidVector(vector)) {
        if (this._dimensions === 0) {
          this._dimensions = vector.length;
        }
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  async embedText(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    const payload = this.buildRequestBody(text);

    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`Local embedding provider request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let errDetail = `${res.status} ${res.statusText}`;
      try {
        const errJson = (await res.json()) as { error?: string | { message?: string } };
        if (typeof errJson.error === 'string') {
          errDetail = `${errDetail}: ${errJson.error}`;
        } else if (errJson.error && typeof errJson.error === 'object' && typeof errJson.error.message === 'string') {
          errDetail = `${errDetail}: ${errJson.error.message}`;
        }
      } catch {}
      throw new Error(`Local embedding provider HTTP error: ${errDetail}`);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error(`Local embedding provider returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (data && typeof data === 'object' && 'error' in data && (data as Record<string, unknown>).error) {
      const errMsg = (data as Record<string, unknown>).error;
      throw new Error(`Local embedding provider error: ${typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)}`);
    }

    const vector = this.extractVector(data);
    if (!vector || !isValidVector(vector)) {
      throw new Error('Local embedding provider returned invalid vector: must be a non-empty array of finite numbers');
    }

    // Update dimensions dynamically to reflect the actual returned vector dimension
    this._dimensions = vector.length;

    return vector;
  }
}

import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  mongoUri: requireEnv('MONGODB_URI', 'mongodb://localhost:27017'),
  dbName: requireEnv('DB_NAME', 'crawlforge'),
  port: parseInt(requireEnv('PORT', '3000'), 10),
  logLevel: requireEnv('LOG_LEVEL', 'info'),
  crawl: {
    concurrency: parseInt(requireEnv('CRAWL_CONCURRENCY', '3'), 10),
    delayMs: parseInt(requireEnv('CRAWL_DELAY_MS', '500'), 10),
    timeoutMs: parseInt(requireEnv('CRAWL_TIMEOUT_MS', '10000'), 10),
    maxRetries: parseInt(requireEnv('CRAWL_MAX_RETRIES', '3'), 10),
    allowedDomains: requireEnv('ALLOWED_DOMAINS', 'localhost').split(',').map(d => d.trim()).filter(Boolean),
  },
  embedding: {
    provider: process.env.EMBEDDING_PROVIDER ?? 'unconfigured',
    endpoint: process.env.EMBEDDING_ENDPOINT ?? 'http://localhost:11434/api/embeddings',
    model: process.env.EMBEDDING_MODEL ?? 'all-minilm',
  },
} as const;

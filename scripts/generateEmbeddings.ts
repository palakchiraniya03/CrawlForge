/**
 * CLI script to generate or backfill embeddings for stored pages in CrawlForge.
 *
 * Usage:
 *   npx tsx scripts/generateEmbeddings.ts             # Backfill embeddings for pages needing them
 *   npx tsx scripts/generateEmbeddings.ts --force     # Re-generate embeddings for all pages
 *   npx tsx scripts/generateEmbeddings.ts --url <url> # Generate embedding for a specific page
 */

import { connectDb, disconnectDb } from '../src/db/client.js';
import { EmbeddingService } from '../src/embeddings/embeddingService.js';
import { createEmbeddingProvider } from '../src/embeddings/providerFactory.js';

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const urlIdx = args.indexOf('--url');
  const targetUrl = urlIdx !== -1 && args[urlIdx + 1] ? args[urlIdx + 1] : undefined;

  const db = await connectDb();
  const provider = createEmbeddingProvider();
  const service = new EmbeddingService(db, provider);
  await service.init();

  const available = await provider.isAvailable();
  if (!available) {
    console.error(`Error: Embedding provider "${provider.name}" is not available or not configured.`);
    console.error('Configure EMBEDDING_PROVIDER in environment variables (e.g. EMBEDDING_PROVIDER=local-http).');
    process.exit(1);
  }

  if (targetUrl) {
    console.log(`Generating embedding for: ${targetUrl} (force: ${force})`);
    const result = await service.generateEmbeddingForUrl(targetUrl, { force });
    console.log('Result:', result);
  } else {
    console.log(`Backfilling embeddings for all stored pages (force: ${force})...`);
    const result = await service.backfill({ force });
    console.log('Backfill summary:', result);
  }

  const status = await service.getStatus();
  console.log('Current embedding status:', status);

  await disconnectDb();
}

main().catch(err => {
  console.error('Embedding generation failed:', err);
  process.exit(1);
});

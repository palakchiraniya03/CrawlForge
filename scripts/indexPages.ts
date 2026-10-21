/**
 * CLI script to index or re-index stored pages into CrawlForge's inverted index.
 *
 * Usage:
 *   npx tsx scripts/indexPages.ts             # Index all unindexed / changed pages
 *   npx tsx scripts/indexPages.ts --force     # Reindex all pages
 *   npx tsx scripts/indexPages.ts --url <url> # Index a specific page
 */

import { connectDb, disconnectDb } from '../src/db/client.js';
import { SearchIndexer } from '../src/search/indexer.js';

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const urlIdx = args.indexOf('--url');
  const targetUrl = urlIdx !== -1 && args[urlIdx + 1] ? args[urlIdx + 1] : undefined;

  const db = await connectDb();
  const indexer = new SearchIndexer(db);
  await indexer.init();

  if (targetUrl) {
    console.log(`Indexing page: ${targetUrl} (force: ${force})`);
    const result = await indexer.indexPageByUrl(targetUrl, { force });
    console.log('Result:', result);
  } else {
    console.log(`Indexing all stored pages (force: ${force})...`);
    const result = await indexer.indexAll({ force });
    console.log('Indexing summary:', result);
  }

  const stats = await indexer.getIndexStats();
  console.log('Current index stats:', stats);

  await disconnectDb();
}

main().catch(err => {
  console.error('Indexing failed:', err);
  process.exit(1);
});

import { connectDb } from './db/client.js';
import { createApp } from './app.js';
import { config } from './config/env.js';
import { Frontier } from './frontier/frontier.js';
import { PageStore } from './db/pageStore.js';
import { SearchIndexer } from './search/indexer.js';

async function main() {
  const db = await connectDb();
  console.log('Connected to MongoDB');

  // Initialize collections and run startup recovery for abandoned jobs
  const frontier = new Frontier(db);
  await frontier.init();
  const pageStore = new PageStore(db);
  await pageStore.init();
  const searchIndexer = new SearchIndexer(db);
  await searchIndexer.init();

  const app = createApp(db);
  app.listen(config.port, () => {
    console.log(`CrawlForge server listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

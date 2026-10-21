import { connectDb } from './db/client.js';
import { createApp } from './app.js';
import { config } from './config/env.js';

async function main() {
  await connectDb();
  console.log('Connected to MongoDB');

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`CrawlForge server listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

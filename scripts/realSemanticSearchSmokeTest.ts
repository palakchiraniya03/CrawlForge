import { MongoClient } from 'mongodb';
import { EmbeddingService } from '../src/embeddings/embeddingService.js';
import { createEmbeddingProvider } from '../src/embeddings/providerFactory.js';
import { SearchIndexer } from '../src/search/indexer.js';
import { SearchService } from '../src/search/searchService.js';

const dbName = process.env.DB_NAME;

if (dbName !== 'crawlforge_real_embedding_test') {
  throw new Error(`Safety stop: unexpected database "${dbName}"`);
}

const client = new MongoClient(
  process.env.MONGODB_URI ?? 'mongodb://localhost:27017',
);

async function main() {
  await client.connect();

  try {
    const db = client.db(dbName);
    const provider = createEmbeddingProvider();
    const embeddings = new EmbeddingService(db, provider);

    await embeddings.init();

    const status = await embeddings.getStatus();

    if (
      status.counts.totalPages !== 3 ||
      status.counts.validEmbeddings !== 3 ||
      status.provider.dimensions !== 768
    ) {
      throw new Error(
        `Safety stop: unexpected test data or embedding status: ${JSON.stringify(status)}`,
      );
    }

    const indexer = new SearchIndexer(db);
    await indexer.init();

    const search = new SearchService(db, indexer, embeddings);

    const queries = [
      'How can farmers decide when crops need watering?',
      'How do I make bread using flour and yeast?',
      'How do routers send data between networks?',
    ];

    for (const query of queries) {
      const result = await search.search(query, {
        mode: 'hybrid',
        limit: 3,
      });

      console.log('\nQuery:', query);
      console.log(
        'Results:',
        result.results.map((item) => ({
          title: item.title,
          score: item.score,
          url: item.url,
        })),
      );

      const expectedUrls: Record<string, string> = {
        'How can farmers decide when crops need watering?':
          'https://test.crawlforge.invalid/farming',
        'How do I make bread using flour and yeast?':
          'https://test.crawlforge.invalid/cooking',
        'How do routers send data between networks?':
          'https://test.crawlforge.invalid/networks',
      };

      if (result.results[0]?.url !== expectedUrls[query]) {
        throw new Error(
          `Unexpected top result for "${query}". Expected "${expectedUrls[query]}", got "${result.results[0]?.url}"`,
        );
      }
    }

    console.log('\nPASS: real semantic queries returned results.');
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error('Semantic search test failed:', error);
  process.exitCode = 1;
});

import { MongoClient } from 'mongodb';
import { PageStore } from '../src/db/pageStore.js';
import { EmbeddingService } from '../src/embeddings/embeddingService.js';
import { createEmbeddingProvider } from '../src/embeddings/providerFactory.js';

const dbName = process.env.DB_NAME;
if (dbName !== 'crawlforge_real_embedding_test') {
  throw new Error(`Safety stop: expected isolated test DB, got "${dbName}"`);
}

const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');

async function main() {
  await client.connect();
  try {
    const db = client.db(dbName);
    const pageStore = new PageStore(db);
    await pageStore.init();

    const existing = await db.collection('pages').countDocuments();
    if (existing !== 0) {
      throw new Error(`Safety stop: expected an empty pages collection, found ${existing} documents.`);
    }

    const samples = [
      {
        url: 'https://test.crawlforge.invalid/farming',
        title: 'Smart Irrigation for Farmers',
        textContent: 'Soil moisture sensors help farmers decide when crops need water. Irrigation planning can use weather forecasts and soil conditions.',
      },
      {
        url: 'https://test.crawlforge.invalid/cooking',
        title: 'Baking Bread at Home',
        textContent: 'Bread baking uses flour, yeast, water, and salt. Kneading dough and controlling oven temperature affect the final loaf.',
      },
      {
        url: 'https://test.crawlforge.invalid/networks',
        title: 'Computer Networking Basics',
        textContent: 'Routers forward packets between networks. IP addresses identify network interfaces, and switches connect devices on a local network.',
      },
    ];

    for (const sample of samples) {
      await pageStore.savePage({
        ...sample,
        origin: 'https://test.crawlforge.invalid',
        outgoingLinks: [],
        httpStatus: 200,
        contentType: 'text/html',
      });
    }

    const provider = createEmbeddingProvider();
    console.log('Provider:', provider.name);
    console.log('Available:', await provider.isAvailable());

    const service = new EmbeddingService(db, provider);
    await service.init();

    const result = await service.backfill();
    console.log('Backfill:', result);

    const stored = await db.collection('page_embeddings')
      .find({}, { projection: { _id: 0, url: 1, provider: 1, dimensions: 1 } })
      .toArray();
    console.log('Stored embeddings:', stored);

    const status = await service.getStatus();
    console.log('Embedding status:', status);

    if (!status.provider.available || result.errors !== 0 ||
        result.generated !== samples.length ||
        status.counts.validEmbeddings !== samples.length ||
        stored.some(item => item.dimensions !== 768)) {
      throw new Error('Real embedding integration test failed validation.');
    }

    console.log('PASS: real Ollama embeddings generated and persisted in the isolated test database.');
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

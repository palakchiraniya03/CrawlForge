/**
 * Temporary, standalone end-to-end verification script for CrawlForge.
 *
 * Exercises the complete pipeline:
 * Local Fixture Server → CrawlerWorker → PageStore → SearchIndexer → SearchService
 *
 * Safety & Isolation Guarantees:
 * 1. Hard refusal if NODE_ENV === 'production'.
 * 2. Connects exclusively to dedicated test database `crawlforge_e2e_test`.
 *    Explicitly refuses to connect to or write to `crawlforge`.
 * 3. Does NOT automatically drop any database or collection.
 *    If `crawlforge_e2e_test` already contains data, stops with a clear warning.
 * 4. In-memory SSRF and allowed-domain overrides applied strictly after production guard.
 * 5. Scopes crawl exclusively to the local fixture server's ephemeral origin.
 * 6. Asserts that search results match a page actually crawled and stored during this run.
 * 7. Guaranteed cleanup of fixture server and MongoDB client via try/finally.
 */

// 1. Production safety guard — refuse execution immediately in production
if (process.env.NODE_ENV === 'production') {
  console.error('❌ SAFETY REFUSAL: e2eSmokeTest cannot be executed in production (NODE_ENV === "production").');
  process.exit(1);
}

// 2. In-memory test-only environment overrides (applied only after production guard)
process.env.SSRF_ALLOWED_HOSTS = 'localhost';
process.env.ALLOWED_DOMAINS = 'localhost';

import { MongoClient } from 'mongodb';
import { startFixtureServer, FixtureServer } from '../tests/fixtures/fixtureServer.js';
import { Frontier } from '../src/frontier/frontier.js';
import { PageStore } from '../src/db/pageStore.js';
import { CrawlerWorker } from '../src/crawler/worker.js';
import { SearchIndexer } from '../src/search/indexer.js';
import { SearchService } from '../src/search/searchService.js';
import { clearRobotsCache } from '../src/crawler/robotsCache.js';

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const TEST_DB_NAME = 'crawlforge_e2e_test';
const MAX_CRAWL_ITERATIONS = 20;

// Explicit safety check: reject connection if configured to primary/dev database
if (TEST_DB_NAME === 'crawlforge' || TEST_DB_NAME.toLowerCase().includes('prod')) {
  console.error(`❌ SAFETY REFUSAL: Target database "${TEST_DB_NAME}" is disallowed for smoke testing.`);
  process.exit(1);
}

async function runSmokeTest(): Promise<void> {
  console.log('====================================================');
  console.log('   CrawlForge End-to-End Pipeline Smoke Test        ');
  console.log('====================================================\n');

  let client: MongoClient | null = null;
  let fixture: FixtureServer | null = null;

  try {
    // 1. Connect to MongoDB and verify dedicated database isolation
    console.log(`[1/6] Connecting to MongoDB (${TEST_DB_NAME})...`);
    client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();

    const db = client.db(TEST_DB_NAME);

    // Hard assertion on database name
    if (db.databaseName !== TEST_DB_NAME || db.databaseName === 'crawlforge') {
      throw new Error(`SAFETY ERROR: Unexpected database name "${db.databaseName}". Expected "${TEST_DB_NAME}".`);
    }
    console.log(`      ✓ Connected to dedicated database: "${db.databaseName}" (dev db untouched)`);

    // 2. Check for pre-existing records across all pipeline collections — do NOT auto-drop; fail with nonzero exit if dirty
    const [
      existingFrontier,
      existingPages,
      existingVersions,
      existingInverted,
      existingIndexed,
    ] = await Promise.all([
      db.collection('frontier_urls').countDocuments(),
      db.collection('pages').countDocuments(),
      db.collection('page_versions').countDocuments(),
      db.collection('inverted_index').countDocuments(),
      db.collection('indexed_pages').countDocuments(),
    ]);

    const totalExisting =
      existingFrontier +
      existingPages +
      existingVersions +
      existingInverted +
      existingIndexed;

    if (totalExisting > 0) {
      console.error('\n❌ ERROR: Dedicated test database is not clean:');
      console.error(`   - frontier_urls: ${existingFrontier} document(s)`);
      console.error(`   - pages:         ${existingPages} document(s)`);
      console.error(`   - page_versions: ${existingVersions} document(s)`);
      console.error(`   - inverted_index: ${existingInverted} document(s)`);
      console.error(`   - indexed_pages: ${existingIndexed} document(s)`);
      console.error(`\nRefusing to run to avoid mixing previous data with this test run.`);
      console.error(`To run a clean smoke test, drop database "${TEST_DB_NAME}" first:`);
      console.error(`   mongosh --eval "db.getSiblingDB('${TEST_DB_NAME}').dropDatabase()"\n`);
      throw new Error(
        `Database "${TEST_DB_NAME}" already contains records (${totalExisting} total across pipeline collections). Halting smoke test.`,
      );
    }
    console.log(`      ✓ Verified database "${TEST_DB_NAME}" is clean across all collections (0 records)\n`);

    // 3. Start local HTTP fixture server
    console.log('[2/6] Starting local fixture HTTP server...');
    clearRobotsCache();
    fixture = await startFixtureServer();
    const fixtureOrigin = new URL(fixture.baseUrl).origin;
    console.log(`      ✓ Fixture server running at: ${fixture.baseUrl}`);
    console.log(`      ✓ Scoped crawl origin:       ${fixtureOrigin}\n`);

    // 4. Initialize Frontier, PageStore, and CrawlerWorker
    console.log('[3/6] Initializing Frontier and PageStore...');
    const frontier = new Frontier(db);
    await frontier.init();

    const pageStore = new PageStore(db);
    await pageStore.init();

    // Verify worker receives the PageStore and target origin
    const worker = new CrawlerWorker(frontier, pageStore, fixtureOrigin);

    // Seed the frontier with the fixture root URL only
    await frontier.addUrl(fixture.baseUrl, 0);
    console.log(`      ✓ Seeded root URL: ${fixture.baseUrl}`);

    // 5. Run the crawl loop
    console.log('[4/6] Executing crawl loop on in-scope pages...');
    let doneCount = 0;
    let robotsBlockedCount = 0;
    let otherCount = 0;
    const storedUrlsDuringThisRun = new Set<string>();

    for (let i = 0; i < MAX_CRAWL_ITERATIONS; i++) {
      // Enforce that only the fixture origin is claimed and processed
      const result = await worker.processNext(fixtureOrigin);
      if (!result) break; // Frontier has no more pending work

      if (result.status === 'done') {
        doneCount++;
        storedUrlsDuringThisRun.add(result.url);
        console.log(`      [done] ${result.url} (HTTP ${result.httpStatus}, v${result.version ?? 1})`);
      } else if (result.status === 'robots_blocked') {
        robotsBlockedCount++;
        console.log(`      [robots_blocked] ${result.url} (correctly blocked by robots.txt)`);
      } else {
        otherCount++;
        console.log(`      [${result.status}] ${result.url}`);
      }
    }

    const storedPageCount = await pageStore.getPageCount();
    console.log(`      ✓ Crawl finished: ${doneCount} pages stored, ${robotsBlockedCount} blocked by robots.txt, total in PageStore: ${storedPageCount}\n`);

    if (storedPageCount === 0 || storedUrlsDuringThisRun.size === 0) {
      throw new Error('Pipeline failed: no pages were persisted to PageStore during this run');
    }

    // 6. Index stored pages using SearchIndexer
    console.log('[5/6] Building inverted index with SearchIndexer...');
    const indexer = new SearchIndexer(db);
    await indexer.init();

    const indexSummary = await indexer.indexAll();
    const indexStats = await indexer.getIndexStats();
    console.log(`      ✓ Indexing complete: ${indexSummary.indexed} indexed, ${indexSummary.unchanged} unchanged`);
    console.log(`      ✓ Index stats: ${indexStats.totalDocs} docs, ${indexStats.totalPostings} postings, avg length: ${indexStats.avgDocLength} tokens\n`);

    // 7. Execute BM25 search queries with SearchService
    console.log('[6/6] Executing BM25 queries with SearchService...');
    const searchService = new SearchService(db, indexer);

    // Search for a word present in fixture Page A: "content"
    const query = 'content';
    console.log(`      Searching for query: "${query}"...`);
    const searchResult = await searchService.search(query, { limit: 5 });

    console.log(`      Found ${searchResult.total} matching result(s):`);
    for (const hit of searchResult.results) {
      console.log(`        - [score: ${hit.score}] "${hit.title}" (${hit.url})`);
      console.log(`          Snippet: "${hit.snippet}"`);
    }

    // Verify search assertion: at least one result must be a page crawled & stored during THIS run
    const matchingRunHit = searchResult.results.find(
      hit => storedUrlsDuringThisRun.has(hit.url) && hit.url.startsWith(fixtureOrigin),
    );

    if (!matchingRunHit) {
      throw new Error(
        `Pipeline assertion failed: no search result matched a page stored during this run (origin: ${fixtureOrigin})`,
      );
    }
    console.log(`      ✓ Verified match: "${matchingRunHit.title}" (${matchingRunHit.url}) was crawled and stored during this run.`);

    console.log('\n====================================================');
    console.log('   SMOKE TEST PASSED: Full Pipeline Verified!       ');
    console.log('====================================================');
    console.log(`Database "${TEST_DB_NAME}" preserved for inspection.`);
  } finally {
    // Guaranteed cleanup: close fixture server and MongoDB client
    if (fixture) {
      await fixture.stop();
      console.log('\n[cleanup] Local fixture server stopped.');
    }
    if (client) {
      await client.close();
      console.log('[cleanup] MongoDB connection closed.');
    }
  }
}

runSmokeTest().catch(err => {
  console.error('\n❌ Smoke test failed with error:', err);
  process.exit(1);
});

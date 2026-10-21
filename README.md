# CrawlForge

CrawlForge is a safe, production-grade web crawler, persistent document store, and hybrid search engine built with TypeScript, Node.js, and MongoDB.

---

## Architecture Overview

CrawlForge consists of five integrated milestones:

1. **Backend Foundation & URL Utilities**: Express server, robust MongoDB connection pooling, health checks, strict environment validation, and RFC 3986 URL normalization.
2. **Safe Crawler & URL Frontier**: Asynchronous BFS crawler worker, queue leases, lease expiration recovery, polite domain delay, robots.txt compliance, and rigorous SSRF protection (DNS resolution, private IP blocking, loopback prevention).
3. **Persistent Page Storage & Versioning**: Content-hashed document store (`pages` and `page_versions`), conditional HTTP requests (`ETag` / `If-None-Match`, `Last-Modified` / `If-Modified-Since`), HTTP 304 handling without data loss, and optimistic concurrency control for concurrent recrawls.
4. **Lexical Search Engine (BM25)**: Inverted index (`inverted_index`, `indexed_pages`), tokenizer with stop-word filtering, BM25 Robertson–Spärck Jones ranking with title boosting, deterministic URL tie-breaking, and keyword snippet extraction.
5. **Semantic Search & Hybrid Retrieval**: Dedicated vector embedding storage (`page_embeddings`), cosine similarity scoring, Reciprocal Rank Fusion (RRF) for hybrid ranking, stale embedding detection, and pluggable provider architecture (Ollama / LocalAI / offline test provider).
6. **Browser Automation Foundation**: Headless Playwright Chromium integration for structured page inspection, visible element extraction, and unambiguous action execution (`click` and `fill`) with strict SSRF request interception and safety boundaries.

```
                      +-----------------------------+
                      |       Web Sites / Seed      |
                      +--------------+--------------+
                                     |
                                     v
+------------------+       +-------------------+       +--------------------+
|  URL Frontier    | <---> |   CrawlerWorker   | --->  |     PageStore      |
| (frontier_urls)  |       |   (SSRF/Robots)   |       | (pages/versions)   |
+------------------+       +-------------------+       +---------+----------+
                                                                 |
                                 +-------------------------------+
                                 |                               |
                                 v                               v
                     +-----------------------+       +----------------------+
                     |     SearchIndexer     |       |   EmbeddingService   |
                     |   (inverted_index)    |       |  (page_embeddings)   |
                     +-----------+-----------+       +-----------+----------+
                                 |                               |
                                 v                               v
                         [ BM25 Lexical ]                [ Cosine Semantic ]
                                 \                               /
                                  \                             /
                                   v                           v
                                +--------------------------------+
                                |      Reciprocal Rank Fusion    |
                                |         (SearchService)        |
                                +---------------+----------------+
                                                |
                                                v
                                  GET /api/search?mode=hybrid
```

---

## Retrieval Modes

CrawlForge supports three search modes via the `mode` query parameter:

### 1. `mode=lexical` (Default)
- **Algorithm**: BM25 (Robertson–Spärck Jones) with document frequency weighting and document length normalization ($k_1 = 1.2$, $b = 0.75$, title boost = 2.0).
- **Use Case**: Exact keyword matching, technical identifiers, product codes, or specific terms.
- **Index**: Backed by `inverted_index` and `indexed_pages`.

### 2. `mode=semantic`
- **Algorithm**: Dense vector embeddings and cosine similarity against non-stale stored documents.
- **Use Case**: Conceptual queries, synonyms, intent matching, and semantic exploration where exact keywords may not appear in the source text.
- **Index**: Backed by `page_embeddings` with validation against current `pages.contentHash`.
- **Failure Mode**: If no embedding provider is configured, returns HTTP 503 with a descriptive error.

### 3. `mode=hybrid`
- **Algorithm**: Reciprocal Rank Fusion (RRF):
  $$\text{RRF}(d) = \frac{w_{\text{lexical}}}{k + r_{\text{lexical}}(d)} + \frac{w_{\text{semantic}}}{k + r_{\text{semantic}}(d)}$$
  Where $k$ defaults to 60, and $r(d)$ is the 1-based rank in each candidate list.
- **Deduplication**: Results are merged so each URL appears at most once, marked with `source: 'both' | 'lexical' | 'semantic'`.
- **Tie-Breaking**: Deterministic secondary sort by URL ensures reproducible pagination.
- **Graceful Fallback**: If the embedding provider is unavailable or unconfigured, hybrid search automatically falls back to lexical BM25 retrieval with a response warning rather than failing the request.

---

## Configuration & Environment Variables

Copy `.env.example` to `.env` to configure CrawlForge:

```ini
# Server & Database
PORT=3000
MONGODB_URI=mongodb://localhost:27017
DB_NAME=crawlforge
LOG_LEVEL=info

# Crawler & Safety
CRAWL_CONCURRENCY=3
CRAWL_DELAY_MS=500
CRAWL_TIMEOUT_MS=10000
CRAWL_MAX_RETRIES=3
ALLOWED_DOMAINS=localhost

# Embedding Provider Configuration (Milestone 5)
# Options: 'unconfigured' | 'local-http' | 'test-fake'
EMBEDDING_PROVIDER=unconfigured

# Local HTTP Embedding Settings (for Ollama, LocalAI, etc.)
EMBEDDING_ENDPOINT=http://localhost:11434/api/embeddings
EMBEDDING_MODEL=all-minilm
EMBEDDING_TIMEOUT_MS=5000
EMBEDDING_DIMENSIONS=384
```

### Supported Embedding Providers

1. **`unconfigured` (Default)**:
   - Safe, zero-overhead default.
   - Lexical search functions normally.
   - Hybrid search falls back to BM25 with a clear warning.
   - Semantic search explicitly fails closed (HTTP 503), preventing silent or random vectors.

2. **`local-http` (e.g. Ollama or LocalAI)**:
   - Connects to an external local HTTP embedding daemon.
   - Example with Ollama:
     ```bash
     ollama pull all-minilm
     ollama serve
     ```
   - In `.env`:
     ```ini
     EMBEDDING_PROVIDER=local-http
     EMBEDDING_ENDPOINT=http://localhost:11434/api/embeddings
     EMBEDDING_MODEL=all-minilm
     ```

3. **`test-fake` (Offline Deterministic Provider)**:
   - Used for automated testing and offline verification.
   - Correlates semantic clusters into vector dimensions without downloading models or performing external network requests.

---

## Resource & Memory Considerations

CrawlForge is intentionally engineered for efficiency and low-memory environments (such as developer laptops with 8 GB RAM):

- **No In-Process Heavy ML Models**: Does not bundle `@xenova/transformers` or Python runtimes inside Node.js.
- **External Local Inference**: Heavy vector computations are delegated to lightweight local services (such as Ollama) over standard HTTP.
- **Text Truncation**: Page title and body text are limited to the first 1,000 characters before embedding generation, preventing context window exhaustion and excessive memory allocations.
- **Streamed Batches**: Indexing and embedding backfills stream documents via MongoDB cursors rather than buffering entire collections into memory.
- **Automatic Stale Handling**: Old embeddings are invalidated automatically when page content changes via content-hash aggregation pipelines, avoiding complex cascading deletions.

---

## API Reference

### Search Endpoints

#### `GET /api/search`
Execute a lexical, semantic, or hybrid search query.

**Query Parameters:**
| Parameter | Type | Default | Description |
|---|---|---|---|
| `q` | string | *required* | The search query string |
| `mode` | string | `lexical` | Retrieval mode: `lexical`, `semantic`, or `hybrid` |
| `limit` | integer | `10` | Maximum results to return (1–100) |
| `offset` | integer | `0` | Result offset for pagination ($\ge 0$) |
| `k1` | number | `1.2` | BM25 term frequency saturation parameter |
| `b` | number | `0.75` | BM25 document length normalization parameter |
| `rrfK` | integer | `60` | RRF rank smoothing constant (hybrid mode) |
| `weightLexical` | number | `1.0` | Weight multiplier for lexical RRF scores |
| `weightSemantic` | number | `1.0` | Weight multiplier for semantic RRF scores |

**Example Requests:**
```bash
# Lexical search (default)
curl "http://localhost:3000/api/search?q=crawler"

# Semantic search
curl "http://localhost:3000/api/search?q=spider+harvesting&mode=semantic"

# Hybrid search with customized RRF weights
curl "http://localhost:3000/api/search?q=distributed+spider&mode=hybrid&weightLexical=1.0&weightSemantic=1.5"
```

**Example Hybrid Response:**
```json
{
  "query": "spider",
  "mode": "hybrid",
  "total": 2,
  "limit": 10,
  "offset": 0,
  "results": [
    {
      "url": "http://example.com/spider-crawler",
      "title": "Web Spider Crawler",
      "score": 0.032786,
      "snippet": "Web ...spider... crawler architecture and frontier.",
      "source": "both",
      "lexicalScore": 1.482,
      "semanticScore": 0.895,
      "lexicalRank": 1,
      "semanticRank": 1
    }
  ]
}
```

---

### Embedding & Indexing Management

#### `POST /api/embeddings/backfill`
Generate embeddings for stored pages.
```bash
# Backfill all stored pages without existing embeddings
curl -X POST http://localhost:3000/api/embeddings/backfill

# Force regenerate all embeddings even if unchanged
curl -X POST http://localhost:3000/api/embeddings/backfill \
  -H "Content-Type: application/json" \
  -d '{"force": true}'

# Backfill a single page by URL
curl -X POST http://localhost:3000/api/embeddings/backfill \
  -H "Content-Type: application/json" \
  -d '{"url": "http://example.com/page-1"}'
```

#### `GET /api/embeddings/status`
Inspect embedding provider availability and synchronization counts.
```bash
curl http://localhost:3000/api/embeddings/status
```
**Example Response:**
```json
{
  "status": "ok",
  "provider": {
    "name": "local-http",
    "available": true,
    "dimensions": 384
  },
  "counts": {
    "totalPages": 42,
    "totalEmbeddings": 42,
    "validEmbeddings": 40,
    "staleEmbeddings": 2,
    "missingEmbeddings": 2
  }
}
```

#### `POST /api/index` & `GET /api/index/stats`
Manage lexical inverted index and view index statistics.
```bash
curl -X POST http://localhost:3000/api/index
curl http://localhost:3000/api/index/stats
```

---

### Browser Automation API (Milestone 6)

#### Browser Binary Setup
If Playwright Chromium binaries are not yet installed on the machine, run:
```bash
npx playwright install chromium
```
*Note: CrawlForge will never silently download browser binaries during server startup or execution. If the binary is missing, endpoints fail closed with HTTP 503 explaining the exact install command.*

#### `POST /api/browser/inspect`
Inspect a web page using headless Chromium, extracting visible page content, accessible links, and buttons.

```bash
curl -X POST http://localhost:3000/api/browser/inspect \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

**Response Format:**
```json
{
  "status": "ok",
  "data": {
    "url": "https://example.com/",
    "title": "Example Domain",
    "textContent": "Example Domain This domain is for use in illustrative examples in documents...",
    "links": [
      { "text": "More information...", "href": "https://www.iana.org/domains/example" }
    ],
    "buttons": []
  }
}
```

#### `POST /api/browser/action`
Execute a single, explicitly requested browser action (`click` or `fill`). Requires an unambiguous target label.

```bash
# Click a button or link by explicit label
curl -X POST http://localhost:3000/api/browser/action \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "action": {
      "type": "click",
      "label": "More information..."
    }
  }'

# Fill an input field by accessible label without submitting
curl -X POST http://localhost:3000/api/browser/action \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://localhost:3000/contact",
    "action": {
      "type": "fill",
      "label": "Your Name",
      "value": "Alice Doe"
    }
  }'
```

#### Browser Automation Safety Model
- **SSRF Request Interception**: Playwright routes intercept all outgoing HTTP/HTTPS requests (including subresources and 30x redirects). Requests targeting loopback, RFC 1918, link-local, cloud metadata, or private IP ranges are aborted with `blockedbyclient`.
- **No Automatic Submission**: `fill` actions modify the input value without dispatching form submissions or Enter keys.
- **Ambiguous Target Guard**: If more than one visible element matches a label, the action fails closed with an informative error rather than guessing.
- **Resource Lifecycle**: Browser contexts and child processes are unconditionally closed in `finally` blocks.
- **No Arbitrary Code Execution**: No user-supplied JavaScript is executed; page content is treated strictly as untrusted data.

---

## CLI Utilities

Generate or backfill embeddings directly from the command line:

```bash
# Backfill all stored pages
npx tsx scripts/generateEmbeddings.ts

# Backfill a single page
npx tsx scripts/generateEmbeddings.ts --url http://example.com/page-1

# Force re-embed all pages
npx tsx scripts/generateEmbeddings.ts --force
```

---

## Testing & Verification

Run the comprehensive automated test suite (250 unit and integration tests):

```bash
# Run all tests
npm test

# Run TypeScript compilation check
npm run build
```

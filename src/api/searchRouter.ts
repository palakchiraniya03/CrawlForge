/**
 * Express router for lexical, semantic, and hybrid search and indexing endpoints.
 *
 * Routes:
 * - GET  /api/search            -> Search endpoint with mode=lexical|semantic|hybrid.
 * - POST /api/index             -> Trigger lexical indexing for all or single page.
 * - GET  /api/index/stats       -> Lexical index statistics (documents, postings, avgdl).
 * - POST /api/embeddings/backfill -> Trigger embedding generation for all or single page.
 * - GET  /api/embeddings/status   -> Embedding provider and synchronization status.
 */

import { Router, Request, Response } from 'express';
import type { Db } from 'mongodb';
import { SearchIndexer } from '../search/indexer.js';
import {
  SearchService,
  SearchMode,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_RRF_K,
} from '../search/searchService.js';
import { EmbeddingService } from '../embeddings/embeddingService.js';
import { createEmbeddingProvider } from '../embeddings/providerFactory.js';
import type { EmbeddingProvider } from '../embeddings/types.js';

export function createSearchRouter(
  getDb: () => Db,
  customProvider?: EmbeddingProvider,
): Router {
  const router = Router();

  let indexer: SearchIndexer | null = null;
  let embeddingService: EmbeddingService | null = null;
  let searchService: SearchService | null = null;

  async function getServices(): Promise<{
    indexer: SearchIndexer;
    embeddingService: EmbeddingService;
    searchService: SearchService;
  }> {
    if (!indexer || !embeddingService || !searchService) {
      const db = getDb();

      indexer = new SearchIndexer(db);
      await indexer.init();

      const provider = customProvider || createEmbeddingProvider();
      embeddingService = new EmbeddingService(db, provider);
      await embeddingService.init();

      searchService = new SearchService(db, indexer, embeddingService);
    }
    return { indexer, embeddingService, searchService };
  }

  // GET /search?q=<query>&mode=lexical|semantic|hybrid&limit=<n>&offset=<n>
  router.get('/search', async (req: Request, res: Response) => {
    try {
      const q = req.query.q;

      if (q === undefined || typeof q !== 'string') {
        res.status(400).json({ status: 'error', message: 'Query parameter "q" is required' });
        return;
      }

      // Mode parameter validation
      let mode: SearchMode = 'lexical';
      if (req.query.mode !== undefined) {
        const rawMode = String(req.query.mode).toLowerCase();
        if (rawMode !== 'lexical' && rawMode !== 'semantic' && rawMode !== 'hybrid') {
          res.status(400).json({
            status: 'error',
            message: 'Invalid mode parameter: must be one of "lexical", "semantic", "hybrid"',
          });
          return;
        }
        mode = rawMode as SearchMode;
      }

      let limit = DEFAULT_LIMIT;
      if (req.query.limit !== undefined) {
        const parsedLimit = parseInt(String(req.query.limit), 10);
        if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIMIT) {
          res.status(400).json({
            status: 'error',
            message: `Invalid limit parameter: must be an integer between 1 and ${MAX_LIMIT}`,
          });
          return;
        }
        limit = parsedLimit;
      }

      let offset = 0;
      if (req.query.offset !== undefined) {
        const parsedOffset = parseInt(String(req.query.offset), 10);
        if (isNaN(parsedOffset) || parsedOffset < 0) {
          res.status(400).json({
            status: 'error',
            message: 'Invalid offset parameter: must be a non-negative integer',
          });
          return;
        }
        offset = parsedOffset;
      }

      // Optional BM25 parameters
      let k1: number | undefined;
      if (req.query.k1 !== undefined) {
        const parsedK1 = parseFloat(String(req.query.k1));
        if (isNaN(parsedK1) || parsedK1 < 0) {
          res.status(400).json({ status: 'error', message: 'Invalid k1 parameter: must be a positive number' });
          return;
        }
        k1 = parsedK1;
      }

      let b: number | undefined;
      if (req.query.b !== undefined) {
        const parsedB = parseFloat(String(req.query.b));
        if (isNaN(parsedB) || parsedB < 0 || parsedB > 1) {
          res.status(400).json({ status: 'error', message: 'Invalid b parameter: must be a number between 0 and 1' });
          return;
        }
        b = parsedB;
      }

      // Optional Hybrid RRF parameters
      let rrfK: number | undefined;
      if (req.query.rrfK !== undefined) {
        const parsedK = parseInt(String(req.query.rrfK), 10);
        if (isNaN(parsedK) || parsedK < 1) {
          res.status(400).json({ status: 'error', message: 'Invalid rrfK parameter: must be an integer >= 1' });
          return;
        }
        rrfK = parsedK;
      }

      let weightLexical: number | undefined;
      if (req.query.weightLexical !== undefined) {
        const parsedW = parseFloat(String(req.query.weightLexical));
        if (isNaN(parsedW) || parsedW < 0) {
          res.status(400).json({ status: 'error', message: 'Invalid weightLexical parameter: must be >= 0' });
          return;
        }
        weightLexical = parsedW;
      }

      let weightSemantic: number | undefined;
      if (req.query.weightSemantic !== undefined) {
        const parsedW = parseFloat(String(req.query.weightSemantic));
        if (isNaN(parsedW) || parsedW < 0) {
          res.status(400).json({ status: 'error', message: 'Invalid weightSemantic parameter: must be >= 0' });
          return;
        }
        weightSemantic = parsedW;
      }

      const { searchService } = await getServices();
      const results = await searchService.search(q, {
        mode,
        limit,
        offset,
        k1,
        b,
        rrfK,
        weightLexical,
        weightSemantic,
      });

      res.json(results);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes('unavailable') || errorMessage.includes('not ready')) {
        res.status(503).json({ status: 'error', message: errorMessage });
        return;
      }
      console.error('Error during search execution:', err);
      res.status(500).json({ status: 'error', message: 'Internal search engine error' });
    }
  });

  // POST /index — Trigger lexical indexing for all or single page
  router.post('/index', async (req: Request, res: Response) => {
    try {
      const { indexer } = await getServices();
      const { url, force } = (req.body ?? {}) as { url?: string; force?: boolean };

      if (url) {
        const result = await indexer.indexPageByUrl(url, { force: Boolean(force) });
        if (result.outcome === 'not_found') {
          res.status(404).json({ status: 'error', message: `Page not found in storage: ${url}` });
          return;
        }
        res.json({ status: 'ok', ...result });
        return;
      }

      const result = await indexer.indexAll({ force: Boolean(force) });
      res.json({ status: 'ok', ...result });
    } catch (err) {
      console.error('Error during lexical indexing:', err);
      res.status(500).json({ status: 'error', message: 'Internal indexing error' });
    }
  });

  // GET /index/stats — Return global lexical index statistics
  router.get('/index/stats', async (_req: Request, res: Response) => {
    try {
      const { indexer } = await getServices();
      const stats = await indexer.getIndexStats();
      res.json({ status: 'ok', ...stats });
    } catch (err) {
      console.error('Error fetching lexical index stats:', err);
      res.status(500).json({ status: 'error', message: 'Internal stats error' });
    }
  });

  // POST /embeddings/backfill — Trigger embedding generation for all or single page
  router.post('/embeddings/backfill', async (req: Request, res: Response) => {
    try {
      const { embeddingService } = await getServices();
      const { url, force } = (req.body ?? {}) as { url?: string; force?: boolean };

      const available = await embeddingService.provider.isAvailable();
      if (!available) {
        res.status(503).json({
          status: 'error',
          message: `Embedding provider "${embeddingService.provider.name}" is not available or configured.`,
        });
        return;
      }

      if (url) {
        const result = await embeddingService.generateEmbeddingForUrl(url, { force: Boolean(force) });
        if (result.outcome === 'not_found') {
          res.status(404).json({ status: 'error', message: `Page not found in storage: ${url}` });
          return;
        }
        res.json({ status: 'ok', ...result });
        return;
      }

      const result = await embeddingService.backfill({ force: Boolean(force) });
      res.json({ status: 'ok', ...result });
    } catch (err) {
      console.error('Error during embedding backfill:', err);
      res.status(500).json({ status: 'error', message: 'Internal embedding error' });
    }
  });

  // GET /embeddings/status — Report provider availability and synchronization stats
  router.get('/embeddings/status', async (_req: Request, res: Response) => {
    try {
      const { embeddingService } = await getServices();
      const status = await embeddingService.getStatus();
      res.json({ status: 'ok', ...status });
    } catch (err) {
      console.error('Error fetching embedding status:', err);
      res.status(500).json({ status: 'error', message: 'Internal status error' });
    }
  });

  return router;
}

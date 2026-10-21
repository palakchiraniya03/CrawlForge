/**
 * Express router for search and indexing endpoints.
 *
 * Routes:
 * - GET  /api/search      -> Ranked BM25 search results with pagination.
 * - POST /api/index       -> Trigger indexing for all or single page.
 * - GET  /api/index/stats -> Global index statistics (documents, postings, avgdl).
 */

import { Router, Request, Response } from 'express';
import type { Db } from 'mongodb';
import { SearchIndexer } from '../search/indexer.js';
import { SearchService, DEFAULT_LIMIT, MAX_LIMIT } from '../search/searchService.js';

export function createSearchRouter(getDb: () => Db): Router {
  const router = Router();

  // Helper to lazily retrieve dependencies with initialized collections
  let indexer: SearchIndexer | null = null;
  let searchService: SearchService | null = null;

  async function getServices(): Promise<{ indexer: SearchIndexer; searchService: SearchService }> {
    if (!indexer || !searchService) {
      const db = getDb();
      indexer = new SearchIndexer(db);
      await indexer.init();
      searchService = new SearchService(db, indexer);
    }
    return { indexer, searchService };
  }

  // GET /search?q=<query>&limit=<n>&offset=<n>
  router.get('/search', async (req: Request, res: Response) => {
    try {
      const q = req.query.q;

      if (q === undefined || typeof q !== 'string') {
        res.status(400).json({ status: 'error', message: 'Query parameter "q" is required' });
        return;
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

      const { searchService } = await getServices();
      const results = await searchService.search(q, { limit, offset, k1, b });

      res.json(results);
    } catch (err) {
      console.error('Error during search execution:', err);
      res.status(500).json({ status: 'error', message: 'Internal search engine error' });
    }
  });

  // POST /index — Index all stored pages or a single page by URL
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

      // Index all pages in database
      const result = await indexer.indexAll({ force: Boolean(force) });
      res.json({ status: 'ok', ...result });
    } catch (err) {
      console.error('Error during indexing:', err);
      res.status(500).json({ status: 'error', message: 'Internal indexing error' });
    }
  });

  // GET /index/stats — Return global search index statistics
  router.get('/index/stats', async (_req: Request, res: Response) => {
    try {
      const { indexer } = await getServices();
      const stats = await indexer.getIndexStats();
      res.json({ status: 'ok', ...stats });
    } catch (err) {
      console.error('Error fetching index stats:', err);
      res.status(500).json({ status: 'error', message: 'Internal stats error' });
    }
  });

  return router;
}

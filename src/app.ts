import express, { Request, Response, NextFunction } from 'express';
import type { Db } from 'mongodb';
import { getDb } from './db/client.js';
import { createSearchRouter } from './api/searchRouter.js';
import { createBrowserRouter } from './api/browserRouter.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import { BrowserService } from './browser/browserService.js';

export function createApp(
  customDb?: Db,
  customProvider?: EmbeddingProvider,
  customBrowserService?: BrowserService,
) {
  const app = express();
  app.use(express.json());

  // GET /health
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // GET /health/db
  app.get('/health/db', async (_req: Request, res: Response) => {
    try {
      const db = customDb ?? getDb();
      const result = await db.command({ ping: 1 });
      if (result.ok === 1) {
        res.json({ status: 'ok', database: db.databaseName, timestamp: new Date().toISOString() });
      } else {
        res.status(503).json({ status: 'error', message: 'Ping failed' });
      }
    } catch (err) {
      res.status(503).json({
        status: 'error',
        message: err instanceof Error ? err.message : 'Unknown database error',
      });
    }
  });

  // Mount Search and Indexing API router under /api
  const dbGetter = () => customDb ?? getDb();
  app.use('/api', createSearchRouter(dbGetter, customProvider));

  // Mount Browser Automation API router under /api/browser
  app.use('/api/browser', createBrowserRouter(customBrowserService));

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ status: 'error', message: 'Not found' });
  });

  // Global error handler
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  });

  return app;
}

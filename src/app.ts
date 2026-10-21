import express, { Request, Response, NextFunction } from 'express';
import { getDb } from './db/client.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  // GET /health
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // GET /health/db
  app.get('/health/db', async (_req: Request, res: Response) => {
    try {
      const db = getDb();
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

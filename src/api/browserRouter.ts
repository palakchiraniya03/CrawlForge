/**
 * Express router for Browser Automation endpoints.
 *
 * Routes:
 * - POST /api/browser/inspect -> Inspect page content, links, and buttons.
 * - POST /api/browser/action  -> Execute an explicit action (click or fill).
 */

import { Router, Request, Response } from 'express';
import { BrowserService } from '../browser/browserService.js';
import type { BrowserAction } from '../browser/types.js';

export function createBrowserRouter(customBrowserService?: BrowserService): Router {
  const router = Router();
  const browserService = customBrowserService ?? new BrowserService();

  // POST /api/browser/inspect
  router.post('/inspect', async (req: Request, res: Response) => {
    try {
      const { url } = req.body ?? {};

      if (!url || typeof url !== 'string') {
        res.status(400).json({
          status: 'error',
          message: 'Field "url" is required and must be a string.',
        });
        return;
      }

      // Check browser availability
      const availability = browserService.isAvailable();
      if (!availability.available) {
        res.status(503).json({
          status: 'error',
          message: availability.reason,
        });
        return;
      }

      const result = await browserService.inspectPage(url);
      res.json({
        status: 'ok',
        data: result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('SSRF') || message.includes('blocked by SSRF') || message.includes('Invalid URL') || message.includes('Unsupported protocol')) {
        res.status(400).json({ status: 'error', message });
        return;
      }

      if (message.includes('Playwright Chromium browser binary is not installed')) {
        res.status(503).json({ status: 'error', message });
        return;
      }

      if (message.includes('timeout') || message.includes('Timeout')) {
        res.status(504).json({ status: 'error', message: 'Browser operation timed out.' });
        return;
      }

      console.error('Browser inspect error:', err);
      res.status(500).json({ status: 'error', message: 'Internal browser automation error.' });
    }
  });

  // POST /api/browser/action
  router.post('/action', async (req: Request, res: Response) => {
    try {
      const { url, action } = req.body ?? {};

      if (!url || typeof url !== 'string') {
        res.status(400).json({
          status: 'error',
          message: 'Field "url" is required and must be a string.',
        });
        return;
      }

      if (!action || typeof action !== 'object') {
        res.status(400).json({
          status: 'error',
          message: 'Field "action" is required and must be an object with "type" and "label".',
        });
        return;
      }

      const { type, label, value } = action as Partial<BrowserAction>;

      if (type !== 'click' && type !== 'fill') {
        res.status(400).json({
          status: 'error',
          message: 'Invalid action type: must be "click" or "fill".',
        });
        return;
      }

      if (!label || typeof label !== 'string' || !label.trim()) {
        res.status(400).json({
          status: 'error',
          message: 'Field "action.label" is required and must be a non-empty string.',
        });
        return;
      }

      if (type === 'fill' && (value === undefined || typeof value !== 'string')) {
        res.status(400).json({
          status: 'error',
          message: 'Field "action.value" is required for fill action and must be a string.',
        });
        return;
      }

      // Check browser availability
      const availability = browserService.isAvailable();
      if (!availability.available) {
        res.status(503).json({
          status: 'error',
          message: availability.reason,
        });
        return;
      }

      const result = await browserService.executeAction(url, {
        type,
        label: label.trim(),
        value,
      });

      res.json({
        status: 'ok',
        data: result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (
        message.includes('SSRF') ||
        message.includes('blocked by SSRF') ||
        message.includes('Invalid URL') ||
        message.includes('Unsupported protocol') ||
        message.includes('Target not found') ||
        message.includes('Ambiguous target')
      ) {
        res.status(400).json({ status: 'error', message });
        return;
      }

      if (message.includes('Playwright Chromium browser binary is not installed')) {
        res.status(503).json({ status: 'error', message });
        return;
      }

      if (message.includes('timeout') || message.includes('Timeout')) {
        res.status(504).json({ status: 'error', message: 'Browser action timed out.' });
        return;
      }

      console.error('Browser action error:', err);
      res.status(500).json({ status: 'error', message: 'Internal browser automation error.' });
    }
  });

  return router;
}

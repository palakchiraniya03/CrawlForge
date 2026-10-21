/**
 * Local HTTP fixture server for deterministic integration tests.
 *
 * Provides controlled pages with known content, redirect chains,
 * robots.txt rules, error pages, and content-type variations.
 *
 * Usage: call start() to get the base URL, call stop() in afterAll.
 */

import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';

export interface FixtureServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

type Route = {
  body: string;
  contentType: string;
  status: number;
  headers?: Record<string, string>;
};

function makeRoutes(port: number): Map<string, Route> {
  const base = `http://localhost:${port}`;
  const routes = new Map<string, Route>();

  // robots.txt — disallows /secret
  routes.set('/robots.txt', {
    status: 200,
    contentType: 'text/plain',
    body: `User-agent: *\nDisallow: /secret\nDisallow: /admin\n`,
  });

  // Root page with links to other pages
  routes.set('/', {
    status: 200,
    contentType: 'text/html',
    body: `<!DOCTYPE html><html><head><title>Fixture Home</title></head><body>
      <h1>Home</h1>
      <a href="/page-a">Page A</a>
      <a href="/page-b">Page B</a>
      <a href="/page-a">Page A (duplicate)</a>
      <a href="/secret">Secret (disallowed)</a>
      <a href="javascript:void(0)">JS link</a>
      <a href="mailto:test@test.com">mailto link</a>
      <a href="http://external-not-allowed.com/page">External (out of scope)</a>
    </body></html>`,
  });

  // Page A — plain content
  routes.set('/page-a', {
    status: 200,
    contentType: 'text/html',
    body: `<!DOCTYPE html><html><head><title>Page A</title></head><body>
      <h1>Page A</h1>
      <p>Some content on page A.</p>
      <a href="/">Back to home</a>
    </body></html>`,
  });

  // Page B — redirects to page A
  routes.set('/page-b', {
    status: 301,
    contentType: 'text/html',
    body: '',
    headers: { Location: `${base}/page-a` },
  });

  // Secret page — disallowed by robots.txt
  routes.set('/secret', {
    status: 200,
    contentType: 'text/html',
    body: `<!DOCTYPE html><html><head><title>Secret</title></head><body>SECRET</body></html>`,
  });

  // 404 page
  routes.set('/not-found', {
    status: 404,
    contentType: 'text/html',
    body: `<!DOCTYPE html><html><head><title>Not Found</title></head><body>Not Found</body></html>`,
  });

  // 500 error page
  routes.set('/server-error', {
    status: 500,
    contentType: 'text/html',
    body: `<!DOCTYPE html><html><body>Server Error</body></html>`,
  });

  // Non-HTML response (PDF)
  routes.set('/document.pdf', {
    status: 200,
    contentType: 'application/pdf',
    body: `%PDF binary content`,
  });

  // Redirect to a private IP (SSRF attempt) — simulate via Location header
  // The redirect target won't be followed if SSRF check works
  routes.set('/redirect-to-private', {
    status: 301,
    contentType: 'text/html',
    body: '',
    headers: { Location: 'http://192.168.1.1/' },
  });

  // Redirect loop A → B → A
  routes.set('/loop-a', {
    status: 302,
    contentType: 'text/html',
    body: '',
    headers: { Location: `${base}/loop-b` },
  });
  routes.set('/loop-b', {
    status: 302,
    contentType: 'text/html',
    body: '',
    headers: { Location: `${base}/loop-a` },
  });

  // Slow response (for timeout test — returns after a long delay)
  // We handle this specially in the handler

  return routes;
}

export function startFixtureServer(): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url ?? '/';

      // Special: /slow — delays 30s (caller should timeout before this)
      if (path === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body>slow</body></html>');
        }, 30_000);
        return;
      }

      const port = (server.address() as { port: number }).port;
      const routes = makeRoutes(port);
      const route = routes.get(path);

      if (!route) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body>404 Not Found</body></html>');
        return;
      }

      const headers: Record<string, string> = {
        'Content-Type': route.contentType,
        ...route.headers,
      };

      res.writeHead(route.status, headers);
      res.end(route.body);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const baseUrl = `http://localhost:${addr.port}`;
      resolve({
        baseUrl,
        stop: () => new Promise<void>((res, rej) => server.close(err => err ? rej(err) : res())),
      });
    });
  });
}

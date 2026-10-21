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
  setRoute: (path: string, route: Route) => void;
  resetRoutes: () => void;
}

export type Route = {
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

  // Conditional ETag page
  routes.set('/conditional-etag', {
    status: 200,
    contentType: 'text/html',
    body: `<!DOCTYPE html><html><head><title>ETag Page</title></head><body><p>ETag content</p></body></html>`,
    headers: { ETag: '"etag-v1"' },
  });

  // Conditional Last-Modified page
  routes.set('/conditional-modified', {
    status: 200,
    contentType: 'text/html',
    body: `<!DOCTYPE html><html><head><title>Modified Page</title></head><body><p>Modified content</p></body></html>`,
    headers: { 'Last-Modified': 'Wed, 21 Oct 2026 12:00:00 GMT' },
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

  return routes;
}

export function startFixtureServer(): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    let customRoutes = new Map<string, Route>();

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

      // Special: /slow-body — sends headers and initial chunk, then stalls
      if (path === '/slow-body') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('<!DOCTYPE html><html><body><p>initial chunk');
        const timer = setTimeout(() => {
          res.end('</p></body></html>');
        }, 30_000);
        const cleanup = () => clearTimeout(timer);
        res.on('close', cleanup);
        req.on('close', cleanup);
        return;
      }

      const port = (server.address() as { port: number }).port;
      const defaultRoutes = makeRoutes(port);
      const route = customRoutes.get(path) ?? defaultRoutes.get(path);

      if (!route) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body>404 Not Found</body></html>');
        return;
      }

      const headers: Record<string, string> = {
        'Content-Type': route.contentType,
        ...route.headers,
      };

      // Check conditional GET headers (ETag / If-None-Match)
      const ifNoneMatch = req.headers['if-none-match'];
      const routeEtag = route.headers?.['ETag'] ?? route.headers?.['etag'];
      if (ifNoneMatch && routeEtag && ifNoneMatch === routeEtag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }

      // Check conditional GET headers (Last-Modified / If-Modified-Since)
      const ifModifiedSince = req.headers['if-modified-since'];
      const routeModified = route.headers?.['Last-Modified'] ?? route.headers?.['last-modified'];
      if (ifModifiedSince && routeModified && ifModifiedSince === routeModified) {
        res.writeHead(304, headers);
        res.end();
        return;
      }

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
        setRoute: (path: string, route: Route) => {
          customRoutes.set(path, route);
        },
        resetRoutes: () => {
          customRoutes.clear();
        },
      });
    });
  });
}

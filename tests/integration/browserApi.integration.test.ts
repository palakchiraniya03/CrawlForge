import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Server } from 'http';
import { createApp } from '../../src/app.js';
import { BrowserService } from '../../src/browser/browserService.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/fixtureServer.js';

let fixture: FixtureServer;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.SSRF_ALLOWED_HOSTS = 'localhost';
  fixture = await startFixtureServer();

  const app = createApp();
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        baseUrl = `http://localhost:${address.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fixture.stop();
  delete process.env.SSRF_ALLOWED_HOSTS;
});

beforeEach(() => {
  fixture.resetRoutes();
});

describe('Browser API — POST /api/browser/inspect', () => {
  it('returns 200 with structured page details on valid inspection request', async () => {
    fixture.setRoute('/inspect-api-test', {
      status: 200,
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><head><title>API Inspect Page</title></head><body>
        <h1>CrawlForge Headless Inspection</h1>
        <a href="/link-1">Action Link</a>
        <button>Trigger Action</button>
      </body></html>`,
    });

    const res = await fetch(`${baseUrl}/api/browser/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${fixture.baseUrl}/inspect-api-test` }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.data.title).toBe('API Inspect Page');
    expect(data.data.textContent).toContain('CrawlForge Headless Inspection');
    expect(data.data.links).toHaveLength(1);
    expect(data.data.links[0].text).toBe('Action Link');
    expect(data.data.buttons).toHaveLength(1);
    expect(data.data.buttons[0].text).toBe('Trigger Action');
  });

  it('validates url parameter and returns 400 when missing or empty', async () => {
    const res = await fetch(`${baseUrl}/api/browser/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.status).toBe('error');
    expect(data.message).toContain('Field "url" is required');
  });

  it('returns 400 when destination is blocked by SSRF policy', async () => {
    const res = await fetch(`${baseUrl}/api/browser/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest' }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.status).toBe('error');
    expect(data.message).toContain('SSRF');
  });

  it('returns 503 when browser binary is reported unavailable', async () => {
    // Custom app with unavailable browser service
    class UnavailableBrowserService extends BrowserService {
      override isAvailable() {
        return {
          available: false,
          reason: 'Playwright Chromium browser binary is not installed. Please run: npx playwright install chromium',
        };
      }
    }

    const testApp = createApp(undefined, undefined, new UnavailableBrowserService());
    let testServer: Server;
    let testUrl: string;

    await new Promise<void>(resolve => {
      testServer = testApp.listen(0, () => {
        const addr = testServer.address() as { port: number };
        testUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });

    try {
      const res = await fetch(`${testUrl!}/api/browser/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${fixture.baseUrl}/` }),
      });

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.status).toBe('error');
      expect(data.message).toContain('npx playwright install chromium');
    } finally {
      await new Promise<void>(resolve => testServer.close(() => resolve()));
    }
  });
});

describe('Browser API — POST /api/browser/action', () => {
  it('returns 200 on successful click action', async () => {
    fixture.setRoute('/action-click-source', {
      status: 200,
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><head><title>Click Source</title></head><body>
        <a href="${fixture.baseUrl}/action-click-dest">Proceed to Next</a>
      </body></html>`,
    });

    fixture.setRoute('/action-click-dest', {
      status: 200,
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><head><title>Destination Reached</title></head><body>Destination</body></html>`,
    });

    const res = await fetch(`${baseUrl}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/action-click-source`,
        action: {
          type: 'click',
          label: 'Proceed to Next',
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.data.success).toBe(true);
    expect(data.data.newUrl).toContain('/action-click-dest');
    expect(data.data.newTitle).toBe('Destination Reached');
  });

  it('returns 200 on successful fill action', async () => {
    fixture.setRoute('/action-fill-test', {
      status: 200,
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><head><title>Form Fill</title></head><body>
        <label for="nameInput">Your Full Name</label>
        <input id="nameInput" type="text" />
      </body></html>`,
    });

    const res = await fetch(`${baseUrl}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/action-fill-test`,
        action: {
          type: 'fill',
          label: 'Your Full Name',
          value: 'Alex Smith',
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.data.success).toBe(true);
    expect(data.data.message).toContain('Successfully filled field "Your Full Name"');
  });

  it('validates action object structure and returns 400 on invalid input', async () => {
    // Missing action
    let res = await fetch(`${baseUrl}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${fixture.baseUrl}/` }),
    });
    expect(res.status).toBe(400);

    // Unsupported action type
    res = await fetch(`${baseUrl}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/`,
        action: { type: 'submit', label: 'Go' },
      }),
    });
    expect(res.status).toBe(400);

    // Missing label
    res = await fetch(`${baseUrl}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/`,
        action: { type: 'click', label: '' },
      }),
    });
    expect(res.status).toBe(400);

    // Fill missing value
    res = await fetch(`${baseUrl}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/`,
        action: { type: 'fill', label: 'Field' },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when requested target is missing or ambiguous', async () => {
    fixture.setRoute('/empty-page', {
      status: 200,
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><body>Empty</body></html>`,
    });

    const res = await fetch(`${baseUrl}/api/browser/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/empty-page`,
        action: { type: 'click', label: 'Does Not Exist' },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.status).toBe('error');
    expect(data.message).toContain('Target not found');
  });
});

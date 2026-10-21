import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../fixtures/fixtureServer.js';
import { BrowserService } from '../../src/browser/browserService.js';

let fixture: FixtureServer;
let browserService: BrowserService;

beforeAll(async () => {
  // Allow localhost for fixture server during tests
  process.env.SSRF_ALLOWED_HOSTS = 'localhost';

  fixture = await startFixtureServer();
  browserService = new BrowserService({
    navigationTimeoutMs: 5000,
    actionTimeoutMs: 3000,
    maxTextLength: 1000,
  });
});

afterAll(async () => {
  await fixture.stop();
  delete process.env.SSRF_ALLOWED_HOSTS;
});

beforeEach(() => {
  fixture.resetRoutes();
});

describe('BrowserService — Integration Tests', () => {
  describe('Page Inspection', () => {
    it('successfully inspects visible page content, links, and buttons', async () => {
      fixture.setRoute('/browser-inspect', {
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html>
        <html>
          <head><title>Test Page Title</title></head>
          <body>
            <h1>Welcome to CrawlForge</h1>
            <p>This is visible body content for testing browser automation.</p>
            <a href="/target-1">Target Link 1</a>
            <a href="/target-2">Target Link 2</a>
            <a href="/hidden-link" style="display:none;">Hidden Link</a>
            <button>Clickable Action</button>
            <input type="submit" value="Submit Button">
            <button style="display:none;">Hidden Button</button>
          </body>
        </html>`,
      });

      const result = await browserService.inspectPage(`${fixture.baseUrl}/browser-inspect`);

      expect(result.url).toContain('/browser-inspect');
      expect(result.title).toBe('Test Page Title');
      expect(result.textContent).toContain('Welcome to CrawlForge');
      expect(result.textContent).toContain('visible body content');

      // Verify visible links
      const linkTexts = result.links.map(l => l.text);
      expect(linkTexts).toContain('Target Link 1');
      expect(linkTexts).toContain('Target Link 2');
      expect(linkTexts).not.toContain('Hidden Link');

      // Verify visible buttons
      const buttonTexts = result.buttons.map(b => b.text);
      expect(buttonTexts).toContain('Clickable Action');
      expect(buttonTexts).toContain('Submit Button');
      expect(buttonTexts).not.toContain('Hidden Button');
    });

    it('bounds text content extraction according to maxTextLength', async () => {
      fixture.setRoute('/long-text', {
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html><html><body><p>${'A'.repeat(5000)}</p></body></html>`,
      });

      const result = await browserService.inspectPage(`${fixture.baseUrl}/long-text`);
      expect(result.textContent.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('Browser Actions — Clicking', () => {
    it('clicks a uniquely labelled link and follows navigation', async () => {
      fixture.setRoute('/click-source', {
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html>
        <html>
          <head><title>Source Page</title></head>
          <body>
            <a href="${fixture.baseUrl}/click-dest">Navigate to Destination</a>
          </body>
        </html>`,
      });

      fixture.setRoute('/click-dest', {
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html>
        <html>
          <head><title>Destination Page</title></head>
          <body><p>You have arrived.</p></body>
        </html>`,
      });

      const result = await browserService.executeAction(`${fixture.baseUrl}/click-source`, {
        type: 'click',
        label: 'Navigate to Destination',
      });

      expect(result.success).toBe(true);
      expect(result.newUrl).toContain('/click-dest');
      expect(result.newTitle).toBe('Destination Page');
    });

    it('clicks a button element matching label', async () => {
      fixture.setRoute('/button-page', {
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html>
        <html>
          <head><title>Button Test</title></head>
          <body>
            <button onclick="document.title='Button Clicked'">Execute Action</button>
          </body>
        </html>`,
      });

      const result = await browserService.executeAction(`${fixture.baseUrl}/button-page`, {
        type: 'click',
        label: 'Execute Action',
      });

      expect(result.success).toBe(true);
      expect(result.newTitle).toBe('Button Clicked');
    });

    it('rejects with clear error when click target is missing', async () => {
      fixture.setRoute('/missing-target', {
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html><html><body><button>Other Button</button></body></html>`,
      });

      await expect(
        browserService.executeAction(`${fixture.baseUrl}/missing-target`, {
          type: 'click',
          label: 'Nonexistent Button',
        }),
      ).rejects.toThrow(/Target not found: no visible button or link matching label "Nonexistent Button"/);
    });

    it('rejects with clear error when multiple targets match label (ambiguous target)', async () => {
      fixture.setRoute('/ambiguous-targets', {
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html>
        <html>
          <body>
            <button>Delete Record</button>
            <button>Delete Record</button>
          </body>
        </html>`,
      });

      await expect(
        browserService.executeAction(`${fixture.baseUrl}/ambiguous-targets`, {
          type: 'click',
          label: 'Delete Record',
        }),
      ).rejects.toThrow(/Ambiguous target: found 2 elements matching label "Delete Record"/);
    });
  });

  describe('Browser Actions — Filling Form Fields', () => {
    it('fills a uniquely labelled field without submitting the form', async () => {
      fixture.setRoute('/form-page', {
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html>
        <html>
          <head><title>Form Test</title></head>
          <body>
            <form onsubmit="document.title='FORM_SUBMITTED'; return false;">
              <label for="username">Username</label>
              <input type="text" id="username" name="username">
              <input type="submit" value="Submit Form">
            </form>
          </body>
        </html>`,
      });

      const result = await browserService.executeAction(`${fixture.baseUrl}/form-page`, {
        type: 'fill',
        label: 'Username',
        value: 'JaneDoe',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully filled field "Username"');
      // Crucial requirement: form MUST NOT be submitted
      expect(result.pageTitle).not.toBe('FORM_SUBMITTED');
    });

    it('rejects with clear error when field target is missing', async () => {
      fixture.setRoute('/missing-field', {
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html><html><body><input placeholder="Search"></body></html>`,
      });

      await expect(
        browserService.executeAction(`${fixture.baseUrl}/missing-field`, {
          type: 'fill',
          label: 'Nonexistent Field',
          value: 'test',
        }),
      ).rejects.toThrow(/Target not found: no visible form field matching label "Nonexistent Field"/);
    });

    it('rejects with clear error when multiple fields match label (ambiguous target)', async () => {
      fixture.setRoute('/ambiguous-fields', {
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html>
        <html>
          <body>
            <input aria-label="Comment" type="text">
            <input aria-label="Comment" type="text">
          </body>
        </html>`,
      });

      await expect(
        browserService.executeAction(`${fixture.baseUrl}/ambiguous-fields`, {
          type: 'fill',
          label: 'Comment',
          value: 'Hello',
        }),
      ).rejects.toThrow(/Ambiguous target: found 2 fields matching label "Comment"/);
    });
  });

  describe('Safety & SSRF Interception', () => {
    it('blocks direct navigation to internal IPs via SSRF policy', async () => {
      await expect(
        browserService.inspectPage('http://169.254.169.254/latest/meta-data'),
      ).rejects.toThrow(/Navigation blocked by SSRF policy/);
    });

    it('intercepts and aborts HTTP redirects to private/internal IPs', async () => {
      fixture.setRoute('/ssrf-redirect', {
        status: 302,
        contentType: 'text/html',
        body: '',
        headers: {
          Location: 'http://169.254.169.254/latest/meta-data',
        },
      });

      // Browser navigation should fail or abort because redirect to 169.254.169.254 is blocked by route interception
      await expect(
        browserService.inspectPage(`${fixture.baseUrl}/ssrf-redirect`),
      ).rejects.toThrow();
    }, 15000);
  });
});

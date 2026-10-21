/**
 * Browser Automation Service.
 *
 * Implements a safe, bounded Playwright Chromium controller for page inspection
 * and explicitly requested browser actions (click and fill).
 *
 * Safety boundaries:
 * - Strict URL validation (HTTP and HTTPS only).
 * - Comprehensive SSRF prevention via DNS verification and route interception.
 * - Redirects and subresources to private/loopback/internal IPs are blocked.
 * - No user-supplied JavaScript execution.
 * - Forms are never automatically submitted.
 * - Timeouts on navigation and actions.
 * - Bounded text extraction to prevent memory exhaustion.
 * - Deterministic, unconditional browser cleanup in finally blocks.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import * as fs from 'fs';
import { checkUrlSafe } from '../security/ssrf.js';
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserInspectionResult,
  BrowserServiceOptions,
  VisibleButton,
  VisibleLink,
} from './types.js';

export const DEFAULT_NAV_TIMEOUT_MS = 10000;
export const DEFAULT_ACTION_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_TEXT_LENGTH = 10000;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class BrowserService {
  private navTimeoutMs: number;
  private actionTimeoutMs: number;
  private maxTextLength: number;

  constructor(options: BrowserServiceOptions = {}) {
    this.navTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
    this.actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  }

  /**
   * Check whether the Playwright Chromium binary is installed and executable.
   */
  isAvailable(): { available: boolean; reason?: string } {
    try {
      const execPath = chromium.executablePath();
      if (execPath && fs.existsSync(execPath)) {
        return { available: true };
      }
      return {
        available: false,
        reason: 'Playwright Chromium browser binary is not installed. Please run: npx playwright install chromium',
      };
    } catch (err) {
      return {
        available: false,
        reason: `Playwright Chromium browser binary is not installed. Please run: npx playwright install chromium (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }

  /**
   * Launch a browser instance with safe sandboxing arguments.
   */
  private async launchBrowser(): Promise<Browser> {
    const status = this.isAvailable();
    if (!status.available) {
      throw new Error(status.reason);
    }

    return await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }

  /**
   * Create an isolated browser context with strict SSRF request filtering.
   */
  private async createContext(browser: Browser): Promise<BrowserContext> {
    const context = await browser.newContext({
      userAgent: 'CrawlForge-BrowserBot/1.0 (+http://localhost:3000)',
      ignoreHTTPSErrors: false,
    });

    // Intercept all requests (including subresources and redirect navigations)
    await context.route('**/*', async route => {
      const requestUrl = route.request().url();

      if (requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) {
        return route.continue();
      }

      try {
        const parsed = new URL(requestUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return route.abort('blockedbyclient');
        }

        const safeCheck = await checkUrlSafe(requestUrl);
        if (!safeCheck.safe) {
          return route.abort('blockedbyclient');
        }

        return route.continue();
      } catch {
        return route.abort('blockedbyclient');
      }
    });

    return context;
  }

  /**
   * Validate initial target URL before launching or navigating.
   */
  async validateTargetUrl(rawUrl: string): Promise<string> {
    if (!rawUrl || typeof rawUrl !== 'string') {
      throw new Error('Target URL must be a non-empty string');
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid URL: ${rawUrl}`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported protocol: ${parsed.protocol}. Only http and https are allowed.`);
    }

    const check = await checkUrlSafe(rawUrl);
    if (!check.safe) {
      throw new Error(`Navigation blocked by SSRF policy: ${check.reason ?? 'Destination is not allowed'}`);
    }

    return parsed.toString();
  }

  /**
   * Inspect a web page: extracts title, bounded visible text, visible links, and visible buttons.
   */
  async inspectPage(targetUrl: string): Promise<BrowserInspectionResult> {
    const validUrl = await this.validateTargetUrl(targetUrl);

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      browser = await this.launchBrowser();
      context = await this.createContext(browser);
      page = await context.newPage();

      // Guard main-frame navigations
      page.on('framenavigated', async frame => {
        if (frame === page?.mainFrame()) {
          const fUrl = frame.url();
          if (fUrl && fUrl !== 'about:blank') {
            const check = await checkUrlSafe(fUrl);
            if (!check.safe) {
              await page.close().catch(() => {});
            }
          }
        }
      });

      await page.goto(validUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.navTimeoutMs,
      });

      const title = (await page.title()) || '';
      const bodyText = (await page.innerText('body').catch(() => '')) || '';
      const textContent = bodyText.trim().slice(0, this.maxTextLength);

      // Extract visible links and buttons
      const { links, buttons } = await page.evaluate(() => {
        function isVisible(el: HTMLElement): boolean {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        const rawLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
        const linkList: Array<{ text: string; href?: string }> = rawLinks
          .filter(isVisible)
          .map(a => ({
            text: (a.textContent || a.getAttribute('aria-label') || '').trim(),
            href: a.href,
          }))
          .filter(l => l.text.length > 0 || (l.href && l.href.length > 0));

        const buttonElements = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]',
          ),
        );
        const buttonList: Array<{ text: string; role?: string }> = buttonElements
          .filter(isVisible)
          .map(el => {
            let text = '';
            if (el instanceof HTMLInputElement) {
              text = el.value || el.getAttribute('aria-label') || '';
            } else {
              text = el.textContent || el.getAttribute('aria-label') || '';
            }
            const role = el.getAttribute('role') || el.tagName.toLowerCase();
            return {
              text: text.trim(),
              role,
            };
          })
          .filter(b => b.text.length > 0);

        return { links: linkList, buttons: buttonList };
      });

      return {
        url: page.url(),
        title,
        textContent,
        links,
        buttons,
      };
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }

  /**
   * Execute an explicit browser action (click or fill) on a target page.
   */
  async executeAction(targetUrl: string, action: BrowserAction): Promise<BrowserActionResult> {
    const validUrl = await this.validateTargetUrl(targetUrl);

    if (!action || typeof action !== 'object') {
      throw new Error('Action must be a valid object');
    }

    if (action.type !== 'click' && action.type !== 'fill') {
      throw new Error(`Unsupported action type: "${(action as any).type}". Supported types are "click" and "fill".`);
    }

    const label = (action.label ?? '').trim();
    if (!label) {
      throw new Error('Action label is required and cannot be empty.');
    }

    if (action.type === 'fill' && typeof action.value !== 'string') {
      throw new Error('Action value is required for fill action and must be a string.');
    }

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      browser = await this.launchBrowser();
      context = await this.createContext(browser);
      page = await context.newPage();

      await page.goto(validUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.navTimeoutMs,
      });

      const initialTitle = await page.title();

      if (action.type === 'click') {
        const matchingElements = await this.findClickableElements(page, label);

        if (matchingElements.length === 0) {
          throw new Error(`Target not found: no visible button or link matching label "${label}".`);
        }
        if (matchingElements.length > 1) {
          throw new Error(
            `Ambiguous target: found ${matchingElements.length} elements matching label "${label}". Please provide a unique label.`,
          );
        }

        const target = matchingElements[0];
        await target.click({ timeout: this.actionTimeoutMs });

        // Allow any navigation to settle
        await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});

        const newUrl = page.url();
        const newTitle = await page.title();

        return {
          action,
          success: true,
          message: `Successfully clicked element with label "${label}"`,
          currentUrl: newUrl,
          pageTitle: initialTitle,
          newUrl,
          newTitle,
        };
      }

      if (action.type === 'fill') {
        const matchingFields = await this.findInputFields(page, label);

        if (matchingFields.length === 0) {
          throw new Error(`Target not found: no visible form field matching label "${label}".`);
        }
        if (matchingFields.length > 1) {
          throw new Error(
            `Ambiguous target: found ${matchingFields.length} fields matching label "${label}". Please provide a unique label.`,
          );
        }

        const targetField = matchingFields[0];
        // Fill without pressing Enter or submitting
        await targetField.fill(action.value!, { timeout: this.actionTimeoutMs });

        return {
          action,
          success: true,
          message: `Successfully filled field "${label}"`,
          currentUrl: page.url(),
          pageTitle: await page.title(),
        };
      }

      throw new Error(`Unhandled action type: ${action.type}`);
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }

  /**
   * Find unique visible button or link elements matching label.
   */
  private async findClickableElements(page: Page, label: string): Promise<Locator[]> {
    const labelPattern = new RegExp(`^${escapeRegex(label)}$`, 'i');

    // 1. Check accessible roles: button and link
    const roleButtons = await page.getByRole('button', { name: labelPattern }).all();
    const roleLinks = await page.getByRole('link', { name: labelPattern }).all();

    const candidates: Locator[] = [];
    for (const loc of [...roleButtons, ...roleLinks]) {
      if (await loc.isVisible().catch(() => false)) {
        candidates.push(loc);
      }
    }

    // 2. If nothing found via role, search by visible element text
    if (candidates.length === 0) {
      const textLocs = await page
        .locator('button, a, [role="button"], input[type="button"], input[type="submit"]')
        .filter({ hasText: labelPattern })
        .all();

      for (const loc of textLocs) {
        if (await loc.isVisible().catch(() => false)) {
          candidates.push(loc);
        }
      }
    }

    // Deduplicate any overlapping locators pointing to the same DOM node
    return await this.deduplicateLocators(page, candidates);
  }

  /**
   * Find unique visible form fields matching label.
   */
  private async findInputFields(page: Page, label: string): Promise<Locator[]> {
    const labelPattern = new RegExp(`^${escapeRegex(label)}$`, 'i');

    const roleInputs = await page.getByRole('textbox', { name: labelPattern }).all();
    const labeledInputs = await page.getByLabel(labelPattern).all();
    const placeholderInputs = await page.getByPlaceholder(labelPattern).all();

    const candidates: Locator[] = [];
    for (const loc of [...roleInputs, ...labeledInputs, ...placeholderInputs]) {
      if (await loc.isVisible().catch(() => false)) {
        candidates.push(loc);
      }
    }

    return await this.deduplicateLocators(page, candidates);
  }

  /**
   * Deduplicate locators that refer to the identical underlying DOM element.
   */
  private async deduplicateLocators(page: Page, locators: Locator[]): Promise<Locator[]> {
    const unique: Locator[] = [];
    for (const loc of locators) {
      let isDuplicate = false;
      const elHandle = await loc.elementHandle().catch(() => null);
      if (!elHandle) continue;

      for (const existing of unique) {
        const existingHandle = await existing.elementHandle().catch(() => null);
        if (!existingHandle) continue;

        const isSame = await page
          .evaluate(([a, b]) => a === b, [elHandle, existingHandle])
          .catch(() => false);
        if (isSame) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        unique.push(loc);
      }
    }
    return unique;
  }
}

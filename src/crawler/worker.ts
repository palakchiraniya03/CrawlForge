/**
 * Crawler worker — orchestrates the full crawl pipeline for one URL.
 *
 * Pipeline per URL:
 * 1. Claim a job from the frontier.
 * 2. Check scope (allowed origin) — already enforced by frontier.addUrl,
 *    but re-verified here as defence-in-depth.
 * 3. Check robots.txt (conservative: deny on failure).
 * 4. Apply per-host rate limiting.
 * 5. Fetch the URL safely (SSRF-protected, redirect-validated).
 * 6. Extract content with Cheerio.
 * 7. Enqueue newly discovered links.
 * 8. Mark job done or failed.
 *
 * This module does NOT store page content — that is Milestone 3's job.
 * Here we only log what was found and enqueue discovered links.
 */

import { Frontier } from '../frontier/frontier.js';
import { safeFetch } from './fetcher.js';
import { isAllowedByRobots, getRobotsCrawlDelay } from './robotsCache.js';
import { extractContent, ExtractedContent } from './extractor.js';
import { HostPacer } from './hostPacer.js';
import { config } from '../config/env.js';
import { PageStore, PageSaveOutcome } from '../db/pageStore.js';

export interface CrawlJobResult {
  url: string;
  status: 'done' | 'robots_blocked' | 'fetch_failed' | 'scope_blocked';
  httpStatus?: number;
  contentType?: string;
  extracted?: ExtractedContent;
  linksEnqueued: number;
  error?: string;
  version?: number;
  outcome?: PageSaveOutcome;
  isNewVersion?: boolean;
  is304?: boolean;
}

export class CrawlerWorker {
  private pacer: HostPacer;

  constructor(
    private readonly frontier: Frontier,
    private readonly pageStore?: PageStore,
    private readonly defaultOrigin?: string,
  ) {
    this.pacer = new HostPacer(config.crawl.delayMs);
  }

  /**
   * Process one URL from the frontier.
   * Returns null if there is no work available.
   *
   * @param origin - Optional origin filter to scope job claiming to a specific target origin.
   */
  async processNext(origin?: string): Promise<CrawlJobResult | null> {
    const targetOrigin = origin ?? this.defaultOrigin;
    const job = await this.frontier.claimNext(targetOrigin);
    if (!job) return null;

    const url = job.url;

    // Re-verify scope as defence-in-depth
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      await this.frontier.markFailed(url, 'Invalid URL after claiming');
      return { url, status: 'fetch_failed', linksEnqueued: 0, error: 'Invalid URL' };
    }

    const isAllowed = config.crawl.allowedDomains.some(allowed => {
      const allowedHost = allowed.startsWith('http') ? new URL(allowed).hostname : allowed;
      return hostname === allowedHost || hostname.endsWith(`.${allowedHost}`);
    });

    if (!isAllowed) {
      await this.frontier.markFailed(url, 'Out of scope');
      return { url, status: 'scope_blocked', linksEnqueued: 0, error: 'Out of scope' };
    }

    // Check robots.txt (conservative: deny on error)
    const robotsAllowed = await isAllowedByRobots(url);
    if (!robotsAllowed) {
      await this.frontier.markRobotsBlocked(url, 'Disallowed by robots.txt');
      return { url, status: 'robots_blocked', linksEnqueued: 0, error: 'Blocked by robots.txt' };
    }

    // Apply per-host robots.txt crawl-delay (on top of our configured minimum)
    try {
      const pageOrigin = new URL(url).origin;
      const robotsDelay = await getRobotsCrawlDelay(pageOrigin);
      if (robotsDelay > 0) {
        this.pacer.setHostDelay(hostname, robotsDelay * 1000);
      }
    } catch { /* ignore */ }

    await this.pacer.paceWithHostDelay(hostname);

    // Check existing page metadata for conditional GET (ETag / Last-Modified)
    let etag: string | undefined;
    let lastModified: string | undefined;
    if (this.pageStore) {
      const existingPage = await this.pageStore.getPage(url);
      if (existingPage) {
        etag = existingPage.etag;
        lastModified = existingPage.lastModified;
      }
    }

    // Safe fetch with conditional request validators if available
    const fetchResult = await safeFetch(url, {
      timeoutMs: config.crawl.timeoutMs,
      maxRetries: 0, // Frontier handles retries at job level
      etag,
      lastModified,
    });

    if (fetchResult.status !== 'ok') {
      const isPermanent =
        fetchResult.status === 'ssrf_blocked' ||
        fetchResult.status === 'unsupported_content_type' ||
        (fetchResult.status === 'http_error' &&
          fetchResult.httpStatus !== undefined &&
          fetchResult.httpStatus >= 400 &&
          fetchResult.httpStatus < 500);

      if (isPermanent) {
        await this.frontier.markFailed(url, fetchResult.error ?? fetchResult.status, fetchResult.httpStatus);
      } else {
        // Transient — frontier will retry
        await this.frontier.markFailed(url, fetchResult.error ?? fetchResult.status, fetchResult.httpStatus);
      }

      return {
        url,
        status: 'fetch_failed',
        httpStatus: fetchResult.httpStatus,
        contentType: fetchResult.contentType,
        linksEnqueued: 0,
        error: fetchResult.error,
      };
    }

    // Case 1: HTTP 304 Not Modified
    if (fetchResult.httpStatus === 304 || fetchResult.notModified) {
      let saveResult;
      if (this.pageStore) {
        saveResult = await this.pageStore.savePage({
          url,
          origin: job.origin,
          title: '',
          textContent: '',
          outgoingLinks: [],
          httpStatus: 304,
          contentType: fetchResult.contentType ?? '',
          etag: fetchResult.etag,
          lastModified: fetchResult.lastModified,
          is304: true,
        });
      }

      await this.frontier.markDone(url);

      return {
        url,
        status: 'done',
        httpStatus: 304,
        linksEnqueued: 0,
        is304: true,
        version: saveResult?.version,
        outcome: saveResult?.outcome ?? 'not_modified_304',
        isNewVersion: false,
      };
    }

    // Case 2: HTTP 200 OK — extract content and persist page
    const extracted = extractContent(fetchResult.body!, fetchResult.url);

    let saveResult;
    if (this.pageStore) {
      saveResult = await this.pageStore.savePage({
        url: fetchResult.url,
        origin: job.origin,
        title: extracted.title,
        textContent: extracted.textContent,
        outgoingLinks: extracted.outgoingLinks,
        httpStatus: fetchResult.httpStatus ?? 200,
        contentType: fetchResult.contentType ?? 'text/html',
        etag: fetchResult.etag,
        lastModified: fetchResult.lastModified,
      });
    }

    // Enqueue discovered links
    let linksEnqueued = 0;
    for (const link of extracted.outgoingLinks) {
      const added = await this.frontier.addUrl(link, job.depth + 1);
      if (added) linksEnqueued++;
    }

    await this.frontier.markDone(url);

    return {
      url,
      status: 'done',
      httpStatus: fetchResult.httpStatus,
      contentType: fetchResult.contentType,
      extracted,
      linksEnqueued,
      version: saveResult?.version,
      outcome: saveResult?.outcome,
      isNewVersion: saveResult?.isNewVersion,
    };
  }
}

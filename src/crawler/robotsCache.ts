/**
 * robots.txt cache and checker.
 *
 * Security properties:
 * - robots.txt fetches use the same SSRF-safe fetcher as the crawler.
 * - On ANY error fetching robots.txt (network, timeout, SSRF block, etc.)
 *   we conservatively DENY crawling rather than assume permission.
 * - robots.txt content is cached in memory per host to avoid redundant fetches.
 * - Cache entries expire after CACHE_TTL_MS (1 hour default).
 *
 * Conservative rule: unknown = denied.
 */

import { createRequire } from 'module';

// robots-parser ships a CJS module. We use createRequire to import it correctly
// in an ESM context, avoiding the broken default-export typing in its .d.ts.
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const robotsParser = _require('robots-parser') as (url: string, content: string) => {
  isAllowed(url: string, ua?: string): boolean | undefined;
  isDisallowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
};
import { safeFetch } from './fetcher.js';

export const CRAWL_USER_AGENT = 'CrawlForge';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  robotsTxt: string | null; // null means fetch failed → deny all
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Fetch and cache the robots.txt for the given origin.
 * Returns the raw robots.txt content, or null if the fetch failed.
 */
async function fetchRobotsTxt(origin: string): Promise<string | null> {
  const robotsUrl = `${origin}/robots.txt`;

  const result = await safeFetch(robotsUrl, {
    timeoutMs: 5000,
    maxRetries: 1, // Only one retry for robots.txt
    allowedContentTypes: ['text/plain', 'text/html'],
    acceptHeader: 'text/plain,text/html;q=0.9,*/*;q=0.8',
  });

  if (result.status === 'ok' && result.body !== undefined) {
    return result.body;
  }

  // Any failure → null (deny-all)
  return null;
}

/**
 * Get the robots.txt content for an origin, using the cache.
 */
async function getRobotsTxt(origin: string): Promise<string | null> {
  const now = Date.now();
  const cached = cache.get(origin);

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.robotsTxt;
  }

  const robotsTxt = await fetchRobotsTxt(origin);
  cache.set(origin, { robotsTxt, fetchedAt: now });
  return robotsTxt;
}

/**
 * Check whether the given URL is allowed by robots.txt.
 *
 * Returns false if:
 * - robots.txt fetch failed (conservative)
 * - The URL is disallowed by the robots.txt rules
 *
 * Returns true only if robots.txt was successfully fetched and the URL
 * is explicitly allowed (or no disallow rule matches).
 */
export async function isAllowedByRobots(url: string): Promise<boolean> {
  let origin: string;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
  } catch {
    return false; // Can't parse URL → deny
  }

  const robotsTxt = await getRobotsTxt(origin);

  if (robotsTxt === null) {
    // Failed to fetch → conservatively deny
    return false;
  }

  const robotsUrl = `${origin}/robots.txt`;
  const robots = robotsParser(robotsUrl, robotsTxt);
  const allowed = robots.isAllowed(url, CRAWL_USER_AGENT);

  // robots-parser returns undefined if no rule matches → treat as allowed
  return allowed !== false;
}

/**
 * Get the crawl delay for the given origin from robots.txt.
 * Returns 0 if unknown or if fetch failed.
 */
export async function getRobotsCrawlDelay(origin: string): Promise<number> {
  const robotsTxt = await getRobotsTxt(origin);
  if (robotsTxt === null) return 0;

  const robotsUrl = `${origin}/robots.txt`;
  const robots = robotsParser(robotsUrl, robotsTxt);
  return robots.getCrawlDelay(CRAWL_USER_AGENT) ?? 0;
}

/** Clear the robots.txt cache (for testing). */
export function clearRobotsCache(): void {
  cache.clear();
}

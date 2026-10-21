/**
 * Safe HTTP fetcher for the crawler.
 *
 * Security properties enforced here:
 * 1. SSRF check on the initial URL before any network I/O.
 * 2. Redirect validation: every redirect destination is SSRF-checked before following.
 * 3. Redirect limit: at most MAX_REDIRECTS hops (prevents redirect loops).
 * 4. Content-type gating: only HTML responses are accepted for crawling.
 * 5. Timeout: hard abort after configurable milliseconds.
 * 6. Retry with bounded exponential backoff on transient failures.
 * 7. Response body size limit to prevent memory exhaustion.
 */

import { checkUrlSafe, checkHostnameSafe } from '../security/ssrf.js';
import { config } from '../config/env.js';

export const MAX_REDIRECTS = 5;
export const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
export const SUPPORTED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];

export type FetchStatus =
  | 'ok'
  | 'ssrf_blocked'
  | 'redirect_limit'
  | 'unsupported_content_type'
  | 'timeout'
  | 'http_error'
  | 'network_error'
  | 'retries_exhausted';

export interface FetchResult {
  status: FetchStatus;
  url: string;          // final URL after redirects
  originalUrl: string;
  httpStatus?: number;
  contentType?: string;
  body?: string;
  error?: string;
  redirectChain: string[];
  attempts: number;
  etag?: string;
  lastModified?: string;
  notModified?: boolean;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
  allowedContentTypes?: string[];
  acceptHeader?: string;
  etag?: string;
  lastModified?: string;
}

/**
 * Perform a safe HTTP GET, following redirects manually so each hop can be
 * SSRF-validated. Retries on transient failures with bounded exponential backoff.
 */
export async function safeFetch(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? config.crawl.timeoutMs;
  const maxRetries = options.maxRetries ?? config.crawl.maxRetries;
  const userAgent = options.userAgent ?? 'CrawlForge/1.0 (+https://github.com/crawlforge)';
  const allowedContentTypes = options.allowedContentTypes;
  const acceptHeader = options.acceptHeader;
  const etag = options.etag;
  const lastModified = options.lastModified;

  const originalUrl = url;
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;

    if (attempt > 0) {
      // Exponential backoff: 1s, 2s, 4s, capped at 16s
      const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
      await sleep(backoffMs);
    }

    const result = await attemptFetch(url, {
      timeoutMs,
      userAgent,
      allowedContentTypes,
      acceptHeader,
      etag,
      lastModified,
    });

    if (result.status === 'ok' || result.status === 'ssrf_blocked' || result.status === 'unsupported_content_type' || result.status === 'redirect_limit') {
      // Non-retryable outcomes
      return { ...result, originalUrl, attempts };
    }

    if (result.status === 'http_error' && result.httpStatus !== undefined) {
      // 4xx errors are not transient — don't retry
      if (result.httpStatus >= 400 && result.httpStatus < 500) {
        return { ...result, originalUrl, attempts };
      }
    }

    // Transient failures: timeout, network_error, 5xx → retry
    if (attempt === maxRetries) {
      if (maxRetries === 0) {
        return { ...result, originalUrl, attempts };
      }
      return {
        ...result,
        status: 'retries_exhausted',
        originalUrl,
        attempts,
        error: `All ${maxRetries + 1} attempts failed. Last error: ${result.error ?? result.status}`,
      };
    }

    // Continue to next attempt
  }

  // Should never reach here
  return {
    status: 'retries_exhausted',
    url,
    originalUrl,
    redirectChain: [],
    attempts,
    error: 'Unexpected retry loop exit',
  };
}

async function attemptFetch(
  startUrl: string,
  options: {
    timeoutMs: number;
    userAgent: string;
    allowedContentTypes?: string[];
    acceptHeader?: string;
    etag?: string;
    lastModified?: string;
  },
): Promise<FetchResult> {
  const redirectChain: string[] = [];
  let currentUrl = startUrl;

  // SSRF check on initial URL
  const initialCheck = await checkUrlSafe(currentUrl);
  if (!initialCheck.safe) {
    return {
      status: 'ssrf_blocked',
      url: currentUrl,
      originalUrl: startUrl,
      redirectChain,
      attempts: 1,
      error: initialCheck.reason,
    };
  }

  // Follow redirects manually
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop === MAX_REDIRECTS) {
      return {
        status: 'redirect_limit',
        url: currentUrl,
        originalUrl: startUrl,
        redirectChain,
        attempts: 1,
        error: `Redirect limit (${MAX_REDIRECTS}) exceeded`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    let response: Response;
    try {
      const defaultAccept = 'text/html,application/xhtml+xml;q=0.9';
      const accept = options.acceptHeader ?? (options.allowedContentTypes ? options.allowedContentTypes.join(',') : defaultAccept);

      response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual', // We handle redirects ourselves
        signal: controller.signal,
        headers: {
          'User-Agent': options.userAgent,
          'Accept': accept,
          'Accept-Language': 'en',
          ...(options.etag ? { 'If-None-Match': options.etag } : {}),
          ...(options.lastModified ? { 'If-Modified-Since': options.lastModified } : {}),
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (isAbortError(err)) {
        return {
          status: 'timeout',
          url: currentUrl,
          originalUrl: startUrl,
          redirectChain,
          attempts: 1,
          error: `Request timed out after ${options.timeoutMs}ms`,
        };
      }
      return {
        status: 'network_error',
        url: currentUrl,
        originalUrl: startUrl,
        redirectChain,
        attempts: 1,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }

    // Handle redirects (exclude 304 Not Modified, which is not a redirect)
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      if (!location) {
        return {
          status: 'network_error',
          url: currentUrl,
          originalUrl: startUrl,
          redirectChain,
          attempts: 1,
          error: `Redirect ${response.status} with no Location header`,
        };
      }

      // Resolve the redirect target against the current URL
      let redirectUrl: string;
      try {
        redirectUrl = new URL(location, currentUrl).toString();
      } catch {
        return {
          status: 'network_error',
          url: currentUrl,
          originalUrl: startUrl,
          redirectChain,
          attempts: 1,
          error: `Invalid redirect location: ${location}`,
        };
      }

      // SSRF check on redirect destination before following
      const redirectCheck = await checkUrlSafe(redirectUrl);
      if (!redirectCheck.safe) {
        return {
          status: 'ssrf_blocked',
          url: redirectUrl,
          originalUrl: startUrl,
          redirectChain,
          attempts: 1,
          error: `Redirect to unsafe destination: ${redirectCheck.reason}`,
        };
      }

      redirectChain.push(currentUrl);
      currentUrl = redirectUrl;
      continue; // Follow the redirect
    }

    // Non-redirect response
    const httpStatus = response.status;
    const rawEtag = response.headers.get('etag');
    const etag = rawEtag && rawEtag.trim() ? rawEtag.trim() : undefined;
    const rawLastModified = response.headers.get('last-modified');
    const lastModified = rawLastModified && rawLastModified.trim() ? rawLastModified.trim() : undefined;

    // Handle 304 Not Modified (conditional GET success)
    if (httpStatus === 304) {
      return {
        status: 'ok',
        url: currentUrl,
        originalUrl: startUrl,
        httpStatus: 304,
        notModified: true,
        etag,
        lastModified,
        redirectChain,
        attempts: 1,
      };
    }

    if (httpStatus < 200 || httpStatus >= 300) {
      return {
        status: 'http_error',
        url: currentUrl,
        originalUrl: startUrl,
        httpStatus,
        redirectChain,
        attempts: 1,
        error: `HTTP ${httpStatus}`,
      };
    }

    // Check content type
    const rawContentType = response.headers.get('content-type') ?? '';
    const contentType = rawContentType.split(';')[0].trim().toLowerCase();
    const supportedTypes = options.allowedContentTypes ?? SUPPORTED_CONTENT_TYPES;

    if (!supportedTypes.includes(contentType)) {
      // Drain body to free connection
      try { await response.body?.cancel(); } catch { /* ignore */ }
      return {
        status: 'unsupported_content_type',
        url: currentUrl,
        originalUrl: startUrl,
        httpStatus,
        contentType: rawContentType,
        redirectChain,
        attempts: 1,
        error: `Unsupported content type: ${rawContentType}`,
      };
    }

    // Read body with size limit
    const body = await readBodyWithLimit(response, MAX_BODY_BYTES);

    return {
      status: 'ok',
      url: currentUrl,
      originalUrl: startUrl,
      httpStatus,
      contentType: rawContentType,
      body,
      etag,
      lastModified,
      notModified: false,
      redirectChain,
      attempts: 1,
    };
  }

  // Unreachable
  return {
    status: 'network_error',
    url: currentUrl,
    originalUrl: startUrl,
    redirectChain,
    attempts: 1,
    error: 'Unexpected loop exit',
  };
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return await response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder('utf-8').decode(combined);
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.includes('aborted') || err.message.includes('abort'))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

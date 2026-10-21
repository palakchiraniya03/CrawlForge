import { URL } from 'url';

export interface NormalizeResult {
  normalized: string;
  valid: boolean;
  error?: string;
}

/**
 * Normalize a URL for deduplication purposes.
 * - Lowercases scheme and host
 * - Removes default ports (80 for http, 443 for https)
 * - Sorts query parameters alphabetically
 * - Removes fragment (#...)
 * - Decodes percent-encoded unreserved characters
 * - Resolves relative URLs against a base when provided
 * - Removes trailing slash from path (except root "/")
 */
export function normalizeUrl(rawUrl: string, base?: string): NormalizeResult {
  try {
    const url = base ? new URL(rawUrl, base) : new URL(rawUrl);

    // Only allow http and https
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { normalized: '', valid: false, error: `Unsupported protocol: ${url.protocol}` };
    }

    // Remove default ports
    if ((url.protocol === 'http:' && url.port === '80') ||
        (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }

    // Sort query params
    url.searchParams.sort();

    // Remove fragment
    url.hash = '';

    // Remove trailing slash from path (but keep root "/")
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }

    // Decode unreserved characters (letters, digits, -, _, ., ~)
    const decoded = url.toString().replace(
      /%([0-9A-Fa-f]{2})/g,
      (match, hex) => {
        const code = parseInt(hex, 16);
        if (
          (code >= 0x41 && code <= 0x5a) || // A-Z
          (code >= 0x61 && code <= 0x7a) || // a-z
          (code >= 0x30 && code <= 0x39) || // 0-9
          code === 0x2d ||                   // -
          code === 0x5f ||                   // _
          code === 0x2e ||                   // .
          code === 0x7e                      // ~
        ) {
          return String.fromCharCode(code);
        }
        return match.toUpperCase();
      }
    );

    return { normalized: decoded.toLowerCase().replace(/^(https?:\/\/[^/]+)/, m => m.toLowerCase()), valid: true };
  } catch (err) {
    return { normalized: '', valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Extract all href links from a set of anchor tags' href values,
 * resolved against the given base URL, normalized and deduplicated.
 */
export function resolveLinks(hrefs: string[], base: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const href of hrefs) {
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:')) {
      continue;
    }
    const result = normalizeUrl(trimmed, base);
    if (result.valid && !seen.has(result.normalized)) {
      seen.add(result.normalized);
      results.push(result.normalized);
    }
  }
  return results;
}

/**
 * Tokenizer and text processing utilities for CrawlForge search.
 *
 * Responsibilities:
 * - Consistent text normalization and tokenization (lowercase, punctuation-free).
 * - Stop-word filtering with configurable dictionary.
 * - Term frequency calculation.
 * - Keyword-in-context snippet extraction.
 */

export const DEFAULT_STOP_WORDS = new Set<string>([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'cannot', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for',
  'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more',
  'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
  'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such',
  'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your',
  'yours', 'yourself', 'yourselves',
]);

export interface TokenizeOptions {
  stopWords?: Set<string>;
  minLength?: number;
}

/**
 * Tokenize a string into normalized, lowercase words.
 * Removes all punctuation, symbols, and non-alphanumeric characters.
 * Filters out stop words and tokens shorter than minLength.
 */
export function tokenize(text: string | null | undefined, options: TokenizeOptions = {}): string[] {
  if (!text) return [];

  const stopWords = options.stopWords ?? DEFAULT_STOP_WORDS;
  const minLength = options.minLength ?? 1;

  // 1. Lowercase
  const lower = text.toLowerCase();

  // 2. Replace non-alphanumeric characters with spaces
  const cleaned = lower.replace(/[^a-z0-9]+/g, ' ');

  // 3. Split by whitespace
  const rawTokens = cleaned.trim().split(/\s+/);

  // 4. Filter stop words, min length, and empty tokens
  const filtered: string[] = [];
  for (const token of rawTokens) {
    if (!token || token.length < minLength) continue;
    if (stopWords.has(token)) continue;
    filtered.push(token);
  }

  return filtered;
}

/**
 * Compute term frequencies from an array of tokens.
 * Returns a map of term -> count.
 */
export function computeTermFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

/**
 * Extract a relevant snippet around the first occurrence of any query token.
 * Trims to word boundaries and appends ellipses where text was truncated.
 *
 * @param text - The full readable text of the document.
 * @param queryTokens - The normalized query tokens to look for.
 * @param maxLength - Maximum target snippet length in characters (default: 160).
 */
export function extractSnippet(
  text: string | null | undefined,
  queryTokens: string[],
  maxLength: number = 160,
): string {
  if (!text) return '';

  // Normalize all whitespaces to single spaces
  const cleanText = text.replace(/\s+/g, ' ').trim();
  if (cleanText.length <= maxLength) {
    return cleanText;
  }

  const lowerText = cleanText.toLowerCase();

  // Find the earliest match of any query token
  let firstMatchIndex = -1;
  let matchedLength = 0;

  for (const token of queryTokens) {
    if (!token) continue;
    // Look for whole-word boundary or substring
    const regex = new RegExp(`\\b${token}\\b`, 'i');
    const match = regex.exec(cleanText);
    if (match) {
      if (firstMatchIndex === -1 || match.index < firstMatchIndex) {
        firstMatchIndex = match.index;
        matchedLength = token.length;
      }
    }
  }

  // Fallback: if no whole-word match found, try plain indexOf
  if (firstMatchIndex === -1) {
    for (const token of queryTokens) {
      if (!token) continue;
      const idx = lowerText.indexOf(token.toLowerCase());
      if (idx !== -1 && (firstMatchIndex === -1 || idx < firstMatchIndex)) {
        firstMatchIndex = idx;
        matchedLength = token.length;
      }
    }
  }

  // If still not found, return beginning of text
  if (firstMatchIndex === -1) {
    const end = findWordBoundary(cleanText, maxLength, 'forward');
    return cleanText.slice(0, end).trim() + (end < cleanText.length ? '...' : '');
  }

  // Center the snippet around the matched token
  const halfWindow = Math.floor((maxLength - matchedLength) / 2);
  let start = Math.max(0, firstMatchIndex - halfWindow);
  let end = Math.min(cleanText.length, start + maxLength);

  // If we bumped into the end, shift start left
  if (end === cleanText.length) {
    start = Math.max(0, end - maxLength);
  }

  // Adjust start to nearest preceding word boundary (unless 0)
  if (start > 0) {
    start = findWordBoundary(cleanText, start, 'forward');
  }

  // Adjust end to nearest following word boundary (unless length)
  if (end < cleanText.length) {
    end = findWordBoundary(cleanText, end, 'backward');
  }

  let snippet = cleanText.slice(start, end).trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < cleanText.length) snippet = snippet + '...';

  return snippet;
}

function findWordBoundary(text: string, pos: number, direction: 'forward' | 'backward'): number {
  if (pos <= 0) return 0;
  if (pos >= text.length) return text.length;

  if (direction === 'forward') {
    // Look ahead for next space, up to 15 chars
    for (let i = pos; i < Math.min(text.length, pos + 15); i++) {
      if (text[i] === ' ') return i + 1;
    }
    return pos;
  } else {
    // Look back for previous space, up to 15 chars
    for (let i = pos; i > Math.max(0, pos - 15); i--) {
      if (text[i] === ' ') return i;
    }
    return pos;
  }
}

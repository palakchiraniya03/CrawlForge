import { describe, it, expect } from 'vitest';
import {
  tokenize,
  computeTermFrequencies,
  extractSnippet,
  DEFAULT_STOP_WORDS,
} from '../../src/search/tokenizer.js';

describe('tokenize', () => {
  it('lowercases and splits words by punctuation and whitespace', () => {
    const text = 'CrawlForge: Fast, Safe & Reliable Web-Crawler!';
    const tokens = tokenize(text);

    expect(tokens).toContain('crawlforge');
    expect(tokens).toContain('fast');
    expect(tokens).toContain('safe');
    expect(tokens).toContain('reliable');
    expect(tokens).toContain('web');
    expect(tokens).toContain('crawler');
  });

  it('filters out default stop words', () => {
    const text = 'This is a test of the emergency broadcast system';
    const tokens = tokenize(text);

    // 'this', 'is', 'a', 'of', 'the' should be excluded
    expect(tokens).not.toContain('this');
    expect(tokens).not.toContain('is');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('of');
    expect(tokens).not.toContain('the');

    expect(tokens).toEqual(['test', 'emergency', 'broadcast', 'system']);
  });

  it('supports custom stop words list', () => {
    const text = 'apple banana cherry date';
    const customStopWords = new Set(['banana', 'cherry']);
    const tokens = tokenize(text, { stopWords: customStopWords });

    expect(tokens).toEqual(['apple', 'date']);
  });

  it('handles empty, null, and whitespace-only text gracefully', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
    expect(tokenize('   \n\t   ')).toEqual([]);
    expect(tokenize('!!! ??? ,,, ...')).toEqual([]);
  });

  it('respects minLength option', () => {
    const text = 'ai ml deep learning in cs';
    const tokens = tokenize(text, { minLength: 3 });

    // 'ai', 'ml', 'cs' are length 2 -> filtered out
    // 'in' is stop word -> filtered out
    expect(tokens).toEqual(['deep', 'learning']);
  });
});

describe('computeTermFrequencies', () => {
  it('calculates frequency count for each distinct token', () => {
    const tokens = ['crawler', 'search', 'crawler', 'engine', 'crawler', 'engine'];
    const tf = computeTermFrequencies(tokens);

    expect(tf.get('crawler')).toBe(3);
    expect(tf.get('engine')).toBe(2);
    expect(tf.get('search')).toBe(1);
    expect(tf.get('missing')).toBeUndefined();
  });

  it('returns an empty map for empty tokens', () => {
    const tf = computeTermFrequencies([]);
    expect(tf.size).toBe(0);
  });
});

describe('extractSnippet', () => {
  it('returns short text as-is when under maxLength', () => {
    const text = 'Short description.';
    const snippet = extractSnippet(text, ['short'], 100);
    expect(snippet).toBe('Short description.');
  });

  it('locates query token in text and centers snippet with ellipses', () => {
    const text =
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Inverted index is a database data structure. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.';
    const snippet = extractSnippet(text, ['inverted', 'index'], 80);

    expect(snippet).toContain('Inverted index');
    expect(snippet.startsWith('...')).toBe(true);
    expect(snippet.endsWith('...')).toBe(true);
  });

  it('falls back to start of text when query token is not found in body', () => {
    const text =
      'First sentence of the document starts here and provides general background information for readers interested in the subject matter.';
    const snippet = extractSnippet(text, ['unmatchedkeyword'], 60);

    expect(snippet).toContain('First sentence');
    expect(snippet.endsWith('...')).toBe(true);
  });

  it('handles empty or null text safely', () => {
    expect(extractSnippet('', ['test'])).toBe('');
    expect(extractSnippet(null, ['test'])).toBe('');
    expect(extractSnippet(undefined, ['test'])).toBe('');
  });
});

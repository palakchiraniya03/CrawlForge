/**
 * Integration tests for robots.txt handling.
 *
 * Tests:
 * - robots.txt fetch and disallow enforcement
 * - Conservative deny when robots.txt returns an error
 * - Allowed paths are correctly permitted
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isAllowedByRobots, clearRobotsCache } from '../../src/crawler/robotsCache.js';
import { startFixtureServer, FixtureServer } from '../fixtures/fixtureServer.js';

// Note: SSRF_ALLOWED_HOSTS=localhost is set in tests/setup.ts

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await startFixtureServer();
});

afterAll(async () => {
  await fixture.stop();
});

describe('robots.txt handling', () => {
  it('allows an explicitly permitted path', async () => {
    clearRobotsCache();
    const allowed = await isAllowedByRobots(`${fixture.baseUrl}/page-a`);
    expect(allowed).toBe(true);
  });

  it('disallows a path in robots.txt Disallow rule', async () => {
    clearRobotsCache();
    const allowed = await isAllowedByRobots(`${fixture.baseUrl}/secret`);
    expect(allowed).toBe(false);
  });

  it('disallows /admin from robots.txt', async () => {
    clearRobotsCache();
    const allowed = await isAllowedByRobots(`${fixture.baseUrl}/admin`);
    expect(allowed).toBe(false);
  });

  it('conservatively denies when robots.txt host is unavailable', async () => {
    clearRobotsCache();
    // Use a port that is not listening
    const allowed = await isAllowedByRobots('http://localhost:19999/any-path');
    expect(allowed).toBe(false);
  });

  it('denies crawling a loopback URL (SSRF protection in robots fetch)', async () => {
    clearRobotsCache();
    // SSRF blocks the robots.txt fetch → conservative deny
    const allowed = await isAllowedByRobots('http://127.0.0.2/any-path');
    expect(allowed).toBe(false);
  });
});

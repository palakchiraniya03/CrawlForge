/**
 * Vitest global setup for integration tests.
 * Sets environment variables that must be available before any test module loads.
 * This file runs in the same worker context before test files are imported.
 */

// Allow the local test fixture server (runs on localhost) to bypass SSRF
// IP-range checks. This is intentionally empty in production.
process.env.SSRF_ALLOWED_HOSTS = 'localhost';
process.env.ALLOWED_DOMAINS = 'localhost';
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';

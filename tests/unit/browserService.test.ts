import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BrowserService } from '../../src/browser/browserService.js';

describe('BrowserService — Unit Tests', () => {
  let browserService: BrowserService;

  beforeEach(() => {
    browserService = new BrowserService({
      navigationTimeoutMs: 2000,
      actionTimeoutMs: 1000,
      maxTextLength: 500,
    });
  });

  describe('isAvailable()', () => {
    it('returns an availability status object', () => {
      const status = browserService.isAvailable();
      expect(typeof status.available).toBe('boolean');
      if (!status.available) {
        expect(status.reason).toContain('npx playwright install chromium');
      }
    });
  });

  describe('validateTargetUrl()', () => {
    it('rejects empty or non-string URLs', async () => {
      await expect(browserService.validateTargetUrl('')).rejects.toThrow(/Target URL must be a non-empty string/);
      await expect(browserService.validateTargetUrl(null as any)).rejects.toThrow(/Target URL must be a non-empty string/);
    });

    it('rejects invalid URL syntax', async () => {
      await expect(browserService.validateTargetUrl('not_a_valid_url')).rejects.toThrow(/Invalid URL/);
    });

    it('rejects unsupported protocols', async () => {
      await expect(browserService.validateTargetUrl('ftp://example.com')).rejects.toThrow(/Unsupported protocol/);
      await expect(browserService.validateTargetUrl('file:///etc/passwd')).rejects.toThrow(/Unsupported protocol/);
      await expect(browserService.validateTargetUrl('javascript:alert(1)')).rejects.toThrow(/Unsupported protocol/);
    });

    it('rejects internal IP addresses by SSRF policy', async () => {
      // Cloud metadata IP
      await expect(browserService.validateTargetUrl('http://169.254.169.254/latest')).rejects.toThrow(
        /Navigation blocked by SSRF policy/,
      );
      // Private RFC 1918 IPs
      await expect(browserService.validateTargetUrl('http://192.168.1.1/admin')).rejects.toThrow(
        /Navigation blocked by SSRF policy/,
      );
      await expect(browserService.validateTargetUrl('http://10.0.0.1/')).rejects.toThrow(
        /Navigation blocked by SSRF policy/,
      );
    });
  });

  describe('Action Input Validation in executeAction()', () => {
    it('rejects invalid action object', async () => {
      await expect(
        browserService.executeAction('http://example.com', null as any),
      ).rejects.toThrow(/Action must be a valid object/);
    });

    it('rejects unsupported action types', async () => {
      await expect(
        browserService.executeAction('http://example.com', { type: 'eval' as any, label: 'test' }),
      ).rejects.toThrow(/Unsupported action type/);
    });

    it('rejects missing or empty label', async () => {
      await expect(
        browserService.executeAction('http://example.com', { type: 'click', label: '' }),
      ).rejects.toThrow(/Action label is required and cannot be empty/);
      await expect(
        browserService.executeAction('http://example.com', { type: 'click', label: '   ' }),
      ).rejects.toThrow(/Action label is required and cannot be empty/);
    });

    it('rejects fill action without string value', async () => {
      await expect(
        browserService.executeAction('http://example.com', { type: 'fill', label: 'Email' }),
      ).rejects.toThrow(/Action value is required for fill action/);
      await expect(
        browserService.executeAction('http://example.com', { type: 'fill', label: 'Email', value: 123 as any }),
      ).rejects.toThrow(/Action value is required for fill action/);
    });
  });
});

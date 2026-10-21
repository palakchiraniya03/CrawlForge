/**
/**
 * Types and interfaces for the CrawlForge browser automation foundation.
 */

export type BrowserActionType = 'click' | 'fill';

export interface BrowserAction {
  type: BrowserActionType;
  label: string;
  value?: string;
}

export interface VisibleLink {
  text: string;
  href?: string;
}

export interface VisibleButton {
  text: string;
  role?: string;
}

export interface BrowserInspectionResult {
  url: string;
  title: string;
  textContent: string;
  links: VisibleLink[];
  buttons: VisibleButton[];
}

export interface BrowserActionResult {
  action: BrowserAction;
  success: boolean;
  message: string;
  currentUrl: string;
  pageTitle?: string;
  newUrl?: string;
  newTitle?: string;
}

export interface BrowserServiceOptions {
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  maxTextLength?: number;
}

// The real `Pages` served by http.ts, and the Content-Security-Policy their HTML is sent with.

import { createHash } from 'node:crypto';
import type { Pages } from '../types.js';
import { COPY_SCRIPT, landing } from './landing.js';
import { notFound } from './notfound.js';
import { privacy } from './privacy.js';
import { terms } from './terms.js';

export const pages: Pages = { landing, privacy, terms, notFound };

/**
 * Allows exactly what the pages use: same-origin images and fonts, inline styles, and the one copy
 * script by hash. Anything injected later (analytics, a proxy's script) is blocked. JSON-LD is not
 * executed, so it needs no allowance.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  "img-src 'self'",
  "font-src 'self'",
  "style-src 'unsafe-inline'",
  `script-src 'sha256-${createHash('sha256').update(COPY_SCRIPT, 'utf8').digest('base64')}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// The real `Pages` served by http.ts.

import type { Pages } from '../types.js';
import { landing } from './landing.js';
import { notFound } from './notfound.js';
import { privacy } from './privacy.js';
import { terms } from './terms.js';

export const pages: Pages = { landing, privacy, terms, notFound };

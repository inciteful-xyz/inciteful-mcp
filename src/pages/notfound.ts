// The 404 page for unknown paths under /academic/mcp.

import type { PageCtx } from '../types.js';
import { esc, links, shell } from './layout.js';

export function notFound(ctx: PageCtx): string {
  const l = links(ctx);
  const body = `<div class="doc"><div class="wrap">
<h1>Page not found</h1>
<p>There’s nothing at this address. To connect your assistant, use <a href="${esc(l.mcp)}">${esc(l.mcp)}</a>.</p>
<p><a href="${esc(l.mcp)}">Inciteful MCP server</a> · <a href="${esc(l.webApp)}">Inciteful web app</a> · <a href="${esc(l.help)}">Help</a></p>
</div></div>`;
  return shell(ctx, { title: 'Page not found: Inciteful MCP Server', description: 'This page does not exist. The Inciteful MCP server is at its landing page.', canonical: l.mcp, body });
}

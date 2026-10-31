// /academic/mcp/terms: short and specific to the MCP server, because the site terms assume an
// account (spec §4.8).

import type { PageCtx } from '../types.js';
import { esc, links, shell, SUPPORT_EMAIL } from './layout.js';

const TERMS_EFFECTIVE = '2026-10-30';

export function terms(ctx: PageCtx): string {
  const l = links(ctx);
  const body = `<div class="doc"><div class="wrap">
<h1>Terms: Inciteful MCP server</h1>
<p class="muted">Effective ${TERMS_EFFECTIVE}. These terms cover the MCP server at <a href="${esc(l.mcp)}">${esc(l.mcp)}</a>. By connecting to it, you agree to them.</p>

<h2>Acceptable use</h2>
<ul class="plain">
<li>Use it for finding, reading and citing research literature.</li>
<li>Don’t try to get around the rate limits, overload the service, or copy the citation graph in bulk. If you need large-scale access, email us.</li>
<li>Don’t use it to attack, probe or disrupt the service or other people’s use of it.</li>
</ul>

<h2>Fair-use limits</h2>
<p>Requests are rate-limited per caller, and assistants that reach us from their vendor’s servers share one limit per vendor. We may change the limits, or block traffic that harms the service, without notice.</p>

<h2>No warranty</h2>
<p>The service is free and provided “as is”, without warranty of any kind. It may be unavailable, slow or wrong: open bibliographic data has gaps and errors. Check what matters against the original sources. To the extent the law allows, we aren’t liable for any loss arising from its use.</p>

<h2>Data licences</h2>
<p>Paper metadata comes from OpenAlex under CC0. Full text from PubMed Central keeps each article’s own licence, which the result names; follow it when you reuse the text. The server’s code is open source under the MIT licence.</p>

<h2>Not for clinical decisions</h2>
<p>This is a literature discovery tool. It doesn’t give medical advice, and its results must not be used to make clinical or other health decisions.</p>

<h2>Changes and contact</h2>
<p>We may update these terms; the date above changes when we do. Questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. See also the <a href="${esc(l.privacy)}">privacy policy</a>.</p>
</div></div>`;
  return shell(ctx, {
    title: 'Terms: Inciteful MCP Server',
    description: 'Terms for the free Inciteful MCP server: acceptable use, fair-use rate limits, no warranty, data licences, and not for clinical decisions.',
    canonical: l.terms,
    body,
  });
}

// /academic/mcp/privacy, in the librarian rubric's order (spec §4.8). It describes the logging as it
// is: a 90-day usage log without queries, ids or raw IPs, and graph-service logs kept 15 days.

import type { PageCtx } from '../types.js';
import { esc, links, shell, SUPPORT_EMAIL } from './layout.js';

export const PRIVACY_VERSION = '1.0';
export const PRIVACY_EFFECTIVE = '2026-10-30';
const SITE_PRIVACY = 'https://incitefulmed.com/privacy/';

export function privacy(ctx: PageCtx): string {
  const l = links(ctx);
  const body = `<div class="doc"><div class="wrap">
<h1>Privacy: Inciteful MCP server</h1>
<p class="muted">Version ${PRIVACY_VERSION}, effective ${PRIVACY_EFFECTIVE}. Covers the MCP server at <a href="${esc(l.mcp)}">${esc(l.mcp)}</a> and these pages.</p>

<h2>Summary</h2>
<ul class="plain">
<li>You don’t need an account, and we set no cookies.</li>
<li>We keep a usage log for 90 days: which tool was called, by which client, how long it took and how it went. It holds no queries, paper IDs or raw IP addresses.</li>
<li>Our graph service’s own logs may contain the paper IDs and queries it processes. We keep them for up to 15 days, with no IP addresses.</li>
<li>Your requests pass through Cloudflare, and lookups go to OpenAlex and NCBI. Sentry, which monitors our graph service, may receive request addresses that include paper IDs, with no IP addresses. Your assistant’s vendor handles your conversation under its own policy.</li>
<li>Don’t put personal or health details in your prompts.</li>
</ul>

<h2>What we collect</h2>
<div class="table-scroll"><table>
<thead><tr><th>What</th><th>Why</th><th>How long</th></tr></thead>
<tbody>
<tr><td>Usage log, one row per tool call: time, tool name, your client’s name and version (or its User-Agent), duration, outcome (such as ok, error, rate-limited or timeout), graph size and depth, and the number of OpenAlex calls</td><td>To see which tools are used, keep the service healthy and tune fair-use limits</td><td>90 days, then deleted by a daily job</td></tr>
<tr><td>A hash of your IP address in each usage row, salted with a random value that changes every day and is held in memory, never written to disk</td><td>To count distinct callers per day and spot abuse, without storing the address</td><td>90 days, with the usage row. The salt is discarded each day, so hashes can’t be linked across days</td></tr>
<tr><td>Rate-limit rejections, counted per minute and per hashed caller</td><td>To tune fair-use limits</td><td>90 days</td></tr>
<tr><td>Your IP address (or its /64 network for IPv6), in memory</td><td>To apply per-caller rate limits</td><td>In memory until the server restarts or clears idle entries; never written to disk by this server</td></tr>
<tr><td>Our graph service’s own logs: the paper IDs and queries the graph service processes, with no IP addresses</td><td>To run and debug the graph service</td><td>Up to 15 days</td></tr>
<tr><td>Error and performance traces of our graph service, sent to Sentry: request addresses that may include paper IDs, with no IP addresses</td><td>To find errors and slow requests in the graph service</td><td>Under Sentry’s retention policy, up to 90 days</td></tr>
</tbody>
</table></div>

<h2>What we never collect</h2>
<ul class="plain">
<li>Names, email addresses or accounts: there is no sign-in.</li>
<li>Your conversation. We receive the tool calls your assistant makes, not the chat around them.</li>
<li>Queries, SQL, seed papers or paper IDs in the usage log.</li>
<li>Raw IP addresses in the usage log.</li>
<li>Cookies, device fingerprints or advertising identifiers.</li>
</ul>

<h2>Who receives data</h2>
<ul class="plain">
<li><b>Cloudflare</b> (network): carries every request to us, as it does for the rest of incitefulmed.com.</li>
<li><b>OpenAlex</b>: receives the search terms and paper IDs needed to look up papers.</li>
<li><b>NCBI</b> (PubMed Central): receives the article ID when full text is requested.</li>
<li><b>Sentry</b> (error and performance monitoring for our graph service): may receive request addresses that include paper IDs, with no IP addresses; kept under Sentry’s retention policy (up to 90 days).</li>
<li><b>Hosting:</b> our servers run at Hetzner and Google Cloud.</li>
<li><b>Your assistant’s vendor</b> (for example Anthropic, OpenAI or Cursor): decides which tool calls to make and receives the results, under its own privacy policy.</li>
</ul>
<p>We don’t sell data or share it with advertisers.</p>

<h2>Cookies and analytics</h2>
<p>None. The MCP server and these pages set no cookies and load no analytics, tracking pixels or third-party scripts.</p>

<h2>Retention and deletion</h2>
<p>Usage rows are deleted after 90 days by a daily job. Our graph service’s own logs are kept for up to 15 days. Graph-service traces sent to Sentry are kept under Sentry’s retention policy, up to 90 days. The daily salt lives in memory and is replaced each day. Once the day’s salt is discarded, we can’t turn a hash back into an IP address or tie your rows to you. For the same reason we can’t find the rows of a particular person, but you can still contact us with any request.</p>

<h2>Your choices</h2>
<ul class="plain">
<li>You can use the server without an account, and remove it from your assistant at any time.</li>
<li>Keep personal or health details out of your prompts: your assistant may pass words from them on as search terms.</li>
<li>Your assistant’s vendor has its own settings for chat history and data use.</li>
</ul>

<h2>How this relates to the site-wide policy</h2>
<p>The <a href="${SITE_PRIVACY}">incitefulmed.com privacy policy</a> covers Inciteful Med’s website and app, which use accounts. This page covers the MCP server and its pages, which don’t; where the two differ for this service, this page applies.</p>

<h2>Effective date and version</h2>
<p>Version ${PRIVACY_VERSION}, effective ${PRIVACY_EFFECTIVE}. When this policy changes, the version and date here change with it.</p>

<h2>Contact</h2>
<p>Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> with any question or request about this policy.</p>
</div></div>`;
  return shell(ctx, {
    title: 'Privacy: Inciteful MCP Server',
    description: 'What the Inciteful MCP server logs, for how long, and who receives data: no account or cookies, a 90-day usage log without queries or raw IP addresses.',
    canonical: l.privacy,
    body,
  });
}

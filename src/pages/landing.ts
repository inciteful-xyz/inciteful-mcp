// The landing page at /academic/mcp (spec §4.8, layout A): install first, everything else below.

import { readFileSync } from 'node:fs';
import { coverageNote } from '../provenance.js';
import type { PageCtx } from '../types.js';
import { esc, GITHUB_URL, links, ORGANIZATION_ID, shell, WEBSITE_ID, type Links } from './layout.js';

export const LANDING_TITLE = 'Inciteful MCP Server: Citation Graph for AI Assistants';
const H1 = 'Inciteful MCP: the citation graph inside your AI assistant';
export const LANDING_DESCRIPTION =
  "Connect Claude, ChatGPT, Cursor or any MCP client to Inciteful's citation graph. Free, no login: find similar papers, chase citations and export BibTeX.";
const BADGES = ['Free', 'No account', 'OpenAlex metadata (CC0)', 'Open-source server (MIT)'];

/** When the client steps below were last checked against each vendor's docs. */
const STEPS_CHECKED = '2026-10-30';

type Example = { placeholder: boolean; label: string; turns: Array<{ role: 'user' | 'tool' | 'assistant'; text: string }> };
/** A placeholder until the launch checklist swaps in a real run (spec §4.8). */
const EXAMPLE = JSON.parse(readFileSync(new URL('../../assets/example.json', import.meta.url), 'utf8')) as Example;

type Client = { id: string; name: string; steps: (l: Links) => string; source: { url: string; label: string } };

const b = (s: string) => `<b>${s}</b>`;
const pre = (s: string) => `<pre><code>${esc(s)}</code></pre>`;

const CLIENTS: Client[] = [
  {
    id: 'claude', name: 'Claude',
    steps: l => `<ol>
<li>In Claude, open ${b('Customize → Connectors')}, click ${b('+ Add')}, then ${b('Add custom connector')}.</li>
<li>Name it “Inciteful”, paste <code>${esc(l.mcp)}</code> as the server URL, and continue.</li>
<li>Under ${b('Authentication')}, choose ${b('No sign in')}, then click ${b('Add')}.</li>
<li>In a chat, click ${b('+')}, open ${b('Connectors')} and turn Inciteful on.</li>
<li>Ask: <i>“Using Inciteful, find papers similar to 10.1038/nature14539.”</i></li>
</ol>
<p class="muted">Free plans allow one custom connector. On Team and Enterprise plans, an owner adds it under ${b('Organization settings → Connectors')}, and members connect it from ${b('Customize → Connectors')}.</p>`,
    source: { url: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp', label: 'Anthropic’s custom connector guide' },
  },
  {
    id: 'chatgpt', name: 'ChatGPT',
    steps: l => `<ol>
<li>Open ChatGPT’s Plugins page (chatgpt.com/plugins), select the ${b('+')} button, then ${b('Add custom MCP server')}.</li>
<li>Enter the name “Inciteful” and a short description. Under ${b('Connection')}, choose a public endpoint and paste <code>${esc(l.mcp)}</code>.</li>
<li>For authentication, pick the option without sign-in: Inciteful needs no account. Review the warning, select ${b('I understand and want to continue')}, then ${b('Create as a plugin')}.</li>
<li>In a new chat, type ${b('@')}, pick Inciteful and ask your question.</li>
</ol>
<p class="muted">Account and workspace policies decide whether you can add custom MCP servers. In a business workspace, an admin may need to allow it.</p>`,
    source: { url: 'https://developers.openai.com/plugins/deploy/connect-chatgpt', label: 'OpenAI’s guide to connecting an MCP server' },
  },
  {
    id: 'cursor', name: 'Cursor',
    steps: l => `<ol>
<li>Open <code>~/.cursor/mcp.json</code> for all your projects, or <code>.cursor/mcp.json</code> in one project.</li>
<li>Add the server:${pre(JSON.stringify({ mcpServers: { inciteful: { url: l.mcp } } }, null, 2))}</li>
<li>Save the file. Inciteful appears with your MCP servers under ${b('Customize')} in the sidebar, where you can turn it on or off.</li>
</ol>`,
    source: { url: 'https://cursor.com/docs/mcp', label: 'Cursor’s MCP docs' },
  },
  {
    id: 'claude-code', name: 'Claude Code',
    steps: l => `<ol>
<li>Run:${pre(`claude mcp add --transport http inciteful ${l.mcp}`)}</li>
<li>That adds it for the current project. Add <code>--scope user</code> to use it in all your projects.</li>
<li>Start <code>claude</code> and ask, for example: <i>“Using Inciteful, find the important papers around 10.1038/nature14539.”</i></li>
</ol>`,
    source: { url: 'https://code.claude.com/docs/en/mcp', label: 'Claude Code’s MCP docs' },
  },
  {
    id: 'vscode', name: 'VS Code',
    steps: l => `<ol>
<li>Open the Command Palette and run ${b('MCP: Add Server')}, then choose ${b('HTTP (HTTP or Server-Sent Events)')}.</li>
<li>Paste <code>${esc(l.mcp)}</code>, enter the ID <code>inciteful</code>, and choose where to save it (${b('Global')} makes it available in every workspace).</li>
<li>Or add it to <code>.vscode/mcp.json</code> yourself:${pre(JSON.stringify({ servers: { inciteful: { type: 'http', url: l.mcp } } }, null, 2))}</li>
<li>Ask your question in the Chat view.</li>
</ol>`,
    source: { url: 'https://code.visualstudio.com/docs/agent-customization/mcp-servers', label: 'VS Code’s MCP server docs' },
  },
  {
    id: 'other', name: 'Other clients',
    steps: l => `<ol>
<li>Add a remote MCP server with the URL <code>${esc(l.mcp)}</code>. The transport is Streamable HTTP.</li>
<li>Leave authentication empty: no API key, header or sign-in.</li>
<li>Clients configured with JSON often take <code>{"mcpServers": {"inciteful": {"url": "…"}}}</code>, but key names vary, so check your client’s docs.</li>
</ol>`,
    source: { url: 'https://modelcontextprotocol.io/specification/2026-07-28/basic/transports', label: 'the MCP transport specification' },
  },
];

function clientPanels(l: Links): string {
  const inputs = CLIENTS.map((c, i) =>
    `<input type="radio" name="client" id="c-${c.id}"${i === 0 ? ' checked' : ''}><label for="c-${c.id}">${c.name}</label>`).join('\n');
  const panels = CLIENTS.map(c => `<section class="panel" id="p-${c.id}" aria-labelledby="h-${c.id}">
<h3 id="h-${c.id}">${c.name}</h3>
${c.steps(l)}
<p class="checked">Steps checked on ${STEPS_CHECKED} against <a href="${esc(c.source.url)}">${c.source.label}</a>.</p>
</section>`).join('\n');
  return `<div class="clients" role="group" aria-label="Setup steps by client">
${inputs}
<div class="panels">
${panels}
</div>
</div>`;
}

const TILES: Array<{ title: string; text: string; tools: string; ask?: string }> = [
  { title: 'Find similar papers, fast', text: 'Rank papers by citation-pattern similarity to one seed paper or several.', tools: 'find_similar_papers', ask: 'What else should I read like these three papers?' },
  { title: 'Explore the citation network', text: 'Build the citation network two steps out from your seeds, then rank the important, similar, review and recent papers, plus authors, journals and institutions. Each seed’s references and citations are there too.', tools: 'explore_citation_network', ask: 'Which foundational papers am I missing?' },
  { title: 'Connect two papers', text: 'Show the citation paths and bridge papers between two works, even across fields.', tools: 'connect_papers', ask: 'How does this physics paper connect to that ecology one?' },
  { title: 'Ask the graph in SQL', text: 'Run your own SELECT query over the network, with the same engine as the web app’s SQL view.', tools: 'query_citation_graph', ask: 'Top authors since 2020 by PageRank in this network.' },
  { title: 'Find and read papers', text: 'Search by topic, fetch up to 100 records with abstracts, and read open-access full text from PubMed Central.', tools: 'search_literature · get_papers · read_paper' },
  { title: 'Export citations', text: 'Export BibTeX or RIS (for Zotero, EndNote and others).', tools: 'export_citations', ask: 'Export the top 30 as BibTeX.' },
];

function tiles(): string {
  return TILES.map(t => `<div class="tile"><h3>${esc(t.title)}</h3><p>${esc(t.text)}</p><code>${esc(t.tools)}</code>${t.ask ? `<q>“${esc(t.ask)}”</q>` : ''}</div>`).join('\n');
}

function example(): string {
  const turns = EXAMPLE.turns.map(t => {
    if (t.role === 'user') return `<p class="u">${esc(t.text)}</p>`;
    if (t.role === 'tool') return `<p class="tool">→ ${esc(t.text)}</p>`;
    return `<p>${esc(t.text)}</p>`;
  }).join('\n');
  return `<div class="chat"${EXAMPLE.placeholder ? ' data-placeholder' : ''}>
${turns}
<p class="label">${esc(EXAMPLE.label)}</p>
</div><!-- /chat -->`;
}

const SAMPLE_PROVENANCE = `"provenance": {
  "retrieved_at": "2026-10-30T18:02:11Z",
  "tool": "explore_citation_network",
  "data_source": "OpenAlex metadata (CC0)
                  via Inciteful's citation graph",
  "graph_snapshot": "2026-10-15",
  "seeds": [
    { "input": "10.1038/nature14539",
      "openalex_id": "W2919115771" }
  ],
  "graph": {
    "papers": 18240,
    "depth": 2,
    "prune_threshold": 10000,
    "highly_cited_not_expanded": 3
  },
  "method": "page_rank (local)",
  "filters": { "title_all": ["learning"] },
  "sql_executed": "SELECT ... LIMIT 25"
}`;

function jsonLd(l: Links): string {
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': `${l.mcp}#software`,
        name: 'Inciteful MCP Server',
        description: LANDING_DESCRIPTION,
        url: l.mcp,
        installUrl: l.mcp,
        applicationCategory: 'ReferenceApplication',
        operatingSystem: 'Any',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        isAccessibleForFree: true,
        license: 'https://opensource.org/licenses/MIT',
        image: l.assetUrl('og.png'),
        sameAs: [GITHUB_URL],
        publisher: { '@id': ORGANIZATION_ID },
        isPartOf: { '@id': WEBSITE_ID },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Inciteful', item: l.site },
          { '@type': 'ListItem', position: 2, name: 'Inciteful Academic', item: l.webApp },
          { '@type': 'ListItem', position: 3, name: 'MCP server', item: l.mcp },
        ],
      },
    ],
  };
  // `<` escaped, so no value can close the script element.
  return `<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, '\\u003c')}</script>\n`;
}

/** Progressive enhancement: the URL is selectable text; the button appears only when it can work. */
const COPY_SCRIPT = `(function(){var b=document.getElementById('copy'),u=document.getElementById('mcp-url');if(!b||!u||!navigator.clipboard)return;b.hidden=false;b.addEventListener('click',function(){navigator.clipboard.writeText(u.textContent.trim()).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1600)},function(){})})})();`;

/** Escaped, with line-break opportunities after single slashes, so the URL wraps at path segments. */
const breakable = (url: string) => esc(url).replace(/(?<=[^/])\/(?=[^/])/g, '/<wbr>');

export function landing(ctx: PageCtx): string {
  const l = links(ctx);
  const snapshot = ctx.snapshot ?? 'snapshot date unavailable';
  const body = `<section class="hero"><div class="wrap">
<h1>${H1}</h1>
<p class="sub">Connect Claude, ChatGPT, Cursor or any MCP client to Inciteful. It snowballs from seed papers, finds the important and review papers around them, and traces the paths between two papers. It’s free, needs no login, and runs on open OpenAlex data.</p>
<p class="url-label" id="url-label">Add this URL to your assistant as a remote MCP server:</p>
<div class="url"><code id="mcp-url" aria-labelledby="url-label">${breakable(l.mcp)}</code><button type="button" id="copy" hidden>Copy</button></div>
${clientPanels(l)}
<ul class="badges" aria-label="At a glance">${BADGES.map(x => `<li>${x}</li>`).join('')}</ul>
</div></section>

<section class="sec"><div class="wrap">
<h2>What you can ask it to do</h2>
<div class="grid">
${tiles()}
</div>
<p class="muted">It also includes a literature-review prompt, <code>literature_review</code>, that runs the iterative snowball with you: resolve your seeds, find similar papers, agree 3–5 seeds, explore the network, read the finalists’ abstracts, then write with a DOI for every paper.</p>
</div></section>

<section class="sec alt"><div class="wrap">
<h2>See it work</h2>
${example()}
</div></section>

<section class="sec"><div class="wrap">
<h2>How it ranks, and how you can report it</h2>
<div class="cols">
<div>
<p>Use it to report citation searching (PRISMA-S, TARCiS).</p>
<ul class="plain">
<li><b>Similar:</b> <a href="${esc(l.methods('adamic-adar'))}">Adamic/Adar</a> bibliographic coupling. Shared niche references count more than shared popular ones.</li>
<li><b>Co-citation:</b> the <a href="${esc(l.methods('salton'))}">Salton index</a>, normalized so famous papers don’t dominate.</li>
<li><b>Important:</b> <a href="${esc(l.methods('pagerank'))}">PageRank</a> inside your local network, not global citation counts.</li>
<li><b>Fast similarity:</b> <a href="${esc(l.methods('fast-similarity'))}">one step out</a> from the seeds, for quick answers.</li>
<li><b>Connector:</b> <a href="${esc(l.methods('connector'))}">shortest undirected citation paths</a> between two papers.</li>
</ul>
<p class="muted">Every result names the method that ranked it and carries a provenance block. The fields are explained on the <a href="${esc(l.methods('provenance-fields'))}">methods page</a>.</p>
</div>
<div>
<pre>${esc(SAMPLE_PROVENANCE)}</pre>
<p class="muted">Paste it into the methods appendix of a PRISMA-S or TARCiS report.</p>
</div>
</div>
</div></section>

<section class="sec alt"><div class="wrap">
<h2>Data, coverage and limits</h2>
<ul class="plain">
<li><b>Graph snapshot: ${esc(snapshot)}</b>. ${esc(coverageNote(ctx.snapshot, ctx.recentTier))}</li>
<li><b>Title filters match paper titles only</b> (not abstracts or full text), with Porter stemming. The tools say so, so your assistant won’t over-filter.</li>
<li>Very highly cited papers aren’t expanded, which keeps graphs a usable size. When that happens, the result says how many.</li>
<li><b>Licences:</b> metadata is OpenAlex CC0; full text from PubMed Central carries each article’s own licence, which the result names.</li>
<li>Retraction and preprint flags from OpenAlex are passed through. Metadata errors in open indexes can still occur.</li>
<li><b>Fair-use limits:</b> per-caller rate limits keep it free for everyone.</li>
</ul>
</div></section>

<section class="sec"><div class="wrap">
<h2>Privacy</h2>
<ul class="plain">
<li>No account, no sign-in and no cookies.</li>
<li>Our usage log keeps, for 90 days, one row per tool call: the tool name, your client’s name and version, how long it took, the outcome and the graph size. Your IP address is stored as a hash with a salt that changes every day. The usage log holds no queries, paper IDs or raw IP addresses.</li>
<li>Our graph service’s logs may contain the paper IDs and queries it processes. They’re kept for up to 15 days, with no IP addresses.</li>
<li>Data goes to Cloudflare (network), OpenAlex (search terms and IDs), NCBI (full text) and your assistant’s vendor, under its own policy.</li>
<li>Don’t put personal or health details in your prompts.</li>
</ul>
<p class="muted"><a href="${esc(l.privacy)}">Full privacy policy</a> · <a href="${esc(l.terms)}">Terms</a></p>
</div></section>

<section class="sec alt"><div class="wrap">
<h2>Works well with</h2>
<p>Zotero, EndNote and other reference managers, through the BibTeX and RIS export; and the <a href="${esc(l.webApp)}">Inciteful web app</a>, where every result links to an interactive graph you can keep exploring.</p>
</div></section>

<section class="sec"><div class="wrap">
<h2>FAQ</h2>
<details open><summary>Is this the same Inciteful as inciteful.xyz?</summary><p>Yes. Inciteful now lives at incitefulmed.com/academic. The web app, the graph and the methods are unchanged, and it’s still free.</p></details>
<details><summary>Who builds it, and why is it free?</summary><p>The team behind Inciteful and Inciteful Med builds it. Inciteful has been free since it started; the MCP server runs on the same citation graph service as the web app, and fair-use limits keep the cost manageable.</p></details>
<details><summary>Why is it on a medical domain?</summary><p>Inciteful Academic moved to incitefulmed.com/academic, next to Inciteful Med. The graph covers every field in OpenAlex, not just medicine.</p></details>
<details><summary>Which assistants work?</summary><p>Claude (web, desktop, mobile and Claude Code), ChatGPT where your plan allows custom MCP servers, Cursor, VS Code, and any client that supports remote MCP over Streamable HTTP.</p></details>
<details><summary>My assistant didn’t use Inciteful.</summary><p>Name it in your prompt, for example “Using Inciteful…”. Assistants often default to web search.</p></details>
<details><summary>Why are some recent papers missing?</summary><p>${esc(coverageNote(ctx.snapshot, ctx.recentTier))}</p></details>
<details><summary>Why did I hit a rate limit?</summary><p>Every Claude user shares one rate-limit bucket, because Claude’s requests reach us from Anthropic’s servers; the same goes for ChatGPT and OpenAI’s servers. If you see a rate-limit error, wait a minute and retry.</p></details>
<details><summary>What happens if the service is down?</summary><p>If the server is down, so is the search. The MCP server runs as a single service with no standby, so your assistant will report a connection error until it’s back; try again a little later.</p></details>
<details><summary>Is it open source?</summary><p>The server is, under the MIT licence, <a href="${GITHUB_URL}">on GitHub</a>. It calls Inciteful’s hosted graph service to build citation graphs, and that service isn’t part of the repository.</p></details>
</div></section>`;
  return shell(ctx, { title: LANDING_TITLE, description: LANDING_DESCRIPTION, canonical: l.mcp, body, head: jsonLd(l), script: COPY_SCRIPT });
}

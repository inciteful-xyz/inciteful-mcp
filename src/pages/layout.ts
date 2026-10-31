// Shared page shell: head (meta, Open Graph, fonts), header, footer and styles. Pages are static
// HTML with inline CSS; nothing loads from another origin, and there are no cookies or analytics.

import type { PageCtx } from '../types.js';

/** Swapped for the real address by the launch checklist (spec §8). */
export const SUPPORT_EMAIL = '{{SUPPORT_EMAIL}}';
export const GITHUB_URL = 'https://github.com/inciteful-xyz/inciteful-mcp';
/** The site-wide Organization and WebSite nodes, declared by incitefulmed.com's home page. */
export const ORGANIZATION_ID = 'https://incitefulmed.com/#organization';
export const WEBSITE_ID = 'https://incitefulmed.com/#website';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escapes text and attribute values. */
export function esc(value: string): string {
  return value.replace(/[&<>"']/g, c => ESCAPES[c]);
}

/** URLs the pages link to, all derived from `publicBaseUrl`. */
export type Links = {
  /** The MCP endpoint and landing page, e.g. https://incitefulmed.com/academic/mcp */
  mcp: string;
  privacy: string;
  terms: string;
  /** Root-relative asset path, so staging serves its own copies. */
  asset(name: string): string;
  /** Absolute asset URL, for Open Graph. */
  assetUrl(name: string): string;
  webApp: string;
  help: string;
  methods(anchor?: string): string;
  site: string;
};

export function links(ctx: PageCtx): Links {
  const mcp = ctx.publicBaseUrl.href.replace(/\/+$/, '');
  const path = ctx.publicBaseUrl.pathname.replace(/\/+$/, '');
  const origin = ctx.publicBaseUrl.origin;
  return {
    mcp,
    privacy: `${mcp}/privacy`,
    terms: `${mcp}/terms`,
    asset: name => `${path}/assets/${name}`,
    assetUrl: name => `${mcp}/assets/${name}`,
    webApp: `${origin}/academic/`,
    help: `${origin}/academic/help/`,
    methods: anchor => `${origin}/academic/help/methods${anchor ? `#${anchor}` : ''}`,
    site: `${origin}/`,
  };
}

export type ShellOpts = {
  title: string;
  description: string;
  canonical: string;
  body: string;
  /** Extra head markup (JSON-LD). Must already be safe. */
  head?: string;
  /** The one inline script allowed, placed at the end of the body. Must already be safe. */
  script?: string;
};

export function shell(ctx: PageCtx, opts: ShellOpts): string {
  const l = links(ctx);
  const og = l.assetUrl('og.png');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="canonical" href="${esc(opts.canonical)}">
<link rel="icon" href="${esc(l.asset('favicon.svg'))}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${esc(l.asset('icon.png'))}">
<link rel="preload" href="${esc(l.asset('dm-sans-latin-wght-normal.woff2'))}" as="font" type="font/woff2" crossorigin>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Inciteful">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:url" content="${esc(opts.canonical)}">
<meta property="og:image" content="${esc(og)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Inciteful MCP: the citation graph inside your AI assistant">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(opts.title)}">
<meta name="twitter:description" content="${esc(opts.description)}">
<meta name="twitter:image" content="${esc(og)}">
<style>${styles(l)}</style>
${opts.head ?? ''}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav"><div class="wrap">
<a class="brand" href="${esc(l.mcp)}"><img src="${esc(l.asset('favicon.svg'))}" alt="" width="26" height="25"> Inciteful <span>MCP</span></a>
<nav aria-label="Inciteful"><a href="${esc(l.webApp)}">Web app</a><a href="${esc(l.methods())}">Methods</a><a href="${esc(l.help)}">Help</a><a href="${GITHUB_URL}">GitHub</a></nav>
</div></header>
<main id="main">
${opts.body}
</main>
<footer class="foot"><div class="wrap">
<span>Inciteful · free literature discovery</span>
<a href="${esc(l.webApp)}">Open the web app</a>
<a href="${GITHUB_URL}">GitHub</a>
<a href="${esc(l.methods())}">Methods</a>
<a href="${esc(l.privacy)}">Privacy</a>
<a href="${esc(l.terms)}">Terms</a>
<span>Support: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></span>
</div></footer>
${opts.script ? `<script>${opts.script}</script>\n` : ''}</body>
</html>
`;
}

function styles(l: Links): string {
  return `
@font-face{font-family:'DM Sans';font-style:normal;font-display:swap;font-weight:100 1000;src:url(${l.asset('dm-sans-latin-wght-normal.woff2')}) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'DM Sans';font-style:normal;font-display:swap;font-weight:100 1000;src:url(${l.asset('dm-sans-latin-ext-wght-normal.woff2')}) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
:root{--violet:#5613BF;--violet-2:#6b3bc5;--ink:#1d1530;--muted:#5d536e;--line:#ebe5f5;--tint:#faf8fe;--pink:#efe7fc;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
html{font-size:16px;-webkit-text-size-adjust:100%}
body{margin:0;font-family:'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:1rem;line-height:1.6;color:var(--ink);background:#fff}
a{color:var(--violet)}
a:hover{color:var(--violet-2)}
:focus-visible{outline:3px solid var(--violet);outline-offset:2px}
code,pre{font-family:var(--mono)}
.wrap{max-width:920px;margin:0 auto;padding:0 20px}
.skip{position:absolute;left:-9999px}.skip:focus{left:12px;top:12px;background:#fff;padding:6px 10px;z-index:2}
.nav{border-bottom:1px solid #eee}
.nav .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px 18px;padding-top:12px;padding-bottom:12px}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:1.1rem;color:var(--ink);text-decoration:none}
.brand span{color:var(--violet)}
.nav nav{display:flex;flex-wrap:wrap;gap:4px 18px}
.nav nav a{color:var(--muted);text-decoration:none;font-size:.95rem}
.nav nav a:hover{color:var(--violet)}
.hero{background:linear-gradient(135deg,#f5effd,#fff 70%);padding:40px 0 34px}
h1{font-size:2.1rem;line-height:1.15;margin:0 0 12px;letter-spacing:-.01em}
h2{font-size:1.4rem;line-height:1.25;margin:0 0 14px}
h3{font-size:1.05rem;margin:0 0 6px}
.sub{color:#4a4060;font-size:1.1rem;margin:0 0 22px;max-width:46em}
.url{display:flex;flex-wrap:wrap;gap:10px;align-items:center;background:var(--ink);color:#fff;border-radius:10px;padding:12px 14px}
.url code{flex:1 1 16em;min-width:0;font-size:1rem;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all}
.url button{font:inherit;font-weight:600;font-size:.95rem;background:var(--violet);color:#fff;border:0;border-radius:7px;padding:6px 16px;cursor:pointer}
.url button:hover{background:var(--violet-2)}
.url-label{font-size:.9rem;color:var(--muted);margin:0 0 6px}
.clients{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0 0}
.clients>input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.clients>label{border:1px solid #d8cdf0;border-radius:999px;padding:4px 14px;font-size:.92rem;background:#fff;cursor:pointer;user-select:none}
.clients>input:checked+label{background:var(--violet);color:#fff;border-color:var(--violet)}
.clients>input:focus-visible+label{outline:3px solid var(--violet);outline-offset:2px}
.panels{flex:1 1 100%;margin-top:6px}
.panel{display:none;background:#fff;border:1px solid #e6def5;border-radius:10px;padding:14px 18px}
${['claude', 'chatgpt', 'cursor', 'claude-code', 'vscode', 'other'].map(id => `#c-${id}:checked~.panels #p-${id}`).join(',')}{display:block}
.panel h2{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.panel ol{margin:0;padding-left:1.3em}
.panel li{margin:2px 0}
.panel pre{background:#f5f1fb;color:var(--ink);border-radius:7px;padding:10px 12px;margin:8px 0;font-size:.85rem;white-space:pre-wrap;overflow-wrap:anywhere}
.panel code{font-size:.9em;overflow-wrap:anywhere}
.checked{font-size:.82rem;color:var(--muted);margin:10px 0 0}
.badges{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0;margin:18px 0 0}
.badges li{font-size:.9rem;color:var(--violet);background:var(--pink);border-radius:999px;padding:3px 12px}
.sec{padding:38px 0;border-top:1px solid #f0edf5}
.sec.alt{background:var(--tint)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.tile{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:#fff}
.tile p{margin:0}
.tile code{display:block;font-size:.8rem;color:var(--violet);margin-top:6px;overflow-wrap:anywhere}
.tile q{display:block;color:#6b5f80;font-style:italic;margin-top:6px;quotes:none}
.chat{border:1px solid #e3dcf0;border-radius:12px;padding:16px;background:#fff;max-width:44em}
.chat p{margin:0 0 10px}
.chat .u{background:#ece6f7;border-radius:12px;padding:10px 14px;margin-left:auto;max-width:36em}
.chat .tool{font-family:var(--mono);font-size:.85rem;color:var(--violet)}
.chat .label{font-size:.82rem;color:var(--muted);margin:0}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:22px;align-items:start}
.sec pre{font-size:.8rem;background:var(--ink);color:#e9e2f7;border-radius:10px;padding:14px 16px;margin:0;white-space:pre;overflow-x:auto}
.muted{color:var(--muted);font-size:.92rem}
ul.plain{margin:0;padding-left:1.2em}
ul.plain li{margin:4px 0}
details{border-bottom:1px solid #eee;padding:10px 0}
summary{font-weight:600;cursor:pointer}
details p{margin:8px 0 0}
.doc{padding:34px 0 48px}
.doc h2{margin-top:30px}
.doc table{width:100%;border-collapse:collapse;font-size:.95rem;margin:6px 0}
.doc th,.doc td{border-bottom:1px solid #eee;padding:8px;text-align:left;vertical-align:top}
.doc th{background:#f5f1fb}
.table-scroll{overflow-x:auto}
.foot{background:var(--ink);color:#cfc2ea;font-size:.92rem;padding:22px 0}
.foot .wrap{display:flex;flex-wrap:wrap;gap:8px 20px}
.foot a{color:#fff}
@media (max-width:520px){h1{font-size:1.65rem}.hero{padding-top:28px}.sec{padding:30px 0}}
`;
}

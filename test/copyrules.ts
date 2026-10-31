// Copy rules and text helpers shared by the page tests and the README test, so a new rule
// applies to both at once.

/** Fixed spec phrases that legitimately contain "only", removed as whole phrases before the check. */
export const ALLOWED = ['looked up live only when named', 'titles only'];
/** No "first" or "only", and no claim that searches aren't logged. */
export const BANNED = /n[o'’]?t log|n.t logged|never log|no logging|without logging|unlogged|no logs?\b|nothing (?:is |gets |will be )?logged|first|only/i;
/** No compliance claims. */
export const COMPLIANCE = /hipaa|gdpr|complian|certified/i;

/** The first copy-rule violation in `text`, with 40 characters of context either side, or null. */
export function copyRuleHit(text: string): string | null {
  let rest = text;
  for (const phrase of ALLOWED) rest = rest.split(phrase).join(' ');
  for (const re of [BANNED, COMPLIANCE]) {
    const hit = re.exec(rest);
    if (hit) return rest.slice(Math.max(0, hit.index - 40), hit.index + 40);
  }
  return null;
}

export const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** The text a reader sees: no scripts, styles, tags or attributes; entities decoded; spaces collapsed. */
export function visibleText(html: string): string {
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decode(stripped).replace(/\s+/g, ' ').trim();
}

export function scripts(html: string): Array<{ attrs: string; body: string }> {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map(m => ({ attrs: m[1], body: m[2] }));
}

/** Copy a reader or a search engine sees: visible text, meta and alt text, and JSON-LD strings. */
export function allCopy(html: string): string {
  const attrs = [...html.matchAll(/\b(?:content|alt)="([^"]*)"/g)].map(m => decode(m[1]));
  const ld: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') ld.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const s of scripts(html).filter(s => /type="application\/ld\+json"/.test(s.attrs))) walk(JSON.parse(s.body));
  return [visibleText(html), ...attrs, ...ld].join(' \n ');
}

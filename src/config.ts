import { inspect } from 'node:util';

export interface Config { graphPrimary: URL; graphSecondary: URL; openalexKey: string; publicBaseUrl: URL; usageDbPath: string }

// Every variable is required. There are no defaults, so a misconfigured pod fails at startup
// instead of silently calling the wrong server. Error messages name the variable, never its value.
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

function httpUrl(env: NodeJS.ProcessEnv, name: string): URL {
  const raw = required(env, name);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${name} must be an http(s) URL`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be an http(s) URL`);
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  if (url.search || url.hash) throw new Error(`${name} must not contain a query string or fragment`);
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const graphPrimary = httpUrl(env, 'GRAPH_API_PRIMARY_URL');
  const graphSecondary = httpUrl(env, 'GRAPH_API_SECONDARY_URL');
  const openalexKey = required(env, 'OPENALEX_ACADEMIC_API_KEY');
  const publicBaseUrl = httpUrl(env, 'PUBLIC_BASE_URL');
  const usageDbPath = required(env, 'USAGE_DB_PATH');
  const visible = () => ({ graphPrimary: graphPrimary.href, graphSecondary: graphSecondary.href, openalexKey: '[redacted]', publicBaseUrl: publicBaseUrl.href, usageDbPath });
  const config = { graphPrimary, graphSecondary, publicBaseUrl, usageDbPath } as Config;
  // Non-enumerable, so a spread or Object.entries drops the key; toJSON and inspect redact it.
  Object.defineProperties(config, {
    // A getter over the closure: even inspect with customInspect: false shows [Getter], not the value.
    openalexKey: { get: () => openalexKey, enumerable: false },
    toJSON: { value: visible, enumerable: false },
    [inspect.custom]: { value: () => visible(), enumerable: false },
  });
  return Object.freeze(config);
}

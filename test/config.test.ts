import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { loadConfig } from '../src/config.js';

const SENTINEL = 'sentinel-key-6f1c2a';

const valid = (): NodeJS.ProcessEnv => ({
  GRAPH_API_PRIMARY_URL: 'http://graph-api-1s.inciteful-med.svc:8080',
  GRAPH_API_SECONDARY_URL: 'http://graph-api-2s.inciteful-med.svc:8080',
  OPENALEX_ACADEMIC_API_KEY: SENTINEL,
  PUBLIC_BASE_URL: 'https://incitefulmed.com/academic',
  USAGE_DB_PATH: '/data/usage.sqlite',
});

const NAMES = ['GRAPH_API_PRIMARY_URL', 'GRAPH_API_SECONDARY_URL', 'OPENALEX_ACADEMIC_API_KEY', 'PUBLIC_BASE_URL', 'USAGE_DB_PATH'];

test('loads a valid environment', () => {
  const config = loadConfig(valid());
  assert.equal(config.graphPrimary.href, 'http://graph-api-1s.inciteful-med.svc:8080/');
  assert.equal(config.graphSecondary.href, 'http://graph-api-2s.inciteful-med.svc:8080/');
  assert.equal(config.openalexKey, SENTINEL);
  assert.equal(config.publicBaseUrl.href, 'https://incitefulmed.com/academic');
  assert.equal(config.usageDbPath, '/data/usage.sqlite');
});

test('fails_on_each_missing_var', () => {
  for (const name of NAMES) {
    const env = valid();
    delete env[name];
    assert.throws(() => loadConfig(env), { message: `missing required env var: ${name}` });
  }
});

test('rejects_blank', () => {
  for (const name of NAMES) {
    for (const blank of ['', '   ']) {
      assert.throws(() => loadConfig({ ...valid(), [name]: blank }), { message: `missing required env var: ${name}` });
    }
  }
});

test('rejects_url_with_credentials', () => {
  for (const name of ['GRAPH_API_PRIMARY_URL', 'GRAPH_API_SECONDARY_URL', 'PUBLIC_BASE_URL']) {
    for (const bad of ['https://user:pass@example.com', 'https://user@example.com', 'ftp://example.com', 'not a url']) {
      assert.throws(() => loadConfig({ ...valid(), [name]: bad }), (error: Error) => {
        assert.match(error.message, new RegExp(`^${name} `));
        assert.doesNotMatch(error.message, /user|pass|example\.com|ftp|not a url/);
        return true;
      });
    }
  }
});

test('key_never_in_errors_or_inspection', () => {
  assert.throws(() => loadConfig({ ...valid(), GRAPH_API_PRIMARY_URL: `https://${SENTINEL}@example.com` }), (error: Error) => {
    assert.doesNotMatch(error.message, new RegExp(SENTINEL));
    assert.doesNotMatch(inspect(error), new RegExp(SENTINEL));
    return true;
  });
  const config = loadConfig(valid());
  assert.doesNotMatch(inspect(config), new RegExp(SENTINEL));
  assert.doesNotMatch(inspect(config, { showHidden: true, depth: Infinity }), new RegExp(SENTINEL));
  assert.doesNotMatch(JSON.stringify(config), new RegExp(SENTINEL));
  assert.doesNotMatch(String(config), new RegExp(SENTINEL));
  assert.doesNotMatch(`${config}`, new RegExp(SENTINEL));
  assert.doesNotMatch(JSON.stringify({ ...config }), new RegExp(SENTINEL));
});

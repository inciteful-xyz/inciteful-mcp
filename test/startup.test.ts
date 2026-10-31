import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;

const ENV = {
  GRAPH_API_PRIMARY_URL: 'http://graph-primary-SENTINELA.internal',
  GRAPH_API_SECONDARY_URL: 'http://graph-secondary-SENTINELB.internal',
  OPENALEX_ACADEMIC_API_KEY: 'sk-SENTINELC-key',
  PUBLIC_BASE_URL: 'https://SENTINELD.example.org/academic/mcp',
  USAGE_DB_PATH: '/nonexistent/SENTINELE/usage.sqlite',
};

function run(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Only PATH and HOME from the parent, so nothing else can satisfy a missing variable.
    const child = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('index.ts did not exit')); }, 20_000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('startup_fails_naming_only_the_missing_var', async () => {
  for (const missing of ['OPENALEX_ACADEMIC_API_KEY', 'USAGE_DB_PATH']) {
    const env: Record<string, string> = { ...ENV };
    delete env[missing];
    const { code, stdout, stderr } = await run(env);
    assert.notEqual(code, 0, missing);
    assert.equal(code, 1);
    assert.equal(stderr.trim(), `missing required env var: ${missing}`);
    assert.equal(stdout, '');
    for (const value of Object.values(ENV)) assert.ok(!stderr.includes(value) && !stdout.includes(value));
    assert.doesNotMatch(stderr + stdout, /SENTINEL/);
  }
});

test('startup_exits_when_the_usage_db_cannot_open', async () => {
  // Every variable set, but USAGE_DB_PATH sits under a directory that doesn't exist.
  const { code, stdout, stderr } = await run(ENV);
  assert.equal(code, 1);
  // node:sqlite's ExperimentalWarning may or may not print before the exit; it isn't ours.
  const ours = stderr.split('\n').filter(l => !/ExperimentalWarning|--trace-warnings/.test(l)).join('\n');
  assert.equal(ours.trim(), 'usage log: cannot open USAGE_DB_PATH (ERR_SQLITE_ERROR); exiting');
  assert.equal(stdout, '');
  assert.doesNotMatch(stderr + stdout, /SENTINEL/);
});

#!/usr/bin/env node
/**
 * scripts/test.mjs — one Node-20-safe entry point for the test suite.
 *
 * `node --test test/*.test.mjs` relies on Node's own glob expansion, which
 * only exists on Node >= 21. The package declares engines.node >= 20.11, so
 * enumerate the test files explicitly instead. `npm test`, validate.mjs and
 * release.mjs all invoke this script so they can never drift apart.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(path.join(ROOT, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join('test', name));

if (files.length === 0) {
  console.error('test: no *.test.mjs files found under test/');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: ROOT,
  stdio: 'inherit',
  timeout: 900_000,
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
});
if (result.error) {
  console.error(`test: could not spawn node --test: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);

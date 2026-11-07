#!/usr/bin/env node
/**
 * scripts/pack-check.mjs — prove that `npm pack` would publish exactly the
 * allowlisted files and nothing else (no tests, docs, community files, scripts,
 * or tmp dirs).
 *
 * Usage:
 *   node scripts/pack-check.mjs
 *
 * Exits 0 when the dry-run tarball matches `<package.json>.files` plus
 * package.json itself; exits 1 with a missing/unexpected file breakdown otherwise.
 * The release pipeline calls `checkPack()` directly so a mismatch aborts publishing.
 *
 * Zero dependencies: npm is invoked as a subprocess, everything else is node:fs.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Arguments we are willing to hand to a shell: npm flags, names and versions. */
const SAFE_ARG = /^[A-Za-z0-9@/._:=+~-]+$/;

/**
 * Run an npm command. On Windows `npm` resolves to `npm.cmd`, which node refuses
 * to spawn without a shell, so both platforms go through the system shell. Every
 * argument is restricted by SAFE_ARG first, which rules out shell metacharacters.
 */
export function runNpm(args, { cwd = ROOT, timeout = 180_000, stdio = 'pipe' } = {}) {
  for (const arg of args) {
    if (typeof arg !== 'string' || !SAFE_ARG.test(arg)) {
      throw new Error(`refusing to pass unsafe argument to npm: ${JSON.stringify(arg)}`);
    }
  }
  const commandLine = ['npm', ...args].join(' ');
  return spawnSync(commandLine, {
    cwd,
    shell: true,
    stdio,
    encoding: stdio === 'pipe' ? 'utf8' : undefined,
    timeout,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function tail(text, limit = 1200) {
  const clean = String(text ?? '').trim();
  return clean.length <= limit ? clean : `…${clean.slice(-limit)}`;
}

/** Files npm publishes: everything in `files` plus package.json itself. */
export function expectedPublishedFiles(pkg) {
  if (!pkg || !Array.isArray(pkg.files)) {
    throw new Error('package.json has no "files" array');
  }
  return [...new Set(['package.json', ...pkg.files])].sort();
}

/** Patterns that must never appear in a published tarball. */
const FORBIDDEN_PACK_PATTERNS = [
  /^docs\//i,
  /^\.github\//i,
  /^test\//,
  /^scripts\//,
  /^CONTRIBUTING(\.en)?\.md$/i,
  /^SECURITY\.md$/i,
  /^CODE_OF_CONDUCT\.md$/i,
  /^CHANGELOG\.md$/i,
  /^AGENTS\.md$/i,
  /(^|\/)\.tmp-test\//,
  /(^|\/)node_modules\//,
  /\.tgz$/,
];

/**
 * Run `npm pack --dry-run --json` and compare the tarball listing with the allowlist.
 * Returns a plain result object; never throws for a failed check (callers decide).
 */
export function checkPack({ root = ROOT, pkg = null } = {}) {
  const packageJson = pkg ?? JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const expected = expectedPublishedFiles(packageJson);

  const result = runNpm(['pack', '--dry-run', '--json'], { cwd: root });
  if (result.error) {
    return { ok: false, expected, reason: `could not run npm pack: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      expected,
      reason: `npm pack --dry-run --json failed (exit ${result.status}): ${tail(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return {
      ok: false,
      expected,
      reason: `could not parse npm pack JSON (${error.message}); stdout: ${tail(result.stdout)}`,
    };
  }

  const info = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!info || !Array.isArray(info.files)) {
    return { ok: false, expected, reason: 'npm pack JSON output has no "files" array' };
  }

  const actual = info.files.map((file) => String(file.path).replace(/\\/g, '/')).sort();
  const missing = expected.filter((file) => !actual.includes(file));
  const unexpected = actual.filter((file) => !expected.includes(file));
  const forbidden = actual.filter((file) => FORBIDDEN_PACK_PATTERNS.some((re) => re.test(file)));

  const ok = missing.length === 0 && unexpected.length === 0 && forbidden.length === 0;
  const problems = [];
  if (missing.length > 0) problems.push(`missing from tarball: ${missing.join(', ')}`);
  if (unexpected.length > 0) problems.push(`unexpected in tarball: ${unexpected.join(', ')}`);
  if (forbidden.length > 0) problems.push(`forbidden in tarball: ${forbidden.join(', ')}`);

  return {
    ok,
    expected,
    actual,
    missing,
    unexpected,
    forbidden,
    entryCount: Number.isInteger(info.entryCount) ? info.entryCount : actual.length,
    size: Number.isFinite(info.size) ? info.size : null,
    unpackedSize: Number.isFinite(info.unpackedSize) ? info.unpackedSize : null,
    filename: typeof info.filename === 'string' ? info.filename : null,
    reason: ok ? 'tarball matches the files allowlist' : problems.join('; '),
  };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node scripts/pack-check.mjs');
    return 0;
  }
  if (argv.length > 0) {
    console.error(`pack-check: unknown argument(s): ${argv.join(' ')}`);
    return 2;
  }

  let result;
  try {
    result = checkPack();
  } catch (error) {
    console.error(`FAIL pack-check: ${error.message}`);
    return 1;
  }

  if (!result.ok) {
    console.error(`FAIL pack-check: ${result.reason}`);
    if (result.missing?.length) console.error(`  missing:    ${result.missing.join(', ')}`);
    if (result.unexpected?.length) console.error(`  unexpected: ${result.unexpected.join(', ')}`);
    if (result.forbidden?.length) console.error(`  forbidden:  ${result.forbidden.join(', ')}`);
    return 1;
  }

  console.log(
    `OK pack-check: ${result.entryCount} files, ${formatBytes(result.size)} tarball / ${formatBytes(result.unpackedSize)} unpacked${
      result.filename ? ` (${result.filename})` : ''
    }`,
  );
  for (const file of result.actual) console.log(`  ${file}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

#!/usr/bin/env node
/**
 * scripts/release.mjs — ordered publish pipeline for dsh-code-review.
 *
 * Steps (abort immediately with a non-zero exit code on the first failure):
 *   1. validate  node scripts/validate.mjs
 *   2. test      node scripts/test.mjs
 *   3. build     node scripts/build.mjs
 *   4. pack      npm pack --dry-run --json, then assert the tarball is exactly the allowlist
 *   5. dry run   stop here when --dry-run or RELEASE_DRY_RUN=1
 *   6. auth      npm whoami
 *   7. version   npm view <name> version (first publish allowed)
 *   8. publish   npm publish --access public
 *
 * Usage:
 *   node scripts/release.mjs [--dry-run] [--tag <dist-tag>] [-- <extra npm publish args>]
 *   npm run release -- --dry-run
 *
 * Zero dependencies.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPack, formatBytes, runNpm } from './pack-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOTAL_STEPS = 8;

function loadPackage() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (error) {
    abort('manifest', `cannot read package.json: ${error.message}`);
  }
}

function abort(step, message) {
  console.error(`release aborted at "${step}": ${message}`);
  process.exit(1);
}

function step(number, name, description) {
  console.log(`\n[${number}/${TOTAL_STEPS}] ${name} — ${description}`);
}

function tail(text, limit = 1600) {
  const clean = String(text ?? '').trim();
  return clean.length <= limit ? clean : `…${clean.slice(-limit)}`;
}

/** Run a node script / node test command in a child process, inheriting stdio. */
function runNode(stepName, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 900_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  if (result.error) abort(stepName, `could not start node ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) abort(stepName, `"node ${args.join(' ')}" exited with code ${result.status}`);
}

function parseArguments(argv) {
  const dryRun = argv.includes('--dry-run') || process.env.RELEASE_DRY_RUN === '1';
  const separator = argv.indexOf('--');
  const own = separator >= 0 ? argv.slice(0, separator) : argv;
  const passthrough = separator >= 0 ? argv.slice(separator + 1) : [];

  let tag = null;
  for (let index = 0; index < own.length; index += 1) {
    const arg = own[index];
    if (arg === '--dry-run') continue;
    if (arg === '--tag') {
      tag = own[index + 1];
      if (!tag) abort('args', '--tag needs a distribution tag, e.g. --tag next');
      index += 1;
      continue;
    }
    if (arg.startsWith('--tag=')) {
      tag = arg.slice('--tag='.length);
      if (!tag) abort('args', '--tag needs a distribution tag, e.g. --tag next');
      continue;
    }
    abort('args', `unknown argument ${JSON.stringify(arg)} (try --help)`);
  }
  if (tag !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    abort('args', `invalid distribution tag ${JSON.stringify(tag)}`);
  }
  return { dryRun, tag, passthrough };
}

function printUsage() {
  console.log('usage: node scripts/release.mjs [--dry-run] [--tag <dist-tag>] [-- <extra npm publish args>]');
  console.log('');
  console.log('  --dry-run        run validate/test/build/pack, then stop before auth/publish');
  console.log('  --tag <name>     npm dist-tag for this publish (default: latest)');
  console.log('  -- <args...>     forwarded to "npm publish" (after --access public)');
  console.log('');
  console.log('Environment: RELEASE_DRY_RUN=1 is equivalent to --dry-run.');
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return 0;
  }
  const { dryRun, tag, passthrough } = parseArguments(argv);
  const pkg = loadPackage();

  console.log(`${pkg.name} release pipeline — ${pkg.name}@${pkg.version}${dryRun ? ' (dry run)' : ''}`);

  // 1. validate -----------------------------------------------------------
  step(1, 'validate', 'manifest, package layout, client sources/bundle, host imports, locales, icon, secrets');
  runNode('validate', [path.join(ROOT, 'scripts', 'validate.mjs')]);

  // 2. test ---------------------------------------------------------------
  step(2, 'test', 'node scripts/test.mjs');
  runNode('test', [path.join(ROOT, 'scripts', 'test.mjs')]);

  // 3. build --------------------------------------------------------------
  step(3, 'build', 'regenerate client.js from src/client/*.js');
  runNode('build', [path.join(ROOT, 'scripts', 'build.mjs')]);

  // 4. pack ---------------------------------------------------------------
  step(4, 'pack', 'npm pack --dry-run --json, then assert the published file list');
  const packed = checkPack({ pkg });
  if (!packed.ok) {
    abort(
      'pack',
      `${packed.reason}${packed.missing?.length ? `; missing: ${packed.missing.join(', ')}` : ''}${
        packed.unexpected?.length ? `; unexpected: ${packed.unexpected.join(', ')}` : ''
      }`,
    );
  }
  console.log(
    `  tarball: ${packed.entryCount} files, ${formatBytes(packed.size)} compressed / ${formatBytes(packed.unpackedSize)} unpacked` +
      `${packed.filename ? ` (${packed.filename})` : ''}`,
  );
  for (const file of packed.actual) console.log(`    ${file}`);

  // 5. dry run ------------------------------------------------------------
  if (dryRun) {
    step(5, 'dry-run', 'skipping auth, version query and publish');
    console.log('\nDRY RUN OK — publish skipped');
    return 0;
  }

  // 6. auth ---------------------------------------------------------------
  step(6, 'auth', 'npm whoami');
  const whoami = runNpm(['whoami']);
  if (whoami.error) abort('auth', `could not run npm: ${whoami.error.message}`);
  if (whoami.status !== 0) {
    abort(
      'auth',
      'not logged in to the npm registry. Run "npm login" first. ' +
        `The npm account must own the package name "${pkg.name}" or have access to its scope. ` +
        `npm whoami said: ${tail(`${whoami.stdout ?? ''}\n${whoami.stderr ?? ''}`)}`,
    );
  }
  const npmUser = String(whoami.stdout ?? '').trim();
  console.log(`  logged in as ${npmUser || '(npm returned no user name)'}`);

  // 7. version ------------------------------------------------------------
  step(7, 'version', `npm view ${pkg.name} version`);
  const view = runNpm(['view', pkg.name, 'version']);
  let published = null;
  let firstPublish = false;
  if (view.status === 0) {
    published = String(view.stdout ?? '').trim().replace(/^['"]|['"]$/g, '').split('\n').pop()?.trim() ?? '';
    if (!published) abort('version', `npm view ${pkg.name} version returned no version`);
    if (published === pkg.version) {
      abort(
        'version',
        `the registry already has ${pkg.name}@${published}, which is the local version. ` +
          'Bump "version" in package.json (npm does not allow re-publishing the same version).',
      );
    }
    console.log(`  registry has ${published}; publishing ${pkg.version}`);
  } else {
    const failure = `${view.stdout ?? ''}\n${view.stderr ?? ''}`;
    const missing =
      /E404|404 Not Found|is not in this registry|No match found|not found/i.test(failure) ||
      /E404/i.test(String(view.error?.code ?? ''));
    if (!missing) {
      abort(
        'version',
        `could not query the npm registry (exit ${view.status}); refusing to publish blind. ` +
          `Check the network/registry config and retry. Output: ${tail(failure)}`,
      );
    }
    firstPublish = true;
    console.log(`  ${pkg.name} is not published yet — this will be the first publish`);
  }

  // 8. publish ------------------------------------------------------------
  step(8, 'publish', 'npm publish --access public');
  const publishArgs = ['publish', '--access', 'public', ...(tag ? ['--tag', tag] : []), ...passthrough];
  const displayCommand = ['npm', ...publishArgs].join(' ');
  console.log(`  running: ${displayCommand}`);
  const publish = runNpm(publishArgs, { stdio: 'inherit', timeout: 900_000 });
  if (publish.error) abort('publish', `could not run npm publish: ${publish.error.message}`);
  if (publish.status !== 0) {
    abort(
      'publish',
      `"${displayCommand}" exited with code ${publish.status}. ` +
        'If this is an authentication or permission error, run "npm login" again and make sure ' +
        `the npm account owns the package name "${pkg.name}".`,
    );
  }

  console.log(`\nrelease: published ${pkg.name}@${pkg.version}${tag ? ` with dist-tag "${tag}"` : ''}`);
  console.log(`  command: ${displayCommand}`);
  if (firstPublish) console.log(`  note: first publish of ${pkg.name}`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));

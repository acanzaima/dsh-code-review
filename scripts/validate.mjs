#!/usr/bin/env node
/**
 * scripts/validate.mjs — every pre-release gate for dsh-code-review, zero dependencies.
 *
 * Runs the gates in a fixed order and stops at the first failure:
 *   OK <gate>: <detail>      gate passed
 *   FAIL <gate>: <reason>    gate failed; process exit code is 1
 *
 * Gates: manifest, package-files, client-source, client-build, host-syntax,
 *        locales, icon, secrets, tests (tests only with --with-tests).
 *
 * Usage:
 *   node scripts/validate.mjs                # fast gates only
 *   node scripts/validate.mjs --with-tests   # also run the suite via `scripts/test.mjs`
 *
 * `scripts/release.mjs` runs the test suite as its own step so failures are
 * attributed to a "test" step rather than to this script's "tests" gate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ORDER, buildClient, BuildError, stripComments } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Package id shown beside the localized plugin name in DSH (manifest gate enforces it). */
const PKG_NAME = 'dsh-code-review';

/** The `.`-export and package layout fixed by docs/protocol.md §1/package.json spec. */
const EXPECTED_EXPORTS = {
  '.': './index.js',
  './client': './client.js',
  './locale/*.json': './locale/*.json',
  './icon': './icon.svg',
  './package.json': './package.json',
};

const EXPECTED_INJECT = [
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-slots',
];

const HOST_FILES = [
  'index.js',
  'src/host/protocol.js',
  'src/host/models.js',
  'src/host/git.js',
  'src/host/patch.js',
  'src/host/index.js',
  'src/host/ai.js',
  'src/host/settings.js',
];

/** Files that must never be published even if a stale `files` array lists them. */
const FORBIDDEN_FILES = [
  { label: 'docs/', test: (entry) => entry === 'docs' || entry.startsWith('docs/') },
  { label: '.github/', test: (entry) => entry === '.github' || entry.startsWith('.github/') },
  { label: 'test/', test: (entry) => entry === 'test' || entry.startsWith('test/') },
  { label: '.tmp-test/', test: (entry) => entry === '.tmp-test' || entry.startsWith('.tmp-test/') },
  { label: 'node_modules/', test: (entry) => entry === 'node_modules' || entry.startsWith('node_modules/') },
  { label: '*.tgz', test: (entry) => entry.endsWith('.tgz') },
  { label: 'scripts/', test: (entry) => entry === 'scripts' || entry.startsWith('scripts/') },
  { label: 'CONTRIBUTING.md', test: (entry) => entry === 'CONTRIBUTING.md' || entry === 'CONTRIBUTING.en.md' },
  { label: 'SECURITY.md', test: (entry) => entry === 'SECURITY.md' },
  { label: 'CODE_OF_CONDUCT.md', test: (entry) => entry === 'CODE_OF_CONDUCT.md' },
  { label: 'CHANGELOG.md', test: (entry) => entry === 'CHANGELOG.md' },
  { label: 'AGENTS.md', test: (entry) => entry === 'AGENTS.md' },
];

const REQUIRED_FILES = [
  'client.js',
  'cordis.patch.yml',
  'index.js',
  'README.md',
  'LICENSE',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
];

/** Raised by a gate; the message is printed after `FAIL <gate>: `. */
class GateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateError';
  }
}

function fail(message) {
  throw new GateError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function readText(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

function readJson(relative) {
  const text = readText(relative);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${relative} is not valid JSON: ${error.message}`);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function tail(text, limit = 1200) {
  const clean = String(text ?? '').trim();
  if (clean.length <= limit) return clean;
  return `…${clean.slice(-limit)}`;
}

/** Shared state between gates: gate 1 loads package.json for the later gates. */
const context = { pkg: null };

// ---------------------------------------------------------------------------
// Gate 1 — manifest
// ---------------------------------------------------------------------------
function gateManifest() {
  assert(existsSync(path.join(ROOT, 'package.json')), 'package.json is missing');
  const pkg = readJson('package.json');
  context.pkg = pkg;

  assert(typeof pkg.name === 'string' && pkg.name.trim() !== '', 'package.json: "name" is missing');
  assert(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(pkg.version), 'package.json: "version" is missing or not semver-like');
  assert(pkg.name === 'dsh-code-review', `package.json: "name" must be "dsh-code-review" (bundle id and Cordis row id depend on it); found ${JSON.stringify(pkg.name)}`);
  assert(pkg.type === 'module', 'package.json: "type" must be "module"');
  assert(pkg.license === 'MIT', 'package.json: "license" must be "MIT"');
  assert(pkg.main === './index.js', 'package.json: "main" must be "./index.js"');
  assert(pkg.private === false, 'package.json: "private" must be false so the package can be published');

  // Every allowlisted file must exist before we claim the package is buildable.
  assert(Array.isArray(pkg.files), 'package.json: "files" must be an array');
  const missingFiles = pkg.files.filter((entry) => typeof entry !== 'string' || !existsSync(path.join(ROOT, entry)));
  assert(missingFiles.length === 0, `package.json: files entries do not exist: ${missingFiles.map((e) => String(e)).join(', ')}`);

  // exports / main shape.
  assert(pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports), 'package.json: "exports" must be an object');
  assert(deepEqual(pkg.exports, EXPECTED_EXPORTS), `package.json: "exports" must be exactly ${JSON.stringify(EXPECTED_EXPORTS)}`);

  // DSH integration block.
  assert(pkg.dsh && typeof pkg.dsh === 'object', 'package.json: "dsh" block is missing');
  assert(pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'package.json: dsh.bundle.patch must be "./cordis.patch.yml"');
  assert(pkg.dsh.client && typeof pkg.dsh.client === 'object', 'package.json: "dsh.client" block is missing');
  assert(pkg.dsh.client.platform === 'web', 'package.json: dsh.client.platform must be "web"');
  assert(pkg.dsh.client.immediately === true, 'package.json: dsh.client.immediately must be true');
  assert(deepEqual(pkg.dsh.client.inject, EXPECTED_INJECT), `package.json: dsh.client.inject must be exactly ${JSON.stringify(EXPECTED_INJECT)}`);

  // Zero dependencies: node builtins only (docs/protocol.md §1).
  const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const present = dependencyFields.filter((field) => pkg[field] && Object.keys(pkg[field]).length > 0);
  assert(present.length === 0, `package.json must have zero dependencies, found: ${present.join(', ')}`);

  return `${pkg.name}@${pkg.version}, ${pkg.files.length} allowlisted files, zero dependencies`;
}

// ---------------------------------------------------------------------------
// Gate 2 — package-files
// ---------------------------------------------------------------------------
function gatePackageFiles() {
  assert(context.pkg, 'manifest gate did not run');
  const { files } = context.pkg;

  for (const entry of files) {
    for (const forbidden of FORBIDDEN_FILES) {
      if (forbidden.test(entry)) {
        fail(`"${entry}" must not be published (${forbidden.label}); remove it from package.json "files"`);
      }
    }
  }

  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) fail(`"${required}" is missing from package.json "files"`);
  }

  return `${files.length} entries, no tests/scripts/docs/community files, required runtime files present`;
}

// ---------------------------------------------------------------------------
// Gate 3 — client-source
// ---------------------------------------------------------------------------

/**
 * Literal colours are not allowed in client sources: the UI must style itself
 * with DSH theme custom properties (`--dsw-alias-*`, `--dsw-shadow-lv*`, ...)
 * or `color-mix()` derived from them, so the DSH theme can restyle it.
 */

function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/** Return `file:line reason` strings for literal colours found outside comments. */
function findLiteralColours(relative, code) {
  const hits = [];
  const scan = (re) => {
    let match;
    while ((match = re.exec(code)) !== null) {
      hits.push(`${relative}:${lineNumberAt(code, match.index)} uses literal colour ${JSON.stringify(match[0].slice(0, 32))}`);
      if (hits.length >= 6) return;
    }
  };
  scan(/#[0-9a-fA-F]{3,8}\b/g);
  scan(/(?<![A-Za-z0-9_-])rgb\(/g);
  scan(/(?<![A-Za-z0-9_-])rgba\(/g);
  return hits;
}

/** `document.body` writes are forbidden: the plugin renders inside its slots only. */
const BODY_WRITE_RE = /document\.body\s*(?:\.\s*(?:innerHTML|outerHTML|textContent|innerText|appendChild|append|prepend|insertBefore|replaceChildren|removeChild|remove|classList|style|setAttribute|removeAttribute|addEventListener)\b|\s*\[)/;

function gateClientSource() {
  const scanned = [];
  for (const name of ORDER) {
    const relative = `src/client/${name}.js`;
    if (!existsSync(path.join(ROOT, relative))) fail(`missing client source ${relative}`);
    const source = readText(relative);

    // Plain script syntax: parse without executing. This also rejects top-level await.
    try {
      new vm.Script(source, { filename: relative });
    } catch (error) {
      fail(`${relative} is not a valid plain script: ${error.message}`);
    }

    const code = stripComments(source);

    const esm = /(^|\n)[ \t]*(import|export)[ \t]/.exec(code);
    if (esm) {
      const line = lineNumberAt(code, esm.index + esm[0].indexOf(esm[2]));
      fail(`${relative}:${line} contains ESM syntax ('${esm[2]}'); client sources are plain scripts`);
    }

    const bodyWrite = BODY_WRITE_RE.exec(code);
    if (bodyWrite) {
      fail(`${relative}:${lineNumberAt(code, bodyWrite.index)} writes to document.body; render only inside the registered slot component tree`);
    }

    const colourHits = findLiteralColours(relative, code);
    if (colourHits.length > 0) fail(colourHits.join('; '));

    scanned.push(name);
  }
  return `${scanned.length} plain-script sources, no ESM/JSX/document.body/colour literals`;
}

// ---------------------------------------------------------------------------
// Gate 4 — client-build
// ---------------------------------------------------------------------------
function gateClientBuild() {
  let result;
  try {
    result = buildClient({ check: true });
  } catch (error) {
    if (error instanceof BuildError) fail(error.message);
    throw error;
  }
  assert(result.ok, result.reason);
  return `client.js is fresh (${result.moduleCount} modules, ${result.bytes} bytes)`;
}

// ---------------------------------------------------------------------------
// Gate 5 — host-syntax
// ---------------------------------------------------------------------------

/**
 * Import each host module in a throwaway `node` process. This catches syntax
 * errors, broken relative imports and top-level side effects that would crash
 * DSH when the bundle loads.
 *
 * The dictated probe is `node --input-type=module --eval "await import(process.argv[1])"`
 * with the absolute file path as argv[1]. On Windows a bare `E:\\...` path is parsed
 * as a URL scheme, so the probe converts it with pathToFileURL first.
 */
const HOST_PROBE =
  "const { pathToFileURL } = await import('node:url'); await import(pathToFileURL(process.argv[1]).href);";

function gateHostSyntax() {
  for (const relative of HOST_FILES) {
    const absolute = path.join(ROOT, relative);
    if (!existsSync(absolute)) fail(`missing host module ${relative}`);
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', HOST_PROBE, absolute], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    if (result.error) fail(`could not spawn node for ${relative}: ${result.error.message}`);
    if (result.status !== 0) {
      const output = tail(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
      fail(`${relative} failed to import (exit ${result.status}): ${output}`);
    }
  }
  return `${HOST_FILES.length} host modules import cleanly`;
}

// ---------------------------------------------------------------------------
// Gate 6 — locales
// ---------------------------------------------------------------------------
function gateLocales() {
  for (const language of ['en', 'zh']) {
    const relative = `locale/${language}.json`;
    const data = readJson(relative);
    assert(data.meta && typeof data.meta === 'object', `${relative}: missing "meta" object`);
    assert(typeof data.meta.title === 'string' && data.meta.title.trim() !== '', `${relative}: "meta.title" must be a non-empty string`);
    assert(typeof data.meta.description === 'string' && data.meta.description.trim() !== '', `${relative}: "meta.description" must be a non-empty string`);
    // DSH shows the package id beside the localized plugin name (e.g.
    // "上下文 (dsh-context)"), so every locale keeps that suffix.
    assert(data.meta.title.includes(`(${PKG_NAME})`), `${relative}: "meta.title" must contain the package id suffix "(${PKG_NAME})"`);
  }
  return `en + zh display metadata present, both name ${PKG_NAME}`;
}

// ---------------------------------------------------------------------------
// Gate 7 — icon
// ---------------------------------------------------------------------------

/**
 * `icon.svg` must be self-contained. The only accepted `http://` occurrence is the
 * SVG namespace declaration itself (`xmlns="http://www.w3.org/2000/svg"`), which is
 * required for a standalone SVG file to render and is not an external reference.
 * It is removed from the scan below; any other URL/script/image is rejected.
 */
const SVG_NAMESPACE_RE = /xmlns=(["'])http:\/\/www\.w3\.org\/2000\/svg\1/g;

function gateIcon() {
  const relative = 'icon.svg';
  assert(existsSync(path.join(ROOT, relative)), `${relative} is missing`);
  const raw = readText(relative);
  const bytes = Buffer.byteLength(raw);
  assert(bytes < 256 * 1024, `${relative} is ${bytes} bytes; must be under 256 KiB`);
  const stripped = raw.trimStart();
  assert(stripped.startsWith('<svg'), `${relative} must start with "<svg"`);

  const scanned = raw.replace(SVG_NAMESPACE_RE, '');
  const forbidden = ['http://', 'https://', 'xlink:href', '<image', '<script'];
  for (const needle of forbidden) {
    const at = scanned.toLowerCase().indexOf(needle.toLowerCase());
    assert(at === -1, `${relative} must not contain ${JSON.stringify(needle)} (found at byte ${at})`);
  }
  return `${bytes} bytes, self-contained SVG`;
}

// ---------------------------------------------------------------------------
// Gate 8 — secrets
// ---------------------------------------------------------------------------

/**
 * Patterns are deliberately shape-aware to avoid false positives in prose
 * ("risk-free", "task-list"): `sk-` is only matched when it starts a token.
 * API key / password checks only match the `name: "value"` assignment shape.
 * Never print the matched value, only the file, line and pattern name.
 */
const SECRET_PATTERNS = [
  { name: 'private key marker', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { name: 'sk- API key', re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/ },
  { name: 'ghp_ token', re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'password assignment', re: /\bpassword\s*[:=]/i },
  { name: 'api key assignment', re: /\bapi[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: 'absolute Windows path', re: /[A-Za-z]:\\/ },
];

function gateSecrets() {
  assert(context.pkg, 'manifest gate did not run');
  const shipped = ['package.json', ...context.pkg.files];
  const hits = [];
  for (const relative of shipped) {
    const absolute = path.join(ROOT, relative);
    if (!existsSync(absolute)) fail(`cannot scan missing shipped file ${relative}`);
    const text = readText(relative);
    for (const pattern of SECRET_PATTERNS) {
      const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`);
      let match;
      while ((match = re.exec(text)) !== null) {
        hits.push(`${relative}:${lineNumberAt(text, match.index)} looks like ${pattern.name}`);
        if (match[0].length === 0) re.lastIndex += 1;
        if (hits.length >= 10) break;
      }
      if (hits.length >= 10) break;
    }
    if (hits.length >= 10) break;
  }
  assert(hits.length === 0, `potential secrets/paths found: ${hits.join('; ')}`);
  return `${new Set(shipped).size} shipped files scanned, no key markers or absolute paths`;
}

// ---------------------------------------------------------------------------
// Gate 9 — tests (opt-in; release.mjs runs the suite as its own step)
// ---------------------------------------------------------------------------
function gateTests() {
  const result = spawnSync(process.execPath, [path.join('scripts', 'test.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 900_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  if (result.error) fail(`could not spawn scripts/test.mjs: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`scripts/test.mjs failed (exit ${result.status}): ${tail(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, 2000)}`);
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const pass = /# pass (\d+)/.exec(output);
  const failCount = /# fail (\d+)/.exec(output);
  const detail = pass ? `${pass[1]} passing${failCount ? `, ${failCount[1]} failing` : ''}` : 'suite passed';
  return detail;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node scripts/validate.mjs [--with-tests]');
    return 0;
  }
  const known = new Set(['--with-tests']);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    console.error(`validate: unknown argument(s): ${unknown.join(' ')}`);
    return 2;
  }

  const gates = [
    ['manifest', gateManifest],
    ['package-files', gatePackageFiles],
    ['client-source', gateClientSource],
    ['client-build', gateClientBuild],
    ['host-syntax', gateHostSyntax],
    ['locales', gateLocales],
    ['icon', gateIcon],
    ['secrets', gateSecrets],
  ];
  const withTests = argv.includes('--with-tests');
  if (withTests) gates.push(['tests', gateTests]);

  for (const [name, run] of gates) {
    try {
      const detail = run();
      console.log(`OK ${name}${detail ? `: ${detail}` : ''}`);
    } catch (error) {
      if (error instanceof GateError) {
        console.error(`FAIL ${name}: ${error.message}`);
        return 1;
      }
      console.error(`FAIL ${name}: unexpected error: ${error && error.stack ? error.stack : error}`);
      return 1;
    }
  }

  console.log(`validate: all ${gates.length} gates passed${withTests ? '' : ' (tests skipped: pass --with-tests)'}`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));

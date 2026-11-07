// Fixture builders for the git-core tests.
//
// Every repository created here lives under <plugin>/.tmp-test/<pid> and is
// removed by the test file's `after` hook (and by fixture.cleanup() on demand).
// The per-process subdirectory matters: `node --test test/` runs test FILES in
// parallel processes, and concurrent suite invocations must not delete each
// other's fixtures. The modules under test are only ever pointed at these
// throwaway repos.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGit, createNodeExecutor, GitError } from '../../src/host/git.js';

export { createGit, createNodeExecutor, GitError };

export const pluginRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const tmpRootBase = path.join(pluginRoot, '.tmp-test');
/** This test process owns only its own subtree of the shared scratch root. */
export const tmpRoot = path.join(tmpRootBase, String(process.pid));

let fixtureCounter = 0;

export function makeTempDir(prefix = 'repo') {
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, `${prefix}-${process.pid}-${Date.now()}-${fixtureCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove this process's fixtures, then the shared root when it became empty. */
export function cleanupTmpRoot() {
  removeTree(tmpRoot);
  try {
    fs.rmdirSync(tmpRootBase);
  } catch {
    /* another test process may still own a subtree */
  }
}

export function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort cleanup */
  }
}

/** Raw git runner for fixtures (never used by the module under test). */
export function runGit(cwd, argv, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  if (opts.literal) env.GIT_LITERAL_PATHSPECS = '1';
  const input = opts.input === undefined || opts.input === null
    ? undefined
    : Buffer.isBuffer(opts.input) ? opts.input : Buffer.from(String(opts.input), 'utf8');
  const result = spawnSync('git', argv, {
    cwd,
    env,
    input,
    timeout: opts.timeout ?? 120000,
    windowsHide: true,
  });
  const out = result.stdout ? result.stdout.toString('utf8') : '';
  const err = result.stderr ? result.stderr.toString('utf8') : '';
  return { code: result.status, stdout: result.stdout || Buffer.alloc(0), stderr: result.stderr || Buffer.alloc(0), out, err, signal: result.signal };
}

/**
 * A throwaway repository. `fixture.git(...)` throws on non-zero exit so tests
 * fail loudly instead of drifting into a half-built state.
 * Pass `{ dir }` to place it in an existing directory (e.g. one with spaces).
 */
export function createFixture(t, name = 'repo', options = {}) {
  const dir = options.dir ? path.resolve(options.dir) : makeTempDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const cleanup = () => removeTree(dir);
  if (t && typeof t.after === 'function') t.after(cleanup);

  const fixture = {
    dir,
    cleanup,
    /** run git; throws (with stderr) on non-zero exit unless allowFail. */
    git(argv, opts = {}) {
      const result = runGit(dir, argv, opts);
      if (result.code !== 0 && !opts.allowFail) {
        throw new Error(`fixture git ${argv.join(' ')} failed (${result.code}): ${result.err}`);
      }
      return result;
    },
    init({ branch = 'main' } = {}) {
      fixture.git(['init', '-q', '-b', branch]);
      fixture.git(['config', 'user.name', 'Test User']);
      fixture.git(['config', 'user.email', 'test@example.com']);
      fixture.git(['config', 'core.autocrlf', 'false']);
      fixture.git(['config', 'commit.gpgsign', 'false']);
      fixture.git(['config', 'core.symlinks', 'false']);
      return fixture;
    },
    config(key, value) {
      fixture.git(['config', key, value]);
      return fixture;
    },
    write(relPath, content) {
      const full = path.join(dir, ...String(relPath).split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.isBuffer(content) ? content : String(content));
      return fixture;
    },
    remove(relPath) {
      fs.rmSync(path.join(dir, ...String(relPath).split('/')), { recursive: true, force: true });
      return fixture;
    },
    read(relPath) {
      return fs.readFileSync(path.join(dir, ...String(relPath).split('/')));
    },
    readText(relPath) {
      return fixture.read(relPath).toString('utf8');
    },
    exists(relPath) {
      return fs.existsSync(path.join(dir, ...String(relPath).split('/')));
    },
    mkdir(relPath) {
      fs.mkdirSync(path.join(dir, ...String(relPath).split('/')), { recursive: true });
      return fixture;
    },
    addAll() {
      fixture.git(['add', '-A']);
      return fixture;
    },
    commit(message = 'commit') {
      fixture.git(['commit', '-q', '-F', '-'], { input: String(message) });
      return fixture;
    },
    headSha() {
      const result = runGit(dir, ['rev-parse', 'HEAD']);
      return result.code === 0 ? result.out.trim() : null;
    },
    branch() {
      const result = runGit(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
      return result.code === 0 ? result.out.trim() : null;
    },
    /** Raw bytes of `rev:path` (empty Buffer when the object is empty). */
    gitBytes(rev, relPath) {
      const result = runGit(dir, ['cat-file', '-p', `${rev}:${relPath}`]);
      return result.code === 0 ? result.stdout : null;
    },
    indexBytes(relPath) {
      return fixture.gitBytes(':0', relPath);
    },
    headBytes(relPath) {
      return fixture.gitBytes('HEAD', relPath);
    },
    /** `git status --porcelain=v2 -z` output as a Buffer (for assertions). */
    statusPorcelain() {
      return fixture.git(['status', '--porcelain=v2', '-z', '--untracked-files=all']).stdout;
    },
    /** read a file's executable bit as tracked in the index (mode string). */
    indexMode(relPath) {
      const result = runGit(dir, ['ls-files', '-s', '-z', '--', relPath], { literal: true });
      const text = result.stdout.toString('utf8');
      const first = text.split('\u0000')[0];
      return first ? first.split(' ')[0] : null;
    },
    writeHook(name, script) {
      const hookPath = path.join(dir, '.git', 'hooks', name);
      fs.mkdirSync(path.dirname(hookPath), { recursive: true });
      fs.writeFileSync(hookPath, script);
      try {
        fs.chmodSync(hookPath, 0o755);
      } catch {
        /* Windows may not honour the bit; git runs hooks anyway here */
      }
      return fixture;
    },
  };
  return fixture;
}

/** Create a git client with the default node executor. */
export function newGit() {
  return createGit(createNodeExecutor());
}

/** git client whose executor records every argv array (shell-safety assertions). */
export function newRecordingGit() {
  const base = createNodeExecutor();
  const calls = [];
  const git = createGit({
    run(argv, opts) {
      calls.push({ argv: argv.slice(), opts: { ...opts } });
      return base.run(argv, opts);
    },
  });
  return { git, calls };
}

/** Strip a repo path prefix the way errors do not need. */
export function relative(repoRoot, absPath) {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

/** Assert an async call rejects with a GitError carrying `code`; returns the error. */
export async function expectGitError(promise, code) {
  try {
    await promise;
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    if (code && err.code !== code) {
      throw new Error(`expected GitError code ${code}, got ${err.code} (${err.message})`);
    }
    return err;
  }
  throw new Error(`expected GitError ${code || 'of any code'}, but the call succeeded`);
}

/** Read status fresh and index entries by key. */
export async function statusOf(git, repo) {
  return git.status(repo);
}

export function entryOf(status, key) {
  const entry = status.entries.find((item) => item.key === key);
  if (!entry) {
    throw new Error(`no entry ${key} in status; keys=${status.entries.map((e) => e.key).join(', ')}`);
  }
  return entry;
}

export function keysOf(status) {
  return status.entries.map((entry) => entry.key);
}

/** sha256 helper for byte equality checks (node:crypto). */
export { sha256 } from '../../src/host/patch.js';

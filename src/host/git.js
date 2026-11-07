// dsh-code-review — pure Git operations for the host half.
//
// Design rules (docs/protocol.md §4):
//  * every git invocation goes through the injected Executor as an argv array;
//    no shell, no string interpolation, no process.chdir();
//  * paths are always passed as argument values after "--" and with
//    GIT_LITERAL_PATHSPECS=1, so filenames can never be interpreted as options,
//    globs or pathspec magic;
//  * every read returns fresh data from git — nothing about repository state is
//    cached between calls;
//  * before any write, the state the caller believes in (fingerprints, hunk
//    identity) is re-derived from the repository and compared; on mismatch the
//    write is refused with entry/stale or patch/mismatch.
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  MAX_SIDE_BYTES, MAX_SIDE_LINES, EMPTY, DIR, sha256, toBuffer, countTextLines,
  looksBinary, truncateText, parsePatch, firstFile, allHunks, buildSingleHunkPatch,
  findMatchingHunk, makeNewFilePatch,
} from './patch.js';

/** Documented caps: entry rows, diff side bytes/lines, copied stderr, preview commits, process budget. */
export const CAPS = Object.freeze({
  maxStatusEntries: 2000, // summary counts cover only the rows actually returned
  maxDiffBytes: MAX_SIDE_BYTES, // side larger than this -> tooLarge, no text
  maxDiffLines: MAX_SIDE_LINES, // side with more lines -> truncated text
  maxStderr: 16 * 1024, // stdout/stderr copied into GitError.details
  maxPushCommits: 200, // push preview commit list
  maxOutputBytes: 64 * 1024 * 1024, // one git invocation may not collect more stdout+stderr than this
  timeoutMs: 120_000, // one git invocation may not run longer than this
});

export class GitError extends Error {
  /** @param {string} code protocol error code (docs/protocol.md §3.4); @param {string} message; @param {object} [details] */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

/** @typedef {{ code: number, stdout: Buffer, stderr: Buffer }} ExecResult */
/** @typedef {{ run(argv: string[], opts?: { cwd?: string, env?: object, input?: string|Buffer }): Promise<ExecResult> }} Executor */

/**
 * Default Executor: spawns git directly with an argv array whose first element
 * is the command name (`'git'`), per docs/protocol.md §4.
 *
 * The executable is resolved to an absolute path once (PATH + PATHEXT on
 * Windows) and cached. Spawning an absolute path avoids transient
 * `spawn git ENOENT` failures seen under heavy parallel load on Windows, and
 * Electron main processes may see a different PATH than a shell. On ENOENT the
 * executable is re-resolved and the call retried once before it is surfaced as
 * `repo/git-unavailable`.
 * Resolves `{ code, stdout, stderr }` for any exit code (including non-zero);
 * rejects only on a real spawn failure (binary missing, bad cwd, ...), when the
 * invocation exceeds `timeoutMs`, or when its combined output exceeds
 * `maxOutputBytes`. Those two limits keep a hung hook or a runaway command from
 * pinning the plugin's write chain or exhausting memory.
 */
export function createNodeExecutor({
  gitPath = 'git',
  logger = null,
  timeoutMs = CAPS.timeoutMs,
  maxOutputBytes = CAPS.maxOutputBytes,
} = {}) {
  const explicit = /[\\/]/.test(gitPath) ? path.resolve(gitPath) : null;
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => ext.trim()).filter(Boolean)
    : [''];
  let executable; // undefined = not resolved yet, null = the PATH search failed

  function resolveExecutable() {
    if (explicit !== null) return explicit;
    const names = [...extensions.map((ext) => (ext === '' ? gitPath : `${gitPath}${ext}`)), gitPath];
    for (const entry of (process.env.PATH || '').split(path.delimiter)) {
      const dir = entry.replace(/^"(.*)"$/, '$1');
      const absoluteDir = dir === '' ? process.cwd() : path.resolve(dir);
      for (const name of names) {
        const candidate = path.join(absoluteDir, name);
        try {
          fs.accessSync(candidate, fs.constants.F_OK);
          return candidate;
        } catch {
          /* keep looking */
        }
      }
    }
    return null;
  }

  function spawnOnce(binary, args, opts) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(binary, args, {
          cwd: opts.cwd,
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(err);
        return;
      }
      const out = [];
      const err = [];
      let settled = false;
      let outputBytes = 0;
      let timer = null;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        fn(value);
      };
      const abort = (code, message) => {
        const error = new Error(message);
        error.code = code;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        settle(reject, error);
      };
      const consume = (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          abort('output-too-large', `git output exceeded ${maxOutputBytes} bytes`);
          return false;
        }
        return true;
      };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => abort('timeout', `git command timed out after ${timeoutMs}ms`), timeoutMs);
        timer.unref?.();
      }
      child.on('error', (error) => settle(reject, error));
      child.stdout.on('data', (chunk) => {
        if (consume(chunk)) out.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (consume(chunk)) err.push(chunk);
      });
      child.stdin.on('error', () => { /* the child may exit before reading stdin */ });
      child.on('close', (code) => settle(resolve, { code: code === null ? 1 : code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
      try {
        child.stdin.end(opts.input === undefined || opts.input === null ? undefined : toBuffer(opts.input));
      } catch {
        /* the child may have been killed already */
      }
    });
  }

  return {
    async run(argv, opts = {}) {
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
        throw new TypeError('createNodeExecutor: argv must be a non-empty array of strings');
      }
      const [, ...args] = argv;
      if (logger && typeof logger.debug === 'function') logger.debug(`git ${args.join(' ')}`);
      if (executable === undefined) executable = resolveExecutable();
      const binary = executable || gitPath || argv[0];
      try {
        return await spawnOnce(binary, args, opts);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
        // Stale cache / PATH update: re-resolve once, then retry the same call.
        executable = resolveExecutable();
        const retried = executable || binary;
        if (logger && typeof logger.debug === 'function') logger.debug(`git retry after ENOENT: ${retried}`);
        return spawnOnce(retried, args, opts);
      }
    },
  };
}

/** Trim a git output buffer to bounded stderr text for GitError.details. */
function clip(value, max = CAPS.maxStderr) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…(truncated)` : text;
}

function normalizeResult(result) {
  return {
    code: Number(result && result.code !== undefined ? result.code : 0),
    stdout: toBuffer(result && result.stdout),
    stderr: toBuffer(result && result.stderr),
  };
}

const isZeroOid = (oid) => !oid || /^0+$/.test(oid);

function splitNul(buf) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      parts.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) parts.push(buf.subarray(start));
  return parts;
}

function joinRepoPath(root, relPath) {
  // git always reports worktree paths with '/' separators, also on Windows.
  return path.join(root, ...String(relPath).split('/'));
}

const CHANGE_BY_CODE = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
};

function changeForCode(code) {
  return CHANGE_BY_CODE[code] || 'modified';
}

// --- porcelain=v2 status parsing (NUL safe) ---------------------------------

function readFields(buf, count) {
  let pos = 0;
  const fields = [];
  for (let i = 0; i < count; i++) {
    const space = buf.indexOf(0x20, pos);
    if (space === -1) return null;
    fields.push(buf.subarray(pos, space).toString('utf8'));
    pos = space + 1;
  }
  return { fields, rest: buf.subarray(pos) };
}

/**
 * Parse `git status --porcelain=v2 -z --branch` output. NUL is the only record
 * separator, so paths containing spaces, quotes or newlines round-trip exactly.
 * Exported so the test-suite can verify NUL-safety without touching a filesystem.
 */
export function parseStatusV2(output) {
  const parts = splitNul(toBuffer(output));
  const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 };
  const records = [];
  const header = (line, prefix, key) => {
    if (line.startsWith(prefix)) branch[key] = line.slice(prefix.length);
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length === 0) continue;
    const type = String.fromCharCode(part[0]);
    if (type === '#') {
      const line = part.toString('utf8');
      header(line, '# branch.oid ', 'oid');
      header(line, '# branch.head ', 'head');
      header(line, '# branch.upstream ', 'upstream');
      const ab = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (ab) { branch.ahead = Number(ab[1]); branch.behind = Number(ab[2]); }
      continue;
    }
    if (type === '1' || type === '2' || type === 'u') {
      // token count includes the record-type field itself.
      const count = type === '1' ? 8 : type === '2' ? 9 : 10;
      const read = readFields(part, count);
      if (!read) continue;
      const fields = read.fields;
      if (type === '1') {
        const [, xy, sub, mH, mI, mW, hH, hI] = fields;
        records.push({ type, xy, sub, mH, mI, mW, hH, hI, path: read.rest.toString('utf8') });
      } else if (type === '2') {
        const next = parts[i + 1];
        if (!next) continue;
        const [, xy, sub, mH, mI, mW, hH, hI, score] = fields;
        records.push({ type, xy, sub, mH, mI, mW, hH, hI, score, path: read.rest.toString('utf8'), oldPath: next.toString('utf8') });
        i++; // oldPath is the next NUL field
      } else {
        const [, xy, sub, m1, m2, m3, mW, h1, h2, h3] = fields;
        records.push({ type, xy, sub, m1, m2, m3, mW, h1, h2, h3, path: read.rest.toString('utf8') });
      }
    } else if (type === '?') {
      records.push({ type, path: part.subarray(2).toString('utf8') });
    }
    // '!' ignored entries are not requested.
  }
  return { branch, records };
}

/**
 * Canonical fingerprint over the *whole* index, not just the rows the status
 * payload displays. The status endpoint returns it and git.commit() re-derives
 * it from a fresh read, so a staged change hidden behind the display cap still
 * invalidates a commit expectation.
 *
 * Derived from `git ls-files -s -z`: one NUL-terminated record per index entry,
 * `<mode> <oid> <stage>\t<path>`. All fields (path, mode, oid, stage) are
 * canonicalised and hashed, so identical trees always produce the same value.
 * An empty index yields ''.
 */
export function computeIndexFingerprint(output) {
  const parts = splitNul(toBuffer(output));
  const records = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    const tab = part.indexOf(0x09);
    if (tab === -1) continue;
    const meta = part.subarray(0, tab).toString('utf8'); // "<mode> <oid> <stage>"
    const relPath = part.subarray(tab + 1);
    records.push(Buffer.concat([Buffer.from(`${meta}\u0000`, 'utf8'), relPath, Buffer.from('\u0000')]));
  }
  if (records.length === 0) return '';
  records.sort(Buffer.compare);
  return sha256(Buffer.concat(records));
}

/**
 * Canonical comparison of an expected fingerprint and the freshly derived one.
 * Every field participates: base/target content identity, the file mode pair and
 * the submodule gitlink identities. Unknown extra fields are ignored.
 */
export function fingerprintEquals(expected, actual) {
  const left = canonicalFingerprint(expected);
  const right = canonicalFingerprint(actual);
  if (left === null || right === null || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

function canonicalFingerprint(fingerprint) {
  const value = fingerprint !== null && typeof fingerprint === 'object' ? fingerprint : null;
  if (value === null || typeof value.base !== 'string' || typeof value.target !== 'string') return null;
  const parts = [value.base, value.target, typeof value.mode === 'string' ? value.mode : ''];
  const gitlink = value.gitlink !== null && typeof value.gitlink === 'object' ? value.gitlink : null;
  if (gitlink !== null) {
    const oldSha = typeof gitlink.oldSha === 'string' ? gitlink.oldSha : '';
    const newSha = typeof gitlink.newSha === 'string' ? gitlink.newSha : '';
    parts.push('gitlink', oldSha, newSha);
  }
  return parts;
}


// --- numstat / raw diff parsing ---------------------------------------------

function parseNumstatZ(output) {
  const map = new Map();
  const parts = splitNul(toBuffer(output));
  let i = 0;
  while (i < parts.length) {
    const field = parts[i++].toString('utf8');
    if (!field) continue;
    const tab1 = field.indexOf('\t');
    const tab2 = tab1 === -1 ? -1 : field.indexOf('\t', tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;
    const add = field.slice(0, tab1);
    const del = field.slice(tab1 + 1, tab2);
    let p = field.slice(tab2 + 1);
    if (p === '') {
      // With -z a rename/copy is "<add>\t<del>\t\0<old>\0<new>\0".
      i++; // old path
      p = i < parts.length ? parts[i++].toString('utf8') : '';
    }
    map.set(p, add === '-' || del === '-' ? null : { additions: Number(add) || 0, deletions: Number(del) || 0 });
  }
  return map;
}

function parseRawDiffZ(output) {
  const records = [];
  const parts = splitNul(toBuffer(output));
  let i = 0;
  while (i < parts.length) {
    const header = parts[i++].toString('utf8');
    if (!header.startsWith(':')) continue;
    const fields = header.slice(1).split(' ');
    if (fields.length < 5) continue;
    const [oldMode, newMode, oldSha, newSha, statusText] = fields;
    let p = i < parts.length ? parts[i++].toString('utf8') : '';
    let oldPath = null;
    if (statusText[0] === 'R' || statusText[0] === 'C') {
      oldPath = p;
      p = i < parts.length ? parts[i++].toString('utf8') : '';
    }
    records.push({ oldMode, newMode, oldSha, newSha, status: statusText[0], oldPath, path: p });
  }
  return records;
}

// --- createGit --------------------------------------------------------------

/** Create the git operation surface. @param {Executor} exec */
export function createGit(exec) {
  if (!exec || typeof exec.run !== 'function') {
    throw new TypeError('createGit(exec): an executor with run(argv, opts) is required');
  }
  let versionCache = null;

  // --- process plumbing -----------------------------------------------------

  async function invoke(argv, opts = {}) {
    // literal pathspecs: every path handed to git is a literal filename, never a
    // glob or pathspec magic. Callers cannot override an explicit env value.
    const env = opts.literal === true ? { GIT_LITERAL_PATHSPECS: '1', ...(opts.env || {}) } : opts.env;
    try {
      return normalizeResult(await exec.run(['git', ...argv], { cwd: opts.cwd, env, input: opts.input }));
    } catch (err) {
      const reason = err && typeof err.code === 'string' ? err.code : '';
      if (reason === 'timeout') {
        throw new GitError('repo/timeout', 'git command timed out', { argv: argv.slice(0, 3) });
      }
      if (reason === 'output-too-large') {
        throw new GitError('repo/output-too-large', 'git output exceeded the configured limit', { argv: argv.slice(0, 3) });
      }
      throw new GitError('repo/git-unavailable', 'unable to run git', {
        argv: argv.slice(0, 3),
        reason: reason || null,
      });
    }
  }

  function gitFailure(message, argv, result, fallbackCode = 'internal') {
    const stderr = clip(result.stderr);
    const stdout = clip(result.stdout);
    const lower = stderr.toLowerCase();
    let code = fallbackCode;
    if (lower.includes('index.lock')) code = 'repo/locked';
    else if (lower.includes('not a git repository')) code = 'repo/no-git';
    return new GitError(code, message, { argv: argv.slice(0, 4), exitCode: result.code, stdout, stderr });
  }

  async function invokeOrThrow(message, argv, opts) {
    const result = await invoke(argv, opts);
    if (result.code !== 0) throw gitFailure(message, argv, result);
    return result;
  }

  // --- low level readers ----------------------------------------------------

  /**
   * Resolve a `<rev>:<path>` object spec to its git object id, or null when the
   * object/path does not exist. The spec is passed as one argv value, so paths
   * with spaces, quotes or newlines are safe.
   */
  async function resolveObject(cwd, spec) {
    const result = await invoke(['rev-parse', '-q', '--verify', spec], { cwd });
    if (result.code !== 0) return null;
    const oid = result.stdout.toString('utf8').trim();
    return /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null;
  }

  /**
   * Object sizes by id, without reading any content. Object ids are hex, so the
   * batch input is newline safe. Used to decide whether a blob is small enough
   * to load into memory; the status path itself never loads git blobs.
   */
  async function readObjectSizes(cwd, oids) {
    const wanted = [...new Set((oids || []).filter((oid) => oid && !isZeroOid(oid)))];
    const sizes = new Map();
    for (let start = 0; start < wanted.length; start += 256) {
      const batch = wanted.slice(start, start + 256);
      const result = await invoke(['cat-file', '--batch-check'], { cwd, input: `${batch.join('\n')}\n` });
      if (result.code !== 0) throw gitFailure('git cat-file --batch-check failed', ['cat-file', '--batch-check'], result);
      for (const line of result.stdout.toString('utf8').split('\n')) {
        if (!line) continue;
        const first = line.indexOf(' ');
        const second = first === -1 ? -1 : line.indexOf(' ', first + 1);
        if (first === -1 || second === -1) continue; // "<oid> missing"
        const size = Number(line.slice(second + 1));
        if (Number.isFinite(size)) sizes.set(line.slice(0, first), size);
      }
    }
    return sizes;
  }

  /** Batch-fetch blob contents by object id (ids are hex, so the input is NUL/newline safe). */
  async function readObjects(cwd, oids) {
    const wanted = [...new Set((oids || []).filter((oid) => oid && !isZeroOid(oid)))];
    const out = new Map();
    for (let start = 0; start < wanted.length; start += 64) {
      const batch = wanted.slice(start, start + 64);
      const result = await invoke(['cat-file', '--batch'], { cwd, input: `${batch.join('\n')}\n` });
      if (result.code !== 0) throw gitFailure('git cat-file --batch failed', ['cat-file', '--batch'], result);
      const buf = result.stdout;
      let pos = 0;
      while (pos < buf.length) {
        const newline = buf.indexOf(0x0a, pos);
        if (newline === -1) break;
        const header = buf.subarray(pos, newline).toString('utf8');
        pos = newline + 1;
        const fields = header.split(' ');
        if (fields.length < 3 || fields[1] === 'missing') continue;
        const size = Number(fields[2]);
        if (!Number.isFinite(size)) break;
        out.set(fields[0], buf.subarray(pos, pos + size));
        pos += size + 1; // trailing '\n' appended by cat-file
      }
    }
    return out;
  }

  async function readRemotes(cwd) {
    const result = await invoke(['remote', '-v'], { cwd });
    if (result.code !== 0) return [];
    const remotes = new Map();
    for (const line of result.stdout.toString('utf8').split('\n')) {
      const tab = line.indexOf('\t');
      const match = tab === -1 ? null : / \((fetch|push)\)$/.exec(line.slice(tab + 1));
      if (!match) continue;
      const name = line.slice(0, tab);
      if (!remotes.has(name)) remotes.set(name, line.slice(tab + 1, tab + 1 + match.index));
    }
    return [...remotes].map(([name, url]) => ({ name, url }));
  }

  /**
   * Read a worktree file: symlink targets are read as link bytes, regular files
   * are hashed (streamed when large) and only buffered up to the diff size cap.
   */
  async function scanWorktreeFile(root, relPath) {
    const full = joinRepoPath(root, relPath);
    let stat;
    try {
      stat = await fsp.lstat(full);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return MISSING_SCAN;
      throw new GitError('internal', 'unable to read a worktree file', { path: relPath, reason: err && err.code ? err.code : null });
    }
    if (stat.isSymbolicLink()) {
      const target = await fsp.readlink(full, { encoding: 'buffer' });
      return {
        exists: true, isDir: false, symlink: true, size: target.length, buf: target,
        hash: sha256(target), head: target.subarray(0, 8000), lines: countTextLines(target), targetText: target.toString('utf8'),
      };
    }
    if (stat.isDirectory()) {
      return { exists: true, isDir: true, symlink: false, size: 0, buf: null, hash: null, head: null, lines: 0 };
    }
    if (stat.size <= CAPS.maxDiffBytes) {
      const buf = await fsp.readFile(full);
      return {
        exists: true, isDir: false, symlink: false, size: buf.length, buf,
        hash: sha256(buf), head: buf.subarray(0, 8000), lines: countTextLines(buf),
      };
    }
    // Large file: we still need an exact hash for the fingerprint, but must not
    // hold the whole content in memory.
    const hash = createHash('sha256');
    const headChunks = [];
    let headLength = 0;
    let size = 0;
    let lines = 0;
    let lastByte = -1;
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(full);
      stream.on('data', (chunk) => {
        hash.update(chunk);
        size += chunk.length;
        if (headLength < 8000) {
          const take = chunk.subarray(0, Math.min(8000 - headLength, chunk.length));
          headChunks.push(take);
          headLength += take.length;
        }
        for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) lines++;
        lastByte = chunk[chunk.length - 1];
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    if (size > 0 && lastByte !== 0x0a) lines++;
    return {
      exists: true, isDir: false, symlink: false, size, buf: null,
      hash: hash.digest('hex'), head: Buffer.concat(headChunks), lines,
    };
  }

  // --- repo resolution ------------------------------------------------------

  async function resolveRepo(cwd) {
    const dir = path.resolve(cwd === undefined || cwd === null ? process.cwd() : String(cwd));
    let stat = null;
    try { stat = await fsp.stat(dir); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) throw new GitError('repo/not-found', 'directory does not exist', { cwd: dir });
    const result = await invoke(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { cwd: dir });
    if (result.code !== 0) {
      const stderr = clip(result.stderr);
      const message = /not a git repository/i.test(stderr) ? 'not a git repository' : 'unable to resolve repository';
      throw new GitError('repo/no-git', message, { cwd: dir, stderr, exitCode: result.code });
    }
    const lines = result.stdout.toString('utf8').split('\n').filter(Boolean);
    if (lines.length < 3) throw new GitError('repo/no-git', 'unexpected rev-parse output', { cwd: dir });
    const root = path.resolve(lines[0]);
    const gitDir = path.resolve(lines[1]);
    // rev-parse prints --git-common-dir relative to the directory it ran in
    // ("../.git" from a subdirectory), so resolve it against that, not the root.
    const commonDir = path.resolve(dir, lines[2]);

    const [headResult, symbolic, upstreamResult] = await Promise.all([
      invoke(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root }),
      invoke(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root }),
      invoke(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root }),
    ]);
    const headSha = headResult.code === 0 ? headResult.stdout.toString('utf8').trim() || null : null;
    const branch = symbolic.code === 0 ? symbolic.stdout.toString('utf8').trim() || null : null;
    const upstreamText = upstreamResult.code === 0 ? upstreamResult.stdout.toString('utf8').trim() : '';
    const upstream = upstreamText && !upstreamText.includes('@{') ? upstreamText : null;
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const counts = await invoke(['rev-list', '--count', '--left-right', '@{upstream}...HEAD'], { cwd: root });
      if (counts.code === 0) {
        const [behindText, aheadText] = counts.stdout.toString('utf8').trim().split('\t');
        behind = Number(behindText) || 0;
        ahead = Number(aheadText) || 0;
      }
    }
    return { root, gitDir, branch, detached: branch === null, headSha, upstream, ahead, behind, remotes: await readRemotes(root), worktree: gitDir !== commonDir };
  }

  // --- status ---------------------------------------------------------------

  function emptyStatusPayload(cwd, error) {
    const zero = { files: 0, entries: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, stagedAdditions: 0, stagedDeletions: 0, unstagedAdditions: 0, unstagedDeletions: 0, untrackedFiles: 0, truncated: false };
    return {
      repo: null,
      cwd: path.resolve(String(cwd === undefined || cwd === null ? process.cwd() : cwd)),
      state: error && error.code === 'repo/no-git' ? 'no-git' : 'error',
      error: error ? { code: error.code, message: error.message } : undefined,
      entries: [],
      summary: zero,
      generatedAt: Date.now(),
      stagedFingerprint: '',
    };
  }

  function repoWithFreshBranch(repo, branch) {
    const detached = !branch.head || branch.head === '(detached)';
    return {
      ...repo,
      branch: detached ? null : branch.head,
      detached,
      headSha: branch.oid && branch.oid !== '(initial)' && !isZeroOid(branch.oid) ? branch.oid : null,
      upstream: branch.upstream || null,
      ahead: branch.ahead || 0,
      behind: branch.behind || 0,
    };
  }

  function buildStatusRows(records) {
    const rows = [];
    const row = (status, change, record, oldPath = null) => rows.push({ status, change, path: record.path, oldPath, isUntracked: status === 'untracked', record });
    for (const record of records) {
      if (record.type === '?') { row('untracked', 'added', record); continue; }
      if (record.type === 'u') { row('conflict', 'conflict', record); continue; }
      const x = record.xy[0];
      const y = record.xy[1];
      if (record.type === '2' || x !== '.') row('staged', changeForCode(record.type === '2' ? x : x), record, record.oldPath ?? null);
      if (y !== '.') row('unstaged', changeForCode(y), record);
    }
    return rows;
  }

  function detectKind(row, opts) {
    if (row.status === 'conflict') return 'conflict';
    const record = row.record;
    const modes = [record.mH, record.mI, record.mW].filter(Boolean);
    if ((record.sub && record.sub[0] === 'S') || modes.includes('160000')) return 'submodule';
    if (modes.includes('120000') || opts.symlink) return 'symlink';
    if (opts.binary) return 'binary';
    if (!opts.targetDir && !opts.baseDir && opts.targetSize === 0 && opts.baseSize === 0) return 'empty';
    return 'text';
  }

  /** The git mode pair the row's two sides carry ("100644:100755"), or null. */
  function rowMode(row) {
    const record = row.record;
    if (row.status === 'staged') return record.mH && record.mI ? `${record.mH}:${record.mI}` : null;
    if (row.status === 'unstaged') return record.mI && record.mW ? `${record.mI}:${record.mW}` : null;
    return null;
  }

  async function status(repoOrCwd, options = {}) {
    let repo = null;
    let cwd = null;
    if (repoOrCwd && typeof repoOrCwd === 'object') {
      repo = repoOrCwd;
    } else {
      cwd = typeof repoOrCwd === 'string' ? repoOrCwd : process.cwd();
      try {
        repo = await resolveRepo(cwd);
      } catch (err) {
        if (err instanceof GitError && (err.code === 'repo/no-git' || err.code === 'repo/not-found' || err.code === 'repo/git-unavailable')) {
          return emptyStatusPayload(cwd, err);
        }
        throw err;
      }
    }
    // `Infinity` requests the full (untruncated) listing used by whole-repository
    // writes; the display path keeps the documented cap.
    const maxEntries = typeof options.maxEntries === 'number' && options.maxEntries > 0 ? options.maxEntries : CAPS.maxStatusEntries;
    const root = repo.root;
    const result = await invoke(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--find-renames'], { cwd: root });
    if (result.code !== 0) throw gitFailure('git status failed', ['status'], result);
    const parsed = parseStatusV2(result.stdout);
    const freshRepo = { ...repoWithFreshBranch(repo, parsed.branch), remotes: await readRemotes(root) };

    const allRows = buildStatusRows(parsed.records);
    const truncated = allRows.length > maxEntries;
    const rows = truncated ? allRows.slice(0, maxEntries) : allRows;

    const hasStaged = rows.some((row) => row.status === 'staged');
    const hasUnstaged = rows.some((row) => row.status === 'unstaged');
    const [stagedNumstat, unstagedNumstat] = await Promise.all([
      hasStaged ? readNumstatZ(root, true) : new Map(),
      hasUnstaged ? readNumstatZ(root, false) : new Map(),
    ]);

    // Only object sizes are read here, never blob contents: a git-object side is
    // fingerprinted by its object id (identity), so polling the status never
    // re-reads large blobs. Worktree bytes are read at most once per path and
    // are streamed when large.
    const wantedOids = rows.flatMap((row) => {
      const plan = sidePlan(row);
      return [plan.baseOid, plan.targetOid].filter(Boolean);
    });
    const sizes = await readObjectSizes(root, wantedOids);
    const worktreeCache = new Map();
    const worktreeScan = (relPath) => {
      if (!worktreeCache.has(relPath)) worktreeCache.set(relPath, scanWorktreeFile(root, relPath));
      return worktreeCache.get(relPath);
    };

    const entries = [];
    const statusByPath = new Map();
    for (const row of rows) {
      const plan = sidePlan(row);
      let target = MISSING_SCAN;
      if (plan.targetDir) {
        target = DIR_SCAN;
      } else if (plan.targetOid) {
        const size = sizes.get(plan.targetOid) ?? 0;
        target = { exists: true, isDir: false, symlink: false, size, buf: null, hash: null, head: null, lines: 0 };
      } else if (plan.targetWorktree) {
        target = await worktreeScan(row.path);
      }
      const baseSize = plan.baseDir || !plan.baseOid ? 0 : sizes.get(plan.baseOid) ?? 0;
      const targetSize = plan.targetDir ? 0 : target.size;

      const counts = row.status === 'untracked' ? undefined : (row.status === 'staged' ? stagedNumstat : unstagedNumstat).get(row.path);
      const kind = detectKind(row, {
        binary: row.status === 'untracked' ? looksBinary(target.head || target.buf) : counts === null,
        symlink: !!target.symlink,
        baseDir: plan.baseDir,
        targetDir: plan.targetDir,
        baseSize,
        targetSize,
      });
      const fingerprint = {
        base: plan.baseDir ? DIR : plan.baseOid ? plan.baseOid : EMPTY,
        target: plan.targetDir ? DIR
          : plan.targetWorktree ? (target.exists ? target.hash : EMPTY)
            : plan.targetOid ? plan.targetOid : EMPTY,
      };
      const mode = rowMode(row);
      if (mode !== null) fingerprint.mode = mode;
      const entry = {
        key: entryKey(row.status, row.path, row.oldPath),
        status: row.status,
        change: row.change,
        path: row.path,
        oldPath: row.oldPath,
        kind,
        isUntracked: row.status === 'untracked',
        hasBothSides: false,
        additions: kind === 'text' ? (row.status === 'untracked' ? target.lines || 0 : counts?.additions || 0) : 0,
        deletions: kind === 'text' && counts ? counts.deletions : 0,
        fingerprint,
      };
      if (kind === 'submodule') {
        entry.submodule = submoduleShas(row);
        fingerprint.gitlink = { oldSha: entry.submodule.oldSha, newSha: entry.submodule.newSha };
      } else if (kind === 'symlink') {
        entry.symlink = { target: await readSymlinkTarget(root, plan, target) };
      }
      entries.push(entry);
      if (!statusByPath.has(row.path)) statusByPath.set(row.path, new Set());
      statusByPath.get(row.path).add(row.status);
    }
    for (const entry of entries) {
      const statuses = statusByPath.get(entry.path);
      entry.hasBothSides = !!statuses && statuses.has('staged') && statuses.has('unstaged');
    }
    return {
      repo: freshRepo,
      cwd: root,
      state: 'ok',
      entries,
      summary: summarize(entries, truncated),
      generatedAt: Date.now(),
      stagedFingerprint: await readIndexFingerprint(root),
    };
  }

  const MISSING_SCAN = Object.freeze({ exists: false, isDir: false, symlink: false, size: 0, buf: null, hash: null, head: null, lines: 0 });
  const DIR_SCAN = Object.freeze({ exists: true, isDir: true, symlink: false, size: 0, buf: null, hash: null, head: null, lines: 0 });

  /** Submodule shas come from the status record: HEAD/index/ours depending on the row. */
  function submoduleShas(row) {
    const record = row.record;
    const nonzero = (value) => (value && !isZeroOid(value) ? value : null);
    const baseSha = row.status === 'staged' ? record.hH : row.status === 'unstaged' ? record.hI : row.status === 'conflict' ? record.h2 : null;
    return { oldSha: nonzero(baseSha), newSha: nonzero(row.status === 'staged' ? record.hI : null) };
  }

  /** Symlink target text: worktree link bytes, or the small blob the index records. */
  async function readSymlinkTarget(root, plan, target) {
    if (plan.targetWorktree) return target.symlink ? target.targetText ?? null : null;
    if (!plan.targetOid) return null;
    const contents = await readObjects(root, [plan.targetOid]);
    const buf = contents.get(plan.targetOid);
    return buf ? buf.toString('utf8') : null;
  }

  /** Canonical fingerprint of the complete index (see computeIndexFingerprint). */
  async function readIndexFingerprint(cwd) {
    const result = await invoke(['ls-files', '-s', '-z'], { cwd });
    if (result.code !== 0) throw gitFailure('git ls-files failed', ['ls-files'], result);
    return computeIndexFingerprint(result.stdout);
  }

  function summarize(entries, truncated) {
    const summary = {
      files: 0, entries: entries.length, staged: 0, unstaged: 0, untracked: 0, conflicts: 0,
      stagedAdditions: 0, stagedDeletions: 0, unstagedAdditions: 0, unstagedDeletions: 0,
      untrackedFiles: 0, truncated,
    };
    const paths = new Set();
    for (const entry of entries) {
      paths.add(entry.path);
      if (entry.status === 'staged') {
        summary.staged++;
        summary.stagedAdditions += entry.additions;
        summary.stagedDeletions += entry.deletions;
      } else if (entry.status === 'unstaged') {
        summary.unstaged++;
        summary.unstagedAdditions += entry.additions;
        summary.unstagedDeletions += entry.deletions;
      } else if (entry.status === 'untracked') {
        summary.untracked++;
        summary.untrackedFiles++;
      } else if (entry.status === 'conflict') {
        summary.conflicts++;
      }
    }
    summary.files = paths.size;
    return summary;
  }

  /**
   * Which byte sources make up this row's fingerprint pair: git object ids,
   * worktree reads, absent ('empty') or submodule dir.
   */
  function sidePlan(row) {
    const r = row.record;
    const oid = (value) => (value && !isZeroOid(value) ? value : null);
    const targetDir = r.mW === '160000' || (r.sub && r.sub[0] === 'S');
    if (row.status === 'untracked') return { baseOid: null, baseDir: false, targetOid: null, targetDir: false, targetWorktree: true };
    if (row.status === 'conflict') return { baseOid: oid(r.h2), baseDir: r.m2 === '160000', targetOid: null, targetDir: !!targetDir, targetWorktree: true };
    if (row.status === 'staged') return { baseOid: oid(r.hH), baseDir: r.mH === '160000', targetOid: oid(r.hI), targetDir: r.mI === '160000', targetWorktree: false };
    return { baseOid: oid(r.hI), baseDir: r.mI === '160000', targetOid: null, targetDir: !!targetDir, targetWorktree: true };
  }

  async function readNumstatZ(cwd, cached) {
    const argv = ['diff', '--numstat', '-z', '--no-color'];
    if (cached) argv.push('--cached', '-M');
    const result = await invoke(argv, { cwd });
    if (result.code !== 0) return new Map();
    return parseNumstatZ(result.stdout);
  }

  function entryKey(status, relPath, oldPath) {
    if (status === 'staged') return oldPath ? `staged:${oldPath}:${relPath}` : `staged:${relPath}`;
    if (status === 'unstaged') return `unstaged:${relPath}`;
    if (status === 'untracked') return `untracked:${relPath}`;
    return `conflict:${relPath}`;
  }

  // --- entry diff -----------------------------------------------------------

  function findEntry(listing, key) {
    const entry = listing && listing.entries ? listing.entries.find((item) => item.key === key) : null;
    if (!entry) throw new GitError('entry/not-found', 'no current entry for that key', { key });
    return entry;
  }

  function assertFreshFingerprint(key, expected, actual) {
    if (!fingerprintEquals(expected, actual)) {
      throw new GitError('entry/stale', 'entry changed since it was loaded', { key, expected: expected ?? null, actual });
    }
  }

  /**
   * Validate the client's expected fingerprints for a write that affects a whole
   * set of entries. `exact` is used by the `"all"` form: the expected key set
   * must match the affected set exactly (nothing hidden, nothing extra). A
   * missing/invalid `expected` is treated as stale — the write is never guessed.
   */
  function validateExpectedFingerprints(targets, expected, { exact }) {
    if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
      throw new GitError('entry/stale', 'missing expected fingerprints; refresh and retry', {
        expected: null,
        actual: targets.length,
      });
    }
    if (exact) {
      const targetKeys = new Set(targets.map((entry) => entry.key));
      const expectedKeys = Object.keys(expected);
      const extra = expectedKeys.filter((key) => !targetKeys.has(key));
      const missing = [...targetKeys].filter((key) => !Object.prototype.hasOwnProperty.call(expected, key));
      if (extra.length > 0 || missing.length > 0) {
        throw new GitError('entry/stale', 'expected fingerprints do not cover the affected entries', {
          expected: expectedKeys.sort().slice(0, 100),
          actual: [...targetKeys].sort().slice(0, 100),
        });
      }
    }
    for (const target of targets) {
      const expectedFingerprint = expected[target.key];
      if (!fingerprintEquals(expectedFingerprint, target.fingerprint)) {
        throw new GitError('entry/stale', 'entry changed since it was loaded', {
          key: target.key,
          expected: expectedFingerprint ?? null,
          actual: target.fingerprint,
        });
      }
    }
  }

  async function readRawRecords(root, argv) {
    const result = await invoke(argv, { cwd: root, literal: true });
    if (result.code !== 0) return [];
    return parseRawDiffZ(result.stdout);
  }

  function makeSide({ label, ref, exists, dir, buf, scan, size }) {
    const bytes = dir ? 0 : Number.isFinite(size) ? size : scan ? scan.size : buf ? buf.length : 0;
    const binary = !dir && looksBinary(scan ? scan.head || scan.buf : buf);
    const tooLarge = !dir && bytes > CAPS.maxDiffBytes;
    const content = !exists || dir || binary || tooLarge ? null : buf || (scan && scan.buf) || null;
    let text = '';
    let lines = 0;
    let truncated = false;
    if (content) {
      const total = countTextLines(content);
      truncated = total > CAPS.maxDiffLines;
      text = truncated ? truncateText(content, CAPS.maxDiffLines) : content.toString('utf8');
      lines = truncated ? CAPS.maxDiffLines : total;
    }
    return {
      label: exists ? label : 'Empty', ref: exists ? ref : 'empty', exists: !!exists,
      binary: !!binary, tooLarge: !!tooLarge, truncated, encoding: binary ? 'binary' : 'utf8',
      bytes: exists && !dir ? bytes : 0, lines, text,
    };
  }

  function contractHunk(filePatch, rawHunk, index) {
    return {
      index,
      header: rawHunk.headerText,
      oldStart: rawHunk.oldStart,
      oldLines: rawHunk.oldLines,
      newStart: rawHunk.newStart,
      newLines: rawHunk.newLines,
      section: rawHunk.section,
      lines: rawHunk.lines.map((line) => ({ ...line })),
      patch: buildSingleHunkPatch(filePatch, rawHunk).toString('utf8'),
    };
  }

  /**
   * Compute an EntryDiff plus the raw parsed patch needed for single-hunk
   * application. Always reads current repository content — never the caller's
   * cached bytes.
   */
  async function computeDiff(repo, entry) {
    const root = repo.root;
    const staged = entry.status === 'staged';
    const unstaged = entry.status === 'unstaged';
    const untracked = entry.status === 'untracked';
    const conflict = entry.status === 'conflict';
    const submodule = entry.kind === 'submodule';
    const symlink = entry.kind === 'symlink';

    // --- identities / sizes (fresh reads) ----------------------------------
    const entryFingerprint = entry.fingerprint !== null && typeof entry.fingerprint === 'object' ? entry.fingerprint : null;
    // A submodule side is a directory when the fresh status marked that side as
    // one ('dir'); an added or deleted gitlink has an empty side instead.
    const baseDir = submodule && entryFingerprint !== null && entryFingerprint.base === DIR;
    const targetDir = submodule && entryFingerprint !== null && entryFingerprint.target === DIR;
    let baseSpec = null;
    let targetSpec = null;
    let targetScan = null;

    if (conflict) {
      baseSpec = `:2:${entry.path}`;
    } else if (staged) {
      if (repo.headSha && !baseDir) baseSpec = `HEAD:${entry.oldPath || entry.path}`;
      if (!targetDir) targetSpec = `:0:${entry.path}`;
    } else if (unstaged) {
      if (!baseDir) baseSpec = `:0:${entry.path}`;
      if (!targetDir) targetScan = await scanWorktreeFile(root, entry.path);
    } else if (untracked) {
      targetScan = await scanWorktreeFile(root, entry.path);
    }

    const baseOid = baseSpec === null ? null : await resolveObject(root, baseSpec);
    const targetOid = targetSpec === null ? null : await resolveObject(root, targetSpec);
    const objectSizes = await readObjectSizes(root, [baseOid, targetOid].filter(Boolean));
    const baseSize = baseDir ? 0 : baseOid ? objectSizes.get(baseOid) ?? 0 : 0;
    const targetSize = targetDir ? 0 : targetOid ? objectSizes.get(targetOid) ?? 0 : targetScan ? targetScan.size : 0;
    // Size gate before any content read: a blob larger than the display cap is
    // identified by object id only and reported as tooLarge without buffering it.
    const contentOids = [baseOid, targetOid].filter((oid) => oid && (objectSizes.get(oid) ?? 0) <= CAPS.maxDiffBytes);
    const contents = contentOids.length > 0 ? await readObjects(root, contentOids) : new Map();
    const baseBuf = baseOid === null ? null : contents.get(baseOid) ?? null;
    const targetBuf = targetOid === null ? null : contents.get(targetOid) ?? null;

    const baseExists = baseDir || baseOid !== null;
    const targetExists = targetDir || targetOid !== null || (targetScan ? targetScan.exists : false);
    const baseBinary = !baseDir && looksBinary(baseBuf);
    const targetBinary = !targetDir && (targetScan ? looksBinary(targetScan.head || targetScan.buf) : looksBinary(targetBuf));

    const fingerprint = {
      base: baseDir ? DIR : baseOid !== null ? baseOid : EMPTY,
      target: targetDir ? DIR : targetOid !== null ? targetOid : targetScan ? (targetScan.exists ? targetScan.hash : EMPTY) : EMPTY,
    };
    // Mode pair and submodule gitlink identity come from the fresh status row the
    // caller passed in; the content identity is re-derived from the repository.
    if (entry.fingerprint !== null && typeof entry.fingerprint === 'object') {
      if (typeof entry.fingerprint.mode === 'string') fingerprint.mode = entry.fingerprint.mode;
      const gitlink = entry.fingerprint.gitlink;
      if (gitlink !== null && typeof gitlink === 'object') {
        fingerprint.gitlink = {
          oldSha: typeof gitlink.oldSha === 'string' ? gitlink.oldSha : null,
          newSha: typeof gitlink.newSha === 'string' ? gitlink.newSha : null,
        };
      }
    }

    // --- reference / label metadata ----------------------------------------
    const refs = staged
      ? { baseLabel: repo.headSha ? 'HEAD' : 'Empty', targetLabel: 'Index', baseRef: `HEAD:${entry.oldPath || entry.path}`, targetRef: `:0:${entry.path}` }
      : unstaged
        ? { baseLabel: 'Index', targetLabel: 'Worktree', baseRef: `:0:${entry.path}`, targetRef: `worktree:${entry.path}` }
        : untracked
          ? { baseLabel: 'Empty', targetLabel: 'Untracked', baseRef: 'empty', targetRef: `worktree:${entry.path}` }
          : { baseLabel: 'Index (ours)', targetLabel: 'Worktree', baseRef: `:2:${entry.path}`, targetRef: `worktree:${entry.path}` };
    const base = makeSide({ label: refs.baseLabel, ref: refs.baseRef, exists: baseExists, dir: baseDir, buf: baseBuf, size: baseSize });
    const target = makeSide({ label: refs.targetLabel, ref: refs.targetRef, exists: targetExists, dir: targetDir, buf: targetBuf, scan: targetScan, size: targetSize });

    // --- unsupported classification (before spending on patches) -----------
    let unsupported = null;
    if (conflict) unsupported = { code: 'conflict', message: 'unmerged path' };
    else if (submodule) unsupported = { code: 'submodule', message: 'submodule changes are not diffed as text' };
    else if (symlink) unsupported = { code: 'symlink', message: 'symlink changes are not diffed as text' };
    else if (baseBinary || targetBinary || entry.kind === 'binary') unsupported = { code: 'binary', message: 'binary file' };
    else if (base.tooLarge || target.tooLarge) unsupported = { code: 'too-large', message: `file exceeds ${CAPS.maxDiffBytes} bytes` };

    // --- mode change --------------------------------------------------------
    let modeChange = null;
    if (!unsupported && (staged || unstaged)) {
      const paths = staged && entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
      const baseArgs = staged ? ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-color', '-M', '--'] : ['diff', '--raw', '-z', '--no-abbrev', '--no-color', '--'];
      const records = await readRawRecords(root, [...baseArgs, ...paths]);
      const record = records.find((item) => item.path === entry.path);
      if (record && !isZeroOid(record.oldMode) && !isZeroOid(record.newMode) && record.oldMode !== record.newMode) {
        modeChange = { oldMode: record.oldMode, newMode: record.newMode };
      }
    }

    // --- hunks --------------------------------------------------------------
    let filePatch = null;
    let rawHunks = [];
    if (!unsupported) {
      if (staged || unstaged) {
        const paths = staged && entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
        const diffArgs = staged
          ? ['diff', '--cached', '--no-color', '--no-ext-diff', '-U3', '-M', '--']
          : ['diff', '--no-color', '--no-ext-diff', '-U3', '--'];
        const result = await invoke([...diffArgs, ...paths], { cwd: root, literal: true });
        if (result.code !== 0) throw gitFailure('git diff failed', diffArgs, result);
        filePatch = firstFile(parsePatch(result.stdout));
        rawHunks = allHunks(parsePatch(result.stdout));
      } else if (untracked && targetScan && targetScan.buf) {
        const synthetic = makeNewFilePatch(entry.path, targetScan.buf);
        filePatch = firstFile(synthetic);
        rawHunks = allHunks(synthetic);
      }
      if (modeChange && rawHunks.length === 0) {
        unsupported = { code: 'mode-only', message: `mode changed ${modeChange.oldMode} -> ${modeChange.newMode}` };
      } else if (entry.change === 'typechange' && entry.kind === 'text') {
        unsupported = { code: 'mode-only', message: 'file type changed' };
      }
    }

    const hunks = rawHunks.map((hunk, index) => contractHunk(filePatch, hunk, index));
    const stats = { additions: 0, deletions: 0 };
    for (const hunk of rawHunks) {
      for (const line of hunk.lines) {
        if (line.kind === '+') stats.additions++;
        else if (line.kind === '-') stats.deletions++;
      }
    }

    const entryDiff = {
      repo,
      entry: { ...entry, fingerprint },
      comparison: { baseLabel: base.label, targetLabel: target.label, baseRef: base.ref, targetRef: target.ref },
      base,
      target,
      hunks,
      stats,
      unsupported,
      modeChange,
    };
    return { entryDiff, filePatch, rawHunks };
  }

  // --- mutating whole-file operations ---------------------------------------

  async function listingFor(repo, providedStatus) {
    const listing = providedStatus || await status(repo);
    const repoRef = listing.repo || (repo && repo.root ? repo : await resolveRepo(repo));
    return { listing, repoRef };
  }

  /**
   * Status payload used by a `"all"` write: the displayed entries stay capped,
   * but the write affects the whole repository, so a second untruncated read is
   * used when the display list was cut.
   */
  async function listingForAll(repoRef, listing) {
    if (!listing.summary || listing.summary.truncated !== true) return listing;
    return status(repoRef, { maxEntries: Number.POSITIVE_INFINITY });
  }

  /** Split a path list into `git add` argv batches that stay under the OS cap. */
  function chunkPaths(paths, maxChars = 8_000) {
    const chunks = [];
    let current = [];
    let length = 0;
    for (const relPath of paths) {
      const size = relPath.length + 1;
      if (current.length > 0 && length + size > maxChars) {
        chunks.push(current);
        current = [];
        length = 0;
      }
      current.push(relPath);
      length += size;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  async function stage(repo, params = {}) {
    const { keys, includeUntracked, expected } = params;
    const { listing, repoRef } = await listingFor(repo, params.status);
    const targets = [];
    const skipped = [];
    if (keys === 'all') {
      // "all" always means the whole repository, not just the displayed rows.
      const full = await listingForAll(repoRef, listing);
      for (const entry of full.entries) {
        if (entry.status === 'conflict') skipped.push(entry.key);
        else if (entry.status === 'unstaged') targets.push(entry);
        else if (entry.status === 'untracked' && includeUntracked === true) targets.push(entry);
      }
      validateExpectedFingerprints(targets, expected, { exact: true });
    } else if (Array.isArray(keys)) {
      const byKey = new Map(listing.entries.map((entry) => [entry.key, entry]));
      const requested = [];
      for (const key of keys) {
        const entry = byKey.get(key);
        if (!entry) throw new GitError('entry/not-found', 'no current entry for that key', { key });
        requested.push(entry);
      }
      validateExpectedFingerprints(requested, expected, { exact: false });
      for (const entry of requested) {
        if (entry.status === 'staged') continue;
        targets.push(entry); // conflicts are staged explicitly -> marks resolved
      }
    } else {
      throw new GitError('internal', 'stage: keys must be an array or "all"', {});
    }
    const paths = [...new Set(targets.map((entry) => entry.path))];
    for (const chunk of chunkPaths(paths)) {
      const result = await invoke(['add', '-A', '--', ...chunk], { cwd: repoRef.root, literal: true });
      if (result.code !== 0) throw gitFailure('git add failed', ['add'], result);
    }
    const result = { affected: [...new Set(targets.map((entry) => entry.path))] };
    // Staging "all" never resolves conflicts; the Host can tell the user which
    // paths were left alone.
    if (skipped.length) result.skipped = skipped;
    return result;
  }

  /** Fresh view of the staged scope; used to validate unstage keys. */
  async function readStagedKeys(root) {
    const records = await readRawRecords(root, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-color', '-M']);
    const map = new Map();
    for (const record of records) {
      if (record.status === 'U') continue; // unmerged paths are not "staged changes"
      const key = entryKey('staged', record.path, record.oldPath);
      map.set(key, { path: record.path, oldPath: record.oldPath, paths: record.oldPath ? [record.oldPath, record.path] : [record.path] });
    }
    return map;
  }

  async function unstage(repo, params = {}) {
    const { keys, expected } = params;
    const { listing, repoRef } = await listingFor(repo, params.status);
    const root = repoRef.root;
    if (keys === 'all') {
      const full = await listingForAll(repoRef, listing);
      const targets = full.entries.filter((entry) => entry.status === 'staged');
      validateExpectedFingerprints(targets, expected, { exact: true });
      const affected = targets.map((entry) => entry.path);
      const argv = repoRef.headSha
        ? ['restore', '--staged', '--', '.']
        : ['rm', '-r', '--cached', '-q', '--', '.'];
      const result = await invoke(argv, { cwd: root, literal: true });
      if (result.code !== 0) {
        const stderr = clip(result.stderr);
        // A conflicted index cannot be written back with restore; a mixed reset
        // is the only way to return the whole index to HEAD.
        if (repoRef.headSha && /unmerged|needs merge|conflict/i.test(stderr)) {
          const reset = await invoke(['reset', '-q'], { cwd: root });
          if (reset.code !== 0) throw gitFailure('git reset failed', ['reset'], reset);
          return { affected };
        }
        throw gitFailure('git unstage failed', argv, result);
      }
      return { affected };
    }
    if (!Array.isArray(keys)) throw new GitError('internal', 'unstage: keys must be an array or "all"', {});
    if (keys.length === 0) {
      validateExpectedFingerprints([], expected, { exact: false });
      return { affected: [] };
    }
    const fresh = await readStagedKeys(root);
    const requested = [];
    const byKey = new Map(listing.entries.map((entry) => [entry.key, entry]));
    for (const key of keys) {
      const entry = byKey.get(key);
      if (!entry) throw new GitError('entry/not-found', 'no staged entry for that key', { key });
      requested.push(entry);
    }
    validateExpectedFingerprints(requested, expected, { exact: false });
    const paths = new Set();
    const affected = [];
    for (const key of keys) {
      const stagedEntry = fresh.get(key);
      if (!stagedEntry) throw new GitError('entry/not-found', 'no staged entry for that key', { key });
      for (const p of stagedEntry.paths) paths.add(p);
      affected.push(stagedEntry.path);
    }
    const argv = repoRef.headSha
      ? ['restore', '--staged', '--', ...paths]
      : ['rm', '--cached', '-q', '--', ...paths];
    const result = await invoke(argv, { cwd: root, literal: true });
    if (result.code !== 0) throw gitFailure('git unstage failed', argv, result);
    return { affected: [...new Set(affected)] };
  }

  async function discard(repo, params = {}) {
    const { key, expected } = params;
    const { listing, repoRef } = await listingFor(repo, params.status);
    const entry = findEntry(listing, key);
    if (entry.status !== 'unstaged') {
      throw new GitError('entry/unsupported', `discard is only supported for unstaged entries (got ${entry.status})`, { key, status: entry.status });
    }
    if (entry.kind === 'submodule') {
      throw new GitError('entry/unsupported', 'discard of submodule content is not supported', { key });
    }
    const { entryDiff } = await computeDiff(repoRef, entry);
    assertFreshFingerprint(key, expected, entryDiff.entry.fingerprint);
    const result = await invoke(['restore', '--worktree', '--', entry.path], { cwd: repoRef.root, literal: true });
    if (result.code !== 0) {
      const failure = gitFailure('git restore --worktree failed', ['restore', '--worktree'], result);
      if (/unmerged|needs merge/i.test(failure.details.stderr)) {
        throw new GitError('entry/conflict', 'path is unmerged', { key, path: entry.path });
      }
      throw failure;
    }
    return { affected: [entry.path] };
  }

  // --- single-hunk operations ----------------------------------------------

  function hunkIndexOf(filePatch, rawHunks, hunkIndex) {
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= rawHunks.length) {
      throw new GitError('patch/mismatch', `hunk ${hunkIndex} is not present in the current diff`, {
        hunkIndex, hunkCount: rawHunks.length,
      });
    }
    return findMatchingHunk(rawHunks, rawHunks[hunkIndex]);
  }

  async function applySingleHunk(repoRef, filePatch, rawHunks, hunkIndex, mode) {
    const match = hunkIndexOf(filePatch, rawHunks, hunkIndex);
    if (match !== hunkIndex) {
      throw new GitError('patch/mismatch', 'hunk identity changed while applying', { hunkIndex, matched: match });
    }
    const patch = buildSingleHunkPatch(filePatch, rawHunks[hunkIndex]);
    const argv = ['apply', mode === 'worktree' ? '-R' : '--cached'];
    if (mode === 'reverse-index') argv.push('-R');
    argv.push('-');
    const result = await invoke(argv, { cwd: repoRef.root, input: patch });
    if (result.code !== 0) {
      throw new GitError('patch/mismatch', `git apply failed (exit ${result.code})`, {
        hunkIndex,
        exitCode: result.code,
        stdout: clip(result.stdout),
        stderr: clip(result.stderr),
      });
    }
  }

  async function assertHunkTarget(repoRef, entry, hunkIndex, expected, allowedStatuses) {
    if (!allowedStatuses.includes(entry.status)) {
      if (entry.status === 'conflict') {
        throw new GitError('entry/conflict', 'unmerged entries cannot be patched by hunk', { key: entry.key });
      }
      throw new GitError('entry/unsupported', `hunk operation is not supported for ${entry.status} entries`, {
        key: entry.key, status: entry.status,
      });
    }
    if (entry.change === 'renamed' || entry.change === 'copied') {
      throw new GitError('entry/unsupported', 'hunk operations on renames/copies are not supported; stage the whole file instead', {
        key: entry.key, change: entry.change,
      });
    }
    if (entry.change === 'typechange') {
      throw new GitError('entry/unsupported', 'hunk operations on file type changes are not supported', { key: entry.key });
    }
    const diff = await computeDiff(repoRef, entry);
    assertFreshFingerprint(entry.key, expected, diff.entryDiff.entry.fingerprint);
    if (diff.entryDiff.unsupported) {
      throw new GitError('entry/unsupported', diff.entryDiff.unsupported.message, {
        key: entry.key, unsupported: diff.entryDiff.unsupported.code,
      });
    }
    hunkIndexOf(diff.filePatch, diff.rawHunks, hunkIndex);
    return diff;
  }

  async function stageHunk(repo, params = {}) {
    const { key, hunkIndex, expected } = params;
    const { listing, repoRef } = await listingFor(repo, params.status);
    const entry = findEntry(listing, key);
    const diff = await assertHunkTarget(repoRef, entry, hunkIndex, expected, ['unstaged', 'untracked']);
    await applySingleHunk(repoRef, diff.filePatch, diff.rawHunks, hunkIndex, 'index');
    return { affected: [entry.path] };
  }

  async function unstageHunk(repo, params = {}) {
    const { key, hunkIndex, expected } = params;
    const { listing, repoRef } = await listingFor(repo, params.status);
    const entry = findEntry(listing, key);
    const diff = await assertHunkTarget(repoRef, entry, hunkIndex, expected, ['staged']);
    await applySingleHunk(repoRef, diff.filePatch, diff.rawHunks, hunkIndex, 'reverse-index');
    return { affected: [entry.path] };
  }

  async function discardHunk(repo, params = {}) {
    const { key, hunkIndex, expected } = params;
    const { listing, repoRef } = await listingFor(repo, params.status);
    const entry = findEntry(listing, key);
    const diff = await assertHunkTarget(repoRef, entry, hunkIndex, expected, ['unstaged']);
    await applySingleHunk(repoRef, diff.filePatch, diff.rawHunks, hunkIndex, 'worktree');
    return { affected: [entry.path] };
  }

  // --- commit ---------------------------------------------------------------

  function assertMessage(message) {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new GitError('commit/invalid-message', 'commit message is empty', {});
    }
  }

  async function commit(repo, params = {}) {
    const { message, expected } = params;
    assertMessage(message);
    const fresh = await status(repo);
    const root = fresh.repo.root;
    // Conflict and staged-set checks read the whole index, never the capped
    // display rows: a staged change beyond the display cap still blocks or
    // permits a commit correctly.
    const stagedRecords = await readRawRecords(root, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-color', '-M']);
    const conflictPaths = stagedRecords.filter((record) => record.status === 'U').map((record) => record.path);
    if (conflictPaths.length > 0) {
      throw new GitError('commit/conflict-pending', 'cannot commit while the index has unmerged paths', { paths: conflictPaths });
    }
    if (stagedRecords.length === 0) throw new GitError('commit/empty-index', 'nothing is staged', {});
    const exp = expected !== null && typeof expected === 'object' ? expected : null;
    const actual = { headSha: fresh.repo.headSha, stagedFingerprint: fresh.stagedFingerprint };
    if (!exp || exp.headSha !== actual.headSha || exp.stagedFingerprint !== actual.stagedFingerprint) {
      throw new GitError('commit/stale', 'repository changed since the commit expectation was taken', {
        expected: exp ? { headSha: exp.headSha, stagedFingerprint: exp.stagedFingerprint } : null,
        actual,
      });
    }
    const result = await invoke(['commit', '-F', '-'], { cwd: fresh.repo.root, input: Buffer.from(message, 'utf8') });
    if (result.code !== 0) {
      const stdout = clip(result.stdout);
      const stderr = clip(result.stderr);
      throw new GitError('commit/failed', `git commit failed (exit ${result.code})`, {
        exitCode: result.code,
        stdout,
        stderr,
        hookOutput: clip(Buffer.concat([result.stdout, result.stderr])),
      });
    }
    const log = await invoke(['log', '-1', '--format=%H%x00%h%x00%s'], { cwd: fresh.repo.root });
    if (log.code !== 0) throw gitFailure('unable to read the new commit', ['log'], log);
    const [headSha, shortSha, ...summaryParts] = log.stdout.toString('utf8').split('\u0000');
    const postStatus = await status(fresh.repo);
    return {
      repo: postStatus.repo,
      headSha: headSha.trim(),
      shortSha: (shortSha || '').trim(),
      summary: summaryParts.join('\u0000').trim(),
      status: postStatus,
    };
  }

  // --- push -----------------------------------------------------------------

  async function readUpstreamConfig(root, branch) {
    const remoteResult = await invoke(['config', '--get', `branch.${branch}.remote`], { cwd: root });
    const mergeResult = await invoke(['config', '--get', `branch.${branch}.merge`], { cwd: root });
    if (remoteResult.code !== 0 || mergeResult.code !== 0) return null;
    const remote = remoteResult.stdout.toString('utf8').trim();
    const merge = mergeResult.stdout.toString('utf8').trim();
    if (!remote || !merge || remote === '.') return null;
    const name = merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : merge;
    return { remote, branch: name, ref: merge };
  }

  function pickDefaultRemote(remotes) {
    const origin = remotes.find((item) => item.name === 'origin');
    return origin ? origin.name : remotes.length ? remotes[0].name : null;
  }

  /**
   * Remote-tracking ref that the "commits to push" preview compares against.
   * Never a local branch: a local `main` is not evidence about the remote.
   */
  async function remoteTrackingRef(root, remote, targetBranch) {
    if (!remote || !targetBranch) return null;
    const candidate = `refs/remotes/${remote}/${targetBranch}`;
    const result = await invoke(['rev-parse', '-q', '--verify', candidate], { cwd: root });
    return result.code === 0 ? candidate : null;
  }

  async function readCommits(root, range) {
    const result = await invoke(['log', '--no-color', '--format=%H%x00%h%x00%s', range], { cwd: root });
    if (result.code !== 0) return [];
    return result.stdout.toString('utf8').split('\n').filter(Boolean).map((line) => {
      const [sha, shortSha, ...subject] = line.split('\u0000');
      return { sha, shortSha, subject: subject.join('\u0000') };
    }).slice(0, CAPS.maxPushCommits);
  }

  async function pushPreview(repo, params = {}) {
    const { listing, repoRef } = await listingFor(repo, params.status);
    const sourceBranch = repoRef.branch;
    const remotes = repoRef.remotes || [];
    const defaultRemote = pickDefaultRemote(remotes);
    const requestedRemote = typeof params.remote === 'string' && params.remote.length > 0 ? params.remote : null;
    const remote = requestedRemote || defaultRemote;
    const upstream = sourceBranch ? await readUpstreamConfig(repoRef.root, sourceBranch) : null;
    // Target: an explicit request wins; otherwise follow the configured upstream
    // only when it lives on the selected remote; otherwise push to the same name.
    const targetBranch = params.targetBranch
      || (upstream && upstream.remote === remote ? upstream.branch : null)
      || sourceBranch;
    const commitsBase = await remoteTrackingRef(repoRef.root, remote, targetBranch);
    const commits = sourceBranch && repoRef.headSha
      ? await readCommits(repoRef.root, commitsBase ? `${commitsBase}..HEAD` : 'HEAD')
      : [];
    const reasons = [];
    if (!sourceBranch) reasons.push('detached HEAD');
    if (!remotes.length) reasons.push('no remotes');
    else if (requestedRemote && !remotes.some((item) => item.name === requestedRemote)) reasons.push('unknown remote');
    else if (!remote) reasons.push('no default remote');
    return {
      repo: repoRef,
      branch: sourceBranch,
      sourceBranch,
      targetBranch: targetBranch ?? null,
      remote: remote ?? null,
      remotes,
      upstream,
      defaultRemote,
      commits,
      commitsBase,
      canPush: reasons.length === 0,
      reason: reasons.length ? reasons.join('; ') : undefined,
    };
  }

  function mapPushFailure(argv, result) {
    const stdout = clip(result.stdout);
    const stderr = clip(result.stderr);
    const combined = `${stderr}\n${stdout}`;
    let code = 'internal';
    if (/non-fast-forward|\[rejected\]|\[remote rejected\]|failed to push some refs|fetch first/i.test(combined)) code = 'push/rejected';
    else if (/authentication failed|could not read username|permission denied|publickey|terminal prompts disabled|host key verification failed/i.test(combined)) code = 'push/auth';
    else if (/could not resolve host|connection refused|connection timed out|unable to access|recv failure|early eof|network is unreachable|timed out/i.test(combined)) code = 'push/network';
    return new GitError(code, 'git push failed', { argv: argv.slice(0, 3), exitCode: result.code, stdout, stderr });
  }

  async function push(repo, params = {}) {
    const { setUpstream } = params;
    const { repoRef } = await listingFor(repo, params.status);
    const remotes = repoRef.remotes || [];
    if (!remotes.length) throw new GitError('push/no-remote', 'repository has no remotes', {});
    // The source is always the current local branch; a client-supplied source is
    // never trusted (the wire only carries remote/targetBranch/setUpstream).
    const sourceBranch = repoRef.branch;
    if (!sourceBranch) throw new GitError('push/no-branch', 'cannot push a detached HEAD', {});
    const upstream = await readUpstreamConfig(repoRef.root, sourceBranch);
    const defaultRemote = pickDefaultRemote(remotes);
    const remote = params.remote || (upstream && remotes.some((item) => item.name === upstream.remote) ? upstream.remote : defaultRemote);
    if (!remote || !remotes.some((item) => item.name === remote)) {
      throw new GitError('push/no-remote', 'the requested remote is not configured', {
        remote: remote || null,
        remotes: remotes.map((item) => item.name),
      });
    }
    const targetBranch = params.targetBranch || (upstream ? upstream.branch : null) || sourceBranch;
    if (!targetBranch) throw new GitError('push/no-branch', 'no target branch to push to', {});
    let argv;
    if (setUpstream === true) {
      argv = ['push', '-u', remote, `refs/heads/${sourceBranch}:refs/heads/${targetBranch}`];
    } else {
      if (!upstream) {
        throw new GitError('push/upstream-missing', 'the branch has no upstream; retry with setUpstream', { branch: sourceBranch });
      }
      argv = ['push', remote, `refs/heads/${sourceBranch}:refs/heads/${targetBranch}`];
    }
    const result = await invoke(argv, { cwd: repoRef.root, env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    if (result.code !== 0) throw mapPushFailure(argv, result);
    const postStatus = await status(repoRef);
    return {
      repo: postStatus.repo,
      ok: true,
      remote,
      branch: sourceBranch,
      sourceBranch,
      targetBranch,
      setUpstream: setUpstream === true,
      stdout: clip(result.stdout),
      stderr: clip(result.stderr),
      status: postStatus,
    };
  }

  // --- diff entry lookup ----------------------------------------------------

  /**
   * Diff a single status entry. `opts.status` is an optional, already-fetched
   * StatusPayload used as a hint (the content is always re-read from git).
   */
  async function diff(repo, key, opts = {}) {
    const listing = opts.status || await status(repo);
    const entry = findEntry(listing, key);
    const repoRef = listing.repo || (repo && repo.root ? repo : await resolveRepo(repo));
    const { entryDiff } = await computeDiff(repoRef, entry);
    return entryDiff;
  }

  // --- remote configuration ------------------------------------------------

  /**
   * Configure a remote: add it, or update its URL when the name already exists.
   * Only local Git config is written — no network access is attempted, so a
   * wrong URL is reported by the next push/fetch, not here.
   */
  async function setRemote(repo, { name, url }) {
    const root = repo && typeof repo.root === 'string' ? repo.root : null;
    if (!root) throw new GitError('repo/no-git', 'no repository to configure');
    const remotes = await readRemotes(root);
    const exists = remotes.some((remote) => remote.name === name);
    const argv = exists ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url];
    const result = await invoke(argv, { cwd: root });
    if (result.code !== 0) {
      throw gitFailure(exists ? 'git remote set-url failed' : 'git remote add failed', argv, result, 'remote/failed');
    }
    return { name, url, created: !exists };
  }

  // --- public surface -------------------------------------------------------

  async function gitVersion() {
    if (versionCache) return versionCache;
    const result = await invokeOrThrow('git --version failed', ['--version']);
    const text = result.stdout.toString('utf8').trim();
    const match = /^git version\s+(.+)$/.exec(text);
    versionCache = match ? match[1].trim() : text;
    return versionCache;
  }

  return {
    resolveRepo,
    status,
    diff,
    stage,
    unstage,
    discard,
    stageHunk,
    unstageHunk,
    discardHunk,
    commit,
    pushPreview,
    push,
    setRemote,
    gitVersion,
  };
}

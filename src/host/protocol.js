/**
 * dsh-code-review — Host protocol primitives.
 *
 * The wire boundary shared by the Fetch route, the method table and the
 * client RPC layer: response envelopes plus the readers that normalise
 * untrusted request parameters before they reach git. Keeping it in one
 * module makes the boundary easy to audit against docs/protocol.md.
 *
 * Error messages are stable English diagnostics; user-facing wording comes from
 * the client, which maps `error.code` to localized text. No raw exception text
 * and no request-controlled content is ever put into a message.
 */
import { sep } from 'node:path';

const MAX_KEYS = 5_000;
const MAX_REMOTE_NAME = 200;
const MAX_REMOTE_URL = 2_048;
const MAX_BRANCH_NAME = 255;
/** Remote names stay conservative: letter/digit first, then name-safe chars. */
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Normalise a git path from the wire to native display form. */
export function toDisplayPath(path) {
  return String(path).split('/').join(sep);
}

/**
 * Normalise anything the UI can send before it reaches git.
 * @returns {{ sessionId?: string, cwd?: string }}
 */
export function readTargetParams(params) {
  const target = {};
  if (typeof params?.sessionId === 'string' && params.sessionId.length > 0) target.sessionId = params.sessionId;
  if (typeof params?.cwd === 'string' && params.cwd.length > 0) target.cwd = params.cwd;
  return target;
}

export function readKeyList(params) {
  if (params?.keys === 'all') return 'all';
  if (!Array.isArray(params?.keys)) throw new ProtocolError('internal', 'keys must be an array of entry keys or "all"');
  if (params.keys.length > MAX_KEYS) throw new ProtocolError('internal', 'too many entry keys in one request');
  const keys = [];
  for (const key of params.keys) {
    if (typeof key !== 'string' || key.length === 0) throw new ProtocolError('internal', 'entry keys must be non-empty strings');
    keys.push(key);
  }
  return keys;
}

export function readKey(params) {
  if (typeof params?.key !== 'string' || params.key.length === 0) {
    throw new ProtocolError('entry/not-found', 'missing entry key');
  }
  return params.key;
}

export function readFingerprint(params) {
  const expected = params?.expected;
  if (expected === null || typeof expected !== 'object') {
    throw new ProtocolError('entry/stale', 'missing expected fingerprint; refresh and retry');
  }
  if (typeof expected.base !== 'string' || typeof expected.target !== 'string') {
    throw new ProtocolError('entry/stale', 'invalid expected fingerprint; refresh and retry');
  }
  return copyFingerprint(expected);
}

/**
 * Read the whole-file `expected` map: `Record<entryKey, Fingerprint>` whose
 * values are the fingerprint objects the client last received from `status`.
 * Returns `undefined` when the field is absent so the git layer can refuse the
 * write with `entry/stale` instead of guessing.
 */
export function readExpectedMap(params) {
  const raw = params?.expected;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProtocolError('entry/stale', 'invalid expected fingerprints; refresh and retry');
  }
  const expected = {};
  for (const key of Object.keys(raw)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    expected[key] = copyFingerprint(raw[key]);
  }
  return expected;
}

/** Only the documented fingerprint fields survive the wire boundary. */
function copyFingerprint(value) {
  const source = value !== null && typeof value === 'object' ? value : null;
  if (source === null || typeof source.base !== 'string' || typeof source.target !== 'string') {
    throw new ProtocolError('entry/stale', 'invalid expected fingerprint; refresh and retry');
  }
  const fingerprint = { base: source.base, target: source.target };
  if (typeof source.mode === 'string') fingerprint.mode = source.mode;
  const gitlink = source.gitlink !== null && typeof source.gitlink === 'object' ? source.gitlink : null;
  if (gitlink !== null) {
    fingerprint.gitlink = {
      oldSha: typeof gitlink.oldSha === 'string' ? gitlink.oldSha : null,
      newSha: typeof gitlink.newSha === 'string' ? gitlink.newSha : null,
    };
  }
  return fingerprint;
}

/**
 * Classify request entries: only the entry key is trusted. Everything else the
 * client could send (status, path, kind, excerpt candidates) is ignored and
 * rebuilt by the Host from a fresh `status` read.
 * @returns {string[] | undefined} undefined = classify every current entry
 */
export function readClassifyKeys(params) {
  const raw = params?.entries;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ProtocolError('ai/invalid', 'entries must be an array of { key } objects');
  if (raw.length > MAX_KEYS) throw new ProtocolError('ai/invalid', 'too many classification entries');
  const keys = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') throw new ProtocolError('ai/invalid', 'invalid classification entry');
    if (typeof entry.key !== 'string' || entry.key.length === 0) {
      throw new ProtocolError('ai/invalid', 'invalid classification entry key');
    }
    keys.push(entry.key);
  }
  return keys;
}

/** Optional remote name for push requests. */
export function readRemoteName(params) {
  const value = params?.remote;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REMOTE_NAME) {
    throw new ProtocolError('push/no-remote', 'invalid remote name');
  }
  if (/[\u0000-\u0020\u007f]/.test(value)) throw new ProtocolError('push/no-remote', 'invalid remote name');
  return value;
}

/**
 * Read the name + URL for `remoteSet`. The URL is only syntax-checked here; a
 * valid-looking but unreachable URL is accepted because configuring a remote
 * writes local Git config only and never touches the network.
 * @returns {{ name: string, url: string }}
 */
export function readRemoteConfig(params) {
  const name = params?.name;
  if (typeof name !== 'string' || name.length > MAX_REMOTE_NAME || !REMOTE_NAME_PATTERN.test(name)) {
    throw new ProtocolError('remote/invalid', 'invalid remote name');
  }
  const url = typeof params?.url === 'string' ? params.url.trim() : '';
  if (url.length === 0 || url.length > MAX_REMOTE_URL) {
    throw new ProtocolError('remote/invalid', 'invalid remote URL');
  }
  /* Control characters would break the command line / config file; a leading
   * dash could be read as a git option even though git receives argv arrays. */
  if (/[\u0000-\u001f\u007f]/.test(url) || url.startsWith('-')) {
    throw new ProtocolError('remote/invalid', 'invalid remote URL');
  }
  return { name, url };
}

/** Optional target branch name for push requests. */
export function readBranchName(params) {
  const value = params?.targetBranch;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BRANCH_NAME) {
    throw new ProtocolError('push/no-branch', 'invalid target branch name');
  }
  if (/[\u0000-\u0020\u007f\\:~^?*\[]/.test(value)) {
    throw new ProtocolError('push/no-branch', 'invalid target branch name');
  }
  if (value.startsWith('-') || value.startsWith('.') || value.endsWith('/') || value.endsWith('.')) {
    throw new ProtocolError('push/no-branch', 'invalid target branch name');
  }
  if (value.includes('..') || value.includes('@{') || value.endsWith('.lock')) {
    throw new ProtocolError('push/no-branch', 'invalid target branch name');
  }
  return value;
}

/** A problem reportable through the plugin protocol instead of a transport fault. */
export class ProtocolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.details = details;
  }
}

export function protocolFailure(code, message, details) {
  const error = { code, message };
  if (details !== undefined) {
    try {
      error.details = JSON.parse(JSON.stringify(details));
    } catch {
      /* details are diagnostics only */
    }
  }
  return { ok: false, error };
}

export function success(value) {
  return { ok: true, value };
}

export function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

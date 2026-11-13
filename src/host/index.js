/**
 * dsh-code-review — Host half.
 *
 * Responsibilities:
 *  - run real git commands (argv arrays only, never a shell) through `createGit`;
 *  - authenticate the browser through DSH's own `/api` Connection carrier by
 *    registering an exact Fetch route (`ctx.connection.fetch.register`);
 *  - resolve the repository from the requesting session's working directory;
 *  - serialise this plugin's own writes per repository so two panel actions
 *    cannot interleave;
 *  - expose optional AI grouping through DSH's `llm` service.
 *
 * What it deliberately does not do: no history browsing, no branch management,
 * no stash, no rebase, no conflict editor, no automatic push/force-push.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AiError, createClassifier } from './ai.js';
import { GitError, createGit, createNodeExecutor } from './git.js';
import { createModelCatalog } from './models.js';
import {
  ProtocolError,
  jsonResponse,
  protocolFailure,
  readBranchName,
  readClassifyKeys,
  readExpectedMap,
  readFingerprint,
  readGrouping,
  readKey,
  readKeyList,
  readRemoteConfig,
  readRemoteName,
  success,
} from './protocol.js';
import { createSettingsStore } from './settings.js';

const ROUTE_PATH = '/api/code-review';
const MAX_CLASSIFY_ENTRIES = 400;
const CLASSIFY_TIMEOUT_MS = 45_000;
const COMMIT_MESSAGE_TIMEOUT_MS = 45_000;
/** Prompt budget for the staged patch sent when drafting a commit message. */
const MAX_COMMIT_MESSAGE_DIFF_CHARS = 24_000;
const EXCERPT_LIMIT = 20;
const EXCERPT_BYTES = 2 * 1024;
const CLASSIFY_CACHE_LIMIT = 4;

/** Paths whose content is never sent to a model for classification. */
const SENSITIVE_PATH = new RegExp(
  [
    String.raw`(^|[\\/])\.env[^\\/]*$`,
    String.raw`(^|[\\/])\.npmrc$`,
    String.raw`(^|[\\/])\.netrc$`,
    String.raw`(^|[\\/])\.pypirc$`,
    String.raw`(^|[\\/])\.git-credentials$`,
    String.raw`(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$`,
    String.raw`\.(pem|key|p12|pfx|keystore|jks)$`,
    String.raw`(^|[\\/])(secret|secrets|credential|credentials)([\\/]|\.|$)`,
    String.raw`(secret|credential|password|passwd|api[-_]?key|token|private[-_]?key)`,
  ].join('|'),
  'i',
);

function emptySummary() {
  return {
    files: 0,
    entries: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    stagedAdditions: 0,
    stagedDeletions: 0,
    unstagedAdditions: 0,
    unstagedDeletions: 0,
    untrackedFiles: 0,
    truncated: false,
  };
}

/**
 * Resolve a git-reported relative path inside the repository root. Absolute
 * paths, `..` escapes and any other path that resolves outside the root are
 * rejected before anything is read.
 */
function resolveInsideRepo(root, relPath) {
  const rootDir = resolve(root);
  if (typeof relPath !== 'string' || relPath.length === 0) return null;
  if (isAbsolute(relPath)) return null;
  const full = resolve(rootDir, ...relPath.split('/'));
  const inside = relative(rootDir, full);
  if (inside.length === 0 || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) return null;
  return full;
}

/**
 * Read a bounded excerpt of an untracked text file. Only regular files inside
 * the repository root are read: a path that escapes the root, or a symlink (or
 * a path swapped to one after the status read) is ignored instead of followed.
 */
async function readExcerpt(root, relPath) {
  const full = resolveInsideRepo(root, relPath);
  if (full === null) return undefined;
  try {
    const info = await lstat(full);
    if (!info.isFile() || info.size > EXCERPT_BYTES * 8) return undefined;
    const text = await readFile(full, 'utf8');
    if (text.includes('\u0000')) return undefined;
    return text.slice(0, EXCERPT_BYTES);
  } catch {
    return undefined;
  }
}

/**
 * Bounded project hints for the classifier: the directory names beside the
 * changed paths, not the repository content.
 */
async function projectHints(root) {
  const hints = { name: basename(root), topLevel: [], manifests: [] };
  try {
    const children = await readdir(root, { withFileTypes: true });
    hints.topLevel = children
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .slice(0, 40)
      .map((entry) => entry.name);
    hints.manifests = children
      .filter((entry) => entry.isFile() && /^(package\.json|pnpm-workspace\.yaml|go\.mod|Cargo\.toml|pyproject\.toml|pom\.xml|build\.gradle|composer\.json|Makefile|CMakeLists\.txt)$/.test(entry.name))
      .slice(0, 12)
      .map((entry) => entry.name);
  } catch {
    /* hints are optional */
  }
  return hints;
}

/** Build the classifier input: stable ids plus optional bounded excerpts for new files. */
async function classifierEntries(root, entries) {
  const selected = entries.slice(0, MAX_CLASSIFY_ENTRIES);
  const result = [];
  let excerpts = 0;
  for (const entry of selected) {
    const row = {
      id: entry.key,
      status: entry.status,
      change: entry.change,
      path: entry.path,
      oldPath: entry.oldPath,
      additions: entry.additions,
      deletions: entry.deletions,
    };
    // Excerpts are only ever read for entries the Host itself classified as a
    // newly added text file; the path check inside readExcerpt keeps the read
    // inside the repository root and refuses symlinks.
    if (entry.status === 'untracked' && entry.kind === 'text' && excerpts < EXCERPT_LIMIT && !SENSITIVE_PATH.test(entry.path)) {
      const text = await readExcerpt(root, entry.path);
      if (text !== undefined) {
        excerpts += 1;
        const lines = text.split('\n').slice(0, 24).join('\n');
        row.excerpt = `<<<FILE ${entry.path}\n${lines}\n>>>`;
      }
    }
    result.push(row);
  }
  return { entries: result, omitted: Math.max(0, entries.length - selected.length) };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function createHostPlugin(ctx) {
  const logger = {
    warn(error) {
      try {
        ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)));
      } catch {
        /* logging must never fail a request */
      }
    },
  };

  const settings = createSettingsStore({ logger });
  const git = createGit(createNodeExecutor({ logger }));
  const classifier = createClassifier(ctx);
  const modelCatalog = createModelCatalog({ ctx, classifier, settings });

  let gitVersionPromise;
  function gitVersion() {
    gitVersionPromise ??= git.gitVersion().catch(() => null);
    return gitVersionPromise;
  }

  // ---- This plugin's own write serialisation ---------------------------------
  // One chain for the whole plugin: the panel can only issue one mutation at a
  // time, so a stage and a commit cannot interleave. External tools are NOT
  // blocked by this chain; every mutation therefore re-validates state first.
  let writeChain = Promise.resolve();
  function serialise(operation) {
    const run = writeChain.then(operation, operation);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---- Repository resolution -------------------------------------------------
  function cwdForSession(sessionId) {
    if (typeof sessionId !== 'string') return undefined;
    try {
      const session = ctx.get('sessions')?.get?.(sessionId);
      const cwd = session?.header?.cwd;
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
    } catch {
      return undefined;
    }
  }

  function resolveCwd(params) {
    const fromSession = cwdForSession(params?.sessionId);
    if (fromSession !== undefined) return fromSession;
    if (typeof params?.cwd === 'string' && params.cwd.length > 0) return params.cwd;
    const workingDirectory = ctx.get('workingDirectory');
    if (typeof workingDirectory?.defaultDirectory === 'string' && workingDirectory.defaultDirectory.length > 0) {
      return workingDirectory.defaultDirectory;
    }
    return process.cwd();
  }

  async function openRepo(params) {
    const cwd = resolveCwd(params);
    try {
      const repo = await git.resolveRepo(cwd);
      return { cwd, repo };
    } catch (error) {
      if (error instanceof GitError && error.code === 'repo/no-git') {
        return { cwd, repo: null, error: { code: 'repo/no-git', message: error.message } };
      }
      if (error instanceof GitError && error.code === 'repo/git-unavailable') {
        return { cwd, repo: null, error: { code: 'repo/git-unavailable', message: error.message } };
      }
      if (error instanceof GitError && error.code === 'repo/not-found') {
        return { cwd, repo: null, error: { code: 'repo/not-found', message: error.message } };
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(new Error(`[code-review] repository resolution failed: ${message}`));
      return { cwd, repo: null, error: { code: 'repo/error', message } };
    }
  }

  async function contextFor(params) {
    const opened = await openRepo(params);
    if (opened.repo === null) {
      return {
        ...opened,
        status: {
          repo: null,
          cwd: opened.cwd,
          state: opened.error.code === 'repo/no-git' ? 'no-git' : 'error',
          error: opened.error,
          gitVersion: await gitVersion(),
          entries: [],
          summary: emptySummary(),
          generatedAt: Date.now(),
        },
      };
    }
    const status = await git.status(opened.repo);
    return { ...opened, status: { ...status, gitVersion: await gitVersion() } };
  }

  async function requireStatusEntry(status, key) {
    const entry = status.entries.find((candidate) => candidate.key === key);
    if (entry === undefined) throw new ProtocolError('entry/not-found', 'entry is no longer in the current change set; refresh and retry', { key });
    return entry;
  }

  function requireWritableRepo(opened) {
    if (opened.repo === null) throw new ProtocolError('repo/no-git', 'the current directory is not a git repository');
    return opened.repo;
  }

  // ---- Classification cache --------------------------------------------------
  /** @type {Map<string, { signature: string, result: object }>} */
  const classifyCache = new Map();
  const classifyControllers = new Map();
  /** In-flight commit-message drafts, cancellable per request id (read-only op). */
  const messageControllers = new Map();

  function classifySignature(repo, entries, model, reasoningEffort, grouping, customInstructions) {
    const hash = createHash('sha256');
    hash.update(repo.root);
    hash.update('\u0000');
    hash.update(model ?? '');
    hash.update('\u0000');
    hash.update(reasoningEffort ?? '');
    hash.update('\u0000');
    // The grouping mode selects a different prompt, so a warm role-mode result
    // must never be served for a logic-mode request (and vice versa); the mode's
    // extra instructions are part of that prompt and belong in the signature too.
    hash.update(grouping ?? 'role');
    hash.update('\u0000');
    hash.update(customInstructions ?? '');
    hash.update('\u0000');
    for (const entry of entries) {
      const fingerprint = entry.fingerprint !== null && typeof entry.fingerprint === 'object' ? entry.fingerprint : {};
      const gitlink = fingerprint.gitlink !== null && typeof fingerprint.gitlink === 'object' ? fingerprint.gitlink : {};
      hash.update([
        entry.key,
        entry.change,
        fingerprint.base ?? '',
        fingerprint.target ?? '',
        fingerprint.mode ?? '',
        gitlink.oldSha ?? '',
        gitlink.newSha ?? '',
      ].join('\u0000'));
      hash.update('\u0000');
    }
    return hash.digest('hex');
  }

  /**
   * Select the entries for one classification from a fresh Host status payload.
   * When the client sends `{ key }` entries, only those keys are used and every
   * key must still exist (otherwise entry/not-found). Everything the model later
   * sees — status, change, path, kind, excerpt eligibility — is Host-derived;
   * anything else the client may attach is ignored.
   */
  function selectClassificationEntries(status, keys, current) {
    // The user-facing "最多归类条目数" setting bounds one classification request;
    // the protocol cap below it is a hard safety limit for the prompt size.
    const configuredMax = Number.isFinite(current.maxCandidates) ? current.maxCandidates : MAX_CLASSIFY_ENTRIES;
    const maxEntries = Math.max(1, Math.min(MAX_CLASSIFY_ENTRIES, Math.trunc(configuredMax)));
    let candidates = Array.isArray(status.entries) ? status.entries : [];
    if (keys !== undefined) {
      const wanted = new Set(keys);
      const present = new Set(candidates.map((entry) => entry.key));
      for (const key of wanted) {
        if (!present.has(key)) throw new ProtocolError('entry/not-found', 'entry is no longer in the current change set', { key });
      }
      candidates = candidates.filter((entry) => wanted.has(entry.key));
    }
    const selected = candidates.slice(0, maxEntries);
    return { entries: selected, limitedOut: candidates.length - selected.length };
  }

  /**
   * Run (or reuse) one classification for an already-resolved repository and
   * prepared entries. The cache is keyed by repo + effective model + grouping
   * mode + that mode's instructions + entry fingerprints, so a warm cache
   * returns without another model call while switching modes or editing the
   * instructions always gets a fresh result.
   */
  async function runClassification({ repo, entries, limitedOut, sessionId, requestId, force, grouping, current, controller }) {
    // Explicit plugin choice → the model the requesting session runs on →
    // the DSH default model. Resolving the session route here keeps "use the
    // model of this conversation" true without another plugin-side setting.
    const requestedRoute = modelCatalog.classifyRouteFromSettings(current);
    const route = requestedRoute
      ?? classifier.sessionRoute(sessionId)
      ?? classifier.defaultRoute();
    const effectiveRoute = route === null || route === undefined ? null : route;
    const model = effectiveRoute === null ? undefined : `${effectiveRoute.provider}/${effectiveRoute.model}`;
    const reasoningEffort = typeof current.reasoningEffort === 'string' && current.reasoningEffort.length > 0
      ? current.reasoningEffort
      : undefined;
    const mode = grouping === 'logic' ? 'logic' : 'role';
    // Each mode carries its own extra instructions: the two prompts ask for
    // different grouping principles, so a logic-specific rule must never leak
    // into role mode (or vice versa).
    const instructionsKey = mode === 'logic' ? 'customInstructionsLogic' : 'customInstructionsRole';
    const instructions = typeof current[instructionsKey] === 'string' ? current[instructionsKey] : '';
    const signature = classifySignature(repo, entries, model, reasoningEffort, mode, instructions);
    const cached = classifyCache.get(repo.root);
    if (force !== true && cached !== undefined && cached.signature === signature) {
      return { ...cached.result, cached: true };
    }
    const prepared = await classifierEntries(repo.root, entries);
    const result = await classifier.classify({
      entries: prepared.entries,
      project: await projectHints(repo.root),
      signal: controller.signal,
      route: effectiveRoute === null ? undefined : effectiveRoute,
      customInstructions: instructions,
      reasoningEffort,
      grouping: mode,
    });
    const value = {
      requestId,
      grouping: mode,
      categories: result.categories,
      source: 'ai',
      model: result.model,
      cached: false,
      dropped: result.dropped.length,
      unassigned: result.unassigned,
      omitted: prepared.omitted + limitedOut,
      repo,
    };
    classifyCache.set(repo.root, { signature, result: value });
    while (classifyCache.size > CLASSIFY_CACHE_LIMIT) {
      const oldest = classifyCache.keys().next().value;
      if (oldest === undefined) break;
      classifyCache.delete(oldest);
    }
    return value;
  }

  async function classify(params) {
    const current = await settings.read();
    if (current.aiClassify !== true) throw new ProtocolError('ai/disabled', 'AI classification is disabled in settings');
    // An explicit per-request mode wins over the persisted plugin setting; the
    // reader rejects unknown values so a stale client cannot pick a third mode.
    const grouping = readGrouping(params) ?? (current.aiGrouping === 'logic' ? 'logic' : 'role');
    const opened = await openRepo(params);
    const repo = requireWritableRepo(opened);
    const keys = readClassifyKeys(params);
    // The classification input is rebuilt from a fresh Host status read. The wire
    // only contributes entry keys, never metadata, paths or excerpt candidates.
    const status = await git.status(repo);
    const selected = selectClassificationEntries(status, keys, current);
    if (selected.entries.length === 0) throw new ProtocolError('ai/invalid', 'no changed entries to classify');
    const requestId = typeof params.requestId === 'string' ? params.requestId : 'classify';
    const controller = new AbortController();
    classifyControllers.get(requestId)?.abort();
    classifyControllers.set(requestId, controller);
    const timeout = setTimeout(() => controller.abort(new Error('classify timeout')), CLASSIFY_TIMEOUT_MS);
    timeout.unref?.();
    try {
      return await runClassification({
        repo,
        entries: selected.entries,
        limitedOut: selected.limitedOut,
        sessionId: params.sessionId,
        requestId,
        force: params.force === true,
        grouping,
        current,
        controller,
      });
    } finally {
      clearTimeout(timeout);
      if (classifyControllers.get(requestId) === controller) classifyControllers.delete(requestId);
    }
  }

  // ---- Optional idle pre-classification --------------------------------------
  // When the user opts in, one classification is started shortly after a
  // conversation turn finishes, so opening the review panel finds a warm cache
  // instead of waiting for the model. It only runs for sessions whose panel was
  // opened at least once in this host process, only when AI grouping is enabled,
  // and it is cancelled as soon as the session starts running again. A warm
  // cache signature short-circuits the whole path, so unchanged changes cost
  // nothing.
  const PRECLASSIFY_DEBOUNCE_MS = 2_000;
  /** @type {Set<string>} session ids whose panel has been used in this process. */
  const seenSessions = new Set();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const preclassifyTimers = new Map();
  /** @type {Set<string>} sessions with a pre-classification request in flight. */
  const preclassifyInFlight = new Set();

  function rememberSession(params) {
    if (typeof params?.sessionId === 'string' && params.sessionId.length > 0) seenSessions.add(params.sessionId);
  }

  function cancelPreclassify(sessionId) {
    const timer = preclassifyTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    preclassifyTimers.delete(sessionId);
  }

  function disposePreclassify() {
    for (const timer of preclassifyTimers.values()) clearTimeout(timer);
    preclassifyTimers.clear();
  }

  /**
   * One idle pre-classification pass. This runs from an unawaited timer
   * callback, so the *whole* chain — settings read, repository resolution,
   * status read, model call — must be caught here; a rejected promise escaping
   * this function would surface as an unhandled rejection in the DSH host.
   */
  async function preclassifySession(sessionId) {
    try {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return { skipped: 'no-session' };
      const current = await settings.read();
      if (current.preclassify !== true || current.aiClassify !== true) return { skipped: 'disabled' };
      if (!seenSessions.has(sessionId)) return { skipped: 'unseen-session' };
      if (preclassifyInFlight.has(sessionId)) return { skipped: 'in-flight' };
      preclassifyInFlight.add(sessionId);
      try {
        const opened = await openRepo({ sessionId });
        const repo = opened.repo;
        if (repo === null) return { skipped: 'no-repo' };
        const status = await git.status(repo);
        const selected = selectClassificationEntries(status, undefined, current);
        if (selected.entries.length === 0) return { skipped: 'clean' };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error('preclassify timeout')), CLASSIFY_TIMEOUT_MS);
        timeout.unref?.();
        try {
          const value = await runClassification({
            repo,
            entries: selected.entries,
            limitedOut: selected.limitedOut,
            sessionId,
            requestId: `preclassify:${sessionId}`,
            force: false,
            // Pre-classification always uses the persisted mode: it runs without
            // a request, so there is no per-request override to apply.
            grouping: current.aiGrouping === 'logic' ? 'logic' : 'role',
            current,
            controller,
          });
          return { ok: true, cached: value.cached === true, entries: selected.entries.length };
        } catch (error) {
          logger.warn(error instanceof Error ? error : new Error(`[code-review] idle pre-classification failed: ${String(error)}`));
          return { ok: false };
        } finally {
          clearTimeout(timeout);
        }
      } finally {
        preclassifyInFlight.delete(sessionId);
      }
    } catch (error) {
      // Covers settings.read/openRepo/git.status failures. The detail is logged,
      // never rethrown into the host event loop.
      logger.warn(error instanceof Error ? error : new Error(`[code-review] idle pre-classification failed: ${String(error)}`));
      return { ok: false };
    }
  }

  function schedulePreclassify(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    cancelPreclassify(sessionId);
    const timer = setTimeout(() => {
      preclassifyTimers.delete(sessionId);
      preclassifySession(sessionId).catch((error) => {
        logger.warn(error instanceof Error ? error : new Error(`[code-review] idle pre-classification failed: ${String(error)}`));
      });
    }, PRECLASSIFY_DEBOUNCE_MS);
    timer.unref?.();
    preclassifyTimers.set(sessionId, timer);
  }

  // ---- Method table ----------------------------------------------------------
  const methods = {
    async status(params) {
      const context = await contextFor(params);
      return context.status;
    },

    /* Turn the session's workspace into a repository without touching its
     * files: git init writes only `.git/`. It is a write, so it rides the
     * shared chain, and it re-resolves first: if another window initialised the
     * directory in the meantime, that repository is returned instead of being
     * re-initialised. */
    async repoInit(params) {
      return serialise(async () => {
        const opened = await openRepo(params);
        if (opened.repo === null && opened.error.code !== 'repo/no-git') {
          throw new ProtocolError(opened.error.code, opened.error.message);
        }
        const created = opened.repo === null;
        const repo = created ? await git.init(opened.cwd) : opened.repo;
        const status = await contextFor(params);
        return { repo: status.status.repo ?? repo, created, status: status.status };
      });
    },

    async diff(params) {
      const context = await contextFor(params);
      const repo = requireWritableRepo(context);
      const key = readKey(params);
      await requireStatusEntry(context.status, key);
      const entryDiff = await git.diff(repo, key, { status: context.status });
      return { ...entryDiff, repo };
    },

    async stage(params) {
      return serialise(async () => {
        const context = await contextFor(params);
        const repo = requireWritableRepo(context);
        const keys = readKeyList(params);
        const includeUntracked = params?.includeUntracked !== false;
        const expected = readExpectedMap(params);
        const result = await git.stage(repo, { keys, includeUntracked, expected, status: context.status });
        const status = await contextFor(params);
        return { repo, ok: true, affected: result.affected, skipped: result.skipped, status: status.status };
      });
    },

    async unstage(params) {
      return serialise(async () => {
        const context = await contextFor(params);
        const repo = requireWritableRepo(context);
        const keys = readKeyList(params);
        const expected = readExpectedMap(params);
        const result = await git.unstage(repo, { keys, expected, status: context.status });
        const status = await contextFor(params);
        return { repo, ok: true, affected: result.affected, status: status.status };
      });
    },

    async discard(params) {
      return serialise(async () => {
        const context = await contextFor(params);
        const repo = requireWritableRepo(context);
        const key = readKey(params);
        await requireStatusEntry(context.status, key);
        const result = await git.discard(repo, { key, expected: readFingerprint(params), status: context.status });
        const status = await contextFor(params);
        return { repo, ok: true, affected: result.affected, status: status.status };
      });
    },

    async stageHunk(params) {
      return serialise(() => hunkOperation(params, 'stage'));
    },

    async unstageHunk(params) {
      return serialise(() => hunkOperation(params, 'unstage'));
    },

    async discardHunk(params) {
      return serialise(() => hunkOperation(params, 'discard'));
    },

    async commit(params) {
      return serialise(async () => {
        const context = await contextFor(params);
        const repo = requireWritableRepo(context);
        const message = typeof params?.message === 'string' ? params.message : '';
        const expected = params?.expected;
        if (expected === null || typeof expected !== 'object') {
          throw new ProtocolError('commit/stale', 'missing commit expectation; refresh and retry');
        }
        const result = await git.commit(repo, {
          message,
          expected: { headSha: expected.headSha ?? null, stagedFingerprint: String(expected.stagedFingerprint ?? '') },
          status: context.status,
        });
        const status = await contextFor(params);
        return { ...result, repo, status: status.status };
      });
    },

    async pushPreview(params) {
      const context = await contextFor(params);
      const repo = requireWritableRepo(context);
      return git.pushPreview(repo, {
        remote: readRemoteName(params),
        targetBranch: readBranchName(params),
        status: context.status,
      });
    },

    async push(params) {
      return serialise(async () => {
        const context = await contextFor(params);
        const repo = requireWritableRepo(context);
        const result = await git.push(repo, {
          remote: readRemoteName(params),
          targetBranch: readBranchName(params),
          setUpstream: params?.setUpstream === true,
          status: context.status,
        });
        const status = await contextFor(params);
        return { ...result, repo, status: status.status };
      });
    },

    /* Configure a remote address. This is a local Git config write, so it rides
     * the same write chain as index/commit writes; it never contacts the remote.
     * An existing name is updated in place (git remote set-url). */
    async remoteSet(params) {
      return serialise(async () => {
        const context = await contextFor(params);
        requireWritableRepo(context);
        const { name, url } = readRemoteConfig(params);
        const result = await git.setRemote(context.repo, { name, url });
        const status = await contextFor(params);
        return {
          repo: status.status.repo ?? context.repo,
          ok: true,
          name: result.name,
          url: result.url,
          created: result.created,
          status: status.status,
        };
      });
    },

    async classify(params) {
      return classify(params);
    },

    async classifyCancel(params) {
      const requestId = typeof params?.requestId === 'string' ? params.requestId : '';
      const controller = classifyControllers.get(requestId);
      if (controller === undefined) return { cancelled: false };
      controller.abort(new Error('cancelled by user'));
      classifyControllers.delete(requestId);
      return { cancelled: true };
    },

    /* Draft one commit message for the current staged change set. Read-only:
     * the staged patch and a bounded slice of recent commit messages are the
     * model input, and the reply is plain text returned to the editable field —
     * nothing here writes Git state. The effective model is the same one AI
     * grouping uses (explicit plugin choice → session model → DSH default). */
    async commitMessage(params) {
      const context = await contextFor(params);
      const repo = requireWritableRepo(context);
      const staged = (Array.isArray(context.status.entries) ? context.status.entries : [])
        .filter((entry) => entry.status === 'staged');
      if (staged.length === 0) throw new ProtocolError('message/no-staged', 'nothing is staged to describe');
      const requestId = typeof params?.requestId === 'string' && params.requestId.length > 0 ? params.requestId : 'commit-message';
      const controller = new AbortController();
      messageControllers.get(requestId)?.abort();
      messageControllers.set(requestId, controller);
      const timeout = setTimeout(() => controller.abort(new Error('commit message timeout')), COMMIT_MESSAGE_TIMEOUT_MS);
      timeout.unref?.();
      try {
        const current = await settings.read();
        const requestedRoute = modelCatalog.classifyRouteFromSettings(current);
        const route = requestedRoute
          ?? classifier.sessionRoute(params?.sessionId)
          ?? classifier.defaultRoute();
        const [patch, history] = await Promise.all([
          git.stagedPatch(repo, { maxChars: MAX_COMMIT_MESSAGE_DIFF_CHARS }),
          git.commitHistory(repo),
        ]);
        const result = await classifier.writeCommitMessage({
          project: await projectHints(repo.root),
          entries: staged.map((entry) => ({
            path: entry.path,
            oldPath: entry.oldPath,
            change: entry.change,
            additions: entry.additions,
            deletions: entry.deletions,
          })),
          patch: patch.text,
          patchTruncated: patch.truncated,
          history: history.commits,
          signal: controller.signal,
          route: route ?? undefined,
          reasoningEffort: typeof current.reasoningEffort === 'string' && current.reasoningEffort.length > 0
            ? current.reasoningEffort
            : undefined,
        });
        return {
          requestId,
          message: result.message,
          model: result.model,
          history: history.commits.length,
          repo,
        };
      } finally {
        clearTimeout(timeout);
        if (messageControllers.get(requestId) === controller) messageControllers.delete(requestId);
      }
    },

    async commitMessageCancel(params) {
      const requestId = typeof params?.requestId === 'string' ? params.requestId : '';
      const controller = messageControllers.get(requestId);
      if (controller === undefined) return { cancelled: false };
      controller.abort(new Error('cancelled by user'));
      messageControllers.delete(requestId);
      return { cancelled: true };
    },

    async models(params) {
      return modelCatalog.listModels(params?.sessionId);
    },

    async settingsGet(params) {
      const value = await settings.read();
      return modelCatalog.withModelRoute(value, params?.sessionId);
    },

    async settingsSet(params) {
      const patch = params?.patch;
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new ProtocolError('settings/invalid', 'patch must be an object');
      }
      if ('aiClassify' in patch && typeof patch.aiClassify !== 'boolean') {
        throw new ProtocolError('settings/invalid', 'aiClassify must be a boolean');
      }
      if ('preclassify' in patch && typeof patch.preclassify !== 'boolean') {
        throw new ProtocolError('settings/invalid', 'preclassify must be a boolean');
      }
      // The grouping mode drives which prompt is used; only the two documented
      // modes are persisted (the default is 'role').
      if ('aiGrouping' in patch && patch.aiGrouping !== 'role' && patch.aiGrouping !== 'logic') {
        throw new ProtocolError('settings/invalid', 'aiGrouping must be "role" or "logic"');
      }
      // The commit drawer's split control persists its action mode; only the two
      // documented values are accepted (the default is 'commit'). The one-click
      // AI·commit+push action lives in the toolbar and is not a mode.
      if ('commitMode' in patch && patch.commitMode !== 'commit' && patch.commitMode !== 'commitPush') {
        throw new ProtocolError('settings/invalid', 'commitMode must be "commit" or "commitPush"');
      }
      if ('maxCandidates' in patch && !Number.isFinite(patch.maxCandidates)) {
        throw new ProtocolError('settings/invalid', 'maxCandidates must be a number');
      }
      if ('locale' in patch && patch.locale !== null && patch.locale !== 'zh' && patch.locale !== 'en') {
        throw new ProtocolError('settings/invalid', 'locale must be zh, en or null');
      }
      // Each mode's instructions are validated independently; the legacy shared
      // field stays accepted so an older client bundle can still save them.
      for (const field of ['customInstructionsRole', 'customInstructionsLogic', 'customInstructions']) {
        if (!(field in patch) || patch[field] === null) continue;
        if (typeof patch[field] !== 'string' || patch[field].length > 4000) {
          throw new ProtocolError('settings/invalid', `${field} must be a string of at most 4000 characters or null`);
        }
      }
      if ('reasoningEffort' in patch && patch.reasoningEffort !== null) {
        if (typeof patch.reasoningEffort !== 'string' || patch.reasoningEffort.length === 0 || patch.reasoningEffort.length > 64) {
          throw new ProtocolError('settings/invalid', 'reasoningEffort must be a string of at most 64 characters or null');
        }
      }
      for (const field of ['provider', 'model']) {
        if (!(field in patch)) continue;
        const value = patch[field];
        if (value !== null && (typeof value !== 'string' || value.length === 0)) {
          throw new ProtocolError('settings/invalid', `${field} must be a string or null`);
        }
      }
      // A half-set route is not selectable and would be silently ignored by the
      // classifier, so reject it instead of persisting a confusing state.
      if ('provider' in patch || 'model' in patch) {
        const current = await settings.read();
        const nextProvider = 'provider' in patch ? patch.provider : current.provider;
        const nextModel = 'model' in patch ? patch.model : current.model;
        const hasProvider = typeof nextProvider === 'string' && nextProvider.length > 0;
        const hasModel = typeof nextModel === 'string' && nextModel.length > 0;
        if (hasProvider !== hasModel) {
          throw new ProtocolError('settings/invalid', 'provider and model must be set or cleared together');
        }
      }
      // An explicit reasoning level belongs to the exact model: switching the
      // model without naming a new level clears it so the new model's default
      // (or the classifier's "off" fallback) applies instead of a stale id.
      const effectivePatch = { ...patch };
      // The pre-split settings page sent one shared field; apply it to both
      // modes (its old behaviour). Explicit per-mode values win.
      if ('customInstructions' in patch) {
        if (!('customInstructionsRole' in patch)) effectivePatch.customInstructionsRole = patch.customInstructions;
        if (!('customInstructionsLogic' in patch)) effectivePatch.customInstructionsLogic = patch.customInstructions;
        delete effectivePatch.customInstructions;
      }
      if (('provider' in patch || 'model' in patch) && !('reasoningEffort' in patch)) {
        effectivePatch.reasoningEffort = null;
      }
      // Settings writes share the plugin's mutation chain: two panels saving at
      // once must not lose each other's patch through a read-modify-write race.
      const next = await serialise(() => settings.write(effectivePatch));
      // Turning classification off, or changing the model / prompt / limit /
      // grouping mode, invalidates cached results. Disabling AI grouping also
      // drops queued pre-classifications; disabling pre-classification only
      // drops the queue.
      if (patch.aiClassify === false || 'provider' in patch || 'model' in patch
        || 'customInstructions' in patch || 'customInstructionsRole' in patch || 'customInstructionsLogic' in patch
        || 'maxCandidates' in patch || 'reasoningEffort' in patch || 'aiGrouping' in patch) {
        classifyCache.clear();
      }
      if (patch.aiClassify === false || patch.preclassify === false) disposePreclassify();
      return modelCatalog.withModelRoute(next, params?.sessionId);
    },
  };

  async function hunkOperation(params, kind) {
    const context = await contextFor(params);
    const repo = requireWritableRepo(context);
    const key = readKey(params);
    const hunkIndex = params?.hunkIndex;
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0) {
      throw new ProtocolError('internal', 'invalid hunk index');
    }
    await requireStatusEntry(context.status, key);
    const expected = readFingerprint(params);
    const operation = kind === 'stage' ? git.stageHunk : kind === 'unstage' ? git.unstageHunk : git.discardHunk;
    const result = await operation.call(git, repo, { key, hunkIndex, expected, status: context.status });
    const status = await contextFor(params);
    return { repo, ok: true, affected: result.affected, status: status.status, kind };
  }

  /** One protocol call. Never throws: failures become `{ ok: false, error }`. */
  async function dispatch(method, params) {
    const handler = methods[method];
    if (typeof handler !== 'function') {
      /* A client bundle can be newer than a running Host half: give the panel a
       * stable code it can localize into "restart DSH" instead of "internal". */
      return protocolFailure('protocol/unknown-method', 'unknown plugin method');
    }
    // Remember sessions whose panel has been used: idle pre-classification only
    // ever runs for those, never for every session in the profile.
    rememberSession(params);
    try {
      return success(await handler(params ?? {}));
    } catch (error) {
      if (error instanceof ProtocolError) return protocolFailure(error.code, error.message, error.details);
      if (error instanceof AiError) return protocolFailure(error.code, error.message, error.details);
      if (error instanceof GitError) {
        return protocolFailure(error.code, error.message, error.details);
      }
      // Unexpected failures keep their details in the log only: the wire gets a
      // stable message so internals (paths, stack text) never leak to the panel.
      logger.warn(error instanceof Error ? error : new Error(`[code-review] ${String(error)}`));
      return protocolFailure('internal', 'Internal error');
    }
  }

  async function route(request) {
    if (request.method !== 'POST') return jsonResponse(405, { ok: false, error: { code: 'internal', message: 'only POST is supported' } });
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { ok: false, error: { code: 'internal', message: 'request body is not JSON' } });
    }
    const method = typeof body?.method === 'string' ? body.method : '';
    const params = body?.params !== null && typeof body?.params === 'object' ? body.params : {};
    return jsonResponse(200, await dispatch(method, params));
  }

  return {
    route,
    dispatch,
    methods,
    settings,
    git,
    preclassifySession,
    schedulePreclassify,
    cancelPreclassify,
    disposePreclassify,
  };
}

/**
 * Register the plugin with a DSH Cordis context.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const plugin = createHostPlugin(ctx);
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () =>
        connectionCtx.connection.fetch.register({
          path: ROUTE_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => plugin.route(request),
        }),
      'code-review: /api/code-review Fetch route',
    );
  });
  // Optional idle pre-classification: warm the classification cache when a
  // conversation finishes a turn, and drop the queued work as soon as it runs
  // again. Registered on the plugin context so the host disposes it on unload.
  ctx.effect(
    () => {
      const off = ctx.on('api-session/status', (sessionId, running) => {
        if (running === true) plugin.cancelPreclassify(sessionId);
        else plugin.schedulePreclassify(sessionId);
      });
      return () => {
        if (typeof off === 'function') off();
        plugin.disposePreclassify();
      };
    },
    'code-review: pre-classify on idle',
  );
  ctx.logger?.info?.('[code-review] host half loaded; route ' + ROUTE_PATH);
  return plugin;
}

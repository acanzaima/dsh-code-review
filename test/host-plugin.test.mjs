/**
 * Host-half integration tests: the plugin protocol (dispatch/route), settings
 * persistence, repository/session resolution, commit expectations and the AI
 * classification validation — all against throwaway repositories.
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCommitMessagePayload, parseClassification, parseCommitMessage } from '../src/host/ai.js';

const run = promisify(execFile);

let workspace;
let repoDir;
let home;
let plugin;
let llmReply = null;
let llmCalls = 0;
/** Payload of the most recent model request (asserts the Host data boundary). */
let llmRequest = null;
/** Optional fault injected into the fake llm stream: { mode: 'sync'|'async', error }. */
let llmThrow = null;
/** Optional finish reason override for the fake llm stream. */
let llmFinish = null;
/** Session id → the `{ provider, model }` route its request header reports. */
let sessionRoutes = {};
/** Session id → the host `modelSelection` projection state. */
let projectionStates = {};

function fakeCtx(sessionCwd) {
  const services = {
    sessions: {
      get(id) {
        const route = sessionRoutes[id];
        return {
          id,
          header: { cwd: sessionCwd, id },
          requestHeader() {
            return route === undefined ? undefined : { config: { provider: route.provider, model: route.model } };
          },
        };
      },
    },
    sessionProjections: {
      stateOf(session, key) {
        if (key !== 'modelSelection') return undefined;
        return projectionStates[session.id];
      },
    },
    llm: {
      stream(request) {
        llmCalls += 1;
        llmRequest = request;
        if (llmThrow !== null && llmThrow.mode === 'sync') throw llmThrow.error;
        return (async function* () {
          if (llmThrow !== null && llmThrow.mode === 'async') {
            yield { type: 'text-delta', text: 'partial' };
            throw llmThrow.error;
          }
          yield { type: 'text-delta', text: llmReply ?? '{}' };
          yield { type: 'finish', reason: { kind: llmFinish ?? 'stop' } };
        })();
      },
      async resolveModelInfo(provider, model) {
        return {
          provider,
          id: model,
          reasoning: { efforts: [{ id: 'off' }, { id: 'high' }], defaultEffort: 'high' },
        };
      },
      listProviders() {
        return [
          { id: 'fake', name: 'Fake Provider' },
          { id: 'other', name: 'Other Provider' },
        ];
      },
      async listModels(provider) {
        if (provider === 'fake') {
          return [
            { id: 'fake-model', name: 'Fake Model' },
            { id: 'fake-model-pro', name: 'Fake Model Pro' },
          ];
        }
        return [];
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'fake', model: 'fake-model' };
      },
    },
  };
  return {
    logger: { info() {}, warn() {} },
    get(name) {
      return services[name];
    },
    inject() {
      return () => {};
    },
  };
}

async function git(args, cwd = repoDir) {
  return run('git', args, { cwd, windowsHide: true });
}

/** Expected-fingerprint map for the listed keys, from a fresh status payload. */
function expectedFor(status, keys) {
  const wanted = new Set(keys);
  const expected = {};
  for (const entry of status.entries) if (wanted.has(entry.key)) expected[entry.key] = entry.fingerprint;
  return expected;
}

/** Expected map for a whole-repository stage call. */
function expectedStageAll(status, includeUntracked = true) {
  const expected = {};
  for (const entry of status.entries) {
    if (entry.status === 'unstaged' || (includeUntracked && entry.status === 'untracked')) {
      expected[entry.key] = entry.fingerprint;
    }
  }
  return expected;
}

/** Expected map for a whole-repository unstage call. */
function expectedUnstageAll(status) {
  const expected = {};
  for (const entry of status.entries) if (entry.status === 'staged') expected[entry.key] = entry.fingerprint;
  return expected;
}

/** The JSON payload handed to the model by the most recent classification call. */
function lastPrompt() {
  assert.ok(llmRequest, 'no model request was made');
  const message = llmRequest.messages[0];
  return JSON.parse(message.content[0].text);
}

async function currentStatus() {
  const result = await plugin.dispatch('status', { cwd: repoDir });
  assert.equal(result.ok, true);
  return result.value;
}

async function seedRepository() {
  await mkdir(repoDir, { recursive: true });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test User']);
  await git(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(repoDir, 'app.js'), 'const value = 1;\nconsole.log(value);\n', 'utf8');
  await writeFile(join(repoDir, 'README.md'), '# demo\n', 'utf8');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'initial']);
  // one staged change, one unstaged change on another file, one untracked
  await writeFile(join(repoDir, 'app.js'), 'const value = 2;\nconsole.log(value);\n', 'utf8');
  await git(['add', 'app.js']);
  await writeFile(join(repoDir, 'README.md'), '# demo\n\nmore docs\n', 'utf8');
  await writeFile(join(repoDir, 'new file.txt'), 'hello\n', 'utf8');
}

before(async () => {
  // tmpdir() can return a Windows 8.3 short path (e.g. C:\Users\RUNNER~1 on CI
  // runners) while git reports the canonical long path, so pin one form.
  workspace = realpathSync.native(await mkdtemp(join(tmpdir(), 'code-review-host-')));
  repoDir = join(workspace, 'repo');
  home = join(workspace, 'home');
  await mkdir(home, { recursive: true });
  process.env.DSH_HOME = home;
  await seedRepository();
  const { createHostPlugin } = await import('../src/host/index.js');
  plugin = createHostPlugin(fakeCtx(repoDir));
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('protocol', () => {
  test('status reports the repository, groups and scoped summary', async () => {
    const result = await plugin.dispatch('status', { cwd: repoDir });
    assert.equal(result.ok, true);
    const status = result.value;
    assert.equal(status.state, 'ok');
    assert.equal(resolve(status.repo.root), resolve(repoDir));
    assert.equal(status.repo.branch, 'main');
    assert.ok(status.repo.headSha);
    const keys = status.entries.map((entry) => entry.key);
    assert.ok(keys.includes('staged:app.js'), `missing staged entry: ${keys.join(',')}`);
    assert.ok(keys.includes('unstaged:README.md'));
    assert.ok(keys.some((key) => key.startsWith('untracked:new file.txt')));
    assert.equal(status.summary.staged, 1);
    assert.equal(status.summary.unstaged, 1);
    assert.equal(status.summary.untracked, 1);
    assert.equal(status.summary.files, 3);
    assert.ok(status.summary.stagedAdditions >= 1);
    assert.ok(status.summary.unstagedAdditions >= 1);
    assert.equal(status.summary.untrackedFiles, 1);
    assert.equal(typeof status.stagedFingerprint, 'string');
    assert.ok(status.stagedFingerprint.length > 0);
  });

  test('session id resolves the same repository', async () => {
    const result = await plugin.dispatch('status', { sessionId: 'session-1' });
    assert.equal(result.ok, true);
    assert.equal(resolve(result.value.repo.root), resolve(repoDir));
  });

  test('repoInit initialises a plain workspace without touching its files', async () => {
    const plain = join(workspace, 'plain');
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, 'notes.txt'), 'keep me\n', 'utf8');
    const before = await plugin.dispatch('status', { cwd: plain });
    assert.equal(before.ok, true);
    assert.equal(before.value.state, 'no-git');

    const created = await plugin.dispatch('repoInit', { cwd: plain });
    assert.equal(created.ok, true);
    assert.equal(created.value.created, true);
    assert.equal(created.value.status.state, 'ok');
    assert.equal(resolve(created.value.repo.root), resolve(plain));
    assert.ok(created.value.status.entries.some((entry) => entry.path === 'notes.txt'),
      'the untouched file shows up as an untracked entry');
    assert.equal(await readFile(join(plain, 'notes.txt'), 'utf8'), 'keep me\n');
    assert.deepEqual((await readdir(plain)).sort(), ['.git', 'notes.txt'], 'only .git is created');

    // Idempotent: an existing repository is returned, never re-initialised.
    const again = await plugin.dispatch('repoInit', { cwd: plain });
    assert.equal(again.ok, true);
    assert.equal(again.value.created, false);

    const missing = await plugin.dispatch('repoInit', { cwd: join(workspace, 'no-such-dir') });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'repo/not-found');
  });

  test('diff returns both full sides and hunks', async () => {
    const result = await plugin.dispatch('diff', { cwd: repoDir, key: 'unstaged:README.md' });
    assert.equal(result.ok, true);
    const value = result.value;
    assert.equal(value.entry.key, 'unstaged:README.md');
    assert.equal(value.comparison.baseLabel.length > 0, true);
    assert.equal(value.base.exists, true);
    assert.match(value.base.text, /# demo/);
    assert.match(value.target.text, /more docs/);
    assert.equal(Array.isArray(value.hunks), true);
  });

  test('unknown keys are rejected without touching the repository', async () => {
    const before = await readFile(join(repoDir, 'README.md'), 'utf8');
    const result = await plugin.dispatch('diff', { cwd: repoDir, key: 'staged:does-not-exist.js' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'entry/not-found');
    assert.equal(await readFile(join(repoDir, 'README.md'), 'utf8'), before);
  });

  test('route speaks the JSON envelope and answers only POST', async () => {
    const response = await plugin.route(
      new Request('http://localhost/api/code-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'status', params: { cwd: repoDir } }),
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.value.state, 'ok');

    const get = await plugin.route(new Request('http://localhost/api/code-review', { method: 'GET' }));
    assert.equal(get.status, 405);
  });

  test('known errors carry a stable English message, no raw exception text', async () => {
    const notFound = await plugin.dispatch('diff', { cwd: repoDir, key: 'staged:does-not-exist.js' });
    assert.equal(notFound.ok, false);
    assert.equal(notFound.error.code, 'entry/not-found');
    assert.doesNotMatch(notFound.error.message, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(notFound.error.message, /[\\/]/);

    const unknown = await plugin.dispatch('no-such-method', {});
    assert.equal(unknown.ok, false);
    // A client bundle can be newer than the running Host half: the stable code
    // tells the panel to ask for a DSH restart instead of showing "internal".
    assert.equal(unknown.error.code, 'protocol/unknown-method');
    assert.equal(unknown.error.message, 'unknown plugin method');
  });

  test('an unexpected exception never leaks its message or paths over the wire', async () => {
    const original = plugin.git.status;
    plugin.git.status = async () => {
      throw new Error('C:\\Users\\secret\\internal\\exploded here');
    };
    try {
      const result = await plugin.dispatch('status', { cwd: repoDir });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'internal');
      assert.equal(result.error.message, 'Internal error');
      assert.equal(JSON.stringify(result).includes('secret'), false);
    } finally {
      plugin.git.status = original;
    }
  });
});

describe('staging', () => {
  test('file-level stage moves only the requested file into the index', async () => {
    const status = await currentStatus();
    const result = await plugin.dispatch('stage', {
      cwd: repoDir,
      keys: ['unstaged:README.md'],
      expected: expectedFor(status, ['unstaged:README.md']),
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.ok, true);
    assert.ok(Array.isArray(result.value.affected), 'affected must be a plain path array');
    assert.ok(result.value.affected.every((path) => typeof path === 'string'));
    assert.ok(result.value.affected.includes('README.md'), JSON.stringify(result.value.affected));
    assert.ok(result.value.status.entries.some((entry) => entry.key === 'staged:README.md'));
    const cached = await git(['diff', '--cached', '--name-only']);
    assert.match(cached.stdout, /README\.md/);
  });

  test('file-level unstage keeps the working tree content', async () => {
    const before = await readFile(join(repoDir, 'README.md'), 'utf8');
    const status = await currentStatus();
    const result = await plugin.dispatch('unstage', {
      cwd: repoDir,
      keys: ['staged:README.md'],
      expected: expectedFor(status, ['staged:README.md']),
    });
    assert.equal(result.ok, true);
    assert.equal(await readFile(join(repoDir, 'README.md'), 'utf8'), before);
    const cached = await git(['diff', '--cached', '--name-only']);
    assert.doesNotMatch(cached.stdout, /README\.md/);
  });

  test('stale fingerprints abort a discard and change nothing', async () => {
    const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
    const entry = status.entries.find((candidate) => candidate.key === 'unstaged:README.md');
    assert.ok(entry);
    const before = await readFile(join(repoDir, 'README.md'), 'utf8');
    const result = await plugin.dispatch('discard', {
      cwd: repoDir,
      key: entry.key,
      expected: { base: 'not-the-real-base', target: 'not-the-real-target' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'entry/stale');
    assert.equal(await readFile(join(repoDir, 'README.md'), 'utf8'), before);
  });

  test('discard of an untracked entry is refused', async () => {
    const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
    const entry = status.entries.find((candidate) => candidate.status === 'untracked');
    const result = await plugin.dispatch('discard', {
      cwd: repoDir,
      key: entry.key,
      expected: entry.fingerprint,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'entry/unsupported');
  });

  test('stage all also stages untracked files but never hides conflicts', async () => {
    const status = await currentStatus();
    const result = await plugin.dispatch('stage', {
      cwd: repoDir,
      keys: 'all',
      includeUntracked: true,
      expected: expectedStageAll(status),
    });
    assert.equal(result.ok, true);
    const keys = (await plugin.dispatch('status', { cwd: repoDir })).value.entries.map((entry) => entry.key);
    assert.ok(keys.includes('staged:new file.txt'));
  });
});

describe('write expectations', () => {
  /** A throwaway repository with one committed file and one unstaged edit. */
  async function expectationRepo(name) {
    const dir = join(workspace, name);
    await mkdir(dir, { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await run('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    await writeFile(join(dir, 'seed.txt'), 'base\n', 'utf8');
    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
    await writeFile(join(dir, 'seed.txt'), 'changed\n', 'utf8');
    await writeFile(join(dir, 'extra.txt'), 'new\n', 'utf8');
    return dir;
  }

  function statusOf(dir) {
    return plugin.dispatch('status', { cwd: dir });
  }

  test('stage without expected fingerprints is refused as stale', async () => {
    const dir = await expectationRepo('expect-missing');
    const before = await readFile(join(dir, 'seed.txt'), 'utf8');
    const result = await plugin.dispatch('stage', { cwd: dir, keys: ['unstaged:seed.txt'] });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'entry/stale');
    assert.equal(await readFile(join(dir, 'seed.txt'), 'utf8'), before);
    const staged = await run('git', ['diff', '--cached', '--name-only'], { cwd: dir });
    assert.equal(staged.stdout.trim(), '', 'nothing may be staged without a valid expectation');
  });

  test('an external edit between preview and stage is a stale entry, not a write', async () => {
    const dir = await expectationRepo('expect-stale');
    const status = (await statusOf(dir)).value;
    const expected = expectedFor(status, ['unstaged:seed.txt']);
    // Someone edits the file after the panel last saw it.
    await writeFile(join(dir, 'seed.txt'), 'changed again\n', 'utf8');
    const result = await plugin.dispatch('stage', { cwd: dir, keys: ['unstaged:seed.txt'], expected });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'entry/stale');
    assert.deepEqual(result.error.details, {
      key: 'unstaged:seed.txt',
      expected: expected['unstaged:seed.txt'],
      actual: (await statusOf(dir)).value.entries.find((entry) => entry.key === 'unstaged:seed.txt').fingerprint,
    });
    const stagedNames = await run('git', ['diff', '--cached', '--name-only'], { cwd: dir });
    assert.equal(stagedNames.stdout.trim(), '');
  });

  test('unstage without or with an outdated expectation is refused', async () => {
    const dir = await expectationRepo('expect-unstage');
    let status = (await statusOf(dir)).value;
    const staged = await plugin.dispatch('stage', {
      cwd: dir,
      keys: ['unstaged:seed.txt'],
      expected: expectedFor(status, ['unstaged:seed.txt']),
    });
    assert.equal(staged.ok, true);

    const missing = await plugin.dispatch('unstage', { cwd: dir, keys: ['staged:seed.txt'] });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'entry/stale');

    const oldExpected = expectedFor((await statusOf(dir)).value, ['staged:seed.txt']);
    await writeFile(join(dir, 'seed.txt'), 'changed after staging\n', 'utf8');
    await run('git', ['add', 'seed.txt'], { cwd: dir });
    const stale = await plugin.dispatch('unstage', { cwd: dir, keys: ['staged:seed.txt'], expected: oldExpected });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'entry/stale');
    const cached = await run('git', ['diff', '--cached', '--name-only'], { cwd: dir });
    assert.match(cached.stdout, /seed\.txt/, 'the stale unstage must not write');
  });

  test('stage "all" requires the expected key set to match exactly', async () => {
    const dir = await expectationRepo('expect-all');
    const status = (await statusOf(dir)).value;
    const full = expectedStageAll(status);

    const missingKey = { ...full };
    delete missingKey['untracked:extra.txt'];
    const missing = await plugin.dispatch('stage', { cwd: dir, keys: 'all', includeUntracked: true, expected: missingKey });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'entry/stale');

    const extra = { ...full, 'untracked:not-there.txt': { base: 'empty', target: 'f'.repeat(64) } };
    const extraResult = await plugin.dispatch('stage', { cwd: dir, keys: 'all', includeUntracked: true, expected: extra });
    assert.equal(extraResult.ok, false);
    assert.equal(extraResult.error.code, 'entry/stale');

    const stagedNames = await run('git', ['diff', '--cached', '--name-only'], { cwd: dir });
    assert.equal(stagedNames.stdout.trim(), '', 'mismatched expectation sets must not stage anything');

    const ok = await plugin.dispatch('stage', { cwd: dir, keys: 'all', includeUntracked: true, expected: full });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value.affected.sort(), ['extra.txt', 'seed.txt']);
    assert.deepEqual(ok.value.skipped, undefined);
  });

  test('unstage "all" requires the complete staged set and leaves the worktree alone', async () => {
    const dir = await expectationRepo('expect-unstage-all');
    const status = (await statusOf(dir)).value;
    await plugin.dispatch('stage', { cwd: dir, keys: 'all', includeUntracked: true, expected: expectedStageAll(status) });
    const stagedStatus = (await statusOf(dir)).value;
    const complete = expectedUnstageAll(stagedStatus);
    assert.deepEqual(Object.keys(complete).sort(), ['staged:extra.txt', 'staged:seed.txt']);

    const partial = { 'staged:seed.txt': complete['staged:seed.txt'] };
    const refused = await plugin.dispatch('unstage', { cwd: dir, keys: 'all', expected: partial });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'entry/stale');

    const before = await readFile(join(dir, 'seed.txt'), 'utf8');
    const ok = await plugin.dispatch('unstage', { cwd: dir, keys: 'all', expected: complete });
    assert.equal(ok.ok, true);
    assert.equal(await readFile(join(dir, 'seed.txt'), 'utf8'), before, 'unstaging never writes the worktree');
    const cached = await run('git', ['diff', '--cached', '--name-only'], { cwd: dir });
    assert.equal(cached.stdout.trim(), '');
  });
});

describe('commit', () => {
  test('commit only the staged snapshot and refuse a stale expectation', async () => {
    const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
    assert.ok(status.entries.some((entry) => entry.status === 'staged'));
    const first = await plugin.dispatch('commit', {
      cwd: repoDir,
      message: 'feat: second commit',
      expected: { headSha: status.repo.headSha, stagedFingerprint: status.stagedFingerprint },
    });
    assert.equal(first.ok, true);
    assert.notEqual(first.value.headSha, status.repo.headSha);
    assert.match(first.value.summary, /feat: second commit/);
    const log = await git(['log', '-1', '--pretty=%s']);
    assert.equal(log.stdout.trim(), 'feat: second commit');

    const stale = await plugin.dispatch('commit', {
      cwd: repoDir,
      message: 'should not happen',
      expected: { headSha: status.repo.headSha, stagedFingerprint: status.stagedFingerprint },
    });
    assert.equal(stale.ok, false);
    assert.ok(['commit/stale', 'commit/empty-index'].includes(stale.error.code), stale.error.code);
    const head = await git(['log', '-1', '--pretty=%s']);
    assert.equal(head.stdout.trim(), 'feat: second commit');
  });

  test('an empty message is refused and nothing is committed', async () => {
    const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
    const before = status.repo.headSha;
    const result = await plugin.dispatch('commit', {
      cwd: repoDir,
      message: '   ',
      expected: { headSha: status.repo.headSha, stagedFingerprint: status.stagedFingerprint },
    });
    assert.equal(result.ok, false);
    assert.equal((await plugin.dispatch('status', { cwd: repoDir })).value.repo.headSha, before);
  });
});

describe('push', () => {
  test('push preview reports no remote and push is refused', async () => {
    const preview = await plugin.dispatch('pushPreview', { cwd: repoDir });
    assert.equal(preview.ok, true);
    assert.equal(preview.value.remotes.length, 0);
    assert.equal(preview.value.canPush, false);
    const push = await plugin.dispatch('push', { cwd: repoDir });
    assert.equal(push.ok, false);
    assert.equal(push.error.code, 'push/no-remote');
  });

  test('first push creates the upstream and later preview reports it', async () => {
    const bare = join(workspace, 'remote.git');
    await run('git', ['init', '-q', '--bare', bare], { cwd: workspace });
    await git(['remote', 'add', 'origin', bare]);
    const preview = await plugin.dispatch('pushPreview', { cwd: repoDir });
    assert.equal(preview.ok, true);
    assert.equal(preview.value.canPush, true);
    assert.equal(preview.value.sourceBranch, 'main');
    assert.equal(preview.value.targetBranch, 'main');
    assert.equal(preview.value.remote, 'origin');
    assert.equal(preview.value.commitsBase, null, 'no remote-tracking ref exists before the first push');
    const pushed = await plugin.dispatch('push', { cwd: repoDir, remote: 'origin', targetBranch: 'main', setUpstream: true });
    assert.equal(pushed.ok, true);
    assert.equal(pushed.value.ok, true);
    assert.equal(pushed.value.sourceBranch, 'main');
    assert.equal(pushed.value.targetBranch, 'main');
    const afterPreview = await plugin.dispatch('pushPreview', { cwd: repoDir });
    assert.ok(afterPreview.value.upstream);
    assert.equal(afterPreview.value.commitsBase, 'refs/remotes/origin/main');
    assert.equal(afterPreview.value.commits.length, 0);
  });

  test('push ignores a client-supplied source branch (only remote/target are wire data)', async () => {
    const preview = await plugin.dispatch('pushPreview', { cwd: repoDir, remote: 'origin', targetBranch: 'main' });
    assert.equal(preview.ok, true);
    // `branch` is no longer a request field; the Host derives the source itself.
    const pushed = await plugin.dispatch('push', { cwd: repoDir, remote: 'origin', branch: 'does-not-exist', setUpstream: true });
    assert.equal(pushed.ok, true, JSON.stringify(pushed.error));
    assert.equal(pushed.value.sourceBranch, 'main');
    assert.equal(pushed.value.branch, 'main');
  });

  test('push parameters are validated before touching git', async () => {
    const badBranch = await plugin.dispatch('pushPreview', { cwd: repoDir, targetBranch: 'bad branch name' });
    assert.equal(badBranch.ok, false);
    assert.equal(badBranch.error.code, 'push/no-branch');
    const magicBranch = await plugin.dispatch('pushPreview', { cwd: repoDir, targetBranch: 'refs/heads/x:refs/heads/y' });
    assert.equal(magicBranch.ok, false);
    assert.equal(magicBranch.error.code, 'push/no-branch');
    const badRemote = await plugin.dispatch('pushPreview', { cwd: repoDir, remote: 'bad remote' });
    assert.equal(badRemote.ok, false);
    assert.equal(badRemote.error.code, 'push/no-remote');
  });
});

describe('remoteSet', () => {
  let remoteRepo;
  let bareDir;

  before(async () => {
    remoteRepo = await mkdtemp(join(workspace, 'remote-config-'));
    await git(['init', '-q', '-b', 'main'], remoteRepo);
    await git(['config', 'user.email', 'test@example.com'], remoteRepo);
    await git(['config', 'user.name', 'Test User'], remoteRepo);
    await writeFile(join(remoteRepo, 'a.txt'), 'a\n', 'utf8');
    await git(['add', '.'], remoteRepo);
    await git(['commit', '-q', '-m', 'initial'], remoteRepo);
    // A local bare repository stands in for the remote: no network is used.
    bareDir = join(remoteRepo, 'upstream.git');
    await run('git', ['init', '-q', '--bare', '-b', 'main', bareDir], { cwd: remoteRepo });
  });

  test('adds a remote and returns the refreshed status', async () => {
    const url = bareDir.replace(/\\/g, '/');
    const result = await plugin.dispatch('remoteSet', { cwd: remoteRepo, name: 'origin', url });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.value.ok, true);
    assert.equal(result.value.name, 'origin');
    assert.equal(result.value.url, url);
    assert.equal(result.value.created, true);
    assert.equal(resolve(result.value.repo.root), resolve(remoteRepo));
    assert.deepEqual(result.value.status.repo.remotes, [{ name: 'origin', url }]);
    // The write landed in local Git config, and a separate status call agrees.
    const configured = await git(['remote', 'get-url', 'origin'], remoteRepo);
    assert.equal(configured.stdout.trim(), url);
    const status = await plugin.dispatch('status', { cwd: remoteRepo });
    assert.equal(status.ok, true);
    assert.deepEqual(status.value.repo.remotes, [{ name: 'origin', url }]);
  });

  test('updates an existing remote URL in place instead of adding a duplicate', async () => {
    const url = join(workspace, 'moved-origin.git').replace(/\\/g, '/');
    const result = await plugin.dispatch('remoteSet', { cwd: remoteRepo, name: 'origin', url });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.value.created, false);
    assert.deepEqual(result.value.status.repo.remotes, [{ name: 'origin', url }]);
    const listed = await git(['remote'], remoteRepo);
    assert.deepEqual(listed.stdout.trim().split(/\r?\n/), ['origin']);
  });

  test('supports a second remote and serialises concurrent remote writes', async () => {
    const first = join(workspace, 'second.git').replace(/\\/g, '/');
    const second = join(workspace, 'third.git').replace(/\\/g, '/');
    const [a, b] = await Promise.all([
      plugin.dispatch('remoteSet', { cwd: remoteRepo, name: 'upstream', url: first }),
      plugin.dispatch('remoteSet', { cwd: remoteRepo, name: 'backup', url: second }),
    ]);
    assert.equal(a.ok, true, JSON.stringify(a.error));
    assert.equal(b.ok, true, JSON.stringify(b.error));
    assert.equal(a.value.created, true);
    assert.equal(b.value.created, true);
    const names = (await git(['remote'], remoteRepo)).stdout.trim().split(/\r?\n/).sort();
    assert.deepEqual(names, ['backup', 'origin', 'upstream']);
  });

  test('rejects invalid remote config before touching git', async () => {
    const before = (await git(['remote'], remoteRepo)).stdout.trim();
    const cases = [
      [{ url: 'https://example.com/repo.git' }, 'missing name'],
      [{ name: 'origin' }, 'missing url'],
      [{ name: '', url: 'https://example.com/repo.git' }, 'empty name'],
      [{ name: 'bad name', url: 'https://example.com/repo.git' }, 'name with a space'],
      [{ name: '-origin', url: 'https://example.com/repo.git' }, 'name starting with a dash'],
      [{ name: '.origin', url: 'https://example.com/repo.git' }, 'name starting with a dot'],
      [{ name: 'a'.repeat(201), url: 'https://example.com/repo.git' }, 'oversized name'],
      [{ name: 'ok', url: '' }, 'empty url'],
      [{ name: 'ok', url: '   ' }, 'blank url'],
      [{ name: 'ok', url: '-u' }, 'url starting with a dash'],
      [{ name: 'ok', url: 'https://example.com/\u0000bad' }, 'url with a control character'],
      [{ name: 'ok', url: 'u'.repeat(2049) }, 'oversized url'],
    ];
    for (const [params, label] of cases) {
      const result = await plugin.dispatch('remoteSet', { cwd: remoteRepo, ...params });
      assert.equal(result.ok, false, label);
      assert.equal(result.error.code, 'remote/invalid', label);
    }
    assert.equal((await git(['remote'], remoteRepo)).stdout.trim(), before,
      'invalid requests never write git config');
  });

  test('refuses a workspace that is not a git repository', async () => {
    const plain = await mkdtemp(join(workspace, 'plain-remote-'));
    const result = await plugin.dispatch('remoteSet', {
      cwd: plain,
      name: 'origin',
      url: 'https://example.com/repo.git',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'repo/no-git');
  });
});

describe('settings and AI grouping', () => {
  test('settings default to AI off and persist changes', async () => {
    const initial = await plugin.dispatch('settingsGet', {});
    assert.equal(initial.ok, true);
    assert.equal(initial.value.aiClassify, false);
    assert.equal(initial.value.aiGrouping, 'role', 'grouping defaults to the role mode');
    assert.equal(initial.value.commitMode, 'commit', 'commit mode defaults to commit');
    const updated = await plugin.dispatch('settingsSet', { patch: { aiClassify: true, maxCandidates: 50 } });
    assert.equal(updated.ok, true);
    assert.equal(updated.value.aiClassify, true);
    assert.equal(updated.value.maxCandidates, 50);
    const stored = JSON.parse(await readFile(join(home, 'code-review', 'settings.json'), 'utf8'));
    assert.equal(stored.aiClassify, true);
    assert.equal(stored.maxCandidates, 50);
    assert.equal(stored.aiGrouping, 'role');
    assert.equal(stored.commitMode, 'commit');
  });

  test('aiGrouping persists, is validated and falls back to role', async () => {
    try {
      const updated = await plugin.dispatch('settingsSet', { patch: { aiGrouping: 'logic' } });
      assert.equal(updated.ok, true);
      assert.equal(updated.value.aiGrouping, 'logic');
      assert.equal((await plugin.dispatch('settingsGet', {})).value.aiGrouping, 'logic');
      const stored = JSON.parse(await readFile(join(home, 'code-review', 'settings.json'), 'utf8'));
      assert.equal(stored.aiGrouping, 'logic');

      for (const value of ['bogus', '', 1, null, true]) {
        const rejected = await plugin.dispatch('settingsSet', { patch: { aiGrouping: value } });
        assert.equal(rejected.ok, false, `accepted ${JSON.stringify(value)}`);
        assert.equal(rejected.error.code, 'settings/invalid');
      }
      // The rejected writes must not have changed the persisted mode.
      assert.equal((await plugin.dispatch('settingsGet', {})).value.aiGrouping, 'logic');
    } finally {
      await plugin.dispatch('settingsSet', { patch: { aiGrouping: 'role' } });
    }
  });

  test('commitMode persists, rejects the retired AI mode and unrelated saves keep it', async () => {
    const settingsFile = join(home, 'code-review', 'settings.json');
    try {
      const updated = await plugin.dispatch('settingsSet', { patch: { commitMode: 'commitPush' } });
      assert.equal(updated.ok, true);
      assert.equal(updated.value.commitMode, 'commitPush');
      assert.equal((await plugin.dispatch('settingsGet', {})).value.commitMode, 'commitPush');
      assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).commitMode, 'commitPush');

      // The first iteration exposed 'aiCommitPush' as a drawer mode; it is now a
      // toolbar action and must no longer be accepted as a persisted mode.
      const retired = await plugin.dispatch('settingsSet', { patch: { commitMode: 'aiCommitPush' } });
      assert.equal(retired.ok, false);
      assert.equal(retired.error.code, 'settings/invalid');

      // A patch that does not mention the field must not reset it.
      const unrelated = await plugin.dispatch('settingsSet', { patch: { maxCandidates: 60 } });
      assert.equal(unrelated.ok, true);
      assert.equal(unrelated.value.commitMode, 'commitPush');
      assert.equal((await plugin.dispatch('settingsGet', {})).value.commitMode, 'commitPush');
      assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).commitMode, 'commitPush');

      for (const value of ['aiCommitPush', 'push', 'commit-push', '', 1, null, true]) {
        const rejected = await plugin.dispatch('settingsSet', { patch: { commitMode: value } });
        assert.equal(rejected.ok, false, `accepted ${JSON.stringify(value)}`);
        assert.equal(rejected.error.code, 'settings/invalid');
      }
      // Rejected writes persist nothing; the previous mode and saved file stay intact.
      assert.equal((await plugin.dispatch('settingsGet', {})).value.commitMode, 'commitPush');
      assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).commitMode, 'commitPush');
    } finally {
      await plugin.dispatch('settingsSet', { patch: { commitMode: 'commit' } });
    }
  });

  test('a retired or unknown persisted commitMode degrades to commit', async () => {
    // A hand-edited / older settings file must not break the drawer: the retired
    // 'aiCommitPush' mode and any unknown value fall back to the documented
    // default on load.
    const fallbackHome = join(workspace, 'fallback-home');
    await mkdir(join(fallbackHome, 'code-review'), { recursive: true });
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = fallbackHome;
    try {
      for (const persistedMode of ['aiCommitPush', 'obsolete-mode']) {
        await writeFile(
          join(fallbackHome, 'code-review', 'settings.json'),
          `${JSON.stringify({ aiClassify: true, commitMode: persistedMode }, null, 2)}\n`,
          'utf8',
        );
        const { createHostPlugin } = await import('../src/host/index.js');
        const fallbackPlugin = createHostPlugin(fakeCtx(repoDir));
        const read = await fallbackPlugin.dispatch('settingsGet', {});
        assert.equal(read.ok, true);
        assert.equal(read.value.commitMode, 'commit', `persisted ${persistedMode}`);
        assert.equal(read.value.aiClassify, true, 'the rest of the persisted settings still load');
      }
    } finally {
      process.env.DSH_HOME = previousHome;
    }
  });

  test('classify rejects invalid settings values', async () => {
    const result = await plugin.dispatch('settingsSet', { patch: { aiClassify: 'yes' } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'settings/invalid');
  });

  test('classification keeps every real entry exactly once', async () => {
    // Make sure the working tree has a mixed change set again (the commit and
    // push suites above left it clean).
    await writeFile(join(repoDir, 'README.md'), '# demo\n\nmore docs\n\nclassify me\n', 'utf8');
    await writeFile(join(repoDir, 'config.json'), '{"feature": true}\n', 'utf8');
    const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
    assert.ok(status.entries.length > 0, 'expected a non-empty change set');
    const entries = status.entries.map((entry) => ({
      key: entry.key,
      status: entry.status,
      change: entry.change,
      path: entry.path,
      oldPath: entry.oldPath,
      additions: entry.additions,
      deletions: entry.deletions,
      kind: entry.kind,
      fingerprint: entry.fingerprint,
    }));
    const first = entries[0];
    llmReply = JSON.stringify({
      categories: [
        { name: '配置', ids: [first.key, 'hallucinated:path'] },
        { name: '文档', ids: [first.key] },
      ],
    });
    const result = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-1', entries });
    assert.equal(result.ok, true);
    const flattened = [];
    for (const category of result.value.categories) {
      for (const id of category.ids) {
        assert.ok(entries.some((entry) => entry.key === id), `unknown id kept: ${id}`);
        flattened.push(id);
      }
    }
    assert.equal(new Set(flattened).size, flattened.length, 'duplicate ids in the result');
    assert.equal(flattened.length, entries.length, 'entries must not be dropped');
    assert.ok(flattened.includes(first.key));
    // Classification is a mechanical task: reasoning is turned off when the model
    // advertises it, and the adapter/model default output cap is used (a pinned
    // small cap truncates reasoning-model JSON replies -> ai/invalid).
    assert.equal(llmRequest.reasoningEffort, 'off');
    assert.equal(llmRequest.maxTokens, undefined);

    const cached = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-2', entries });
    assert.equal(cached.ok, true);
    assert.equal(cached.value.cached, true);
  });

  test('classify maps a thrown llm failure to ai/unavailable with a stable reason', async () => {
    // A failing provider must surface a safe failure code (never the raw error
    // text) so the panel can explain why AI grouping failed.
    const enabled = await plugin.dispatch('settingsSet', { patch: { aiClassify: true, provider: null, model: null } });
    assert.equal(enabled.ok, true);
    try {
      llmThrow = { mode: 'sync', error: Object.assign(new Error('boom at C:\\secret\\path'), { code: 'NO_ADAPTER' }) };
      const sync = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-throw-sync', force: true });
      assert.equal(sync.ok, false);
      assert.equal(sync.error.code, 'ai/unavailable');
      assert.equal(sync.error.details.reason, 'NO_ADAPTER');
      assert.equal(sync.error.message.includes('boom'), false, 'raw error text must not leak');

      llmThrow = { mode: 'async', error: Object.assign(new Error('stream boom'), { code: 'RATE_LIMIT' }) };
      const async = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-throw-async', force: true });
      assert.equal(async.ok, false);
      assert.equal(async.error.code, 'ai/unavailable');
      assert.equal(async.error.details.reason, 'RATE_LIMIT');
      assert.equal(async.error.message.includes('boom'), false, 'raw error text must not leak');
    } finally {
      llmThrow = null;
      await plugin.dispatch('settingsSet', { patch: { aiClassify: false, provider: null, model: null } });
    }
  });

  test('classify reports truncated and empty model replies with a stable reason', async () => {
    const enabled = await plugin.dispatch('settingsSet', { patch: { aiClassify: true, provider: null, model: null } });
    assert.equal(enabled.ok, true);
    try {
      llmReply = '{"categories":[{"name":"x"';
      llmFinish = 'max-tokens';
      const truncated = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-max-tokens', force: true });
      assert.equal(truncated.ok, false);
      assert.equal(truncated.error.code, 'ai/invalid');
      assert.equal(truncated.error.details.reason, 'max-tokens');

      llmReply = '';
      llmFinish = null;
      const empty = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-empty', force: true });
      assert.equal(empty.ok, false);
      assert.equal(empty.error.code, 'ai/invalid');
      assert.equal(empty.error.details.reason, 'empty-reply');

      llmReply = 'not json at all';
      const notJson = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-not-json', force: true });
      assert.equal(notJson.ok, false);
      assert.equal(notJson.error.code, 'ai/invalid');
      assert.equal(notJson.error.details.reason, 'not-json');
    } finally {
      llmReply = null;
      llmFinish = null;
      await plugin.dispatch('settingsSet', { patch: { aiClassify: false, provider: null, model: null } });
    }
  });

  test('classify trusts only entry keys and rebuilds everything else from status', async () => {
    const previous = (await plugin.dispatch('settingsGet', {})).value;
    await plugin.dispatch('settingsSet', { patch: { aiClassify: true, provider: null, model: null } });
    try {
      await writeFile(join(repoDir, 'notes.txt'), 'plain notes for grouping\n', 'utf8');
      await writeFile(join(repoDir, '.env.local'), 'SECRET_TOKEN=super-secret-value\n', 'utf8');
      await writeFile(join(repoDir, '.envrc'), 'export TOKEN=also-secret-value\n', 'utf8');
      const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
      const realKeys = status.entries.map((entry) => entry.key);
      const notesKey = status.entries.find((entry) => entry.path === 'notes.txt').key;
      // Forged metadata: the Host must ignore path/status/change/kind/counts and
      // use only the key. `../AGENTS.md` must never reach a model payload.
      const forged = realKeys.map((key) => ({
        key,
        status: 'untracked',
        change: 'added',
        path: '../AGENTS.md',
        oldPath: null,
        additions: 9999,
        deletions: 9999,
        kind: 'text',
        fingerprint: { base: 'empty', target: 'f'.repeat(64) },
      }));
      llmReply = JSON.stringify({ categories: [{ name: '全部', ids: realKeys }] });
      const result = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-boundary', entries: forged, force: true });
      assert.equal(result.ok, true);

      const payload = lastPrompt();
      assert.equal(payload.entries.length, realKeys.length);
      for (const row of payload.entries) {
        const real = status.entries.find((entry) => entry.key === row.id);
        assert.ok(real, `unknown id ${row.id}`);
        assert.equal(row.path, real.path, 'metadata must come from the Host status');
        assert.equal(row.status, real.status);
        assert.equal(row.change, real.change);
        assert.notEqual(row.added, 9999);
      }
      const serialized = JSON.stringify(payload);
      assert.equal(serialized.includes('AGENTS.md'), false, 'a forged path must never reach the model');
      assert.equal(serialized.includes('super-secret-value'), false, '.env* content must never be excerpted');
      assert.equal(serialized.includes('also-secret-value'), false, '.env* content must never be excerpted');
      // Untracked text files are the only excerpt source; sensitive names are excluded.
      const sensitive = payload.entries.filter((row) => row.path.startsWith('.env'));
      assert.equal(sensitive.length, 2);
      assert.ok(sensitive.every((row) => row.excerpt === undefined));
      const notes = payload.entries.find((row) => row.id === notesKey);
      assert.match(notes.excerpt, /plain notes for grouping/);

      // A key that is no longer in the change set is rejected before the model call.
      const callsBefore = llmCalls;
      const unknown = await plugin.dispatch('classify', {
        cwd: repoDir,
        requestId: 'req-boundary-missing',
        entries: [{ key: 'untracked:ghost.txt' }],
      });
      assert.equal(unknown.ok, false);
      assert.equal(unknown.error.code, 'entry/not-found');
      assert.equal(llmCalls, callsBefore, 'an unknown key must not reach the model');

      // Omitting entries classifies every current Host-derived entry.
      const all = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-boundary-all', force: true });
      assert.equal(all.ok, true);
      assert.equal(lastPrompt().entries.length, realKeys.length);
    } finally {
      await plugin.dispatch('settingsSet', { patch: { aiClassify: previous.aiClassify === true } });
    }
  });

  test('models lists every configured route and marks the DSH default', async () => {
    await plugin.dispatch('settingsSet', { patch: { provider: null, model: null } });
    const result = await plugin.dispatch('models', {});
    assert.equal(result.ok, true);
    const value = result.value;
    assert.deepEqual(value.defaultModel, { provider: 'fake', model: 'fake-model' });
    assert.equal(value.selectedModel, null);
    const fake = value.routes.filter((route) => route.provider === 'fake').map((route) => route.model);
    assert.ok(fake.includes('fake-model'));
    assert.ok(fake.includes('fake-model-pro'), JSON.stringify(value.routes));
    // A provider that advertises no models is not selectable (it has nothing to offer).
    assert.equal(value.routes.some((route) => route.provider === 'other'), false, 'provider without models must not appear');
    // The effective route's reasoning ladder powers the model picker's second row.
    assert.deepEqual(value.reasoning.route, { provider: 'fake', model: 'fake-model' });
    assert.deepEqual(value.reasoning.efforts.map((effort) => effort.id), ['off', 'high']);
    assert.equal(value.reasoning.defaultEffort, 'high');
  });

  test('each grouping mode keeps and uses its own prompt instructions', async () => {
    const saved = await plugin.dispatch('settingsSet', {
      patch: {
        aiClassify: true,
        provider: 'fake',
        model: 'fake-model-pro',
        customInstructionsRole: '  按业务域分组  ',
        customInstructionsLogic: '  把测试与夹具放进对应功能  ',
      },
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.value.selectedModel, 'fake/fake-model-pro');
    assert.equal(saved.value.effectiveModel, 'fake/fake-model-pro');
    assert.equal(saved.value.model, 'fake-model-pro');
    assert.equal(saved.value.customInstructionsRole, '按业务域分组');
    assert.equal(saved.value.customInstructionsLogic, '把测试与夹具放进对应功能');

    const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
    const entries = status.entries.map((entry) => ({
      key: entry.key,
      status: entry.status,
      change: entry.change,
      path: entry.path,
      oldPath: entry.oldPath,
      additions: entry.additions,
      deletions: entry.deletions,
      kind: entry.kind,
      fingerprint: entry.fingerprint,
    }));
    llmReply = JSON.stringify({ categories: [{ name: '全部', ids: entries.map((entry) => entry.key) }] });

    // Role mode receives only its own instructions; logic mode only its own.
    const role = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-model-role', entries, force: true, grouping: 'role' });
    assert.equal(role.ok, true);
    assert.equal(role.value.model, 'fake/fake-model-pro');
    assert.equal(role.value.categories.length, 1);
    assert.match(llmRequest.system, /按业务域分组/);
    assert.doesNotMatch(llmRequest.system, /把测试与夹具放进对应功能/);

    const logic = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-model-logic', entries, force: true, grouping: 'logic' });
    assert.equal(logic.ok, true);
    assert.match(llmRequest.system, /把测试与夹具放进对应功能/);
    assert.doesNotMatch(llmRequest.system, /按业务域分组/);

    // The pre-split shared field still maps to both modes instead of being dropped.
    const legacy = await plugin.dispatch('settingsSet', { patch: { customInstructions: '  共享要求  ' } });
    assert.equal(legacy.ok, true);
    assert.equal(legacy.value.customInstructionsRole, '共享要求');
    assert.equal(legacy.value.customInstructionsLogic, '共享要求');

    // Invalid prompt types are rejected per field.
    const invalidLegacy = await plugin.dispatch('settingsSet', { patch: { customInstructions: 42 } });
    assert.equal(invalidLegacy.ok, false);
    assert.equal(invalidLegacy.error.code, 'settings/invalid');
    const invalidRole = await plugin.dispatch('settingsSet', { patch: { customInstructionsRole: 42 } });
    assert.equal(invalidRole.ok, false);
    assert.equal(invalidRole.error.code, 'settings/invalid');

    // Clearing the selection falls back to the DSH default model.
    const cleared = await plugin.dispatch('settingsSet', {
      patch: { provider: null, model: null, customInstructionsRole: null, customInstructionsLogic: null },
    });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.value.selectedModel, null);
    assert.equal(cleared.value.effectiveModel, 'fake/fake-model');
    assert.equal(cleared.value.customInstructionsRole, undefined);
    assert.equal(cleared.value.customInstructionsLogic, undefined);
  });

  test('turning the switch off disables classification', async () => {
    await plugin.dispatch('settingsSet', { patch: { aiClassify: false } });
    const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
    const result = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-3', entries: status.entries });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ai/disabled');
  });

  test('the session model is the default classification route', async () => {
    // The assistant's own configured models list is unchanged; only the
    // session's model selection / last request header differs from the default.
    sessionRoutes = { 'session-model': { provider: 'fake', model: 'fake-model-pro' } };
    projectionStates = { 'session-model': { lastUsed: { provider: 'fake', model: 'fake-model-pro' }, pending: null } };
    try {
      await plugin.dispatch('settingsSet', { patch: { aiClassify: true, provider: null, model: null } });
      const listed = await plugin.dispatch('models', { sessionId: 'session-model' });
      assert.equal(listed.ok, true);
      assert.deepEqual(listed.value.sessionModel, { provider: 'fake', model: 'fake-model-pro' });
      assert.deepEqual(listed.value.defaultModel, { provider: 'fake', model: 'fake-model' });
      assert.equal(listed.value.selectedModel, null);
      assert.ok(
        listed.value.routes.some((route) => route.provider === 'fake' && route.model === 'fake-model-pro'),
        'the session route must be selectable',
      );

      // The composer's pending selection (picked but not sent yet) wins, so the
      // dialog shows the same model the composer seat shows.
      projectionStates['session-model'].pending = { provider: 'fake', model: 'fake-model' };
      const pendingListed = await plugin.dispatch('models', { sessionId: 'session-model' });
      assert.deepEqual(pendingListed.value.sessionModel, { provider: 'fake', model: 'fake-model' });

      // The projection also wins when it disagrees with the logged header.
      projectionStates['session-model'] = { lastUsed: { provider: 'fake', model: 'fake-model-pro' }, pending: null };
      sessionRoutes = { 'session-model': { provider: 'fake', model: 'fake-model' } };
      const projectedListed = await plugin.dispatch('models', { sessionId: 'session-model' });
      assert.deepEqual(projectedListed.value.sessionModel, { provider: 'fake', model: 'fake-model-pro' });

      sessionRoutes = { 'session-model': { provider: 'fake', model: 'fake-model-pro' } };
      const read = await plugin.dispatch('settingsGet', { sessionId: 'session-model' });
      assert.equal(read.ok, true);
      assert.equal(read.value.sessionModel, 'fake/fake-model-pro');
      assert.equal(read.value.effectiveModel, 'fake/fake-model-pro');
      assert.equal(read.value.defaultModel, 'fake/fake-model');

      // No explicit setting → the session's model is used for classification.
      const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
      const entries = status.entries.map((entry) => ({
        key: entry.key,
        status: entry.status,
        change: entry.change,
        path: entry.path,
        oldPath: entry.oldPath,
        additions: entry.additions,
        deletions: entry.deletions,
        kind: entry.kind,
        fingerprint: entry.fingerprint,
      }));
      llmReply = JSON.stringify({ categories: [{ name: '全部', ids: entries.map((entry) => entry.key) }] });
      const bySession = await plugin.dispatch('classify', {
        cwd: repoDir,
        sessionId: 'session-model',
        requestId: 'req-session-model',
        entries,
        force: true,
      });
      assert.equal(bySession.ok, true);
      assert.equal(bySession.value.model, 'fake/fake-model-pro');

      // An explicit plugin choice still wins over the session model.
      await plugin.dispatch('settingsSet', { patch: { provider: 'fake', model: 'fake-model' } });
      llmReply = JSON.stringify({ categories: [{ name: '全部', ids: entries.map((entry) => entry.key) }] });
      const bySetting = await plugin.dispatch('classify', {
        cwd: repoDir,
        sessionId: 'session-model',
        requestId: 'req-setting-model',
        entries,
        force: true,
      });
      assert.equal(bySetting.ok, true);
      assert.equal(bySetting.value.model, 'fake/fake-model');
      const persisted = await plugin.dispatch('settingsGet', { sessionId: 'session-model' });
      assert.equal(persisted.value.selectedModel, 'fake/fake-model');
      assert.equal(persisted.value.sessionModel, 'fake/fake-model-pro');
      assert.equal(persisted.value.effectiveModel, 'fake/fake-model');
      assert.equal(persisted.value.model, 'fake-model');
    } finally {
      sessionRoutes = {};
      projectionStates = {};
      await plugin.dispatch('settingsSet', { patch: { provider: null, model: null, aiClassify: false } });
    }
  });

  test('maxCandidates bounds one classification request', async () => {
    await writeFile(join(repoDir, 'limit-a.txt'), 'a\n', 'utf8');
    await writeFile(join(repoDir, 'limit-b.txt'), 'b\n', 'utf8');
    await writeFile(join(repoDir, 'limit-c.txt'), 'c\n', 'utf8');
    await plugin.dispatch('settingsSet', { patch: { aiClassify: true, provider: null, model: null, maxCandidates: 1 } });
    try {
      const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
      const entries = status.entries.map((entry) => ({
        key: entry.key,
        status: entry.status,
        change: entry.change,
        path: entry.path,
        oldPath: entry.oldPath,
        additions: entry.additions,
        deletions: entry.deletions,
        kind: entry.kind,
        fingerprint: entry.fingerprint,
      }));
      assert.ok(entries.length >= 3, 'expected at least three changed entries');
      llmReply = JSON.stringify({ categories: [{ name: '全部', ids: entries.map((entry) => entry.key) }] });
      const result = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-max', entries, force: true });
      assert.equal(result.ok, true);
      assert.equal(result.value.omitted, entries.length - 1);
      const classifiedIds = result.value.categories.flatMap((category) => category.ids);
      assert.equal(classifiedIds.length, 1, 'only maxCandidates entries may reach the model');
    } finally {
      await plugin.dispatch('settingsSet', { patch: { maxCandidates: 200, aiClassify: false } });
    }
  });

  test('concurrent settings saves keep every patch', async () => {
    const [first, second] = await Promise.all([
      plugin.dispatch('settingsSet', { patch: { aiClassify: true } }),
      plugin.dispatch('settingsSet', { patch: { maxCandidates: 77, locale: 'en' } }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const stored = JSON.parse(await readFile(join(home, 'code-review', 'settings.json'), 'utf8'));
    assert.equal(stored.aiClassify, true);
    assert.equal(stored.maxCandidates, 77);
    assert.equal(stored.locale, 'en');
    const read = await plugin.dispatch('settingsGet', {});
    assert.equal(read.value.aiClassify, true);
    assert.equal(read.value.maxCandidates, 77);
    assert.equal(read.value.locale, 'en');
    await plugin.dispatch('settingsSet', { patch: { aiClassify: false, locale: 'zh' } });
  });

  test('a half-set model route is rejected', async () => {
    const providerOnly = await plugin.dispatch('settingsSet', { patch: { provider: 'fake' } });
    assert.equal(providerOnly.ok, false);
    assert.equal(providerOnly.error.code, 'settings/invalid');
    const modelOnly = await plugin.dispatch('settingsSet', { patch: { model: 'fake-model' } });
    assert.equal(modelOnly.ok, false);
    assert.equal(modelOnly.error.code, 'settings/invalid');
  });

  test('reasoningEffort persists, validates and clears when the model switches', async () => {
    const saved = await plugin.dispatch('settingsSet', {
      patch: { aiClassify: true, provider: 'fake', model: 'fake-model', reasoningEffort: 'high' },
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.value.reasoningEffort, 'high');
    assert.equal((await plugin.dispatch('settingsGet', {})).value.reasoningEffort, 'high');

    // The level belongs to the exact model: switching without naming a new one clears it.
    const switched = await plugin.dispatch('settingsSet', { patch: { provider: 'fake', model: 'fake-model-pro' } });
    assert.equal(switched.ok, true);
    assert.equal(switched.value.reasoningEffort, undefined);

    const nonexistent = await plugin.dispatch('settingsSet', { patch: { reasoningEffort: 'nonexistent' } });
    assert.equal(nonexistent.ok, true, 'unknown ids are accepted and fall back later');
    const invalid = await plugin.dispatch('settingsSet', { patch: { reasoningEffort: 5 } });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'settings/invalid');

    const cleared = await plugin.dispatch('settingsSet', {
      patch: { aiClassify: false, provider: null, model: null, reasoningEffort: null },
    });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.value.reasoningEffort, undefined);
  });

  test('classification uses the explicit reasoning effort and falls back to off', async () => {
    await plugin.dispatch('settingsSet', {
      patch: { aiClassify: true, provider: null, model: null, reasoningEffort: 'high' },
    });
    try {
      const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
      assert.ok(status.entries.length > 0, 'expected a non-empty change set');
      const entries = status.entries.map((entry) => ({
        key: entry.key,
        status: entry.status,
        change: entry.change,
        path: entry.path,
        oldPath: entry.oldPath,
        additions: entry.additions,
        deletions: entry.deletions,
        kind: entry.kind,
        fingerprint: entry.fingerprint,
      }));
      llmReply = JSON.stringify({ categories: [{ name: 'all', ids: entries.map((entry) => entry.key) }] });
      llmRequest = null;
      const explicit = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-effort-high', force: true, entries });
      assert.equal(explicit.ok, true);
      assert.equal(llmRequest.reasoningEffort, 'high');

      // An unsupported id must not fail the call: the mechanical "off" fallback wins.
      await plugin.dispatch('settingsSet', { patch: { reasoningEffort: 'nonexistent' } });
      llmRequest = null;
      const fallback = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-effort-fallback', force: true, entries });
      assert.equal(fallback.ok, true);
      assert.equal(llmRequest.reasoningEffort, 'off');
    } finally {
      await plugin.dispatch('settingsSet', {
        patch: { aiClassify: false, provider: null, model: null, reasoningEffort: null },
      });
    }
  });

  test('idle pre-classification warms the classification cache', async () => {
    // Using the panel once (any protocol call with the session id) marks the
    // session as eligible for idle pre-classification.
    await plugin.dispatch('status', { sessionId: 'session-pre' });
    await plugin.dispatch('settingsSet', { patch: { aiClassify: true, preclassify: true, provider: null, model: null } });
    try {
      const status = (await plugin.dispatch('status', { sessionId: 'session-pre' })).value;
      assert.ok(status.entries.length > 0, 'expected a non-empty change set');
      const entries = status.entries.map((entry) => ({
        key: entry.key,
        status: entry.status,
        change: entry.change,
        path: entry.path,
        oldPath: entry.oldPath,
        additions: entry.additions,
        deletions: entry.deletions,
        kind: entry.kind,
        fingerprint: entry.fingerprint,
      }));
      llmReply = JSON.stringify({ categories: [{ name: '全部', ids: entries.map((entry) => entry.key) }] });
      llmCalls = 0;
      const warm = await plugin.preclassifySession('session-pre');
      assert.equal(warm.ok, true);
      assert.equal(warm.cached, false);
      assert.equal(llmCalls, 1, 'the idle pass should call the model exactly once');
      const hit = await plugin.dispatch('classify', { sessionId: 'session-pre', requestId: 'req-pre-hit', entries });
      assert.equal(hit.ok, true);
      assert.equal(hit.value.cached, true);
      assert.equal(llmCalls, 1, 'a warm cache must not call the model again');
    } finally {
      await plugin.dispatch('settingsSet', { patch: { preclassify: false, aiClassify: false } });
    }
  });

  test('idle pre-classification respects its opt-in and session gates', async () => {
    await plugin.dispatch('settingsSet', { patch: { aiClassify: true, preclassify: false } });
    const disabled = await plugin.preclassifySession('session-pre');
    assert.equal(disabled.skipped, 'disabled');
    await plugin.dispatch('settingsSet', { patch: { preclassify: true } });
    const unseen = await plugin.preclassifySession('never-opened');
    assert.equal(unseen.skipped, 'unseen-session');
    await plugin.dispatch('settingsSet', { patch: { preclassify: false, aiClassify: false } });
  });

  test('idle pre-classification swallows a repository read failure', async () => {
    // A separate repository whose index is corrupt: repository resolution still
    // works, but the status read fails. The background entry point must resolve
    // with a failure result instead of leaving a rejected promise behind.
    const { createHostPlugin } = await import('../src/host/index.js');
    const brokenDir = join(workspace, 'broken-repo');
    await mkdir(brokenDir, { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: brokenDir });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: brokenDir });
    await run('git', ['config', 'user.name', 'Test User'], { cwd: brokenDir });
    await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: brokenDir });
    await writeFile(join(brokenDir, 'a.txt'), 'a\n', 'utf8');
    await run('git', ['add', '-A'], { cwd: brokenDir });
    await run('git', ['commit', '-q', '-m', 'seed'], { cwd: brokenDir });
    const brokenPlugin = createHostPlugin(fakeCtx(brokenDir));
    await brokenPlugin.dispatch('status', { sessionId: 'session-broken' });
    await brokenPlugin.dispatch('settingsSet', { patch: { aiClassify: true, preclassify: true, provider: null, model: null } });
    try {
      await writeFile(join(brokenDir, '.git', 'index'), 'this is not a git index', 'utf8');
      const result = await brokenPlugin.preclassifySession('session-broken');
      assert.equal(result.ok, false, 'the failure is reported as a result, not a rejection');
      // The scheduled form has the same guarantee: nothing escapes the timer.
      brokenPlugin.schedulePreclassify('session-broken');
      brokenPlugin.cancelPreclassify('session-broken');
    } finally {
      await brokenPlugin.dispatch('settingsSet', { patch: { aiClassify: false, preclassify: false } });
      brokenPlugin.disposePreclassify();
    }
  });

  test('classify uses the persisted grouping mode and accepts an explicit override', async () => {
    await plugin.dispatch('settingsSet', { patch: { aiClassify: true, provider: null, model: null, aiGrouping: 'logic' } });
    try {
      const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
      assert.ok(status.entries.length > 0, 'expected a non-empty change set');
      const keys = status.entries.map((entry) => entry.key);
      const entries = keys.map((key) => ({ key }));
      llmReply = JSON.stringify({ categories: [{ name: '登录流程', description: '登录与鉴权', ids: keys }] });

      llmRequest = null;
      const logic = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-logic-mode', entries, force: true });
      assert.equal(logic.ok, true, JSON.stringify(logic.error));
      assert.equal(logic.value.grouping, 'logic');
      // The mode picked the logic prompt: it demands the NON_FUNCTIONAL sentinel
      // and groups by functional logic instead of by semantic role.
      assert.match(llmRequest.system, /NON_FUNCTIONAL/);
      assert.match(llmRequest.system, /功能逻辑/);
      assert.doesNotMatch(llmRequest.system, /语义角色/);

      // An explicit per-request mode wins over the persisted setting.
      llmReply = JSON.stringify({ categories: [{ name: '全部', ids: keys }] });
      const role = await plugin.dispatch('classify', {
        cwd: repoDir,
        requestId: 'req-explicit-role',
        entries,
        force: true,
        grouping: 'role',
      });
      assert.equal(role.ok, true, JSON.stringify(role.error));
      assert.equal(role.value.grouping, 'role');
      assert.match(llmRequest.system, /语义角色/);
      assert.doesNotMatch(llmRequest.system, /NON_FUNCTIONAL/);
      // The override is per request only; the persisted setting is untouched.
      assert.equal((await plugin.dispatch('settingsGet', {})).value.aiGrouping, 'logic');

      // Unknown modes are rejected before any model call.
      const callsBefore = llmCalls;
      for (const grouping of ['bogus', 3, true, {}]) {
        const invalid = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-invalid-mode', entries, grouping });
        assert.equal(invalid.ok, false, `accepted ${JSON.stringify(grouping)}`);
        assert.equal(invalid.error.code, 'ai/invalid');
        assert.equal(invalid.error.details.reason, 'invalid-grouping');
      }
      assert.equal(llmCalls, callsBefore, 'an invalid grouping mode must not reach the model');
    } finally {
      await plugin.dispatch('settingsSet', { patch: { aiClassify: false, provider: null, model: null, aiGrouping: 'role' } });
    }
  });

  test('logic mode maps the NON_FUNCTIONAL sentinel and keeps the fallback', async () => {
    await plugin.dispatch('settingsSet', { patch: { aiClassify: true, provider: null, model: null, aiGrouping: 'logic' } });
    try {
      // Keep this self-contained: the test needs a change set large enough for
      // one classified group, the sentinel category and an unclassified residue.
      for (const name of ['group-a.txt', 'group-b.txt', 'group-c.txt', 'group-d.txt', 'group-e.txt']) {
        await writeFile(join(repoDir, name), `${name}\n`, 'utf8');
      }
      const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
      const keys = status.entries.map((entry) => entry.key);
      assert.ok(keys.length >= 4, 'expected a change set with an unclassified residue');
      const entries = keys.map((key) => ({ key }));
      const functional = [keys[0]];
      const config = [keys[1]];
      llmReply = JSON.stringify({
        categories: [
          { name: '登录流程', description: '登录与鉴权', ids: functional },
          { name: 'NON_FUNCTIONAL', description: '无运行时行为变更', ids: config },
          { name: 'NON_FUNCTIONAL', ids: [keys[2]] },
        ],
      });
      const result = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-non-functional', entries, force: true });
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(result.value.grouping, 'logic');

      const sentinels = result.value.categories.filter((category) => category.name === 'NON_FUNCTIONAL');
      assert.equal(sentinels.length, 1, 'duplicate sentinel categories must merge');
      assert.equal(sentinels[0].kind, 'non-functional');
      assert.deepEqual(sentinels[0].ids, [...config, keys[2]]);
      assert.equal(sentinels[0].description, '无运行时行为变更');

      // Entries the model did not cover still go to 其他变更, not to the sentinel.
      const classified = new Set([...functional, ...config, keys[2]]);
      const remaining = keys.filter((key) => !classified.has(key));
      assert.ok(remaining.length > 0, 'the reply deliberately omits entries');
      const fallback = result.value.categories.find((category) => category.name === '其他变更');
      assert.ok(fallback, 'missing entries must fall back to 其他变更');
      assert.deepEqual(fallback.ids, remaining);
      assert.equal(fallback.kind, undefined);
      assert.equal(result.value.unassigned, remaining.length);
    } finally {
      await plugin.dispatch('settingsSet', { patch: { aiClassify: false, provider: null, model: null, aiGrouping: 'role' } });
    }
  });

  test('parseClassification keeps the two-argument role-mode behaviour', () => {
    const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const reply = JSON.stringify({ categories: [{ name: 'NON_FUNCTIONAL', ids: ['a'] }] });

    // Two arguments means the default role mode: NON_FUNCTIONAL has no kind and
    // the missing entries are appended to 其他变更 exactly as before.
    const role = parseClassification(reply, entries);
    assert.deepEqual(role.categories[0], { name: 'NON_FUNCTIONAL', ids: ['a'] });
    assert.equal(role.categories[1].name, '其他变更');
    assert.deepEqual(role.categories[1].ids, ['b', 'c']);

    const logic = parseClassification(reply, entries, { grouping: 'logic' });
    assert.equal(logic.categories[0].kind, 'non-functional');

    const merged = parseClassification(
      JSON.stringify({
        categories: [
          { name: 'NON_FUNCTIONAL', description: 'no runtime change', ids: ['a'] },
          { name: 'NON_FUNCTIONAL', ids: ['b'] },
        ],
      }),
      entries,
      { grouping: 'logic' },
    );
    const sentinels = merged.categories.filter((category) => category.name === 'NON_FUNCTIONAL');
    assert.equal(sentinels.length, 1);
    assert.deepEqual(sentinels[0].ids, ['a', 'b']);
    assert.equal(sentinels[0].kind, 'non-functional');
    assert.deepEqual(merged.categories.find((category) => category.name === '其他变更').ids, ['c']);
  });

  test('the classification cache is sensitive to the grouping mode', async () => {
    await plugin.dispatch('settingsSet', { patch: { aiClassify: true, provider: null, model: null, aiGrouping: 'role' } });
    try {
      const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
      const keys = status.entries.map((entry) => entry.key);
      const entries = keys.map((key) => ({ key }));
      llmReply = JSON.stringify({ categories: [{ name: '全部', ids: keys }] });

      llmCalls = 0;
      const role = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-cache-role', entries, force: true });
      assert.equal(role.ok, true, JSON.stringify(role.error));
      assert.equal(role.value.grouping, 'role');
      assert.equal(llmCalls, 1);
      const roleCached = await plugin.dispatch('classify', { cwd: repoDir, requestId: 'req-cache-role-2', entries });
      assert.equal(roleCached.ok, true);
      assert.equal(roleCached.value.cached, true);
      assert.equal(llmCalls, 1, 'the same mode must hit the cache');

      // A different mode means a different prompt, so it must call the model again.
      const logic = await plugin.dispatch('classify', {
        cwd: repoDir,
        requestId: 'req-cache-logic',
        entries,
        grouping: 'logic',
      });
      assert.equal(logic.ok, true, JSON.stringify(logic.error));
      assert.equal(logic.value.grouping, 'logic');
      assert.equal(logic.value.cached, false);
      assert.equal(llmCalls, 2);
      const logicCached = await plugin.dispatch('classify', {
        cwd: repoDir,
        requestId: 'req-cache-logic-2',
        entries,
        grouping: 'logic',
      });
      assert.equal(logicCached.value.cached, true);
      assert.equal(llmCalls, 2);

      // Changing the persisted mode clears the cache: the old role-mode entry is
      // gone even if a later request explicitly asks for role mode again.
      await plugin.dispatch('settingsSet', { patch: { aiGrouping: 'logic' } });
      const afterClear = await plugin.dispatch('classify', {
        cwd: repoDir,
        requestId: 'req-cache-clear',
        entries,
        grouping: 'role',
      });
      assert.equal(afterClear.ok, true, JSON.stringify(afterClear.error));
      assert.equal(afterClear.value.cached, false);
      assert.equal(llmCalls, 3);
    } finally {
      await plugin.dispatch('settingsSet', { patch: { aiClassify: false, provider: null, model: null, aiGrouping: 'role' } });
    }
  });

  test('idle pre-classification uses the persisted grouping mode', async () => {
    await plugin.dispatch('status', { sessionId: 'session-mode-pre' });
    await plugin.dispatch('settingsSet', {
      patch: { aiClassify: true, preclassify: true, provider: null, model: null, aiGrouping: 'logic' },
    });
    try {
      const status = (await plugin.dispatch('status', { sessionId: 'session-mode-pre' })).value;
      assert.ok(status.entries.length > 0, 'expected a non-empty change set');
      llmReply = JSON.stringify({ categories: [{ name: '全部', ids: status.entries.map((entry) => entry.key) }] });
      llmCalls = 0;
      llmRequest = null;
      const warm = await plugin.preclassifySession('session-mode-pre');
      assert.equal(warm.ok, true);
      assert.equal(warm.cached, false);
      assert.equal(llmCalls, 1);
      assert.match(llmRequest.system, /NON_FUNCTIONAL/);
      assert.match(llmRequest.system, /功能逻辑/);

      const hit = await plugin.dispatch('classify', { sessionId: 'session-mode-pre', requestId: 'req-pre-mode-hit' });
      assert.equal(hit.ok, true, JSON.stringify(hit.error));
      assert.equal(hit.value.cached, true);
      assert.equal(hit.value.grouping, 'logic');
      assert.equal(llmCalls, 1, 'the warm pre-classification cache must be reused');
    } finally {
      await plugin.dispatch('settingsSet', {
        patch: { preclassify: false, aiClassify: false, provider: null, model: null, aiGrouping: 'role' },
      });
    }
  });
});

describe('commit message draft', () => {
  test('needs staged content and never calls the model otherwise', async () => {
    await git(['reset', '-q']);
    const status = (await plugin.dispatch('status', { cwd: repoDir })).value;
    assert.equal(status.summary.staged, 0, 'expected an empty index for this case');
    const callsBefore = llmCalls;
    const rejected = await plugin.dispatch('commitMessage', { cwd: repoDir, requestId: 'msg-empty' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'message/no-staged');
    assert.equal(llmCalls, callsBefore, 'no model call without staged content');
  });

  test('drafts from the staged patch and the repository history only', async () => {
    await git(['reset', '-q']);
    const unstagedMarker = `unstaged-marker-${Date.now()}`;
    const before = (await plugin.dispatch('status', { cwd: repoDir })).value;
    const headBefore = before.repo.headSha;
    await writeFile(join(repoDir, 'app.js'), 'const value = "draft marker";\nconsole.log(value);\n', 'utf8');
    await git(['add', '--', 'app.js']);
    await writeFile(join(repoDir, 'README.md'), `# demo\n\n${unstagedMarker}\n`, 'utf8');
    try {
      llmReply = '```\nfeat(review): 根据暂存改动生成提交信息\n\n- 新增 AI 草稿按钮\n- 沿用仓库历史格式\n```';
      llmRequest = null;
      const result = await plugin.dispatch('commitMessage', { cwd: repoDir, requestId: 'msg-ok' });
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(result.value.message, 'feat(review): 根据暂存改动生成提交信息\n\n- 新增 AI 草稿按钮\n- 沿用仓库历史格式');
      assert.equal(result.value.model, 'fake/fake-model');
      assert.equal(result.value.requestId, 'msg-ok');
      assert.ok(result.value.history >= 1, 'recent commits are used as the style reference');
      assert.equal(result.value.repo.root, before.repo.root);

      // The model input is the staged patch + bounded history; worktree-only
      // content and the full repository are never sent.
      const payload = lastPrompt();
      assert.ok(payload.staged.files.some((file) => file.path === 'app.js'));
      assert.match(payload.diff.text, /\+const value = "draft marker"/);
      assert.equal(payload.diff.text.includes(unstagedMarker), false, 'unstaged worktree content must not be sent');
      assert.ok(payload.history.count >= 1);
      assert.ok(payload.history.commits.every((commit) => typeof commit.subject === 'string' && commit.subject.length > 0));
      // The fixture history is English, so the prompt must ask for English even
      // though the prompt itself is Chinese.
      assert.equal(payload.history.language, 'en');
      assert.match(llmRequest.system, /提交信息/);
      assert.match(llmRequest.system, /history\.language/);
      assert.match(llmRequest.system, /必须全部用英文/);
      assert.equal(llmRequest.reasoningEffort, 'off');

      // Read-only: the index and HEAD are untouched.
      const after = (await plugin.dispatch('status', { cwd: repoDir })).value;
      assert.equal(after.summary.staged, 1);
      assert.equal(after.repo.headSha, headBefore);
    } finally {
      await git(['reset', '-q']);
    }
  });

  test('reports unusable replies and model failures with message/* codes', async () => {
    await git(['reset', '-q']);
    await writeFile(join(repoDir, 'app.js'), 'const value = "failure case";\nconsole.log(value);\n', 'utf8');
    await git(['add', '--', 'app.js']);
    try {
      llmReply = '';
      llmFinish = null;
      const empty = await plugin.dispatch('commitMessage', { cwd: repoDir, requestId: 'msg-empty-reply' });
      assert.equal(empty.ok, false);
      assert.equal(empty.error.code, 'message/invalid');
      assert.equal(empty.error.details.reason, 'empty-reply');

      llmReply = 'feat: cut';
      llmFinish = 'max-tokens';
      const cut = await plugin.dispatch('commitMessage', { cwd: repoDir, requestId: 'msg-max-tokens' });
      assert.equal(cut.ok, false);
      assert.equal(cut.error.code, 'message/invalid');
      assert.equal(cut.error.details.reason, 'max-tokens');

      llmFinish = null;
      llmThrow = { mode: 'async', error: Object.assign(new Error('boom at C:\\secret\\path'), { code: 'RATE_LIMIT' }) };
      const failed = await plugin.dispatch('commitMessage', { cwd: repoDir, requestId: 'msg-unavailable' });
      assert.equal(failed.ok, false);
      assert.equal(failed.error.code, 'message/unavailable');
      assert.equal(failed.error.details.reason, 'RATE_LIMIT');
      assert.equal(failed.error.message.includes('boom'), false, 'raw error text must not leak');
    } finally {
      llmReply = null;
      llmFinish = null;
      llmThrow = null;
      await git(['reset', '-q']);
    }
  });

  test('cancellation is scoped to an in-flight request id', async () => {
    const missing = await plugin.dispatch('commitMessageCancel', { requestId: 'not-in-flight' });
    assert.equal(missing.ok, true);
    assert.deepEqual(missing.value, { cancelled: false });
  });

  test('parseCommitMessage unwraps replies into plain commit text', () => {
    assert.equal(parseCommitMessage('```\nfeat: x\n\n- a\n```'), 'feat: x\n\n- a');
    assert.equal(parseCommitMessage('提交信息：\r\nfix: y\r\n\r\n\r\n- b\r\n'), 'fix: y\n\n- b');
    assert.equal(parseCommitMessage('  plain subject  \n'), 'plain subject');
    assert.throws(
      () => parseCommitMessage(''),
      (error) => error.code === 'message/invalid' && error.details.reason === 'empty-reply',
    );
    assert.throws(
      () => parseCommitMessage('```\n```'),
      (error) => error.code === 'message/invalid' && error.details.reason === 'not-message',
    );
  });

  test('buildCommitMessagePayload describes history style and marks a clipped patch', () => {
    const payload = buildCommitMessagePayload({
      project: { name: 'demo', topLevel: ['src'], manifests: ['package.json'] },
      entries: [{ path: 'a.js', change: 'modified', additions: 2, deletions: 1 }],
      patch: 'x'.repeat(30_000),
      history: [{ subject: 'feat(a): 一' }, { subject: 'fix: 二' }, { subject: '支持中文标题' }],
    });
    assert.equal(payload.staged.count, 1);
    assert.deepEqual(payload.staged.files[0], { path: 'a.js', change: 'modified', added: 2, removed: 1 });
    assert.equal(payload.diff.truncated, true);
    assert.match(payload.diff.text, /patch 已截断/);
    assert.equal(payload.history.count, 3);
    assert.equal(payload.history.conventional, true);
    assert.equal(payload.history.language, 'zh', 'the history subjects are Chinese');
    assert.ok(payload.history.commits.every((commit) => typeof commit.subject === 'string'));

    const empty = buildCommitMessagePayload({ patch: '', history: [] });
    assert.equal(empty.diff.truncated, false);
    assert.equal(empty.history.count, 0);
    assert.equal(empty.history.conventional, false);
    assert.equal(empty.history.language, 'unknown', 'no history leaves the language to the patch / project hints');
    // The language hint is deterministic, so the Chinese prompt cannot decide
    // the reply language: recent subjects are the signal, and a body in another
    // script never flips an English subject.
    const english = buildCommitMessagePayload({ history: [{ subject: 'feat: add upload' }, { subject: 'fix(api): guard timeout' }] });
    assert.equal(english.history.language, 'en');
    const mixed = buildCommitMessagePayload({ history: [{ subject: 'feat: add upload' }, { subject: '修复：上传' }] });
    assert.equal(mixed.history.language, 'mixed');
    const bodyOnly = buildCommitMessagePayload({ history: [{ subject: 'fix: guard timeout', body: '原因：超时' }] });
    assert.equal(bodyOnly.history.language, 'en', 'a body in another script must not flip an English subject');
    // A git-layer truncation is preserved even for a short patch.
    const clipped = buildCommitMessagePayload({ patch: 'diff --git a/x b/x', patchTruncated: true });
    assert.equal(clipped.diff.truncated, true);
    assert.match(clipped.diff.text, /patch 已截断/);
  });
});

describe('non-repository workspace', () => {
  test('reports no-git instead of failing', async () => {
    const elsewhere = await mkdtemp(join(workspace, 'plain-'));
    const result = await plugin.dispatch('status', { cwd: elsewhere });
    assert.equal(result.ok, true);
    assert.equal(result.value.state, 'no-git');
    assert.equal(result.value.repo, null);
    assert.equal(result.value.entries.length, 0);
  });
});

// Integration tests for the dsh-code-review git engine.
//
// All repositories are throwaway fixtures under <plugin>/.tmp-test; git is only
// ever run against those. `node --test test/git-core.test.mjs` runs this file.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createFixture,
  newGit,
  newRecordingGit,
  expectGitError,
  entryOf,
  keysOf,
  cleanupTmpRoot,
  removeTree,
  runGit,
  makeTempDir,
  createNodeExecutor,
  createGit,
  GitError,
} from './helpers/repo.mjs';
import {
  CAPS,
  parseStatusV2,
  computeIndexFingerprint,
  fingerprintEquals,
} from '../src/host/git.js';
import {
  quotePath,
  makeNewFilePatch,
  parsePatch,
  buildSingleHunkPatch,
  findMatchingHunk,
  sha256,
  countTextLines,
  looksBinary,
  MAX_SIDE_BYTES,
  MAX_SIDE_LINES,
} from '../src/host/patch.js';

after(cleanupTmpRoot);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function committedFixture(t, name, files, { branch = 'main' } = {}) {
  const f = createFixture(t, name);
  f.init({ branch });
  for (const [relPath, content] of Object.entries(files)) f.write(relPath, content);
  f.addAll();
  f.commit('initial commit');
  const git = newGit();
  const repo = await git.resolveRepo(f.dir);
  return { f, git, repo };
}

function textLines(count, prefix = 'line') {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}\n`).join('');
}

/** Replace one 1-based line in a text file, keeping everything else byte-identical. */
function withEditedLine(text, lineNumber, replacement) {
  const lines = text.split('\n');
  lines[lineNumber - 1] = replacement;
  return lines.join('\n');
}

async function freshStatus(git, repo) {
  return git.status(repo);
}

async function refreshRepo(git, repo) {
  return git.resolveRepo(repo.root);
}

/** Fingerprints of the given keys, in the `stage`/`unstage` expected-map shape. */
function expectedFor(status, keys) {
  const wanted = new Set(keys);
  const expected = {};
  for (const entry of status.entries) if (wanted.has(entry.key)) expected[entry.key] = entry.fingerprint;
  return expected;
}

/** Expected map for a `"all"` stage: everything stage-all would move. */
function expectedStageAll(status, includeUntracked = true) {
  const expected = {};
  for (const entry of status.entries) {
    if (entry.status === 'unstaged' || (includeUntracked && entry.status === 'untracked')) {
      expected[entry.key] = entry.fingerprint;
    }
  }
  return expected;
}

/** Expected map for a `"all"` unstage: every staged entry. */
function expectedUnstageAll(status) {
  const expected = {};
  for (const entry of status.entries) if (entry.status === 'staged') expected[entry.key] = entry.fingerprint;
  return expected;
}

/** Canonical full-index fingerprint straight from `git ls-files -s -z`. */
function indexFingerprintOf(fixture) {
  return computeIndexFingerprint(fixture.git(['ls-files', '-s', '-z']).stdout);
}

// ---------------------------------------------------------------------------
// executor plumbing
// ---------------------------------------------------------------------------

test('createNodeExecutor: argv arrays, stdin input, exit codes and spawn failures', async (t) => {
  const f = createFixture(t, 'executor');
  f.init();
  const exec = createNodeExecutor();

  const version = await exec.run(['git', '--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout.toString('utf8'), /^git version \d+\.\d+/);
  assert.ok(Buffer.isBuffer(version.stderr));

  // Non-zero exits are resolved, never rejected.
  const missing = await exec.run(['git', 'rev-parse', '--verify', 'no-such-ref'], { cwd: f.dir });
  assert.notEqual(missing.code, 0);
  assert.equal(typeof missing.stdout.length, 'number');

  // stdin is written then closed, byte-exactly.
  const hashed = await exec.run(['git', 'hash-object', '--stdin'], { cwd: f.dir, input: 'hello\n' });
  assert.equal(hashed.code, 0);
  assert.equal(hashed.stdout.toString('utf8').trim(), 'ce013625030ba8dba906f756967f9e9ca394464a');

  // Binary stdin is preserved.
  const binary = Buffer.from([0, 1, 2, 3, 255]);
  const hashedBinary = await exec.run(['git', 'hash-object', '--stdin'], { cwd: f.dir, input: binary });
  assert.equal(hashedBinary.code, 0);

  // A real spawn failure rejects (the only rejection case).
  const broken = createNodeExecutor({ gitPath: 'definitely-not-a-git-binary-xyz' });
  await assert.rejects(broken.run(['git', '--version']), /ENOENT|not found|spawn/i);

  // argv[0] is the command name; shell metacharacters stay one argument.
  const argvEcho = await exec.run(['git', 'hash-object', '--stdin'], {
    cwd: f.dir,
    input: '$(echo hi) `echo hi` ; & | > <',
  });
  assert.equal(argvEcho.code, 0);
});

test('createNodeExecutor: logger is optional and receives invocations', async () => {
  const lines = [];
  const exec = createNodeExecutor({ logger: { debug: (line) => lines.push(line) } });
  const result = await exec.run(['git', '--version']);
  assert.equal(result.code, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^git --version$/);
});

// ---------------------------------------------------------------------------
// repository without a first commit
// ---------------------------------------------------------------------------

test('no-first-commit repo: resolve, status, diff, stage, unstage, partial stage, first commit', async (t) => {
  const f = createFixture(t, 'nohead');
  f.init();
  f.write('f.txt', 'a\nb\nc\n');
  f.write('empty.txt', '');
  f.write('nested/dir/file.md', '# hi\n');
  const git = newGit();

  const repo = await git.resolveRepo(f.dir);
  assert.equal(repo.headSha, null);
  assert.equal(repo.branch, 'main');
  assert.equal(repo.detached, false);
  assert.equal(repo.worktree, false);
  assert.ok(path.isAbsolute(repo.root));
  assert.ok(fs.existsSync(repo.root));
  assert.ok(fs.existsSync(repo.gitDir));

  const status = await git.status(repo);
  assert.equal(status.state, 'ok');
  assert.deepEqual(keysOf(status).sort(), ['untracked:empty.txt', 'untracked:f.txt', 'untracked:nested/dir/file.md']);
  assert.equal(status.summary.untracked, 3);
  assert.equal(status.summary.staged, 0);
  assert.equal(status.stagedFingerprint, '');
  const emptyEntry = entryOf(status, 'untracked:empty.txt');
  assert.equal(emptyEntry.kind, 'empty');
  assert.equal(emptyEntry.additions, 0);
  assert.equal(emptyEntry.fingerprint.base, 'empty');
  assert.match(emptyEntry.fingerprint.target, /^[0-9a-f]{64}$/);

  // untracked diff: empty -> worktree text
  const diff = await git.diff(repo, 'untracked:f.txt', { status });
  assert.equal(diff.base.exists, false);
  assert.equal(diff.base.label, 'Empty');
  assert.equal(diff.base.ref, 'empty');
  assert.equal(diff.target.label, 'Untracked');
  assert.equal(diff.target.ref, 'worktree:f.txt');
  assert.equal(diff.target.text, 'a\nb\nc\n');
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.hunks[0].header, '@@ -0,0 +1,3 @@');
  assert.equal(diff.hunks[0].patch, 'diff --git "a/f.txt" "b/f.txt"\nnew file mode 100644\n--- /dev/null\n+++ "b/f.txt"\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n');
  assert.deepEqual(diff.stats, { additions: 3, deletions: 0 });
  assert.equal(diff.unsupported, null);
  assert.deepEqual(diff.entry.fingerprint, entryOf(status, 'untracked:f.txt').fingerprint);

  // explicit untracked stage keeps the worktree bytes
  const before = f.read('f.txt');
  await git.stage(repo, { keys: ['untracked:f.txt'], includeUntracked: false, expected: expectedFor(status, ['untracked:f.txt']), status });
  let staged = await freshStatus(git, repo);
  assert.equal(entryOf(staged, 'staged:f.txt').change, 'added');
  assert.equal(f.read('f.txt').equals(before), true);
  assert.match(staged.stagedFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(staged.stagedFingerprint, indexFingerprintOf(f), 'the fingerprint covers the whole index');

  // unstage returns the file to untracked, worktree untouched
  await git.unstage(repo, { keys: ['staged:f.txt'], expected: expectedFor(staged, ['staged:f.txt']), status: staged });
  staged = await freshStatus(git, repo);
  assert.equal(entryOf(staged, 'untracked:f.txt').kind, 'text');
  assert.equal(f.read('f.txt').equals(before), true);
  assert.equal(staged.stagedFingerprint, '');

  // unstage('all') without a first commit empties the index without throwing
  await git.stage(repo, { keys: 'all', includeUntracked: true, expected: expectedStageAll(staged), status: staged });
  let allStaged = await freshStatus(git, repo);
  assert.equal(allStaged.summary.staged, 3);
  await git.unstage(repo, { keys: 'all', expected: expectedUnstageAll(allStaged), status: allStaged });
  allStaged = await freshStatus(git, repo);
  assert.equal(allStaged.summary.staged, 0);
  assert.equal(allStaged.summary.untracked, 3);
  assert.equal(f.git(['ls-files']).out.trim(), '');
  assert.equal(f.read('f.txt').equals(before), true);

  // partial stage without a first commit: stage a file, edit it further, stage one hunk
  f.write('partial.txt', textLines(20));
  f.addAll();
  f.write('partial.txt', withEditedLine(withEditedLine(textLines(20), 2, 'EDIT-two'), 18, 'EDIT-eighteen'));
  let partial = await freshStatus(git, repo);
  const partialStaged = entryOf(partial, 'staged:partial.txt');
  const partialUnstaged = entryOf(partial, 'unstaged:partial.txt');
  assert.equal(partialStaged.hasBothSides, true);
  assert.equal(partialUnstaged.hasBothSides, true);
  assert.equal(partialUnstaged.additions, 2);
  assert.equal(partialStaged.additions, 20);
  const unstagedDiff = await git.diff(repo, 'unstaged:partial.txt', { status: partial });
  assert.equal(unstagedDiff.hunks.length, 2);
  const worktreeBefore = f.read('partial.txt');
  await git.stageHunk(repo, {
    key: 'unstaged:partial.txt',
    hunkIndex: 1,
    expected: partialUnstaged.fingerprint,
    status: partial,
  });
  assert.equal(f.read('partial.txt').equals(worktreeBefore), true, 'staging a hunk must not touch the worktree');
  const afterHunk = await freshStatus(git, repo);
  assert.equal(afterHunk.entries.filter((entry) => entry.status === 'unstaged').length, 1);
  const remaining = afterHunk.entries.find((entry) => entry.status === 'unstaged');
  assert.match((await git.diff(repo, remaining.key, { status: afterHunk })).hunks[0].header, /^@@ -1,\d+ \+1,\d+ @@/);

  // stage everything else and create the first commit
  const toCommit = await freshStatus(git, repo);
  const commitStatus = toCommit;
  const result = await git.commit(repo, {
    message: 'first commit',
    expected: { headSha: commitStatus.repo.headSha, stagedFingerprint: commitStatus.stagedFingerprint },
    status: commitStatus,
  });
  assert.match(result.headSha, /^[0-9a-f]{40}$/);
  assert.equal(result.shortSha.length >= 7, true);
  assert.equal(result.summary, 'first commit');
  assert.equal(result.status.entries.length, 1, 'the un-staged hunk stays in the worktree after the first commit');
  assert.equal(entryOf(result.status, 'unstaged:partial.txt').status, 'unstaged');
  assert.equal(entryOf(result.status, 'unstaged:partial.txt').additions, 1);
  assert.equal(result.status.repo.headSha, result.headSha);
  assert.equal(result.status.stagedFingerprint, indexFingerprintOf(f));
  const repoAfter = await git.resolveRepo(f.dir);
  assert.equal(repoAfter.headSha, result.headSha);
  assert.equal(f.git(['log', '--format=%s', '-1']).out.trim(), 'first commit');
  assert.deepEqual(f.read('partial.txt').toString('utf8'), withEditedLine(withEditedLine(textLines(20), 2, 'EDIT-two'), 18, 'EDIT-eighteen'));
});

test('resolveRepo: repo/no-git and repo/not-found', async (t) => {
  const git = newGit();
  // This one must live OUTSIDE the plugin checkout: the fixture root is inside
  // this repository, so a "plain" directory there would still resolve to it.
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-code-review-not-a-repo-'));
  t.after(() => removeTree(plainDir));
  const noGit = await expectGitError(git.resolveRepo(plainDir), 'repo/no-git');
  assert.match(noGit.details.stderr, /not a git repository/i);
  await expectGitError(git.resolveRepo(path.join(plainDir, 'missing-dir')), 'repo/not-found');

  const status = await git.status(plainDir);
  assert.equal(status.repo, null);
  assert.equal(status.state, 'no-git');
  assert.equal(status.error.code, 'repo/no-git');
  assert.deepEqual(status.entries, []);
});

test('init creates a repository without touching working-tree files', async (t) => {
  const git = newGit();
  // Outside the plugin checkout: a directory inside it would resolve to this
  // repository instead of being a plain directory. os.tmpdir() is an 8.3 short
  // path on Windows CI (RUNNER~1) while git reports the canonical long path, so
  // pin the canonical form before comparing roots.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-code-review-init-')));
  t.after(() => removeTree(dir));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'keep me\n');
  await expectGitError(git.resolveRepo(dir), 'repo/no-git');

  const repo = await git.init(dir);
  assert.equal(path.resolve(repo.root), path.resolve(dir));
  assert.ok(repo.branch, 'the new repository reports its branch');
  const status = await git.status(repo);
  assert.equal(entryOf(status, 'untracked:note.txt').status, 'untracked');
  assert.equal(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8'), 'keep me\n');
  // Only .git is created: no README / LICENSE / .gitignore is invented.
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.git', 'note.txt']);
});

// ---------------------------------------------------------------------------
// staged vs unstaged separation
// ---------------------------------------------------------------------------

test('staged vs unstaged separation with line counts split by scope', async (t) => {
  const base = textLines(20);
  const { f, git, repo } = await committedFixture(t, 'separation', { 'f.txt': base });
  f.write('f.txt', withEditedLine(base, 2, 'STAGED-two'));
  f.git(['add', '--', 'f.txt']);
  f.write('f.txt', withEditedLine(f.readText('f.txt'), 18, 'UNSTAGED-eighteen'));

  const status = await freshStatus(git, repo);
  assert.deepEqual(keysOf(status).sort(), ['staged:f.txt', 'unstaged:f.txt']);
  const stagedEntry = entryOf(status, 'staged:f.txt');
  const unstagedEntry = entryOf(status, 'unstaged:f.txt');
  assert.equal(stagedEntry.hasBothSides, true);
  assert.equal(unstagedEntry.hasBothSides, true);
  assert.equal(stagedEntry.change, 'modified');
  assert.equal(unstagedEntry.change, 'modified');
  assert.equal(stagedEntry.additions, 1);
  assert.equal(stagedEntry.deletions, 1);
  assert.equal(unstagedEntry.additions, 1);
  assert.equal(unstagedEntry.deletions, 1);
  assert.equal(status.summary.files, 1, 'one path deduplicated across statuses');
  assert.equal(status.summary.entries, 2);
  assert.equal(status.summary.staged, 1);
  assert.equal(status.summary.unstaged, 1);
  assert.equal(status.summary.stagedAdditions, 1);
  assert.equal(status.summary.stagedDeletions, 1);
  assert.equal(status.summary.unstagedAdditions, 1);
  assert.equal(status.summary.unstagedDeletions, 1);

  // fingerprints of the two scopes differ (different base/target pairs)
  assert.notDeepEqual(stagedEntry.fingerprint, unstagedEntry.fingerprint);

  const stagedDiff = await git.diff(repo, 'staged:f.txt', { status });
  assert.equal(stagedDiff.comparison.baseLabel, 'HEAD');
  assert.equal(stagedDiff.comparison.targetLabel, 'Index');
  assert.equal(stagedDiff.comparison.baseRef, 'HEAD:f.txt');
  assert.equal(stagedDiff.comparison.targetRef, ':0:f.txt');
  assert.deepEqual(stagedDiff.stats, { additions: 1, deletions: 1 });

  const unstagedDiff = await git.diff(repo, 'unstaged:f.txt', { status });
  assert.equal(unstagedDiff.comparison.baseLabel, 'Index');
  assert.equal(unstagedDiff.comparison.targetLabel, 'Worktree');
  assert.equal(unstagedDiff.base.ref, ':0:f.txt');
  assert.equal(unstagedDiff.target.ref, 'worktree:f.txt');
  assert.equal(unstagedDiff.comparison.targetRef, 'worktree:f.txt');

  // fingerprint is sensitive to a one-byte change
  const oldFp = unstagedEntry.fingerprint;
  f.write('f.txt', withEditedLine(f.readText('f.txt'), 18, 'UNSTAGED-eighteen-later2'));
  const changed = await freshStatus(git, repo);
  assert.notEqual(entryOf(changed, 'unstaged:f.txt').fingerprint.target, oldFp.target);
});

// ---------------------------------------------------------------------------
// whole-file stage / unstage / discard
// ---------------------------------------------------------------------------

test('whole-file stage / unstage / discard keep the other side intact', async (t) => {
  const base = textLines(10);
  const { f, git, repo } = await committedFixture(t, 'wholefile', { 'f.txt': base });

  // stage: worktree untouched, index follows the worktree
  const editA = withEditedLine(base, 2, 'EDIT-two');
  f.write('f.txt', editA);
  let status = await freshStatus(git, repo);
  await git.stage(repo, { keys: ['unstaged:f.txt'], expected: expectedFor(status, ['unstaged:f.txt']), status });
  assert.equal(f.readText('f.txt'), editA);
  assert.equal(f.indexBytes('f.txt').toString('utf8'), editA);
  status = await freshStatus(git, repo);
  assert.deepEqual(keysOf(status), ['staged:f.txt']);

  // unstage: worktree untouched, index back to HEAD
  await git.unstage(repo, { keys: ['staged:f.txt'], expected: expectedFor(status, ['staged:f.txt']), status });
  assert.equal(f.readText('f.txt'), editA);
  assert.deepEqual(f.indexBytes('f.txt'), f.headBytes('f.txt'));
  status = await freshStatus(git, repo);
  assert.deepEqual(keysOf(status), ['unstaged:f.txt']);

  // discard: worktree goes back to the index, staged content is kept
  f.git(['add', '--', 'f.txt']); // index = editA
  const editB = withEditedLine(editA, 7, 'EDIT-seven-unstaged');
  f.write('f.txt', editB);
  status = await freshStatus(git, repo);
  assert.deepEqual(keysOf(status).sort(), ['staged:f.txt', 'unstaged:f.txt']);
  const unstagedEntry = entryOf(status, 'unstaged:f.txt');
  const indexBeforeDiscard = f.indexBytes('f.txt');
  await git.discard(repo, { key: 'unstaged:f.txt', expected: unstagedEntry.fingerprint, status });
  assert.equal(f.readText('f.txt'), editA, 'discard restores the index content into the worktree');
  assert.deepEqual(f.indexBytes('f.txt'), indexBeforeDiscard, 'discard never touches the index');
  status = await freshStatus(git, repo);
  assert.deepEqual(keysOf(status), ['staged:f.txt']);

  // discard of a staged / untracked / conflict entry is refused (no index baseline)
  await expectGitError(
    git.discard(repo, { key: 'staged:f.txt', expected: entryOf(status, 'staged:f.txt').fingerprint, status }),
    'entry/unsupported',
  );
  f.write('untracked.txt', 'u\n');
  status = await freshStatus(git, repo);
  await expectGitError(
    git.discard(repo, { key: 'untracked:untracked.txt', expected: entryOf(status, 'untracked:untracked.txt').fingerprint, status }),
    'entry/unsupported',
  );
  assert.equal(f.exists('untracked.txt'), true, 'refused discard must not delete untracked files');

  // discard with a stale fingerprint: nothing changes
  f.write('f.txt', withEditedLine(editA, 9, 'EDIT-nine'));
  status = await freshStatus(git, repo);
  const staleExpected = { base: entryOf(status, 'unstaged:f.txt').fingerprint.base, target: 'f'.repeat(64) };
  const bytesBefore = f.read('f.txt');
  await expectGitError(
    git.discard(repo, { key: 'unstaged:f.txt', expected: staleExpected, status }),
    'entry/stale',
  );
  assert.deepEqual(f.read('f.txt'), bytesBefore);
});

test('stage("all") skips conflicted paths and reports them in details.skipped', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'stageall', { 'a.txt': 'a1\n', 'b.txt': 'b1\n' });
  // make a conflict on a.txt
  f.git(['checkout', '-q', '-b', 'side']);
  f.write('a.txt', 'side\n');
  f.addAll();
  f.commit('side');
  f.git(['checkout', '-q', 'main']);
  f.write('a.txt', 'main\n');
  f.addAll();
  f.commit('main edit');
  const merge = runGit(f.dir, ['merge', 'side']);
  assert.notEqual(merge.code, 0, 'merge must conflict');
  f.write('b.txt', 'b2\n');
  f.write('untracked.txt', 'u\n');
  const status = await freshStatus(git, repo);
  assert.equal(status.summary.conflicts, 1);

  const result = await git.stage(repo, { keys: 'all', includeUntracked: true, expected: expectedStageAll(status), status });
  const after = await freshStatus(git, repo);
  assert.deepEqual(result.skipped, ['conflict:a.txt']);
  assert.ok(result.affected.includes('b.txt'));
  assert.ok(result.affected.includes('untracked.txt'));
  assert.equal(entryOf(after, 'conflict:a.txt').status, 'conflict', 'conflict must stay unresolved');
  assert.deepEqual(keysOf(after).filter((key) => key.startsWith('conflict:')), ['conflict:a.txt']);
  // stage('all') without includeUntracked leaves untracked alone; conflicts stay skipped
  const result2 = await git.stage(repo, { keys: 'all', expected: expectedStageAll(after, false), status: after });
  assert.deepEqual(result2.affected, []);
  assert.deepEqual(result2.skipped, ['conflict:a.txt']);
});

// ---------------------------------------------------------------------------
// hunk operations preserve every untouched byte
// ---------------------------------------------------------------------------

test('hunk stage/unstage/discard preserve the other edits and the other side byte-exactly', async (t) => {
  const base = textLines(30, 'L');
  const { f, git, repo } = await committedFixture(t, 'hunks', { 'f.txt': base });

  // --- stageHunk: worktree has two hunks; stage only the second one ---------
  const twoEdits = withEditedLine(withEditedLine(base, 2, 'EDIT2'), 28, 'EDIT28');
  f.write('f.txt', twoEdits);
  const worktreeBefore = f.read('f.txt');
  let status = await freshStatus(git, repo);
  const diff = await git.diff(repo, 'unstaged:f.txt', { status });
  assert.equal(diff.hunks.length, 2);
  assert.equal(diff.hunks[1].lines.some((line) => line.kind === '+' && line.text === 'EDIT28'), true);

  await git.stageHunk(repo, {
    key: 'unstaged:f.txt',
    hunkIndex: 1,
    expected: entryOf(status, 'unstaged:f.txt').fingerprint,
    status,
  });
  assert.deepEqual(f.read('f.txt'), worktreeBefore, 'stageHunk must not modify the worktree');
  let after = await freshStatus(git, repo);
  assert.deepEqual(f.indexBytes('f.txt').toString('utf8'), withEditedLine(base, 28, 'EDIT28'), 'only the selected hunk reaches the index');
  assert.deepEqual(keysOf(after).sort(), ['staged:f.txt', 'unstaged:f.txt']);
  const stagedDiff = await git.diff(repo, 'staged:f.txt', { status: after });
  assert.equal(stagedDiff.hunks.length, 1);
  assert.match(stagedDiff.hunks[0].header, /^@@ -2[4-6],\d+ \+2[4-6],\d+ @@/);
  const unstagedDiff = await git.diff(repo, 'unstaged:f.txt', { status: after });
  assert.equal(unstagedDiff.hunks.length, 1);
  assert.match(unstagedDiff.hunks[0].header, /^@@ -1,\d+ \+1,\d+ @@/);
  assert.deepEqual(unstagedDiff.target.text, twoEdits);

  // --- unstageHunk: reverse the staged hunk only -----------------------------
  const stagedFp = entryOf(after, 'staged:f.txt').fingerprint;
  await git.unstageHunk(repo, { key: 'staged:f.txt', hunkIndex: 0, expected: stagedFp, status: after });
  assert.deepEqual(f.read('f.txt'), worktreeBefore, 'unstageHunk must not modify the worktree');
  after = await freshStatus(git, repo);
  assert.deepEqual(f.indexBytes('f.txt'), f.headBytes('f.txt'), 'the index is back to HEAD');
  assert.deepEqual(keysOf(after), ['unstaged:f.txt']);
  assert.equal((await git.diff(repo, 'unstaged:f.txt', { status: after })).hunks.length, 2);

  // --- discardHunk: reverse one worktree hunk only ---------------------------
  status = after;
  const indexBefore = f.indexBytes('f.txt');
  await git.discardHunk(repo, {
    key: 'unstaged:f.txt',
    hunkIndex: 1,
    expected: entryOf(status, 'unstaged:f.txt').fingerprint,
    status,
  });
  assert.deepEqual(f.indexBytes('f.txt'), indexBefore, 'discardHunk must not modify the index');
  assert.equal(f.readText('f.txt'), withEditedLine(base, 2, 'EDIT2'), 'only the addressed hunk is discarded');
  const left = await freshStatus(git, repo);
  assert.equal((await git.diff(repo, 'unstaged:f.txt', { status: left })).hunks.length, 1);

  // --- hunk index out of range -> patch/mismatch, no write -------------------
  const beforeMismatch = f.read('f.txt');
  await expectGitError(
    git.discardHunk(repo, { key: 'unstaged:f.txt', hunkIndex: 5, expected: entryOf(left, 'unstaged:f.txt').fingerprint, status: left }),
    'patch/mismatch',
  );
  assert.deepEqual(f.read('f.txt'), beforeMismatch);
});

test('hunk stale fingerprint -> entry/stale, nothing written', async (t) => {
  const base = textLines(20);
  const { f, git, repo } = await committedFixture(t, 'hunkstale', { 'f.txt': base });
  f.write('f.txt', withEditedLine(base, 2, 'EDIT2'));
  const status = await freshStatus(git, repo);
  const entry = entryOf(status, 'unstaged:f.txt');
  const bytesBefore = f.read('f.txt');

  // The file changes after the status snapshot the client based its fingerprint on.
  f.write('f.txt', withEditedLine(base, 2, 'EDIT2-changed'));
  await expectGitError(
    git.stageHunk(repo, { key: 'unstaged:f.txt', hunkIndex: 0, expected: entry.fingerprint, status }),
    'entry/stale',
  );
  assert.equal(f.readText('f.txt'), withEditedLine(base, 2, 'EDIT2-changed'));
  assert.deepEqual(f.indexBytes('f.txt'), f.headBytes('f.txt'), 'no-index write on stale input');

  // After refreshing, the same operation succeeds.
  const fresh = await freshStatus(git, repo);
  await git.stageHunk(repo, {
    key: 'unstaged:f.txt',
    hunkIndex: 0,
    expected: entryOf(fresh, 'unstaged:f.txt').fingerprint,
    status: fresh,
  });
  assert.notDeepEqual(f.indexBytes('f.txt'), f.headBytes('f.txt'));
});

test('hunk ops refuse binary / symlink / submodule / mode-only / conflict entries', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'unsupported', { 'f.txt': 'one\ntwo\n' });

  // binary untracked
  f.write('bin.dat', Buffer.from([0, 1, 2, 0, 255]));
  let status = await freshStatus(git, repo);
  const binaryEntry = entryOf(status, 'untracked:bin.dat');
  assert.equal(binaryEntry.kind, 'binary');
  assert.equal(binaryEntry.additions, 0);
  const binaryDiff = await git.diff(repo, 'untracked:bin.dat', { status });
  assert.equal(binaryDiff.unsupported.code, 'binary');
  assert.equal(binaryDiff.base.exists, false);
  assert.equal(binaryDiff.target.encoding, 'binary');
  assert.equal(binaryDiff.target.binary, true);
  assert.equal(binaryDiff.hunks.length, 0);
  await expectGitError(
    git.stageHunk(repo, { key: 'untracked:bin.dat', hunkIndex: 0, expected: binaryEntry.fingerprint, status }),
    'entry/unsupported',
  );

  // mode-only staged change (Windows-compatible: update-index --chmod)
  f.git(['update-index', '--chmod=+x', '--', 'f.txt']);
  status = await freshStatus(git, repo);
  const modeEntry = entryOf(status, 'staged:f.txt');
  assert.equal(modeEntry.additions, 0);
  assert.equal(modeEntry.deletions, 0);
  const modeDiff = await git.diff(repo, 'staged:f.txt', { status });
  assert.equal(modeDiff.unsupported.code, 'mode-only');
  assert.deepEqual(modeDiff.modeChange, { oldMode: '100644', newMode: '100755' });
  assert.equal(modeDiff.hunks.length, 0);
  await expectGitError(
    git.unstageHunk(repo, { key: 'staged:f.txt', hunkIndex: 0, expected: modeEntry.fingerprint, status }),
    'entry/unsupported',
  );
  await git.unstage(repo, { keys: ['staged:f.txt'], expected: expectedFor(status, ['staged:f.txt']), status });

  // fake symlink entry (POSIX-less Windows: cacheinfo)
  const linkSha = runGit(f.dir, ['hash-object', '-w', '--stdin'], { input: 'target/path' }).out.trim();
  f.git(['update-index', '--add', '--cacheinfo', `120000,${linkSha},link`]);
  status = await freshStatus(git, repo);
  const linkEntry = entryOf(status, 'staged:link');
  assert.equal(linkEntry.kind, 'symlink');
  assert.deepEqual(linkEntry.symlink, { target: 'target/path' });
  const linkDiff = await git.diff(repo, 'staged:link', { status });
  assert.equal(linkDiff.unsupported.code, 'symlink');
  await expectGitError(
    git.stageHunk(repo, { key: 'staged:link', hunkIndex: 0, expected: linkEntry.fingerprint, status }),
    'entry/unsupported',
  );

  // fake submodule entry (gitlink)
  f.git(['update-index', '--add', '--cacheinfo', `160000,${f.headSha()},sub`]);
  status = await freshStatus(git, repo);
  const subEntry = entryOf(status, 'staged:sub');
  assert.equal(subEntry.kind, 'submodule');
  assert.notEqual(subEntry.kind, 'text');
  assert.equal(subEntry.fingerprint.target, 'dir');
  assert.equal(subEntry.submodule.newSha, f.headSha());
  const subDiff = await git.diff(repo, 'staged:sub', { status });
  assert.equal(subDiff.unsupported.code, 'submodule');
  assert.equal(subDiff.hunks.length, 0);
  await expectGitError(
    git.unstageHunk(repo, { key: 'staged:sub', hunkIndex: 0, expected: subEntry.fingerprint, status }),
    'entry/unsupported',
  );
});

test('hunk ops refuse staged renames (whole-file unstaging required)', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'renamehunk', { 'old.txt': 'alpha\nbeta\ngamma\n' });
  f.git(['mv', 'old.txt', 'new.txt']);
  f.write('new.txt', 'alpha\nbeta\ngamma\ndelta\n');
  f.addAll();
  const status = await freshStatus(git, repo);
  const entry = entryOf(status, 'staged:old.txt:new.txt');
  assert.equal(entry.change, 'renamed');
  assert.equal(entry.oldPath, 'old.txt');
  assert.equal(entry.path, 'new.txt');
  await expectGitError(
    git.unstageHunk(repo, { key: entry.key, hunkIndex: 0, expected: entry.fingerprint, status }),
    'entry/unsupported',
  );
  const after = await freshStatus(git, repo);
  assert.deepEqual(keysOf(after), ['staged:old.txt:new.txt'], 'refused hunk op changes nothing');
});

// ---------------------------------------------------------------------------
// stale fingerprints for whole-file ops
// ---------------------------------------------------------------------------

test('whole-file discard with stale fingerprint -> entry/stale and no write', async (t) => {
  const base = textLines(5);
  const { f, git, repo } = await committedFixture(t, 'discardstale', { 'f.txt': base });
  f.write('f.txt', 'changed\n');
  const status = await freshStatus(git, repo);
  const entry = entryOf(status, 'unstaged:f.txt');
  f.write('f.txt', 'changed again\n');
  await expectGitError(
    git.discard(repo, { key: 'unstaged:f.txt', expected: entry.fingerprint, status }),
    'entry/stale',
  );
  assert.equal(f.readText('f.txt'), 'changed again\n');
});

// ---------------------------------------------------------------------------
// renames / copies / deletes
// ---------------------------------------------------------------------------

test('staged rename: oldPath, content diff, git mv plus edit, whole-file unstage', async (t) => {
  const base = 'alpha\nbeta\ngamma\n';
  const { f, git, repo } = await committedFixture(t, 'rename', { 'old.txt': base });

  // pure move (no content change) is still a staged rename entry with oldPath
  f.git(['mv', 'old.txt', 'new.txt']);
  let status = await freshStatus(git, repo);
  const key = 'staged:old.txt:new.txt';
  const entry = entryOf(status, key);
  assert.equal(entry.status, 'staged');
  assert.equal(entry.change, 'renamed');
  assert.equal(entry.path, 'new.txt');
  assert.equal(entry.oldPath, 'old.txt');
  assert.equal(entry.kind, 'text');
  let diff = await git.diff(repo, key, { status });
  assert.equal(diff.comparison.baseRef, 'HEAD:old.txt');
  assert.equal(diff.comparison.targetRef, ':0:new.txt');
  assert.equal(diff.base.text, base);
  assert.equal(diff.target.text, base);
  assert.equal(diff.hunks.length, 0);

  // git mv plus edit: the staged diff is produced with -M against the old path
  f.write('new.txt', `${base}delta\n`);
  f.git(['add', '-A']);
  status = await freshStatus(git, repo);
  const edited = entryOf(status, key);
  assert.equal(edited.change, 'renamed');
  diff = await git.diff(repo, key, { status });
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.hunks[0].lines.filter((line) => line.kind === '+').map((line) => line.text).join(''), 'delta');
  assert.deepEqual(diff.stats, { additions: 1, deletions: 0 });

  // the renamed file can also have unstaged edits, reported as a normal modification
  f.write('new.txt', `${base}delta\nunstaged\n`);
  status = await freshStatus(git, repo);
  const unstagedKey = 'unstaged:new.txt';
  const unstagedEntry = entryOf(status, unstagedKey);
  assert.equal(unstagedEntry.change, 'modified');
  assert.equal(unstagedEntry.oldPath, null);
  const unstagedDiff = await git.diff(repo, unstagedKey, { status });
  assert.equal(unstagedDiff.comparison.baseRef, ':0:new.txt');
  assert.equal(unstagedDiff.hunks.length, 1);

  // whole-file unstage of a rename resets both sides of it
  await git.unstage(repo, { keys: [key], expected: expectedFor(status, [key]), status });
  const after = await freshStatus(git, repo);
  assert.deepEqual(keysOf(after).sort(), ['unstaged:old.txt', 'untracked:new.txt']);
  assert.equal(entryOf(after, 'unstaged:old.txt').change, 'deleted');
  assert.equal(f.readText('new.txt'), `${base}delta\nunstaged\n`, 'unstage never touches the worktree');
  assert.deepEqual(f.indexBytes('old.txt'), f.headBytes('old.txt'));
});

test('deleted files: unstaged/staged delete, diff sides, unstage and discard', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'deletes', { 'gone.txt': 'g1\ng2\ng3\n', 'keep.txt': 'k\n' });
  f.remove('gone.txt');
  let status = await freshStatus(git, repo);
  const entry = entryOf(status, 'unstaged:gone.txt');
  assert.equal(entry.change, 'deleted');
  assert.equal(entry.kind, 'text');
  assert.equal(entry.fingerprint.target, 'empty');
  assert.equal(entry.deletions, 3);
  const diff = await git.diff(repo, 'unstaged:gone.txt', { status });
  assert.equal(diff.base.exists, true);
  assert.equal(diff.target.exists, false);
  assert.equal(diff.target.ref, 'empty');
  assert.equal(diff.target.text, '');
  assert.deepEqual(diff.stats, { additions: 0, deletions: 3 });

  // stage the deletion
  await git.stage(repo, { keys: ['unstaged:gone.txt'], expected: expectedFor(status, ['unstaged:gone.txt']), status });
  status = await freshStatus(git, repo);
  const staged = entryOf(status, 'staged:gone.txt');
  assert.equal(staged.change, 'deleted');
  assert.equal(staged.fingerprint.target, 'empty');
  assert.equal(f.exists('gone.txt'), false);
  // unstage keeps the worktree deletion
  await git.unstage(repo, { keys: ['staged:gone.txt'], expected: expectedFor(status, ['staged:gone.txt']), status });
  status = await freshStatus(git, repo);
  assert.equal(entryOf(status, 'unstaged:gone.txt').change, 'deleted');
  assert.equal(f.exists('gone.txt'), false);
  assert.deepEqual(f.indexBytes('gone.txt'), f.headBytes('gone.txt'));
  // discard restores the deleted worktree file from the index
  await git.discard(repo, {
    key: 'unstaged:gone.txt',
    expected: entryOf(status, 'unstaged:gone.txt').fingerprint,
    status,
  });
  assert.equal(f.readText('gone.txt'), 'g1\ng2\ng3\n');
  assert.deepEqual(f.indexBytes('gone.txt'), f.headBytes('gone.txt'));
});

test('untracked / empty / binary files report kind and line counts correctly', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'kinds', { 'seed.txt': 'seed\n' });
  f.write('empty.dat', '');
  f.write('bin.dat', Buffer.from([0, 1, 2, 3, 255]));
  f.write('plain.txt', 'x\ny\n');
  let status = await freshStatus(git, repo);
  const emptyEntry = entryOf(status, 'untracked:empty.dat');
  assert.equal(emptyEntry.kind, 'empty');
  assert.equal(emptyEntry.additions, 0);
  assert.equal(entryOf(status, 'untracked:bin.dat').kind, 'binary');
  assert.equal(entryOf(status, 'untracked:bin.dat').additions, 0);
  const plainEntry = entryOf(status, 'untracked:plain.txt');
  assert.equal(plainEntry.kind, 'text');
  assert.equal(plainEntry.additions, 2);
  // untracked files are not folded into staged/unstaged line counts
  assert.equal(status.summary.stagedAdditions, 0);
  assert.equal(status.summary.unstagedAdditions, 0);
  assert.equal(status.summary.untrackedFiles, 3);

  const emptyDiff = await git.diff(repo, 'untracked:empty.dat', { status });
  assert.equal(emptyDiff.hunks.length, 0);
  assert.equal(emptyDiff.target.exists, true);
  assert.equal(emptyDiff.target.text, '');
  assert.equal(emptyDiff.target.bytes, 0);
  assert.equal(emptyDiff.unsupported, null);

  await git.stage(repo, { keys: 'all', includeUntracked: true, expected: expectedStageAll(status), status });
  status = await freshStatus(git, repo);
  assert.equal(entryOf(status, 'staged:empty.dat').kind, 'empty');
  assert.equal(entryOf(status, 'staged:bin.dat').kind, 'binary');
  const stagedBinaryDiff = await git.diff(repo, 'staged:bin.dat', { status });
  assert.equal(stagedBinaryDiff.unsupported.code, 'binary');
  assert.equal(stagedBinaryDiff.hunks.length, 0);
});

// ---------------------------------------------------------------------------
// conflicts
// ---------------------------------------------------------------------------

test('merge conflict: status reports conflict entries and commit is refused', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'conflict', { 'f.txt': 'base\n', 'other.txt': 'o\n' });
  f.git(['checkout', '-q', '-b', 'side']);
  f.write('f.txt', 'side version\n');
  f.addAll();
  f.commit('side commit');
  f.git(['checkout', '-q', 'main']);
  f.write('f.txt', 'main version\n');
  f.addAll();
  f.commit('main commit');
  const merge = runGit(f.dir, ['merge', 'side']);
  assert.notEqual(merge.code, 0, 'the merge must conflict');
  const headBefore = f.headSha();

  const status = await freshStatus(git, repo);
  assert.equal(status.summary.conflicts, 1);
  const entry = entryOf(status, 'conflict:f.txt');
  assert.equal(entry.status, 'conflict');
  assert.equal(entry.change, 'conflict');
  assert.equal(entry.kind, 'conflict');
  const diff = await git.diff(repo, 'conflict:f.txt', { status });
  assert.equal(diff.unsupported.code, 'conflict');
  assert.equal(diff.hunks.length, 0);
  assert.equal(diff.base.label, 'Index (ours)');
  await expectGitError(
    git.stageHunk(repo, { key: 'conflict:f.txt', hunkIndex: 0, expected: entry.fingerprint, status }),
    'entry/conflict',
  );

  const expected = { headSha: status.repo.headSha, stagedFingerprint: status.stagedFingerprint };
  await expectGitError(git.commit(repo, { message: 'nope', expected, status }), 'commit/conflict-pending');
  assert.equal(f.headSha(), headBefore, 'no commit may be created while conflicts are pending');
  assert.equal(f.git(['rev-list', '--count', 'HEAD']).out.trim(), '2');
});

// ---------------------------------------------------------------------------
// special paths (never shell interpreted, round-trip exactly)
// ---------------------------------------------------------------------------

const SPECIAL_PATHS = [
  'café 文件.txt',
  'a b.txt',
  "q'uote.txt",
  'dollar$bang!.txt',
  '--weird',
  'percent%VAR%.txt',
  'amp&.txt',
  'back`tick.txt',
  'semi;colon.txt',
  'paren(1).txt',
  'hash#name.txt',
];

test('special paths round-trip through status/diff/stage/commit and stay one argv value', async (t) => {
  const f = createFixture(t, 'specialpaths');
  f.init();
  f.write('seed.txt', 'seed\n');
  f.addAll();
  f.commit('seed');
  for (const name of SPECIAL_PATHS) f.write(name, `content of ${name}\n`);

  const { git, calls } = newRecordingGit();
  const repo = await git.resolveRepo(f.dir);
  let status = await git.status(repo);
  assert.deepEqual(
    keysOf(status).filter((key) => key.startsWith('untracked:')).sort(),
    SPECIAL_PATHS.map((name) => `untracked:${name}`).sort(),
  );
  for (const name of SPECIAL_PATHS) {
    const diff = await git.diff(repo, `untracked:${name}`, { status });
    assert.equal(diff.target.text, `content of ${name}\n`);
    assert.ok(diff.hunks[0].patch.includes(name === '--weird' ? 'a/--weird' : '+' + `content of ${name}`));
  }

  await git.stage(repo, { keys: 'all', includeUntracked: true, expected: expectedStageAll(status), status });
  status = await freshStatus(git, repo);
  assert.equal(status.summary.staged, SPECIAL_PATHS.length);
  // the index contains the exact names, byte for byte
  const lsFiles = f.git(['ls-files', '-z']).stdout.toString('utf8').split('\u0000').filter(Boolean).sort();
  assert.deepEqual(lsFiles, [...SPECIAL_PATHS, 'seed.txt'].sort());
  // commit with them, then edit them: keys stay exact
  const expected = { headSha: status.repo.headSha, stagedFingerprint: status.stagedFingerprint };
  await git.commit(repo, { message: 'add special paths', expected, status });
  for (const name of SPECIAL_PATHS) f.write(name, `edited content of ${name}\n`);
  status = await freshStatus(git, repo);
  assert.deepEqual(
    keysOf(status).sort(),
    SPECIAL_PATHS.map((name) => `unstaged:${name}`).sort(),
  );

  // every recorded argv is an array whose first element is 'git', and paths are single arguments
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.ok(Array.isArray(call.argv));
    assert.equal(call.argv[0], 'git');
    for (const value of call.argv) assert.equal(typeof value, 'string');
  }
  const addCall = calls.find((call) => call.argv[1] === 'add' && call.argv.includes('--weird'));
  assert.ok(addCall, 'git add must receive --weird as a literal argv value');
  assert.ok(addCall.argv.includes('--'), 'literal paths must follow a -- separator');
  assert.ok(addCall.argv.indexOf('--') < addCall.argv.indexOf('--weird'));
  assert.ok(calls.some((call) => call.argv.includes("q'uote.txt")));
  assert.ok(calls.some((call) => call.argv.includes('back`tick.txt')));
  // no shell side effects: no injected files, no environment expansion
  assert.equal(f.exists('injected'), false);
  assert.equal(f.exists('injected-marker'), false);
  assert.equal(f.exists('pwned'), false);

  // hunk ops on tricky names (quoted diff headers) work and preserve the worktree bytes
  const tricky = 'café 文件.txt';
  const original = textLines(20, 'C');
  f.write(tricky, original);
  f.git(['add', '--', tricky], { literal: true });
  f.commit('reset tricky');
  const working = withEditedLine(withEditedLine(original, 2, 'C-two'), 18, 'C-eighteen');
  f.write(tricky, working);
  const worktreeBefore = f.read(tricky);
  status = await freshStatus(git, repo);
  const trickyEntry = entryOf(status, `unstaged:${tricky}`);
  const trickyDiff = await git.diff(repo, trickyEntry.key, { status });
  assert.equal(trickyDiff.hunks.length, 2);
  await git.stageHunk(repo, { key: trickyEntry.key, hunkIndex: 1, expected: trickyEntry.fingerprint, status });
  assert.deepEqual(f.read(tricky), worktreeBefore);
  assert.deepEqual(f.indexBytes(tricky).toString('utf8'), withEditedLine(original, 18, 'C-eighteen'));

  // a filename that looks like an option is also safe for whole-file staging
  f.write('dashfile', 'x\n');
  status = await freshStatus(git, repo);
  await git.stage(repo, { keys: ['untracked:dashfile'], expected: expectedFor(status, ['untracked:dashfile']), status });
  assert.ok(keysOf(await freshStatus(git, repo)).includes('staged:dashfile'));
});

test('parseStatusV2 is NUL-safe for paths with newlines, quotes and spaces', async () => {
  const records = [
    '# branch.oid 0123456789012345678901234567890123456789',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -3',
    '1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb path with spaces.txt',
    '2 R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 new\nline.txt',
    'old\nline.txt',
    '? --weird',
    '1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb café 文件 "quoted".txt',
    '? to\ttab.txt',
  ];
  const raw = Buffer.from(records.join('\u0000') + '\u0000', 'utf8');
  const parsed = parseStatusV2(raw);
  assert.equal(parsed.branch.oid, '0123456789012345678901234567890123456789');
  assert.equal(parsed.branch.head, 'main');
  assert.equal(parsed.branch.upstream, 'origin/main');
  assert.deepEqual({ ahead: parsed.branch.ahead, behind: parsed.branch.behind }, { ahead: 2, behind: 3 });
  assert.equal(parsed.records[0].path, 'path with spaces.txt');
  assert.equal(parsed.records[1].path, 'new\nline.txt');
  assert.equal(parsed.records[1].oldPath, 'old\nline.txt');
  assert.equal(parsed.records[2].type, '?');
  assert.equal(parsed.records[2].path, '--weird');
  assert.equal(parsed.records[3].path, 'café 文件 "quoted".txt');
  assert.equal(parsed.records[4].path, 'to\ttab.txt');

  // quoted porcelain v1 style paths must not be unquoted by us (v2 -z is verbatim)
  const withQuote = Buffer.from('? "quoted name.txt"\u0000', 'utf8');
  assert.equal(parseStatusV2(withQuote).records[0].path, '"quoted name.txt"');
});

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

test('commit: message with quotes/newlines/$()/backticks goes through stdin verbatim', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'commitmsg', { 'f.txt': 'a\n' });
  f.write('f.txt', 'a\nb\n');
  f.addAll();
  const status = await freshStatus(git, repo);
  const message = [
    'subject "quoted" and \'single quoted\'',
    '',
    '$HOME $(touch injected-marker) `echo pwned` !bang! ; & |',
    'second body line with \\backslash\\ and \t tab',
  ].join('\n');
  const result = await git.commit(repo, {
    message,
    expected: { headSha: status.repo.headSha, stagedFingerprint: status.stagedFingerprint },
    status,
  });
  assert.match(result.headSha, /^[0-9a-f]{40}$/);
  assert.equal(result.summary, 'subject "quoted" and \'single quoted\'');
  assert.equal(f.git(['cat-file', 'commit', result.headSha]).out.includes('$HOME $(touch injected-marker)'), true);
  const body = f.git(['log', '-1', '--format=%B']).out.replace(/\n+$/, '');
  assert.equal(body, message);
  assert.equal(f.exists('injected-marker'), false, 'message must never be shell-evaluated');
  assert.equal(fs.existsSync(path.join(process.cwd(), 'injected-marker')), false);
  assert.equal(result.status.repo.headSha, result.headSha);
  assert.deepEqual(keysOf(result.status), []);
});

test('commit: empty index, empty message and whitespace-only message are refused', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'commitrefuse', { 'f.txt': 'a\n' });
  const clean = await freshStatus(git, repo);
  const expected = { headSha: clean.repo.headSha, stagedFingerprint: clean.stagedFingerprint };
  const headBefore = f.headSha();
  await expectGitError(git.commit(repo, { message: 'x', expected, status: clean }), 'commit/empty-index');
  f.write('f.txt', 'b\n');
  f.addAll();
  let status = await freshStatus(git, repo);
  const stagedExpected = { headSha: status.repo.headSha, stagedFingerprint: status.stagedFingerprint };
  await expectGitError(git.commit(repo, { message: '', expected: stagedExpected, status }), 'commit/invalid-message');
  await expectGitError(git.commit(repo, { message: '   \n\t\n', expected: stagedExpected, status }), 'commit/invalid-message');
  assert.equal(f.headSha(), headBefore);
  assert.equal(status.summary.staged, 1, 'refused commits must not change the index');
  // and a valid message does work
  const ok = await git.commit(repo, { message: 'real commit', expected: stagedExpected, status });
  assert.notEqual(ok.headSha, headBefore);
});

test('commit: failing pre-commit hook -> commit/failed with hook output, no commit created', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'commithook', { 'f.txt': 'a\n' });
  f.writeHook('pre-commit', '#!/bin/sh\necho "HOOK-STDOUT: rejected by policy"\necho "HOOK-STDERR: rejected by policy" >&2\nexit 1\n');
  f.write('f.txt', 'b\n');
  f.addAll();
  const status = await freshStatus(git, repo);
  const headBefore = f.headSha();
  const error = await expectGitError(
    git.commit(repo, {
      message: 'hook should reject',
      expected: { headSha: status.repo.headSha, stagedFingerprint: status.stagedFingerprint },
      status,
    }),
    'commit/failed',
  );
  assert.equal(error.details.exitCode !== 0, true);
  assert.match(error.details.hookOutput, /HOOK-STDOUT: rejected by policy/);
  assert.match(error.details.hookOutput, /HOOK-STDERR: rejected by policy/);
  assert.equal(f.headSha(), headBefore, 'a rejected commit must not move HEAD');
  assert.equal((await freshStatus(git, repo)).summary.staged, 1, 'the index must stay staged');
});

test('commit: changed head or staged fingerprint -> commit/stale with no commit', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'commitstale', { 'f.txt': 'a\n' });
  const exec = newGit();

  // (a) HEAD moved after the expectation was taken, without touching the index
  // (an external commit of the same tree, exactly what a concurrent client or a
  // rebase would do)
  f.write('f.txt', 'b\n');
  f.addAll();
  let status = await freshStatus(git, repo);
  const staleHeadExpected = { headSha: status.repo.headSha, stagedFingerprint: status.stagedFingerprint };
  const tree = f.git(['rev-parse', 'HEAD^{tree}']).out.trim();
  const externalCommit = f.git(['commit-tree', tree, '-p', f.headSha()], { input: 'external commit\n' }).out.trim();
  f.git(['update-ref', 'refs/heads/main', externalCommit]);
  const headAfterExternal = f.headSha();
  assert.equal(headAfterExternal, externalCommit);
  const commitCountBefore = Number(f.git(['rev-list', '--count', 'HEAD']).out.trim());
  await expectGitError(
    git.commit(repo, { message: 'stale-head', expected: staleHeadExpected, status }),
    'commit/stale',
  );
  assert.equal(f.headSha(), headAfterExternal);
  assert.equal(Number(f.git(['rev-list', '--count', 'HEAD']).out.trim()), commitCountBefore);

  // (b) the staged set changed after the expectation was taken
  f.write('f.txt', 'c\n');
  status = await exec.status(f.dir);
  const freshRepo = status.repo;
  const staleFingerprintExpected = { headSha: status.repo.headSha, stagedFingerprint: status.stagedFingerprint };
  f.write('extra.txt', 'e\n');
  f.git(['add', '--', 'extra.txt']);
  await expectGitError(
    exec.commit(freshRepo, { message: 'stale-index', expected: staleFingerprintExpected, status }),
    'commit/stale',
  );
  assert.equal(f.headSha(), headAfterExternal);
  // a fresh expectation (from the current state) succeeds
  const current = await exec.status(freshRepo);
  const ok = await exec.commit(freshRepo, {
    message: 'fresh commit',
    expected: { headSha: current.repo.headSha, stagedFingerprint: current.stagedFingerprint },
    status: current,
  });
  assert.notEqual(ok.headSha, headAfterExternal);
});

// ---------------------------------------------------------------------------
// commit-message inputs (history style + staged prompt patch)
// ---------------------------------------------------------------------------

test('commitHistory: recent subjects and bounded bodies, empty before the first commit', async (t) => {
  const f = createFixture(t, 'msg-history');
  f.init();
  const git = newGit();
  let repo = await git.resolveRepo(f.dir);
  // A repository without history must not make the draft path fail.
  assert.deepEqual(await git.commitHistory(repo), { commits: [] });

  f.write('a.txt', 'a\n');
  f.addAll();
  f.commit('feat: 初始提交\n\n- 第一项细节\n- 第二项细节');
  f.write('a.txt', 'b\n');
  f.addAll();
  f.commit('fix(core): 修复边界\n\n第二段正文');
  repo = await git.resolveRepo(f.dir);

  const history = await git.commitHistory(repo);
  assert.equal(history.commits.length, 2);
  // Newest first, exactly as git log reports them.
  assert.equal(history.commits[0].subject, 'fix(core): 修复边界');
  assert.match(history.commits[0].body, /第二段正文/);
  assert.equal(history.commits[1].subject, 'feat: 初始提交');
  assert.match(history.commits[1].body, /第一项细节/);
  // The limit is honoured.
  const limited = await git.commitHistory(repo, { limit: 1 });
  assert.equal(limited.commits.length, 1);
});

test('stagedPatch: only the index is included, worktree content is not', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'msg-patch', { 'a.txt': 'one\n', 'b.txt': 'x\n' });
  f.write('a.txt', 'one\ntwo\n');
  f.git(['add', '--', 'a.txt']);
  f.write('b.txt', 'x\nworktree-only\n');

  const patch = await git.stagedPatch(repo);
  assert.equal(patch.truncated, false);
  assert.match(patch.text, /\+two/);
  assert.match(patch.text, /^diff --git a\/a\.txt/m);
  assert.equal(patch.text.includes('b.txt'), false, 'unstaged content must never reach the draft prompt');
  assert.equal(patch.text.includes('worktree-only'), false);

  // The prompt budget clips the patch and reports it instead of silently hiding it.
  const tiny = await git.stagedPatch(repo, { maxChars: 20 });
  assert.equal(tiny.truncated, true);
  assert.equal(tiny.text.length, 20);
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

function bareRemoteAt(t, dir, name) {
  const bare = path.join(dir, name);
  const result = runGit(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  assert.equal(result.code, 0, result.err);
  return bare;
}

test('push: preview, setUpstream, tracking config, second preview, rejection, no remote', async (t) => {
  const parent = makeTempDir('pushbase');
  t.after(() => removeTree(parent));
  const f = createFixture(t, 'pushrepo');
  f.init();
  f.write('a.txt', 'a\n');
  f.addAll();
  f.commit('c1');
  const git = newGit();
  let repo = await git.resolveRepo(f.dir);

  // --- no remote at all -----------------------------------------------------
  let preview = await git.pushPreview(repo, { status: await git.status(repo) });
  assert.deepEqual(preview.remotes, []);
  assert.equal(preview.canPush, false);
  assert.equal(preview.reason, 'no remotes');
  await expectGitError(git.push(repo, { status: await git.status(repo) }), 'push/no-remote');

  // --- add a bare remote and preview ---------------------------------------
  const bare = bareRemoteAt(t, parent, 'remote with spaces.git');
  f.git(['remote', 'add', 'origin', bare.replace(/\\/g, '/')]);
  repo = await git.resolveRepo(f.dir);
  let status = await git.status(repo);
  preview = await git.pushPreview(repo, { status });
  assert.deepEqual(preview.remotes.map((remote) => remote.name), ['origin']);
  assert.equal(preview.defaultRemote, 'origin');
  assert.equal(preview.branch, 'main');
  assert.equal(preview.upstream, null);
  assert.equal(preview.canPush, true);
  assert.equal(preview.commits.length, 1);
  assert.equal(preview.commits[0].subject, 'c1');

  // pushing without setUpstream (no upstream configured) is refused
  await expectGitError(git.push(repo, { status }), 'push/upstream-missing');

  // --- first push with setUpstream creates the tracking configuration ------
  const pushed = await git.push(repo, { setUpstream: true, status });
  assert.equal(pushed.ok, true);
  assert.equal(pushed.remote, 'origin');
  assert.equal(pushed.branch, 'main');
  assert.equal(pushed.setUpstream, true);
  assert.equal(pushed.status.repo.upstream, 'origin/main');
  assert.equal(pushed.status.repo.ahead, 0);
  assert.equal(pushed.status.repo.behind, 0);
  assert.equal(f.git(['config', '--get', 'branch.main.remote']).out.trim(), 'origin');
  assert.equal(f.git(['config', '--get', 'branch.main.merge']).out.trim(), 'refs/heads/main');
  assert.equal(runGit(bare, ['rev-parse', 'refs/heads/main']).out.trim(), f.headSha());

  // --- second preview reports upstream and 0/0 -----------------------------
  repo = await git.resolveRepo(f.dir);
  status = await git.status(repo);
  assert.equal(status.repo.upstream, 'origin/main');
  assert.equal(status.repo.ahead, 0);
  assert.equal(status.repo.behind, 0);
  preview = await git.pushPreview(repo, { status });
  assert.deepEqual(preview.upstream, { remote: 'origin', branch: 'main', ref: 'refs/heads/main' });
  assert.deepEqual(preview.commits, []);
  assert.equal(preview.canPush, true);

  // --- rejection: the remote gains a commit the local repo does not have ----
  const clone2 = path.join(parent, 'clone2');
  assert.equal(runGit(parent, ['clone', '-q', bare.replace(/\\/g, '/'), clone2]).code, 0);
  runGit(clone2, ['config', 'user.name', 'Clone']);
  runGit(clone2, ['config', 'user.email', 'clone@example.com']);
  fs.writeFileSync(path.join(clone2, 'remote.txt'), 'remote\n');
  runGit(clone2, ['add', '-A']);
  runGit(clone2, ['commit', '-q', '-m', 'remote commit']);
  assert.equal(runGit(clone2, ['push', '-q', 'origin', 'main']).code, 0);
  const remoteHead = runGit(bare, ['rev-parse', 'refs/heads/main']).out.trim();

  f.write('local.txt', 'local\n');
  f.addAll();
  f.commit('local commit');
  const localHead = f.headSha();
  repo = await git.resolveRepo(f.dir);
  status = await git.status(repo);
  const rejection = await expectGitError(git.push(repo, { status }), 'push/rejected');
  assert.match(rejection.details.stderr, /rejected|non-fast-forward|fetch first/i);
  assert.equal(runGit(bare, ['rev-parse', 'refs/heads/main']).out.trim(), remoteHead, 'push must never force');
  assert.equal(f.headSha(), localHead);

  // --- detached HEAD cannot be pushed ---------------------------------------
  f.git(['checkout', '-q', '--detach', 'HEAD']);
  repo = await git.resolveRepo(f.dir);
  status = await git.status(repo);
  assert.equal(repo.branch, null);
  assert.equal(repo.detached, true);
  await expectGitError(git.push(repo, { status }), 'push/no-branch');
});

// ---------------------------------------------------------------------------
// remote configuration
// ---------------------------------------------------------------------------

test('setRemote adds a remote, then updates its URL without duplicating it', async (t) => {
  const f = createFixture(t, 'setremote');
  f.init();
  f.write('a.txt', 'a\n');
  f.addAll();
  f.commit('initial');
  const git = newGit();
  let repo = await git.resolveRepo(f.dir);
  assert.deepEqual(repo.remotes, []);

  // --- add a remote -------------------------------------------------------
  const url = 'https://example.com/org/repo.git';
  const added = await git.setRemote(repo, { name: 'origin', url });
  assert.deepEqual(added, { name: 'origin', url, created: true });
  repo = await git.resolveRepo(f.dir);
  assert.deepEqual(repo.remotes, [{ name: 'origin', url }]);
  assert.equal(f.git(['remote', 'get-url', 'origin']).out.trim(), url);
  // The status payload exposes the new remote (the client refreshes with it).
  const statusAfterAdd = await git.status(repo);
  assert.deepEqual(statusAfterAdd.repo.remotes, [{ name: 'origin', url }]);

  // --- an existing name updates in place ----------------------------------
  const nextUrl = 'git@example.com:org/repo.git';
  const updated = await git.setRemote(repo, { name: 'origin', url: nextUrl });
  assert.deepEqual(updated, { name: 'origin', url: nextUrl, created: false });
  repo = await git.resolveRepo(f.dir);
  assert.deepEqual(repo.remotes, [{ name: 'origin', url: nextUrl }],
    'an existing name is updated in place, not duplicated');
  assert.deepEqual(f.git(['remote']).out.trim().split(/\r?\n/), ['origin']);

  // --- a second remote is additive ----------------------------------------
  const secondUrl = 'https://example.com/other.git';
  const second = await git.setRemote(repo, { name: 'upstream', url: secondUrl });
  assert.equal(second.created, true);
  const status = await git.status(repo);
  assert.deepEqual(status.repo.remotes.map((remote) => remote.name), ['origin', 'upstream']);
  assert.deepEqual(status.repo.remotes[1], { name: 'upstream', url: secondUrl });

  // --- online-ness is irrelevant ------------------------------------------
  // Configuring a remote writes local Git config only; an unreachable address
  // is accepted here (the next push reports the connection problem).
  const unreachable = 'https://127.0.0.1:1/never.git';
  const offline = await git.setRemote(repo, { name: 'offline', url: unreachable });
  assert.equal(offline.created, true);
  assert.equal(f.git(['config', '--get', 'remote.offline.url']).out.trim(), unreachable);
});

test('setRemote passes name/url as argv items and maps failures to remote/failed', async (t) => {
  const f = createFixture(t, 'setremote-argv');
  f.init();
  f.write('a.txt', 'a\n');
  f.addAll();
  f.commit('initial');

  // argv-only invocation (no shell): shell metacharacters arrive byte-exactly
  // as one argument instead of being interpreted.
  const recording = newRecordingGit();
  const repo = await recording.git.resolveRepo(f.dir);
  const url = 'https://example.com/a b.git?x=1&y=2';
  await recording.git.setRemote(repo, { name: 'origin', url });
  const remoteAdd = recording.calls.find((call) => call.argv[1] === 'remote' && call.argv[2] === 'add');
  assert.ok(remoteAdd, 'git remote add was invoked');
  assert.deepEqual(remoteAdd.argv, ['git', 'remote', 'add', 'origin', url]);
  assert.equal(f.git(['config', '--get', 'remote.origin.url']).out.trim(), url);

  // A failing git command becomes the stable remote/failed protocol code.
  const base = createNodeExecutor();
  const failing = createGit({
    run(argv, opts) {
      if (argv[1] === 'remote') {
        return Promise.resolve({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('fatal: could not write config') });
      }
      return base.run(argv, opts);
    },
  });
  const failRepo = await failing.resolveRepo(f.dir);
  const failure = await expectGitError(
    failing.setRemote(failRepo, { name: 'origin', url: 'https://example.com/x.git' }),
    'remote/failed',
  );
  assert.match(failure.details.stderr, /could not write config/);
});

test('setRemote refuses a repo ref without a root', async () => {
  const git = newGit();
  await expectGitError(git.setRemote(null, { name: 'origin', url: 'https://example.com/x.git' }), 'repo/no-git');
  await expectGitError(git.setRemote({}, { name: 'origin', url: 'https://example.com/x.git' }), 'repo/no-git');
});

// ---------------------------------------------------------------------------
// caps: entry list truncation, tooLarge and truncated diff sides
// ---------------------------------------------------------------------------

test('large file behaviour: status entry list truncation at the documented cap', async (t) => {
  const f = createFixture(t, 'truncate');
  f.init();
  f.write('seed.txt', 'seed\n');
  f.addAll();
  f.commit('seed');
  const total = CAPS.maxStatusEntries + 3;
  for (let i = 0; i < total; i++) f.write(`bulk/f${String(i).padStart(4, '0')}.txt`, `file ${i}\n`);
  const git = newGit();
  const repo = await git.resolveRepo(f.dir);
  const status = await git.status(repo);
  assert.equal(status.summary.truncated, true);
  assert.equal(status.entries.length, CAPS.maxStatusEntries);
  assert.equal(status.summary.entries, CAPS.maxStatusEntries);
  assert.equal(status.summary.untracked, CAPS.maxStatusEntries);
  assert.equal(status.entries.every((entry) => entry.status === 'untracked'), true);
});

test('large file behaviour: diffs report tooLarge / truncated instead of pretending completeness', async (t) => {
  const bigContent = 'a\n'.repeat(Math.ceil(MAX_SIDE_BYTES / 2) + 5);
  const { f, git, repo } = await committedFixture(t, 'large', { 'big.txt': bigContent });
  f.write('big.txt', `A\n${bigContent.slice(2)}`);
  let status = await freshStatus(git, repo);
  const diff = await git.diff(repo, 'unstaged:big.txt', { status });
  assert.equal(diff.base.tooLarge, true);
  assert.equal(diff.target.tooLarge, true);
  assert.equal(diff.base.text, '');
  assert.equal(diff.target.text, '');
  assert.equal(diff.unsupported.code, 'too-large');
  assert.equal(diff.hunks.length, 0);
  await expectGitError(
    git.discardHunk(repo, {
      key: 'unstaged:big.txt',
      hunkIndex: 0,
      expected: entryOf(status, 'unstaged:big.txt').fingerprint,
      status,
    }),
    'entry/unsupported',
  );

  // > MAX_SIDE_LINES lines: content is cut and flagged truncated
  const manyLines = textLines(MAX_SIDE_LINES + 10, 'L');
  f.write('long.txt', manyLines);
  f.addAll();
  f.commit('long file');
  f.write('long.txt', withEditedLine(f.readText('long.txt'), 1, 'CHANGED'));
  status = await freshStatus(git, repo);
  const longDiff = await git.diff(repo, 'unstaged:long.txt', { status });
  assert.equal(longDiff.base.truncated, true);
  assert.equal(longDiff.target.truncated, true);
  assert.equal(longDiff.base.tooLarge, false);
  assert.equal(longDiff.base.lines, MAX_SIDE_LINES);
  assert.equal(longDiff.target.lines, MAX_SIDE_LINES);
  assert.ok(longDiff.base.text.length > 0);
  assert.equal(longDiff.unsupported, null);
});

// ---------------------------------------------------------------------------
// linked worktrees and repository paths with spaces
// ---------------------------------------------------------------------------

test('worktree support: resolveRepo reports a linked worktree own root/gitDir/branch', async (t) => {
  const parent = makeTempDir('wtbase');
  t.after(() => removeTree(parent));
  const f = createFixture(t, 'wtmain');
  f.init();
  f.write('a.txt', 'a\n');
  f.addAll();
  f.commit('c1');
  f.git(['branch', 'feature']);
  const linked = path.join(parent, 'linked worktree');
  const added = runGit(f.dir, ['worktree', 'add', '-q', linked, 'feature']);
  assert.equal(added.code, 0, added.err);

  const git = newGit();
  const mainRepo = await git.resolveRepo(f.dir);
  assert.equal(mainRepo.worktree, false);
  // `rev-parse --git-common-dir` is relative to the invoked directory: a
  // subdirectory of a normal repository must not look like a linked worktree.
  fs.mkdirSync(path.join(f.dir, 'nested'), { recursive: true });
  const mainFromSub = await git.resolveRepo(path.join(f.dir, 'nested'));
  assert.equal(mainFromSub.worktree, false);
  assert.equal(mainFromSub.root, path.resolve(f.dir));
  assert.equal(mainFromSub.gitDir, path.resolve(f.dir, '.git'));
  const wtRepo = await git.resolveRepo(linked);
  assert.equal(wtRepo.worktree, true);
  assert.equal(wtRepo.root, path.resolve(linked));
  assert.equal(wtRepo.branch, 'feature');
  assert.equal(wtRepo.headSha, mainRepo.headSha);
  assert.ok(wtRepo.gitDir.startsWith(path.resolve(f.dir, '.git', 'worktrees')), wtRepo.gitDir);
  assert.notEqual(wtRepo.gitDir, path.resolve(f.dir, '.git'));
  fs.mkdirSync(path.join(linked, 'nested'), { recursive: true });
  const wtFromSub = await git.resolveRepo(path.join(linked, 'nested'));
  assert.equal(wtFromSub.worktree, true);
  assert.equal(wtFromSub.root, path.resolve(linked));
  assert.equal(wtFromSub.gitDir, wtRepo.gitDir);

  fs.writeFileSync(path.join(linked, 'a.txt'), 'changed in linked\n');
  const status = await git.status(wtRepo);
  assert.equal(status.repo.worktree, true);
  assert.deepEqual(keysOf(status), ['unstaged:a.txt']);
  const diff = await git.diff(wtRepo, 'unstaged:a.txt', { status });
  assert.equal(diff.target.text, 'changed in linked\n');
  // the main worktree is untouched
  assert.equal(fs.readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), 'a\n');
});

test('repository path and remote path containing spaces', async (t) => {
  const parent = makeTempDir('spacesbase');
  t.after(() => removeTree(parent));
  const repoDir = path.join(parent, 'repo with spaces');
  const f = createFixture(t, 'unused', { dir: repoDir });
  f.init();
  f.write('a file.txt', 'a\n');
  f.addAll();
  f.commit('c1');
  f.write('a file.txt', 'b\n');
  const git = newGit();
  const repo = await git.resolveRepo(repoDir);
  assert.equal(repo.root, path.resolve(repoDir));
  let status = await git.status(repo);
  assert.deepEqual(keysOf(status), ['unstaged:a file.txt']);
  const diff = await git.diff(repo, 'unstaged:a file.txt', { status });
  assert.equal(diff.target.text, 'b\n');
  await git.stageHunk(repo, {
    key: 'unstaged:a file.txt',
    hunkIndex: 0,
    expected: entryOf(status, 'unstaged:a file.txt').fingerprint,
    status,
  });
  assert.equal(f.readText('a file.txt'), 'b\n');

  const bare = bareRemoteAt(t, parent, 'remote with spaces.git');
  f.git(['remote', 'add', 'origin', bare.replace(/\\/g, '/')]);
  status = await freshStatus(git, repo);
  const pushed = await git.push(repo, { setUpstream: true, status });
  assert.equal(pushed.ok, true);
  assert.equal(pushed.remote, 'origin');
});

// ---------------------------------------------------------------------------
// patch.js unit coverage (byte exactness, quoting, NUL safety helpers)
// ---------------------------------------------------------------------------

test('patch.js: parse + rebuild reproduces git diff bytes exactly (CRLF, no trailing newline)', async (t) => {
  const { f } = await committedFixture(t, 'patchexact', { 'f.txt': 'one\r\ntwo\r\nthree\r\n' });
  f.write('f.txt', 'one\r\nTWO\r\nthree');
  const raw = f.git(['diff', '--no-color', '-U3', '--', 'f.txt']).stdout;
  const parsed = parsePatch(raw);
  assert.equal(parsed.files.length, 1);
  const file = parsed.files[0];
  assert.equal(file.hunks.length, 1);
  const hunk = file.hunks[0];
  const minus = hunk.lines.filter((line) => line.kind === '-').map((line) => line.text);
  const plus = hunk.lines.filter((line) => line.kind === '+').map((line) => line.text);
  assert.deepEqual(minus, ['two\r', 'three\r']);
  assert.deepEqual(plus, ['TWO\r', 'three']);
  // the "\ No newline at end of file" marker is kept in rawLines but not in contract lines
  assert.equal(hunk.rawLines.some((line) => line.buf.toString('utf8').startsWith('\\ No newline')), true);
  assert.deepEqual(buildSingleHunkPatch(file, hunk), raw, 'single-hunk patch must be byte-identical to git output');
  // and git accepts it
  const check = runGit(f.dir, ['apply', '--cached', '--check'], { input: buildSingleHunkPatch(file, hunk) });
  assert.equal(check.code, 0, check.err);
  // findMatchingHunk finds it and rejects a modified body
  assert.equal(findMatchingHunk(file.hunks, hunk), 0);
  const tampered = { ...hunk, lines: hunk.lines.map((line, index) => (index === 0 ? { ...line, text: 'nope' } : line)) };
  assert.equal(findMatchingHunk(file.hunks, tampered), -1);
});

test('patch.js: quotePath and synthetic new-file patches cover exotic names', () => {
  assert.equal(quotePath('plain.txt'), '"plain.txt"');
  assert.equal(quotePath('a b.txt'), '"a b.txt"');
  assert.equal(quotePath('q"uote'), '"q\\"uote"');
  assert.equal(quotePath('back\\slash'), '"back\\\\slash"');
  assert.equal(quotePath('new\nline'), '"new\\nline"');
  assert.equal(quotePath('tab\there'), '"tab\\there"');
  assert.match(quotePath('café'), /^"caf\\303\\251"$/);

  // non-UTF8-safe path bytes are escaped as octal, never injected raw
  const quoted = quotePath('--weird');
  assert.equal(quoted, '"--weird"');

  const parsed = makeNewFilePatch('a b.txt', Buffer.from('one\ntwo\n'));
  const file = parsed.files[0];
  assert.equal(file.headerLines[0].buf.toString('utf8'), 'diff --git "a/a b.txt" "b/a b.txt"');
  assert.equal(file.hunks.length, 1);
  assert.equal(buildSingleHunkPatch(file, file.hunks[0]).toString('utf8'),
    'diff --git "a/a b.txt" "b/a b.txt"\nnew file mode 100644\n--- /dev/null\n+++ "b/a b.txt"\n@@ -0,0 +1,2 @@\n+one\n+two\n');

  // empty content produces a header-only patch (no hunks)
  assert.equal(makeNewFilePatch('empty.txt', Buffer.alloc(0)).files[0].hunks.length, 0);
  // missing trailing newline gets the marker line
  const noEol = makeNewFilePatch('noeol.txt', Buffer.from('abc'));
  assert.equal(noEol.files[0].hunks[0].rawLines.some((line) => line.buf.toString('utf8').startsWith('\\ No newline')), true);
  assert.equal(countTextLines(Buffer.from('a\nb')), 2);
  assert.equal(countTextLines(Buffer.alloc(0)), 0);
  assert.equal(looksBinary(Buffer.from([1, 0, 2])), true);
  assert.equal(looksBinary(Buffer.from('abc')), false);
});

// ===========================================================================
// literal pathspecs, hunk-stage byte exactness, mode/gitlink fingerprints,
// full-index commit safety, process limits and push source/target separation
// ===========================================================================

test('literal pathspecs: a bracket filename is only ever the literal file', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'literalpaths', {
    'a.txt': 'alpha\n',
    'b.txt': 'bravo\n',
    '[ab].txt': 'literal bracket\n',
  });
  // Without GIT_LITERAL_PATHSPECS the pathspec "[ab].txt" matches "a.txt".
  f.write('a.txt', 'alpha-changed\n');
  f.write('b.txt', 'bravo-changed\n');
  f.write('[ab].txt', 'literal-changed\n');
  let status = await freshStatus(git, repo);
  assert.deepEqual(keysOf(status).sort(), ['unstaged:[ab].txt', 'unstaged:a.txt', 'unstaged:b.txt']);

  const diff = await git.diff(repo, 'unstaged:[ab].txt', { status });
  assert.equal(diff.target.text, 'literal-changed\n');
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.hunks[0].patch.includes('literal-changed'), true);
  assert.equal(diff.hunks[0].patch.includes('alpha-changed'), false, 'the sibling file must not leak into the diff');

  // Every path-scoped call opts into literal pathspecs through the executor env.
  const { git: recording, calls } = newRecordingGit();
  const recordedRepo = await recording.resolveRepo(f.dir);
  const recordedStatus = await recording.status(recordedRepo);
  await recording.diff(recordedRepo, 'unstaged:[ab].txt', { status: recordedStatus });
  const diffCall = calls.find((call) => call.argv[1] === 'diff' && call.argv.includes('[ab].txt'));
  assert.ok(diffCall, 'diff must pass the literal path as one argv value');
  assert.equal(diffCall.opts.env.GIT_LITERAL_PATHSPECS, '1');

  // Whole-file stage touches only the literal file.
  status = await freshStatus(git, repo);
  await git.stage(repo, {
    keys: ['unstaged:[ab].txt'],
    expected: expectedFor(status, ['unstaged:[ab].txt']),
    status,
  });
  const afterStage = await freshStatus(git, repo);
  assert.ok(keysOf(afterStage).includes('staged:[ab].txt'));
  assert.ok(keysOf(afterStage).includes('unstaged:a.txt'));
  assert.ok(keysOf(afterStage).includes('unstaged:b.txt'));
  assert.equal(f.indexBytes('[ab].txt').toString('utf8'), 'literal-changed\n');
  assert.deepEqual(f.indexBytes('a.txt'), f.headBytes('a.txt'));
  assert.deepEqual(f.indexBytes('b.txt'), f.headBytes('b.txt'));

  // Hunk staging is equally narrow.
  f.write('[ab].txt', 'literal-hunk-edited\n');
  status = await freshStatus(git, repo);
  const bracketEntry = entryOf(status, 'unstaged:[ab].txt');
  await git.stageHunk(repo, {
    key: bracketEntry.key,
    hunkIndex: 0,
    expected: bracketEntry.fingerprint,
    status,
  });
  const afterHunk = await freshStatus(git, repo);
  assert.deepEqual(keysOf(afterHunk).sort(), ['staged:[ab].txt', 'unstaged:a.txt', 'unstaged:b.txt']);
  assert.equal(f.readText('[ab].txt'), 'literal-hunk-edited\n');
  assert.equal(f.indexBytes('[ab].txt').toString('utf8'), 'literal-hunk-edited\n');
  assert.deepEqual(f.indexBytes('a.txt'), f.headBytes('a.txt'));
  assert.deepEqual(f.indexBytes('b.txt'), f.headBytes('b.txt'));
});

test('no-trailing-newline untracked file: hunk stage keeps the marker on its own line and stages exact bytes', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'noeolstage', { 'seed.txt': 'seed\n' });
  f.write('noeol.txt', 'abc');
  f.write('multi.txt', 'one\ntwo');

  let status = await freshStatus(git, repo);
  let entry = entryOf(status, 'untracked:noeol.txt');
  let diff = await git.diff(repo, entry.key, { status });
  assert.equal(diff.hunks.length, 1);
  assert.match(diff.hunks[0].patch, /\n\+abc\n\\ No newline at end of file\n$/);
  assert.equal(/\+abc\\ No newline/.test(diff.hunks[0].patch), false, 'the marker must never be glued to the content line');
  assert.deepEqual(diff.entry.fingerprint, entry.fingerprint);
  await git.stageHunk(repo, { key: entry.key, hunkIndex: 0, expected: entry.fingerprint, status });
  assert.deepEqual(f.indexBytes('noeol.txt'), Buffer.from('abc'), 'the staged blob must be byte-identical to the file');

  status = await freshStatus(git, repo);
  entry = entryOf(status, 'untracked:multi.txt');
  diff = await git.diff(repo, entry.key, { status });
  assert.match(diff.hunks[0].patch, /\n\+two\n\\ No newline at end of file\n$/);
  await git.stageHunk(repo, { key: entry.key, hunkIndex: 0, expected: entry.fingerprint, status });
  assert.deepEqual(f.indexBytes('multi.txt'), Buffer.from('one\ntwo'));
});

test('entry fingerprints include the file mode pair', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'modefp', { 'f.txt': 'one\ntwo\n' });
  f.write('f.txt', 'changed\n');
  f.git(['add', '--', 'f.txt']);
  f.git(['update-index', '--chmod=+x', '--', 'f.txt']);

  let status = await freshStatus(git, repo);
  const entry = entryOf(status, 'staged:f.txt');
  assert.equal(entry.fingerprint.mode, '100644:100755');
  assert.deepEqual(f.indexMode('f.txt'), '100755');
  const diff = await git.diff(repo, entry.key, { status });
  assert.deepEqual(diff.entry.fingerprint, entry.fingerprint, 'status and diff derive the same fingerprint');
  const expected = expectedFor(status, [entry.key]);

  // A mode-only external change must invalidate the previewed expectation.
  f.git(['update-index', '--chmod=-x', '--', 'f.txt']);
  status = await freshStatus(git, repo);
  assert.equal(entryOf(status, 'staged:f.txt').fingerprint.mode, '100644:100644');
  await expectGitError(git.unstage(repo, { keys: ['staged:f.txt'], expected, status }), 'entry/stale');
  assert.ok(keysOf(await freshStatus(git, repo)).includes('staged:f.txt'), 'the refused unstage must not write');

  // The refreshed expectation succeeds.
  status = await freshStatus(git, repo);
  await git.unstage(repo, {
    keys: ['staged:f.txt'],
    expected: expectedFor(status, ['staged:f.txt']),
    status,
  });
  assert.equal(f.git(['ls-files', '-s', '--', 'f.txt']).out.trim().split(' ')[0], '100644');
});

test('entry and index fingerprints include submodule gitlink identities', async (t) => {
  const f = createFixture(t, 'gitlinkfp');
  f.init();
  f.write('a.txt', 'a\n');
  f.addAll();
  f.commit('c1');
  const shaA = f.headSha();
  f.write('a.txt', 'a2\n');
  f.addAll();
  f.commit('c2');
  const shaB = f.headSha();
  f.write('a.txt', 'a3\n');
  f.addAll();
  f.commit('c3');
  const shaC = f.headSha();
  f.git(['update-index', '--add', '--cacheinfo', `160000,${shaA},sub`]);
  f.git(['commit', '-q', '-m', 'gitlink A']);
  const git = newGit();
  const repo = await git.resolveRepo(f.dir);

  // staged gitlink A -> B
  f.git(['update-index', '--cacheinfo', `160000,${shaB},sub`]);
  let status = await git.status(repo);
  const first = entryOf(status, 'staged:sub');
  assert.equal(first.kind, 'submodule');
  assert.deepEqual(first.submodule, { oldSha: shaA, newSha: shaB });
  assert.deepEqual(first.fingerprint.gitlink, { oldSha: shaA, newSha: shaB });
  assert.equal(first.fingerprint.target, 'dir');
  assert.equal(first.fingerprint.mode, '160000:160000');
  const firstIndexFingerprint = status.stagedFingerprint;
  const diff = await git.diff(repo, first.key, { status });
  assert.deepEqual(diff.entry.fingerprint, first.fingerprint, 'diff and status agree on the gitlink identity');
  assert.equal(diff.unsupported.code, 'submodule');

  // staged gitlink A -> C: the entry and the full-index fingerprints both change
  f.git(['update-index', '--cacheinfo', `160000,${shaC},sub`]);
  status = await git.status(repo);
  const second = entryOf(status, 'staged:sub');
  assert.deepEqual(second.fingerprint.gitlink, { oldSha: shaA, newSha: shaC });
  assert.notDeepEqual(second.fingerprint, first.fingerprint);
  assert.notEqual(status.stagedFingerprint, firstIndexFingerprint);

  // The A->B expectation is stale now and must not write.
  await expectGitError(
    git.unstage(repo, { keys: ['staged:sub'], expected: { 'staged:sub': first.fingerprint }, status }),
    'entry/stale',
  );
  assert.deepEqual(entryOf(await freshStatus(git, repo), 'staged:sub').fingerprint.gitlink, { oldSha: shaA, newSha: shaC });

  // A fresh expectation unstages the gitlink back to HEAD.
  await git.unstage(repo, { keys: ['staged:sub'], expected: expectedFor(status, ['staged:sub']), status });
  const after = await freshStatus(git, repo);
  assert.deepEqual(keysOf(after), ['unstaged:sub'], 'only the worktree-deleted row remains');
  assert.match(f.git(['ls-files', '-s', '--', 'sub']).out.trim(), /^160000 [0-9a-f]+ 0\tsub$/);
});

test('staged fingerprint covers the complete index, not only the displayed rows', async (t) => {
  const f = createFixture(t, 'hiddenindex');
  f.init();
  f.write('seed.txt', 'seed\n');
  f.addAll();
  f.commit('seed');
  const total = CAPS.maxStatusEntries + 5;
  for (let i = 0; i < total; i++) f.write(`bulk/f${String(i).padStart(4, '0')}.txt`, `file ${i}\n`);
  f.addAll();
  const git = newGit();
  let repo = await git.resolveRepo(f.dir);
  let status = await git.status(repo);
  assert.equal(status.summary.truncated, true);
  assert.equal(status.entries.length, CAPS.maxStatusEntries);
  const hiddenPath = `bulk/f${String(total - 1).padStart(4, '0')}.txt`;
  assert.equal(status.entries.some((entry) => entry.path === hiddenPath), false, 'the last path is hidden behind the cap');
  const expected = { headSha: status.repo.headSha, stagedFingerprint: status.stagedFingerprint };
  assert.deepEqual(f.indexBytes(hiddenPath), Buffer.from(`file ${total - 1}\n`));

  // Change only the hidden staged entry: visible rows do not change, the index does.
  f.write(hiddenPath, 'changed after preview\n');
  f.addAll();
  status = await git.status(repo);
  repo = status.repo;
  assert.equal(status.entries.length, CAPS.maxStatusEntries);
  assert.notEqual(status.stagedFingerprint, expected.stagedFingerprint);
  const headBefore = f.headSha();
  await expectGitError(git.commit(repo, { message: 'must not commit', expected, status }), 'commit/stale');
  assert.equal(f.headSha(), headBefore, 'a stale commit must not move HEAD');

  // A fresh expectation commits the whole index, hidden entries included.
  status = await git.status(repo);
  const committed = await git.commit(repo, {
    message: 'commit everything',
    expected: { headSha: status.repo.headSha, stagedFingerprint: status.stagedFingerprint },
    status,
  });
  assert.equal(
    f.git(['cat-file', '-p', `HEAD:${hiddenPath}`]).out,
    'changed after preview\n',
    'the hidden staged content is what got committed',
  );
  assert.equal(committed.status.repo.headSha, committed.headSha);
});

test('stage "all" affects the whole repository even when the display list is truncated', async (t) => {
  const f = createFixture(t, 'stageallfull');
  f.init();
  f.write('seed.txt', 'seed\n');
  f.addAll();
  f.commit('seed');
  const total = CAPS.maxStatusEntries + 3;
  for (let i = 0; i < total; i++) f.write(`bulk/f${String(i).padStart(4, '0')}.txt`, `file ${i}\n`);
  const git = newGit();
  const repo = await git.resolveRepo(f.dir);
  const displayed = await git.status(repo);
  assert.equal(displayed.summary.truncated, true);
  assert.equal(displayed.entries.length, CAPS.maxStatusEntries);
  // The Host validates "all" against the true scope, so the expected set must be
  // built from the full (untruncated) read.
  const full = await git.status(repo, { maxEntries: Number.POSITIVE_INFINITY });
  assert.equal(full.entries.length, total);
  const staged = await git.stage(repo, {
    keys: 'all',
    includeUntracked: true,
    expected: expectedStageAll(full),
    status: displayed,
  });
  assert.equal(staged.affected.length, total);
  const after = await git.status(repo);
  assert.equal(after.summary.staged, CAPS.maxStatusEntries, 'summary counts only the returned rows');
  assert.equal(after.summary.truncated, true);
  const cachedNames = f.git(['diff', '--cached', '--name-only', '-z']).stdout.toString('utf8').split('\u0000').filter(Boolean);
  assert.equal(cachedNames.length, total, 'every worktree change was staged, not only the displayed ones');
  // An incomplete expectation (only the displayed rows) is refused as stale.
  f.write('bulk/f0000.txt', 'edit again\n');
  const truncatedExpected = expectedStageAll(displayed);
  await expectGitError(
    git.stage(repo, { keys: 'all', includeUntracked: true, expected: truncatedExpected, status: after }),
    'entry/stale',
  );

  // unstage "all" is the mirror image: it validates and moves the whole staged
  // set, including entries hidden behind the display cap.
  const fullStaged = await git.status(repo, { maxEntries: Number.POSITIVE_INFINITY });
  assert.equal(fullStaged.entries.filter((entry) => entry.status === 'staged').length, total);
  const unstaged = await git.unstage(repo, {
    keys: 'all',
    expected: expectedUnstageAll(fullStaged),
    status: after,
  });
  assert.equal(unstaged.affected.length, total);
  const finalStatus = await git.status(repo);
  assert.equal(finalStatus.summary.staged, 0);
  assert.equal(finalStatus.summary.untrackedFiles, CAPS.maxStatusEntries, 'the untracked rows are back (truncated display)');
  const cachedAfter = f.git(['diff', '--cached', '--name-only']).stdout.toString('utf8').trim();
  assert.equal(cachedAfter, '', 'the complete index was unstaged');
  assert.deepEqual(f.read('bulk/f0001.txt'), Buffer.from('file 1\n'), 'unstaging never touches the worktree');
});

test('executor timeout and output caps map to stable protocol errors', async (t) => {
  const nodePath = process.execPath;
  const hanging = createNodeExecutor({ gitPath: nodePath, timeoutMs: 150 });
  await assert.rejects(
    hanging.run(['git', '-e', 'setTimeout(() => process.exit(0), 30000)']),
    (error) => error && error.code === 'timeout',
  );
  const chatty = createNodeExecutor({ gitPath: nodePath, maxOutputBytes: 4096 });
  await assert.rejects(
    chatty.run(['git', '-e', 'process.stdout.write("x".repeat(200000))']),
    (error) => error && error.code === 'output-too-large',
  );
  const timeoutSurface = createGit({
    run: () => Promise.reject(Object.assign(new Error('timed out'), { code: 'timeout' })),
  });
  await expectGitError(timeoutSurface.gitVersion(), 'repo/timeout');
  const largeSurface = createGit({
    run: () => Promise.reject(Object.assign(new Error('too large'), { code: 'output-too-large' })),
  });
  await expectGitError(largeSurface.gitVersion(), 'repo/output-too-large');
});

test('push preview compares against the remote-tracking ref and separates source/target', async (t) => {
  const parent = makeTempDir('pushtarget');
  t.after(() => removeTree(parent));
  const f = createFixture(t, 'pushtargetrepo');
  f.init();
  f.write('a.txt', 'a\n');
  f.addAll();
  f.commit('c1');
  const bare = bareRemoteAt(t, parent, 'origin.git');
  f.git(['remote', 'add', 'origin', bare.replace(/\\/g, '/')]);
  f.git(['push', '-q', '-u', 'origin', 'main']);
  const git = newGit();

  // Local main has one unpushed commit.
  f.write('a.txt', 'a2\n');
  f.addAll();
  f.commit('c2');
  let repo = await git.resolveRepo(f.dir);
  let status = await git.status(repo);
  let preview = await git.pushPreview(repo, { status });
  assert.equal(preview.sourceBranch, 'main');
  assert.equal(preview.targetBranch, 'main');
  assert.equal(preview.remote, 'origin');
  assert.equal(preview.commitsBase, 'refs/remotes/origin/main');
  assert.deepEqual(preview.commits.map((commit) => commit.subject), ['c2']);

  // A different target branch has no remote-tracking ref yet: first-push fallback.
  preview = await git.pushPreview(repo, { status, targetBranch: 'release' });
  assert.equal(preview.sourceBranch, 'main');
  assert.equal(preview.targetBranch, 'release');
  assert.equal(preview.commitsBase, null);
  assert.deepEqual(preview.commits.map((commit) => commit.subject), ['c2', 'c1']);

  // Push the local main to the differently-named remote branch and track it.
  let pushed = await git.push(repo, { targetBranch: 'release', setUpstream: true, status });
  assert.equal(pushed.sourceBranch, 'main');
  assert.equal(pushed.targetBranch, 'release');
  assert.equal(pushed.branch, 'main');
  assert.equal(runGit(bare, ['rev-parse', 'refs/heads/release']).out.trim(), f.headSha());
  assert.equal(f.git(['config', '--get', 'branch.main.merge']).out.trim(), 'refs/heads/release');
  repo = await git.resolveRepo(f.dir);
  status = await git.status(repo);
  preview = await git.pushPreview(repo, { status });
  assert.equal(preview.commitsBase, 'refs/remotes/origin/release');
  assert.equal(preview.targetBranch, 'release', 'the configured upstream target is used by default');
  assert.deepEqual(preview.commits, []);

  // A different target than the upstream is allowed (no upstream rewrite).
  pushed = await git.push(repo, { targetBranch: 'main', status });
  assert.equal(pushed.targetBranch, 'main');
  assert.equal(f.git(['config', '--get', 'branch.main.merge']).out.trim(), 'refs/heads/release');
  assert.equal(runGit(bare, ['rev-parse', 'refs/heads/main']).out.trim(), f.headSha());

  // A second remote is selectable, and its tracking ref drives the preview.
  const backup = bareRemoteAt(t, parent, 'backup.git');
  f.git(['remote', 'add', 'backup', backup.replace(/\\/g, '/')]);
  repo = await git.resolveRepo(f.dir);
  status = await git.status(repo);
  pushed = await git.push(repo, { remote: 'backup', targetBranch: 'main', setUpstream: true, status });
  assert.equal(pushed.remote, 'backup');
  assert.equal(runGit(backup, ['rev-parse', 'refs/heads/main']).out.trim(), f.headSha());
  repo = await git.resolveRepo(f.dir);
  status = await git.status(repo);
  preview = await git.pushPreview(repo, { status, remote: 'backup', targetBranch: 'main' });
  assert.equal(preview.remote, 'backup');
  assert.equal(preview.commitsBase, 'refs/remotes/backup/main');
  assert.deepEqual(preview.commits, []);
  const missingRemote = await git.pushPreview(repo, { status, remote: 'nowhere' });
  assert.equal(missingRemote.canPush, false);
  assert.match(missingRemote.reason, /unknown remote/);
  await expectGitError(git.push(repo, { remote: 'nowhere', status }), 'push/no-remote');

  // Detached HEAD cannot be pushed and the preview says why.
  f.git(['checkout', '-q', '--detach', 'HEAD']);
  repo = await git.resolveRepo(f.dir);
  status = await git.status(repo);
  preview = await git.pushPreview(repo, { status });
  assert.equal(preview.sourceBranch, null);
  assert.equal(preview.canPush, false);
  assert.match(preview.reason, /detached HEAD/);
  await expectGitError(git.push(repo, { status }), 'push/no-branch');
});

test('status and diff identify oversized blobs without loading their content', async (t) => {
  const bigContent = 'a\n'.repeat(Math.ceil(MAX_SIDE_BYTES / 2) + 5);
  const { f } = await committedFixture(t, 'bigident', { 'big.txt': bigContent });
  f.write('big.txt', `A\n${bigContent.slice(2)}`);
  f.git(['add', '--', 'big.txt']);
  const { git, calls } = newRecordingGit();
  const repo = await git.resolveRepo(f.dir);
  const status = await git.status(repo);
  const staged = entryOf(status, 'staged:big.txt');
  assert.equal(staged.kind, 'text');
  // The fingerprint of a git-object side is its object id, not a content hash:
  // the status read never has to buffer the blob.
  assert.match(staged.fingerprint.base, /^[0-9a-f]{40,64}$/);
  assert.match(staged.fingerprint.target, /^[0-9a-f]{40,64}$/);
  const diff = await git.diff(repo, staged.key, { status });
  assert.equal(diff.base.tooLarge, true);
  assert.equal(diff.target.tooLarge, true);
  assert.equal(diff.base.bytes > MAX_SIDE_BYTES, true);
  assert.equal(diff.target.bytes > MAX_SIDE_BYTES, true);
  assert.equal(diff.base.text, '');
  assert.equal(diff.target.text, '');
  assert.equal(diff.unsupported.code, 'too-large');
  const contentReads = calls.filter((call) => call.argv[1] === 'cat-file' && call.argv.includes('--batch'));
  assert.deepEqual(contentReads, [], 'status/diff must not load oversized blob content');
});

test('fingerprints from status and diff agree for every supported entry kind', async (t) => {
  const { f, git, repo } = await committedFixture(t, 'fpuniform', {
    'modified.txt': 'one\ntwo\n',
    'deleted.txt': 'gone\n',
    'staged.txt': 'staged base\n',
  });
  f.write('modified.txt', 'one\ntwo\nthree\n');
  f.remove('deleted.txt');
  f.write('staged.txt', 'staged v2\n');
  f.git(['add', '--', 'staged.txt']);
  f.write('untracked.txt', 'new file\n');
  f.write('binary.dat', Buffer.from([0, 1, 2, 255]));
  const status = await freshStatus(git, repo);
  for (const entry of status.entries) {
    const diff = await git.diff(repo, entry.key, { status });
    assert.deepEqual(diff.entry.fingerprint, entry.fingerprint, `status and diff fingerprints differ for ${entry.key}`);
    assert.equal(diff.repo.root, repo.root);
  }
});
test('gitVersion and status payload shape for the host half', async (t) => {
  const { git, repo } = await committedFixture(t, 'payload', { 'f.txt': 'a\n' });
  const version = await git.gitVersion();
  assert.match(version, /^\d+\.\d+/);
  assert.equal(await git.gitVersion(), version);
  const status = await git.status(repo);
  assert.equal('gitVersion' in status, false, 'the host half adds gitVersion itself');
  assert.equal(status.state, 'ok');
  assert.equal(status.cwd, repo.root);
  assert.equal(typeof status.generatedAt, 'number');
  assert.equal(typeof status.stagedFingerprint, 'string');
  assert.deepEqual(Object.keys(status.summary).sort(), [
    'conflicts', 'entries', 'files', 'staged', 'stagedAdditions', 'stagedDeletions',
    'truncated', 'unstaged', 'unstagedAdditions', 'unstagedDeletions', 'untracked', 'untrackedFiles',
  ]);
  // diff of an unknown key is entry/not-found
  await expectGitError(git.diff(repo, 'unstaged:does-not-exist.txt', { status }), 'entry/not-found');
});


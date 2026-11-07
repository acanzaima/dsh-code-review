import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Load the client-bundle module exactly the way the bundle loader would.
const src = readFileSync(new URL('../src/client/diff.js', import.meta.url), 'utf8');
const diff = {};
new Function('__def', src)((name, fn) => fn(diff, () => ({}), {}));

const {
  buildSideBySide,
  changeAnchors,
  defaultExpanded,
  detectLanguage,
  highlight,
  findNextChange,
  buildRows,
  highlightLine,
  rowCount,
  rowIndexToOriginal,
  findNextChangeInRows
} = diff;

const ALLOWED_CLASSES = new Set(['kw', 'str', 'num', 'com', 'id', 'punc']);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function countLines(text) {
  if (text === '') return 0;
  const parts = text.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

// The exact line splitting rules the engine documents for displayed text:
// no CR from CRLF, no invented trailing empty line.
function expectedDisplayLines(text) {
  if (text === '') return [''];
  const parts = text.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function side(label, text, extra = {}) {
  return {
    label,
    ref: `${label.toLowerCase()}:f.txt`,
    exists: true,
    binary: false,
    tooLarge: false,
    truncated: false,
    encoding: 'utf8',
    bytes: text.length,
    lines: countLines(text),
    text,
    ...extra
  };
}

function missingSide(label = 'Empty') {
  return {
    label,
    ref: 'empty',
    exists: false,
    binary: false,
    tooLarge: false,
    truncated: false,
    encoding: 'utf8',
    bytes: 0,
    lines: 0,
    text: ''
  };
}

function hl(line) {
  return { kind: line[0], text: line.slice(1), oldLine: 0, newLine: 0 };
}

function hunk(index, oldStart, oldLines, newStart, newLines, lines) {
  return {
    index,
    header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
    oldStart,
    oldLines,
    newStart,
    newLines,
    section: '',
    lines: lines.map(hl),
    patch: ''
  };
}

function countStats(hunks) {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.kind === '+') additions += 1;
      else if (line.kind === '-') deletions += 1;
    }
  }
  return { additions, deletions };
}

function entryDiff({ base, target, hunks = [], unsupported = null, modeChange = null, path = 'f.txt' }) {
  return {
    repo: {
      root: 'C:/repo', gitDir: 'C:/repo/.git', branch: 'main', detached: false, headSha: 'abc123',
      upstream: 'origin/main', ahead: 0, behind: 0, remotes: [], worktree: false
    },
    entry: {
      key: `unstaged:${path}`, status: 'unstaged', change: 'modified', path, oldPath: null, kind: 'text',
      isUntracked: false, hasBothSides: false, additions: 0, deletions: 0,
      fingerprint: { base: 'base', target: 'target' }
    },
    comparison: {
      baseLabel: 'Index', targetLabel: 'Worktree',
      baseRef: `index:${path}`, targetRef: `worktree:${path}`
    },
    base,
    target,
    hunks,
    stats: countStats(hunks),
    unsupported,
    modeChange
  };
}

function fileText(count, fn = (i) => `line ${i}`) {
  const out = [];
  for (let i = 1; i <= count; i++) out.push(fn(i));
  return out.join('\n');
}

function mkHunkLine(kind, text) {
  return kind + text;
}

// Full-file fixture: 60 untouched-line file with changes on line 2 and line 54,
// so reconstructing the whole file (not just the patch) is required.
function bigFixture() {
  const baseLines = [];
  const targetLines = [];
  for (let i = 1; i <= 60; i++) {
    baseLines.push(`line ${i}`);
    targetLines.push(i === 2 ? 'line 2 changed' : i === 54 ? 'line 54 changed' : `line ${i}`);
  }
  const base = side('Index', baseLines.join('\n'));
  const target = side('Worktree', targetLines.join('\n'));
  const h1 = hunk(0, 1, 5, 1, 5, [' line 1', '-line 2', '+line 2 changed', ' line 3', ' line 4', ' line 5']);
  const h2 = hunk(1, 53, 5, 53, 5, [' line 53', '-line 54', '+line 54 changed', ' line 55', ' line 56', ' line 57']);
  return entryDiff({ base, target, hunks: [h1, h2], path: 'src/big.js' });
}

// 20-line file with changes on line 2 and line 10: a 4-row gap (small, expanded
// by default) plus a large untouched tail (collapsed by default).
function smallGapFixture() {
  const baseLines = [];
  const targetLines = [];
  for (let i = 1; i <= 20; i++) {
    baseLines.push(`line ${i}`);
    targetLines.push(i === 2 ? 'LINE 2' : i === 10 ? 'LINE 10' : `line ${i}`);
  }
  const base = side('Index', baseLines.join('\n'));
  const target = side('Worktree', targetLines.join('\n'));
  const h1 = hunk(0, 1, 4, 1, 4, [' line 1', '-line 2', '+LINE 2', ' line 3', ' line 4']);
  const h2 = hunk(1, 9, 4, 9, 4, [' line 9', '-line 10', '+LINE 10', ' line 11', ' line 12']);
  return entryDiff({ base, target, hunks: [h1, h2] });
}

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

function assertModelInvariants(model, { baseLineCount, targetLineCount } = {}) {
  assert.equal(Array.isArray(model.rows), true, 'rows is an array');
  assert.equal(model.rowCount, model.rows.length);

  const leftNos = [];
  const rightNos = [];
  let changeCursor = -1;

  model.hunkRowRanges.forEach((range) => {
    assert.equal(typeof range.index, 'number');
    assert.ok(range.start >= 0 && range.end >= range.start);
    assert.ok(range.start >= changeCursor, 'hunk row ranges are ordered');
    changeCursor = range.end;
  });

  for (let i = 0; i < model.rows.length; i++) {
    const row = model.rows[i];
    assert.equal(typeof row, 'object');
    assert.equal(row.left.kind === 'ctx', row.right.kind === 'ctx', `ctx pairing on row ${i}`);
    assert.equal(typeof row.left.text, 'string');
    assert.equal(typeof row.right.text, 'string');
    assert.ok(row.left.no === null || Number.isInteger(row.left.no), `left line number on row ${i}`);
    assert.ok(row.right.no === null || Number.isInteger(row.right.no), `right line number on row ${i}`);
    assert.ok(['ctx', 'add', 'del', 'empty'].includes(row.left.kind));
    assert.ok(['ctx', 'add', 'del', 'empty'].includes(row.right.kind));

    if (row.change === true) {
      assert.ok(row.left.kind === 'del' || row.left.kind === 'empty', `change row ${i} left kind`);
      assert.ok(row.right.kind === 'add' || row.right.kind === 'empty', `change row ${i} right kind`);
      assert.ok(!(row.left.kind === 'empty' && row.right.kind === 'empty'), `change row ${i} not empty`);
      assert.equal(typeof row.hunkIndex, 'number', `change row ${i} hunkIndex`);
    } else if (row.truncationRow !== true) {
      assert.equal(row.left.kind, 'ctx', `non-change row ${i} left ctx`);
      assert.equal(row.right.kind, 'ctx', `non-change row ${i} right ctx`);
      assert.ok(row.hunkIndex === null || typeof row.hunkIndex === 'number');
    }

    if (row.left.kind === 'ctx' || row.left.kind === 'del') leftNos.push(row.left.no);
    if (row.right.kind === 'ctx' || row.right.kind === 'add') rightNos.push(row.right.no);

    if (row.left.kind !== 'ctx' && row.left.kind !== 'empty') assert.ok(row.left.no !== null);
    if (row.right.kind !== 'ctx' && row.right.kind !== 'empty') assert.ok(row.right.no !== null);
  }

  // no base / target line is ever lost, and line numbers are 1..N in order
  leftNos.forEach((no, i) => assert.equal(no, i + 1, 'left column line numbering'));
  rightNos.forEach((no, i) => assert.equal(no, i + 1, 'right column line numbering'));
  if (baseLineCount !== undefined) assert.equal(leftNos.length, baseLineCount, 'all base lines present');
  if (targetLineCount !== undefined) assert.equal(rightNos.length, targetLineCount, 'all target lines present');

  // changeRowIndexes is exactly the change rows, ascending
  const expectedChanges = [];
  model.rows.forEach((row, i) => {
    if (row.change) expectedChanges.push(i);
  });
  assert.deepEqual(model.changeRowIndexes, expectedChanges);

  // blocks are maximal runs of change rows
  assert.equal(Array.isArray(model.changeBlocks), true);
  for (const block of model.changeBlocks) {
    for (let i = block.start; i < block.end; i++) assert.equal(model.rows[i].change, true);
    if (block.start > 0) assert.notEqual(model.rows[block.start - 1].change, true);
    if (block.end < model.rows.length) assert.notEqual(model.rows[block.end].change, true);
  }
  assert.equal(
    model.changeBlocks.reduce((sum, block) => sum + (block.end - block.start), 0),
    expectedChanges.length
  );

  // gaps are maximal runs of untouched rows (never including marker rows)
  assert.equal(Array.isArray(model.gaps), true);
  for (const gap of model.gaps) {
    assert.ok(gap.rows === gap.end - gap.start && gap.rows > 0);
    for (let i = gap.start; i < gap.end; i++) {
      assert.notEqual(model.rows[i].change, true);
      assert.notEqual(model.rows[i].truncationRow, true);
    }
  }
}

// ---------------------------------------------------------------------------
// module shape
// ---------------------------------------------------------------------------

test('module exposes the contract API plus documented renderer helpers', () => {
  assert.equal(typeof buildSideBySide, 'function');
  assert.equal(typeof changeAnchors, 'function');
  assert.equal(typeof defaultExpanded, 'function');
  assert.equal(typeof detectLanguage, 'function');
  assert.equal(typeof highlight, 'function');
  assert.equal(typeof findNextChange, 'function');
  assert.equal(typeof buildRows, 'function');
  assert.equal(typeof highlightLine, 'function');
  assert.equal(typeof rowCount, 'function');
  assert.equal(typeof rowIndexToOriginal, 'function');
  assert.equal(typeof findNextChangeInRows, 'function');
});

test('module tolerates a missing / malformed EntryDiff', () => {
  for (const input of [undefined, null, {}, { base: {}, target: {} }]) {
    const model = buildSideBySide(input);
    assert.equal(Array.isArray(model.rows), true);
    assert.equal(model.language, null);
    assert.deepEqual(model.changeRowIndexes, []);
    assert.deepEqual(buildRows(model, defaultExpanded(model)), []);
    assert.deepEqual(changeAnchors(model), []);
  }
  // a completely missing payload can never claim full context
  for (const input of [undefined, null, {}]) {
    assert.equal(buildSideBySide(input).hasFullContext, false);
  }
  assert.equal(buildSideBySide({ base: {}, target: {} }).rows.length, 0);
});

// ---------------------------------------------------------------------------
// core alignment cases required by docs/protocol.md section 5
// ---------------------------------------------------------------------------

test('pure insertion', () => {
  const base = side('Index', fileText(5));
  const target = side('Worktree', fileText(7, (i) => (i === 3 ? 'inserted a' : i === 4 ? 'inserted b' : i <= 2 ? `line ${i}` : `line ${i - 2}`)));
  const h = hunk(0, 2, 0, 3, 2, ['+inserted a', '+inserted b']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));

  assertModelInvariants(model, { baseLineCount: 5, targetLineCount: 7 });
  assert.equal(model.hasFullContext, true);
  assert.equal(model.rows.length, 7);
  assert.deepEqual(model.changeRowIndexes, [2, 3]);
  assert.equal(model.rows[1].left.text, 'line 2');
  assert.equal(model.rows[2].left.kind, 'empty');
  assert.equal(model.rows[2].right.kind, 'add');
  assert.equal(model.rows[2].right.text, 'inserted a');
  assert.equal(model.rows[2].right.no, 3);
  assert.equal(model.rows[4].left.text, 'line 3');
  assert.equal(model.rows[4].right.text, 'line 3');
  assert.equal(model.rows[6].right.text, 'line 5');
  assert.equal(model.hunkRowRanges.length, 1);
  assert.equal(model.hunkRowRanges[0].start, 2);
  assert.equal(model.hunkRowRanges[0].end, 4);
});

test('pure deletion', () => {
  const base = side('Index', fileText(7));
  const target = side('Worktree', fileText(5));
  const h = hunk(0, 3, 2, 2, 0, ['-line 3', '-line 4']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));

  assertModelInvariants(model, { baseLineCount: 7, targetLineCount: 5 });
  assert.equal(model.rows.length, 7);
  assert.deepEqual(model.changeRowIndexes, [2, 3]);
  assert.equal(model.rows[2].left.kind, 'del');
  assert.equal(model.rows[2].left.text, 'line 3');
  assert.equal(model.rows[2].right.kind, 'empty');
  assert.equal(model.rows[3].left.no, 4);
  assert.equal(model.rows[4].left.text, 'line 5');
  assert.equal(model.rows[4].right.text, 'line 3');
});

test('replacement with unequal line counts keeps both columns aligned pairwise', () => {
  const base = side('Index', fileText(5));
  const target = side('Worktree', 'line 1\nline 2\nX\nY\nZ\nline 5');
  const h = hunk(0, 3, 2, 3, 3, ['-line 3', '-line 4', '+X', '+Y', '+Z']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));

  assertModelInvariants(model, { baseLineCount: 5, targetLineCount: 6 });
  assert.equal(model.rows.length, 6);
  assert.deepEqual(model.changeRowIndexes, [2, 3, 4]);
  assert.equal(model.rows[2].left.text, 'line 3');
  assert.equal(model.rows[2].right.text, 'X');
  assert.equal(model.rows[3].left.text, 'line 4');
  assert.equal(model.rows[3].right.text, 'Y');
  assert.equal(model.rows[4].left.kind, 'empty');
  assert.equal(model.rows[4].left.no, null);
  assert.equal(model.rows[4].right.text, 'Z');
  assert.equal(model.rows[4].right.no, 5);
  // one change block, three rows
  assert.equal(model.changeBlocks.length, 1);
  assert.deepEqual(model.changeBlocks[0], { start: 2, end: 5, hunkIndex: 0 });
});

test('interleaved deletion/addition lines inside one hunk form a single change block', () => {
  const base = side('Index', fileText(4));
  const target = side('Worktree', 'line 1\nA\nline 3\nline 4');
  const h = hunk(0, 1, 3, 1, 3, [' line 1', '-line 2', '+A', ' line 3']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));
  assertModelInvariants(model, { baseLineCount: 4, targetLineCount: 4 });
  assert.equal(model.changeBlocks.length, 1);
  assert.equal(model.rows[1].left.text, 'line 2');
  assert.equal(model.rows[1].right.text, 'A');
});

test('adjacent hunks keep separate hunk indexes on rows', () => {
  const base = side('Index', fileText(6));
  const target = side('Worktree', 'line 1\nLINE 2\nLINE 3\nline 4\nline 5\nline 6');
  const h1 = hunk(0, 2, 1, 2, 1, ['-line 2', '+LINE 2']);
  const h2 = hunk(1, 3, 1, 3, 1, ['-line 3', '+LINE 3']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h1, h2] }));

  assertModelInvariants(model, { baseLineCount: 6, targetLineCount: 6 });
  assert.equal(model.rows.length, 6);
  assert.deepEqual(model.changeRowIndexes, [1, 2]);
  assert.deepEqual(model.hunkRowRanges, [
    { index: 0, start: 1, end: 2 },
    { index: 1, start: 2, end: 3 }
  ]);
  assert.equal(model.rows[1].hunkIndex, 0);
  assert.equal(model.rows[2].hunkIndex, 1);

  // the two rows are contiguous, so they are one visual change block / anchor,
  // but each row keeps the hunk index needed for per-hunk operations
  assert.equal(model.changeBlocks.length, 1);
  assert.deepEqual(model.changeBlocks[0], { start: 1, end: 3, hunkIndex: 0 });
  const anchors = changeAnchors(model);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].index, 1);
  assert.equal(anchors[0].height, 2 / 6);
});

test('single-line file', () => {
  const base = side('Index', 'x');
  const target = side('Worktree', 'y');
  const h = hunk(0, 1, 1, 1, 1, ['-x', '+y']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));

  assertModelInvariants(model, { baseLineCount: 1, targetLineCount: 1 });
  assert.equal(model.rows.length, 1);
  assert.deepEqual(model.changeRowIndexes, [0]);
  assert.equal(model.rows[0].left.text, 'x');
  assert.equal(model.rows[0].right.text, 'y');
  assert.equal(model.gaps.length, 0);

  const anchors = changeAnchors(model);
  assert.deepEqual(anchors, [{ index: 0, top: 0, height: 1, hunkIndex: 0 }]);
});

test('untracked file (empty base side)', () => {
  const target = side('Worktree', 'alpha\nbeta\ngamma');
  const h = hunk(0, 0, 0, 1, 3, ['+alpha', '+beta', '+gamma']);
  const model = buildSideBySide(entryDiff({ base: missingSide(), target, hunks: [h] }));

  assertModelInvariants(model, { baseLineCount: 0, targetLineCount: 3 });
  assert.equal(model.rows.length, 3);
  assert.equal(model.hasFullContext, true);
  for (const row of model.rows) {
    assert.equal(row.change, true);
    assert.equal(row.left.kind, 'empty');
    assert.equal(row.right.kind, 'add');
  }
  assert.deepEqual(model.changeRowIndexes, [0, 1, 2]);
  assert.equal(model.changeBlocks.length, 1);
});

test('deleted file (empty target side)', () => {
  const base = side('Index', 'alpha\nbeta\ngamma');
  const h = hunk(0, 1, 3, 0, 0, ['-alpha', '-beta', '-gamma']);
  const model = buildSideBySide(entryDiff({ base, target: missingSide(), hunks: [h] }));

  assertModelInvariants(model, { baseLineCount: 3, targetLineCount: 0 });
  assert.equal(model.rows.length, 3);
  assert.equal(model.hasFullContext, true);
  assert.ok(model.rows.every((row) => row.left.kind === 'del' && row.right.kind === 'empty'));
});

test('empty file on both sides', () => {
  const model = buildSideBySide(entryDiff({ base: side('Index', ''), target: side('Worktree', ''), hunks: [] }));
  assert.equal(model.rows.length, 0);
  assert.equal(model.hasFullContext, true);
  assert.deepEqual(model.changeRowIndexes, []);
  assert.deepEqual(model.gaps, []);
  assert.deepEqual(defaultExpanded(model), []);
  assert.deepEqual(buildRows(model, []), []);
  assert.deepEqual(model.stats, { additions: 0, deletions: 0 });
});

test('file ending without a trailing newline does not gain an empty line', () => {
  const base = side('Index', 'a\nb\nc');
  const target = side('Worktree', 'a\nb\nC');
  const h = hunk(0, 3, 1, 3, 1, ['-c', '+C']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));

  assertModelInvariants(model, { baseLineCount: 3, targetLineCount: 3 });
  assert.equal(model.rows.length, 3);
  assert.equal(model.rows[2].left.text, 'c');
  assert.equal(model.rows[2].right.text, 'C');

  // also check the line counter itself, with no hunks at all
  const same = buildSideBySide(entryDiff({ base: side('Index', 'x\ny'), target: side('Worktree', 'x\ny'), hunks: [] }));
  assert.equal(same.rows.length, 2);
  assert.equal(same.hasFullContext, true);
});

test('full-file comparison shows untouched regions outside the +-3 hunk context', () => {
  const model = buildSideBySide(bigFixture());
  assertModelInvariants(model, { baseLineCount: 60, targetLineCount: 60 });

  assert.equal(model.rows.length, 60);
  assert.equal(model.hasFullContext, true);
  assert.equal(model.language, 'js');
  assert.deepEqual(model.hunkRowRanges, [
    { index: 0, start: 0, end: 5 },
    { index: 1, start: 52, end: 57 }
  ]);
  assert.deepEqual(model.changeRowIndexes, [1, 53]);

  // lines 6..52 are far outside both hunks, yet still present as context rows
  const line6 = model.rows[5];
  assert.equal(line6.hunkIndex, null);
  assert.equal(line6.left.no, 6);
  assert.equal(line6.left.text, 'line 6');
  assert.equal(line6.right.no, 6);
  assert.equal(line6.right.text, 'line 6');

  // hunk context rows still belong to their hunk
  assert.equal(model.rows[0].hunkIndex, 0);
  assert.equal(model.rows[0].left.no, 1);
  assert.equal(model.rows[4].hunkIndex, 0);
  assert.equal(model.rows[4].left.no, 5);
  assert.equal(model.rows[52].hunkIndex, 1);
  assert.equal(model.rows[56].left.no, 57);
  assert.equal(model.rows[59].hunkIndex, null);
  assert.equal(model.rows[59].left.no, 60);

  assert.deepEqual(model.gaps, [
    { index: 0, start: 0, end: 1, rows: 1 },
    { index: 1, start: 2, end: 53, rows: 51 },
    { index: 2, start: 54, end: 60, rows: 6 }
  ]);
  // untouched runs are treated as gaps wherever they sit, including hunk context
  assert.deepEqual(defaultExpanded(model), [true, false, true]);
  assert.deepEqual(model.changeBlocks, [
    { start: 1, end: 2, hunkIndex: 0 },
    { start: 53, end: 54, hunkIndex: 1 }
  ]);
});

test('CRLF text is displayed without carriage returns while line counts stay correct', () => {
  const base = side('Index', 'a\r\nb\r\nc\r\n');
  const target = side('Worktree', 'a\r\nB\r\nc');
  const h = hunk(0, 1, 3, 1, 3, [' a', '-b', '+B', ' c']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));

  assertModelInvariants(model, { baseLineCount: 3, targetLineCount: 3 });
  assert.equal(model.rows.length, 3);
  for (const row of model.rows) {
    assert.ok(!row.left.text.includes('\r'), `left row ${JSON.stringify(row.left.text)} has no CR`);
    assert.ok(!row.right.text.includes('\r'), `right row ${JSON.stringify(row.right.text)} has no CR`);
  }
  assert.equal(model.rows[0].left.text, 'a');
  assert.equal(model.rows[1].left.text, 'b');
  assert.equal(model.rows[1].right.text, 'B');

  // CRLF outside hunks, reconstructed from the side texts alone
  const noHunks = buildSideBySide(entryDiff({
    base: side('Index', 'x\r\ny\r\n'),
    target: side('Worktree', 'x\r\ny\r\n'),
    hunks: []
  }));
  assert.equal(noHunks.rows.length, 2);
  assert.deepEqual(noHunks.rows.map((row) => row.left.text), ['x', 'y']);
});

test('CJK text is preserved', () => {
  const base = side('Index', '你好\n世界\n再见');
  const target = side('Worktree', '你好\n世界！\n再见');
  const h = hunk(0, 1, 3, 1, 3, [' 你好', '-世界', '+世界！', ' 再见']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));

  assertModelInvariants(model, { baseLineCount: 3, targetLineCount: 3 });
  assert.equal(model.rows[0].left.text, '你好');
  assert.equal(model.rows[1].left.text, '世界');
  assert.equal(model.rows[1].right.text, '世界！');
  assert.equal(model.rows[2].right.text, '再见');

  const tokens = highlight('const 变量 = "值"; // 注释', 'js');
  assert.equal(tokens[0].spans.map((span) => span.text).join(''), 'const 变量 = "值"; // 注释');
});

test('tabs are preserved in the model (renderer owns tab width)', () => {
  const base = side('Index', '\tif (x) {\r\n\t\treturn 1;\r\n\t}');
  const target = side('Worktree', '\tif (x) {\r\n\t\treturn 2;\r\n\t}');
  const h = hunk(0, 1, 3, 1, 3, [' \tif (x) {', '-\t\treturn 1;', '+\t\treturn 2;', ' \t}']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));
  assert.equal(model.rows[1].left.text, '\t\treturn 1;');
  assert.equal(model.rows[1].right.text, '\t\treturn 2;');
});

test('mode-only diff with no hunks', () => {
  const text = fileText(5);
  const ed = entryDiff({
    base: side('Index', text),
    target: side('Worktree', text),
    hunks: [],
    unsupported: { code: 'mode-only', message: 'file mode changed' },
    modeChange: { oldMode: '100644', newMode: '100755' }
  });
  const model = buildSideBySide(ed);

  assertModelInvariants(model, { baseLineCount: 5, targetLineCount: 5 });
  assert.equal(model.hasFullContext, false, 'unsupported marks context as incomplete');
  assert.equal(model.rows.length, 5);
  assert.deepEqual(model.changeRowIndexes, []);
  assert.deepEqual(model.changeBlocks, []);
  assert.deepEqual(model.gaps, []);
  assert.deepEqual(defaultExpanded(model), []);
  assert.deepEqual(buildRows(model, []).map((row) => row.left.text), ['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
  assert.deepEqual(changeAnchors(model), []);
  assert.deepEqual(model.modeChange, { oldMode: '100644', newMode: '100755' });
  assert.equal(model.stats.additions, 0);
  assert.equal(model.stats.deletions, 0);
});

test('binary diff produces no rows and never claims full context', () => {
  const binary = side('Index', '', { binary: true, encoding: 'binary', bytes: 120 });
  const binaryTarget = side('Worktree', '', { binary: true, encoding: 'binary', bytes: 140 });
  const model = buildSideBySide(entryDiff({
    base: binary,
    target: binaryTarget,
    hunks: [],
    unsupported: { code: 'binary', message: 'binary files differ' }
  }));

  assert.equal(model.rows.length, 0);
  assert.equal(model.hasFullContext, false);
  assert.deepEqual(model.changeRowIndexes, []);
  assert.deepEqual(buildRows(model, defaultExpanded(model)), []);
  assert.equal(rowCount(buildRows(model, [])), 0);

  // one side binary is enough
  const halfBinary = buildSideBySide(entryDiff({
    base: side('Index', 'text\nfile'),
    target: side('Worktree', '', { binary: true, encoding: 'binary' }),
    hunks: [],
    unsupported: { code: 'binary', message: 'binary files differ' }
  }));
  assert.equal(halfBinary.hasFullContext, false);
  assert.equal(halfBinary.rows.length, 0);
});

test('truncated side clamps to complete lines and marks a truncation row', () => {
  const base = side('Index', 'a\nb\nTRUNCATED-FRAGMENT-MUST-NOT-APPEAR', { truncated: true, bytes: 999999 });
  const target = side('Worktree', 'a\nb\nc\nd\n');
  const h = hunk(0, 1, 3, 1, 3, [' a', ' b', '-actual line three', '+c']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));

  assert.equal(model.hasFullContext, false);
  assert.deepEqual(model.truncatedSides, ['base']);
  assert.equal(model.rows.length, 4);
  const truncationRows = model.rows.filter((row) => row.truncationRow === true);
  assert.equal(truncationRows.length, 1);
  assert.deepEqual(truncationRows[0].truncatedSides, ['base']);
  assert.equal(truncationRows[0].hunkIndex, null);
  // the incomplete fragment of the truncated text is never displayed as a line
  for (const row of model.rows) {
    assert.ok(!row.left.text.includes('TRUNCATED-FRAGMENT'), 'partial tail is dropped');
    assert.ok(!row.right.text.includes('TRUNCATED-FRAGMENT'));
  }
  // only the complete prefix lines are taken from the truncated text
  assert.deepEqual(model.rows.slice(0, 2).map((row) => row.left.text), ['a', 'b']);
  // truncation row survives collapsing and never becomes part of a gap
  const rendered = buildRows(model, defaultExpanded(model));
  assert.ok(rendered.some((row) => row.truncationRow === true));
  assert.deepEqual(model.gaps, [{ index: 0, start: 0, end: 2, rows: 2 }]);
});

test('truncated text that ends at a line boundary still marks the cut', () => {
  const base = side('Index', 'a\nb\n', { truncated: true });
  const target = side('Worktree', 'a\nb2');
  const h = hunk(0, 1, 2, 1, 2, [' a', '-b', '+b2']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));
  assert.equal(model.hasFullContext, false);
  assert.deepEqual(model.truncatedSides, ['base']);
  assert.equal(model.rows.length, 3);
  assert.equal(model.rows[0].left.text, 'a');
  assert.equal(model.rows[1].right.text, 'b2');
  const rendered = buildRows(model, defaultExpanded(model));
  assert.ok(rendered.some((row) => row.truncationRow === true));
});

test('both sides truncated merges into a single marker row', () => {
  const base = side('Index', 'one\ntwo\nthr', { truncated: true });
  const target = side('Worktree', 'one\ntwo\nfo', { truncated: true });
  const h = hunk(0, 1, 2, 1, 2, [' one', '-two', '+TWO']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));
  assert.equal(model.hasFullContext, false);
  assert.deepEqual(model.truncatedSides, ['base', 'target']);
  const markers = model.rows.filter((row) => row.truncationRow === true);
  assert.equal(markers.length, 1);
  assert.deepEqual(markers[0].truncatedSides, ['base', 'target']);
  // complete lines from the truncated prefix can still be shown
  assert.equal(model.rows[0].left.text, 'one');
});

test('stats fall back to hunk contents when the host omits them', () => {
  const base = side('Index', fileText(4));
  const target = side('Worktree', 'line 1\nA\nB\nline 4');
  const h = hunk(0, 2, 2, 2, 2, ['-line 2', '-line 3', '+A', '+B']);
  const ed = entryDiff({ base, target, hunks: [h] });
  delete ed.stats;
  const model = buildSideBySide(ed);
  assert.deepEqual(model.stats, { additions: 2, deletions: 2 });
});

// ---------------------------------------------------------------------------
// full-context fixture invariants
// ---------------------------------------------------------------------------

test('alignment invariants hold for every fixture', () => {
  const cases = [bigFixture(), smallGapFixture()];
  const base4 = side('Index', fileText(4));
  cases.push(entryDiff({ base: base4, target: side('Worktree', 'line 1\nA\nline 3\nline 4'), hunks: [hunk(0, 2, 2, 2, 2, [' line 1', '-line 2', '+A', ' line 3'])] }));
  cases.push(entryDiff({
    base: side('Index', fileText(6)),
    target: side('Worktree', 'line 1\nline 2\nline 3\nline 4\nX\nY'),
    hunks: [hunk(0, 5, 2, 5, 2, ['-line 5', '-line 6', '+X', '+Y'])]
  }));
  for (const ed of cases) {
    const model = buildSideBySide(ed);
    assertModelInvariants(model, {
      baseLineCount: countLines(ed.base.text),
      targetLineCount: countLines(ed.target.text)
    });
  }
});

// ---------------------------------------------------------------------------
// gaps / expanded state / buildRows mapping
// ---------------------------------------------------------------------------

test('defaultExpanded collapses large gaps and expands small ones', () => {
  const big = buildSideBySide(bigFixture());
  assert.deepEqual(big.gaps.map((gap) => gap.rows), [1, 51, 6]);
  assert.deepEqual(defaultExpanded(big), [true, false, true]);
  assert.deepEqual(defaultExpanded(big, 25), [true, true, true]); // 2*25+1 = 51 boundary
  assert.deepEqual(defaultExpanded(big, 24), [true, false, true]);
  assert.deepEqual(defaultExpanded(big, 0), [true, false, false]); // 2*0+1 = 1 boundary

  const small = buildSideBySide(smallGapFixture());
  assert.deepEqual(small.gaps.map((gap) => gap.rows), [1, 7, 10]);
  assert.deepEqual(defaultExpanded(small), [true, true, false]);
  // threshold is 2*contextLines+1
  assert.deepEqual(defaultExpanded(small, 1), [true, false, false]);
  assert.deepEqual(defaultExpanded(small, 4), [true, true, false]);
  assert.deepEqual(defaultExpanded(small, 0), [true, false, false]);

  // models with no change blocks have no gaps to expand
  const unchanged = buildSideBySide(entryDiff({ base: side('Index', fileText(9)), target: side('Worktree', fileText(9)), hunks: [] }));
  assert.deepEqual(unchanged.gaps, []);
  assert.deepEqual(defaultExpanded(unchanged), []);
});

test('buildRows collapses a gap to context lines plus a synthetic gap row', () => {
  const model = buildSideBySide(bigFixture());
  const expanded = defaultExpanded(model);
  const rendered = buildRows(model, expanded);

  assert.equal(rendered.length, 16);
  assert.equal(rowCount(rendered), 16);
  assert.equal(rendered.rowCount, 16);
  assert.equal(rendered.rowIndexToOriginal.length, 16);
  assert.deepEqual(rendered.changeRowIndexes, [1, 9]);
  assert.deepEqual(rendered.gapIndexes, [5]);
  // deep equality still works on the returned array (metadata is non-enumerable)
  assert.deepEqual(rendered.slice(0, 2), model.rows.slice(0, 2));

  const synthetic = rendered[5];
  assert.equal(synthetic.kind, 'gap');
  assert.equal(synthetic.gapStart, true);
  assert.equal(synthetic.gapEnd, true);
  assert.equal(synthetic.gapIndex, 1);
  assert.equal(synthetic.hiddenCount, 45);
  assert.equal(synthetic.hiddenStart, 5);
  assert.equal(synthetic.hiddenEnd, 50);
  assert.equal(synthetic.change, false);
  assert.equal(synthetic.hunkIndex, null);
  assert.equal(synthetic.left.kind, 'empty');
  assert.equal(synthetic.right.kind, 'empty');

  // real rows keep their hunkIndex and map back to the full model
  assert.equal(rendered[0].hunkIndex, 0);
  assert.equal(rendered[0].left.no, 1);
  assert.equal(rendered[9].hunkIndex, 1);
  assert.equal(rendered[9].change, true);
  assert.equal(rendered[9].left.no, 54);
  assert.equal(rendered[15].left.no, 60);
  assert.equal(rendered[15].hunkIndex, null);

  for (let i = 0; i < rendered.length; i++) {
    const original = rowIndexToOriginal(rendered, i);
    if (rendered[i].kind === 'gap') {
      assert.equal(original, -1);
      assert.equal(rendered.rowIndexToOriginal[i], -1);
    } else {
      assert.equal(original, rendered.rowIndexToOriginal[i]);
      assert.ok(original >= 0 && original < model.rows.length);
      assert.deepEqual(rendered[i], model.rows[original]);
    }
  }
  assert.equal(rowIndexToOriginal(rendered, -1), -1);
  assert.equal(rowIndexToOriginal(rendered, 999), -1);

  // fully expanded renders the entire file
  const all = buildRows(model, [true, true]);
  assert.equal(all.length, 60);
  assert.deepEqual(all.changeRowIndexes, [1, 53]);
  assert.equal(all.gapIndexes.length, 0);
  assert.deepEqual(
    all.map((row) => row.left.no),
    Array.from({ length: 60 }, (_, i) => i + 1)
  );
});

test('buildRows honours a non-default contextLines argument', () => {
  const model = buildSideBySide(bigFixture());
  const rendered = buildRows(model, [false, false], 1);
  // all three gaps are larger than 2*1: 1 leading + synthetic + 1 trailing each
  // (gap 0 has 1 row, which fits in 2*contextLines, so it renders in full)
  assert.equal(rendered.length, 9);
  const gaps = rendered.filter((row) => row.kind === 'gap');
  assert.equal(gaps.length, 2);
  assert.deepEqual(gaps.map((row) => row.hiddenCount), [49, 4]);
  assert.deepEqual(gaps.map((row) => row.gapIndex), [1, 2]);

  // without an expanded entry the gap is collapsed, not default-expanded
  const forced = buildRows(model, [false, false, false]);
  assert.equal(forced.length, 16); // gaps <= 2*contextLines always render in full
  assert.ok(forced.length < buildRows(model, [true, true, true]).length);
});

test('findNextChangeInRows navigates the rendered list', () => {
  const model = buildSideBySide(bigFixture());
  const rendered = buildRows(model, defaultExpanded(model));

  assert.deepEqual(rendered.changeRowIndexes, [1, 9]);
  assert.equal(findNextChangeInRows(rendered, -1, 1), 1);
  assert.equal(findNextChangeInRows(rendered, 0, 1), 1);
  assert.equal(findNextChangeInRows(rendered, 1, 1), 9);
  assert.equal(findNextChangeInRows(rendered, 9, -1), 1);
  assert.equal(findNextChangeInRows(rendered, 15, 1), -1);
  assert.equal(findNextChangeInRows(rendered, 0, -1), -1);
  assert.equal(findNextChangeInRows(rendered, undefined, 1), 1);
  assert.equal(findNextChangeInRows(rendered, undefined, -1), 9);
  assert.equal(findNextChangeInRows([], 0, 1), -1);
  assert.equal(findNextChangeInRows(null, 0, 1), -1);
});

// ---------------------------------------------------------------------------
// navigation / anchors on the full model
// ---------------------------------------------------------------------------

test('findNextChange walks change rows in both directions', () => {
  const model = buildSideBySide(bigFixture());
  assert.deepEqual(model.changeRowIndexes, [1, 53]);

  assert.equal(findNextChange(model, -1, 1), 1);
  assert.equal(findNextChange(model, 0, 1), 1);
  assert.equal(findNextChange(model, 1, 1), 53);
  assert.equal(findNextChange(model, 53, 1), -1);
  assert.equal(findNextChange(model, 54, -1), 53);
  assert.equal(findNextChange(model, 53, -1), 1);
  assert.equal(findNextChange(model, 1, -1), -1);
  assert.equal(findNextChange(model, 0, -1), -1);
  assert.equal(findNextChange(model, undefined, 1), 1);
  assert.equal(findNextChange(model, undefined, -1), 53);
  assert.equal(findNextChange(model, 10, 'prev'), 1);
  assert.equal(findNextChange(model, 10, 'next'), 53);
  assert.equal(findNextChange(model, 53, -1), 1);

  const modeOnly = buildSideBySide(entryDiff({ base: side('Index', 'x'), target: side('Worktree', 'x'), hunks: [] }));
  assert.equal(findNextChange(modeOnly, -1, 1), -1);
  assert.equal(findNextChange(modeOnly, 0, -1), -1);
});

test('changeAnchors uses the default-expanded layout, one merged anchor per block', () => {
  const model = buildSideBySide(bigFixture());
  const defaultRows = buildRows(model, defaultExpanded(model));
  const anchors = changeAnchors(model);

  assert.equal(anchors.length, 2);
  assert.equal(anchors.length, model.changeBlocks.length);
  assert.deepEqual(anchors.map((anchor) => anchor.index), [1, 9]);
  assert.deepEqual(anchors.map((anchor) => anchor.hunkIndex), [0, 1]);
  assert.equal(anchors[0].top, 1 / 16);
  assert.equal(anchors[1].top, 9 / 16);
  assert.ok(anchors[0].top < anchors[1].top, 'top values are strictly increasing');
  for (const anchor of anchors) {
    assert.ok(anchor.top >= 0 && anchor.top <= 1);
    assert.ok(anchor.height > 0 && anchor.height <= 1);
    assert.ok(anchor.height >= 1 / defaultRows.length);
    assert.equal(defaultRows[anchor.index].change, true);
  }

  // callers may pass an explicit row layout (e.g. after custom expansion)
  const expandedAnchors = changeAnchors(model, model.rows);
  assert.deepEqual(expandedAnchors.map((anchor) => anchor.index), [1, 53]);
  assert.equal(expandedAnchors[0].height, 1 / 60);
  assert.deepEqual(changeAnchors(model, []), []);
});

test('changeAnchors merges the rows of one change block into a single anchor', () => {
  const base = side('Index', fileText(10));
  const target = side('Worktree', 'line 1\nline 2\nX\nY\nZ\nline 6\nline 7\nline 8\nline 9\nline 10');
  const h = hunk(0, 3, 3, 3, 3, ['-line 3', '-line 4', '-line 5', '+X', '+Y', '+Z']);
  const model = buildSideBySide(entryDiff({ base, target, hunks: [h] }));
  const anchors = changeAnchors(model);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].index, 2);
  assert.equal(anchors[0].height, 3 / 10);
  assert.equal(anchors[0].hunkIndex, 0);
});

// ---------------------------------------------------------------------------
// language detection
// ---------------------------------------------------------------------------

test('detectLanguage maps every required extension', () => {
  const expected = {
    'a.js': 'js', 'a.mjs': 'js', 'a.cjs': 'js', 'a.ts': 'ts', 'a.tsx': 'ts', 'a.jsx': 'js',
    'a.json': 'json',
    'a.css': 'css', 'a.scss': 'css', 'a.less': 'css',
    'a.html': 'html', 'a.vue': 'html', 'a.svelte': 'html',
    'a.md': 'md',
    'a.yml': 'yaml', 'a.yaml': 'yaml',
    'a.py': 'py',
    'a.go': 'go',
    'a.rs': 'rs',
    'a.java': 'java', 'a.kt': 'kt',
    'a.cs': 'cs',
    'a.php': 'php',
    'a.rb': 'rb',
    'a.sh': 'sh', 'a.ps1': 'ps1', 'a.bat': 'bat',
    'a.sql': 'sql',
    'a.xml': 'xml',
    'a.toml': 'toml',
    'a.ini': 'ini'
  };
  for (const [path, language] of Object.entries(expected)) {
    assert.equal(detectLanguage(path), language, path);
  }
  assert.equal(detectLanguage('src\\deep\\nested\\File.TSX'), 'ts');
  assert.equal(detectLanguage('E:/work/app/theme.CSS'), 'css');
  assert.equal(detectLanguage('package.json'), 'json');
  assert.equal(detectLanguage('docker-compose.yml'), 'yaml');

  for (const path of ['noext', '.gitignore', 'Makefile', 'a.unknown', 'archive.tar.gz', '', null, undefined, 42]) {
    assert.equal(detectLanguage(path), null, String(path));
  }

  // language can also be discovered from the comparison refs
  const ed = entryDiff({
    base: side('Index', 'a'),
    target: side('Worktree', 'b'),
    hunks: [hunk(0, 1, 1, 1, 1, ['-a', '+b'])]
  });
  delete ed.entry.path;
  ed.comparison.targetRef = 'worktree:src/app.ts';
  assert.equal(buildSideBySide(ed).language, 'ts');
});

// ---------------------------------------------------------------------------
// highlight
// ---------------------------------------------------------------------------

function assertSpans(entry) {
  assert.equal(typeof entry.line, 'string');
  assert.ok(Array.isArray(entry.spans));
  assert.equal(entry.spans.map((span) => span.text).join(''), entry.line);
  for (const span of entry.spans) {
    assert.equal(typeof span.text, 'string');
    assert.ok(ALLOWED_CLASSES.has(span.cls), `class ${span.cls}`);
    assert.ok(span.text.length > 0, 'no empty spans');
  }
}

test('highlight classifies comments, strings, numbers and keywords', () => {
  const js = highlight('const answer = 42; // "quoted"', 'js');
  assert.equal(js.length, 1);
  assertSpans(js[0]);
  const classes = new Set(js[0].spans.map((span) => span.cls));
  assert.ok(classes.has('kw'), 'keyword');
  assert.ok(classes.has('num'), 'number');
  assert.ok(classes.has('com'), 'comment');
  assert.ok(classes.has('punc'), 'punctuation');
  assert.ok(!classes.has('str'), 'string inside comment is not a string');

  const str = highlight('let s = "hello" + \'world\';', 'js');
  assertSpans(str[0]);
  assert.ok(str[0].spans.some((span) => span.cls === 'str'));

  const ids = highlight('foo bar baz', 'js');
  assert.deepEqual(ids[0].spans, [{ text: 'foo bar baz', cls: 'id' }]);

  const escaped = highlight('const re = "a\\"b";', 'js');
  assertSpans(escaped[0]);
  assert.ok(escaped[0].spans.some((span) => span.cls === 'str' && span.text === '"a\\"b"'));

  const ts = highlight('interface User { readonly id: number }', 'ts');
  assert.ok(ts[0].spans.some((span) => span.cls === 'kw' && span.text === 'interface'));
});

test('highlight keeps multi-line state for block comments and multiline strings', () => {
  const block = highlight('/* start\nmiddle\nend */ let x = 1;', 'js');
  assert.equal(block.length, 3);
  block.forEach(assertSpans);
  assert.ok(block[0].spans.every((span) => span.cls === 'com'));
  assert.ok(block[1].spans.every((span) => span.cls === 'com'));
  assert.equal(block[2].spans[0].text, 'end */');
  assert.equal(block[2].spans[0].cls, 'com');
  assert.ok(block[2].spans.some((span) => span.cls === 'kw' && span.text === 'let'));

  const template = highlight('const q = `one\ntwo`;\nlet z = 2;', 'js');
  assert.equal(template.length, 3);
  template.forEach(assertSpans);
  assert.equal(template[0].spans.find((span) => span.cls === 'str').text, '`one');
  assert.equal(template[1].spans[0].text, 'two`');
  assert.equal(template[1].spans[0].cls, 'str');
  assert.ok(template[2].spans.some((span) => span.cls === 'kw' && span.text === 'let'));

  const py = highlight('"""doc\nmore"""\nx = 1', 'py');
  assert.equal(py.length, 3);
  py.forEach(assertSpans);
  assert.equal(py[0].spans[0].cls, 'str');
  assert.equal(py[1].spans[0].text, 'more"""');
  assert.equal(py[1].spans[0].cls, 'str');
  assert.ok(py[2].spans.some((span) => span.cls === 'num' && span.text === '1'));
});

test('highlight supports every detected language family and never changes the text', () => {
  const samples = {
    js: 'const x = `hi`; // note',
    ts: 'type A = { id: number }; const y: A = { id: 1 };',
    json: '{"ok": true, "n": 12}',
    css: '/* c */ .a { color: #fff; width: 10px; }',
    html: '<!-- c --><div class="x">hi</div>',
    md: '# Title\n**bold** text 42',
    yaml: '# c\nname: value\ntrue: false',
    py: '# c\ndef f(x):\n    return "s" + 1',
    go: 'func main() { x := `raw` }',
    rs: 'fn main() { let x: i32 = 1; }',
    java: 'public class A { private int x = 1; }',
    kt: 'fun main() { val x = """raw""" }',
    cs: 'using System; class A { void M(int x) {} }',
    php: '<?php function f() { return 1; } // c',
    rb: 'def m; @x = 1; end # c',
    sh: 'if [ -f file ]; then echo "hi"; fi # c',
    ps1: '<# c #> $x = "a"; function f {}',
    bat: ':: c\nset X=1\nif exist f echo hi',
    sql: "SELECT id FROM t WHERE x = 'a''b' -- c",
    xml: '<!-- c --><root a="1"/>',
    toml: '# c\nkey = "v"\nflag = true',
    ini: '; c\n[sec]\nkey = value\nflag = true'
  };
  // languages with a keyword table must highlight at least one keyword
  const keywordLanguages = new Set([
    'js', 'ts', 'json', 'html', 'yaml', 'py', 'go', 'rs', 'java', 'kt', 'cs',
    'php', 'rb', 'sh', 'ps1', 'bat', 'sql', 'toml', 'ini'
  ]);
  for (const [language, sample] of Object.entries(samples)) {
    const out = highlight(sample, language);
    assert.ok(out.length > 0, language);
    for (const entry of out) {
      assertSpans(entry);
    }
    if (keywordLanguages.has(language)) {
      assert.ok(
        out.some((entry) => entry.spans.some((span) => span.cls === 'kw')),
        `${language} highlights a keyword`
      );
    }
  }

  // css/xml own their block comments, markdown stays plain code-free
  assert.ok(highlight('/* c */ .a {}', 'css')[0].spans.some((span) => span.cls === 'com'));
  assert.ok(highlight('<!-- c --><a/>', 'xml')[0].spans.some((span) => span.cls === 'com'));
  assert.ok(highlight('# Title', 'md')[0].spans.every((span) => span.cls !== 'kw'));

  // sql keywords are case insensitive
  const sql = highlight('SELECT a FROM t', 'sql');
  assert.equal(sql[0].spans.filter((span) => span.cls === 'kw').length, 2);

  // unknown / missing language degrades to plain text
  const plain = highlight('const x = "y";', null);
  assertSpans(plain[0]);
  assert.ok(plain[0].spans.every((span) => span.cls !== 'kw'));
  assert.equal(plain[0].spans.map((span) => span.text).join(''), 'const x = "y";');
});

test('highlight line splitting follows the same rules as file lines', () => {
  assert.deepEqual(highlight('', 'js'), [{ line: '', spans: [] }]);
  assert.equal(highlight('a\nb', 'js').length, 2);
  assert.equal(highlight('a\n', 'js').length, 1);
  assert.equal(highlight('a\r\nb', 'js').length, 2);
  assert.equal(highlight('a\r\nb', 'js')[0].line, 'a');
  assert.equal(highlight('a\r\nb', 'js')[1].line, 'b');
});

test('highlightLine returns spans for one line', () => {
  const spans = highlightLine('const x = 1', 'js');
  assert.equal(spans.map((span) => span.text).join(''), 'const x = 1');
  assert.deepEqual(highlightLine('', 'js'), []);
  assert.equal(highlightLine('let y = 2;', 'ts').map((span) => span.text).join(''), 'let y = 2;');
});

test('highlight never throws and always preserves text (fuzz)', () => {
  function mulberry32(seed) {
    let state = seed;
    return function random() {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const random = mulberry32(0x5eed1234);
  const charset = [
    'a', 'b', 'X', '9', '0', ' ', '\t', '_', '-', '+', '*', '/', '"', "'", '`', '\\', '\n', '\r',
    '{', '}', '(', ')', '<', '>', '=', '#', ';', ',', '.', ':', '!', '?', '&', '|', '^', '~', '@', '$', '[', ']', '%',
    '你', '好', '世', '界', '\u0000', '\ud83c\udf89', '\ud800', 'ｄ', '\u2028'
  ];
  const languages = ['js', 'ts', 'json', 'css', 'html', 'md', 'yaml', 'py', 'go', 'rs', 'java', 'kt', 'cs',
    'php', 'rb', 'sh', 'ps1', 'bat', 'sql', 'xml', 'toml', 'ini', null, undefined, 'nope', 42];

  for (let round = 0; round < 200; round++) {
    const length = Math.floor(random() * 70);
    let text = '';
    for (let i = 0; i < length; i++) text += charset[Math.floor(random() * charset.length)];
    for (const language of languages) {
      const out = highlight(text, language);
      assert.ok(Array.isArray(out));
      for (const entry of out) assertSpans(entry);
      // line splitting must match the file-line rules used by the diff engine
      assert.deepEqual(out.map((entry) => entry.line), expectedDisplayLines(text));
    }
  }

  // pathological but legal inputs must terminate without throwing
  const stress = [
    '"'.repeat(4000),
    '\\'.repeat(4000),
    '`'.repeat(2000),
    '/*'.repeat(2000),
    '\n'.repeat(2000),
    '你好世界'.repeat(500)
  ];
  for (const text of stress) {
    for (const language of ['js', 'py', 'sql', 'html']) {
      const out = highlight(text, language);
      for (const entry of out) assertSpans(entry);
    }
  }

  // non-string inputs are coerced, never thrown
  assert.doesNotThrow(() => highlight(undefined, 'js'));
  assert.doesNotThrow(() => highlight(null, 'js'));
  assert.doesNotThrow(() => highlight(123, 'js'));
  assert.doesNotThrow(() => highlight({}, 'js'));
  assert.equal(highlight(123, 'js')[0].line, '123');
  assert.equal(highlight(null, 'js')[0].line, '');
});

// ---------------------------------------------------------------------------
// truncation marker / row-count helpers integration
// ---------------------------------------------------------------------------

test('rowCount and rowIndexToOriginal degrade gracefully on plain arrays', () => {
  assert.equal(rowCount([]), 0);
  assert.equal(rowCount(null), 0);
  assert.equal(rowIndexToOriginal([{ x: 1 }], 0), 0);
  assert.equal(rowIndexToOriginal([{ x: 1 }], 5), -1);
  assert.equal(rowIndexToOriginal(null, 0), -1);
});

// ---------------------------------------------------------------------------
// robustness against malformed host payloads
// ---------------------------------------------------------------------------

test('buildSideBySide survives random / malformed host payloads', () => {
  function mulberry32(seed) {
    let state = seed;
    return function random() {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const random = mulberry32(0xbadc0de);
  const pick = (list) => list[Math.floor(random() * list.length)];

  const junkText = () => {
    const lineCount = Math.floor(random() * 8);
    const bits = ['alpha', 'beta', 'line', '你好', '\t', '\r', 'x = 1;', '#', '\\', '"', '`'];
    const lines = [];
    for (let i = 0; i < lineCount; i++) {
      let text = '';
      const pieces = Math.floor(random() * 3) + 1;
      for (let k = 0; k < pieces; k++) text += pick(bits);
      lines.push(text);
    }
    let text = lines.join('\n');
    if (random() < 0.5) text += '\n';
    return text;
  };

  const makeSide = (label) => {
    const kind = random();
    if (kind < 0.55) {
      const text = junkText();
      return {
        label, ref: `${label.toLowerCase()}:f.txt`, exists: true, binary: false, tooLarge: false,
        truncated: random() < 0.2, encoding: 'utf8', bytes: text.length, lines: 0, text
      };
    }
    if (kind < 0.65) {
      return { label, ref: 'empty', exists: false, binary: false, tooLarge: false, truncated: false, encoding: 'utf8', bytes: 0, lines: 0, text: '' };
    }
    if (kind < 0.75) {
      return { label, ref: 'x', exists: true, binary: true, tooLarge: false, truncated: false, encoding: 'binary', bytes: 10, lines: 0, text: '' };
    }
    if (kind < 0.85) {
      return { label, ref: 'x', exists: true, binary: false, tooLarge: true, truncated: false, encoding: 'utf8', bytes: 999999, lines: 0, text: '' };
    }
    return undefined;
  };

  const makeHunks = () => {
    const hunks = [];
    const count = Math.floor(random() * 3);
    for (let h = 0; h < count; h++) {
      const lines = [];
      const lineCount = Math.floor(random() * 8) + 1;
      for (let i = 0; i < lineCount; i++) {
        lines.push({
          kind: pick([' ', '-', '+', ' ', '-', '+', '\\']),
          text: pick(['old', 'new', 'ctx', '你好', '\tindented', '', 'line\r']),
          oldLine: 0,
          newLine: 0
        });
      }
      hunks.push({
        index: random() < 0.7 ? h : pick([undefined, null, 'x']),
        header: '@@ junk @@',
        oldStart: Math.floor(random() * 20) - 2,
        oldLines: random() < 0.25 ? 0 : Math.floor(random() * 6),
        newStart: Math.floor(random() * 20) - 2,
        newLines: random() < 0.25 ? 0 : Math.floor(random() * 6),
        section: '',
        lines,
        patch: ''
      });
    }
    return hunks;
  };

  for (let round = 0; round < 150; round++) {
    const ed = {
      entry: random() < 0.8 ? { path: pick(['a.js', 'b.py', 'c.unknown', 'd.ts']), oldPath: null } : {},
      comparison: random() < 0.5 ? { targetRef: 'worktree:f.txt', baseRef: 'index:f.txt' } : undefined,
      base: makeSide('Index'),
      target: makeSide('Worktree'),
      hunks: makeHunks(),
      stats: random() < 0.5 ? { additions: Math.floor(random() * 5), deletions: Math.floor(random() * 5) } : undefined,
      unsupported: random() < 0.2 ? { code: pick(['binary', 'conflict', 'submodule', 'too-large', 'mode-only']), message: 'x' } : null
    };

    let model;
    assert.doesNotThrow(() => {
      model = buildSideBySide(ed);
    });
    assert.equal(Array.isArray(model.rows), true);
    assert.equal(model.rowCount, model.rows.length);

    for (const row of model.rows) {
      assert.equal(typeof row.left.text, 'string');
      assert.equal(typeof row.right.text, 'string');
      assert.ok(['ctx', 'add', 'del', 'empty'].includes(row.left.kind));
      assert.ok(['ctx', 'add', 'del', 'empty'].includes(row.right.kind));
      assert.equal(row.left.kind === 'ctx', row.right.kind === 'ctx');
      if (row.change === true) {
        assert.ok(!(row.left.kind === 'empty' && row.right.kind === 'empty'));
        assert.ok(row.hunkIndex === null || typeof row.hunkIndex === 'number');
      }
    }
    for (let i = 1; i < model.changeRowIndexes.length; i++) {
      assert.ok(model.changeRowIndexes[i] > model.changeRowIndexes[i - 1], 'change indexes ascending');
    }
    for (const gap of model.gaps) {
      assert.ok(gap.start >= 0 && gap.end <= model.rows.length);
      assert.equal(gap.end - gap.start, gap.rows);
      for (let i = gap.start; i < gap.end; i++) assert.equal(model.rows[i].change, false);
    }

    const baseTruncated = !!(ed.base && ed.base.truncated);
    const targetTruncated = !!(ed.target && ed.target.truncated);
    if (baseTruncated || targetTruncated) {
      assert.equal(model.hasFullContext, false);
      assert.ok(model.rows.some((row) => row.truncationRow === true), 'truncation marker present');
    }
    if (ed.unsupported || (ed.base && ed.base.binary) || (ed.target && ed.target.binary)) {
      assert.equal(model.hasFullContext, false);
    }

    const expanded = defaultExpanded(model);
    assert.equal(expanded.length, model.gaps.length);
    let rendered;
    assert.doesNotThrow(() => {
      rendered = buildRows(model, expanded);
    });
    assert.equal(rendered.rowIndexToOriginal.length, rendered.length);
    assert.equal(rendered.changeRowIndexes.length, model.changeRowIndexes.length);
    assert.doesNotThrow(() => buildRows(model));

    const anchors = changeAnchors(model);
    for (const anchor of anchors) {
      assert.ok(anchor.top >= 0 && anchor.top < 1);
      assert.ok(anchor.height >= 1 / rendered.length);
    }
    for (let i = 1; i < anchors.length; i++) assert.ok(anchors[i].top > anchors[i - 1].top);

    const next = findNextChange(model, -1, 1);
    assert.ok(next === -1 || model.rows[next].change === true);
  }
});

// ---------------------------------------------------------------------------
// performance
// ---------------------------------------------------------------------------

function perfFixture(rowCount) {
  const baseLines = new Array(rowCount);
  const targetLines = new Array(rowCount);
  const body = new Array(rowCount * 2);
  for (let i = 0; i < rowCount; i++) {
    const baseLine = `the quick brown fox jumps over the lazy dog ${i}`;
    const targetLine = `a different line with a bit more text to keep length honest ${i}`;
    baseLines[i] = baseLine;
    targetLines[i] = targetLine;
    body[i] = `-${baseLine}`;
    body[rowCount + i] = `+${targetLine}`;
  }
  return entryDiff({
    base: side('Index', baseLines.join('\n')),
    target: side('Worktree', targetLines.join('\n')),
    hunks: [hunk(0, 1, rowCount, 1, rowCount, body)]
  });
}

function bestMs(ed, runs) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    const model = buildSideBySide(ed);
    const end = process.hrtime.bigint();
    assert.equal(model.rows.length, ed.hunks[0].oldLines);
    assert.equal(model.changeRowIndexes.length, ed.hunks[0].oldLines);
    best = Math.min(best, Number(end - start) / 1e6);
  }
  return best;
}

test('buildSideBySide handles a 20k-row diff well under the timing ceiling (no quadratic string building)', () => {
  const warmup = perfFixture(1000);
  buildSideBySide(warmup);
  buildSideBySide(warmup);

  const small = perfFixture(5000);
  const large = perfFixture(20000);
  const smallMs = bestMs(small, 3);
  const largeMs = bestMs(large, 3);

  assert.ok(largeMs < 2000, `20k-row build took ${largeMs.toFixed(1)}ms (ceiling 2000ms)`);

  // Linear behaviour: per-row cost must not blow up with input size. A quadratic
  // string-concatenation implementation would make the 20k per-row cost hundreds
  // of times worse than the 5k per-row cost.
  const perRowSmall = smallMs / 5000;
  const perRowLarge = largeMs / 20000;
  assert.ok(
    perRowLarge < perRowSmall * 10 + 0.05,
    `per-row cost grew from ${perRowSmall.toFixed(5)}ms to ${perRowLarge.toFixed(5)}ms`
  );

  // large models also collapse/render quickly (no synthetic rows here: all rows change)
  const model = buildSideBySide(large);
  const expanded = defaultExpanded(model);
  assert.deepEqual(expanded, []);
  const rendered = buildRows(model, expanded);
  assert.equal(rendered.length, 20000);
  assert.equal(rendered.changeRowIndexes.length, 20000);
  assert.equal(rendered[0].left.text, 'the quick brown fox jumps over the lazy dog 0');
  assert.equal(rendered[19999].right.text, 'a different line with a bit more text to keep length honest 19999');
});

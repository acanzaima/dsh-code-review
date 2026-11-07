__def('diff', function (exports, require, React) {
  'use strict';

  /*
   * dsh-code-review - pure side-by-side diff layout engine (no React, no DOM).
   *
   * Contract exports (docs/protocol.md section 5):
   *
   *   buildSideBySide(entryDiff) -> SideBySide
   *   changeAnchors(sideBySide, renderedRows?) -> { index, top, height, hunkIndex }[]
   *   defaultExpanded(sideBySide, contextLines = 3) -> boolean[]
   *   detectLanguage(path) -> string | null
   *   highlight(text, language) -> { line, spans: [{ text, cls }] }[]
   *   findNextChange(sideBySide, fromIndex, direction) -> number
   *   buildRows(sideBySide, expanded, contextLines = 3) -> Row[]
   *
   * Extra exports (used by the React renderer; documented on purpose):
   *
   *   highlightLine(text, language) -> [{ text, cls }]
   *     Per-line convenience wrapper around highlight(); use this when the
   *     renderer tokenizes one already-split source line.
   *
   *   rowCount(rows) -> number
   *     Number of rendered rows (works on the array returned by buildRows()).
   *
   *   rowIndexToOriginal(rows, renderedIndex) -> number
   *     Maps a rendered row index back to its index in sideBySide.rows.
   *     Returns -1 for synthetic rows (collapsed-gap marker / truncation marker).
   *
   *   findNextChangeInRows(rows, fromIndex, direction) -> number
   *     Same semantics as findNextChange() but on the rendered rows returned by
   *     buildRows(), so next/previous-change scrolling works in the visible list.
   *
   * buildRows() attaches these properties to the returned array:
   *   rowCount            number      - same as rows.length
   *   rowIndexToOriginal  number[]    - rendered index -> original index, -1 synthetic
   *   changeRowIndexes    number[]    - rendered indexes of changed rows (ascending)
   *   gapIndexes          number[]    - rendered indexes of synthetic 'gap' rows
   *
   * buildRows() real rows are shallow copies of sideBySide.rows (left/right line
   * objects are shared); synthetic rows carry `kind: 'gap'` plus gapStart/gapEnd,
   * gapIndex, hiddenCount and hiddenStart/hiddenEnd (original row range), or
   * `truncationRow: true` plus truncatedSides for a cut-off side. The truncation
   * marker is appended after the last reconstructed row (the cut) and is never
   * treated as a gap, so it always survives collapsing.
   *
   * Gap semantics: a gap is a maximal run of untouched (non-change, non-marker)
   * rows, including context rows that sit inside a hunk. With the default of 3
   * context lines this reproduces git's +-3 context next to every change block.
   * A model with no change blocks has no gaps, so nothing is hidden.
   *
   * SideBySide extra fields beyond section 5: rowCount, gaps, changeBlocks,
   * truncatedSides, unsupported, modeChange.
   */

  // ---------------------------------------------------------------------------
  // tiny helpers
  // ---------------------------------------------------------------------------

  var EMPTY_SET = Object.create(null);

  function toInt(value) {
    var n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : NaN;
  }

  function clampAdvance(value) {
    var n = toInt(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
  }

  function isOpaqueSide(side) {
    // A side we cannot (or must not) turn into displayed lines.
    if (!side || typeof side !== 'object') return true;
    if (side.binary === true) return true;
    if (side.encoding === 'binary') return true;
    if (side.tooLarge === true) return true;
    return false;
  }

  function cleanLineText(value) {
    // hunk line texts: never show the CR of a CRLF pair.
    if (typeof value !== 'string') {
      if (value === undefined || value === null) return '';
      try {
        return String(value);
      } catch (e) {
        return '';
      }
    }
    var length = value.length;
    if (length > 0 && value.charCodeAt(length - 1) === 13) return value.slice(0, length - 1);
    return value;
  }

  // Split a side's raw text into complete display lines.
  // - CRLF is not part of the line text.
  // - a file ending without a newline does not gain an extra empty line.
  // - truncated text is clamped to complete lines (a partial tail line is dropped).
  function splitSideLines(side) {
    var result = { lines: [], truncated: false, available: 0 };
    if (!side || typeof side !== 'object') return result;
    result.truncated = side.truncated === true;
    if (isOpaqueSide(side)) return result;
    if (side.exists === false) return result;
    var raw = typeof side.text === 'string' ? side.text : '';
    if (raw === '') return result;

    var parts = raw.split('\n');
    var endedWithBreak = parts.length > 1 && parts[parts.length - 1] === '';
    if (endedWithBreak) parts.pop();
    if (result.truncated && !endedWithBreak) parts.pop(); // cut mid-line: drop the partial line

    for (var i = 0; i < parts.length; i++) {
      var line = parts[i];
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) parts[i] = line.slice(0, -1);
    }
    result.lines = parts;
    result.available = parts.length;
    return result;
  }

  function rowsOf(model) {
    if (Array.isArray(model)) return model;
    if (model && typeof model === 'object' && Array.isArray(model.rows)) return model.rows;
    return [];
  }

  function isGapCandidate(row) {
    return !!row && row.change !== true && row.truncationRow !== true;
  }

  function computeGaps(rows) {
    var gaps = [];
    if (!rows.length) return gaps;
    var hasChange = false;
    for (var c = 0; c < rows.length; c++) {
      if (rows[c] && rows[c].change === true) {
        hasChange = true;
        break;
      }
    }
    if (!hasChange) return gaps; // no change blocks: nothing to collapse around
    var i = 0;
    while (i < rows.length) {
      if (!isGapCandidate(rows[i])) {
        i += 1;
        continue;
      }
      var j = i + 1;
      while (j < rows.length && isGapCandidate(rows[j])) j += 1;
      gaps.push({ index: gaps.length, start: i, end: j, rows: j - i });
      i = j;
    }
    return gaps;
  }

  function gapsFor(model) {
    var rows = rowsOf(model);
    if (!rows.length) return [];
    if (!Array.isArray(model) && model && Array.isArray(model.gaps) && Array.isArray(model.rows) && model.rows === rows) {
      return model.gaps;
    }
    return computeGaps(rows);
  }

  function changeIndexesFor(model) {
    var rows = rowsOf(model);
    if (!Array.isArray(model) && model && Array.isArray(model.changeRowIndexes)) return model.changeRowIndexes;
    if (Array.isArray(model) && Array.isArray(model.changeRowIndexes)) return model.changeRowIndexes;
    var list = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].change === true) list.push(i);
    }
    return list;
  }

  function normalizeContextLines(value) {
    if (value === undefined || value === null) return 3;
    var n = toInt(value);
    if (!Number.isFinite(n) || n < 0) return 3;
    return n;
  }

  // ---------------------------------------------------------------------------
  // buildSideBySide - reconstruct the whole file as aligned pairs of rows
  // ---------------------------------------------------------------------------

  function hunkStartIndex(start, count, cursor) {
    // git hunk starts are 1-based; with an explicit 0 line count the start is
    // the line number the change is attached to (i.e. the 0-based index of the
    // next untouched line).
    var s = toInt(start);
    if (!Number.isFinite(s)) return cursor;
    var c = toInt(count);
    var index = c === 0 ? s : s - 1;
    if (index < 0) index = 0;
    return index > cursor ? index : cursor;
  }

  function buildSideBySide(entryDiff) {
    var diff = entryDiff && typeof entryDiff === 'object' ? entryDiff : {};
    var baseSide = diff.base && typeof diff.base === 'object' ? diff.base : null;
    var targetSide = diff.target && typeof diff.target === 'object' ? diff.target : null;
    var baseOpaque = isOpaqueSide(baseSide);
    var targetOpaque = isOpaqueSide(targetSide);
    var baseInfo = splitSideLines(baseSide);
    var targetInfo = splitSideLines(targetSide);
    var baseTruncated = baseInfo.truncated;
    var targetTruncated = targetInfo.truncated;
    var oldLines = baseInfo.lines;
    var newLines = targetInfo.lines;

    var rows = [];
    var hunkRowRanges = [];
    var inconsistent = false;
    var oldPos = 0;
    var newPos = 0;

    function pushContextRow(oldNo, newNo, oldText, newText, hunkIndex) {
      rows.push({
        left: { no: oldNo, text: oldText, kind: 'ctx' },
        right: { no: newNo, text: newText, kind: 'ctx' },
        change: false,
        hunkIndex: hunkIndex === undefined ? null : hunkIndex
      });
    }

    // Emit `oldAdvance` old lines and `newAdvance` new lines of untouched content.
    // Kept sides pair up as context rows. Truncated data never fabricates rows.
    function emitUnaffected(oldAdvance, newAdvance) {
      var oa = clampAdvance(oldAdvance);
      var na = clampAdvance(newAdvance);
      if (oa === 0 && na === 0) return;

      var paired = Math.min(oa, na);
      if (!baseOpaque && !targetOpaque) {
        var oldAvail = oldLines.length - oldPos;
        var newAvail = newLines.length - newPos;
        if (oldAvail < 0) oldAvail = 0;
        if (newAvail < 0) newAvail = 0;
        var emit = paired;
        if (emit > oldAvail) emit = oldAvail;
        if (emit > newAvail) emit = newAvail;
        for (var k = 0; k < emit; k++) {
          pushContextRow(oldPos + k + 1, newPos + k + 1, oldLines[oldPos + k], newLines[newPos + k], null);
        }
      }

      // Remaining one-sided lines only when the data is complete on both sides;
      // otherwise the rows would be invented from missing (truncated) content.
      if (!baseOpaque && !targetOpaque && !baseTruncated && !targetTruncated) {
        if (oa > paired) {
          inconsistent = true;
          var oldExtra = Math.min(oa - paired, Math.max(0, oldLines.length - oldPos - paired));
          for (var d = 0; d < oldExtra; d++) {
            rows.push({
              left: { no: oldPos + paired + d + 1, text: oldLines[oldPos + paired + d], kind: 'del' },
              right: { no: null, text: '', kind: 'empty' },
              change: true,
              hunkIndex: null
            });
          }
        }
        if (na > paired) {
          inconsistent = true;
          var newExtra = Math.min(na - paired, Math.max(0, newLines.length - newPos - paired));
          for (var a = 0; a < newExtra; a++) {
            rows.push({
              left: { no: null, text: '', kind: 'empty' },
              right: { no: newPos + paired + a + 1, text: newLines[newPos + paired + a], kind: 'add' },
              change: true,
              hunkIndex: null
            });
          }
        }
      } else if (oa !== na) {
        inconsistent = true;
      }

      oldPos += oa;
      newPos += na;
    }

    var hunks = Array.isArray(diff.hunks) ? diff.hunks : [];
    for (var h = 0; h < hunks.length; h++) {
      var hunk = hunks[h] && typeof hunks[h] === 'object' ? hunks[h] : {};
      var rawIndex = toInt(hunk.index);
      var hunkIndex = Number.isFinite(rawIndex) ? rawIndex : h;
      var oldStartIdx = hunkStartIndex(hunk.oldStart, hunk.oldLines, oldPos);
      var newStartIdx = hunkStartIndex(hunk.newStart, hunk.newLines, newPos);
      var gapOld = oldStartIdx - oldPos;
      var gapNew = newStartIdx - newPos;
      if (gapOld < 0 || gapNew < 0) inconsistent = true;
      emitUnaffected(gapOld, gapNew);

      var hunkStartRow = rows.length;
      var o = oldPos;
      var n = newPos;
      var hunkLines = Array.isArray(hunk.lines) ? hunk.lines : [];
      var li = 0;
      while (li < hunkLines.length) {
        var entry = hunkLines[li] && typeof hunkLines[li] === 'object' ? hunkLines[li] : null;
        var kind = entry ? entry.kind : null;
        if (kind === ' ') {
          var contextText = cleanLineText(entry.text);
          rows.push({
            left: { no: o + 1, text: contextText, kind: 'ctx' },
            right: { no: n + 1, text: contextText, kind: 'ctx' },
            change: false,
            hunkIndex: hunkIndex
          });
          o += 1;
          n += 1;
          li += 1;
          continue;
        }
        if (kind === '-' || kind === '+') {
          var dels = [];
          var adds = [];
          while (li < hunkLines.length) {
            var raw = hunkLines[li] && typeof hunkLines[li] === 'object' ? hunkLines[li] : null;
            var rawKind = raw ? raw.kind : null;
            if (rawKind === '-') {
              dels.push(cleanLineText(raw.text));
              li += 1;
            } else if (rawKind === '+') {
              adds.push(cleanLineText(raw.text));
              li += 1;
            } else {
              break;
            }
          }
          var count = Math.max(dels.length, adds.length);
          for (var k = 0; k < count; k++) {
            var hasDel = k < dels.length;
            var hasAdd = k < adds.length;
            rows.push({
              left: hasDel ? { no: o + 1, text: dels[k], kind: 'del' } : { no: null, text: '', kind: 'empty' },
              right: hasAdd ? { no: n + 1, text: adds[k], kind: 'add' } : { no: null, text: '', kind: 'empty' },
              change: true,
              hunkIndex: hunkIndex
            });
            if (hasDel) o += 1;
            if (hasAdd) n += 1;
          }
          continue;
        }
        // Unknown marker line (e.g. a no-newline marker): nothing to display.
        li += 1;
      }

      oldPos = o;
      newPos = n;
      if (rows.length > hunkStartRow) {
        hunkRowRanges.push({ index: hunkIndex, start: hunkStartRow, end: rows.length });
      }
    }

    emitUnaffected(oldLines.length - oldPos, newLines.length - newPos);

    var truncatedSides = [];
    if (baseTruncated) truncatedSides.push('base');
    if (targetTruncated) truncatedSides.push('target');
    if (truncatedSides.length > 0) {
      // The available text ends here; the rest of the file was not returned.
      rows.push({
        left: { no: null, text: '', kind: 'empty' },
        right: { no: null, text: '', kind: 'empty' },
        change: false,
        hunkIndex: null,
        truncationRow: true,
        truncatedSides: truncatedSides.slice()
      });
    }

    // Derive change indexes / blocks / gaps from the finished row list.
    var changeRowIndexes = [];
    var changeBlocks = [];
    var i = 0;
    while (i < rows.length) {
      if (rows[i].change !== true) {
        i += 1;
        continue;
      }
      var start = i;
      var blockHunkIndex = rows[i].hunkIndex;
      var j = i + 1;
      while (j < rows.length && rows[j].change === true) j += 1;
      changeBlocks.push({ start: start, end: j, hunkIndex: blockHunkIndex });
      for (var c = start; c < j; c++) changeRowIndexes.push(c);
      i = j;
    }
    var gaps = computeGaps(rows);

    var stats = { additions: 0, deletions: 0 };
    var hostStats = diff.stats && typeof diff.stats === 'object' ? diff.stats : null;
    var hostAdd = hostStats ? toInt(hostStats.additions) : NaN;
    var hostDel = hostStats ? toInt(hostStats.deletions) : NaN;
    if (Number.isFinite(hostAdd) && Number.isFinite(hostDel)) {
      stats = { additions: Math.max(0, hostAdd), deletions: Math.max(0, hostDel) };
    } else {
      var counted = countHunkStats(hunks);
      stats = counted;
    }

    var hasFullContext =
      !diff.unsupported && !baseOpaque && !targetOpaque && !baseTruncated && !targetTruncated && !inconsistent;

    return {
      rows: rows,
      changeRowIndexes: changeRowIndexes,
      hunkRowRanges: hunkRowRanges,
      hasFullContext: hasFullContext,
      language: detectDiffLanguage(diff),
      stats: stats,
      rowCount: rows.length,
      changeBlocks: changeBlocks,
      gaps: gaps,
      truncatedSides: truncatedSides,
      unsupported: diff.unsupported || null,
      modeChange: diff.modeChange || null
    };
  }

  function countHunkStats(hunks) {
    var additions = 0;
    var deletions = 0;
    for (var h = 0; h < hunks.length; h++) {
      var lines = hunks[h] && Array.isArray(hunks[h].lines) ? hunks[h].lines : [];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        if (line.kind === '+') additions += 1;
        else if (line.kind === '-') deletions += 1;
      }
    }
    return { additions: additions, deletions: deletions };
  }

  function detectDiffLanguage(diff) {
    var entry = diff.entry && typeof diff.entry === 'object' ? diff.entry : null;
    if (entry) {
      if (typeof entry.path === 'string' && entry.path) return detectLanguage(entry.path);
      if (typeof entry.oldPath === 'string' && entry.oldPath) return detectLanguage(entry.oldPath);
    }
    var comparison = diff.comparison && typeof diff.comparison === 'object' ? diff.comparison : null;
    var refs = [
      comparison ? comparison.targetRef : null,
      comparison ? comparison.baseRef : null,
      diff.target && diff.target.ref,
      diff.base && diff.base.ref
    ];
    for (var r = 0; r < refs.length; r++) {
      var ref = refs[r];
      if (typeof ref !== 'string' || ref === '') continue;
      var colon = ref.indexOf(':');
      var path = colon >= 0 ? ref.slice(colon + 1) : ref;
      if (!path || path === 'empty' || path === 'dir') continue;
      var language = detectLanguage(path);
      if (language) return language;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // buildRows - render the full model with gaps collapsed/expanded
  // ---------------------------------------------------------------------------

  function makeGapRow(gap, hiddenCount, contextLines) {
    return {
      left: { no: null, text: '', kind: 'empty' },
      right: { no: null, text: '', kind: 'empty' },
      change: false,
      hunkIndex: null,
      kind: 'gap',
      gapStart: true,
      gapEnd: true,
      gapIndex: gap.index,
      hiddenCount: hiddenCount,
      hiddenStart: gap.start + contextLines,
      hiddenEnd: gap.end - contextLines
    };
  }

  function defineRowMeta(target, key, value) {
    try {
      Object.defineProperty(target, key, {
        value: value,
        enumerable: false,
        configurable: true,
        writable: true
      });
    } catch (e) {
      target[key] = value;
    }
  }

  function buildRows(sideBySide, expanded, contextLines) {
    var ctx = normalizeContextLines(contextLines);
    var rows = rowsOf(sideBySide);
    var gaps = gapsFor(sideBySide);
    var out = [];
    var map = [];
    var renderedChanges = [];
    var renderedGaps = [];
    var gapCursor = 0;
    var i = 0;
    var limit = 2 * ctx;

    while (i < rows.length) {
      var row = rows[i];
      if (!row || typeof row !== 'object') {
        i += 1;
        continue;
      }
      if (isGapCandidate(row)) {
        while (gapCursor < gaps.length && gaps[gapCursor].end <= i) gapCursor += 1;
        var gap = gapCursor < gaps.length && gaps[gapCursor].start <= i ? gaps[gapCursor] : null;
        if (gap) {
          var isOpen = Array.isArray(expanded) && expanded[gap.index] === true;
          if (isOpen || gap.rows <= limit) {
            for (var g = gap.start; g < gap.end; g++) emitReal(g);
          } else {
            for (var lead = gap.start; lead < gap.start + ctx; lead++) emitReal(lead);
            out.push(makeGapRow(gap, gap.rows - limit, ctx));
            map.push(-1);
            renderedGaps.push(out.length - 1);
            for (var tail = gap.end - ctx; tail < gap.end; tail++) emitReal(tail);
          }
          i = gap.end;
          continue;
        }
      }
      emitReal(i);
      i += 1;
    }

    // Non-enumerable so the array still compares/serializes like a plain Row[].
    defineRowMeta(out, 'rowCount', out.length);
    defineRowMeta(out, 'rowIndexToOriginal', map);
    defineRowMeta(out, 'changeRowIndexes', renderedChanges);
    defineRowMeta(out, 'gapIndexes', renderedGaps);
    return out;

    function emitReal(index) {
      var real = rows[index];
      if (!real || typeof real !== 'object') return;
      out.push(Object.assign({}, real));
      map.push(index);
      if (real.change === true) renderedChanges.push(out.length - 1);
    }
  }

  function rowCount(rows) {
    return Array.isArray(rows) ? rows.length : 0;
  }

  function rowIndexToOriginal(rows, renderedIndex) {
    if (!Array.isArray(rows)) return -1;
    var map = rows.rowIndexToOriginal;
    var index = toInt(renderedIndex);
    if (!Number.isFinite(index) || index < 0 || index >= rows.length) return -1;
    if (Array.isArray(map)) {
      var mapped = map[index];
      return typeof mapped === 'number' ? mapped : -1;
    }
    return index;
  }

  // ---------------------------------------------------------------------------
  // gaps / anchors / navigation
  // ---------------------------------------------------------------------------

  function defaultExpanded(sideBySide, contextLines) {
    var ctx = normalizeContextLines(contextLines);
    var gaps = gapsFor(sideBySide);
    var result = new Array(gaps.length);
    var limit = 2 * ctx + 1;
    for (var i = 0; i < gaps.length; i++) result[i] = gaps[i].rows <= limit;
    return result;
  }

  function changeAnchors(sideBySide, renderedRows) {
    var rows;
    if (Array.isArray(renderedRows)) {
      rows = renderedRows;
    } else {
      // docs/protocol.md section 5: anchors are computed from the default-expanded layout.
      rows = buildRows(sideBySide, defaultExpanded(sideBySide));
    }
    var total = rows.length;
    var anchors = [];
    if (total === 0) return anchors;

    var i = 0;
    while (i < total) {
      var row = rows[i];
      if (!row || row.change !== true) {
        i += 1;
        continue;
      }
      var j = i + 1;
      while (j < total && rows[j] && rows[j].change === true) j += 1;
      var height = (j - i) / total;
      var minimum = 1 / total;
      anchors.push({
        index: i,
        top: i / total,
        height: height > minimum ? height : minimum,
        hunkIndex: row.hunkIndex === undefined ? null : row.hunkIndex
      });
      i = j;
    }
    return anchors;
  }

  function isPreviousDirection(direction) {
    if (typeof direction === 'number') return direction < 0;
    if (typeof direction === 'string') {
      var d = direction.toLowerCase();
      return d === 'prev' || d === 'previous' || d === 'up' || d === '-1' || d === 'back';
    }
    return false;
  }

  function findInList(list, fromIndex, previous) {
    if (!list || list.length === 0) return -1;
    var from = toInt(fromIndex);
    if (!Number.isFinite(from)) from = previous ? Number.MAX_SAFE_INTEGER : -1;

    var lo = 0;
    var hi = list.length;
    if (!previous) {
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (list[mid] <= from) lo = mid + 1;
        else hi = mid;
      }
      return lo < list.length ? list[lo] : -1;
    }
    while (lo < hi) {
      var midPrev = (lo + hi) >> 1;
      if (list[midPrev] < from) lo = midPrev + 1;
      else hi = midPrev;
    }
    return lo > 0 ? list[lo - 1] : -1;
  }

  function findNextChange(sideBySide, fromIndex, direction) {
    return findInList(changeIndexesFor(sideBySide), fromIndex, isPreviousDirection(direction));
  }

  function findNextChangeInRows(rows, fromIndex, direction) {
    if (!Array.isArray(rows)) return -1;
    var list = rows.changeRowIndexes;
    if (!Array.isArray(list)) {
      list = [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i].change === true) list.push(i);
      }
    }
    return findInList(list, fromIndex, isPreviousDirection(direction));
  }

  // ---------------------------------------------------------------------------
  // language detection
  // ---------------------------------------------------------------------------

  var EXTENSION_LANGUAGES = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
    ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
    json: 'json', jsonc: 'json', json5: 'json',
    css: 'css', scss: 'css', less: 'css', sass: 'css',
    html: 'html', htm: 'html', vue: 'html', svelte: 'html',
    md: 'md', markdown: 'md', mdx: 'md',
    yml: 'yaml', yaml: 'yaml',
    py: 'py', pyi: 'py', pyw: 'py',
    go: 'go',
    rs: 'rs',
    java: 'java',
    kt: 'kt', kts: 'kt',
    cs: 'cs', csx: 'cs',
    php: 'php', phtml: 'php',
    rb: 'rb', rake: 'rb', gemspec: 'rb',
    sh: 'sh', bash: 'sh', zsh: 'sh', ksh: 'sh',
    ps1: 'ps1', psm1: 'ps1',
    bat: 'bat', cmd: 'bat',
    sql: 'sql',
    xml: 'xml', xsl: 'xml', xslt: 'xml', svg: 'xml', plist: 'xml',
    toml: 'toml',
    ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini'
  };

  function detectLanguage(path) {
    if (typeof path !== 'string' || path === '') return null;
    var slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    var base = slash >= 0 ? path.slice(slash + 1) : path;
    if (!base) return null;
    var dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return null;
    var ext = base.slice(dot + 1).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(EXTENSION_LANGUAGES, ext)) return null;
    return EXTENSION_LANGUAGES[ext];
  }

  // ---------------------------------------------------------------------------
  // highlight - small per-line tokenizer
  // ---------------------------------------------------------------------------

  function kw(words) {
    var map = Object.create(null);
    var list = String(words).split(/\s+/);
    for (var i = 0; i < list.length; i++) {
      if (list[i]) map[list[i]] = true;
    }
    return map;
  }

  var LANGUAGE_ALIASES = {
    javascript: 'js', js: 'js', node: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
    typescript: 'ts', ts: 'ts', tsx: 'ts',
    json: 'json', jsonc: 'json',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', htm: 'html', vue: 'html', svelte: 'html',
    md: 'md', markdown: 'md',
    yaml: 'yaml', yml: 'yaml',
    python: 'py', py: 'py',
    go: 'go', golang: 'go',
    rust: 'rs', rs: 'rs',
    java: 'java', kotlin: 'kt', kt: 'kt',
    csharp: 'cs', 'c#': 'cs', cs: 'cs',
    php: 'php', ruby: 'rb', rb: 'rb',
    shell: 'sh', bash: 'sh', sh: 'sh', zsh: 'sh',
    powershell: 'ps1', ps1: 'ps1',
    bat: 'bat', batch: 'bat', cmd: 'bat',
    sql: 'sql',
    xml: 'xml', html5: 'html', svg: 'xml',
    toml: 'toml', ini: 'ini', properties: 'ini'
  };

  var KEYWORD_WORDS = {
    js: 'async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield',
    ts: 'abstract any as asserts async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of override private protected public readonly require return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield',
    json: 'true false null',
    html: 'html head body div span p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table thead tbody tfoot tr td th caption form input button select option optgroup textarea img script style link meta title nav header footer section article aside main figure figcaption br hr label fieldset legend canvas video audio source picture track pre code em strong small sub sup mark time details summary dialog template slot svg path circle rect line polygon polyline',
    yaml: 'true false null yes no on off',
    py: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self cls match case',
    go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota make new len cap append copy delete panic recover',
    rs: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
    java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield true false null',
    kt: 'as break class by catch companion const constructor continue crossinline data delegate do dynamic else enum expect external false field file final finally for fun get if import in infix init inline inner interface internal is lateinit noinline null object open operator out override package param private property protected public receiver reified return sealed set setparam super suspend tailrec this throw true try typealias typeof val var vararg when where while',
    cs: 'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in init int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while',
    php: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null',
    rb: 'BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_reader attr_writer attr_accessor',
    sh: 'if then else elif fi case esac for while until do done function in select time return break continue local export readonly declare unset shift source alias echo printf cd exit set trap test true false',
    ps1: 'begin break catch class continue data define do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while workflow true false null',
    bat: 'if else exist not errorlevel defined goto call set echo exit for in do rem start',
    sql: 'select from where insert into values update set delete create table alter drop index join left right inner outer full on group by order having union all distinct as and or not null is like between limit offset case when then else end exists primary key foreign references default constraint unique view database if begin commit rollback transaction procedure function trigger return declare asc desc count sum avg min max',
    xml: '',
    toml: 'true false',
    ini: 'true false yes no on off null none'
  };

  var LANGS = {
    js: {
      lineComments: ['//'], blockComments: [['/*', '*/']], quoteChars: '"\'',
      multilineQuotes: ['`'], keywords: kw(KEYWORD_WORDS.js)
    },
    ts: {
      lineComments: ['//'], blockComments: [['/*', '*/']], quoteChars: '"\'',
      multilineQuotes: ['`'], keywords: kw(KEYWORD_WORDS.ts)
    },
    json: { quoteChars: '"', keywords: kw(KEYWORD_WORDS.json) },
    css: { blockComments: [['/*', '*/']], quoteChars: '"\'', keywords: EMPTY_SET },
    html: {
      blockComments: [['<!--', '-->']], quoteChars: '"\'', keywords: kw(KEYWORD_WORDS.html),
      caseInsensitiveKeywords: true
    },
    md: { keywords: EMPTY_SET },
    yaml: { lineComments: ['#'], quoteChars: '"\'', keywords: kw(KEYWORD_WORDS.yaml), caseInsensitiveKeywords: true },
    py: {
      lineComments: ['#'], quoteChars: '"\'', multilineQuotes: ['"""', "'''"],
      keywords: kw(KEYWORD_WORDS.py)
    },
    go: {
      lineComments: ['//'], blockComments: [['/*', '*/']], quoteChars: '"\'',
      multilineQuotes: ['`'], keywords: kw(KEYWORD_WORDS.go)
    },
    rs: {
      lineComments: ['//'], blockComments: [['/*', '*/']], quoteChars: '"\'' ,
      keywords: kw(KEYWORD_WORDS.rs)
    },
    java: {
      lineComments: ['//'], blockComments: [['/*', '*/']], quoteChars: '"\'',
      multilineQuotes: ['"""'], keywords: kw(KEYWORD_WORDS.java)
    },
    kt: {
      lineComments: ['//'], blockComments: [['/*', '*/']], quoteChars: '"\'',
      multilineQuotes: ['"""'], keywords: kw(KEYWORD_WORDS.kt)
    },
    cs: {
      lineComments: ['//'], blockComments: [['/*', '*/']], quoteChars: '"\'' ,
      keywords: kw(KEYWORD_WORDS.cs)
    },
    php: {
      lineComments: ['//', '#'], blockComments: [['/*', '*/']], quoteChars: '"\'',
      keywords: kw(KEYWORD_WORDS.php)
    },
    rb: { lineComments: ['#'], quoteChars: '"\'', keywords: kw(KEYWORD_WORDS.rb) },
    sh: { lineComments: ['#'], quoteChars: '"\'', keywords: kw(KEYWORD_WORDS.sh) },
    ps1: {
      lineComments: ['#'], blockComments: [['<#', '#>']], quoteChars: '"\'',
      keywords: kw(KEYWORD_WORDS.ps1)
    },
    bat: { lineComments: ['::'], quoteChars: '"', keywords: kw(KEYWORD_WORDS.bat), caseInsensitiveKeywords: true },
    sql: {
      lineComments: ['--'], blockComments: [['/*', '*/']], quoteChars: '\'',
      keywords: kw(KEYWORD_WORDS.sql), caseInsensitiveKeywords: true, doubledQuoteEscape: true
    },
    xml: { blockComments: [['<!--', '-->']], quoteChars: '"\'', keywords: EMPTY_SET },
    toml: { lineComments: ['#'], quoteChars: '"\'', keywords: kw(KEYWORD_WORDS.toml) },
    ini: {
      lineComments: [';', '#'], quoteChars: '"\'', keywords: kw(KEYWORD_WORDS.ini),
      caseInsensitiveKeywords: true
    }
  };

  var PLAIN_LANGUAGE = { keywords: EMPTY_SET };

  function resolveLanguage(language) {
    if (typeof language !== 'string') return PLAIN_LANGUAGE;
    var key = language.trim().toLowerCase();
    if (!key) return PLAIN_LANGUAGE;
    if (Object.prototype.hasOwnProperty.call(LANGS, key)) return LANGS[key];
    if (Object.prototype.hasOwnProperty.call(LANGUAGE_ALIASES, key)) {
      var alias = LANGUAGE_ALIASES[key];
      if (Object.prototype.hasOwnProperty.call(LANGS, alias)) return LANGS[alias];
    }
    return PLAIN_LANGUAGE;
  }

  function langList(lang, field) {
    var value = lang ? lang[field] : null;
    return Array.isArray(value) ? value : [];
  }

  function langString(lang, field) {
    var value = lang ? lang[field] : null;
    return typeof value === 'string' ? value : '';
  }

  function isIdentifierStart(code) {
    return (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95 ||
      code === 36 ||
      code > 127
    );
  }

  function isIdentifierPart(code) {
    return isIdentifierStart(code) || (code >= 48 && code <= 57);
  }

  var NUMBER_RE = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)/y;

  function findStringClose(line, from, delim) {
    var hit = line.indexOf(delim, from);
    while (hit >= 0) {
      if (delim !== '`') return hit;
      var backslashes = 0;
      var k = hit - 1;
      while (k >= 0 && line.charCodeAt(k) === 92) {
        backslashes += 1;
        k -= 1;
      }
      if (backslashes % 2 === 0) return hit;
      hit = line.indexOf(delim, hit + 1);
    }
    return -1;
  }

  function tokenizeLine(line, lang, state) {
    var spans = [];
    var length = line.length;
    if (length === 0) return spans;

    var lineComments = langList(lang, 'lineComments');
    var blockComments = langList(lang, 'blockComments');
    var multilineQuotes = langList(lang, 'multilineQuotes');
    var quoteChars = langString(lang, 'quoteChars');
    var keywords = (lang && lang.keywords) || EMPTY_SET;
    var caseInsensitive = !!(lang && lang.caseInsensitiveKeywords);
    var backslashEscape = !(lang && lang.backslashEscape === false);
    var doubledQuoteEscape = !!(lang && lang.doubledQuoteEscape);

    var runClass = null;
    var runParts = [];

    function flushRun() {
      if (runClass !== null && runParts.length > 0) {
        spans.push({ text: runParts.join(''), cls: runClass });
      }
      runClass = null;
      runParts = [];
    }

    function push(cls, text) {
      if (text === '') return;
      if (runClass === cls) {
        runParts.push(text);
        return;
      }
      flushRun();
      runClass = cls;
      runParts = [text];
    }

    var i = 0;
    while (i < length) {
      // 1. continuation of a multi-line comment or multi-line string
      if (state.blockEnd !== null) {
        var blockEndIdx = line.indexOf(state.blockEnd, i);
        if (blockEndIdx < 0) {
          push('com', line.slice(i));
          i = length;
          break;
        }
        push('com', line.slice(i, blockEndIdx + state.blockEnd.length));
        i = blockEndIdx + state.blockEnd.length;
        state.blockEnd = null;
        continue;
      }
      if (state.quote !== null) {
        var quoteClose = findStringClose(line, i, state.quote);
        if (quoteClose < 0) {
          push('str', line.slice(i));
          i = length;
          break;
        }
        push('str', line.slice(i, quoteClose + state.quote.length));
        i = quoteClose + state.quote.length;
        state.quote = null;
        continue;
      }

      // 2. line comments
      var handled = false;
      for (var lc = 0; lc < lineComments.length; lc++) {
        var prefix = lineComments[lc];
        if (prefix && line.startsWith(prefix, i)) {
          push('com', line.slice(i));
          i = length;
          handled = true;
          break;
        }
      }
      if (handled) break;

      // 3. block comment start
      for (var bc = 0; bc < blockComments.length; bc++) {
        var pair = blockComments[bc];
        var open = pair[0];
        var close = pair[1];
        if (open && close && line.startsWith(open, i)) {
          var blockCloseIdx = line.indexOf(close, i + open.length);
          if (blockCloseIdx < 0) {
            push('com', line.slice(i));
            state.blockEnd = close;
            i = length;
            handled = true;
            break;
          }
          push('com', line.slice(i, blockCloseIdx + close.length));
          i = blockCloseIdx + close.length;
          handled = true;
          break;
        }
      }
      if (handled) continue;

      // 4. multi-line string start (template literals, triple quotes, raw strings)
      for (var mq = 0; mq < multilineQuotes.length; mq++) {
        var delim = multilineQuotes[mq];
        if (!delim || !line.startsWith(delim, i)) continue;
        var stringClose = findStringClose(line, i + delim.length, delim);
        if (stringClose < 0) {
          push('str', line.slice(i));
          state.quote = delim;
          i = length;
          handled = true;
          break;
        }
        push('str', line.slice(i, stringClose + delim.length));
        i = stringClose + delim.length;
        handled = true;
        break;
      }
      if (handled) continue;

      var ch = line[i];

      // 5. single-line string
      if (quoteChars !== '' && quoteChars.indexOf(ch) >= 0) {
        var j = i + 1;
        while (j < length) {
          var cj = line[j];
          if (backslashEscape && cj === '\\') {
            j += 2;
            continue;
          }
          if (cj === ch) {
            if (doubledQuoteEscape && line[j + 1] === ch) {
              j += 2;
              continue;
            }
            j += 1;
            break;
          }
          j += 1;
        }
        if (j > length) j = length;
        push('str', line.slice(i, j));
        i = j;
        continue;
      }

      // 6. number
      if (ch >= '0' && ch <= '9') {
        NUMBER_RE.lastIndex = i;
        var match = NUMBER_RE.exec(line);
        if (match && match[0].length > 0) {
          push('num', match[0]);
          i += match[0].length;
          continue;
        }
      }

      // 7. identifier / keyword
      if (isIdentifierStart(line.charCodeAt(i))) {
        var k2 = i + 1;
        while (k2 < length && isIdentifierPart(line.charCodeAt(k2))) k2 += 1;
        var word = line.slice(i, k2);
        var key = caseInsensitive ? word.toLowerCase() : word;
        push(keywords[key] ? 'kw' : 'id', word);
        i = k2;
        continue;
      }

      // 8. whitespace (plain class; merged runs stay cheap)
      var code = line.charCodeAt(i);
      if (
        code === 32 || code === 9 || code === 11 || code === 12 ||
        code === 13 || code === 0xa0 || code === 0x2028 || code === 0x2029
      ) {
        push('id', line[i]);
        i += 1;
        continue;
      }

      // 9. punctuation / operators
      push('punc', line[i]);
      i += 1;
    }

    flushRun();
    return spans;
  }

  function coerceHighlightText(text) {
    if (typeof text === 'string') return text;
    if (text === null || text === undefined) return '';
    try {
      return String(text);
    } catch (e) {
      return '';
    }
  }

  function splitDisplayLines(text) {
    if (text === '') return [];
    var parts = text.split('\n');
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    for (var i = 0; i < parts.length; i++) {
      var line = parts[i];
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) parts[i] = line.slice(0, -1);
    }
    return parts;
  }

  function highlight(text, language) {
    try {
      return tokenizeText(coerceHighlightText(text), resolveLanguage(language));
    } catch (error) {
      var fallbackLine = coerceHighlightText(text);
      return [{
        line: fallbackLine,
        spans: fallbackLine === '' ? [] : [{ text: fallbackLine, cls: 'id' }]
      }];
    }
  }

  function tokenizeText(input, lang) {
    if (input === '') return [{ line: '', spans: [] }];
    var lines = splitDisplayLines(input);
    if (lines.length === 0) return [{ line: '', spans: [] }];
    var out = new Array(lines.length);
    var state = { blockEnd: null, quote: null };
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var spans;
      try {
        spans = tokenizeLine(line, lang, state);
      } catch (error) {
        state = { blockEnd: null, quote: null };
        spans = line === '' ? [] : [{ text: line, cls: 'id' }];
      }
      out[i] = { line: line, spans: spans };
    }
    return out;
  }

  function highlightLine(text, language) {
    var result = highlight(text, language);
    return result.length > 0 && Array.isArray(result[0].spans) ? result[0].spans : [];
  }

  // ---------------------------------------------------------------------------
  // exports
  // ---------------------------------------------------------------------------

  exports.buildSideBySide = buildSideBySide;
  exports.changeAnchors = changeAnchors;
  exports.defaultExpanded = defaultExpanded;
  exports.detectLanguage = detectLanguage;
  exports.highlight = highlight;
  exports.findNextChange = findNextChange;
  exports.buildRows = buildRows;

  // documented extras for the React renderer (see file header)
  exports.highlightLine = highlightLine;
  exports.rowCount = rowCount;
  exports.rowIndexToOriginal = rowIndexToOriginal;
  exports.findNextChangeInRows = findNextChangeInRows;
});

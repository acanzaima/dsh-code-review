__def('diff-view', function (exports, require, React) {
  'use strict';

  /**
   * dsh-code-review — side-by-side virtualized diff pane.
   *
   * Public exports (stable, consumed by app.js):
   *   DiffPane — React.forwardRef((props, ref) => …)
   *
   * Props: { entry, entryDiff, loading, error, hunkMode, busy, onHunkMenu,
   *          onNotice, t }
   *   entryDiff  EntryDiff from the host (docs/protocol.md §3.2)
   *   hunkMode   'staged' | 'unstaged' | 'none' (menu semantics decided by app)
   *   onHunkMenu(hunkIndex, hunk, position {x,y}) — open the hunk context menu
   *   onNotice(message) — reserved for transient notices from this pane
   *
   * Imperative handle:
   *   nextChange(), prevChange(), scrollToTop(), focus(), clearContext()
   *
   * The pane defensively feature-detects the sibling `diff` module. If it is
   * missing or throws the pane degrades to a plain full-file comparison rather
   * than blanking the slot. `clearContext()` must be called by app.js when the
   * hunk menu closes so the brand-tinted hunk highlight is removed.
   */

  var h = React.createElement;
  var useLayoutEffect = React.useLayoutEffect || React.useEffect || function () {};

  var ROW_H = 20;           /* fixed display row height, must match components.css */
  var CONTEXT_LINES = 3;    /* collapsed gap expansion context */
  var OVERSCAN = 16;        /* rows rendered above/below the viewport */
  var MAX_RENDER_ROWS = 600;

  var EMPTY_ROWS = [];

  var STATUS_SET = { staged: true, unstaged: true, untracked: true, conflict: true };
  var STATUS_TONE = { staged: 'staged', unstaged: 'unstaged', untracked: 'untracked', conflict: 'conflict' };
  var CHANGE_SET = { added: true, modified: true, deleted: true, renamed: true, copied: true, typechange: true, conflict: true };
  var CHANGE_GLYPH = { added: '+', modified: 'M', deleted: '−', renamed: 'R', copied: 'C', typechange: 'T', conflict: '!' };

  var util = {};
  try {
    util = require('util') || {};
  } catch (error) {
    util = {};
  }

  /* Components are emitted after diff-view in the bundle. Modules only execute
   * on first require (after every __def has been registered), but resolve lazily
   * anyway so a missing sibling module never breaks this slot. */
  var componentsModuleCache = null;
  var diffModuleCache = null;

  function safeRequire(name) {
    try {
      return require(name) || {};
    } catch (error) {
      return {};
    }
  }

  function componentsModule() {
    if (componentsModuleCache === null) componentsModuleCache = safeRequire('components');
    return componentsModuleCache;
  }

  function diffModule() {
    if (diffModuleCache === null) diffModuleCache = safeRequire('diff');
    return diffModuleCache;
  }

  function callDiff(name, args, fallback) {
    var module = diffModule();
    var fn = module && module[name];
    if (typeof fn !== 'function') return fallback;
    try {
      return fn.apply(null, args);
    } catch (error) {
      return fallback;
    }
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  function noop() {}

  function cx() {
    if (typeof util.cx === 'function') return util.cx.apply(null, arguments);
    var out = [];
    for (var index = 0; index < arguments.length; index += 1) {
      var value = arguments[index];
      if (!value) continue;
      if (typeof value === 'string') out.push(value);
      else if (Array.isArray(value)) {
        var nested = cx.apply(null, value);
        if (nested) out.push(nested);
      } else if (typeof value === 'object') {
        for (var key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key) && value[key]) out.push(key);
        }
      }
    }
    return out.join(' ');
  }

  function clamp(value, min, max) {
    if (typeof util.clamp === 'function') return util.clamp(value, min, max);
    var number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  function formatCount(value) {
    if (typeof util.formatCount === 'function') return util.formatCount(value);
    var number = Number(value);
    return Number.isFinite(number) ? String(number) : '0';
  }

  function identityT(key) {
    return String(key);
  }

  function makeT(t) {
    return typeof t === 'function' ? t : identityT;
  }

  function errorMessage(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (typeof error.message === 'string' && error.message) return error.message;
    if (typeof error.code === 'string' && error.code) return error.code;
    return String(error);
  }

  function focusNode(node) {
    if (!node || typeof node.focus !== 'function') return;
    try {
      node.focus({ preventScroll: true });
    } catch (error) {
      try {
        node.focus();
      } catch (ignored) {
        /* best effort */
      }
    }
  }

  function scheduleFrame(callback) {
    if (typeof requestAnimationFrame === 'function') return { raf: true, id: requestAnimationFrame(callback) };
    return { raf: false, id: setTimeout(callback, 16) };
  }

  function cancelScheduled(handle) {
    if (!handle) return;
    if (handle.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle.id);
    else clearTimeout(handle.id);
  }

  function isGapRow(row) {
    return !!row && (row.gap === true || row.kind === 'gap');
  }

  function splitLines(text) {
    var source = typeof text === 'string' ? text : '';
    if (!source) return [];
    var lines = source.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** Degraded full-file comparison used only when `diff.buildSideBySide` is absent/crashing. */
  function fallbackSideBySide(entryDiff) {
    var baseLines = splitLines(entryDiff && entryDiff.base ? entryDiff.base.text : '');
    var targetLines = splitLines(entryDiff && entryDiff.target ? entryDiff.target.text : '');
    var count = Math.max(baseLines.length, targetLines.length);
    var rows = [];
    var changeRowIndexes = [];
    var limit = Math.min(count, 20000);
    for (var index = 0; index < limit; index += 1) {
      var leftText = index < baseLines.length ? baseLines[index] : null;
      var rightText = index < targetLines.length ? targetLines[index] : null;
      var changed = leftText !== rightText;
      if (changed) changeRowIndexes.push(index);
      rows.push({
        left: leftText === null
          ? { no: null, text: '', kind: 'empty' }
          : { no: index + 1, text: leftText, kind: changed ? 'del' : 'ctx' },
        right: rightText === null
          ? { no: null, text: '', kind: 'empty' }
          : { no: index + 1, text: rightText, kind: changed ? 'add' : 'ctx' },
        change: changed,
        hunkIndex: changed ? 0 : null,
      });
    }
    return {
      rows: rows,
      changeRowIndexes: changeRowIndexes,
      hunkRowRanges: [],
      hasFullContext: false,
      language: null,
      stats: null,
    };
  }

  function entrySignature(entry, entryDiff) {
    var parts = [];
    parts.push(entry && entry.key ? String(entry.key) : '');
    var repo = (entryDiff && entryDiff.repo) || null;
    parts.push(repo && repo.headSha ? String(repo.headSha) : '');
    /* content + mode + submodule gitlink identity: any change re-initialises
     * the rendered pane and invalidates its hunk context. */
    var fingerprintIdentity = '';
    if (typeof util.fingerprintKey === 'function') {
      fingerprintIdentity = util.fingerprintKey(entry);
    } else {
      var fingerprint = entry && entry.fingerprint ? entry.fingerprint : null;
      if (fingerprint) fingerprintIdentity = String(fingerprint.base || '') + ':' + String(fingerprint.target || '');
    }
    parts.push(fingerprintIdentity);
    parts.push(entryDiff && entryDiff.unsupported && entryDiff.unsupported.code ? String(entryDiff.unsupported.code) : '');
    parts.push(entryDiff && entryDiff.base ? String(entryDiff.base.bytes || 0) : '');
    parts.push(entryDiff && entryDiff.target ? String(entryDiff.target.bytes || 0) : '');
    return parts.join('|');
  }

  function totalBytes(entryDiff) {
    var total = 0;
    if (entryDiff && entryDiff.base && Number(entryDiff.base.bytes) > 0) total += Number(entryDiff.base.bytes);
    if (entryDiff && entryDiff.target && Number(entryDiff.target.bytes) > 0) total += Number(entryDiff.target.bytes);
    return total;
  }

  function normalizeTokenClass(cls) {
    var name = String(cls || '');
    if (name === 'kw' || name === 'str' || name === 'num' || name === 'com' || name === 'id' || name === 'punc') return name;
    return 'punc';
  }

  /** Accepts both documented shapes: [{text,cls}] and [{line, spans:[{text,cls}]}]. */
  function highlightTokens(text, language) {
    if (!text || !language) return null;
    var result = callDiff('highlight', [text, language], null);
    if (!result) return null;
    var spans = null;
    if (Array.isArray(result)) {
      if (result.length > 0 && result[0] && typeof result[0] === 'object' && Array.isArray(result[0].spans)) {
        spans = [];
        for (var lineIndex = 0; lineIndex < result.length; lineIndex += 1) {
          var line = result[lineIndex];
          if (line && Array.isArray(line.spans)) spans = spans.concat(line.spans);
        }
      } else {
        spans = result;
      }
    } else if (result && Array.isArray(result.spans)) {
      spans = result.spans;
    }
    if (!Array.isArray(spans) || spans.length === 0) return null;
    var tokens = [];
    for (var index = 0; index < spans.length; index += 1) {
      var span = spans[index];
      if (!span || typeof span.text !== 'string') continue;
      tokens.push({ text: span.text, cls: normalizeTokenClass(span.cls) });
    }
    return tokens.length > 0 ? tokens : null;
  }

  function contentWidth(maxChars) {
    var chars = clamp(Math.ceil(maxChars), 48, 4000);
    /* Two code columns scroll together inside one grid: each half must fit
     * `chars` monospace characters, so the whole grid needs twice that plus the
     * sticky gutters. Expressed as the documented max(100%, calc(...)) form. */
    return 'max(100%, calc(' + (chars * 0.62 * 2).toFixed(1) + 'em + 120px))';
  }

  function findHunk(entryDiff, hunkIndex) {
    var hunks = entryDiff && Array.isArray(entryDiff.hunks) ? entryDiff.hunks : [];
    for (var index = 0; index < hunks.length; index += 1) {
      var hunk = hunks[index];
      if (hunk && hunk.index === hunkIndex) return hunk;
    }
    return null;
  }

  function currentChangePosition(changeRowIndexes, scrollTop) {
    if (!changeRowIndexes || changeRowIndexes.length === 0) return 0;
    var firstVisible = scrollTop / ROW_H;
    var position = 0;
    for (var index = 0; index < changeRowIndexes.length; index += 1) {
      if (changeRowIndexes[index] <= firstVisible + 0.5) position = index;
      else break;
    }
    return position;
  }

  /**
   * Counter position for the change navigator. A pinned row (clicked or
   * navigated to) wins; otherwise the change at/above the viewport top is the
   * current one, so the counter keeps following scrolling.
   */
  function changeCounterIndex(changeRowIndexes, scrollTop, pinnedRow) {
    if (!changeRowIndexes || changeRowIndexes.length === 0) return -1;
    if (typeof pinnedRow === 'number') {
      var pinned = changeRowIndexes.indexOf(pinnedRow);
      if (pinned >= 0) return pinned;
    }
    return currentChangePosition(changeRowIndexes, scrollTop);
  }

  /**
   * Anchor row: the last change row at or above `row`. Used to keep the
   * navigation anchor in sync with manual scrolling (the row the user is
   * looking at), so repeated "next change" presses advance instead of
   * re-centering the same row every time.
   */
  function changeAnchorRow(changeRowIndexes, row) {
    if (!Array.isArray(changeRowIndexes) || changeRowIndexes.length === 0) return null;
    var target = Number(row);
    if (!Number.isFinite(target)) return null;
    var found = null;
    for (var index = 0; index < changeRowIndexes.length; index += 1) {
      if (changeRowIndexes[index] <= target + 0.5) found = changeRowIndexes[index];
      else break;
    }
    return found;
  }

  /**
   * Next/previous change row relative to the anchor. `direction > 0` returns the
   * first change strictly below the anchor (falling back to the last change);
   * `direction < 0` mirrors this upward (falling back to the first change).
   */
  function resolveChangeTarget(changeRowIndexes, currentRow, direction) {
    if (!Array.isArray(changeRowIndexes) || changeRowIndexes.length === 0) return null;
    var forward = !(Number(direction) < 0);
    var anchor = Number(currentRow);
    var index;
    if (!Number.isFinite(anchor)) return changeRowIndexes[0];
    if (forward) {
      for (index = 0; index < changeRowIndexes.length; index += 1) {
        if (changeRowIndexes[index] > anchor + 0.5) return changeRowIndexes[index];
      }
      return changeRowIndexes[changeRowIndexes.length - 1];
    }
    for (index = changeRowIndexes.length - 1; index >= 0; index -= 1) {
      if (changeRowIndexes[index] < anchor - 0.5) return changeRowIndexes[index];
    }
    return changeRowIndexes[0];
  }

  function unsupportedTitle(info, entryDiff, t) {
    var code = info && info.code;
    if (code === 'conflict') return t('diff.unsupportedConflict');
    if (code === 'binary') return t('diff.binaryNotice');
    if (code === 'submodule') return t('diff.unsupportedSubmodule');
    if (code === 'symlink') return t('diff.unsupportedSymlink');
    if (code === 'too-large') return t('diff.truncated', { bytes: formatCount(totalBytes(entryDiff)) });
    if (code === 'mode-only') {
      var mode = entryDiff && entryDiff.modeChange;
      if (mode && (mode.oldMode || mode.newMode)) {
        return t('diff.modeOnly', { from: String(mode.oldMode || '?'), to: String(mode.newMode || '?') });
      }
      return t('diff.noText');
    }
    if (info && info.message) return String(info.message);
    return t('diff.noText');
  }

  /* ------------------------------------------------------------------ */
  /* DiffPane                                                            */
  /* ------------------------------------------------------------------ */

  var forwardRef = typeof React.forwardRef === 'function' ? React.forwardRef : function (component) { return component; };

  var DiffPane = forwardRef(function DiffPane(props, ref) {
    var t = makeT(props.t);
    var entry = props.entry || (props.entryDiff && props.entryDiff.entry) || null;
    var entryDiff = props.entryDiff || null;
    var loading = !!props.loading;
    var error = props.error || null;
    var busy = !!props.busy;

    /* ---- model ------------------------------------------------------ */

    var sideBySide = React.useMemo(function () {
      if (!entryDiff) return null;
      if (entryDiff.unsupported) return null;
      var built = callDiff('buildSideBySide', [entryDiff], null);
      if (built && Array.isArray(built.rows)) return built;
      return fallbackSideBySide(entryDiff);
    }, [entryDiff]);

    var defaults = React.useMemo(function () {
      if (!sideBySide) return null;
      var value = callDiff('defaultExpanded', [sideBySide, CONTEXT_LINES], null);
      if (Array.isArray(value)) {
        var list = [];
        for (var index = 0; index < value.length; index += 1) list.push(!!value[index]);
        return list;
      }
      return null;
    }, [sideBySide]);

    var signature = React.useMemo(function () {
      return entrySignature(entry, entryDiff);
    }, [entry, entryDiff]);

    var signatureState = React.useState(signature);
    var previousSignature = signatureState[0];
    var setPreviousSignature = signatureState[1];
    var expandedState = React.useState(defaults);
    var expanded = expandedState[0];
    var setExpanded = expandedState[1];
    var contextState = React.useState(null);
    var contextHunk = contextState[0];
    var setContextHunk = contextState[1];
    var rovingState = React.useState(-1);
    var rovingRow = rovingState[0];
    var setRovingRow = rovingState[1];
    /* Navigation anchor: the change row the user last navigated to / is looking
     * at. Repeated "next change" presses advance from it instead of restarting
     * from the viewport top (which would re-select a centred row forever). */
    var navAnchorRef = React.useRef(null);
    var programmaticScrollRef = React.useRef(false);
    var programmaticClearRef = React.useRef(null);
    /* The row the user clicked / navigated to: its gray selection and the
     * top-right counter stay on it until the next manual scroll. */
    var pinnedState = React.useState(null);
    var pinnedChangeRow = pinnedState[0];
    var setPinnedChangeRow = pinnedState[1];
    var hOffsetState = React.useState({ left: 0, right: 0 });
    var hOffsets = hOffsetState[0];
    var setHOffsets = hOffsetState[1];
    var tokenCacheRef = React.useRef(null);

    /* Reset per-entry UI state during render (supported React pattern). */
    if (previousSignature !== signature) {
      setPreviousSignature(signature);
      setExpanded(defaults);
      setContextHunk(null);
      setHOffsets({ left: 0, right: 0 });
      setPinnedChangeRow(null);
      if (tokenCacheRef.current) tokenCacheRef.current.clear();
    }

    var displayRows = React.useMemo(function () {
      if (!sideBySide) return EMPTY_ROWS;
      var built = callDiff('buildRows', [sideBySide, Array.isArray(expanded) ? expanded : [], CONTEXT_LINES], null);
      if (Array.isArray(built)) return built;
      return sideBySide.rows || EMPTY_ROWS;
    }, [sideBySide, expanded]);

    /* Collapsing gaps renumbers display rows: drop cached tokens then. */
    var lastRowsRef = React.useRef(null);
    if (lastRowsRef.current !== displayRows) {
      lastRowsRef.current = displayRows;
      if (tokenCacheRef.current) tokenCacheRef.current.clear();
    }

    var changeRowIndexes = React.useMemo(function () {
      /* buildRows() publishes the rendered change-row indexes as row metadata;
       * prefer them because they already account for collapsed gaps. */
      var metadata = displayRows ? displayRows.changeRowIndexes : null;
      if (Array.isArray(metadata)) {
        var published = [];
        for (var metaIndex = 0; metaIndex < metadata.length; metaIndex += 1) {
          var publishedIndex = Number(metadata[metaIndex]);
          if (Number.isInteger(publishedIndex) && publishedIndex >= 0) published.push(publishedIndex);
        }
        return published;
      }
      var list = [];
      for (var index = 0; index < displayRows.length; index += 1) {
        var row = displayRows[index];
        if (!row || isGapRow(row)) continue;
        if (row.change === true) {
          list.push(index);
          continue;
        }
        var leftKind = row.left && row.left.kind;
        var rightKind = row.right && row.right.kind;
        if (leftKind === 'del' || rightKind === 'add') list.push(index);
      }
      return list;
    }, [displayRows]);

    /* First rendered row of every hunk: the roving tabindex lands on one of
     * these and Alt+↑/↓ jumps between them, so a hunk can be reached with the
     * keyboard only. */
    var hunkFirstRows = React.useMemo(function () {
      var list = [];
      var lastHunk = null;
      for (var index = 0; index < displayRows.length; index += 1) {
        var row = displayRows[index];
        if (!row || isGapRow(row) || row.truncationRow === true) continue;
        var hunkIndex = typeof row.hunkIndex === 'number' ? row.hunkIndex : null;
        if (hunkIndex === null) continue;
        if (hunkIndex !== lastHunk) {
          list.push(index);
          lastHunk = hunkIndex;
        }
      }
      return list;
    }, [displayRows]);

    var defaultRovingRow = displayRows.length === 0
      ? -1
      : (hunkFirstRows.length > 0 ? hunkFirstRows[0] : 0);
    var effectiveRovingRow = rovingRow >= 0 && rovingRow < displayRows.length ? rovingRow : defaultRovingRow;

    /* A new layout (different file, expanded/collapsed gaps) invalidates both
     * the navigation anchor and the roving focus row. */
    React.useEffect(function () {
      navAnchorRef.current = null;
      programmaticScrollRef.current = false;
      if (programmaticClearRef.current !== null) {
        clearTimeout(programmaticClearRef.current);
        programmaticClearRef.current = null;
      }
      setRovingRow(-1);
    }, [displayRows]);

    var maxCharsLeft = React.useMemo(function () {
      var best = 0;
      for (var index = 0; index < displayRows.length; index += 1) {
        var row = displayRows[index];
        if (!row || isGapRow(row)) continue;
        var leftText = row.left && typeof row.left.text === 'string' ? row.left.text : '';
        if (leftText.length > best) best = leftText.length;
      }
      return best;
    }, [displayRows]);

    var maxCharsRight = React.useMemo(function () {
      var best = 0;
      for (var index = 0; index < displayRows.length; index += 1) {
        var row = displayRows[index];
        if (!row || isGapRow(row)) continue;
        var rightText = row.right && typeof row.right.text === 'string' ? row.right.text : '';
        if (rightText.length > best) best = rightText.length;
      }
      return best;
    }, [displayRows]);

    /* One minimap block per contiguous changed-line run, like TortoiseGit's
     * left overview strip: green = added (right side), red = deleted (left
     * side), red|green split = modified on both sides. Huge diffs fall back to
     * one block per hunk so the strip stays cheap to render. */
    function buildChangeMarkers(rows) {
      var total = rows.length;
      var blocks = [];
      var current = null;
      for (var index = 0; index < total; index += 1) {
        var row = rows[index];
        if (!row || isGapRow(row)) {
          current = null;
          continue;
        }
        var hasAdd = !!(row.right && row.right.kind === 'add');
        var hasDel = !!(row.left && row.left.kind === 'del');
        if (!hasAdd && !hasDel) {
          current = null;
          continue;
        }
        if (current && current.end === index) {
          current.end = index + 1;
          if (hasAdd) current.hasAdd = true;
          if (hasDel) current.hasDel = true;
          continue;
        }
        current = {
          start: index,
          end: index + 1,
          hasAdd: hasAdd,
          hasDel: hasDel,
          hunkIndex: typeof row.hunkIndex === 'number' ? row.hunkIndex : null,
        };
        blocks.push(current);
      }
      return blocks;
    }

    function buildHunkMarkers(rows) {
      var total = rows.length;
      var blocks = [];
      var current = null;
      for (var index = 0; index < total; index += 1) {
        var row = rows[index];
        var hunkIndex = row && !isGapRow(row) && typeof row.hunkIndex === 'number' ? row.hunkIndex : null;
        if (hunkIndex === null) {
          current = null;
          continue;
        }
        if (current && current.hunkIndex === hunkIndex && current.end === index) {
          current.end = index + 1;
          if (row.left && row.left.kind === 'del') current.hasDel = true;
          if (row.right && row.right.kind === 'add') current.hasAdd = true;
          continue;
        }
        current = {
          hunkIndex: hunkIndex,
          start: index,
          end: index + 1,
          hasAdd: !!(row.right && row.right.kind === 'add'),
          hasDel: !!(row.left && row.left.kind === 'del'),
        };
        blocks.push(current);
      }
      return blocks;
    }

    var markers = React.useMemo(function () {
      var total = displayRows.length;
      if (!total) return [];
      var blocks = buildChangeMarkers(displayRows);
      if (blocks.length > 600) blocks = buildHunkMarkers(displayRows);
      var output = [];
      for (var blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
        var block = blocks[blockIndex];
        output.push({
          key: 'm-' + blockIndex + '-' + block.start,
          hunkIndex: typeof block.hunkIndex === 'number' ? block.hunkIndex : null,
          start: block.start,
          top: (block.start / total) * 100,
          height: Math.max(((block.end - block.start) / total) * 100, 0.22),
          tone: block.hasAdd && block.hasDel ? 'both' : block.hasAdd ? 'add' : 'del',
        });
      }
      return output;
    }, [displayRows]);

    var gapOrdinalByIndex = React.useMemo(function () {
      var map = {};
      var ordinal = 0;
      for (var index = 0; index < displayRows.length; index += 1) {
        if (isGapRow(displayRows[index])) {
          map[index] = ordinal;
          ordinal += 1;
        }
      }
      return map;
    }, [displayRows]);

    var language = React.useMemo(function () {
      if (sideBySide && sideBySide.language) return sideBySide.language;
      if (!entry || !entry.path) return null;
      var detected = callDiff('detectLanguage', [entry.path], null);
      return typeof detected === 'string' && detected ? detected : null;
    }, [sideBySide, entry]);

    /* ---- scrolling / virtualization --------------------------------- */

    var scrollRef = React.useRef(null);
    var leftProxyRef = React.useRef(null);
    var rightProxyRef = React.useRef(null);
    var minimapRef = React.useRef(null);
    var markersRef = React.useRef([]);

    markersRef.current = markers;
    var minimapDragRef = React.useRef(false);
    var viewportState = React.useState({ scrollTop: 0, height: 0 });
    var viewport = viewportState[0];
    var setViewport = viewportState[1];
    var scrollFrameRef = React.useRef(null);
    var pendingFocusRef = React.useRef(null);
    var totalRowsRef = React.useRef(displayRows.length);
    var changeRowsRef = React.useRef(changeRowIndexes);
    totalRowsRef.current = displayRows.length;
    changeRowsRef.current = changeRowIndexes;
    /* The change row the counter refers to: a pinned (clicked/navigated) row
     * wins, otherwise the change at/above the viewport top follows scrolling. */
    var activeChangeIndex = changeCounterIndex(changeRowIndexes, viewport.scrollTop, pinnedChangeRow);
    var activeChangeRow = activeChangeIndex >= 0 ? changeRowIndexes[activeChangeIndex] : null;
    /* Read by the scroll handler: an explicit clicked/navigated selection must
     * survive scrolling (the handler cannot see the state without a dep bump). */
    var pinnedChangeRowRef = React.useRef(null);
    pinnedChangeRowRef.current = pinnedChangeRow;

    var measure = React.useCallback(function () {
      var node = scrollRef.current;
      if (!node) return;
      var nextTop = node.scrollTop;
      var nextHeight = node.clientHeight;
      setViewport(function (current) {
        if (current.scrollTop === nextTop && current.height === nextHeight) return current;
        return { scrollTop: nextTop, height: nextHeight };
      });
    }, []);

    var lastMeasuredSignature = React.useRef('');

    useLayoutEffect(function () {
      var node = scrollRef.current;
      if (!node) return undefined;
      if (lastMeasuredSignature.current !== signature) {
        lastMeasuredSignature.current = signature;
        node.scrollTop = 0;
      }
      measure();
      var observer = null;
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(function () {
          measure();
        });
        observer.observe(node);
      }
      if (typeof window !== 'undefined') window.addEventListener('resize', measure);
      return function () {
        if (observer) observer.disconnect();
        if (typeof window !== 'undefined') window.removeEventListener('resize', measure);
      };
    }, [measure, signature, displayRows.length]);

    React.useEffect(function () {
      return function () {
        if (scrollFrameRef.current) cancelScheduled(scrollFrameRef.current);
        if (pendingFocusRef.current) cancelScheduled(pendingFocusRef.current);
        if (programmaticClearRef.current !== null) clearTimeout(programmaticClearRef.current);
        scrollFrameRef.current = null;
        pendingFocusRef.current = null;
        programmaticClearRef.current = null;
      };
    }, []);

    var handleScroll = React.useCallback(function () {
      if (scrollFrameRef.current) return;
      scrollFrameRef.current = scheduleFrame(function () {
        scrollFrameRef.current = null;
        measure();
        if (programmaticScrollRef.current) {
          programmaticScrollRef.current = false;
          return;
        }
        /* Scrolling only drives the selection while the user has not picked a
         * row explicitly; a clicked/navigated row stays selected. */
        if (pinnedChangeRowRef.current !== null) return;
        var node = scrollRef.current;
        if (!node) return;
        var centreRow = (node.scrollTop + node.clientHeight / 2) / ROW_H;
        var anchor = changeAnchorRow(changeRowsRef.current, centreRow);
        if (anchor !== null) navAnchorRef.current = anchor;
      });
    }, [measure]);

    function scrollToRow(rowIndex, alignCenter) {
      var node = scrollRef.current;
      if (!node) return;
      var rows = totalRowsRef.current;
      if (!rows) return;
      var target = clamp(Math.floor(Number(rowIndex) || 0), 0, rows - 1);
      var top = target * ROW_H;
      if (alignCenter) top -= Math.max(0, (node.clientHeight - ROW_H) / 2);
      var maxTop = Math.max(0, rows * ROW_H - node.clientHeight);
      node.scrollTop = clamp(top, 0, maxTop);
      measure();
    }

    function markProgrammaticScroll() {
      programmaticScrollRef.current = true;
      if (programmaticClearRef.current !== null) clearTimeout(programmaticClearRef.current);
      programmaticClearRef.current = setTimeout(function () {
        programmaticClearRef.current = null;
        programmaticScrollRef.current = false;
      }, 150);
    }

    function navigateChange(direction) {
      var changes = changeRowsRef.current;
      if (!changes || changes.length === 0) return;
      var node = scrollRef.current;
      /* Nothing to scroll (every row already fits): advance from the current
       * selection instead of a viewport centre that is beyond the last row. */
      var scrollable = totalRowsRef.current * ROW_H > (node ? node.clientHeight : 0);
      var current = navAnchorRef.current;
      if (current === null || !Number.isFinite(current)) {
        current = node && scrollable
          ? (node.scrollTop + node.clientHeight / 2) / ROW_H
          : changes[0];
      }
      var target = resolveChangeTarget(changes, current, direction);
      if (target === null) return;
      navAnchorRef.current = target;
      setPinnedChangeRow(target);
      markProgrammaticScroll();
      scrollToRow(target, true);
    }

    React.useImperativeHandle(ref, function () {
      return {
        nextChange: function () {
          navigateChange(1);
        },
        prevChange: function () {
          navigateChange(-1);
        },
        scrollToTop: function () {
          var node = scrollRef.current;
          if (!node) return;
          node.scrollTop = 0;
          measure();
        },
        focus: function () {
          focusNode(scrollRef.current);
        },
        clearContext: function () {
          setContextHunk(null);
        },
      };
    }, [measure, setContextHunk]);

    /* ---- hunk context menu ------------------------------------------ */

    function openHunkMenu(row, position, rowIndex) {
      if (!row || typeof row.hunkIndex !== 'number') return false;
      if (typeof rowIndex === 'number' && Number.isFinite(rowIndex)) {
        navAnchorRef.current = rowIndex;
        setRovingRow(rowIndex);
      }
      setContextHunk(row.hunkIndex);
      if (typeof props.onHunkMenu === 'function') {
        try {
          props.onHunkMenu(row.hunkIndex, findHunk(entryDiff, row.hunkIndex), position || { x: 0, y: 0 });
        } catch (clickError) {
          if (typeof console !== 'undefined' && console.error) console.error('[code-review] hunk menu handler failed', clickError);
        }
      }
      return true;
    }

    function handleRowContextMenu(event, row, rowIndex) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      openHunkMenu(row, {
        x: event && Number.isFinite(event.clientX) ? event.clientX : 0,
        y: event && Number.isFinite(event.clientY) ? event.clientY : 0,
      }, rowIndex);
    }

    function jumpToHunk(delta, fromRow) {
      var list = hunkFirstRows;
      if (!list || list.length === 0) return;
      var target = null;
      var index;
      if (delta > 0) {
        for (index = 0; index < list.length; index += 1) {
          if (list[index] > fromRow) {
            target = list[index];
            break;
          }
        }
        if (target === null) target = list[list.length - 1];
      } else {
        for (index = list.length - 1; index >= 0; index -= 1) {
          if (list[index] < fromRow) {
            target = list[index];
            break;
          }
        }
        if (target === null) target = list[0];
      }
      setRovingRow(target);
      navAnchorRef.current = target;
      markProgrammaticScroll();
      scrollToRow(target, true);
      focusRenderedRow(target);
    }

    function handleRowKeyDown(event, row, rowIndex) {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        event.stopPropagation();
        var menuRect = event.currentTarget.getBoundingClientRect();
        openHunkMenu(row, { x: menuRect.left + 28, y: menuRect.top + ROW_H }, rowIndex);
        return;
      }
      if (event.key === 'Enter') {
        /* Enter on a focused line opens the same hunk menu as ContextMenu; the
         * cell is a row in a diff, not a button, so Enter must not be a no-op. */
        event.preventDefault();
        event.stopPropagation();
        var enterRect = event.currentTarget.getBoundingClientRect();
        openHunkMenu(row, { x: enterRect.left + 28, y: enterRect.top + ROW_H }, rowIndex);
        return;
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        jumpToHunk(event.key === 'ArrowDown' ? 1 : -1, rowIndex);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        var rows = totalRowsRef.current;
        if (rows <= 0) return;
        var next = clamp(rowIndex + (event.key === 'ArrowDown' ? 1 : -1), 0, rows - 1);
        if (next === rowIndex) return;
        setRovingRow(next);
        focusRenderedRow(next);
      }
    }

    function expandGap(gapIndex) {
      var index = Number(gapIndex);
      if (!Number.isFinite(index) || index < 0) return;
      setExpanded(function (current) {
        var next = Array.isArray(current) ? current.slice() : [];
        while (next.length <= index) next.push(false);
        next[index] = true;
        return next;
      });
    }

    /* ---- minimap ---------------------------------------------------- */

    function minimapScrollTo(clientY) {
      var strip = minimapRef.current;
      var node = scrollRef.current;
      if (!strip || !node) return;
      var rows = totalRowsRef.current;
      if (!rows) return;
      var rect = strip.getBoundingClientRect();
      if (!rect.height) return;
      var fraction = clamp((clientY - rect.top) / rect.height, 0, 1);
      var rowIndex = Math.floor(fraction * rows);
      /* Snap to a nearby change block so a click/drag onto a coloured mark
       * lands exactly on that change instead of a line or two off. */
      var list = markersRef.current || [];
      var threshold = Math.max(1, Math.ceil(rows * 0.012));
      var nearest = null;
      var nearestDistance = Infinity;
      for (var index = 0; index < list.length; index += 1) {
        var marker = list[index];
        var markerRow = Math.round(((marker.top + marker.height / 2) / 100) * rows);
        var distance = Math.abs(markerRow - rowIndex);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = marker;
        }
      }
      if (nearest && nearestDistance <= threshold) {
        scrollToRow(nearest.start, true);
        return;
      }
      scrollToRow(rowIndex, true);
    }

    function handleMinimapPointerDown(event) {
      if (!event) return;
      if (event.button !== undefined && event.button !== 0) return;
      minimapDragRef.current = true;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function' && event.pointerId !== undefined) {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch (error) {
          /* pointer capture is optional */
        }
      }
      minimapScrollTo(event.clientY);
    }

    function handleMinimapPointerMove(event) {
      if (!minimapDragRef.current || !event) return;
      minimapScrollTo(event.clientY);
    }

    function handleMinimapPointerUp(event) {
      minimapDragRef.current = false;
      if (event && event.currentTarget && typeof event.currentTarget.releasePointerCapture === 'function' && event.pointerId !== undefined) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch (error) {
          /* ignore */
        }
      }
    }

    function handleMinimapKeyDown(event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        navigateChange(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        var node = scrollRef.current;
        if (!node) return;
        node.scrollTop = event.key === 'Home' ? 0 : Math.max(0, totalRowsRef.current * ROW_H - node.clientHeight);
        measure();
      }
    }

    /* ---- keyboard navigation in the scroll container ---------------- */

    function activeRowIndex() {
      if (typeof document === 'undefined') return null;
      var active = document.activeElement;
      if (!active || typeof active.closest !== 'function') return null;
      var row = active.closest('[data-row]');
      if (!row) return null;
      var index = Number(row.getAttribute('data-row'));
      return Number.isFinite(index) ? index : null;
    }

    function ensureRowVisible(rowIndex) {
      var node = scrollRef.current;
      if (!node) return;
      var top = rowIndex * ROW_H;
      var bottom = top + ROW_H;
      if (node.scrollTop > top) node.scrollTop = top;
      else if (node.scrollTop + node.clientHeight < bottom) node.scrollTop = bottom - node.clientHeight;
      measure();
    }

    function focusRenderedRow(rowIndex) {
      var node = scrollRef.current;
      if (!node) return;
      var target = node.querySelector('[data-row="' + rowIndex + '"]');
      if (target) {
        focusNode(target);
        ensureRowVisible(rowIndex);
        return;
      }
      ensureRowVisible(rowIndex);
      if (pendingFocusRef.current) cancelScheduled(pendingFocusRef.current);
      pendingFocusRef.current = scheduleFrame(function () {
        pendingFocusRef.current = null;
        var later = scrollRef.current && scrollRef.current.querySelector('[data-row="' + rowIndex + '"]');
        if (later) focusNode(later);
      });
    }

    function handleScrollKeyDown(event) {
      if (event.defaultPrevented) return;
      var node = scrollRef.current;
      if (!node) return;
      var key = event.key;
      var rows = totalRowsRef.current;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        var current = activeRowIndex();
        var delta = key === 'ArrowDown' ? 1 : -1;
        if (current === null) {
          var maxTop = Math.max(0, rows * ROW_H - node.clientHeight);
          node.scrollTop = clamp(node.scrollTop + delta * ROW_H, 0, maxTop);
          measure();
          return;
        }
        focusRenderedRow(clamp(current + delta, 0, Math.max(0, rows - 1)));
        return;
      }
      if (key === 'PageDown' || key === 'PageUp') {
        event.preventDefault();
        var page = Math.max(ROW_H, Math.floor(node.clientHeight / ROW_H) - 2) * ROW_H;
        var maxScroll = Math.max(0, rows * ROW_H - node.clientHeight);
        node.scrollTop = clamp(node.scrollTop + (key === 'PageDown' ? page : -page), 0, maxScroll);
        measure();
        return;
      }
      if (key === 'Home' || key === 'End') {
        event.preventDefault();
        node.scrollTop = key === 'Home' ? 0 : Math.max(0, rows * ROW_H - node.clientHeight);
        measure();
      }
    }

    /* ---- tokens ----------------------------------------------------- */

    function tokensFor(text, rowIndex, sideName) {
      if (!language || !text || typeof text !== 'string') return null;
      if (!tokenCacheRef.current) tokenCacheRef.current = new Map();
      var cache = tokenCacheRef.current;
      var key = sideName + '|' + rowIndex + '|' + text.length;
      if (cache.has(key)) return cache.get(key);
      var tokens = highlightTokens(text, language);
      if (tokens) cache.set(key, tokens);
      return tokens;
    }

    /* ---- render helpers -------------------------------------------- */

    function renderBadge(tone, text, title) {
      var components = componentsModule();
      if (typeof components.Badge === 'function') return h(components.Badge, { tone: tone, title: title }, text);
      return h('span', { className: 'gr-badge gr-badge-' + tone, title: title || undefined }, text);
    }

    function renderIconButton(label, onClick, disabled, glyph) {
      var components = componentsModule();
      if (typeof components.IconButton === 'function') {
        return h(components.IconButton, { label: label, onClick: onClick, disabled: disabled, t: t }, glyph);
      }
      return h('button', {
        type: 'button',
        className: 'gr-iconbtn',
        title: label,
        'aria-label': label,
        onClick: onClick,
        disabled: disabled ? true : undefined,
      }, glyph);
    }

    function renderSpinner(size) {
      var components = componentsModule();
      if (typeof components.Spinner === 'function') return h(components.Spinner, { size: size });
      return h('span', { className: 'gr-spinner', 'aria-hidden': 'true', style: { width: size + 'px', height: size + 'px' } });
    }

    function renderEmpty(emptyProps) {
      var components = componentsModule();
      if (typeof components.EmptyState === 'function') return h(components.EmptyState, emptyProps);
      return h('div', { className: 'gr-diff-notice' },
        emptyProps.title ? h('div', { className: 'gr-diff-notice-title' }, emptyProps.title) : null,
        emptyProps.hint ? h('div', { className: 'gr-diff-notice-hint' }, emptyProps.hint) : null
      );
    }

    function renderNotice(title, hint) {
      return h('div', { className: 'gr-diff-notice' },
        title ? h('div', { className: 'gr-diff-notice-title' }, title) : null,
        hint ? h('div', { className: 'gr-diff-notice-hint' }, hint) : null
      );
    }

    function renderHeader() {
      var components = componentsModule();
      var iconSizes = components.ICON_SIZE || {};
      var comparison = (entryDiff && entryDiff.comparison) || null;
      var baseLabel = comparison && comparison.baseLabel
        ? String(comparison.baseLabel)
        : entryDiff && entryDiff.base && entryDiff.base.label ? String(entryDiff.base.label) : '';
      var targetLabel = comparison && comparison.targetLabel
        ? String(comparison.targetLabel)
        : entryDiff && entryDiff.target && entryDiff.target.label ? String(entryDiff.target.label) : '';
      var comparisonKeys = {
        Empty: 'diff.sourceEmpty',
        Index: 'diff.sourceIndex',
        Worktree: 'diff.sourceWorktree',
        Untracked: 'status.untracked',
        'Index (ours)': 'diff.sourceOurs',
      };
      if (Object.prototype.hasOwnProperty.call(comparisonKeys, baseLabel)) baseLabel = t(comparisonKeys[baseLabel]);
      if (Object.prototype.hasOwnProperty.call(comparisonKeys, targetLabel)) targetLabel = t(comparisonKeys[targetLabel]);
      var status = entry && entry.status && STATUS_SET[entry.status] ? entry.status : '';
      var change = entry && entry.change && CHANGE_SET[entry.change] ? entry.change : '';
      var path = entry && entry.path ? String(entry.path) : '';
      var oldPath = entry && entry.oldPath ? String(entry.oldPath) : '';
      var totalChanges = changeRowIndexes.length;
      var currentIndex = activeChangeIndex;

      var tags = [];
      if (change) {
        tags.push(h('span', {
          key: 'chg',
          className: 'gr-file-chg gr-chg-' + change,
          title: t('change.' + change),
          'aria-hidden': 'true',
        }, CHANGE_GLYPH[change] || 'M'));
      }
      if (status) tags.push(h('span', { key: 'status' }, renderBadge(STATUS_TONE[status], t('status.' + status))));

      var fullContext = !!(entryDiff && entryDiff.base && entryDiff.target && entryDiff.base.exists && entryDiff.target.exists);
      var changeCounterLabel = t('diff.changeCounter', {
        index: formatCount(currentIndex + 1),
        total: formatCount(totalChanges),
      });
      return h(React.Fragment, null,
        h('div', { className: 'gr-diff-head' },
          h('div', { className: 'gr-diff-head-main' },
            h('div', { className: 'gr-diff-head-badges' }, tags),
            h('div', { className: 'gr-diff-path-wrap' },
              h('div', { className: 'gr-diff-path', title: oldPath ? oldPath + ' → ' + path : path },
                oldPath ? h('span', { className: 'gr-diff-path-old' }, oldPath + ' → ') : null,
                h('span', { className: 'gr-diff-path-new' }, path || t('common.unknown'))
              )
            )
          ),
          h('div', { className: 'gr-diff-meta' },
            totalChanges > 0
              ? h('span', {
                key: 'counter',
                className: 'gr-diff-counter',
                title: changeCounterLabel,
              },
                h('span', { 'aria-hidden': 'true' }, t('diff.changePosition', {
                  index: formatCount(currentIndex + 1),
                  total: formatCount(totalChanges),
                })),
                h('span', { className: 'gr-sr-only' }, changeCounterLabel))
              : null,
            h('span', { key: 'nav', className: 'gr-diff-actions' },
              renderIconButton(t('diff.prevChange'), function () { navigateChange(-1); }, totalChanges === 0,
                h(components.IconArrowUp, { size: iconSizes.md || 14 })),
              renderIconButton(t('diff.nextChange'), function () { navigateChange(1); }, totalChanges === 0,
                h(components.IconArrowDown, { size: iconSizes.md || 14 }))
            ),
            fullContext ? h('span', { key: 'full', className: 'gr-diff-hint', title: t('diff.fullContext') }, t('diff.fullContext')) : null,
            sideBySide && sideBySide.hasFullContext === false
              ? h('span', { key: 'patch', className: 'gr-diff-hint gr-diff-hint-warn', title: t('diff.patchOnly') }, t('diff.patchOnly'))
              : null,
            busy || loading
              ? h('span', {
                key: 'busy',
                className: 'gr-diff-hint',
                title: loading ? t('a11y.loadingDiff') : undefined,
              }, renderSpinner(11))
              : null
          )
        ),
        baseLabel || targetLabel ? h('div', { className: 'gr-diff-sources' },
          h('span', { className: 'gr-diff-source', title: baseLabel }, t('diff.base', { label: baseLabel })),
          h('span', { className: 'gr-diff-source', title: targetLabel }, t('diff.target', { label: targetLabel }))) : null
      );
    }

    function renderBanners() {
      if (!entryDiff) return null;
      var banners = [];
      if (entryDiff.base && entryDiff.base.truncated) {
        banners.push(h('div', { key: 'base', className: 'gr-warn-box' },
          t('diff.truncated', { bytes: formatCount(Number(entryDiff.base.bytes) || 0) })));
      }
      if (entryDiff.target && entryDiff.target.truncated) {
        banners.push(h('div', { key: 'target', className: 'gr-warn-box' },
          t('diff.truncated', { bytes: formatCount(Number(entryDiff.target.bytes) || 0) })));
      }
      if (entryDiff.modeChange) {
        banners.push(h('div', { key: 'mode', className: 'gr-info-box' },
          t('diff.modeOnly', {
            from: String(entryDiff.modeChange.oldMode || ''),
            to: String(entryDiff.modeChange.newMode || ''),
          })));
      }
      if (banners.length === 0) return null;
      return h('div', { className: 'gr-diff-banners' }, banners);
    }

    function renderHalf(side, sideName, rowIndex) {
      var kind = side && typeof side.kind === 'string' ? side.kind : 'ctx';
      var number = side && typeof side.no === 'number' ? side.no : null;
      var text = side && typeof side.text === 'string' ? side.text : '';
      var tokens = tokensFor(text, rowIndex, sideName);
      return h('div', {
        className: cx('gr-half',
          sideName === 'left' ? 'gr-half-left' : 'gr-half-right',
          kind === 'del' && 'gr-line-del',
          kind === 'add' && 'gr-line-add',
          kind === 'empty' && 'gr-line-empty'),
      },
        h('span', {
          className: cx('gr-gutter', kind === 'empty' && 'gr-gutter-empty'),
          'aria-hidden': 'true',
        }, number === null ? '' : String(number)),
        h('span', { className: 'gr-code' }, tokens
          ? tokens.map(function (token, tokenIndex) {
            return h('span', { key: tokenIndex, className: 'gr-tok-' + token.cls }, token.text);
          })
          : text)
      );
    }

    function renderRowIndex(rowIndex) {
      var components = componentsModule();
      var iconSizes = components.ICON_SIZE || {};
      var row = displayRows[rowIndex];
      if (!row) return null;
      var top = (rowIndex * ROW_H) + 'px';
      if (row.truncationRow === true) {
        /* diff.js emits a trailing marker row when either side was truncated;
         * show it as a full-width notice instead of two blank code halves. */
        return h('div', { key: 'trunc-' + rowIndex, className: 'gr-diff-truncation', style: { top: top } },
          h('span', { className: 'gr-diff-truncation-text' },
            t('diff.truncated', { bytes: formatCount(totalBytes(entryDiff)) }))
        );
      }
      if (isGapRow(row)) {
        var gapIndex = typeof row.gapIndex === 'number' ? row.gapIndex : gapOrdinalByIndex[rowIndex];
        /* diff.js emits `hiddenCount`; the contract documents `count`. Support both. */
        var count = Number(row.count);
        if (!Number.isFinite(count)) count = Number(row.hiddenCount);
        if (!Number.isFinite(count)) count = 0;
        return h('div', { key: 'gap-' + rowIndex, className: 'gr-diff-gap', style: { top: top } },
          h('button', {
            type: 'button',
            className: 'gr-gap-btn',
            title: t('diff.expand'),
            'aria-label': t('diff.collapsed', { n: formatCount(count) }) + ' · ' + t('diff.expand'),
            onClick: function () {
              expandGap(gapIndex);
            },
            onContextMenu: function (event) {
              event.preventDefault();
            },
          },
            h('span', { className: 'gr-gap-chevron', 'aria-hidden': 'true' }, h(components.IconChevronDown, { size: iconSizes.md || 14 })),
            h('span', { className: 'gr-gap-text' }, t('diff.collapsed', { n: formatCount(count) })),
            h('span', { className: 'gr-gap-expand' }, t('diff.expand'))
          )
        );
      }
      var active = typeof contextHunk === 'number' && typeof row.hunkIndex === 'number' && row.hunkIndex === contextHunk;
      return h('div', {
        key: 'row-' + rowIndex,
        className: cx('gr-diff-row', active && 'gr-hunk-active', activeChangeRow === rowIndex && 'gr-change-current'),
        style: { top: top },
        /* Roving tabindex: exactly one line is tabbable, and it moves to the
         * first row of a hunk. Keyboard users can Tab straight into the diff and
         * then walk lines / jump hunks without a mouse. */
        tabIndex: rowIndex === effectiveRovingRow ? 0 : -1,
        'data-row': rowIndex,
        'data-hunk': typeof row.hunkIndex === 'number' ? row.hunkIndex : undefined,
        onFocus: function () {
          setRovingRow(rowIndex);
        },
        onContextMenu: function (event) {
          handleRowContextMenu(event, row, rowIndex);
        },
        onKeyDown: function (event) {
          handleRowKeyDown(event, row, rowIndex);
        },
        onClick: function (event) {
          /* Clicking a change row moves the persistent selection (and the
           * counter) to it; context rows only take keyboard focus. */
          var changes = changeRowsRef.current;
          if (changes && changes.indexOf(rowIndex) >= 0) {
            navAnchorRef.current = rowIndex;
            setPinnedChangeRow(rowIndex);
          }
          try {
            event.currentTarget.focus();
          } catch (error) {
            /* ignore */
          }
        },
      },
        renderHalf(row.left, 'left', rowIndex),
        renderHalf(row.right, 'right', rowIndex));
    }

    React.useEffect(function () {
      if (leftProxyRef.current) leftProxyRef.current.scrollLeft = 0;
      if (rightProxyRef.current) rightProxyRef.current.scrollLeft = 0;
    }, [signature]);

    React.useEffect(function () {
      var node = scrollRef.current;
      if (!node || typeof node.addEventListener !== 'function') return undefined;
      function onWheel(event) {
        var horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
        if (!horizontal) return;
        var rect = node.getBoundingClientRect();
        var side = event.clientX - rect.left < rect.width / 2 ? 'left' : 'right';
        var proxy = side === 'left' ? leftProxyRef.current : rightProxyRef.current;
        if (!proxy) return;
        event.preventDefault();
        proxy.scrollLeft += event.shiftKey ? (event.deltaY || 0) : (event.deltaX || 0);
      }
      node.addEventListener('wheel', onWheel, { passive: false });
      return function () {
        node.removeEventListener('wheel', onWheel);
      };
    }, []);

    React.useEffect(function () {
      setHOffsets(function (current) {
        var leftMax = leftProxyRef.current ? Math.max(0, leftProxyRef.current.scrollWidth - leftProxyRef.current.clientWidth) : 0;
        var rightMax = rightProxyRef.current ? Math.max(0, rightProxyRef.current.scrollWidth - rightProxyRef.current.clientWidth) : 0;
        var left = Math.min(current.left, leftMax);
        var right = Math.min(current.right, rightMax);
        if (left === current.left && right === current.right) return current;
        return { left: left, right: right };
      });
    }, [maxCharsLeft, maxCharsRight]);

    function setSideOffset(side, value) {
      var next = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
      setHOffsets(function (current) {
        if (current[side] === next) return current;
        var copy = { left: current.left, right: current.right };
        copy[side] = next;
        return copy;
      });
    }

    /* Each side owns an independent horizontal scrollbar: the two proxy scroll
     * containers sit at the bottom of their own column and drive only that
     * side's translateX, so the lines can be compared without them drifting. */
    function renderHScroll(side, chars) {
      var width = Math.max(320, Math.ceil(chars) * 8 + 140);
      var ref = side === 'left' ? leftProxyRef : rightProxyRef;
      return h('div', {
        key: side,
        className: 'gr-hscroll',
        ref: ref,
        'aria-hidden': 'true',
        onScroll: function (event) {
          setSideOffset(side, event.currentTarget.scrollLeft);
        },
      }, h('div', { className: 'gr-hscroll-inner', style: { width: width + 'px' } }));
    }

    function renderGrid() {
      var totalRows = displayRows.length;
      var totalHeight = totalRows * ROW_H;
      var effectiveHeight = viewport.height > 0 ? viewport.height : 600;
      var start = Math.max(0, Math.floor(viewport.scrollTop / ROW_H) - OVERSCAN);
      var end = Math.min(totalRows, Math.ceil((viewport.scrollTop + effectiveHeight) / ROW_H) + OVERSCAN);
      if (end - start > MAX_RENDER_ROWS) end = start + MAX_RENDER_ROWS;
      var indexes = [];
      for (var index = start; index < end; index += 1) indexes.push(index);

      var indicator = null;
      if (totalHeight > 0 && viewport.height > 0) {
        indicator = h('div', {
          className: 'gr-mm-view',
          style: {
            top: clamp((viewport.scrollTop / totalHeight) * 100, 0, 100) + '%',
            height: clamp((viewport.height / totalHeight) * 100, 0.5, 100) + '%',
          },
        });
      }

      return h('div', { className: 'gr-diff-main' },
        h('div', { className: 'gr-diff-body' },
        h('div', {
          className: 'gr-minimap',
          role: 'slider',
          tabIndex: 0,
          'aria-label': t('diff.minimap'),
          'aria-orientation': 'vertical',
          'aria-valuemin': 1,
          'aria-valuemax': Math.max(1, totalRows),
          'aria-valuenow': Math.min(totalRows, Math.max(1, Math.floor(viewport.scrollTop / ROW_H) + 1)),
          title: t('diff.minimap'),
          ref: minimapRef,
          onPointerDown: function (event) {
            handleMinimapPointerDown(event);
          },
          onPointerMove: function (event) {
            handleMinimapPointerMove(event);
          },
          onPointerUp: function (event) {
            handleMinimapPointerUp(event);
          },
          onPointerCancel: function (event) {
            handleMinimapPointerUp(event);
          },
          onKeyDown: handleMinimapKeyDown,
        },
          markers.map(function (marker, markerIndex) {
            return h('div', {
              key: marker.key,
              className: 'gr-mm-marker gr-mm-' + marker.tone,
              style: { top: marker.top.toFixed(3) + '%', height: marker.height.toFixed(3) + '%' },
              title: t('diff.changeCounter', {
                index: formatCount(markerIndex + 1),
                total: formatCount(markers.length),
              }) + (marker.tone === 'add' ? ' · +' : marker.tone === 'del' ? ' · \u2212' : ' · \u00b1'),
              'aria-hidden': 'true',
            });
          }),
          indicator
        ),
        h('div', {
          className: 'gr-diff-scroll',
          ref: scrollRef,
          /* The scroll container is not a tab stop: the roving tabindex on the
           * first hunk line is the keyboard entry point into the diff. */
          tabIndex: -1,
          role: 'region',
          'aria-label': t('a11y.diff'),
          'aria-description': t('diff.hunkNavHint'),
          onScroll: handleScroll,
          onKeyDown: handleScrollKeyDown,
        },
          h('div', {
            className: 'gr-diff-content',
            style: {
              height: totalHeight + 'px',
              width: '100%',
              '--gr-hx-left': hOffsets.left + 'px',
              '--gr-hx-right': hOffsets.right + 'px',
            },
          }, indexes.map(renderRowIndex))
        )
        ),
        h('div', { className: 'gr-diff-hscrolls' },
          renderHScroll('left', maxCharsLeft),
          renderHScroll('right', maxCharsRight)
        )
      );
    }

    /* ---- guards ----------------------------------------------------- */

    var bothBinary = !!(entryDiff && entryDiff.base && entryDiff.target && entryDiff.base.binary && entryDiff.target.binary);
    var unsupported = entryDiff && entryDiff.unsupported ? entryDiff.unsupported : null;

    function shell(body, extraBanners) {
      return h('div', { className: 'gr-diff', 'aria-busy': loading ? 'true' : undefined },
        entry || entryDiff ? renderHeader() : null,
        extraBanners || null,
        body
      );
    }

    if (error) {
      var retryAction = null;
      if (typeof props.onRetry === 'function') {
        var components = componentsModule();
        var retryLabel = t('app.retry');
        retryAction = typeof components.Button === 'function'
          ? h(components.Button, { variant: 'default', size: 'sm', onClick: props.onRetry, t: t }, retryLabel)
          : h('button', { type: 'button', className: 'gr-btn gr-btn-sm', onClick: props.onRetry }, retryLabel);
      }
      return shell(renderEmpty({
        title: errorMessage(error),
        tone: 'error',
        action: retryAction || undefined,
      }));
    }

    /* Only a pane without previous content shows the full skeleton. When a
     * write/poll refreshes the file already on screen, keep the previous diff
     * visible and show the small header spinner instead. */
    if (loading && !entryDiff) {
      return shell(h('div', { className: 'gr-diff-main' },
        h('div', { className: 'gr-diff-loading', role: 'status', 'aria-live': 'polite' },
          h('div', { className: 'gr-diff-loading-label' }, renderSpinner(14), h('span', null, t('a11y.loadingDiff'))),
          h('div', { className: 'gr-diff-skeleton' },
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (row) {
              return h('div', {
                key: row,
                className: 'gr-skel',
                style: { width: (38 + ((row * 19) % 52)) + '%' },
              });
            })
          )
        )
      ));
    }

    if (unsupported || bothBinary) {
      var unsupportedInfo = unsupported || { code: 'binary' };
      return shell(renderNotice(
        unsupportedTitle(unsupportedInfo, entryDiff, t),
        unsupported && unsupported.message && unsupported.code !== 'binary' ? String(unsupported.message) : null
      ), renderBanners());
    }

    if (!entry && !entryDiff) {
      return shell(renderNotice(t('common.empty'), t('diff.noText')));
    }

    if (!sideBySide) {
      return shell(renderNotice(t('diff.noText'), null));
    }

    if (displayRows.length === 0) {
      var bothExist = !!(entryDiff && entryDiff.base && entryDiff.target && entryDiff.base.exists && entryDiff.target.exists);
      return shell(renderNotice(
        bothExist ? t('diff.noText') : t('diff.emptyFile'),
        bothExist ? null : t('diff.emptyFile')
      ), renderBanners());
    }

    return shell(renderGrid(), renderBanners());
  });

  exports.DiffPane = DiffPane;
  /* Pure navigation helpers (re-exported for renderer-level regression tests):
   * "next change" advances from the anchor, not from the viewport top. */
  exports.currentChangePosition = currentChangePosition;
  exports.changeCounterIndex = changeCounterIndex;
  exports.changeAnchorRow = changeAnchorRow;
  exports.resolveChangeTarget = resolveChangeTarget;
});

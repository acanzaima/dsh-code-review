__def('components', function (exports, require, React) {
  'use strict';

  /**
   * dsh-code-review — composed components for the review overlay.
   *
   * Basic elements (button, icon button, switch, select, text field, textarea,
   * dialog, kbd/chip/tag/search, settings section/row/hint) are provided once by
   * the shared `ui` module; this file only composes them into panel surfaces.
   *
   * Public exports (stable, consumed by app.js):
   *   Styles           — the one <style> element holding every `.gr-*` rule.
   *   ReviewButton     — session-header utility icon button that opens the panel.
   *   Modal            — dialog shell from `ui` plus the plugin's close icon.
   *   Button / IconButton / LinkButton / Badge / Spinner — re-exported `ui` primitives.
   *   TopBar           — one-line branch info / change summary / AI state / action toolbar.
   *   ReviewTitle      — review dialog header: repo icon + project name (full path in title).
   *   FileNav          — grouped, filterable changed-file list with commit checkboxes.
   *   ContextMenu      — fixed-position keyboard-navigable menu.
   *   ConfirmDialog    — small confirmation dialog built on Modal.
   *   CommitPanel      — collapsible commit drawer (header + message box + AI draft + split commit action).
   *   PushDialog       — self-contained push dialog (own backdrop layer).
   *   PanelSettings    — in-panel settings page (AI grouping + interface).
   *   EmptyState       — centred empty/warn/error state.
   *   StatusBar        — persistent footer: ready/busy/error/notice + repository summary.
   *   ShortcutHelp     — keyboard-shortcut reference dialog.
   *
   * Optional/extra props beyond the contract (documented at each component):
   *   Modal: `height`, `className`. Button: `leading`, `busyLabel`, `className`.
   *   IconButton: `title` (tooltip when it differs from the accessible label).
   *   FileNav: `onKeyDown`, `onNavigate(delta)`, `onNavigateEdge('home'|'end')`.
   *   ContextMenu: `ignoreRef` (toggle trigger that must not count as outside).
   *   ShortcutHelp: `shortcuts` override list. StatusBar: `status`, `repo`.
   */

  var h = React.createElement;

  var util = {};
  try {
    util = require('util') || {};
  } catch (error) {
    util = {};
  }

  var ui = require('ui');

  var useLayoutEffect = React.useLayoutEffect || React.useEffect || function () {};


  var STATUS_KEYS = { staged: true, unstaged: true, untracked: true, conflict: true };
  var CHANGE_KEYS = { added: true, modified: true, deleted: true, renamed: true, copied: true, typechange: true, conflict: true };
  var CHANGE_GLYPH = { added: '+', modified: 'M', deleted: '−', renamed: 'R', copied: 'C', typechange: 'T', conflict: '!' };
  var CHANGE_TONE = { added: 'add', modified: 'neutral', deleted: 'del', renamed: 'staged', copied: 'staged', typechange: 'unstaged', conflict: 'conflict' };

  /* ------------------------------------------------------------------ */
  /* small helpers                                                       */
  /* ------------------------------------------------------------------ */

  /** Shared kit owns the key-echo fallback and the basic elements below. */
  var makeT = ui.makeT;

  var Spinner = ui.Spinner;
  var IconButton = ui.IconButton;
  var Button = ui.Button;
  var Badge = ui.Badge;
  var Checkbox = ui.Checkbox;
  var LinkButton = ui.LinkButton;
  var Switch = ui.Switch;
  var TextField = ui.TextField;
  var Textarea = ui.Textarea;
  var Select = ui.Select;
  var SettingSection = ui.SettingSection;
  var SettingRow = ui.SettingRow;
  var Hint = ui.Hint;
  var Kbd = ui.Kbd;
  var Chip = ui.Chip;
  var Tag = ui.Tag;
  var SearchInput = ui.SearchInput;
  var dialogEscapeDeferred = ui.dialogEscapeDeferred;
  var ESC_DEFER_SELECTOR = ui.ESC_DEFER_SELECTOR;
  var useDialogFocus = ui.useDialogFocus;
  var focusNode = ui.focusNode;

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

  /** Local HH:MM:SS for the status-bar "updated at" tooltip. */
  function formatClock(value) {
    var ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    var date = new Date(ms);
    var pad = function (part) { return (part < 10 ? '0' : '') + part; };
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function basename(path) {
    if (typeof util.basename === 'function') return util.basename(path);
    var text = String(path || '');
    var at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    return at === -1 ? text : text.slice(at + 1);
  }

  function dirname(path) {
    if (typeof util.dirname === 'function') return util.dirname(path);
    var text = String(path || '');
    var at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    return at === -1 ? '' : text.slice(0, at);
  }

  function errorMessage(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (typeof error.message === 'string' && error.message) return error.message;
    if (typeof error.code === 'string' && error.code) return error.code;
    try {
      return String(error);
    } catch (fallback) {
      return 'error';
    }
  }

  function isCollapsed(collapsed, groupId) {
    if (collapsed === null || collapsed === undefined) return false;
    if (typeof collapsed.has === 'function') return collapsed.has(groupId);
    if (Array.isArray(collapsed)) return collapsed.indexOf(groupId) !== -1;
    if (typeof collapsed === 'object') return !!collapsed[groupId];
    return false;
  }

  /** Stable id for a navigation group; the fallback index only covers tests. */
  function groupIdOf(group, index) {
    return String((group && (group.id || group.key || group.name)) || 'group-' + index);
  }

  function entryOf(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.entry && typeof item.entry === 'object') return item.entry;
    return item;
  }

  function keyOfItem(item) {
    var entry = entryOf(item);
    if (!entry) return '';
    if (typeof entry.key === 'string' && entry.key) return entry.key;
    if (typeof entry.path === 'string' && entry.path) return String(entry.status || 'unstaged') + ':' + entry.path;
    return '';
  }

  function groupEntries(group) {
    if (!group || typeof group !== 'object') return [];
    var value = group.entries || group.files || group.items;
    return Array.isArray(value) ? value : [];
  }

  function safeId(value) {
    return String(value || 'x').replace(/[^A-Za-z0-9_-]+/g, '-');
  }

  /** Stable option value for a {provider, model} pair (never visible to users). */
  function modelKey(provider, model) {
    return String(provider) + '\u0000' + String(model);
  }

  /* Icons adapted from Lucide (https://lucide.dev), ISC License; see README
   * "Third-party notices". The glyph bodies are inlined at development time
   * (fetched from the Iconify API), so the runtime stays offline and dependency-free. */
  /* Icon size scale, grounded in DSH's own UI rather than an arbitrary type
   * ladder. In DSH's client packages icons are 14px in the standard 24–36px
   * rows/controls, 16px for larger tiles and file-identity glyphs, 18px is
   * rare, and controls never use 12px. This panel therefore keeps:
   *   md 14 — every standard control, row, inline mark and compact header;
   *   lg 16 — larger controls, pane headings and identity glyphs;
   *   xl 20 — decorative empty-state illustrations only.
   * A 12px control tier was removed after the DSH audit: it made the
   * disclosure chevron and navigation icons read as undersized noise.
   */
  var ICON_SIZE = { md: 14, lg: 16, xl: 20 };

  var ICON_PARTS = {
    'review': [
      h('circle', { key: 'p0', cx: '18', cy: '18', r: '3' }),
      h('circle', { key: 'p1', cx: '6', cy: '6', r: '3' }),
      h('path', { key: 'p2', d: 'M13 6h3a2 2 0 0 1 2 2v7m-7 3H8a2 2 0 0 1-2-2V9' }),
    ],
    'branch': [
      h('path', { key: 'p0', d: 'M15 6a9 9 0 0 0-9 9V3' }),
      h('circle', { key: 'p1', cx: '18', cy: '6', r: '3' }),
      h('circle', { key: 'p2', cx: '6', cy: '18', r: '3' }),
    ],
    'refresh': [
      h('path', { key: 'p0', d: 'M3 12a9 9 0 0 1 9-9a9.75 9.75 0 0 1 6.74 2.74L21 8' }),
      h('path', { key: 'p1', d: 'M21 3v5h-5m5 4a9 9 0 0 1-9 9a9.75 9.75 0 0 1-6.74-2.74L3 16' }),
      h('path', { key: 'p2', d: 'M8 16H3v5' }),
    ],
    'gear': [
      h('path', { key: 'p0', d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0a2.34 2.34 0 0 0 3.319 1.915a2.34 2.34 0 0 1 2.33 4.033a2.34 2.34 0 0 0 0 3.831a2.34 2.34 0 0 1-2.33 4.033a2.34 2.34 0 0 0-3.319 1.915a2.34 2.34 0 0 1-4.659 0a2.34 2.34 0 0 0-3.32-1.915a2.34 2.34 0 0 1-2.33-4.033a2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915' }),
      h('circle', { key: 'p1', cx: '12', cy: '12', r: '3' }),
    ],
    'plus': [
      h('path', { key: 'p0', d: 'M5 12h14m-7-7v14' }),
    ],
    'minus': [
      h('path', { key: 'p0', d: 'M5 12h14' }),
    ],
    'close': [
      h('path', { key: 'p0', d: 'M18 6L6 18M6 6l12 12' }),
    ],
    'maximize': [
      h('rect', { key: 'p0', x: '3', y: '3', width: '18', height: '18', rx: '2' }),
    ],
    'restore': [
      h('path', { key: 'p0', d: 'M8 8m0 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2z' }),
      h('path', { key: 'p1', d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }),
    ],
    'commit': [
      h('circle', { key: 'p0', cx: '12', cy: '12', r: '3' }),
      h('path', { key: 'p1', d: 'M3 12h6m6 0h6' }),
    ],
    'push': [
      h('path', { key: 'p0', d: 'M12 3v12m5-7l-5-5l-5 5m14 7v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
    ],
    'spark': [
      h('path', { key: 'p0', d: 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594zM20 2v4m2-2h-4' }),
      h('circle', { key: 'p1', cx: '4', cy: '20', r: '2' }),
    ],
    'search': [
      h('path', { key: 'p0', d: 'm21 21l-4.34-4.34' }),
      h('circle', { key: 'p1', cx: '11', cy: '11', r: '8' }),
    ],
    'help': [
      h('circle', { key: 'p0', cx: '12', cy: '12', r: '10' }),
      h('path', { key: 'p1', d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3m.08 4h.01' }),
    ],
    'check': [
      h('path', { key: 'p0', d: 'M20 6L9 17l-5-5' }),
    ],
    'chevron-right': [
      h('path', { key: 'p0', d: 'm9 18l6-6l-6-6' }),
    ],
    'chevron-down': [
      h('path', { key: 'p0', d: 'm6 9l6 6l6-6' }),
    ],
    'arrow-right': [
      h('path', { key: 'p0', d: 'M5 12h14m-7-7l7 7l-7 7' }),
    ],
    'arrow-up': [
      h('path', { key: 'p0', d: 'm5 12l7-7l7 7m-7 7V5' }),
    ],
    'arrow-down': [
      h('path', { key: 'p0', d: 'M12 5v14m7-7l-7 7l-7-7' }),
    ],
    'expand-all': [
      h('path', { key: 'p0', d: 'm7 15l5 5l5-5M7 9l5-5l5 5' }),
    ],
    'collapse-all': [
      h('path', { key: 'p0', d: 'm7 20l5-5l5 5M7 4l5 5l5-5' }),
    ],
    'locate': [
      h('path', { key: 'p0', d: 'M2 12h3m14 0h3M12 2v3m0 14v3' }),
      h('circle', { key: 'p1', cx: '12', cy: '12', r: '7' }),
    ],
    'external': [
      h('path', { key: 'p0', d: 'M15 3h6v6' }),
      h('path', { key: 'p1', d: 'M10 14 21 3' }),
      h('path', { key: 'p2', d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6' }),
    ],
    'layers': [
      h('path', { key: 'p0', d: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z' }),
      h('path', { key: 'p1', d: 'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65' }),
      h('path', { key: 'p2', d: 'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65' }),
    ],
    'alert': [
      h('path', { key: 'p0', d: 'm21.73 18l-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }),
      h('path', { key: 'p1', d: 'M12 9v4' }),
      h('path', { key: 'p2', d: 'M12 17h.01' }),
    ],
  };

  function iconSize(props, fallback) {
    var size = props && Number(props.size);
    return Number.isFinite(size) && size > 0 ? size : fallback;
  }

  /** Render one inlined icon at the requested pixel size. ICON_PARTS entries
   * are already React children (created once at module load). */
  function glyph(name, size) {
    return h('svg', {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className: 'gr-ico',
      'aria-hidden': 'true',
      focusable: 'false',
    }, ICON_PARTS[name] || []);
  }

  function IconReview(props) { return glyph('review', iconSize(props, ICON_SIZE.md)); }
  function IconBranch(props) { return glyph('branch', iconSize(props, ICON_SIZE.md)); }
  function IconRefresh(props) { return glyph('refresh', iconSize(props, ICON_SIZE.md)); }
  function IconGear(props) { return glyph('gear', iconSize(props, ICON_SIZE.md)); }
  function IconPlus(props) { return glyph('plus', iconSize(props, ICON_SIZE.md)); }
  function IconMinus(props) { return glyph('minus', iconSize(props, ICON_SIZE.md)); }
  function IconClose(props) { return glyph('close', iconSize(props, ICON_SIZE.md)); }
  function IconMaximize(props) { return glyph('maximize', iconSize(props, ICON_SIZE.md)); }
  function IconRestore(props) { return glyph('restore', iconSize(props, ICON_SIZE.md)); }
  function IconCommit(props) { return glyph('commit', iconSize(props, ICON_SIZE.md)); }
  function IconPush(props) { return glyph('push', iconSize(props, ICON_SIZE.md)); }
  function IconSpark(props) { return glyph('spark', iconSize(props, ICON_SIZE.md)); }
  function IconSearch(props) { return glyph('search', iconSize(props, ICON_SIZE.md)); }
  function IconHelp(props) { return glyph('help', iconSize(props, ICON_SIZE.md)); }
  function IconCheck(props) { return glyph('check', iconSize(props, ICON_SIZE.md)); }
  function IconChevronRight(props) { return glyph('chevron-right', iconSize(props, ICON_SIZE.md)); }
  function IconChevronDown(props) { return glyph('chevron-down', iconSize(props, ICON_SIZE.md)); }
  function IconArrowRight(props) { return glyph('arrow-right', iconSize(props, ICON_SIZE.md)); }
  function IconArrowUp(props) { return glyph('arrow-up', iconSize(props, ICON_SIZE.md)); }
  function IconArrowDown(props) { return glyph('arrow-down', iconSize(props, ICON_SIZE.md)); }
  function IconExpandAll(props) { return glyph('expand-all', iconSize(props, ICON_SIZE.md)); }
  function IconCollapseAll(props) { return glyph('collapse-all', iconSize(props, ICON_SIZE.md)); }
  function IconLocateSource(props) { return glyph('locate', iconSize(props, ICON_SIZE.md)); }
  function IconExternal(props) { return glyph('external', iconSize(props, ICON_SIZE.md)); }
  function IconAlert(props) { return glyph('alert', iconSize(props, ICON_SIZE.md)); }
  function IconLayers(props) { return glyph('layers', iconSize(props, ICON_SIZE.md)); }

  /**
   * Semantic shape for a change summary mark: filled check for staged, hollow
   * ring for unstaged, dashed ring for untracked and an alert triangle for
   * conflicts. The colour tones stay the existing ones; only the shape changes
   * so the marks read at a glance like the cover's ✓ / ○.
   */
  function statusGlyph(kind) {
    var className = 'gr-sum-icon gr-sum-icon-' + String(kind || 'unstaged');
    if (kind === 'staged') return h('span', { className: className, 'aria-hidden': 'true' }, h(IconCheck, { size: ICON_SIZE.md }));
    if (kind === 'conflict') return h('span', { className: className, 'aria-hidden': 'true' }, h(IconAlert, { size: ICON_SIZE.md }));
    return h('span', { className: className, 'aria-hidden': 'true' });
  }

  /* ------------------------------------------------------------------ */
  /* atomic components                                                   */
  /* ------------------------------------------------------------------ */

  /* Basic elements are implemented once in `src/client/ui.js`. */

  /**
   * Composer entry button, styled exactly like DSH's own composer controls
   * (the `+` / permission / model row): 28px, no border, circular light fill,
   * label-primary glyph, hover fill. Inline styles carry the resting geometry
   * so the button cannot fall back to a host default button chrome while the
   * review panel is closed; the stylesheet still provides hover/focus and the
   * panel styles.
   */
  function ReviewButton(props) {
    var t = makeT(props.t);
    var hoverState = React.useState(false);
    var hovered = hoverState[0];
    var setHovered = hoverState[1];
    var style = {
      width: '28px',
      height: '28px',
      padding: '0',
      margin: '0',
      border: '0',
      borderRadius: '50%',
      background: hovered
        ? 'var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-bg-layer-2))'
        : 'var(--dsw-specific-selector, var(--dsw-alias-bg-layer-2))',
      color: 'var(--dsw-alias-label-primary)',
      display: 'inline-grid',
      placeItems: 'center',
      cursor: 'pointer',
      flex: '0 0 auto',
      lineHeight: '0',
      boxShadow: 'none',
      appearance: 'none',
      WebkitAppearance: 'none',
    };
    return h('button', {
      type: 'button',
      className: 'gr-review-button',
      title: t('app.open'),
      'aria-label': t('app.open'),
      onClick: props.onOpen,
      onMouseEnter: function () { setHovered(true); },
      onMouseLeave: function () { setHovered(false); },
      style: style,
    }, h(IconReview, { size: ICON_SIZE.md }));
  }

  /* ------------------------------------------------------------------ */
  /* Modal                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Dialog shell from the shared kit; the only local part is the plugin's inline
   * close icon (the kit itself stays icon-agnostic).
   */
  function Modal(props) {
    if (props.closeIcon) return ui.Modal(props);
    return ui.Modal(Object.assign({}, props, { closeIcon: h(IconClose, { size: ICON_SIZE.md }) }));
  }

  /* ------------------------------------------------------------------ */
  /* TopBar                                                              */
  /* ------------------------------------------------------------------ */

  function disabledTitle(t, reason) {
    if (!reason) return undefined;
    return t('actions.disabledReason', { reason: String(reason) });
  }

  /**
   * Read-only rows for the branch chip popover: HEAD / upstream / tracking
   * first, then copy actions. Branch switching is deliberately out of scope —
   * the panel reviews the current checkout and never mutates the branch.
   */
  function branchMenuItems(repo, t) {
    if (!repo) return [];
    var items = [];
    var head = repo.headSha ? String(repo.headSha).slice(0, 8) : '';
    var ahead = Math.max(0, Number(repo.ahead) || 0);
    var behind = Math.max(0, Number(repo.behind) || 0);
    if (head) items.push({ id: 'info-head', label: t('branch.head', { sha: head }), disabled: true });
    items.push({
      id: 'info-upstream',
      label: repo.upstream ? t('branch.upstream', { name: String(repo.upstream) }) : t('branch.noUpstream'),
      disabled: true,
    });
    if (ahead > 0 || behind > 0) {
      items.push({
        id: 'info-tracking',
        label: t('push.aheadBehind', { ahead: formatCount(ahead), behind: formatCount(behind) }),
        disabled: true,
      });
    }
    items.push({ separator: true });
    items.push({ id: 'set-remote', label: t('branch.setRemote') });
    items.push({ separator: true });
    items.push({ id: 'copy-branch', label: t('branch.copyName'), disabled: !(repo.branch && !repo.detached) });
    items.push({ id: 'copy-path', label: t('branch.copyPath'), disabled: !repo.root });
    return items;
  }

  /**
   * One-line toolbar: branch/tracking (left), change summary + AI state chip
   * (middle, shrinkable) and the action cluster (right, fixed). The repository
   * identity lives in the dialog header (ReviewTitle), so the toolbar is free
   * for state and actions. The AI chip follows the summary marks, so it sits on
   * the left of the toolbar and disappears together with the summary on narrow
   * panels instead of claiming a row of its own.
   *
   * Contract props: status, repo, busy, operation, onRefresh, onOpenPush,
   * pushDisabledReason, aiCommitBusy, aiCommitCanRun, aiCommitDisabledReason,
   * onAiCommitPush, aiMode, aiGrouping ('role'|'logic'), aiBusy, aiNotice,
   * onChangeGrouping(value), onReclassify, onCopy(value), onSetRemote, t.
   * Bulk staging (stage-all / unstage-all) lives in the FileNav header as the
   * tri-state select-all, where it shares the row/group checkbox model.
   */
  function TopBar(props) {
    var t = makeT(props.t);
    var status = props.status || {};
    var repo = props.repo || status.repo || null;
    var summary = status.summary || null;
    var busy = !!props.busy;
    var aiMode = !!props.aiMode;
    var aiBusy = !!props.aiBusy;
    var aiNotice = props.aiNotice ? String(props.aiNotice) : '';

    var ahead = repo ? Math.max(0, Number(repo.ahead) || 0) : 0;
    var behind = repo ? Math.max(0, Number(repo.behind) || 0) : 0;
    var branchLabel = repo
      ? (repo.detached ? t('state.detached') : (repo.branch || t('common.unknown')))
      : '';
    /* Disabled menu rows are skipped by roving focus, so the same read-only
     * facts are exposed on the trigger as an accessible description. */
    var branchDescription = '';
    if (repo) {
      var branchFacts = [];
      if (repo.headSha) branchFacts.push(t('branch.head', { sha: String(repo.headSha).slice(0, 8) }));
      branchFacts.push(repo.upstream ? t('branch.upstream', { name: String(repo.upstream) }) : t('branch.noUpstream'));
      branchDescription = branchFacts.join(' · ');
    }

    /* The branch chip doubles as a read-only information popover trigger (the
     * cover draws a chevron on it). It never switches branches. */
    var branchMenuState = React.useState(false);
    var branchMenuOpen = branchMenuState[0];
    var setBranchMenuOpen = branchMenuState[1];
    var branchMenuPosition = React.useRef({ x: 0, y: 0 });
    var branchTriggerRef = React.useRef(null);
    React.useEffect(function () {
      if (!repo) setBranchMenuOpen(false);
    }, [repo]);

    function toggleBranchMenu(event) {
      var node = event && event.currentTarget;
      if (node && typeof node.getBoundingClientRect === 'function') {
        var rect = node.getBoundingClientRect();
        branchMenuPosition.current = { x: rect.left, y: rect.bottom + 4 };
      }
      setBranchMenuOpen(function (value) { return !value; });
    }

    function selectBranchMenu(id) {
      setBranchMenuOpen(false);
      if (id === 'set-remote') {
        if (typeof props.onSetRemote === 'function') props.onSetRemote();
        return;
      }
      if (!repo || typeof props.onCopy !== 'function') return;
      if (id === 'copy-branch' && repo.branch && !repo.detached) props.onCopy(String(repo.branch));
      else if (id === 'copy-path' && repo.root) props.onCopy(String(repo.root));
    }

    var branchChip = repo
      ? h('button', {
        type: 'button',
        ref: branchTriggerRef,
        className: cx('gr-chip', 'gr-chip-branch', 'gr-branch-trigger',
          repo.detached && 'gr-chip-warn', branchMenuOpen && 'gr-branch-trigger-open'),
        title: t('branch.details'),
        'aria-label': branchLabel + ' · ' + t('branch.details'),
        'aria-description': branchDescription || undefined,
        'aria-haspopup': 'menu',
        'aria-expanded': branchMenuOpen ? 'true' : 'false',
        onClick: toggleBranchMenu,
      },
        h('span', { className: 'gr-chip-icon', 'aria-hidden': 'true' }, h(IconBranch, { size: ICON_SIZE.md })),
        h('span', { className: 'gr-chip-label' }, branchLabel),
        h('span', { className: 'gr-chip-chevron', 'aria-hidden': 'true' }, h(IconChevronDown, { size: ICON_SIZE.md })))
      : null;

    var tracking = null;
    if (ahead > 0 || behind > 0) {
      tracking = h('span', {
        className: 'gr-tracking',
        title: t('push.aheadBehind', { ahead: formatCount(ahead), behind: formatCount(behind) }),
      },
        ahead > 0 ? h('span', { className: 'gr-ahead' }, h(IconArrowUp, { size: ICON_SIZE.md }), formatCount(ahead)) : null,
        behind > 0 ? h('span', { className: 'gr-behind' }, h(IconArrowDown, { size: ICON_SIZE.md }), formatCount(behind)) : null);
    }

    var worktreeTag = repo && repo.worktree
      ? h(Tag, { title: t('state.worktree') }, t('state.worktree'))
      : null;

    var summaryMarks = [];
    if (repo && summary) {
      summaryMarks.push(h('span', {
        key: 'files',
        className: 'gr-sum-files',
        title: t('summary.entries', { n: formatCount(summary.entries) }),
      }, t('summary.files', { n: formatCount(summary.files) })));

      var statusMarks = [
        ['staged', 'staged', t('status.staged'), summary.staged, t('summary.scopeStaged')],
        ['unstaged', 'unstaged', t('status.unstaged'), summary.unstaged, t('summary.scopeUnstaged')],
        ['untracked', 'untracked', t('status.untracked'), summary.untracked, t('summary.scopeUntracked')],
        ['conflicts', 'conflict', t('status.conflict'), summary.conflicts, t('state.conflictsHint')],
      ];
      var visibleMarks = [];
      for (var markIndex = 0; markIndex < statusMarks.length; markIndex += 1) {
        var mark = statusMarks[markIndex];
        if (!(Number(mark[3]) > 0)) continue;
        visibleMarks.push(h('span', {
          key: mark[0],
          className: cx('gr-sum-item', 'gr-sum-' + mark[1]),
          title: mark[4],
        },
          statusGlyph(mark[1]),
          h('span', { className: 'gr-sum-label' }, mark[2]),
          h('b', null, formatCount(mark[3]))));
      }
      if (visibleMarks.length > 0) {
        summaryMarks.push(h('span', { key: 'status-sep', className: 'gr-sum-sep', 'aria-hidden': 'true' }));
        for (var visibleIndex = 0; visibleIndex < visibleMarks.length; visibleIndex += 1) {
          summaryMarks.push(visibleMarks[visibleIndex]);
        }
      }

      var additions = (Number(summary.stagedAdditions) || 0) + (Number(summary.unstagedAdditions) || 0);
      var deletions = (Number(summary.stagedDeletions) || 0) + (Number(summary.unstagedDeletions) || 0);
      if (additions > 0 || deletions > 0) {
        summaryMarks.push(h('span', {
          key: 'lines',
          className: 'gr-sum-stats',
          title: t('summary.lineTotals'),
        },
          additions > 0 ? h('span', { className: 'gr-add' }, t('summary.additions', { n: formatCount(additions) })) : null,
          deletions > 0 ? h('span', { className: 'gr-del' }, t('summary.deletions', { n: formatCount(deletions) })) : null));
      }
    }

    var pushDisabled = !!props.pushDisabledReason || busy;
    var pushReason = props.pushDisabledReason || (busy ? t('reason.busy') : null);
    var pushTitle = pushDisabled ? disabledTitle(t, pushReason) : t('actions.push');

    /* One-click AI·commit+push: reachable without expanding the commit drawer,
     * so it lives next to (but separate from) the push-dialog button. The two
     * actions are deliberately not merged: one opens the remote/target dialog,
     * the other commits and pushes immediately, and hiding either behind a
     * secondary menu would defeat its purpose. */
    var aiCommitBusy = !!props.aiCommitBusy;
    var aiCommitDisabled = aiCommitBusy || busy || props.aiCommitCanRun === false;
    var aiCommitReason = busy ? t('reason.busy') : (props.aiCommitDisabledReason || null);
    var aiCommitTitle = aiCommitDisabled ? disabledTitle(t, aiCommitReason) : t('commit.modeAiPushHint');
    var aiCommitButton = h(Button, {
      variant: 'default',
      size: 'sm',
      className: 'gr-topbar-ai-commit',
      title: aiCommitTitle,
      ariaLabel: t('commit.modeAiCommitPush'),
      onClick: props.onAiCommitPush,
      disabled: aiCommitDisabled,
      busy: aiCommitBusy,
      leading: h(IconSpark, { size: ICON_SIZE.md }),
      t: t,
    }, h('span', { className: 'gr-ai-commit-label' }, t('commit.modeAiCommitPush')));

    var canSelectGrouping = typeof props.onChangeGrouping === 'function';
    /* Three-way grouping selector (Git status / AI role / AI logic) built on the
     * shared Select so it looks like a DSH menu: a compact trigger with the
     * active label and a chevron, and a listbox that checks the active option.
     * Option titles explain each mode and become the menu row tooltips.
     * Progress is reported in exactly one place: the slim AI status row below
     * the toolbar. Switching grouping off is allowed while a classify request is
     * running (the host aborts it); only a Git write blocks the control. */
    var groupingMode = !aiMode ? 'git' : (props.aiGrouping === 'logic' ? 'logic' : 'role');
    var groupingOptions = [
      { value: 'git', label: t('nav.gitGroups'), title: t('nav.gitGroupsHint') },
      { value: 'role', label: t('nav.aiGroupsRole'), title: t('nav.aiGroupsRoleHint') },
      { value: 'logic', label: t('nav.aiGroupsLogic'), title: t('nav.aiGroupsLogicHint') },
    ];
    var groupingSelect = canSelectGrouping
      ? h(Select, {
        className: 'gr-topbar-grouping',
        anchorMenu: true,
        value: groupingMode,
        options: groupingOptions,
        ariaLabel: t('nav.grouping'),
        disabled: busy ? true : undefined,
        onChange: function (value) {
          if (value !== groupingMode) props.onChangeGrouping(value);
        },
      })
      : null;

    var aiRow = aiBusy || aiNotice
      ? h('div', {
        className: cx('gr-ai-row', aiBusy && 'gr-ai-row-busy'),
        title: aiNotice || t('nav.aiLoading'),
        role: 'status',
        'aria-live': 'polite',
      },
        aiBusy ? h(Spinner, { size: 10 }) : h(IconSpark, { size: ICON_SIZE.md }),
        h('span', { className: 'gr-ai-row-text' }, aiNotice || t('nav.aiLoading')))
      : null;

    var branchMenu = repo && branchMenuOpen
      ? h(ContextMenu, {
        open: true,
        x: branchMenuPosition.current.x,
        y: branchMenuPosition.current.y,
        header: branchLabel,
        items: branchMenuItems(repo, t),
        onSelect: selectBranchMenu,
        onClose: function () { setBranchMenuOpen(false); },
        ignoreRef: branchTriggerRef,
        t: t,
      })
      : null;

    /* The branch popover is a sibling of the toolbar, not a child: `.gr-topbar`
     * is a size container, so a `position: fixed` descendant would be contained
     * (and clipped) by it instead of the viewport. */
    return h(React.Fragment, null,
      h('header', { className: 'gr-topbar', 'aria-busy': busy ? 'true' : undefined },
        h('div', { className: 'gr-topbar-repo' },
          branchChip,
          tracking,
          worktreeTag),
        h('div', { className: 'gr-topbar-mid' }, summaryMarks, aiRow),
        h('div', { className: 'gr-topbar-actions', 'role': 'toolbar', 'aria-label': t('a11y.actions') },
          groupingSelect,
          aiMode ? h(IconButton, {
            label: t('nav.reclassify'),
            onClick: props.onReclassify,
            disabled: busy || aiBusy,
            busy: aiBusy,
            t: t,
          }, h(IconLayers, { size: ICON_SIZE.md })) : null,
          h('span', { key: 'sep-operations', className: 'gr-topbar-sep', 'aria-hidden': 'true' }),
          h(IconButton, {
            label: t('actions.refresh'),
            title: t('actions.refresh'),
            onClick: props.onRefresh,
            disabled: busy,
            busy: busy,
            t: t,
          }, h(IconRefresh, { size: ICON_SIZE.md })),
          h('span', { key: 'sep-push', className: 'gr-topbar-sep', 'aria-hidden': 'true' }),
          aiCommitButton,
          h(Button, {
            variant: 'default',
            size: 'sm',
            className: 'gr-topbar-push',
            title: pushTitle,
            onClick: props.onOpenPush,
            disabled: pushDisabled,
            leading: h(IconPush, { size: ICON_SIZE.md }),
            t: t,
          }, t('actions.push')),
          h('span', { key: 'sep-utility', className: 'gr-topbar-sep', 'aria-hidden': 'true' }),
          typeof props.onOpenSettings === 'function'
            ? h(IconButton, {
              label: t('settings.open'),
              className: 'gr-topbar-settings',
              onClick: props.onOpenSettings,
              t: t,
            }, h(IconGear, { size: ICON_SIZE.md }))
            : null,
          typeof props.onShowShortcuts === 'function'
            ? h(IconButton, {
              label: t('shortcut.help'),
              className: 'gr-topbar-help',
              onClick: props.onShowShortcuts,
              t: t,
            }, h(IconHelp, { size: ICON_SIZE.md }))
            : null
        )),
      branchMenu);
  }

  /**
   * Review dialog header: the repository identity replaces the generic plugin
   * title. The visible label is the project name; the full repository path
   * stays in the tooltip. The toolbar below keeps only branch/summary/actions.
   *
   * Contract props: repo {root}, t.
   */
  function ReviewTitle(props) {
    var t = makeT(props.t);
    var repo = props.repo || null;
    var root = repo && typeof repo.root === 'string' ? repo.root : '';
    var name = root ? basename(root) : t('app.title');
    return h('span', { className: 'gr-review-title' },
      h('span', { className: 'gr-repo-icon', 'aria-hidden': 'true' }, h(IconReview, { size: ICON_SIZE.lg })),
      h('span', {
        className: 'gr-review-title-name',
        title: root || t('state.repoMissing'),
      }, name));
  }

  /* ------------------------------------------------------------------ */
  /* FileNav                                                             */
  /* ------------------------------------------------------------------ */

  function rowTitle(entry, t) {
    var lines = [String(entry.path || '')];
    if (entry.oldPath) lines.push(t('entry.renameFrom', { path: String(entry.oldPath) }));
    var meta = [];
    if (entry.status && STATUS_KEYS[entry.status]) meta.push(t('status.' + entry.status));
    if (entry.change && CHANGE_KEYS[entry.change]) meta.push(t('change.' + entry.change));
    if (meta.length > 0) lines.push(meta.join(' · '));
    return lines.join('\n');
  }

  /**
   * Sidebar file navigation: a header with change count, a search field with a
   * leading glyph and an inline clear button, and the grouped list itself. Rows
   * are single-line (glyph · filename · dim directory suffix · +/− stats); group
   * headers are opaque and stay sticky so no row can bleed above them.
   *
   * Contract props: groups, selectedKey, collapsedGroups, onToggleGroup,
   * onExpandAll, onCollapseAll, onLocate, locateSignal, onSelect, onContextMenu,
   * onToggleStaged(entry, next), onToggleGroupStaged(entries, next),
   * onToggleAllStaged(entries, next), selectAllDisabledReason, busy,
   * search, onSearch, t, listRef.
   * Extra: onKeyDown (forwarded first), onNavigate(delta), onNavigateEdge('home'|'end').
   */
  function FileNav(props) {
    var t = makeT(props.t);
    var groups = Array.isArray(props.groups) ? props.groups : [];
    var selectedKey = props.selectedKey ? String(props.selectedKey) : '';
    var searchValue = props.search === undefined || props.search === null ? '' : String(props.search);
    var innerRef = React.useRef(null);
    var rootRef = React.useRef(null);

    function attachList(node) {
      innerRef.current = node;
      var target = props.listRef;
      if (typeof target === 'function') target(node);
      else if (target && typeof target === 'object') target.current = node;
    }

    /* The header row shares the file rows' horizontal insets so the select-all
     * checkbox and the right-side bulk controls line up with the row checkboxes
     * and the +/− stats. The scroll container owns the scrollbar gutter, so
     * publish its width as a CSS variable for the header's trailing padding. */
    useLayoutEffect(function () {
      var list = innerRef.current;
      var root = rootRef.current;
      if (!list || !root) return;
      var gutter = Math.max(0, Math.round(list.offsetWidth - list.clientWidth));
      root.style.setProperty('--gr-files-scrollbar', gutter + 'px');
    }, [groups.length, props.search]);

    var totals = { total: 0, firstKey: '' };
    for (var groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      var groupItems = groupEntries(groups[groupIndex]);
      for (var itemIndex = 0; itemIndex < groupItems.length; itemIndex += 1) {
        var itemKey = keyOfItem(groupItems[itemIndex]);
        if (!itemKey) continue;
        if (!totals.firstKey) totals.firstKey = itemKey;
        totals.total += 1;
      }
    }

    /* Header select-all: the same "checked = in the next commit" model as rows
     * and group headers, scoped to the groups currently shown (a search filter
     * narrows it; with no filter it is the whole repository). Conflicts are
     * never selected, and whole-repository writes stay blocked when the host
     * truncated the entry list. */
    var selectableEntries = [];
    var selectableTotal = 0;
    var selectableStaged = 0;
    for (var selectGroupIndex = 0; selectGroupIndex < groups.length; selectGroupIndex += 1) {
      var selectItems = groupEntries(groups[selectGroupIndex]);
      for (var selectIndex = 0; selectIndex < selectItems.length; selectIndex += 1) {
        var selectEntry = entryOf(selectItems[selectIndex]);
        if (!selectEntry || selectEntry.status === 'conflict') continue;
        selectableEntries.push(selectEntry);
        selectableTotal += 1;
        if (selectEntry.status === 'staged') selectableStaged += 1;
      }
    }
    var allStaged = selectableTotal > 0 && selectableStaged === selectableTotal;
    var someStaged = selectableStaged > 0 && !allStaged;
    var canToggleAll = selectableTotal > 0
      && props.busy !== true
      && !props.selectAllDisabledReason
      && typeof props.onToggleAllStaged === 'function';
    var selectAllTitle;
    if (!canToggleAll) {
      selectAllTitle = disabledTitle(t, props.selectAllDisabledReason
        || (selectableTotal === 0 ? t('reason.nothingToStage') : t('reason.busy')));
    } else {
      selectAllTitle = t('nav.selectAllHint', { n: formatCount(selectableTotal) })
        + ' · ' + (allStaged ? t('nav.uncheckAll') : t('nav.checkAll'));
    }

    /* Bulk group controls: expanding is only meaningful while something is
     * collapsed, collapsing only while something is open. */
    var anyCollapsed = false;
    var anyExpanded = false;
    for (var navGroupIndex = 0; navGroupIndex < groups.length; navGroupIndex += 1) {
      if (isCollapsed(props.collapsedGroups, groupIdOf(groups[navGroupIndex], navGroupIndex))) anyCollapsed = true;
      else anyExpanded = true;
    }
    var showBulk = groups.length > 0
      && typeof props.onExpandAll === 'function'
      && typeof props.onCollapseAll === 'function';
    var showLocate = typeof props.onLocate === 'function';
    var showBulkBar = showBulk || showLocate;

    React.useEffect(function () {
      var node = innerRef.current;
      if (!node) return;
      var selected = node.querySelector('[role="option"][aria-selected="true"]');
      if (selected && typeof selected.scrollIntoView === 'function') {
        try {
          selected.scrollIntoView({ block: 'nearest' });
        } catch (error) {
          /* older engines: no options object */
        }
      }
    }, [selectedKey, groups, props.locateSignal]);

    function handleRowKeyDown(event, entry) {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      if (typeof props.onContextMenu !== 'function') return;
      var rect = event.currentTarget.getBoundingClientRect();
      if (typeof props.onContextMenu === 'function') {
        props.onContextMenu({
          clientX: rect.left + 24,
          clientY: rect.top + Math.min(rect.height, 18),
          currentTarget: event.currentTarget,
          target: event.target,
          shiftKey: true,
          preventDefault: function () {},
          stopPropagation: function () {},
        }, entry);
      }
    }

    function renderRow(item, rowKeyPrefix) {
      var entry = entryOf(item);
      if (!entry) return null;
      var itemKey = keyOfItem(item);
      var status = entry.status && STATUS_KEYS[entry.status] ? entry.status : 'unstaged';
      var change = entry.change && CHANGE_KEYS[entry.change] ? entry.change : 'modified';
      var selected = itemKey !== '' && itemKey === selectedKey;
      var tabbable = selected || (!selectedKey && itemKey === totals.firstKey);
      var path = String(entry.path || '');
      var name = basename(path);
      var directory = dirname(path);
      var additions = Number(entry.additions) || 0;
      var deletions = Number(entry.deletions) || 0;
      var label = path || itemKey;
      var staged = status === 'staged';
      var canToggleStaged = status !== 'conflict' && typeof props.onToggleStaged === 'function';

      return h('div', {
        key: rowKeyPrefix + '/' + itemKey,
        role: 'option',
        'aria-selected': selected,
        'aria-label': label,
        tabIndex: tabbable ? 0 : -1,
        className: cx('gr-file-row', staged && 'gr-file-row-staged'),
        title: rowTitle(entry, t),
        'data-key': itemKey,
        onClick: function () {
          if (typeof props.onSelect === 'function') props.onSelect(entry);
        },
        onContextMenu: function (event) {
          event.preventDefault();
          if (typeof props.onContextMenu === 'function') props.onContextMenu(event, entry);
        },
        onKeyDown: function (event) {
          handleRowKeyDown(event, entry);
        },
      },
        /* Checked = staged = included in the next commit; toggling it is a
         * stage/unstage write against the same fingerprinted expectation the
         * row was rendered from. */
        h(Checkbox, {
          className: 'gr-file-check',
          checked: staged,
          disabled: props.busy === true || !canToggleStaged,
          title: staged ? t('nav.uncheckStaged') : t('nav.checkStaged'),
          ariaLabel: label + ' · ' + (staged ? t('nav.uncheckStaged') : t('nav.checkStaged')),
          tabIndex: -1,
          onChange: function (next) {
            if (typeof props.onToggleStaged === 'function') props.onToggleStaged(entry, next);
          },
        }),
        h('span', {
          className: cx('gr-file-glyph', 'gr-chg-' + change),
          title: t('change.' + change) + ' · ' + t('status.' + status),
          'aria-hidden': 'true',
        }, CHANGE_GLYPH[change] || 'M'),
        h('span', { className: 'gr-file-name-wrap' },
          h('span', { className: 'gr-file-name' }, name || label),
          directory ? h('span', { className: 'gr-file-dir', title: directory }, directory) : null
        ),
        h('span', { className: 'gr-file-stats' },
          additions > 0 ? h('span', { className: 'gr-add' }, t('summary.additions', { n: formatCount(additions) })) : null,
          deletions > 0 ? h('span', { className: 'gr-del' }, t('summary.deletions', { n: formatCount(deletions) })) : null
        )
      );
    }

    function handleListKeyDown(event) {
      if (typeof props.onKeyDown === 'function') props.onKeyDown(event);
      if (event.defaultPrevented) return;
      var key = event.key;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        if (typeof props.onNavigate !== 'function') return;
        event.preventDefault();
        props.onNavigate(key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (key === 'Home' || key === 'End') {
        if (typeof props.onNavigateEdge !== 'function') return;
        event.preventDefault();
        props.onNavigateEdge(key === 'Home' ? 'home' : 'end');
      }
    }

    function renderGroup(group, index) {
      var groupId = groupIdOf(group, index);
      var entries = groupEntries(group);
      var collapsed = isCollapsed(props.collapsedGroups, groupId);
      /* The Host may mark a category as `kind: 'non-functional'` (logic mode:
       * config / build / CI / docs only). Its machine name is not user-facing:
       * localize the heading and fall back to the descriptive tooltip when the
       * model omitted a description. The group checkbox keeps working because
       * the entries are ordinary rows. */
      var nonFunctional = group.kind === 'non-functional';
      var label = nonFunctional
        ? t('nav.nonFunctional')
        : String(group.label || group.title || group.name || t('nav.other'));
      var description = group.description || group.hint || (nonFunctional ? t('nav.nonFunctionalHint') : null);
      var bodyId = 'gr-group-' + safeId(groupId) + '-' + index;
      /* Group checkbox mirrors the rows: everything counted as committable is
       * staged -> checked, nothing -> unchecked, otherwise the mixed state.
       * Conflicts are left out (they can never be committed). */
      var toggleable = 0;
      var stagedCount = 0;
      for (var checkIndex = 0; checkIndex < entries.length; checkIndex += 1) {
        var checkEntry = entryOf(entries[checkIndex]);
        if (!checkEntry || checkEntry.status === 'conflict') continue;
        toggleable += 1;
        if (checkEntry.status === 'staged') stagedCount += 1;
      }
      var allStaged = toggleable > 0 && stagedCount === toggleable;
      var someStaged = stagedCount > 0 && !allStaged;
      var groupCheckTitle = allStaged ? t('nav.uncheckGroup') : t('nav.checkGroup');
      return h('div', { className: 'gr-group', key: groupId + ':' + index },
        h('div', { className: 'gr-group-head', 'data-tone': String(group.tone || '') },
          h(Checkbox, {
            className: 'gr-group-check',
            checked: allStaged,
            mixed: someStaged,
            disabled: props.busy === true || toggleable === 0 || typeof props.onToggleGroupStaged !== 'function',
            title: groupCheckTitle,
            ariaLabel: label + ' · ' + groupCheckTitle,
            tabIndex: -1,
            onChange: function (next) {
              if (typeof props.onToggleGroupStaged === 'function') props.onToggleGroupStaged(entries, next);
            },
          }),
          h('button', {
            type: 'button',
            className: 'gr-group-head-btn',
            'aria-expanded': !collapsed,
            'aria-controls': bodyId,
            title: description ? String(description) : label,
            onClick: function () {
              if (typeof props.onToggleGroup === 'function') props.onToggleGroup(groupId, !collapsed);
            },
          },
            h('span', {
              className: cx('gr-group-chevron', !collapsed && 'gr-group-chevron-open'),
              'aria-hidden': 'true',
            }, h(IconChevronRight, { size: ICON_SIZE.md })),
            h('span', { className: 'gr-group-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'gr-group-label' }, label),
            h('span', { className: 'gr-group-count' }, formatCount(entries.length))
          )),
        collapsed ? null : h('div', {
          className: 'gr-group-body',
          id: bodyId,
          role: 'group',
          'aria-label': label,
        }, entries.map(function (item, itemIndex) {
          return renderRow(item, groupId + '-' + itemIndex);
        }))
      );
    }

    var showEmpty = groups.length === 0 || totals.total === 0;

    function clearSearch() {
      if (typeof props.onSearch === 'function') props.onSearch('');
    }

    var body = showEmpty
      ? h('div', { className: 'gr-empty-nav' },
        h('span', { className: 'gr-empty-nav-icon', 'aria-hidden': 'true' },
          searchValue ? h(IconSearch, { size: ICON_SIZE.xl }) : h(IconReview, { size: ICON_SIZE.xl })),
        h('span', { className: 'gr-empty-nav-title' }, searchValue ? t('nav.noMatch') : t('nav.noChanges')),
        searchValue ? h('span', { className: 'gr-empty-nav-hint' }, t('nav.noMatchHint')) : null,
        searchValue
          ? h(LinkButton, { className: 'gr-empty-nav-action', onClick: clearSearch }, t('nav.clearSearch'))
          : null)
      : groups.map(renderGroup);

    return h('div', { className: 'gr-files', ref: rootRef },
      h('div', { className: 'gr-files-head' },
        h('div', { className: 'gr-files-head-row' },
          h(Checkbox, {
            className: 'gr-files-select-all',
            checked: allStaged,
            mixed: someStaged,
            disabled: canToggleAll ? undefined : true,
            title: selectAllTitle,
            ariaLabel: t('nav.selectAll'),
            onChange: function (next) {
              if (typeof props.onToggleAllStaged === 'function') props.onToggleAllStaged(selectableEntries, next);
            },
          }),
          h('span', { className: 'gr-files-title' }, t('nav.files')),
          h('span', {
            className: 'gr-files-count',
            title: t('summary.entries', { n: formatCount(totals.total) }),
          }, formatCount(totals.total)),
          /* Bulk view controls form the right-aligned cluster; the title and
           * count stay on the leading edge. */
          h('div', { className: 'gr-files-head-right' },
            showBulkBar
              ? h('div', { className: 'gr-files-bulk' },
                showLocate
                  ? h(IconButton, {
                    label: t('nav.locate'),
                    title: t('nav.locate'),
                    className: 'gr-files-bulk-btn',
                    disabled: !selectedKey ? true : undefined,
                    onClick: function () { props.onLocate(); },
                    t: t,
                  }, h(IconLocateSource, { size: ICON_SIZE.md }))
                  : null,
                showBulk
                  ? h(IconButton, {
                    label: t('nav.expandAll'),
                    title: t('nav.expandAll'),
                    className: 'gr-files-bulk-btn',
                    disabled: !anyCollapsed ? true : undefined,
                    onClick: function () { props.onExpandAll(); },
                    t: t,
                  }, h(IconExpandAll, { size: ICON_SIZE.md }))
                  : null,
                showBulk
                  ? h(IconButton, {
                    label: t('nav.collapseAll'),
                    title: t('nav.collapseAll'),
                    className: 'gr-files-bulk-btn',
                    disabled: !anyExpanded ? true : undefined,
                    onClick: function () { props.onCollapseAll(); },
                    t: t,
                  }, h(IconCollapseAll, { size: ICON_SIZE.md }))
                  : null)
              : null))),
      h('div', { className: 'gr-search' },
        h(SearchInput, {
          value: searchValue,
          placeholder: t('nav.search'),
          ariaLabel: t('nav.search'),
          clearLabel: t('nav.clearSearch'),
          icon: h(IconSearch, { size: ICON_SIZE.md }),
          clearIcon: h(IconClose, { size: ICON_SIZE.md }),
          onChange: function (value) {
            if (typeof props.onSearch === 'function') props.onSearch(value);
          },
          onClear: clearSearch,
        })),
      h('div', {
        className: 'gr-files-list',
        role: 'listbox',
        'aria-label': t('a11y.fileNav'),
        ref: attachList,
        onKeyDown: handleListKeyDown,
      }, body)
    );
  }

  /* ------------------------------------------------------------------ */
  /* ContextMenu                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Viewport-clamped top-left position for a menu anchored to its trigger.
   * `anchor` / `menu` are DOMRect-like ({ left, right, top, bottom, width,
   * height }); options are { placement: 'above'|'below', align:
   * 'start'|'end', gap, viewport: { width, height } }. The preferred side wins
   * when it fits; otherwise the menu flips before being clamped to the viewport.
   * Keeping the menu flush with the anchor (4px gap by default) is what makes
   * popovers read like DSH's own menu buttons instead of floating panels.
   */
  function anchorMenuPosition(anchor, menu, options) {
    var opts = options || {};
    var viewport = opts.viewport || { width: 1024, height: 768 };
    var menuWidth = Math.max(0, Number(menu && menu.width) || 0);
    var menuHeight = Math.max(0, Number(menu && menu.height) || 0);
    var gap = Number.isFinite(opts.gap) ? Number(opts.gap) : 4;
    var anchorTop = Number(anchor && anchor.top) || 0;
    var anchorBottom = Number(anchor && anchor.bottom) || 0;
    var anchorLeft = Number(anchor && anchor.left) || 0;
    var anchorRight = Number(anchor && anchor.right) || 0;
    var above = opts.placement !== 'below';
    var x = opts.align === 'start' ? anchorLeft : anchorRight - menuWidth;
    var y = above ? anchorTop - gap - menuHeight : anchorBottom + gap;
    if (above && y < 4 && anchorBottom + gap + menuHeight <= viewport.height - 4) {
      y = anchorBottom + gap;
    } else if (!above && y + menuHeight > viewport.height - 4 && anchorTop - gap - menuHeight >= 4) {
      y = anchorTop - gap - menuHeight;
    }
    return {
      x: Math.round(clamp(x, 4, Math.max(4, viewport.width - menuWidth - 4))),
      y: Math.round(clamp(y, 4, Math.max(4, viewport.height - menuHeight - 4))),
    };
  }

  /**
   * Contract props: open, x, y, header, items [{id,label,disabled,title,
   * danger,separator,checked}], onSelect(id), onClose, t.
   * Extra: `ignoreRef` — an element ref whose clicks must not count as
   * "outside"; used by toggle triggers so clicking them closes instead of
   * close-then-reopen. `checked` renders a check mark and marks the row as a
   * menu radio item (the commit-mode selector uses it for the remembered mode).
   * `anchorRef` + `placement` ('above'|'below') + `align` ('start'|'end') anchor
   * the menu to a trigger element instead of using the x/y pair; the commit
   * drawer's mode menu uses this so it sits flush above the split control.
   */
  function ContextMenu(props) {
    var t = makeT(props.t);
    var open = !!props.open;
    var menuRef = React.useRef(null);
    var closeRef = React.useRef(props.onClose);
    closeRef.current = props.onClose;
    var initial = (function () {
      var width = typeof window !== 'undefined' ? window.innerWidth : 1024;
      var height = typeof window !== 'undefined' ? window.innerHeight : 768;
      return {
        x: clamp(Number(props.x) || 0, 4, Math.max(4, width - 240)),
        y: clamp(Number(props.y) || 0, 4, Math.max(4, height - 160)),
      };
    });
    var positionState = React.useState(initial);
    var position = positionState[0];
    var setPosition = positionState[1];

    useLayoutEffect(function () {
      if (!open) return;
      var node = menuRef.current;
      if (!node) return;
      var rect = node.getBoundingClientRect();
      var width = typeof window !== 'undefined' ? window.innerWidth : rect.right;
      var height = typeof window !== 'undefined' ? window.innerHeight : rect.bottom;
      var anchorNode = props.anchorRef && props.anchorRef.current;
      var next;
      if (anchorNode && typeof anchorNode.getBoundingClientRect === 'function') {
        next = anchorMenuPosition(anchorNode.getBoundingClientRect(), rect, {
          placement: props.placement === 'below' ? 'below' : 'above',
          align: props.align === 'start' ? 'start' : 'end',
          viewport: { width: width, height: height },
        });
      } else {
        next = {
          x: clamp(Number(props.x) || 0, 4, Math.max(4, width - rect.width - 4)),
          y: clamp(Number(props.y) || 0, 4, Math.max(4, height - rect.height - 4)),
        };
      }
      setPosition(function (current) {
        if (current.x === next.x && current.y === next.y) return current;
        return next;
      });
    }, [open, props.x, props.y, props.anchorRef, props.placement, props.align]);

    React.useEffect(function () {
      if (!open) return undefined;
      var doc = typeof document !== 'undefined' ? document : null;
      if (!doc) return undefined;
      var node = menuRef.current;
      if (node) {
        var first = node.querySelector('[role^="menuitem"]:not([aria-disabled="true"])');
        focusNode(first);
      }
      function onOutside(event) {
        var ignore = props.ignoreRef && props.ignoreRef.current;
        if (ignore && typeof ignore.contains === 'function' && ignore.contains(event.target)) return;
        if (node && !node.contains(event.target) && typeof closeRef.current === 'function') closeRef.current();
      }
      doc.addEventListener('mousedown', onOutside, true);
      doc.addEventListener('contextmenu', onOutside, true);
      return function () {
        doc.removeEventListener('mousedown', onOutside, true);
        doc.removeEventListener('contextmenu', onOutside, true);
      };
    }, [open]);

    if (!open) return null;

    function handleKeyDown(event) {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        if (typeof props.onClose === 'function') props.onClose();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      var node = menuRef.current;
      if (!node) return;
      event.preventDefault();
      var items = Array.prototype.slice.call(node.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])'));
      if (items.length === 0) return;
      var active = typeof document !== 'undefined' ? document.activeElement : null;
      var index = items.indexOf(active);
      var direction = event.key === 'ArrowDown' ? 1 : -1;
      var next = index === -1 ? (direction > 0 ? 0 : items.length - 1) : (index + direction + items.length) % items.length;
      focusNode(items[next]);
    }

    var rawItems = Array.isArray(props.items) ? props.items : [];
    return h('div', {
      className: 'gr-menu',
      role: 'menu',
      'data-gr-menu': 'true',
      ref: menuRef,
      style: { left: position.x + 'px', top: position.y + 'px' },
      onKeyDown: handleKeyDown,
      onContextMenu: function (event) {
        event.preventDefault();
      },
    },
      props.header ? h('div', { className: 'gr-menu-header', title: String(props.header) }, String(props.header)) : null,
      rawItems.map(function (item, index) {
        if (!item || typeof item !== 'object') return null;
        if (item.separator) return h('div', { key: 'sep-' + index, className: 'gr-menu-sep', role: 'separator' });
        var disabled = !!item.disabled;
        var checked = item.checked === true;
        var icon = item.icon
          ? h('span', { className: 'gr-menu-icon', 'aria-hidden': 'true' }, item.icon)
          : null;
        return h('button', {
          key: item.id === undefined ? 'item-' + index : String(item.id),
          type: 'button',
          role: item.checked === undefined ? 'menuitem' : 'menuitemradio',
          className: cx('gr-menu-item', item.danger && 'gr-menu-item-danger'),
          'aria-disabled': disabled ? 'true' : undefined,
          'aria-checked': item.checked === undefined ? undefined : (checked ? 'true' : 'false'),
          title: item.title ? String(item.title) : undefined,
          onClick: function () {
            if (disabled) return;
            if (typeof props.onSelect === 'function') props.onSelect(item.id);
            if (typeof props.onClose === 'function') props.onClose();
          },
        }, icon, item.label, checked ? h('span', { className: 'gr-menu-check', 'aria-hidden': 'true' }, h(IconCheck, { size: ICON_SIZE.md })) : null);
      })
    );
  }

  /* ------------------------------------------------------------------ */
  /* OpenTargetButton                                                    */
  /* ------------------------------------------------------------------ */

  /** One application icon; a failed image load falls back to the open glyph. */
  function AppIcon(props) {
    var failedState = React.useState(false);
    var failed = failedState[0];
    var setFailed = failedState[1];
    var size = Number(props.size) > 0 ? Number(props.size) : ICON_SIZE.md;
    if (!props.src || failed) return h(IconExternal, { size: ICON_SIZE.md });
    return h('img', {
      className: 'gr-app-icon',
      src: String(props.src),
      width: size,
      height: size,
      alt: '',
      draggable: false,
      onError: function () {
        setFailed(true);
      },
    });
  }

  /**
   * Split open control mirroring DSH's session-header open-target button: the
   * primary half launches the preferred application, the chevron lists every
   * installed one. Contract props: t, applications [{id,label,iconSrc}],
   * defaultId, loading, failed, busy, disabled, onOpen(appId).
   */
  function OpenTargetButton(props) {
    var t = makeT(props.t);
    var apps = Array.isArray(props.applications) ? props.applications : [];
    var openState = React.useState(false);
    var open = openState[0];
    var setOpen = openState[1];
    var anchorRef = React.useRef(null);
    var positionState = React.useState({ x: 0, y: 0 });
    var position = positionState[0];
    var setPosition = positionState[1];
    var preferred = null;
    for (var index = 0; index < apps.length; index += 1) {
      if (apps[index] && apps[index].id === props.defaultId) {
        preferred = apps[index];
        break;
      }
    }
    if (!preferred && apps.length > 0) preferred = apps[0];
    var unavailable = !!props.disabled || !!props.loading || !!props.failed || apps.length === 0;
    function toggleMenu() {
      var node = anchorRef.current;
      if (!node || unavailable) return;
      var rect = node.getBoundingClientRect();
      setPosition({ x: Math.max(4, rect.right - 220), y: rect.bottom + 4 });
      setOpen(function (value) { return !value; });
    }
    function choose(id) {
      setOpen(false);
      if (typeof props.onOpen === 'function') props.onOpen(id);
    }
    var items = apps.map(function (app) {
      var isPreferred = preferred && app.id === preferred.id;
      return {
        id: 'app:' + app.id,
        label: isPreferred ? t('open.appDefault', { app: app.label }) : app.label,
        icon: h(AppIcon, { src: app.iconSrc }),
      };
    });
    var label = preferred ? preferred.label : t('open.project');
    return h('span', { className: 'gr-open-target', ref: anchorRef },
      h('button', {
        type: 'button',
        className: 'gr-open-main',
        title: t('open.project'),
        disabled: unavailable || !!props.busy,
        onClick: function () {
          if (preferred) choose(preferred.id);
        },
      },
        props.busy ? h(Spinner, { size: 11 }) : h(IconExternal, { size: ICON_SIZE.md }),
        h('span', { className: 'gr-open-label' }, label)),
      h('button', {
        type: 'button',
        className: 'gr-open-chevron',
        title: t('open.more'),
        'aria-label': t('open.more'),
        'aria-haspopup': 'menu',
        'aria-expanded': open ? 'true' : 'false',
        disabled: unavailable || !!props.busy,
        onClick: toggleMenu,
      }, h(IconChevronDown, { size: ICON_SIZE.md })),
      h(ContextMenu, {
        open: open,
        x: position.x,
        y: position.y,
        items: items,
        onSelect: function (id) {
          choose(String(id).slice(4));
        },
        onClose: function () {
          setOpen(false);
        },
        ignoreRef: anchorRef,
        t: t,
      })
    );
  }

  /* ------------------------------------------------------------------ */
  /* ConfirmDialog                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Contract props: open, title, body, confirmLabel, cancelLabel,
   * tone 'danger'|'default', busy, onConfirm, onCancel, t.
   * Extra: `scoped` — passed through to Modal for in-window dialogs.
   */
  function ConfirmDialog(props) {
    var t = makeT(props.t);
    var tone = props.tone === 'danger' ? 'danger' : 'default';
    return h(Modal, {
      open: !!props.open,
      scoped: !!props.scoped,
      title: props.title || t('common.confirm'),
      onClose: props.busy ? noop : props.onCancel,
      busy: !!props.busy,
      t: t,
      width: 'min(94vw, 480px)',
      height: 'auto',
      footer: h('div', { className: 'gr-dialog-actions' },
        h(Button, {
          variant: 'default',
          onClick: props.onCancel,
          disabled: !!props.busy,
          t: t,
        }, props.cancelLabel || t('common.cancel')),
        h(Button, {
          variant: tone === 'danger' ? 'danger' : 'primary',
          onClick: props.onConfirm,
          busy: !!props.busy,
          t: t,
        }, props.confirmLabel || t('common.confirm'))
      ),
    }, h('div', { className: 'gr-confirm-body' },
      typeof props.body === 'string' || typeof props.body === 'number'
        ? h('p', { className: 'gr-confirm-text' }, String(props.body))
        : (props.body || null)
    ));
  }

  /* ------------------------------------------------------------------ */
  /* CommitAction                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Split commit action inside the commit drawer: the primary half runs the
   * remembered commit mode, the chevron lists the two drawer modes (the
   * selection is a persisted plugin setting, like the toolbar grouping
   * selector). The one-click AI·commit+push action is a separate toolbar button,
   * not a drawer mode. The menu opens upward because the drawer sits at the
   * bottom of the review window.
   *
   * Contract props: t, mode ('commit'|'commitPush'), busy, generating, canRun,
   * reasons [string], onCommit, onChangeMode.
   */
  function CommitAction(props) {
    var t = makeT(props.t);
    var mode = props.mode === 'commitPush' ? props.mode : 'commit';
    var busy = !!props.busy;
    var generating = !!props.generating;
    var reasons = Array.isArray(props.reasons) ? props.reasons : [];
    var running = busy || generating;
    var menuState = React.useState(false);
    var menuOpen = menuState[0];
    var setMenuOpen = menuState[1];
    var triggerRef = React.useRef(null);
    var modes = [
      { id: 'commit', label: t('commit.modeCommit'), hint: t('commit.onlyStaged'), icon: h(IconCommit, { size: ICON_SIZE.md }) },
      { id: 'commitPush', label: t('commit.modeCommitPush'), hint: t('commit.modePushHint'), icon: h(IconPush, { size: ICON_SIZE.md }) },
    ];
    var active = modes[0];
    for (var index = 0; index < modes.length; index += 1) {
      if (modes[index].id === mode) active = modes[index];
    }
    var disabled = running || props.canRun === false;
    var disabledReason = busy
      ? t('commit.running')
      : (generating ? t('commit.generating') : (reasons[0] || null));
    var title = disabled ? disabledTitle(t, disabledReason) : active.hint;

    function toggleMenu() {
      setMenuOpen(function (value) { return !value; });
    }

    function choose(id) {
      setMenuOpen(false);
      if (id !== mode && typeof props.onChangeMode === 'function') props.onChangeMode(String(id));
    }

    return h(React.Fragment, null,
      h('span', { className: 'gr-commit-target', ref: triggerRef },
        h('button', {
          type: 'button',
          className: 'gr-commit-main',
          title: title,
          'aria-label': active.label,
          'aria-busy': running ? 'true' : undefined,
          disabled: disabled ? true : undefined,
          onClick: function () {
            if (disabled) return;
            setMenuOpen(false);
            if (typeof props.onCommit === 'function') props.onCommit();
          },
        },
          running ? h(Spinner, { size: 11 }) : active.icon,
          h('span', { className: 'gr-commit-mode-label' }, active.label)),
        h('button', {
          type: 'button',
          className: 'gr-commit-mode-chevron',
          title: t('commit.mode'),
          'aria-label': t('commit.mode'),
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen ? 'true' : 'false',
          disabled: running ? true : undefined,
          onClick: toggleMenu,
        }, h(IconChevronDown, { size: ICON_SIZE.md }))),
      menuOpen
        ? h(ContextMenu, {
          open: true,
          /* Anchored like DSH's file-explorer menu: flush above the split control
           * (4px gap) and right-aligned to it, so it does not float away from the
           * trigger; the helper flips/clamps only when the viewport is too tight. */
          anchorRef: triggerRef,
          placement: 'above',
          align: 'end',
          header: t('commit.modeHeader'),
          items: modes.map(function (item) {
            return { id: item.id, label: item.label, title: item.hint, checked: item.id === mode };
          }),
          onSelect: choose,
          onClose: function () { setMenuOpen(false); },
          ignoreRef: triggerRef,
          t: t,
        })
        : null);
  }

  /* ------------------------------------------------------------------ */
  /* CommitPanel                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Collapsible commit drawer. The checked (staged) file rows are the commit
   * set — that preview stays in the file navigation, so the drawer only carries
   * the commit message and the actions. The header row (title + checked-file
   * count + expand toggle) is always visible; the body opens on demand and
   * holds a multi-line message field, warnings, the AI draft action and the
   * split commit action (its mode is persisted). There is deliberately no
   * keyboard shortcut: the message is committed from the split action only.
   *
   * Contract props: open, onToggle, message, onMessageChange, count, busy,
   * canGenerate, generateBusy, commitMode, commitBusy, commitGenerating,
   * commitCanRun, commitReasons [string], error, conflictCount, staleNotice,
   * onGenerate, onCommit, onChangeCommitMode, t.
   */
  function CommitPanel(props) {
    var t = makeT(props.t);
    var open = !!props.open;
    var message = props.message === undefined || props.message === null ? '' : String(props.message);
    var count = Number(props.count) || 0;
    var textareaRef = React.useRef(null);
    var previousOpen = React.useRef(false);

    React.useEffect(function () {
      if (open && !previousOpen.current) focusNode(textareaRef.current);
      previousOpen.current = open;
    }, [open]);

    var generateBusy = !!props.generateBusy;
    var conflictBlocked = Number(props.conflictCount) > 0;

    return h('div', { className: cx('gr-commit', open && 'gr-commit-open') },
      h('button', {
        type: 'button',
        className: 'gr-commit-toggle',
        'aria-expanded': open,
        'aria-controls': 'gr-commit-body',
        title: open ? t('commit.collapse') : t('commit.expand'),
        onClick: props.onToggle,
      },
        h('span', { className: 'gr-commit-chevron', 'aria-hidden': 'true' },
          open ? h(IconChevronDown, { size: ICON_SIZE.md }) : h(IconChevronRight, { size: ICON_SIZE.md })),
        h('span', { className: 'gr-commit-title' }, t('commit.title')),
        h('span', { className: 'gr-commit-count' }, t('commit.checkedFiles', { n: formatCount(count) })),
        conflictBlocked ? h(Badge, { tone: 'conflict' }, t('state.conflicts')) : null,
        h('span', { className: 'gr-commit-spacer' }),
        h('span', { className: 'gr-commit-hint gr-dim' }, open ? t('commit.collapse') : t('commit.expand'))
      ),
      !open ? null : h('div', { className: 'gr-commit-body', id: 'gr-commit-body' },
        h('label', { className: 'gr-commit-label', htmlFor: 'gr-commit-message' }, t('commit.message')),
        h(Textarea, {
          id: 'gr-commit-message',
          inputRef: textareaRef,
          rows: 3,
          value: message,
          placeholder: t('commit.messagePlaceholder'),
          ariaLabel: t('a11y.commitMessage'),
          disabled: !!props.busy || generateBusy,
          onChange: function (event) {
            if (typeof props.onMessageChange === 'function') props.onMessageChange(event.target.value);
          },
        }),
        conflictBlocked
          ? h('div', { className: 'gr-warn-box', role: 'alert' }, t('commit.conflictBlocked'))
          : null,
        props.staleNotice ? h('div', { className: 'gr-warn-box', role: 'status' }, String(props.staleNotice)) : null,
        props.error ? h('div', { className: 'gr-error-box', role: 'alert' }, errorMessage(props.error)) : null,
        h('div', { className: 'gr-commit-actions' },
          h(IconButton, {
            label: t('commit.generate'),
            busy: generateBusy,
            disabled: !props.canGenerate || !!props.busy,
            onClick: props.onGenerate,
            t: t,
          }, h(IconSpark, { size: ICON_SIZE.md })),
          h(CommitAction, {
            t: t,
            mode: props.commitMode,
            busy: !!props.commitBusy,
            generating: !!props.commitGenerating,
            canRun: props.commitCanRun,
            reasons: props.commitReasons,
            onCommit: props.onCommit,
            onChangeMode: props.onChangeCommitMode,
          })
        )
      )
    );
  }

  /* ------------------------------------------------------------------ */
  /* PushDialog                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Contract props: open, preview, loading, error, hint, remote, target,
   * onRemoteChange, onTargetChange, onRetry, onClose, onPush, busy, t.
   * Extra: `scoped` — makes the backdrop absolute inside its review window.
   * Renders its own fixed backdrop layer above the panel (never nests a Modal).
   *
   * The source branch is read-only (the host always pushes the current local
   * branch); only the remote and the target branch are editable. `onPush`
   * receives { remote, target, setUpstream } matching the host method. The
   * preview has three explicit states — loading / error / success — so a failed
   * preview renders the localized message plus a retry button instead of a
   * spinner that never stops.
   */
  function PushDialog(props) {
    var t = makeT(props.t);
    var open = !!props.open;
    var preview = props.preview || null;
    var busy = !!props.busy;
    var loading = !!props.loading;
    var error = props.error || null;
    var panelRef = React.useRef(null);
    useDialogFocus(open, busy, props.onClose, panelRef);

    var remotes = preview && Array.isArray(preview.remotes) ? preview.remotes : [];
    var upstream = preview && preview.upstream ? preview.upstream : null;
    var sourceBranch = preview ? String(preview.sourceBranch || preview.branch || '') : '';
    var defaultRemote = preview
      ? String(preview.remote || preview.defaultRemote || (remotes[0] && remotes[0].name) || '')
      : '';
    var defaultTarget = preview
      ? String(preview.targetBranch || preview.branch || sourceBranch || '')
      : '';

    /* app.js drives remote/target as controlled props; fall back to internal
     * state when the dialog is used stand-alone. */
    var controlledRemote = typeof props.remote === 'string';
    var controlledTarget = typeof props.target === 'string';
    var remoteState = React.useState(String(defaultRemote || ''));
    var internalRemote = remoteState[0];
    var setInternalRemote = remoteState[1];
    var targetState = React.useState(String(defaultTarget || ''));
    var internalTarget = targetState[0];
    var setInternalTarget = targetState[1];
    var remote = controlledRemote ? String(props.remote) : internalRemote;
    var target = controlledTarget ? String(props.target) : internalTarget;
    var previousKey = React.useRef('');
    var currentKey = open ? [String(defaultRemote || ''), String(defaultTarget || ''), preview ? '1' : '0'].join('|') : '';
    if (!open) {
      /* Forget the last session so reopening always starts from fresh defaults. */
      previousKey.current = '';
    } else if (previousKey.current !== currentKey) {
      previousKey.current = currentKey;
      if (!controlledRemote) setInternalRemote(String(defaultRemote || ''));
      if (!controlledTarget) setInternalTarget(String(defaultTarget || ''));
    }

    function changeRemote(value) {
      if (typeof props.onRemoteChange === 'function') props.onRemoteChange(value);
      else setInternalRemote(value);
    }

    function changeTarget(value) {
      if (typeof props.onTargetChange === 'function') props.onTargetChange(value);
      else setInternalTarget(value);
    }

    if (!open) return null;

    var loadingPreview = loading || (!preview && !error);
    var previewFailed = !loading && !preview && !!error;
    var canPush = !loadingPreview && !!preview && preview.canPush !== false && remotes.length > 0 && !!target;
    var needsUpstream = !upstream || (upstream.remote !== remote || upstream.branch !== target);
    var pushDisabled = busy || !canPush || previewFailed;
    var pushTitle = pushDisabled
      ? disabledTitle(t, loadingPreview
        ? t('state.loading')
        : (preview && preview.reason) || (remotes.length === 0 ? t('reason.noRemote') : t('reason.busy')))
      : t('push.action');

    var commits = preview && Array.isArray(preview.commits) ? preview.commits : [];
    var retryButton = typeof props.onRetry === 'function'
      ? h(Button, {
        variant: 'default',
        size: 'sm',
        onClick: props.onRetry,
        disabled: busy,
        t: t,
      }, t('app.retry'))
      : null;
    var errorBox = error
      ? h('div', { className: 'gr-push-error', role: 'alert' },
        h('div', { className: 'gr-error-box' }, props.hint ? String(props.hint) : errorMessage(error)),
        retryButton)
      : null;

    return h('div', {
      className: cx('gr-modal-backdrop gr-push-layer', props.scoped && 'gr-modal-backdrop-scoped'),
      onMouseDown: function (event) {
        if (event.target !== event.currentTarget || busy) return;
        if (typeof props.onClose === 'function') props.onClose();
      },
    }, h('div', {
      className: 'gr-modal gr-push-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('push.title'),
      ref: panelRef,
      tabIndex: -1,
      style: { width: 'min(94vw, 560px)', height: 'min(90vh, 720px)' },
    },
      h('div', { className: 'gr-modal-head' },
        h('div', { className: 'gr-modal-titles' },
          h('h2', { className: 'gr-modal-title' }, t('push.title')),
          preview && sourceBranch
            ? h('p', { className: 'gr-modal-subtitle' }, t('push.localBranch') + ': ' + sourceBranch)
            : null
        ),
        h(IconButton, {
          label: t('common.cancel'),
          className: 'gr-modal-close',
          onClick: busy ? undefined : props.onClose,
          disabled: busy,
          t: t,
        }, h(IconClose, { size: ICON_SIZE.md }))
      ),
      h('div', { className: 'gr-modal-body' },
        loadingPreview
          ? h('div', { className: 'gr-push-loading' }, h(Spinner, { size: 16 }), h('span', null, t('state.loading')))
          : previewFailed
            ? h('div', { className: 'gr-push-loading gr-push-failed' }, errorBox)
            : h('div', { className: 'gr-push-body' },
              h('div', { className: 'gr-push-flow' },
                h('div', { className: 'gr-field gr-push-field-local' },
                  h('span', { className: 'gr-field-label' }, t('push.localBranch')),
                  h('span', { className: 'gr-field-value gr-mono', title: sourceBranch }, sourceBranch || t('common.unknown'))
                ),
                h('span', { className: 'gr-push-arrow', 'aria-hidden': 'true' }, h(IconArrowRight, { size: ICON_SIZE.md })),
                h('div', { className: 'gr-field gr-push-field-remote' },
                  h('span', { className: 'gr-field-label' }, t('push.remote')),
                  remotes.length === 0
                    ? h('span', { className: 'gr-field-value gr-dim' }, t('common.none'))
                    : h(Select, {
                      value: remote,
                      options: remotes.map(function (item) {
                        var name = item && item.name ? String(item.name) : String(item);
                        return { value: name, label: name };
                      }),
                      ariaLabel: t('push.remote'),
                      disabled: busy,
                      onChange: changeRemote,
                    })
                ),
                h('span', { className: 'gr-push-arrow', 'aria-hidden': 'true' }, '/'),
                h('div', { className: 'gr-field gr-push-field-target' },
                  h('span', { className: 'gr-field-label' }, t('push.targetBranch')),
                  h(TextField, {
                    type: 'text',
                    ariaLabel: t('push.targetBranch'),
                    value: target,
                    disabled: busy,
                    onChange: function (event) {
                      changeTarget(event.target.value);
                    },
                  })
                )
              ),
              h('div', { className: upstream ? 'gr-info-box' : 'gr-warn-box' },
                upstream
                  ? t('push.upstream', { ref: String(upstream.ref || upstream.remote + '/' + upstream.branch) })
                  : t('push.noUpstream')
              ),
              remotes.length === 0
                ? h('div', { className: 'gr-warn-box', role: 'alert' }, t('push.noRemote'))
                : null,
              preview.canPush === false && preview.reason
                ? h('div', { className: 'gr-warn-box', role: 'alert' }, String(preview.reason))
                : null,
              preview.commitsBase === null
                ? h('div', { className: 'gr-info-box' }, t('push.firstPush'))
                : null,
              preview.ahead !== undefined || preview.behind !== undefined
                ? h('div', { className: 'gr-dim gr-push-ahead' },
                  t('push.aheadBehind', { ahead: formatCount(preview.ahead), behind: formatCount(preview.behind) }))
                : null,
              h('div', { className: 'gr-field' },
                h('span', { className: 'gr-field-label' }, t('push.commits') + ' (' + formatCount(commits.length) + ')'),
                commits.length === 0
                  ? h('div', { className: 'gr-dim gr-push-empty' }, t('push.noCommits'))
                  : h('div', { className: 'gr-commit-list' }, commits.map(function (commit, index) {
                    var sha = commit && (commit.shortSha || commit.sha) ? String(commit.shortSha || commit.sha) : '';
                    return h('div', { className: 'gr-commit-item', key: sha || 'commit-' + index },
                      h('span', { className: 'gr-sha gr-mono' }, sha),
                      h('span', { className: 'gr-commit-subject', title: commit && commit.subject ? String(commit.subject) : '' },
                        commit && commit.subject ? String(commit.subject) : '')
                    );
                  }))
              ),
              errorBox,
              props.hint && !error ? h('div', { className: 'gr-info-box' }, String(props.hint)) : null
            )
      ),
      h('div', { className: 'gr-modal-foot' },
        h(Button, { variant: 'ghost', onClick: props.onClose, disabled: busy, t: t }, t('common.cancel')),
        h(Button, {
          variant: 'primary',
          onClick: function () {
            if (typeof props.onPush !== 'function') return;
            props.onPush({
              remote: remote,
              target: target,
              setUpstream: needsUpstream,
            });
          },
          busy: busy,
          disabled: pushDisabled,
          title: pushTitle,
          busyLabel: t('push.running'),
          t: t,
        }, needsUpstream ? t('push.actionSetUpstream') : t('push.action'))
      )
    ));
  }

  /* ------------------------------------------------------------------ */
  /* ModelPicker                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * DSH composer-style model + reasoning picker (figma Setting-Cell):
   * one popover with a 模型 row, a 推理等级 row and a footer summary; each row
   * swaps the same surface to its own list. Contract props:
   * { t, routes, reasoning, current, reasoningEffort, loading, saving,
   *   disabled, onChange(patch) }.
   */
  /* ------------------------------------------------------------------ */
  /* ModelPicker                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * DSH composer-style model + reasoning picker (figma Setting-Cell):
   * one popover with a 模型 row, a 推理等级 row and a footer summary; each row
   * swaps the same surface to its own list. Contract props:
   * { t, routes, reasoning, current, reasoningEffort, loading, saving,
   *   disabled, onChange(patch) }.
   */
  function ModelPicker(props) {
    var t = makeT(props.t);
    var routes = Array.isArray(props.routes) ? props.routes : [];
    var reasoning = props.reasoning && typeof props.reasoning === 'object' ? props.reasoning : null;
    var efforts = [];
    if (reasoning && Array.isArray(reasoning.efforts)) {
      for (var effortIndex = 0; effortIndex < reasoning.efforts.length; effortIndex += 1) {
        var item = reasoning.efforts[effortIndex];
        if (!item || typeof item !== 'object') continue;
        if (typeof item.id !== 'string' || item.id.length === 0) continue;
        efforts.push({
          id: item.id,
          name: typeof item.name === 'string' && item.name.length > 0 ? item.name : item.id,
          description: typeof item.description === 'string' ? item.description : '',
        });
      }
    }
    var defaultEffort = reasoning && typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : '';
    var current = props.current && props.current.provider && props.current.model
      ? { provider: String(props.current.provider), model: String(props.current.model) }
      : null;
    var explicitEffort = typeof props.reasoningEffort === 'string' && props.reasoningEffort.length > 0
      ? props.reasoningEffort
      : '';
    var effectiveEffort = explicitEffort || defaultEffort;
    var saving = !!props.saving;
    var loading = !!props.loading;

    var openState = React.useState(false);
    var open = openState[0];
    var setOpen = openState[1];
    var viewState = React.useState('root');
    var view = viewState[0];
    var setView = viewState[1];
    var positionState = React.useState(null);
    var position = positionState[0];
    var setPosition = positionState[1];
    var rootRef = React.useRef(null);
    var menuRef = React.useRef(null);

    function findRoute(model) {
      if (!model) return null;
      for (var index = 0; index < routes.length; index += 1) {
        var route = routes[index];
        if (!route) continue;
        if (String(route.provider) === model.provider && String(route.model) === model.model) return route;
      }
      return null;
    }

    function routeLabel(route) {
      if (!route) return '';
      if (route.name && String(route.name).length > 0) return String(route.name);
      return route.model ? String(route.model) : '';
    }

    function effortName(id) {
      for (var index = 0; index < efforts.length; index += 1) {
        if (efforts[index].id === id) return efforts[index].name;
      }
      return id;
    }

    var currentRoute = findRoute(current);
    var currentLabel = currentRoute ? routeLabel(currentRoute) : (current ? String(current.model) : '');
    var effortLabel = effectiveEffort ? effortName(effectiveEffort) : (efforts.length > 0 ? t('ai.pickerDefault') : '');

    // Group routes by provider for the model list (provider sections mirror DSH's menu groups).
    var groups = [];
    var groupByProvider = {};
    for (var routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
      var route = routes[routeIndex];
      if (!route || route.provider === undefined || route.model === undefined || route.model === null) continue;
      var providerKey = String(route.provider);
      var group = groupByProvider[providerKey];
      if (!group) {
        group = {
          provider: providerKey,
          label: route.providerName ? String(route.providerName) : providerKey,
          options: [],
        };
        groupByProvider[providerKey] = group;
        groups.push(group);
      }
      group.options.push(route);
    }

    function estimateHeight() {
      if (view === 'root') return 120;
      if (view === 'efforts') return 44 + efforts.length * 34 + 8;
      var rows = 1;
      for (var index = 0; index < groups.length; index += 1) rows += 1 + groups[index].options.length;
      return 44 + rows * 34 + 8;
    }

    function measure() {
      var node = rootRef.current;
      if (!node) return;
      var rect = node.getBoundingClientRect();
      var estimated = Math.min(360, Math.max(120, estimateHeight()));
      var below = window.innerHeight - rect.bottom - 8;
      var above = rect.top - 12;
      var placement = below >= estimated + 4 ? 'below' : 'above';
      var next = {
        right: Math.round(Math.max(8, window.innerWidth - rect.right)),
        minWidth: view === 'efforts' ? 160 : Math.round(Math.max(240, Math.min(320, rect.width))),
        maxHeight: Math.max(140, Math.min(360, placement === 'below' ? below : above)),
      };
      if (placement === 'below') next.top = Math.round(rect.bottom + 4);
      else next.bottom = Math.round(window.innerHeight - rect.top + 4);
      setPosition(next);
    }

    function closeMenu(focusTrigger) {
      setOpen(false);
      setView('root');
      setPosition(null);
      if (focusTrigger && rootRef.current) {
        var trigger = rootRef.current.querySelector('.gr-combo-trigger');
        if (trigger && typeof trigger.focus === 'function') trigger.focus();
      }
    }

    function toggle() {
      if (saving || (loading && !currentLabel) || props.disabled) return;
      if (open) { closeMenu(true); return; }
      measure();
      setView('root');
      setOpen(true);
    }

    useLayoutEffect(function () {
      if (!open) return undefined;
      measure();
      function onPointerDown(event) {
        var node = rootRef.current;
        if (node !== null && node.contains(event.target)) return;
        closeMenu(false);
      }
      function onReposition() { measure(); }
      document.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('scroll', onReposition, true);
      window.addEventListener('resize', onReposition);
      return function () {
        document.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('scroll', onReposition, true);
        window.removeEventListener('resize', onReposition);
      };
    }, [open, view]);

    // Focus the first actionable row after opening or switching views.
    useLayoutEffect(function () {
      if (!open) return;
      var menu = menuRef.current;
      if (!menu) return;
      var first = menu.querySelector('[data-gr-picker-item="true"]');
      if (first && typeof first.focus === 'function') first.focus();
    }, [open, view]);

    function onMenuKeyDown(event) {
      var key = event.key;
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (view !== 'root') setView('root');
        else closeMenu(true);
        return;
      }
      if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;
      var menu = menuRef.current;
      if (!menu) return;
      var items = menu.querySelectorAll('[data-gr-picker-item="true"]');
      if (items.length === 0) return;
      event.preventDefault();
      var active = document.activeElement;
      var at = -1;
      for (var index = 0; index < items.length; index += 1) {
        if (items[index] === active) { at = index; break; }
      }
      var next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : at + (key === 'ArrowDown' ? 1 : -1);
      if (next < 0) next = items.length - 1;
      if (next >= items.length) next = 0;
      items[next].focus();
    }

    function chooseModel(route) {
      if (!route) return;
      var same = current && String(route.provider) === current.provider && String(route.model) === current.model;
      closeMenu(true);
      if (!same && typeof props.onChange === 'function') {
        props.onChange({ provider: String(route.provider), model: String(route.model), reasoningEffort: null });
      }
    }

    function chooseEffort(id) {
      var next = id || null;
      var same = (explicitEffort || '') === (next || '');
      closeMenu(true);
      if (!same && typeof props.onChange === 'function') props.onChange({ reasoningEffort: next });
    }

    function navRow(key, label, value, onClick, rowDisabled) {
      return h('button', {
        key: key,
        type: 'button',
        role: 'menuitem',
        className: 'gr-model-row',
        'data-gr-picker-item': rowDisabled ? undefined : 'true',
        disabled: rowDisabled ? true : undefined,
        onClick: onClick,
      },
        h('span', { className: 'gr-model-row-label' }, label),
        h('span', { className: 'gr-model-row-value' }, value),
        h('span', { className: 'gr-model-row-chevron', 'aria-hidden': 'true' },
          h(IconChevronRight, { size: ICON_SIZE.md })));
    }

    function backRow() {
      return h('button', {
        key: 'back',
        type: 'button',
        className: 'gr-model-back',
        'data-gr-picker-item': 'true',
        onClick: function () { setView('root'); },
      },
        h('span', { className: 'gr-model-back-icon', 'aria-hidden': 'true' },
          h(IconChevronRight, { size: ICON_SIZE.md })),
        h('span', null, t('ai.pickerBack')));
    }

    function optionRow(key, label, selected, onClick) {
      return h('button', {
        key: key,
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': selected ? 'true' : 'false',
        className: cx('gr-model-option', selected && 'gr-model-option-selected'),
        'data-gr-picker-item': 'true',
        onClick: onClick,
      },
        h('span', { className: 'gr-model-option-label' }, label),
        selected ? h('span', { className: 'gr-combo-check' }, h(IconCheck, { size: ICON_SIZE.md })) : null);
    }

    var rows;
    if (view === 'root') {
      var effortValue = loading
        ? t('ai.pickerLoading')
        : (efforts.length > 0 ? effortLabel : t('ai.pickerNone'));
      rows = [
        navRow('models', t('ai.pickerModel'), currentLabel || t('ai.settingsModelPick'),
          function () { setView('models'); }, groups.length === 0 && !current),
        navRow('efforts', t('ai.pickerEffort'), effortValue,
          function () { setView('efforts'); }, loading || efforts.length === 0),
        currentLabel
          ? h('div', { key: 'summary', className: 'gr-model-summary' },
            h('span', { className: 'gr-model-summary-model' }, currentLabel),
            effectiveEffort ? h('span', { className: 'gr-model-summary-effort' }, effortName(effectiveEffort)) : null)
          : null,
      ];
    } else if (view === 'models') {
      rows = [backRow()];
      for (var groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        var currentGroup = groups[groupIndex];
        rows.push(h('div', { key: 'g-' + currentGroup.provider, className: 'gr-model-group' }, currentGroup.label));
        for (var optionIndex = 0; optionIndex < currentGroup.options.length; optionIndex += 1) {
          var option = currentGroup.options[optionIndex];
          var chosen = current && String(option.provider) === current.provider && String(option.model) === current.model;
          rows.push(optionRow(
            currentGroup.provider + '\u0000' + String(option.model) + '-' + optionIndex,
            routeLabel(option),
            chosen,
            (function (picked) { return function () { chooseModel(picked); }; })(option),
          ));
        }
      }
      if (groups.length === 0) rows.push(h('div', { key: 'empty', className: 'gr-model-empty' }, t('ai.settingsModelUnknown')));
    } else {
      rows = [backRow()];
      for (var effortIndex2 = 0; effortIndex2 < efforts.length; effortIndex2 += 1) {
        var effort = efforts[effortIndex2];
        rows.push(optionRow('effort-' + effort.id, effort.name, effectiveEffort === effort.id,
          (function (picked) { return function () { chooseEffort(picked.id); }; })(effort)));
      }
    }

    var menu = open && position
      ? h('div', {
        className: 'gr-combo-menu gr-model-menu',
        role: 'menu',
        tabIndex: -1,
        ref: menuRef,
        style: {
          top: position.top === undefined ? undefined : position.top + 'px',
          bottom: position.bottom === undefined ? undefined : position.bottom + 'px',
          right: position.right + 'px',
          minWidth: position.minWidth + 'px',
          maxHeight: position.maxHeight + 'px',
        },
        onKeyDown: onMenuKeyDown,
      }, rows)
      : null;

    return h('div', { className: 'gr-combo gr-model-picker', ref: rootRef },
      h('button', {
        type: 'button',
        className: 'gr-combo-trigger gr-model-trigger',
        'aria-haspopup': 'menu',
        'aria-expanded': open ? 'true' : 'false',
        disabled: (saving || props.disabled || (loading && !currentLabel)) ? true : undefined,
        onClick: toggle,
      },
        h('span', { className: 'gr-combo-value' }, currentLabel || (loading ? t('ai.settingsModelLoading') : t('ai.settingsModelPick'))),
        h('span', { className: 'gr-combo-chevron', 'aria-hidden': 'true' }, h(IconChevronDown, { size: ICON_SIZE.md }))),
      menu);
  }


  /* ------------------------------------------------------------------ */
  /* RemoteDialog                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Remote configuration dialog (branch chip → "Set remote repository…").
   * Contract props: open, name, url, remotes [{name,url}], busy, errorText,
   * onNameChange(value), onUrlChange(value), onPick(remote), onSubmit,
   * onClose, t, scoped.
   */
  function RemoteDialog(props) {
    var t = makeT(props.t);
    var open = !!props.open;
    var busy = !!props.busy;
    var remotes = Array.isArray(props.remotes) ? props.remotes : [];
    var name = props.name === undefined || props.name === null ? '' : String(props.name);
    var url = props.url === undefined || props.url === null ? '' : String(props.url);
    var trimmedName = name.trim();
    var exists = false;
    for (var index = 0; index < remotes.length; index += 1) {
      if (remotes[index] && String(remotes[index].name) === trimmedName) {
        exists = true;
        break;
      }
    }
    var canSubmit = trimmedName.length > 0 && url.trim().length > 0 && !busy;

    return h(Modal, {
      open: open,
      scoped: !!props.scoped,
      title: t('remote.title'),
      subtitle: t('remote.subtitle'),
      onClose: busy ? undefined : props.onClose,
      busy: busy,
      t: t,
      width: 'min(94vw, 560px)',
      height: 'auto',
      footer: h('div', { className: 'gr-dialog-actions' },
        h(Button, { variant: 'default', onClick: props.onClose, disabled: busy, t: t }, t('common.cancel')),
        h(Button, {
          variant: 'primary',
          onClick: props.onSubmit,
          disabled: !canSubmit,
          busy: busy,
          busyLabel: t('remote.saving'),
          t: t,
        }, t('remote.save'))),
    }, h('div', { className: 'gr-remote-form' },
      remotes.length > 0
        ? h('div', { className: 'gr-remote-existing' },
          h('div', { className: 'gr-remote-label' }, t('remote.existing')),
          remotes.map(function (remote) {
            var remoteName = String(remote.name || '');
            return h('button', {
              key: 'remote-' + remoteName,
              type: 'button',
              className: cx('gr-remote-row', remoteName === trimmedName && 'gr-remote-row-active'),
              title: t('remote.pick'),
              disabled: busy,
              onClick: function () {
                if (typeof props.onPick === 'function') props.onPick(remote);
              },
            },
              h('span', { className: 'gr-remote-row-name' }, remoteName),
              h('span', { className: 'gr-remote-row-url' }, String(remote.url || '')));
          }))
        : h(Hint, null, t('remote.none')),
      h('label', { className: 'gr-remote-label', htmlFor: 'gr-remote-name' }, t('remote.name')),
      h(TextField, {
        id: 'gr-remote-name',
        value: name,
        placeholder: t('remote.namePlaceholder'),
        disabled: busy,
        ariaLabel: t('remote.name'),
        onChange: function (event) {
          if (typeof props.onNameChange === 'function') props.onNameChange(event.target.value);
        },
      }),
      h('label', { className: 'gr-remote-label', htmlFor: 'gr-remote-url' }, t('remote.url')),
      h(TextField, {
        id: 'gr-remote-url',
        value: url,
        placeholder: t('remote.urlPlaceholder'),
        disabled: busy,
        ariaLabel: t('remote.url'),
        spellCheck: false,
        onChange: function (event) {
          if (typeof props.onUrlChange === 'function') props.onUrlChange(event.target.value);
        },
      }),
      exists
        ? h(Hint, { tone: 'warn' }, t('remote.updateHint', { name: trimmedName }))
        : h(Hint, null, t('remote.urlHint')),
      props.errorText ? h('div', { className: 'gr-error-box', role: 'alert' }, String(props.errorText)) : null,
      h(Hint, null, t('remote.localOnly'))));
  }


  function PanelSettings(props) {
    var t = makeT(props.t);
    var settings = props.settings || {};
    var saving = !!props.saving;
    var preclassify = settings.preclassify === true;
    var locale = settings.locale === 'en' ? 'en' : 'zh';

    var instructionLimit = 4000;
    var instructionState = React.useState(function () {
      return typeof settings.customInstructions === 'string' ? settings.customInstructions : '';
    });
    var instructions = instructionState[0];
    var setInstructions = instructionState[1];
    var instructionLength = String(instructions || '').length;

    var configuredMax = Number(settings.maxCandidates);
    if (!Number.isFinite(configuredMax)) configuredMax = 50;
    var maxState = React.useState(function () {
      return String(Math.max(1, Math.min(1000, Math.trunc(configuredMax))));
    });
    var maxText = maxState[0];
    var setMaxText = maxState[1];

    function commitInstructions() {
      var next = String(instructions || '').trim();
      var current = typeof settings.customInstructions === 'string' ? settings.customInstructions : '';
      if (next !== current && typeof props.onChange === 'function') {
        props.onChange({ customInstructions: next.length > 0 ? next : null });
      }
    }

    function commitMax() {
      var current = Math.max(1, Math.min(1000, Math.trunc(Number(settings.maxCandidates) || 50)));
      var parsed = Math.trunc(Number(maxText));
      if (!Number.isFinite(parsed)) { setMaxText(String(current)); return; }
      var next = Math.max(1, Math.min(1000, parsed));
      setMaxText(String(next));
      if (next !== current && typeof props.onChange === 'function') props.onChange({ maxCandidates: next });
    }

    function patch(partial) {
      if (typeof props.onChange === 'function') props.onChange(partial);
    }

    var modelsInfo = props.modelsInfo || null;
    var routes = modelsInfo && Array.isArray(modelsInfo.routes) ? modelsInfo.routes : [];
    /* `defaultModel` is accepted as a compatibility fallback for older host
     * replies; the contract reply uses `sessionModel`. */
    var sessionSource = modelsInfo && modelsInfo.sessionModel
      ? modelsInfo.sessionModel
      : (modelsInfo && modelsInfo.defaultModel ? modelsInfo.defaultModel : null);
    var sessionModel = sessionSource && sessionSource.provider && sessionSource.model
      ? { provider: String(sessionSource.provider), model: String(sessionSource.model) }
      : null;
    var explicitModel = typeof settings.provider === 'string' && settings.provider.length > 0
      && typeof settings.model === 'string' && settings.model.length > 0
      ? { provider: String(settings.provider), model: String(settings.model) }
      : null;
    var currentModel = explicitModel || sessionModel;
    var modelsLoading = !!props.modelsLoading;
    var modelsError = props.modelsError || null;
    var reasoning = modelsInfo && modelsInfo.reasoning && typeof modelsInfo.reasoning === 'object'
      ? modelsInfo.reasoning
      : null;
    var selectedEffort = typeof settings.reasoningEffort === 'string' ? settings.reasoningEffort : '';
    var languageChoices = [
      { value: 'zh', label: t('settings.languageZh') },
      { value: 'en', label: t('settings.languageEn') },
    ];

    var modelHelper = null;
    if (modelsError) {
      /* The host's raw English message is never shown: app.js passes the
       * code-mapped localized text as `modelsErrorText`. */
      modelHelper = h(Hint, { tone: 'error' }, t('ai.settingsModelLoadFailed', {
        message: props.modelsErrorText ? String(props.modelsErrorText) : errorMessage(modelsError),
      }));
    }

    return h('div', { className: 'gr-settings' },
      h('div', { className: 'gr-settings-scroll' },
        h('div', { className: 'gr-settings-content' },
          props.error
            ? h('div', { className: 'gr-error-box', role: 'alert' },
              props.errorText
                ? String(props.errorText)
                : t('settings.saveFailed', { message: errorMessage(props.error) }))
            : null,
          h(SettingSection, {
            title: t('ai.settingsTitle'),
            description: t('ai.settingsDescription'),
          },
            h(Hint, null, t('ai.settingsSwitchHint')),
            h('details', { className: 'gr-settings-note' },
              h('summary', { className: 'gr-settings-note-summary' },
                h('span', { className: 'gr-settings-note-chevron', 'aria-hidden': 'true' },
                  h(IconChevronRight, { size: ICON_SIZE.md })),
                h('span', { className: 'gr-settings-note-label' }, t('ai.settingsDetails'))),
              h('ul', { className: 'gr-settings-note-list' },
                h('li', null, t('ai.settingsDataNotice')),
                h('li', null, t('ai.settingsScopeNotice')),
                h('li', null, t('ai.settingsOffNote')))),
            h(SettingRow, {
              title: t('ai.settingsModelTitle'),
              description: t('ai.settingsModelDesc'),
            },
              h(ModelPicker, {
                t: t,
                routes: routes,
                reasoning: reasoning,
                current: currentModel,
                reasoningEffort: selectedEffort,
                loading: modelsLoading,
                saving: saving,
                disabled: false,
                onChange: patch,
              }),
              modelHelper),
            h(SettingRow, {
              title: t('ai.settingsPromptTitle'),
              description: t('ai.settingsPromptDesc'),
              full: true,
            },
              h('div', { className: 'gr-textarea-wrap' },
                h(Textarea, {
                  rows: 3,
                  maxLength: instructionLimit,
                  value: instructions,
                  disabled: saving,
                  placeholder: t('ai.settingsPromptPlaceholder'),
                  ariaLabel: t('ai.settingsPromptTitle'),
                  onChange: function (event) {
                    setInstructions(event.target.value);
                  },
                  onBlur: commitInstructions,
                }),
                h('div', { className: 'gr-textarea-meta' },
                  h('span', {
                    className: cx('gr-char-count', instructionLength >= instructionLimit - 200 && 'gr-char-count-near'),
                  }, t('ai.settingsChars', { n: formatCount(instructionLength) }))))),
            h(SettingRow, {
              title: t('ai.settingsMax'),
              description: t('ai.settingsMaxDesc'),
            },
              h('div', { className: 'gr-num-field' },
                h(TextField, {
                  type: 'number',
                  className: 'gr-num-input',
                  ariaLabel: t('ai.settingsMax'),
                  min: 1,
                  max: 1000,
                  step: 1,
                  value: maxText,
                  disabled: saving,
                  onChange: function (event) {
                    setMaxText(event.target.value);
                  },
                  onBlur: commitMax,
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitMax();
                    }
                  },
                }),
                h('span', { className: 'gr-num-unit', 'aria-hidden': 'true' }, t('ai.settingsMaxUnit')))),
            h(SettingRow, {
              title: t('ai.settingsPreclassify'),
              description: t('ai.settingsPreclassifyDesc'),
              controlClassName: 'gr-setting-control-switch',
            },
              h(Switch, {
                checked: preclassify,
                disabled: saving,
                label: t('ai.settingsPreclassify'),
                onChange: function (value) { patch({ preclassify: value }); },
              }))
          ),
          h(SettingSection, {
            title: t('settings.sectionInterface'),
            description: t('settings.languageDesc'),
          },
            h(SettingRow, {
              title: t('settings.language'),
              description: t('settings.languageZh') + ' / ' + t('settings.languageEn'),
            },
              h(Select, {
                className: 'gr-setting-select-sm',
                value: locale,
                options: languageChoices,
                ariaLabel: t('settings.language'),
                disabled: saving,
                onChange: function (value) { patch({ locale: value }); },
              })))
        )
      )
    );
  }

  /* ------------------------------------------------------------------ */
  /* EmptyState                                                          */
  /* ------------------------------------------------------------------ */

  /** Contract props: { title, hint, tone 'info'|'warn'|'error', action }. */
  function EmptyState(props) {
    var tone = props.tone === 'warn' || props.tone === 'error' ? props.tone : 'info';
    return h('div', {
      className: cx('gr-empty', 'gr-tone-' + tone),
      role: tone === 'error' ? 'alert' : 'status',
    },
      props.title ? h('div', { className: 'gr-empty-title' }, props.title) : null,
      props.hint ? h('div', { className: 'gr-empty-hint' }, props.hint) : null,
      props.action ? h('div', { className: 'gr-empty-action' }, props.action) : null
    );
  }

  /* ------------------------------------------------------------------ */
  /* StatusBar                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Contract props: busy, operation, error {message}|null, notice, onDismiss,
   * status (StatusPayload|null), repo (RepoRef|null), t.
   *
   * The strip is always present once the repository state is readable: the left
   * slot reports busy / error / notice and otherwise a steady "Ready", while the
   * right slot keeps the repository summary (branch · files · staged ·
   * unstaged · untracked · conflicts) in view — the persistent footer from the
   * cover. Shortcut hints stay in the Keyboard Shortcuts dialog.
   */
  function StatusBar(props) {
    var t = makeT(props.t);
    var busy = !!props.busy;
    var message = errorMessage(props.error);
    var notice = !message && props.notice ? String(props.notice) : '';
    var status = props.status || null;
    var repo = props.repo || (status && status.repo ? status.repo : null);
    var ready = !busy && !message && !notice && !!status && status.state === 'ok';
    if (!busy && !message && !notice && !ready) return null;
    var operation = props.operation === undefined || props.operation === null || props.operation === ''
      ? t('op.running')
      : String(props.operation);

    var summary = status && status.summary ? status.summary : null;
    var branchLabel = repo
      ? (repo.detached ? t('state.detached') : (repo.branch || t('common.unknown')))
      : '';
    var parts = [];
    if (branchLabel) {
      parts.push({
        key: 'branch',
        text: branchLabel,
        title: repo && repo.root ? String(repo.root) : branchLabel,
        className: 'gr-statusbar-branch',
      });
    }
    if (summary) {
      parts.push({
        key: 'files',
        text: t('summary.files', { n: formatCount(summary.files) }),
        title: t('summary.entries', { n: formatCount(summary.entries) }),
      });
      if (Number(summary.staged) > 0) {
        parts.push({
          key: 'staged',
          text: t('status.staged') + ' ' + formatCount(summary.staged),
          title: t('summary.scopeStaged'),
          className: 'gr-statusbar-staged',
        });
      }
      if (Number(summary.unstaged) > 0) {
        parts.push({
          key: 'unstaged',
          text: t('status.unstaged') + ' ' + formatCount(summary.unstaged),
          title: t('summary.scopeUnstaged'),
          className: 'gr-statusbar-unstaged',
        });
      }
      if (Number(summary.untracked) > 0) {
        parts.push({
          key: 'untracked',
          text: t('status.untracked') + ' ' + formatCount(summary.untracked),
          title: t('summary.scopeUntracked'),
          className: 'gr-statusbar-untracked gr-statusbar-extra',
        });
      }
      if (Number(summary.conflicts) > 0) {
        parts.push({
          key: 'conflicts',
          text: t('status.conflict') + ' ' + formatCount(summary.conflicts),
          title: t('state.conflictsHint'),
          className: 'gr-statusbar-conflict gr-statusbar-extra',
        });
      }
    }
    var summaryNodes = [];
    for (var partIndex = 0; partIndex < parts.length; partIndex += 1) {
      if (partIndex > 0) {
        summaryNodes.push(h('span', {
          key: 'sep-' + parts[partIndex].key,
          className: 'gr-statusbar-sep',
          'aria-hidden': 'true',
        }));
      }
      summaryNodes.push(h('span', {
        key: parts[partIndex].key,
        className: cx('gr-statusbar-seg', parts[partIndex].className),
        title: parts[partIndex].title || undefined,
      }, parts[partIndex].text));
    }
    var generatedAt = status ? formatClock(status.generatedAt) : '';

    var main = h('div', { className: 'gr-statusbar-main', role: 'status', 'aria-live': 'polite' },
      busy
        ? h('span', { className: 'gr-statusbar-busy' }, h(Spinner, { size: 10 }), h('span', null, operation))
        : null,
      message
        ? h('span', { className: 'gr-statusbar-error' }, h('span', null, message),
          h(IconButton, {
            label: t('app.dismiss'),
            title: t('app.dismiss'),
            className: 'gr-statusbar-dismiss',
            onClick: props.onDismiss,
            t: t,
          }, h(IconClose, { size: ICON_SIZE.md })))
        : null,
      notice ? h('span', { className: 'gr-statusbar-notice' }, notice) : null,
      ready
        ? h('span', {
          key: 'ready',
          className: 'gr-statusbar-ready',
          title: generatedAt ? t('app.updated', { time: generatedAt }) : undefined,
        },
          h('span', { className: 'gr-statusbar-dot', 'aria-hidden': 'true' }),
          h('span', null, t('status.ready')))
        : null);

    return h('div', { className: 'gr-statusbar' },
      main,
      summaryNodes.length > 0
        ? h('div', {
          className: 'gr-statusbar-summary',
          role: 'group',
          'aria-label': t('a11y.summary'),
        }, summaryNodes)
        : null);
  }

  /* ------------------------------------------------------------------ */
  /* ShortcutHelp                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Contract props: open, onClose, t.
   * Extra: `shortcuts` — array of { keys: string[], label: string } so app.js
   * can advertise the bindings it actually implements. `scoped` — passed
   * through to Modal for in-window dialogs.
   */
  function ShortcutHelp(props) {
    var t = makeT(props.t);
    var custom = Array.isArray(props.shortcuts) ? props.shortcuts : null;
    var mod = typeof util.isMac === 'function' && util.isMac() ? '⌘' : 'Ctrl';
    /* Defaults mirror the bindings implemented by app.js. */
    var rows = custom || [
      { keys: ['↓', '↑'], label: t('shortcut.navRows') },
      { keys: ['Home', 'End'], label: t('shortcut.fileEdges') },
      { keys: ['Alt', '↓/↑'], label: t('shortcut.switchFiles') },
      { keys: [mod, '←/→'], label: t('shortcut.prevChange') + ' / ' + t('shortcut.nextChange') },
      { keys: ['Enter'], label: t('shortcut.hunkMenu') },
      { keys: ['Shift', 'F10'], label: t('shortcut.contextMenu') },
      { keys: ['R'], label: t('shortcut.refresh') },
      { keys: ['?'], label: t('shortcut.helpToggle') },
      { keys: ['Esc'], label: t('shortcut.close') },
    ];
    return h(Modal, {
      open: !!props.open,
      scoped: !!props.scoped,
      title: t('shortcut.help'),
      onClose: props.onClose,
      t: t,
      width: 'min(94vw, 520px)',
      height: 'auto',
      footer: h('div', { className: 'gr-dialog-actions' },
        h(Button, { variant: 'primary', onClick: props.onClose, t: t }, t('app.close'))
      ),
    }, h('div', { className: 'gr-shortcuts' },
      rows.map(function (row, index) {
        if (!row || typeof row !== 'object') return null;
        var keys = Array.isArray(row.keys) ? row.keys : [String(row.keys)];
        return [
          h('div', { key: 'k-' + index, className: 'gr-shortcut-keys' },
            keys.map(function (key, keyIndex) {
              return h(Kbd, { key: keyIndex }, String(key));
            })
          ),
          h('div', { key: 'l-' + index, className: 'gr-shortcut-label' }, row.label ? String(row.label) : ''),
        ];
      })
    ));
  }

  /* ------------------------------------------------------------------ */
  /* Styles — every `.gr-*` rule lives here                              */
  /* ------------------------------------------------------------------ */

  var STYLE_TEXT = require('styles').STYLE_TEXT;

  function Styles() {
    return h('style', { 'data-gr-styles': 'true' }, STYLE_TEXT);
  }

  /* ------------------------------------------------------------------ */
  /* exports                                                             */
  /* ------------------------------------------------------------------ */

  exports.Styles = Styles;
  exports.ReviewButton = ReviewButton;
  exports.Modal = Modal;
  exports.dialogEscapeDeferred = dialogEscapeDeferred;
  exports.ESC_DEFER_SELECTOR = ESC_DEFER_SELECTOR;
  exports.IconButton = IconButton;
  exports.Button = Button;
  exports.LinkButton = LinkButton;
  exports.Badge = Badge;
  exports.Spinner = Spinner;
  exports.TopBar = TopBar;
  exports.ReviewTitle = ReviewTitle;
  exports.FileNav = FileNav;
  exports.ContextMenu = ContextMenu;
  exports.anchorMenuPosition = anchorMenuPosition;
  exports.OpenTargetButton = OpenTargetButton;
  exports.ConfirmDialog = ConfirmDialog;
  exports.CommitPanel = CommitPanel;
  exports.CommitAction = CommitAction;
  exports.PushDialog = PushDialog;
  exports.RemoteDialog = RemoteDialog;
  exports.PanelSettings = PanelSettings;
  exports.ModelPicker = ModelPicker;
  exports.EmptyState = EmptyState;
  exports.StatusBar = StatusBar;
  exports.ShortcutHelp = ShortcutHelp;
  exports.IconArrowUp = IconArrowUp;
  exports.IconArrowDown = IconArrowDown;
  exports.IconMinus = IconMinus;
  exports.IconClose = IconClose;
  exports.IconMaximize = IconMaximize;
  exports.IconRestore = IconRestore;
  exports.IconChevronDown = IconChevronDown;
  exports.IconExternal = IconExternal;
  exports.IconLocateSource = IconLocateSource;
  exports.IconAlert = IconAlert;
  exports.statusGlyph = statusGlyph;
  exports.branchMenuItems = branchMenuItems;
  exports.ICON_SIZE = ICON_SIZE;
});

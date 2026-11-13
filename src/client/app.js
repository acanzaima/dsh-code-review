__def('app', function (exports, require, React) {
  'use strict';

  var util = require('util');
  var state = require('state');
  var i18nModule = require('i18n');
  var rpcModule = require('rpc');
  var openInApp = require('open-in-app');
  var components = require('components');
  var DiffPane = require('diff-view').DiffPane;

  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;
  var useCallback = React.useCallback;
  var useMemo = React.useMemo;
  var useSyncExternalStore = React.useSyncExternalStore;

  var POLL_INTERVAL_MS = 6000;
  var AI_DEBOUNCE_MS = 350;
  var NOTICE_TIMEOUT_MS = 6000;
  /* Splitter bounds: navigation + splitter + diff always add up to the live
   * workspace width, so the drag is clamped against the measured workspace and
   * the diff column always keeps at least MIN_DIFF_WIDTH pixels. */
  var MIN_NAV_WIDTH = 180;
  var MAX_NAV_WIDTH = 560;
  var MIN_DIFF_WIDTH = 240;
  var SPLITTER_WIDTH = 6;

  // ---------------------------------------------------------------------------
  // Floating review windows
  //
  // The review panel is a frame-wide floating layer (`shell.overlay`, root
  // scoped), not a modal: every reviewed target owns one independent,
  // manually closable desktop-style window, so DSH stays usable behind it and
  // two workspaces can be reviewed side by side. Geometry is kept in memory for
  // the page lifetime and remembered per target across close/reopen.
  // ---------------------------------------------------------------------------
  var WINDOW_MARGIN = 16;
  var WINDOW_CASCADE_STEP = 26;
  var WINDOW_HEAD_HEIGHT = 42;
  var WINDOW_MIN_WIDTH = 760;
  var WINDOW_MIN_HEIGHT = 440;

  var rememberedGeometry = new Map();

  /**
   * The DSH frame reserves its own window chrome (Electron caption / macOS
   * traffic-light strip) above the page content and publishes it on <html>.
   * Review windows live strictly inside that work area: the layer is offset by
   * the same token in CSS and the JS geometry helpers subtract it here, so a
   * maximized window never slides under the DSH title strip and a drag can
   * never push the window off frame.
   */
  function frameTopInset() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
    var root = document ? document.documentElement : null;
    if (!root || typeof window.getComputedStyle !== 'function') return 0;
    var value = window.getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance');
    var inset = parseFloat(value);
    if (!Number.isFinite(inset) || inset < 0) return 0;
    var height = Number(window.innerHeight) || 0;
    if (height > 0) inset = Math.min(inset, Math.round(height / 2));
    return Math.round(inset);
  }

  function viewportSize() {
    if (typeof window === 'undefined') return { width: 1280, height: 800 };
    var width = Number(window.innerWidth);
    var height = Number(window.innerHeight);
    var safeHeight = Number.isFinite(height) && height > 0 ? height : 800;
    return {
      width: Number.isFinite(width) && width > 0 ? width : 1280,
      height: Math.max(240, safeHeight - frameTopInset()),
    };
  }

  function windowSizeBounds(viewport) {
    var vp = viewport || viewportSize();
    return {
      minWidth: Math.min(WINDOW_MIN_WIDTH, Math.max(320, vp.width - WINDOW_MARGIN * 2)),
      minHeight: Math.min(WINDOW_MIN_HEIGHT, Math.max(240, vp.height - WINDOW_MARGIN * 2)),
      maxWidth: Math.max(320, vp.width - WINDOW_MARGIN * 2),
      maxHeight: Math.max(240, vp.height - WINDOW_MARGIN * 2),
    };
  }

  function clampWindowSize(width, height, viewport) {
    var bounds = windowSizeBounds(viewport);
    var nextWidth = Number.isFinite(width) ? width : bounds.minWidth;
    var nextHeight = Number.isFinite(height) ? height : bounds.minHeight;
    return {
      width: util.clamp(Math.round(nextWidth), bounds.minWidth, bounds.maxWidth),
      height: util.clamp(Math.round(nextHeight), bounds.minHeight, bounds.maxHeight),
    };
  }

  /** Fully-visible rectangle: window creation and viewport changes. */
  function clampWindowRect(rect, viewport) {
    var vp = viewport || viewportSize();
    var size = clampWindowSize(rect && rect.width, rect && rect.height, vp);
    var maxX = Math.max(WINDOW_MARGIN, vp.width - WINDOW_MARGIN - size.width);
    var maxY = Math.max(WINDOW_MARGIN, vp.height - WINDOW_MARGIN - size.height);
    var x = rect && Number.isFinite(rect.x) ? rect.x : WINDOW_MARGIN;
    var y = rect && Number.isFinite(rect.y) ? rect.y : WINDOW_MARGIN;
    return {
      x: util.clamp(Math.round(x), WINDOW_MARGIN, maxX),
      y: util.clamp(Math.round(y), WINDOW_MARGIN, maxY),
      width: size.width,
      height: size.height,
    };
  }

  /**
   * A minimized window renders as its title strip only: the stored rectangle is
   * the footprint it restores to, but on screen it occupies just
   * WINDOW_HEAD_HEIGHT. Clamp the live origin and width against the work area
   * with that strip footprint — dragging a minimized window may otherwise never
   * reach the lower part of the work area — while keeping the stored size intact
   * as the restore footprint.
   */
  function clampMinimizedWindowRect(rect, viewport) {
    var vp = viewport || viewportSize();
    var size = clampWindowSize(rect && rect.width, rect && rect.height, vp);
    var x = rect && Number.isFinite(rect.x) ? rect.x : 0;
    var y = rect && Number.isFinite(rect.y) ? rect.y : 0;
    return {
      x: util.clamp(Math.round(x), 0, Math.max(0, vp.width - size.width)),
      y: util.clamp(Math.round(y), 0, Math.max(0, vp.height - WINDOW_HEAD_HEIGHT)),
      width: size.width,
      height: size.height,
    };
  }

  /**
   * Drag position: the window stays wholly inside the work area. Dragging is
   * not allowed to slide a window under the DSH title strip or past any frame
   * edge, so every title-bar button remains reachable and the DSH chrome is
   * never covered by a window it belongs to.
   */
  function dragWindowRect(rect, dx, dy, viewport) {
    var vp = viewport || viewportSize();
    var maxX = Math.max(0, vp.width - rect.width);
    var maxY = Math.max(0, vp.height - rect.height);
    return {
      x: util.clamp(Math.round(rect.x + dx), 0, maxX),
      y: util.clamp(Math.round(rect.y + dy), 0, maxY),
      width: rect.width,
      height: rect.height,
    };
  }

  /**
   * Resize from the right edge (`e`), bottom edge (`s`) or both (`se`). The
   * origin stays pinned and the far edges may only grow up to the work-area
   * boundary from that origin, so a resize can never push the window outside.
   */
  function resizeWindowRect(rect, dx, dy, edge, viewport) {
    var vp = viewport || viewportSize();
    var bounds = windowSizeBounds(vp);
    var maxWidth = Math.max(bounds.minWidth, vp.width - rect.x);
    var maxHeight = Math.max(bounds.minHeight, vp.height - rect.y);
    var width = rect.width;
    var height = rect.height;
    if (edge === 'e' || edge === 'se') width += dx;
    if (edge === 's' || edge === 'se') height += dy;
    return {
      x: rect.x,
      y: rect.y,
      width: util.clamp(Math.round(width), bounds.minWidth, Math.min(bounds.maxWidth, maxWidth)),
      height: util.clamp(Math.round(height), bounds.minHeight, Math.min(bounds.maxHeight, maxHeight)),
    };
  }

  /* Default window footprint: 85% of the DSH window (the viewport the plugin
   * lives in), centered, then clamped by the minimum size and the frame margin.
   * Mirrors what the user expects when opening a desktop window on a large app
   * window: a generous but clearly floating surface. */
  var WINDOW_DEFAULT_RATIO = 0.85;

  function defaultWindowGeometry(viewport, cascadeIndex) {
    var vp = viewport || viewportSize();
    var bounds = windowSizeBounds(vp);
    var width = util.clamp(Math.round(vp.width * WINDOW_DEFAULT_RATIO), bounds.minWidth, bounds.maxWidth);
    var height = util.clamp(Math.round(vp.height * WINDOW_DEFAULT_RATIO), bounds.minHeight, bounds.maxHeight);
    var step = (Math.max(0, Math.floor(cascadeIndex) || 0) % 5) * WINDOW_CASCADE_STEP;
    return clampWindowRect({
      x: Math.round((vp.width - width) / 2) + step,
      y: Math.round((vp.height - height) / 2) + step,
      width: width,
      height: height,
    }, vp);
  }

  /** Maximized: fill the whole DSH work area (below the frame title strip). */
  function maximizedWindowGeometry(viewport) {
    var vp = viewport || viewportSize();
    return { x: 0, y: 0, width: vp.width, height: vp.height };
  }

  function rememberWindowGeometry(key, geometry) {
    if (!key || !geometry) return;
    rememberedGeometry.set(String(key), {
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
    });
  }

  /** Geometry for a window that is about to open: remembered or cascaded. */
  function windowGeometryForOpen(key, openCount) {
    var viewport = viewportSize();
    var remembered = rememberedGeometry.get(String(key));
    if (remembered) return clampWindowRect(remembered, viewport);
    return defaultWindowGeometry(viewport, openCount || 0);
  }

  /** Persist the live geometry of one window under its target key. */
  function saveWindowGeometry(id) {
    var windows = state.windowStore.get().windows;
    for (var index = 0; index < windows.length; index += 1) {
      if (windows[index].id !== id) continue;
      rememberWindowGeometry(windows[index].key, windows[index]);
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function flattenGroups(groups) {
    var list = [];
    for (var index = 0; index < groups.length; index += 1) {
      var entries = groups[index].entries || [];
      for (var at = 0; at < entries.length; at += 1) list.push(entries[at]);
    }
    return list;
  }

  function firstEntryKey(groups) {
    var flat = flattenGroups(groups);
    return flat.length > 0 ? flat[0].key : null;
  }

  /** Mirror FileNav's group-id rule so bulk actions address the same ids. */
  function groupIdOf(group, index) {
    return String((group && (group.id || group.key || group.name)) || 'group-' + index);
  }

  /** Group id containing a change key, or null; used by scroll-from-source. */
  function groupIdForEntry(groups, key) {
    if (!key) return null;
    for (var index = 0; index < groups.length; index += 1) {
      var group = groups[index];
      var entries = group && group.entries ? group.entries : [];
      for (var at = 0; at < entries.length; at += 1) {
        if (entries[at] && entries[at].key === key) return groupIdOf(group, index);
      }
    }
    return null;
  }

  /**
   * Signature for AI grouping. Semantic grouping only depends on the set of
   * changed paths and their change kind: staging/unstaging a file rewrites its
   * entry key and fingerprint, but must NOT reclassify the whole change set (the
   * index state is not an input to grouping). It also keeps the grouping stable
   * when the user toggles commit checkboxes.
   */
  function aiEntriesSignature(entries) {
    var lines = [];
    var seen = {};
    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      if (!entry || !entry.path) continue;
      var line = String(entry.path) + '|' + String(entry.change || '')
        + (entry.oldPath ? '|' + String(entry.oldPath) : '');
      if (Object.prototype.hasOwnProperty.call(seen, line)) continue;
      seen[line] = true;
      lines.push(line);
    }
    lines.sort();
    return util.hashString(lines.join('\n')) + ':' + lines.length;
  }

  /**
   * Convert a classify result (categories of entry keys) into categories of
   * paths. Paths survive staging/unstaging, so the same grouping keeps mapping
   * onto entries after a checkbox toggle instead of collapsing into "Other".
   * `keyPaths` is the key→path table captured when the request was sent, since
   * the keys in the result refer to that snapshot.
   */
  function aiPathGroups(result, keyPaths) {
    if (!result || !Array.isArray(result.categories)) return null;
    var groups = [];
    for (var catIndex = 0; catIndex < result.categories.length; catIndex += 1) {
      var category = result.categories[catIndex];
      if (!category) continue;
      var ids = Array.isArray(category.ids) ? category.ids : [];
      var paths = [];
      for (var at = 0; at < ids.length; at += 1) {
        var id = ids[at];
        var path = keyPaths && Object.prototype.hasOwnProperty.call(keyPaths, id) ? keyPaths[id] : null;
        if (path) paths.push(String(path));
      }
      if (paths.length === 0) continue;
      var pathGroup = {
        name: String(category.name || ''),
        description: category.description ? String(category.description) : '',
        paths: paths,
      };
      /* Logic mode marks the "nothing that changes runtime behaviour" bucket
       * with a stable kind; the navigation localizes it instead of showing the
       * machine name (`NON_FUNCTIONAL`). */
      if (category.kind === 'non-functional') pathGroup.kind = 'non-functional';
      groups.push(pathGroup);
    }
    return groups.length > 0 ? groups : null;
  }

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
   * Localized, code-mapped error text (zh/en). The host's raw `message` is never
   * shown: it may be an internal exception or contain host paths. See
   * `i18n.js` for the full code → dictionary-key table.
   */
  var describeError = i18nModule.describeError;

  function isEditableTarget(target) {
    if (!target || typeof target.tagName !== 'string') return false;
    if (target.isContentEditable) return true;
    var tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  function commitExpectation(status) {
    if (!status || !status.repo) return null;
    return {
      headSha: status.repo.headSha === undefined ? null : status.repo.headSha,
      stagedFingerprint: status.stagedFingerprint === undefined ? '' : String(status.stagedFingerprint),
    };
  }

  /**
   * `expected` map for a stage/unstage call: the exact fingerprints the client
   * previewed, keyed by entry key. `'all'` binds the full set of entries the
   * host will touch: stage = every unstaged row plus untracked rows (conflicts
   * and already-staged rows are never targets); unstage = every staged entry.
   * Any hidden or externally changed target makes the host reject the write with
   * `entry/stale` instead of silently staging it.
   */
  function expectedFingerprints(entries, method, keys) {
    var expected = {};
    var list = Array.isArray(entries) ? entries : [];
    var wanted = Array.isArray(keys) ? keys : null;
    for (var index = 0; index < list.length; index += 1) {
      var entry = list[index];
      if (!entry || typeof entry.key !== 'string' || !entry.fingerprint) continue;
      var include = wanted !== null
        ? wanted.indexOf(entry.key) !== -1
        : method === 'stage'
          ? entry.status === 'unstaged' || entry.status === 'untracked'
          : entry.status === 'staged';
      if (!include) continue;
      expected[entry.key] = entry.fingerprint;
    }
    return expected;
  }

  /**
   * Push dialog defaults from a preview: a read-only local source branch plus an
   * editable remote/target. A user-provided value wins so re-previewing after
   * changing the remote keeps the chosen target.
   */
  function pushDefaults(preview, requestedRemote, requestedTarget) {
    var remotes = preview && Array.isArray(preview.remotes) ? preview.remotes : [];
    var remote = requestedRemote !== undefined && requestedRemote !== ''
      ? String(requestedRemote)
      : String((preview && (preview.remote || preview.defaultRemote)) || (remotes[0] && remotes[0].name) || '');
    var target = requestedTarget !== undefined && requestedTarget !== ''
      ? String(requestedTarget)
      : String((preview && (preview.targetBranch || preview.sourceBranch || preview.branch)) || '');
    return { remote: remote, target: target };
  }

  // ---------------------------------------------------------------------------
  // Plugin settings bootstrap (git groups vs AI groups, locale, limits)
  // ---------------------------------------------------------------------------
  /**
   * Persisted commit mode of the drawer's split commit control. Unknown values
   * (an older settings file, the retired 'aiCommitPush' mode) fall back to the
   * plain commit.
   */
  function commitModeOf(value) {
    return value === 'commitPush' ? 'commitPush' : 'commit';
  }

  /** Normalise the settings value carried in the client store. */
  function pickSettingsValue(value) {
    var result = {
      aiClassify: value && value.aiClassify === true,
      aiGrouping: value && value.aiGrouping === 'logic' ? 'logic' : 'role',
      commitMode: commitModeOf(value && value.commitMode),
      preclassify: value && value.preclassify === true,
      maxCandidates: value && Number.isFinite(value.maxCandidates) ? value.maxCandidates : 50,
    };
    if (value && typeof value.provider === 'string' && value.provider.length > 0) result.provider = value.provider;
    if (value && typeof value.model === 'string' && value.model.length > 0) result.model = value.model;
    if (value && typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0) result.reasoningEffort = value.reasoningEffort;
    if (value && typeof value.customInstructionsRole === 'string' && value.customInstructionsRole.length > 0) result.customInstructionsRole = value.customInstructionsRole;
    if (value && typeof value.customInstructionsLogic === 'string' && value.customInstructionsLogic.length > 0) result.customInstructionsLogic = value.customInstructionsLogic;
    if (value && typeof value.defaultModel === 'string' && value.defaultModel.length > 0) result.defaultModel = value.defaultModel;
    return result;
  }

  /** Settings object handed to the in-panel settings dialog. */
  function settingsForDialog(snapshot) {
    var value = (snapshot && snapshot.value) || {};
    var runtimeI18n = state.runtime && state.runtime.i18n;
    var activeLocale = runtimeI18n && typeof runtimeI18n.getLocale === 'function' ? runtimeI18n.getLocale() : 'zh';
    var locale = snapshot && (snapshot.locale === 'en' || snapshot.locale === 'zh')
      ? snapshot.locale
      : (activeLocale === 'en' ? 'en' : 'zh');
    var settings = {
      aiClassify: value.aiClassify === true,
      aiGrouping: value.aiGrouping === 'logic' ? 'logic' : 'role',
      preclassify: value.preclassify === true,
      maxCandidates: value.maxCandidates,
      locale: locale,
    };
    if (typeof value.provider === 'string') settings.provider = value.provider;
    if (typeof value.model === 'string') settings.model = value.model;
    if (typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0) settings.reasoningEffort = value.reasoningEffort;
    if (typeof value.customInstructionsRole === 'string') settings.customInstructionsRole = value.customInstructionsRole;
    if (typeof value.customInstructionsLogic === 'string') settings.customInstructionsLogic = value.customInstructionsLogic;
    return settings;
  }

  /** Latest settings request wins: a late reply must not overwrite newer state. */
  var settingsSeq = 0;

  function loadSettings() {
    var rpc = state.runtime.rpc;
    if (!rpc) return Promise.resolve();
    var seq = ++settingsSeq;
    return rpc.call('settingsGet').then(function (value) {
      if (seq !== settingsSeq) return value;
      state.settingsStore.set({
        loaded: true,
        saving: false,
        error: null,
        value: pickSettingsValue(value),
        locale: value && (value.locale === 'zh' || value.locale === 'en') ? value.locale : null,
        model: value && value.model ? value.model : null,
      });
      state.runtime.i18n.setLocale(
        value && (value.locale === 'zh' || value.locale === 'en')
          ? value.locale
          : state.runtime.i18n.getLocale(),
      );
      return value;
    }).catch(function (error) {
      if (seq !== settingsSeq) return undefined;
      state.settingsStore.set(function (current) {
        return {
          loaded: current.loaded,
          saving: false,
          error: error || new Error('settingsGet failed'),
          value: current.value,
          locale: current.locale,
          model: current.model,
        };
      });
      return undefined;
    });
  }

  function saveSettings(patch) {
    var rpc = state.runtime.rpc;
    if (!rpc) return Promise.resolve();
    state.settingsStore.set(function (current) {
      var nextValue = {};
      var keys = ['aiClassify', 'aiGrouping', 'commitMode', 'preclassify', 'maxCandidates', 'provider', 'model', 'reasoningEffort', 'customInstructionsRole', 'customInstructionsLogic', 'defaultModel'];
      for (var index = 0; index < keys.length; index += 1) {
        if (current.value && current.value[keys[index]] !== undefined) nextValue[keys[index]] = current.value[keys[index]];
      }
      if (patch) {
        if ('aiClassify' in patch) nextValue.aiClassify = patch.aiClassify === true;
        if ('aiGrouping' in patch) nextValue.aiGrouping = patch.aiGrouping === 'logic' ? 'logic' : 'role';
        if ('commitMode' in patch) nextValue.commitMode = commitModeOf(patch.commitMode);
        if ('preclassify' in patch) nextValue.preclassify = patch.preclassify === true;
        if ('maxCandidates' in patch) nextValue.maxCandidates = patch.maxCandidates;
        if ('provider' in patch) {
          if (patch.provider === null) delete nextValue.provider;
          else nextValue.provider = patch.provider;
        }
        if ('model' in patch) {
          if (patch.model === null) delete nextValue.model;
          else nextValue.model = patch.model;
        }
        if ('reasoningEffort' in patch) {
          if (patch.reasoningEffort === null) delete nextValue.reasoningEffort;
          else nextValue.reasoningEffort = patch.reasoningEffort;
        }
        if ('customInstructionsRole' in patch) {
          if (patch.customInstructionsRole === null) delete nextValue.customInstructionsRole;
          else nextValue.customInstructionsRole = patch.customInstructionsRole;
        }
        if ('customInstructionsLogic' in patch) {
          if (patch.customInstructionsLogic === null) delete nextValue.customInstructionsLogic;
          else nextValue.customInstructionsLogic = patch.customInstructionsLogic;
        }
      }
      return {
        loaded: current.loaded,
        saving: true,
        error: null,
        value: nextValue,
        locale: patch && patch.locale !== undefined ? patch.locale : current.locale,
        model: current.model,
      };
    });
    var seq = ++settingsSeq;
    return rpc.call('settingsSet', { patch: patch }).then(function (value) {
      if (seq !== settingsSeq) return value;
      state.settingsStore.set({
        loaded: true,
        saving: false,
        error: null,
        value: pickSettingsValue(value),
        locale: value && (value.locale === 'zh' || value.locale === 'en') ? value.locale : null,
        model: value && value.model ? value.model : null,
      });
      if (value && (value.locale === 'zh' || value.locale === 'en')) {
        state.runtime.i18n.setLocale(value.locale);
      }
      return value;
    }).catch(function (error) {
      if (seq === settingsSeq) {
        state.settingsStore.set(function (current) {
          return {
            loaded: current.loaded,
            saving: false,
            error: error || new Error('settingsSet failed'),
            value: current.value,
            locale: current.locale,
            model: current.model,
          };
        });
      }
      throw error;
    });
  }

  /**
   * Settings patch for one grouping selector option. Git status only turns AI
   * grouping off (the persisted AI mode survives); the two AI options turn it
   * on and persist their mode, so the toolbar selection survives a restart and
   * the classifier receives the same mode the navigation shows.
   */
  function groupingSettingsPatch(mode) {
    if (mode === 'role') return { aiClassify: true, aiGrouping: 'role' };
    if (mode === 'logic') return { aiClassify: true, aiGrouping: 'logic' };
    return { aiClassify: false };
  }

  // ---------------------------------------------------------------------------
  // Header entry button (session-scoped slot)
  //
  // Opens the floating review window for the current conversation. Clicking the
  // button again for the same session focuses the existing window instead of
  // creating another one; a different session/workspace opens a second window.
  // ---------------------------------------------------------------------------
  function HeaderButtonEntry(props) {
    var t = state.useT();
    var windowState = useSyncExternalStore(state.windowStore.subscribe, state.windowStore.get, state.windowStore.get);
    var sessionId = props && props.sessionId ? props.sessionId : null;
    function open() {
      var target = { sessionId: sessionId, label: 'session' };
      var key = state.windowKeyForTarget(target);
      var openCount = windowState.windows.length;
      state.openPanel(target, windowGeometryForOpen(key, openCount));
    }
    return h(components.ReviewButton, {
      t: t,
      onOpen: open,
      active: state.hasWindowFor(sessionId),
      sessionId: sessionId,
    });
  }


  // ---------------------------------------------------------------------------
  // One floating review window's content (mounts once per review target)
  //
  // Every window is its own component instance, so the repository snapshot,
  // selected file, diff, AI groups, commit drawer and dialogs are independent
  // per window. Only the plugin settings and per-repository review marks are
  // shared between windows.
  // ---------------------------------------------------------------------------
  var ReviewBody = React.memo(function ReviewBody(props) {
    var t = state.useT();
    var settingsSnapshot = state.useStore(state.settingsStore);

    // ---- repository snapshot ------------------------------------------------
    var [snapshot, setSnapshot] = useState(null);
    var [loading, setLoading] = useState(false);
    var [refreshError, setRefreshError] = useState(null);
    /* A one-click `git init` for a workspace that is not a repository yet. */
    var [initBusy, setInitBusy] = useState(false);
    var [selectedKey, setSelectedKey] = useState(null);
    var [diffState, setDiffState] = useState({ key: null, loading: false, error: null, value: null });
    var [diffNonce, setDiffNonce] = useState(0);
    var [busy, setBusy] = useState(null);
    var [notice, setNotice] = useState(null);
    var [operationError, setOperationError] = useState(null);
    /* DSH open-in-app: installed directory applications + file-open availability. */
    var [openTargetState, setOpenTargetState] = useState({ apps: [], defaultId: '', loading: true, failed: false });
    var [openTargetBusy, setOpenTargetBusy] = useState(false);
    var [fileOpenAvailable, setFileOpenAvailable] = useState(false);
    var [collapsedGroups, setCollapsedGroups] = useState(function () {
      return new Set();
    });
    var [locateNonce, setLocateNonce] = useState(0);
    var [search, setSearch] = useState('');
    var [navWidth, setNavWidth] = useState(300);
    var [menu, setMenu] = useState(null);
    var [confirm, setConfirm] = useState(null);
    var [commitOpen, setCommitOpen] = useState(false);
    var [commitMessage, setCommitMessage] = useState('');
    var [commitBusy, setCommitBusy] = useState(false);
    var [commitGenerating, setCommitGenerating] = useState(false);
    var [commitError, setCommitError] = useState(null);
    var [commitStale, setCommitStale] = useState(false);
    var [pushState, setPushState] = useState({ open: false, preview: null, loading: false, error: null, busy: false, remote: '', target: '' });
    var [shortcutHelp, setShortcutHelp] = useState(false);
    var [panelSettingsOpen, setPanelSettingsOpen] = useState(false);
    var [modelsInfo, setModelsInfo] = useState(null);
    var [modelsLoading, setModelsLoading] = useState(false);
    var [modelsError, setModelsError] = useState(null);
    var [aiState, setAiState] = useState({ signature: null, result: null, pathGroups: null, loading: false, error: null, notice: null, model: null });
    /* Remote configuration dialog (branch chip → "Set remote repository…"). */
    var [remoteState, setRemoteState] = useState({ open: false, name: 'origin', url: '', busy: false, error: null });

    var open = true;
    var target = props.target || { sessionId: null, cwd: null, label: '' };
    var sessionId = target && target.sessionId ? target.sessionId : null;
    var aiEnabled = settingsSnapshot.value.aiClassify === true;
    /* Persisted AI grouping mode; only meaningful while AI grouping is on. The
     * classifier and the navigation must always agree on it. */
    var aiGrouping = settingsSnapshot.value.aiGrouping === 'logic' ? 'logic' : 'role';

    var snapshotRef = useRef(null);
    snapshotRef.current = snapshot;
    var selectedKeyRef = useRef(null);
    selectedKeyRef.current = selectedKey;
    var busyRef = useRef(null);
    busyRef.current = busy;
    var refreshSeqRef = useRef(0);
    var previousEntriesRef = useRef([]);
    var diffRef = useRef(null);
    var navScrollRef = useRef(null);
    var workspaceRef = useRef(null);
    var aiRequestRef = useRef({ id: null, signature: null, controller: null, timer: null });
    /* Live mode for async replies: a classify response must be checked against
     * the mode that is active now, not only the one captured when it started. */
    var aiGroupingRef = useRef(aiGrouping);
    aiGroupingRef.current = aiGrouping;
    var remoteStateRef = useRef(remoteState);
    remoteStateRef.current = remoteState;
    var tRef = useRef(t);
    tRef.current = t;
    var settingsSavingRef = useRef(false);
    settingsSavingRef.current = !!(settingsSnapshot && settingsSnapshot.saving);
    /* Target generation: bumped whenever the panel opens/closes or its target
     * changes. Every async reply checks it before touching state, so a late
     * response for repository A can never overwrite repository B. */
    var targetGenerationRef = useRef(0);
    var diffStateRef = useRef(diffState);
    diffStateRef.current = diffState;
    var pushStateRef = useRef(pushState);
    pushStateRef.current = pushState;
    var commitBusyRef = useRef(false);
    commitBusyRef.current = commitBusy;
    /* In-flight AI commit-message draft: { id, controller }. */
    var commitGenerateRef = useRef({ id: null, controller: null });
    var pushBusyRef = useRef(false);
    pushBusyRef.current = !!(pushState && pushState.busy);
    var pushPreviewSeqRef = useRef(0);
    var pushPreviewTimerRef = useRef(null);

    // ---- status refresh -----------------------------------------------------
    var groupsRef = useRef([]);

    var applyStatus = useCallback(function (status, options) {
      var opts = options || {};
      setSnapshot(status);
      setRefreshError(null);
      var entries = Array.isArray(status && status.entries) ? status.entries : [];
      var previousEntries = previousEntriesRef.current;
      previousEntriesRef.current = entries;
      setSelectedKey(function (current) {
        if (current && entries.some(function (entry) { return entry.key === current; })) return current;
        if (current && previousEntries.length > 0) {
          var previousIndex = -1;
          for (var at = 0; at < previousEntries.length; at += 1) {
            if (previousEntries[at].key === current) { previousIndex = at; break; }
          }
          /* A stage/unstage toggle rewrites the entry key but not the file: keep
           * the selection on the same path instead of jumping to whatever row
           * now happens to sit at the old index. */
          if (previousIndex !== -1) {
            var previousPath = previousEntries[previousIndex].path;
            for (var matchAt = 0; matchAt < entries.length; matchAt += 1) {
              if (entries[matchAt].path === previousPath) return entries[matchAt].key;
            }
          }
          if (previousIndex !== -1 && entries.length > 0) {
            return entries[Math.min(previousIndex, entries.length - 1)].key;
          }
        }
        if (opts.keepSelectionOnly) return current;
        return entries.length > 0 ? entries[0].key : null;
      });
    }, []);

    var refresh = useCallback(function (options) {
      var opts = options || {};
      if (!state.runtime.rpc) return Promise.resolve(null);
      var seq = ++refreshSeqRef.current;
      var generation = targetGenerationRef.current;
      if (!opts.silent) setLoading(true);
      var params = sessionId ? { sessionId: sessionId } : {};
      if (target && target.cwd) params.cwd = target.cwd;
      return state.runtime.rpc.call('status', params).then(function (status) {
        if (generation !== targetGenerationRef.current || seq !== refreshSeqRef.current) return null;
        applyStatus(status, opts);
        return status;
      }).catch(function (error) {
        if (generation !== targetGenerationRef.current || seq !== refreshSeqRef.current) return null;
        if (!opts.silent) setRefreshError(error);
        return null;
      }).then(function (status) {
        if (generation === targetGenerationRef.current && seq === refreshSeqRef.current) setLoading(false);
        return status;
      });
    }, [sessionId, applyStatus, target && target.cwd]);

    /* One-click repository initialisation for the no-git empty state. The host
     * runs plain `git init` (never README / LICENSE / .gitignore): this panel
     * reviews an existing workspace, so only `.git/` may be created and every
     * file must stay untouched. The reply already carries the post-init status. */
    var initRepository = useCallback(function () {
      var rpc = state.runtime.rpc;
      if (!rpc || initBusy) return;
      var generation = targetGenerationRef.current;
      var params = sessionId ? { sessionId: sessionId } : {};
      if (!sessionId && target && target.cwd) params.cwd = target.cwd;
      setInitBusy(true);
      setOperationError(null);
      rpc.call('repoInit', params).then(function (result) {
        if (generation !== targetGenerationRef.current) return;
        refreshSeqRef.current += 1;
        if (result && result.status) applyStatus(result.status);
        else refresh({ silent: true, keepSelectionOnly: true });
        setNotice({ tone: 'success', text: tRef.current('state.noGitInitialized') });
      }).catch(function (error) {
        if (generation !== targetGenerationRef.current) return;
        setOperationError({ code: error && error.code, message: describeError(error, tRef.current) });
      }).then(function () {
        setInitBusy(false);
      });
    }, [sessionId, target && target.cwd, initBusy, applyStatus, refresh]);

    // Initial load: invalidate every in-flight request and drop any previous
    // snapshot immediately, so one window never shows another repository's
    // state. Each window mounts its own instance, so this mostly runs on mount.
    useEffect(function () {
      targetGenerationRef.current += 1;
      refreshSeqRef.current += 1;
      pushPreviewSeqRef.current += 1;
      if (pushPreviewTimerRef.current !== null) {
        clearTimeout(pushPreviewTimerRef.current);
        pushPreviewTimerRef.current = null;
      }
      cancelAiRequest();
      previousEntriesRef.current = [];
      setSnapshot(null);
      setLoading(false);
      setRefreshError(null);
      setSelectedKey(null);
      setDiffState({ key: null, loading: false, error: null, value: null });
      setDiffNonce(0);
      setBusy(null);
      setInitBusy(false);
      setCommitBusy(false);
      setCommitOpen(false);
      setCommitMessage('');
      setCommitError(null);
      setCommitStale(false);
      setPushState({ open: false, preview: null, loading: false, error: null, busy: false, remote: '', target: '' });
      setPanelSettingsOpen(false);
      setShortcutHelp(false);
      setModelsInfo(null);
      setModelsError(null);
      setModelsLoading(false);
      setOperationError(null);
      setNotice(null);
      setMenu(null);
      setConfirm(null);
      setAiState({ signature: null, result: null, pathGroups: null, loading: false, error: null, notice: null, model: null });
      if (!open) return undefined;
      refresh();
      return undefined;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, props.openToken, sessionId]);

    // Background refresh: window focus + visibility + slow poll while open.
    useEffect(function () {
      if (!open) return undefined;
      var onWake = function () {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        refresh({ silent: true, keepSelectionOnly: true });
      };
      var handle = null;
      var startPolling = function () {
        if (handle !== null) return;
        handle = setInterval(onWake, POLL_INTERVAL_MS);
      };
      var stopPolling = function () {
        if (handle === null) return;
        clearInterval(handle);
        handle = null;
      };
      var onVisibility = function () {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') stopPolling();
        else {
          startPolling();
          onWake();
        }
      };
      window.addEventListener('focus', onWake);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
      startPolling();
      return function () {
        window.removeEventListener('focus', onWake);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        stopPolling();
      };
    }, [open, refresh]);

    // ---- diff loading -------------------------------------------------------
    /* The selected entry's fingerprint is part of the diff dependency, so a
     * write/poll that changes the content re-fetches the diff. The effect below
     * keeps the previous content on screen for the same file meanwhile; only a
     * file/repository change drops into the loading skeleton. */
    var selectedDiffSignature = '';
    if (snapshot && selectedKey) {
      var snapshotEntriesForDiff = Array.isArray(snapshot.entries) ? snapshot.entries : [];
      for (var diffEntryIndex = 0; diffEntryIndex < snapshotEntriesForDiff.length; diffEntryIndex += 1) {
        var diffCandidate = snapshotEntriesForDiff[diffEntryIndex];
        if (!diffCandidate || diffCandidate.key !== selectedKey) continue;
        selectedDiffSignature = String(diffCandidate.key) + '|' + util.fingerprintKey(diffCandidate);
        break;
      }
    }

    useEffect(function () {
      if (!open || !selectedKey || !snapshot || !snapshot.repo) {
        setDiffState({ key: null, loading: false, error: null, value: null });
        return undefined;
      }
      var key = selectedKey;
      var generation = targetGenerationRef.current;
      var controller = new AbortController();
      /* A write (stage/unstage) rewrites the selected entry's key and
       * fingerprint, which legitimately re-fetches the diff. Keep the previous
       * content on screen while that happens — showing the loading skeleton on
       * every checkbox click makes a local action look like a full reload. Only
       * a different file (or repository) clears the pane immediately. */
      var selectedPath = '';
      var snapshotEntries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
      for (var entryIndex = 0; entryIndex < snapshotEntries.length; entryIndex += 1) {
        if (snapshotEntries[entryIndex] && snapshotEntries[entryIndex].key === key) {
          selectedPath = String(snapshotEntries[entryIndex].path || '');
          break;
        }
      }
      setDiffState(function (previous) {
        var previousValue = previous && previous.value ? previous.value : null;
        var previousEntry = previousValue && previousValue.entry ? previousValue.entry : null;
        var sameFile = !!previousEntry && !!selectedPath && String(previousEntry.path || '') === selectedPath;
        if (sameFile) {
          return { key: key, loading: true, error: null, value: previousValue };
        }
        return { key: key, loading: true, error: null, value: null };
      });
      var params = sessionId ? { sessionId: sessionId, key: key } : { key: key };
      state.runtime.rpc.call('diff', params, { signal: controller.signal }).then(function (value) {
        if (controller.signal.aborted || generation !== targetGenerationRef.current) return;
        setDiffState({ key: key, loading: false, error: null, value: value });
      }).catch(function (error) {
        if (controller.signal.aborted || (error && error.name === 'AbortError')) return;
        if (generation !== targetGenerationRef.current) return;
        setDiffState({ key: key, loading: false, error: error, value: null });
      });
      return function () {
        controller.abort();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, sessionId, selectedKey, diffNonce, snapshot && snapshot.repo && snapshot.repo.headSha, selectedDiffSignature]);

    /* A reloaded diff (or a changed selection) invalidates any open hunk menu:
     * its entry/fingerprint no longer describe what is on screen. */
    useEffect(function () {
      setMenu(null);
      if (diffRef.current && typeof diffRef.current.clearContext === 'function') diffRef.current.clearContext();
    }, [selectedKey, selectedDiffSignature, diffNonce]);

    // ---- notice auto dismiss ------------------------------------------------
    useEffect(function () {
      if (!notice) return undefined;
      var timer = setTimeout(function () {
        setNotice(null);
      }, NOTICE_TIMEOUT_MS);
      return function () {
        clearTimeout(timer);
      };
    }, [notice]);

    // ---- mutations ----------------------------------------------------------
    var mutate = useCallback(function (method, params, successText) {
      if (busyRef.current) return Promise.resolve(null);
      var rpc = state.runtime.rpc;
      if (!rpc) return Promise.resolve(null);
      var generation = targetGenerationRef.current;
      setBusy({ method: method });
      setOperationError(null);
      var payload = {};
      if (sessionId) payload.sessionId = sessionId;
      if (params) for (var name in params) if (Object.prototype.hasOwnProperty.call(params, name)) payload[name] = params[name];
      return rpc.call(method, payload).then(function (result) {
        if (generation !== targetGenerationRef.current) return result;
        /* The write result (and its fresh status) supersedes any read that was
         * already in flight when the write started. */
        refreshSeqRef.current += 1;
        if (result && result.status) applyStatus(result.status);
        else refresh({ silent: true, keepSelectionOnly: true });
        setDiffNonce(function (value) { return value + 1; });
        if (successText) setNotice({ tone: 'success', text: successText });
        return result;
      }).catch(function (error) {
        if (generation !== targetGenerationRef.current) return null;
        refreshSeqRef.current += 1;
        setOperationError({ code: error && error.code, message: describeError(error, tRef.current) });
        refresh({ silent: true, keepSelectionOnly: true });
        setDiffNonce(function (value) { return value + 1; });
        return null;
      }).then(function (result) {
        if (generation === targetGenerationRef.current) setBusy(null);
        return result;
      });
    }, [sessionId, applyStatus, refresh]);

    /* Stage/unstage always carry the fingerprints of the entries the user is
     * looking at; the host re-reads them and aborts with `entry/stale` when the
     * repository moved on between preview and write. */
    var stageKeys = useCallback(function (keys, successText) {
      var current = snapshotRef.current;
      var list = current && Array.isArray(current.entries) ? current.entries : [];
      return mutate('stage', { keys: keys, expected: expectedFingerprints(list, 'stage', keys) }, successText);
    }, [mutate]);

    var unstageKeys = useCallback(function (keys, successText) {
      var current = snapshotRef.current;
      var list = current && Array.isArray(current.entries) ? current.entries : [];
      return mutate('unstage', { keys: keys, expected: expectedFingerprints(list, 'unstage', keys) }, successText);
    }, [mutate]);

    /* Checkbox toggles are ordinary stage/unstage writes; they reuse the same
     * fingerprinted expectations as the bulk and single-file actions. A group
     * toggle skips conflicts (they can never be committed). */
    var toggleEntryStaged = useCallback(function (entry, next) {
      if (!entry || !entry.key) return Promise.resolve(null);
      return next ? stageKeys([entry.key], null) : unstageKeys([entry.key], null);
    }, [stageKeys, unstageKeys]);

    var toggleGroupStaged = useCallback(function (list, next) {
      var items = Array.isArray(list) ? list : [];
      var keys = [];
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        if (!item || !item.key || item.status === 'conflict') continue;
        if (next ? item.status !== 'staged' : item.status === 'staged') keys.push(item.key);
      }
      if (keys.length === 0) return Promise.resolve(null);
      return next ? stageKeys(keys, null) : unstageKeys(keys, null);
    }, [stageKeys, unstageKeys]);

    var runHunk = useCallback(function (method, entry, hunkIndex) {
      if (!entry) return Promise.resolve(null);
      var label = method === 'stageHunk' ? 'op.doneStageHunk' : method === 'unstageHunk' ? 'op.doneUnstageHunk' : 'op.doneDiscardHunk';
      return mutate(method, { key: entry.key, hunkIndex: hunkIndex, expected: entry.fingerprint }, tRef.current(label, {
        path: util.basename(entry.path),
        index: hunkIndex + 1,
      }));
    }, [mutate]);

    var runDiscard = useCallback(function (entry) {
      if (!entry) return Promise.resolve(null);
      return mutate('discard', { key: entry.key, expected: entry.fingerprint }, tRef.current('op.doneDiscard', { n: 1 }));
    }, [mutate]);

    // ---- grouping -----------------------------------------------------------
    var repoRoot = snapshot && snapshot.repo ? snapshot.repo.root : null;
    var entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
    var summary = (snapshot && snapshot.summary) || emptySummary();
    /* The host caps the displayed entry list (summary.truncated). The client
     * cannot preview the hidden part, so every whole-repository write is
     * disabled while this is true; per-file operations stay available. */
    var truncated = !!(snapshot && summary && summary.truncated === true);

    /* Group by a property staging cannot change: whether the path already
     * exists in the repository history. The row checkbox is the stage control,
     * so index-state groups re-bucketed the list under the pointer on every
     * click, and bulk checking collapsed two sections into one. "Untracked" is
     * not stable either: staging a new file makes it tracked immediately. A path
     * that is absent from HEAD stays in the new-files section for the whole
     * change set, staged or not; staged state stays visible on the row
     * checkbox, the summary and the commit drawer. Conflicts keep their own
     * section because they are never part of a commit. */
    var gitGroups = useMemo(function () {
      var newPaths = new Set();
      for (var scan = 0; scan < entries.length; scan += 1) {
        var scanned = entries[scan];
        if (scanned.status === 'untracked' || scanned.change === 'added' || scanned.change === 'copied') {
          newPaths.add(scanned.path);
        }
      }
      var tracked = [];
      var added = [];
      var conflicts = [];
      for (var index = 0; index < entries.length; index += 1) {
        var entry = entries[index];
        if (entry.status === 'conflict') conflicts.push(entry);
        else if (newPaths.has(entry.path)) added.push(entry);
        else tracked.push(entry);
      }
      var wanted = [
        { id: 'tracked', label: t('status.tracked'), tone: 'tracked', entries: tracked },
        { id: 'added', label: t('status.newFiles'), tone: 'untracked', entries: added },
        { id: 'conflict', label: t('status.conflict'), tone: 'conflict', entries: conflicts },
      ];
      return wanted.filter(function (group) { return group.entries.length > 0; });
    }, [entries, t]);

    var aiGroups = useMemo(function () {
      var pathGroups = aiState.pathGroups;
      if (!pathGroups || pathGroups.length === 0) return null;
      /* Entries are matched by path, not by key: staging a file rewrites its
       * key but not its path, so the previous grouping survives index changes
       * instead of collapsing into the "other" bucket. Both rows of a file that
       * is staged and modified again stay in the same category. */
      var byPath = new Map();
      for (var index = 0; index < entries.length; index += 1) {
        var path = String(entries[index].path || '');
        var bucket = byPath.get(path);
        if (bucket) bucket.push(entries[index]);
        else byPath.set(path, [entries[index]]);
      }
      var placed = new Set();
      var groups = [];
      for (var catIndex = 0; catIndex < pathGroups.length; catIndex += 1) {
        var category = pathGroups[catIndex];
        var paths = Array.isArray(category.paths) ? category.paths : [];
        var list = [];
        for (var at = 0; at < paths.length; at += 1) {
          var categoryPath = paths[at];
          if (placed.has(categoryPath)) continue;
          var matches = byPath.get(categoryPath);
          if (!matches || matches.length === 0) continue;
          placed.add(categoryPath);
          for (var matchIndex = 0; matchIndex < matches.length; matchIndex += 1) list.push(matches[matchIndex]);
        }
        if (list.length === 0) continue;
        groups.push({
          id: 'ai:' + String(category.name),
          label: String(category.name),
          description: category.description || '',
          /* Forward the Host's category kind: FileNav localizes the
           * non-functional bucket (`NON_FUNCTIONAL`) for logic grouping. */
          kind: category.kind === 'non-functional' ? 'non-functional' : '',
          tone: 'ai',
          entries: list,
        });
      }
      var rest = [];
      for (var index2 = 0; index2 < entries.length; index2 += 1) {
        if (!placed.has(String(entries[index2].path || ''))) rest.push(entries[index2]);
      }
      if (rest.length > 0) groups.push({ id: 'ai:other', label: t('nav.other'), tone: 'ai', entries: rest });
      return groups.length > 0 ? groups : null;
    }, [aiState.pathGroups, entries, t]);

    var groups = aiEnabled && aiGroups ? aiGroups : gitGroups;
    groupsRef.current = groups;

    // Filter by search.
    var visibleGroups = useMemo(function () {
      var needle = search.trim().toLowerCase();
      if (!needle) return groups;
      var result = [];
      for (var index = 0; index < groups.length; index += 1) {
        var group = groups[index];
        var list = group.entries.filter(function (entry) {
          return String(entry.path).toLowerCase().indexOf(needle) !== -1 ||
            (entry.oldPath && String(entry.oldPath).toLowerCase().indexOf(needle) !== -1);
        });
        if (list.length > 0) result.push({ id: group.id, label: group.label, tone: group.tone, entries: list, description: group.description, kind: group.kind });
      }
      return result;
    }, [groups, search]);

    var flatEntries = useMemo(function () {
      return flattenGroups(visibleGroups);
    }, [visibleGroups]);

    /* Scroll from source: expand the selected file's group, drop a search that
     * hides it, then ask FileNav to scroll it into view (the nonce re-runs the
     * row-scrolling effect even when the visible group list itself is stable). */
    var locateCurrentFile = useCallback(function () {
      if (!selectedKey) return;
      var groupId = groupIdForEntry(groups, selectedKey);
      if (groupId) {
        setCollapsedGroups(function (current) {
          if (!current || !current.has(groupId)) return current;
          var next = new Set(current);
          next.delete(groupId);
          return next;
        });
      }
      var visible = false;
      for (var index = 0; index < flatEntries.length; index += 1) {
        if (flatEntries[index] && flatEntries[index].key === selectedKey) {
          visible = true;
          break;
        }
      }
      if (!visible && search) setSearch('');
      setLocateNonce(function (value) { return value + 1; });
    }, [selectedKey, groups, flatEntries, search]);

    var selectedEntry = useMemo(function () {
      for (var index = 0; index < entries.length; index += 1) {
        if (entries[index].key === selectedKey) return entries[index];
      }
      return null;
    }, [entries, selectedKey]);

    var conflictCount = summary.conflicts || 0;

    // ---- selection ----------------------------------------------------------
    var selectEntry = useCallback(function (entry) {
      if (!entry) return;
      setSelectedKey(entry.key);
    }, []);

    var moveSelection = useCallback(function (delta) {
      if (flatEntries.length === 0) return;
      var currentIndex = -1;
      for (var index = 0; index < flatEntries.length; index += 1) {
        if (flatEntries[index].key === selectedKeyRef.current) { currentIndex = index; break; }
      }
      var nextIndex = currentIndex === -1 ? 0 : util.clamp(currentIndex + delta, 0, flatEntries.length - 1);
      var next = flatEntries[nextIndex];
      if (next) setSelectedKey(next.key);
    }, [flatEntries]);

    /** Keep DOM focus on the selected file row after keyboard navigation. */
    var focusSelectedRow = useCallback(function () {
      if (typeof requestAnimationFrame !== 'function') return;
      requestAnimationFrame(function () {
        var node = navScrollRef.current;
        if (!node || typeof node.querySelector !== 'function') return;
        var row = node.querySelector('[role="option"][aria-selected="true"]');
        if (!row || typeof row.focus !== 'function') return;
        if (typeof document !== 'undefined' && document.activeElement === row) return;
        try {
          row.focus({ preventScroll: true });
        } catch (error) {
          row.focus();
        }
      });
    }, []);

    var navigateSelection = useCallback(function (delta) {
      moveSelection(delta);
      focusSelectedRow();
    }, [moveSelection, focusSelectedRow]);

    var navigateEdge = useCallback(function (edge) {
      if (flatEntries.length === 0) return;
      var next = edge === 'home' ? flatEntries[0] : flatEntries[flatEntries.length - 1];
      if (next) setSelectedKey(next.key);
      focusSelectedRow();
    }, [flatEntries, focusSelectedRow]);

    // ---- AI grouping --------------------------------------------------------
    /* Path-level signature: staging never changes it (see aiEntriesSignature). */
    var entriesSignature = useMemo(function () {
      return aiEntriesSignature(entries);
    }, [entries]);

    var cancelAiRequest = useCallback(function () {
      var ref = aiRequestRef.current;
      if (ref.timer !== null) {
        clearTimeout(ref.timer);
        ref.timer = null;
      }
      var requestId = ref.id;
      if (ref.controller) {
        ref.controller.abort();
        ref.controller = null;
      }
      ref.id = null;
      ref.signature = null;
      if (requestId && state.runtime.rpc) {
        /* Aborting the browser fetch alone only drops the response; the host
         * would keep streaming and spending tokens. Tell it to abort too. */
        state.runtime.rpc.call('classifyCancel', { requestId: requestId }).catch(function () {});
      }
    }, []);

    var requestAi = useCallback(function (options) {
      var force = !!(options && options.force);
      var rpc = state.runtime.rpc;
      if (!rpc) return;
      var current = snapshotRef.current;
      if (!current || !current.repo) return;
      var list = Array.isArray(current.entries) ? current.entries : [];
      if (list.length === 0) return;
      cancelAiRequest();
      var generation = targetGenerationRef.current;
      var requestId = util.uid('classify');
      /* Snapshot the mode: the reply is only valid for the mode it was
       * requested in. The host applies the same explicit mode. */
      var requestedGrouping = aiGroupingRef.current;
      var controller = new AbortController();
      /* Only entry keys are sent: the host re-reads every piece of metadata and
       * the excerpts from the real repository state. Keep the key→path table of
       * this snapshot so the result's keys can be converted back to paths — the
       * keys of a file change when it is staged, its path does not. */
      var payloadEntries = [];
      var keyPaths = {};
      for (var index = 0; index < list.length; index += 1) {
        if (list[index] && typeof list[index].key === 'string') {
          payloadEntries.push({ key: list[index].key });
          if (list[index].path) keyPaths[list[index].key] = String(list[index].path);
        }
      }
      aiRequestRef.current = { id: requestId, signature: entriesSignature, controller: controller, timer: null };
      setAiState(function (currentState) {
        return { signature: currentState.signature, result: currentState.result, pathGroups: currentState.pathGroups, loading: true, error: null, notice: null, model: currentState.model };
      });
      var params = { requestId: requestId, entries: payloadEntries, grouping: requestedGrouping };
      if (sessionId) params.sessionId = sessionId;
      if (force) params.force = true;
      rpc.call('classify', params, { signal: controller.signal }).then(function (value) {
        if (generation !== targetGenerationRef.current) return;
        if (aiRequestRef.current.id !== requestId || controller.signal.aborted) return;
        /* A reply only describes the grouping mode it was requested for. When
         * the user switched modes while it streamed, painting it would mix two
         * different groupings on screen: drop it (the mode-change effect below
         * already cancelled the request and reset the display). */
        var activeGrouping = aiGroupingRef.current;
        var responseGrouping = value && (value.grouping === 'role' || value.grouping === 'logic')
          ? value.grouping
          : requestedGrouping;
        if (requestedGrouping !== activeGrouping || responseGrouping !== activeGrouping) return;
        var latest = snapshotRef.current;
        if (!latest || !latest.repo || latest.repo.root !== (value && value.repo ? value.repo.root : null)) {
          cancelAiRequest();
          return;
        }
        setAiState({
          signature: aiRequestRef.current.signature,
          result: value,
          pathGroups: aiPathGroups(value, keyPaths),
          loading: false,
          error: null,
          notice: value && value.cached ? 'cache' : null,
          model: value && value.model ? value.model : null,
        });
      }).catch(function (error) {
        if (generation !== targetGenerationRef.current) return;
        /* A superseded request owns no state: the newer request owns `loading`. */
        if (aiRequestRef.current.id !== requestId) return;
        if (error && (error.name === 'AbortError' || error.code === 'ai/aborted')) {
          /* Cancelled (replace / toggle off / panel close): always clear loading. */
          setAiState(function (currentState) {
            return {
              signature: currentState.signature,
              result: currentState.result,
              pathGroups: currentState.pathGroups,
              loading: false,
              error: null,
              notice: null,
              model: currentState.model,
            };
          });
          return;
        }
        setAiState({
          signature: aiRequestRef.current.signature,
          result: null,
          pathGroups: null,
          loading: false,
          error: error || new Error('classify failed'),
          notice: 'fallback',
          model: null,
        });
      }).then(function () {
        if (aiRequestRef.current.id === requestId) aiRequestRef.current.controller = null;
      });
    }, [cancelAiRequest, entriesSignature, sessionId]);

    /* Role and logic grouping produce different categories, so switching the
     * mode invalidates everything the previous mode produced: cancel the
     * in-flight request and drop the rendered result / notice instead of
     * painting categories from two modes. The auto-request effect below re-runs
     * (its deps include aiGrouping) and debounces a fresh request with the new
     * mode. */
    var previousGroupingRef = useRef(aiGrouping);
    useEffect(function () {
      if (!aiEnabled) {
        /* The persisted mode may change while AI grouping is off; remember it
         * so enabling AI with that mode does not look like a mode switch. */
        previousGroupingRef.current = aiGrouping;
        return;
      }
      if (previousGroupingRef.current === aiGrouping) return;
      previousGroupingRef.current = aiGrouping;
      cancelAiRequest();
      setAiState({ signature: null, result: null, pathGroups: null, loading: false, error: null, notice: null, model: null });
    }, [aiEnabled, aiGrouping, cancelAiRequest]);

    // Turning AI grouping off, or switching repository, drops any pending result.
    useEffect(function () {
      if (!aiEnabled) {
        cancelAiRequest();
        setAiState({ signature: null, result: null, pathGroups: null, loading: false, error: null, notice: null, model: null });
        return;
      }
      if (!repoRoot) return;
      if (aiState.result && aiState.result.repo && aiState.result.repo.root && aiState.result.repo.root !== repoRoot) {
        cancelAiRequest();
        setAiState({ signature: null, result: null, pathGroups: null, loading: false, error: null, notice: null, model: null });
        return;
      }
      if (!open) return;
      if (entries.length === 0) {
        /* Nothing left to classify (e.g. the user just committed everything).
         * The previous result's signature can never match an empty change set,
         * so keeping it would pin the "AI grouping is refreshing…" chip forever:
         * this branch used to just return, leaving that stale notice on screen. */
        var aiSettled = !aiState.result && !aiState.loading && !aiState.signature && !aiState.error && !aiState.notice;
        if (aiSettled) return;
        cancelAiRequest();
        setAiState({ signature: null, result: null, pathGroups: null, loading: false, error: null, notice: null, model: null });
        return;
      }
      if (aiState.loading && aiRequestRef.current.id !== null) return;
      /* A failed request must not auto-retry: every retry spends model tokens and
       * the failure is already visible. Retry when the entries change or the user
       * presses "重新归类"/toggles AI again. */
      if (aiState.notice === 'fallback' && aiState.signature === entriesSignature) return;
      if (aiState.signature === entriesSignature && aiState.result) return;
      var timer = setTimeout(function () {
        requestAi({});
      }, AI_DEBOUNCE_MS);
      aiRequestRef.current.timer = timer;
      return function () {
        if (aiRequestRef.current.timer === timer) {
          clearTimeout(aiRequestRef.current.timer);
          aiRequestRef.current.timer = null;
        }
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [aiEnabled, aiGrouping, open, repoRoot, entriesSignature, entries.length, aiState.signature, aiState.result]);

    useEffect(function () {
      return function () {
        cancelAiRequest();
      };
    }, [cancelAiRequest]);

    // ---- commit / push ------------------------------------------------------
    /* The commit mode chosen in the drawer's split control is persisted next to
     * the other plugin settings; the main half of the control runs it. The
     * one-click AI·commit+push action lives in the top toolbar instead: it must
     * be reachable without expanding the drawer and is not a persisted mode. */
    var commitMode = commitModeOf(settingsSnapshot.value.commitMode);

    var pushDisabledReason = '';
    if (!snapshot || !snapshot.repo) pushDisabledReason = t('reason.noRepo');
    else if (!snapshot.repo.remotes || snapshot.repo.remotes.length === 0) pushDisabledReason = t('reason.noRemote');
    else if (snapshot.repo.detached) pushDisabledReason = t('reason.detached');

    var stagedEntries = useMemo(function () {
      return entries.filter(function (entry) { return entry.status === 'staged'; });
    }, [entries]);

    /* Guards shared by the drawer commit split and the toolbar AI action: the
     * commit set must be previewable and the index must hold something. */
    var commitBaseReasons = [];
    if (truncated) commitBaseReasons.push(t('reason.truncated'));
    if (conflictCount > 0) commitBaseReasons.push(t('commit.conflictBlocked'));
    if (stagedEntries.length === 0) commitBaseReasons.push(t('commit.nothingChecked'));

    /* Drawer modes commit the editable message; '提交并推送' also pushes without
     * opening the push dialog, so a missing remote / detached HEAD must block it
     * up front instead of failing after the commit. */
    var commitReasons = commitBaseReasons.slice();
    if (commitMessage.trim().length === 0) commitReasons.push(t('commit.messageRequired'));
    if (commitMode === 'commitPush' && pushDisabledReason) commitReasons.push(pushDisabledReason);

    var canCommit = commitBaseReasons.length === 0
      && commitMessage.trim().length > 0
      && (commitMode === 'commit' || !pushDisabledReason);

    /* The toolbar AI action drafts its own message, so it needs neither the
     * drawer nor a typed message; it does need a usable push target. */
    var aiCommitReasons = commitBaseReasons.slice();
    if (pushDisabledReason) aiCommitReasons.push(pushDisabledReason);
    var canAiCommitPush = aiCommitReasons.length === 0;
    var aiCommitBusy = commitBusy || commitGenerating;
    var aiCommitDisabledReason = commitBusy
      ? t('commit.running')
      : commitGenerating
        ? t('commit.generating')
        : (aiCommitReasons[0] || null);
    /* The AI draft action in the drawer only needs staged content: the message
     * field may be empty (that is the point) and the user can still edit the
     * draft. Its tooltip is the action name only — no reason breakdown. */
    var canGenerate = !truncated && conflictCount === 0 && stagedEntries.length > 0;

    /* AI commit-message draft: an explicit, read-only action. Aborting the
     * browser fetch only drops the response, so the Host request is cancelled
     * explicitly (same contract as classifyCancel); the draft is discarded when
     * the drawer closes, the window unmounts or a newer request replaces it. */
    var abortCommitGeneration = useCallback(function () {
      var ref = commitGenerateRef.current;
      if (ref.controller) {
        ref.controller.abort();
        ref.controller = null;
      }
      var requestId = ref.id;
      ref.id = null;
      if (requestId && state.runtime.rpc) {
        state.runtime.rpc.call('commitMessageCancel', { requestId: requestId }).catch(function () {});
      }
    }, []);

    var cancelCommitGeneration = useCallback(function () {
      abortCommitGeneration();
      setCommitGenerating(false);
    }, [abortCommitGeneration]);

    /* Shared AI draft request used by the drawer's draft button and by the
     * AI·commit+push toolbar action. One in-flight request at a time; resolves
     * with the plain-text message or rejects with the host error (an aborted or
     * superseded request rejects with an AbortError). */
    var requestCommitMessage = useCallback(function () {
      var rpc = state.runtime.rpc;
      if (!rpc) return Promise.reject(new Error('rpc unavailable'));
      var current = snapshotRef.current;
      if (!current || !current.repo) return Promise.reject(new Error('repository missing'));
      var summary = current.summary || {};
      var list = Array.isArray(current.entries) ? current.entries : [];
      var stagedCount = 0;
      for (var index = 0; index < list.length; index += 1) {
        if (list[index] && list[index].status === 'staged') stagedCount += 1;
      }
      /* Re-check the same guards the action uses against the live snapshot: a
       * reply for a change set the user already refreshed away is useless. */
      if (summary.truncated || (summary.conflicts || 0) > 0 || stagedCount === 0) {
        return Promise.reject({ code: 'message/no-staged' });
      }
      abortCommitGeneration();
      var generation = targetGenerationRef.current;
      var requestId = util.uid('message');
      var controller = new AbortController();
      commitGenerateRef.current = { id: requestId, controller: controller };
      setCommitGenerating(true);
      setCommitError(null);
      var params = { requestId: requestId };
      if (sessionId) params.sessionId = sessionId;
      return rpc.call('commitMessage', params, { signal: controller.signal }).then(function (value) {
        if (generation !== targetGenerationRef.current
          || commitGenerateRef.current.id !== requestId
          || controller.signal.aborted) {
          var superseded = new Error('commit message request superseded');
          superseded.name = 'AbortError';
          throw superseded;
        }
        commitGenerateRef.current = { id: null, controller: null };
        setCommitGenerating(false);
        var message = value && typeof value.message === 'string' ? value.message : '';
        if (message.trim().length === 0) throw { code: 'message/invalid' };
        return message;
      }).catch(function (error) {
        if (commitGenerateRef.current.id === requestId) {
          commitGenerateRef.current = { id: null, controller: null };
          setCommitGenerating(false);
        }
        throw error;
      });
    }, [abortCommitGeneration, sessionId]);

    var generateCommitMessage = useCallback(function () {
      if (commitBusyRef.current || commitGenerateRef.current.id !== null) return;
      requestCommitMessage().then(function (message) {
        setCommitMessage(message);
        setCommitStale(false);
      }).catch(function (error) {
        if (!error || error.name === 'AbortError' || error.code === 'message/aborted') return;
        if (error.code === 'message/invalid') {
          setCommitError({ message: tRef.current('error.messageInvalid') });
          return;
        }
        setCommitError({ message: describeError(error, tRef.current) });
      });
    }, [requestCommitMessage]);

    /* Closing the review window must not leave a token-burning request behind. */
    useEffect(function () {
      return function () {
        abortCommitGeneration();
      };
    }, [abortCommitGeneration]);

    /* The drawer is collapsed by default; opening it re-reads the staged scope
     * so the commit expectation still reflects the current index. */
    var toggleCommitPanel = useCallback(function () {
      var next = !commitOpen;
      setCommitOpen(next);
      if (!next) {
        cancelCommitGeneration();
        return;
      }
      setCommitError(null);
      setCommitStale(false);
      refresh({ silent: true, keepSelectionOnly: true });
    }, [commitOpen, refresh, cancelCommitGeneration]);

    /* Surface a failed commit in the drawer: with the action in the toolbar the
     * drawer may be collapsed, and the error / stale notice lives there. */
    var showCommitFailure = useCallback(function (error) {
      var code = error && error.code;
      if (code === 'commit/stale') {
        setCommitStale(true);
        setCommitError(null);
        setCommitOpen(true);
        refresh({ silent: true, keepSelectionOnly: true });
        return;
      }
      if (code === 'commit/conflict-pending') {
        setCommitError({ message: tRef.current('commit.conflictBlocked') });
      } else if (code === 'commit/failed') {
        /* Hook / signing output is diagnosed content the user needs; the
         * surrounding sentence stays localized and the raw host message is not
         * shown. */
        var details = (error && error.details) || {};
        var output = String(details.hookOutput || details.stderr || '').trim();
        var failure = tRef.current('error.commitFailed');
        setCommitError({ message: output.length > 0 ? failure + '\n\n' + output : failure });
      } else {
        setCommitError({ message: describeError(error, tRef.current) });
      }
      setCommitOpen(true);
      refresh({ silent: true, keepSelectionOnly: true });
    }, [refresh]);

    /* One action shared by the drawer's commit split and the toolbar's
     * AI·commit+push button. Drawer modes: 'commit' commits the checked
     * snapshot; 'commitPush' also pushes to the current branch's upstream
     * without opening the push dialog. 'aiCommitPush' (toolbar only) drafts the
     * message with AI first, then commits and pushes. Every write still goes
     * through the host write chain with the same stale fingerprint guard. */
    var runCommit = useCallback(function (modeOverride) {
      var mode = modeOverride === 'aiCommitPush' ? 'aiCommitPush' : commitMode;
      var ready = mode === 'aiCommitPush' ? canAiCommitPush : canCommit;
      if (!ready || commitBusyRef.current || commitGenerateRef.current.id !== null) return;
      var rpc = state.runtime.rpc;
      if (!rpc) return;
      var expected = commitExpectation(snapshotRef.current);
      if (!expected) {
        setCommitError({ message: tRef.current('state.repoMissing') });
        setCommitOpen(true);
        return;
      }
      var generation = targetGenerationRef.current;
      setCommitBusy(true);
      setCommitError(null);
      setOperationError(null);
      var messagePromise = mode === 'aiCommitPush' ? requestCommitMessage() : Promise.resolve(commitMessage);
      messagePromise.then(function (message) {
        if (generation !== targetGenerationRef.current) return null;
        if (mode === 'aiCommitPush') setCommitMessage(message);
        var params = { message: message, expected: expected };
        if (sessionId) params.sessionId = sessionId;
        return rpc.call('commit', params).then(function (result) {
          if (generation !== targetGenerationRef.current) return null;
          refreshSeqRef.current += 1;
          setCommitMessage('');
          setCommitStale(false);
          setCommitOpen(false);
          if (result && result.status) applyStatus(result.status);
          setDiffNonce(function (value) { return value + 1; });
          if (mode === 'commit') {
            setNotice({
              tone: 'success',
              text: tRef.current('commit.success', { sha: result.shortSha, summary: result.summary }),
            });
            return null;
          }
          /* One-click push: no dialog. The host resolves the current branch and
           * its upstream (the default remote and the same branch name on a first
           * push); setUpstream keeps the branch tracking the ref it pushed to. */
          var pushParams = { setUpstream: true };
          if (sessionId) pushParams.sessionId = sessionId;
          return rpc.call('push', pushParams).then(function (pushed) {
            if (generation !== targetGenerationRef.current) return null;
            if (pushed && pushed.status) applyStatus(pushed.status);
            setNotice({
              tone: 'success',
              text: tRef.current('commit.pushSuccess', {
                sha: result.shortSha,
                remote: String((pushed && pushed.remote) || ''),
                branch: String((pushed && (pushed.targetBranch || pushed.branch)) || ''),
              }),
            });
            return null;
          }).catch(function (error) {
            if (generation !== targetGenerationRef.current) return null;
            refreshSeqRef.current += 1;
            setOperationError({
              code: error && error.code,
              message: tRef.current('commit.pushAfterCommitFailed', {
                reason: describeError(error, tRef.current),
              }),
            });
            refresh({ silent: true, keepSelectionOnly: true });
            return null;
          });
        });
      }).catch(function (error) {
        if (generation !== targetGenerationRef.current) return null;
        if (!error || error.name === 'AbortError' || error.code === 'message/aborted') return null;
        refreshSeqRef.current += 1;
        showCommitFailure(error);
        return null;
      }).then(function () {
        if (generation === targetGenerationRef.current) setCommitBusy(false);
      });
    }, [canAiCommitPush, canCommit, commitMessage, commitMode, sessionId, requestCommitMessage, applyStatus, refresh, showCommitFailure]);

    /* Push preview: the host compares against the remote-tracking ref of the
     * selected remote/target and returns the read-only local source branch, the
     * editable target branch and the commits that would be pushed. Changing the
     * remote or target re-requests the preview with those parameters. */
    var refreshPushPreview = useCallback(function (options) {
      var opts = options || {};
      var rpc = state.runtime.rpc;
      if (!rpc) return Promise.resolve(null);
      var current = pushStateRef.current || {};
      var remote = opts.remote !== undefined ? String(opts.remote) : String(current.remote || '');
      var target = opts.target !== undefined ? String(opts.target) : String(current.target || '');
      var generation = targetGenerationRef.current;
      var seq = ++pushPreviewSeqRef.current;
      setPushState(function (state) {
        return {
          open: true,
          preview: state && state.open ? state.preview : null,
          loading: true,
          error: null,
          busy: !!(state && state.busy),
          remote: remote,
          target: target,
        };
      });
      var params = sessionId ? { sessionId: sessionId } : {};
      if (remote) params.remote = remote;
      if (target) params.targetBranch = target;
      return rpc.call('pushPreview', params).then(function (preview) {
        if (generation !== targetGenerationRef.current || seq !== pushPreviewSeqRef.current) return null;
        var defaults = pushDefaults(preview, remote, target);
        setPushState({
          open: true,
          preview: preview,
          loading: false,
          error: null,
          busy: false,
          remote: defaults.remote,
          target: defaults.target,
        });
        return preview;
      }).catch(function (error) {
        if (generation !== targetGenerationRef.current || seq !== pushPreviewSeqRef.current) return null;
        /* Failed preview: keep an explicit error state so the dialog can show
         * the localized message plus a retry button instead of a spinner. */
        setPushState({
          open: true,
          preview: null,
          loading: false,
          error: error || new Error('pushPreview failed'),
          busy: false,
          remote: remote,
          target: target,
        });
        return null;
      });
    }, [sessionId]);

    var schedulePushPreview = useCallback(function (remote, target) {
      if (pushPreviewTimerRef.current !== null) clearTimeout(pushPreviewTimerRef.current);
      pushPreviewTimerRef.current = setTimeout(function () {
        pushPreviewTimerRef.current = null;
        refreshPushPreview({ remote: remote, target: target });
      }, 300);
    }, [refreshPushPreview]);

    var closePush = useCallback(function () {
      if (pushBusyRef.current) return;
      if (pushPreviewTimerRef.current !== null) {
        clearTimeout(pushPreviewTimerRef.current);
        pushPreviewTimerRef.current = null;
      }
      pushPreviewSeqRef.current += 1;
      setPushState({ open: false, preview: null, loading: false, error: null, busy: false, remote: '', target: '' });
    }, []);

    // ---- remote configuration ----------------------------------------------
    var openRemoteSettings = useCallback(function () {
      var current = snapshotRef.current;
      var remotes = current && current.repo && Array.isArray(current.repo.remotes) ? current.repo.remotes : [];
      var preferred = null;
      for (var index = 0; index < remotes.length; index += 1) {
        if (remotes[index] && remotes[index].name === 'origin') { preferred = remotes[index]; break; }
      }
      if (preferred === null && remotes.length > 0) preferred = remotes[0];
      setRemoteState({
        open: true,
        name: preferred ? String(preferred.name) : 'origin',
        url: preferred ? String(preferred.url || '') : '',
        busy: false,
        error: null,
      });
    }, []);

    var closeRemoteSettings = useCallback(function () {
      if (remoteStateRef.current.busy) return;
      setRemoteState(function (current) {
        return { open: false, name: current.name, url: current.url, busy: false, error: null };
      });
    }, []);

    var submitRemote = useCallback(function () {
      var rpc = state.runtime.rpc;
      var current = remoteStateRef.current;
      if (!rpc || !current || current.busy) return;
      var name = String(current.name || '').trim();
      var url = String(current.url || '').trim();
      if (!name || !url) return;
      var generation = targetGenerationRef.current;
      var params = { name: name, url: url };
      if (sessionId) params.sessionId = sessionId;
      else if (target && target.cwd) params.cwd = target.cwd;
      setRemoteState(function (previous) {
        return { open: previous.open, name: previous.name, url: previous.url, busy: true, error: null };
      });
      rpc.call('remoteSet', params).then(function (result) {
        if (generation !== targetGenerationRef.current) return;
        refreshSeqRef.current += 1;
        if (result && result.status) applyStatus(result.status);
        else refresh({ silent: true, keepSelectionOnly: true });
        setRemoteState({ open: false, name: name, url: url, busy: false, error: null });
        setNotice({ tone: 'success', text: tRef.current('remote.saved', { name: name }) });
      }).catch(function (error) {
        if (generation !== targetGenerationRef.current) return;
        refreshSeqRef.current += 1;
        setRemoteState(function (previous) {
          return {
            open: previous.open,
            name: previous.name,
            url: previous.url,
            busy: false,
            error: error || new Error('remote set failed'),
          };
        });
        refresh({ silent: true, keepSelectionOnly: true });
      });
    }, [sessionId, target && target.cwd, applyStatus, refresh]);

    useEffect(function () {
      return function () {
        if (pushPreviewTimerRef.current !== null) {
          clearTimeout(pushPreviewTimerRef.current);
          pushPreviewTimerRef.current = null;
        }
      };
    }, []);

    var openPush = useCallback(function () {
      if (!state.runtime.rpc) return;
      setPushState({ open: true, preview: null, loading: true, error: null, busy: false, remote: '', target: '' });
      refreshPushPreview({ remote: '', target: '' });
    }, [refreshPushPreview]);

    var submitPush = useCallback(function (selection) {
      var rpc = state.runtime.rpc;
      if (!rpc) return;
      var chosen = selection && typeof selection === 'object' ? selection : {};
      var current = pushStateRef.current || {};
      if (current.busy) return;
      var remote = chosen.remote !== undefined ? String(chosen.remote) : String(current.remote || '');
      var target = chosen.target !== undefined ? String(chosen.target) : String(current.target || '');
      var setUpstream = chosen.setUpstream !== undefined
        ? chosen.setUpstream === true
        : !(current.preview && current.preview.upstream);
      var generation = targetGenerationRef.current;
      setPushState(function (state) {
        return {
          open: true,
          preview: state.preview,
          loading: state.loading,
          error: null,
          busy: true,
          remote: remote,
          target: target,
        };
      });
      var params = {};
      if (sessionId) params.sessionId = sessionId;
      if (remote) params.remote = remote;
      if (target) params.targetBranch = target;
      if (setUpstream) params.setUpstream = true;
      rpc.call('push', params).then(function (result) {
        if (generation !== targetGenerationRef.current) return;
        pushPreviewSeqRef.current += 1;
        if (pushPreviewTimerRef.current !== null) {
          clearTimeout(pushPreviewTimerRef.current);
          pushPreviewTimerRef.current = null;
        }
        setPushState({ open: false, preview: null, loading: false, error: null, busy: false, remote: '', target: '' });
        if (result && result.status) applyStatus(result.status);
        setNotice({
          tone: 'success',
          text: tRef.current('push.success', {
            remote: result && result.remote ? result.remote : remote,
            branch: result && (result.targetBranch || result.branch) ? (result.targetBranch || result.branch) : target,
          }),
        });
      }).catch(function (error) {
        if (generation !== targetGenerationRef.current) return;
        setPushState(function (state) {
          return {
            open: true,
            preview: state.preview,
            loading: state.loading,
            error: error || new Error('push failed'),
            busy: false,
            remote: remote,
            target: target,
          };
        });
      });
    }, [sessionId, applyStatus]);

    // ---- context menus ------------------------------------------------------
    /* Shared clipboard write: used by the file-row menu and the branch chip
     * popover. Failures stay silent — the action is a convenience, not state. */
    var copyText = useCallback(function (value) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(String(value)).then(function () {
            setNotice({ tone: 'success', text: t('common.copied') });
          }, function () {});
        }
      } catch (error) {
        /* clipboard may be unavailable */
      }
    }, [t]);

    var closeMenu = useCallback(function () {
      setMenu(null);
      if (diffRef.current && typeof diffRef.current.clearContext === 'function') diffRef.current.clearContext();
    }, []);

    var openEntryMenu = useCallback(function (event, entry) {
      if (!entry) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      var x = event && Number.isFinite(event.clientX) ? event.clientX : 0;
      var y = event && Number.isFinite(event.clientY) ? event.clientY : 0;
      if (x === 0 && y === 0 && event && event.currentTarget && event.currentTarget.getBoundingClientRect) {
        var rect = event.currentTarget.getBoundingClientRect();
        x = rect.left + Math.min(40, rect.width / 2);
        y = rect.top + Math.min(20, rect.height / 2);
      }
      var items = [];
      if (fileOpenAvailable) {
        items.push({ id: 'open-file', label: t('open.openFile'), icon: h(components.IconExternal, { size: components.ICON_SIZE.md }) });
        items.push({ id: 'reveal-file', label: t('open.reveal'), icon: h(components.IconLocateSource, { size: components.ICON_SIZE.md }) });
        items.push({ separator: true });
      }
      if (entry.status === 'untracked') {
        items.push({ id: 'stage', label: t('menu.stageFile') });
      } else if (entry.status === 'staged') {
        items.push({ id: 'unstage', label: t('menu.unstageFile') });
      } else if (entry.status === 'unstaged') {
        items.push({ id: 'stage', label: t('menu.stageFile') });
        items.push({ id: 'discard', label: t('menu.discardFile'), danger: true });
      } else if (entry.status === 'conflict') {
        items.push({ id: 'conflict-hint', label: t('diff.unsupportedConflict'), disabled: true });
      }
      items.push({ separator: true });
      items.push({ id: 'copy', label: t('menu.copyPath') });
      setMenu({
        open: true,
        x: x,
        y: y,
        header: t('menu.target', { path: entry.path }),
        items: items,
        entry: entry,
      });
    }, [t, fileOpenAvailable]);

    var onMenuSelect = useCallback(function (id) {
      var current = menu;
      closeMenu();
      if (!current || !current.entry) return;
      var entry = current.entry;
      if (id === 'open-file') { openRepoFile(entry, 'open'); return; }
      if (id === 'reveal-file') { openRepoFile(entry, 'reveal'); return; }
      if (id === 'stage') stageKeys([entry.key], t('op.doneStage', { n: 1 }));
      else if (id === 'unstage') unstageKeys([entry.key], t('op.doneUnstage', { n: 1 }));
      else if (id === 'discard') {
        setConfirm({
          open: true,
          title: t('discard.title'),
          body: t('discard.body', { path: entry.path }) + ' ' + t('discard.keepStaged'),
          confirmLabel: t('discard.confirm'),
          tone: 'danger',
          onConfirm: function () {
            setConfirm(null);
            runDiscard(entry);
          },
        });
      } else if (id === 'copy') copyText(entry.path);
    }, [menu, closeMenu, stageKeys, unstageKeys, runDiscard, openRepoFile, copyText]);

    var openHunkMenu = useCallback(function (hunkIndex, hunk, position) {
      /* Bind the menu to the entry of the diff that is actually on screen, not
       * to the latest snapshot: its fingerprint + hunk index must come from the
       * same version the user reviewed, or the host could validate a newly
       * changed hunk the user never saw. */
      var displayed = diffStateRef.current && diffStateRef.current.value ? diffStateRef.current.value : null;
      if (!displayed || !displayed.entry) return;
      var entry = displayed.entry;
      if (entry.key !== selectedKeyRef.current) return;
      if (entry.status === 'conflict') {
        setMenu({ open: true, x: position.x, y: position.y, header: entry.path, items: [{ id: 'noop', label: t('hunk.unavailable'), disabled: true }], entry: entry });
        return;
      }
      var items = [];
      if (entry.status === 'unstaged') {
        items.push({ id: 'stage-hunk', label: t('hunk.stage'), title: t('hunk.stageHint') });
        items.push({ id: 'discard-hunk', label: t('hunk.discard'), title: t('hunk.discardHint'), danger: true });
      } else if (entry.status === 'staged') {
        items.push({ id: 'unstage-hunk', label: t('hunk.unstage'), title: t('hunk.unstageHint') });
      } else {
        items.push({ id: 'noop', label: t('hunk.unavailable'), disabled: true });
      }
      setMenu({
        open: true,
        x: position.x,
        y: position.y,
        header: entry.path + ' · ' + t('hunk.label', { index: hunkIndex + 1 }),
        items: items,
        entry: entry,
        hunkIndex: hunkIndex,
      });
    }, [t]);

    var onHunkMenuSelect = useCallback(function (id) {
      var current = menu;
      closeMenu();
      if (!current) return;
      var entry = current.entry;
      var hunkIndex = current.hunkIndex;
      if (!entry || !Number.isInteger(hunkIndex)) return;
      if (id === 'stage-hunk') runHunk('stageHunk', entry, hunkIndex);
      else if (id === 'unstage-hunk') runHunk('unstageHunk', entry, hunkIndex);
      else if (id === 'discard-hunk') {
        setConfirm({
          open: true,
          title: t('discard.title'),
          body: t('discard.bodyHunk', { path: entry.path, index: hunkIndex + 1 }) + ' ' + t('discard.keepStaged'),
          confirmLabel: t('discard.confirm'),
          tone: 'danger',
          onConfirm: function () {
            setConfirm(null);
            runHunk('discardHunk', entry, hunkIndex);
          },
        });
      }
    }, [menu, closeMenu, runHunk, t]);

    // ---- top bar actions ----------------------------------------------------
    // ---- settings dialog ----------------------------------------------------
    var closePanelSettings = useCallback(function () {
      setPanelSettingsOpen(false);
    }, []);

    var loadModels = useCallback(function () {
      var rpc = state.runtime.rpc;
      if (!rpc) return Promise.resolve(null);
      var generation = targetGenerationRef.current;
      // The session id makes the model list / labels default to the model this
      // conversation actually runs on (host falls back to the DSH default).
      var params = sessionId ? { sessionId: sessionId } : {};
      setModelsLoading(true);
      setModelsError(null);
      return rpc.call('models', params).then(function (value) {
        if (generation !== targetGenerationRef.current) return null;
        setModelsInfo(value);
        setModelsLoading(false);
        return value;
      }).catch(function (error) {
        if (generation !== targetGenerationRef.current) return null;
        setModelsLoading(false);
        setModelsError(error || new Error('models failed'));
        return null;
      });
    }, [sessionId]);

    var openPanelSettings = useCallback(function () {
      setPanelSettingsOpen(true);
      loadModels();
      var rpc = state.runtime.rpc;
      if (!rpc) return;
      var seq = ++settingsSeq;
      var generation = targetGenerationRef.current;
      var params = sessionId ? { sessionId: sessionId } : {};
      rpc.call('settingsGet', params).then(function (value) {
        if (generation !== targetGenerationRef.current || seq !== settingsSeq) return;
        state.settingsStore.set(function (current) {
          return {
            loaded: true,
            saving: false,
            error: null,
            value: pickSettingsValue(value),
            locale: value && (value.locale === 'zh' || value.locale === 'en') ? value.locale : current.locale,
            model: value && value.model ? value.model : null,
          };
        });
      }).catch(function () {
        /* keep the cached settings */
      });
    }, [sessionId, loadModels]);

    /* Bulk staging now rides on the FileNav header's tri-state select-all, which
     * writes through the same fingerprinted checkbox path as rows and groups. It
     * is still a global write, so a truncated list or a running write disables
     * it with an explicit reason instead of guessing at hidden entries. */
    var selectAllDisabledReason = truncated
      ? t('reason.truncated')
      : (busy ? t('reason.busy') : '');

    // ---- keyboard -----------------------------------------------------------
    /* The listener is attached to this window's DOM node, not to the document:
     * shortcuts must never leak into the DSH composer behind the window, and a
     * second window has its own listener. Esc only closes the topmost layer
     * inside the window; the window itself is closed manually (its close
     * button) and Esc must keep working for DSH outside the window. */
    useEffect(function () {
      if (!open) return undefined;
      var root = props.windowRef && props.windowRef.current;
      if (!root || typeof root.addEventListener !== 'function') return undefined;
      var onKeyDown = function (event) {
        if (event.defaultPrevented) return;
        var eventTarget = event.target;
        var inDiffRow = eventTarget && typeof eventTarget.closest === 'function'
          ? eventTarget.closest('[data-row]')
          : null;
        // An open custom dropdown consumes Escape itself (close the menu, not
        // the settings dialog); the select handler runs later in the bubbling
        // phase, so the capture listener must step aside here. Modal's dialog
        // handler also defers via components.dialogEscapeDeferred.
        if (event.key === 'Escape' && eventTarget && eventTarget.closest
          && eventTarget.closest('[data-gr-combo][data-gr-combo-open="true"]')) return;
        /* Esc closes the topmost interaction only. While a modal write is in
         * flight (mutation / commit / push / settings save) the dialog's busy
         * rule applies to the keyboard as well: no layer may be bypassed. */
        var handleEscape = function () {
          if (menu) { event.preventDefault(); closeMenu(); return true; }
          if (confirm) { event.preventDefault(); if (!busyRef.current) setConfirm(null); return true; }
          if (pushState.open) { event.preventDefault(); closePush(); return true; }
          if (panelSettingsOpen) { event.preventDefault(); if (!settingsSavingRef.current) setPanelSettingsOpen(false); return true; }
          if (shortcutHelp) { event.preventDefault(); setShortcutHelp(false); return true; }
          return false;
        };
        if (isEditableTarget(eventTarget)) {
          if (event.key === 'Escape') handleEscape();
          return;
        }
        var meta = event.ctrlKey || event.metaKey;
        if (event.key === 'Escape') {
          handleEscape();
          return;
        }
        /* A layer that owns the keyboard only yields to Esc; ? toggles its own
         * help dialog. Everything else must not leak into the panel behind. */
        if (shortcutHelp) {
          if (event.key === '?') {
            event.preventDefault();
            setShortcutHelp(false);
          }
          return;
        }
        if (menu || confirm || pushState.open || panelSettingsOpen) return;
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.altKey) {
          /* Inside the diff these keys jump between hunks (handled by the
           * focused diff row); file navigation applies everywhere else. */
          if (inDiffRow) return;
          event.preventDefault();
          moveSelection(event.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (event.key === 'ArrowDown' && !meta) {
          var downRow = eventTarget && eventTarget.closest ? eventTarget.closest('[data-key]') : null;
          if (downRow) return; // handled by FileNav (onNavigate)
          if (eventTarget && eventTarget.closest && eventTarget.closest('[data-gr-nav]')) {
            event.preventDefault();
            moveSelection(1);
          }
          return;
        }
        if (event.key === 'ArrowUp' && !meta) {
          var upRow = eventTarget && eventTarget.closest ? eventTarget.closest('[data-key]') : null;
          if (upRow) return;
          if (eventTarget && eventTarget.closest && eventTarget.closest('[data-gr-nav]')) {
            event.preventDefault();
            moveSelection(-1);
          }
          return;
        }
        if ((event.key === 'ArrowRight' || event.key === 'ArrowDown') && meta) {
          event.preventDefault();
          if (diffRef.current) diffRef.current.nextChange();
          return;
        }
        if ((event.key === 'ArrowLeft' || event.key === 'ArrowUp') && meta) {
          event.preventDefault();
          if (diffRef.current) diffRef.current.prevChange();
          return;
        }
        if (event.key === 'r' || event.key === 'R') {
          if (meta) return;
          event.preventDefault();
          refresh({});
          return;
        }
        if (event.key === '?') {
          event.preventDefault();
          setShortcutHelp(true);
        }
      };
      root.addEventListener('keydown', onKeyDown, true);
      return function () {
        root.removeEventListener('keydown', onKeyDown, true);
      };
    }, [open, menu, confirm, pushState.open, shortcutHelp, panelSettingsOpen, closeMenu, closePush, moveSelection, refresh, props.windowRef]);

    // ---- splitter -----------------------------------------------------------
    var startResize = useCallback(function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      var startX = event.clientX;
      var startWidth = navWidth;
      var measured = workspaceRef.current;
      var maxWidth = MAX_NAV_WIDTH;
      if (measured && typeof measured.getBoundingClientRect === 'function') {
        var rect = measured.getBoundingClientRect();
        var available = rect.width - SPLITTER_WIDTH - MIN_DIFF_WIDTH;
        if (Number.isFinite(available)) {
          maxWidth = Math.min(MAX_NAV_WIDTH, Math.max(MIN_NAV_WIDTH, available));
        }
      }
      var onMove = function (moveEvent) {
        setNavWidth(util.clamp(startWidth + (moveEvent.clientX - startX), MIN_NAV_WIDTH, maxWidth));
      };
      var onUp = function () {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }, [navWidth]);

    // ---- open project / file (DSH open-in-app) ------------------------------
    /* Directory applications come from DSH's own catalog route (the session
     * header split button uses it); specific files go through the optional
     * Session Remote, so remote/SSH sessions simply hide the file actions. */
    /* A workspace without git still owns a directory: the chrome keeps the
     * open-project button and targets the resolved cwd instead of a repo root. */
    var openRoot = repoRoot || (snapshot && snapshot.cwd ? snapshot.cwd : null);
    useEffect(function () {
      if (!open || !openRoot) return undefined;
      var alive = true;
      setOpenTargetState({ apps: [], defaultId: '', loading: true, failed: false });
      openInApp.folderApps().then(function (apps) {
        if (!alive) return;
        setOpenTargetState({
          apps: apps,
          defaultId: apps.length > 0 ? apps[0] : '',
          loading: false,
          failed: apps.length === 0,
        });
      });
      openInApp.canOpenFiles(openInApp.sessionService(state.runtime.ctx)).then(function (available) {
        if (alive) setFileOpenAvailable(available);
      });
      return function () {
        alive = false;
      };
    }, [open, openRoot]);

    var openProject = useCallback(function (appId) {
      var current = snapshotRef.current;
      var root = current ? (current.repo ? current.repo.root : current.cwd) : null;
      if (!root || !appId) return;
      setOpenTargetBusy(true);
      openInApp.openFolder(null, appId, root).then(function (ok) {
        setOpenTargetBusy(false);
        if (!ok) {
          setNotice({ tone: 'error', text: t('open.failed') });
          return;
        }
        setOpenTargetState(function (current) {
          if (!current || current.defaultId === appId) return current;
          return { apps: current.apps, defaultId: appId, loading: false, failed: false };
        });
      });
    }, [t]);

    var openRepoFile = useCallback(function (entry, action) {
      var repo = snapshotRef.current && snapshotRef.current.repo;
      if (!repo || !entry) return;
      var path = openInApp.absoluteRepoPath(repo.root, entry.path);
      openInApp.openFile(openInApp.sessionService(state.runtime.ctx), path, action).then(function (ok) {
        if (!ok) setNotice({ tone: 'error', text: t('open.failed') });
      });
    }, [t]);

    /* DSH open-in-app: the "open project" split button belongs to the window
     * chrome (title bar, where it lived before the floating-window refactor), but
     * its data comes from this window body's snapshot. Render it here and report
     * the element to the parent window so the chrome stays a thin shell. */
    var openTargetButton = useMemo(function () {
      if (!openRoot) return null;
      var applications = openTargetState.apps.map(function (id) {
        return { id: id, label: t('openApp.' + id), iconSrc: openInApp.appIconUrl(id) };
      });
      if (applications.length === 0) return null;
      return h(components.OpenTargetButton, {
        t: t,
        applications: applications,
        defaultId: openTargetState.defaultId,
        loading: openTargetState.loading,
        failed: openTargetState.failed,
        busy: openTargetBusy,
        onOpen: openProject,
      });
    }, [t, openRoot, openTargetState, openTargetBusy, openProject]);
    useEffect(function () {
      if (typeof props.onHeadAction === 'function') props.onHeadAction(openTargetButton);
    }, [openTargetButton, props.onHeadAction]);

    /* The window chrome (title bar) lives in the parent window component; report
     * the resolved repository identity so windows of different workspaces can be
     * told apart by project name, while the body keeps owning the snapshot. */
    useEffect(function () {
      if (typeof props.onRepoChange === 'function') props.onRepoChange(repoRoot);
    }, [repoRoot, props.onRepoChange]);

    // ---- render -------------------------------------------------------------
    if (!open) return null;

    var aiNotice = null;
    if (aiEnabled && entries.length > 0) {
      if (aiState.loading) aiNotice = t('nav.aiLoading');
      else if (aiState.notice === 'fallback') {
        /* Surface the real failure code/reason: the generic "failed" text made
         * production failures impossible to diagnose without host logs. */
        var aiFailure = aiState.error;
        var aiFailureReason = describeError(aiFailure, t);
        var aiFailureCode = aiFailure && aiFailure.code ? String(aiFailure.code) : '';
        var aiFailureDetail = aiFailure && aiFailure.details && typeof aiFailure.details.reason === 'string'
          ? aiFailure.details.reason
          : '';
        if (aiFailureCode && aiFailureDetail) aiFailureCode += ':' + aiFailureDetail;
        else if (!aiFailureCode) aiFailureCode = aiFailureDetail;
        aiNotice = aiFailureCode
          ? t('nav.aiFailedWithReason', { reason: aiFailureReason, code: aiFailureCode })
          : t('nav.aiFailed');
      }
      else if (aiState.notice === 'cache') aiNotice = t('ai.usedCache');
      else if (aiState.result && aiState.signature !== entriesSignature) aiNotice = t('nav.aiStale');
    }

    var topBar = h(components.TopBar, {
      t: t,
      status: snapshot,
      repo: snapshot && snapshot.repo ? snapshot.repo : null,
      busy: !!busy,
      operation: busy ? t('op.running') : null,
      onRefresh: function () { refresh({}); },
      onOpenPush: openPush,
      pushDisabledReason: pushDisabledReason,
      aiCommitBusy: aiCommitBusy,
      aiCommitCanRun: canAiCommitPush,
      aiCommitDisabledReason: aiCommitDisabledReason,
      onAiCommitPush: function () { runCommit('aiCommitPush'); },
      aiMode: aiEnabled,
      aiGrouping: aiGrouping,
      aiBusy: aiState.loading,
      aiNotice: aiNotice,
      onChangeGrouping: function (value) {
        saveSettings(groupingSettingsPatch(value)).catch(function () {});
      },
      onReclassify: function () {
        requestAi({ force: true });
      },
      onShowShortcuts: function () { setShortcutHelp(true); },
      onOpenSettings: openPanelSettings,
      onCopy: copyText,
      onSetRemote: openRemoteSettings,
    });

    var fileNav = h(components.FileNav, {
      t: t,
      groups: visibleGroups,
      selectedKey: selectedKey,
      collapsedGroups: collapsedGroups,
      locateSignal: locateNonce,
      onLocate: locateCurrentFile,
      onToggleGroup: function (id) {
        setCollapsedGroups(function (current) {
          var next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      },
      onExpandAll: function () {
        setCollapsedGroups(new Set());
      },
      onCollapseAll: function () {
        setCollapsedGroups(function () {
          var next = new Set();
          for (var groupIndex = 0; groupIndex < visibleGroups.length; groupIndex += 1) {
            next.add(groupIdOf(visibleGroups[groupIndex], groupIndex));
          }
          return next;
        });
      },
      onSelect: selectEntry,
      onContextMenu: openEntryMenu,
      onToggleStaged: toggleEntryStaged,
      onToggleGroupStaged: toggleGroupStaged,
      onToggleAllStaged: toggleGroupStaged,
      selectAllDisabledReason: selectAllDisabledReason,
      busy: !!busy,
      onNavigate: navigateSelection,
      onNavigateEdge: navigateEdge,
      search: search,
      onSearch: setSearch,
      listRef: navScrollRef,
    });

    /* While a diff is on screen, its own entry snapshot is the operation target:
     * the header and the hunk menu must describe the same version the user is
     * reviewing, not a newer poll result. */
    var displayedEntry = diffState.value && diffState.value.entry ? diffState.value.entry : selectedEntry;
    var diffPane = h(DiffPane, {
      ref: diffRef,
      t: t,
      entry: displayedEntry,
      entryDiff: diffState.value,
      loading: diffState.loading,
      error: diffState.error,
      busy: !!busy,
      hunkMode: displayedEntry ? (displayedEntry.status === 'unstaged' ? 'unstaged' : displayedEntry.status === 'staged' ? 'staged' : 'none') : 'none',
      onHunkMenu: openHunkMenu,
      onNotice: function (text) { setNotice({ tone: 'success', text: text }); },
      onRetry: function () { setDiffNonce(function (value) { return value + 1; }); },
    });

    var splitter = h('div', {
      key: 'splitter',
      className: 'gr-splitter',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': t('common.resize'),
      title: t('common.resize'),
      onPointerDown: startResize,
      style: { width: '6px', cursor: 'col-resize', flex: '0 0 6px', alignSelf: 'stretch' },
    });

    var workspace = h('div', {
      className: 'gr-workspace',
      ref: workspaceRef,
      style: { display: 'flex', flex: '1 1 auto', minHeight: 0, overflow: 'hidden' },
    }, h('div', {
      className: 'gr-nav-column',
      'data-gr-nav': 'true',
      style: { width: navWidth + 'px', flex: '0 0 auto', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
    }, fileNav), splitter, h('div', {
      className: 'gr-diff-column',
      style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
    }, diffPane));

    var overlayStates = [];
    if (!snapshot && loading) overlayStates.push(h('div', { key: 'loading', className: 'gr-panel-placeholder' }, t('app.loading')));
    if (snapshot && snapshot.state === 'no-git') {
      overlayStates.push(h(components.EmptyState, {
        key: 'no-git',
        t: t,
        tone: 'warn',
        title: t('state.noGit'),
        /* The copy states the situation and the outcome; the two actions live in
         * their own centred row so they keep their hierarchy and never break a
         * sentence across lines. */
        hint: t('state.noGitHint'),
        action: [
          h(components.Button, {
            key: 'refresh',
            t: t,
            variant: 'default',
            size: 'sm',
            disabled: initBusy,
            onClick: function () { refresh({}); },
          }, t('app.refresh')),
          h(components.Button, {
            key: 'init',
            t: t,
            variant: 'primary',
            size: 'sm',
            busy: initBusy,
            busyLabel: t('state.noGitInitializing'),
            onClick: initRepository,
          }, t('state.noGitInit')),
        ],
      }));
    } else if (snapshot && snapshot.state === 'error') {
      overlayStates.push(h(components.EmptyState, {
        key: 'error',
        t: t,
        tone: 'error',
        title: t('state.repoMissing'),
        hint: describeError(snapshot.error || refreshError, t),
        action: h(components.Button, { t: t, variant: 'default', size: 'sm', onClick: function () { refresh({}); } }, t('app.retry')),
      }));
    } else if (snapshot && snapshot.state === 'ok' && entries.length === 0) {
      overlayStates.push(h(components.EmptyState, {
        key: 'clean',
        t: t,
        tone: 'info',
        title: t('state.clean'),
        hint: t('state.cleanHint'),
      }));
    }

    var body = h('div', {
      className: 'gr-panel-body',
      style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, overflow: 'hidden' },
    },
      topBar,
      truncated ? h('div', {
        key: 'truncation',
        className: 'gr-truncation-warning',
        role: 'alert',
      }, t('state.truncated')) : null,
      h('div', {
        className: 'gr-panel-main',
        style: { display: 'flex', flex: '1 1 auto', minHeight: 0, overflow: 'hidden' },
      }, overlayStates.length > 0 && entries.length === 0 ? overlayStates[0] : workspace),
      h(components.CommitPanel, {
        t: t,
        open: commitOpen,
        onToggle: toggleCommitPanel,
        message: commitMessage,
        onMessageChange: function (value) {
          setCommitMessage(value);
          if (commitError) setCommitError(null);
        },
        count: stagedEntries.length,
        busy: commitBusy || commitGenerating,
        canGenerate: canGenerate,
        generateBusy: commitGenerating,
        commitMode: commitMode,
        commitBusy: commitBusy,
        commitGenerating: commitGenerating,
        commitCanRun: canCommit,
        commitReasons: commitReasons,
        error: commitError,
        conflictCount: conflictCount,
        onGenerate: generateCommitMessage,
        onCommit: runCommit,
        onChangeCommitMode: function (value) {
          saveSettings({ commitMode: value }).catch(function () {});
        },
        staleNotice: commitStale ? t('commit.stale') : null,
      }),
      h(components.StatusBar, {
        busy: !!busy || commitBusy || commitGenerating,
        operation: busy
          ? t('op.running')
          : commitGenerating
            ? t('commit.generating')
            : commitBusy
              ? t('commit.running')
              : null,
        status: snapshot,
        repo: snapshot && snapshot.repo ? snapshot.repo : null,
        error: operationError || (refreshError ? { message: describeError(refreshError, t) } : null),
        notice: notice ? notice.text : null,
        t: t,
        onDismiss: function () { setOperationError(null); setNotice(null); setRefreshError(null); },
      }),
    );

    return h(React.Fragment, null,
      body,
      menu && menu.open ? h(components.ContextMenu, {
        t: t,
        open: true,
        x: menu.x,
        y: menu.y,
        header: menu.header,
        items: menu.items,
        onSelect: menu.hunkIndex !== undefined && menu.hunkIndex !== null ? onHunkMenuSelect : onMenuSelect,
        onClose: closeMenu,
      }) : null,
      confirm && confirm.open ? h(components.ConfirmDialog, {
        t: t,
        scoped: true,
        open: true,
        title: confirm.title,
        body: confirm.body,
        confirmLabel: confirm.confirmLabel,
        cancelLabel: t('common.cancel'),
        tone: confirm.tone,
        busy: !!busy,
        onConfirm: confirm.onConfirm,
        onCancel: function () { setConfirm(null); },
      }) : null,
      h(components.RemoteDialog, {
        t: t,
        scoped: true,
        open: remoteState.open,
        name: remoteState.name,
        url: remoteState.url,
        remotes: snapshot && snapshot.repo && Array.isArray(snapshot.repo.remotes) ? snapshot.repo.remotes : [],
        busy: remoteState.busy,
        errorText: remoteState.error ? describeError(remoteState.error, t) : null,
        onNameChange: function (value) {
          setRemoteState(function (previous) {
            return { open: previous.open, name: value, url: previous.url, busy: previous.busy, error: null };
          });
        },
        onUrlChange: function (value) {
          setRemoteState(function (previous) {
            return { open: previous.open, name: previous.name, url: value, busy: previous.busy, error: null };
          });
        },
        onPick: function (remote) {
          setRemoteState(function (previous) {
            return {
              open: previous.open,
              name: String(remote && remote.name ? remote.name : ''),
              url: String(remote && remote.url ? remote.url : ''),
              busy: previous.busy,
              error: null,
            };
          });
        },
        onSubmit: submitRemote,
        onClose: closeRemoteSettings,
      }),
      h(components.PushDialog, {
        t: t,
        scoped: true,
        open: pushState.open,
        preview: pushState.preview,
        loading: pushState.loading,
        busy: pushState.busy,
        error: pushState.error,
        hint: pushState.error ? describeError(pushState.error, t) : null,
        remote: pushState.remote,
        target: pushState.target,
        onRemoteChange: function (value) {
          var currentTarget = pushStateRef.current.target;
          if (pushPreviewTimerRef.current !== null) {
            clearTimeout(pushPreviewTimerRef.current);
            pushPreviewTimerRef.current = null;
          }
          setPushState(function (current) {
            return {
              open: current.open,
              preview: current.preview,
              loading: true,
              error: null,
              busy: current.busy,
              remote: value,
              target: current.target,
            };
          });
          refreshPushPreview({ remote: value, target: currentTarget });
        },
        onTargetChange: function (value) {
          setPushState(function (current) {
            return {
              open: current.open,
              preview: current.preview,
              loading: current.loading,
              error: null,
              busy: current.busy,
              remote: current.remote,
              target: value,
            };
          });
          /* Typing a branch name re-previews after a short pause so the commit
           * list always matches the target that would be pushed. */
          schedulePushPreview(pushStateRef.current.remote, value);
        },
        onRetry: function () {
          refreshPushPreview({ remote: pushStateRef.current.remote, target: pushStateRef.current.target });
        },
        onClose: closePush,
        onPush: submitPush,
      }),
      panelSettingsOpen ? h(components.Modal, {
        t: t,
        scoped: true,
        open: true,
        className: 'gr-modal-settings',
        title: t('settings.dialogTitle'),
        subtitle: t('settings.subtitle'),
        onClose: closePanelSettings,
        busy: settingsSnapshot.saving,
        width: 'min(100%, 720px)',
        height: 'min(100%, 780px)',
      }, h(components.PanelSettings, {
        t: t,
        settings: settingsForDialog(settingsSnapshot),
        saving: settingsSnapshot.saving,
        error: settingsSnapshot.error,
        errorText: settingsSnapshot.error ? describeError(settingsSnapshot.error, t) : null,
        modelInfo: settingsSnapshot.model,
        modelsInfo: modelsInfo,
        modelsLoading: modelsLoading,
        modelsError: modelsError,
        modelsErrorText: modelsError ? describeError(modelsError, t) : null,
        onChange: function (patch) {
          saveSettings(patch).then(function () {
            if (patch && ('provider' in patch || 'model' in patch || 'reasoningEffort' in patch)) loadModels();
          }).catch(function () {
            /* the store carries the error */
          });
        },
      })) : null,
      h(components.ShortcutHelp, {
        t: t,
        scoped: true,
        open: shortcutHelp,
        onClose: function () { setShortcutHelp(false); },
        shortcuts: [
          { keys: ['↓', '↑'], label: t('shortcut.navRows') },
          { keys: ['Home', 'End'], label: t('shortcut.fileEdges') },
          { keys: ['Alt', '↓/↑'], label: t('shortcut.switchFiles') },
          { keys: [util.isMac() ? '⌘' : 'Ctrl', '←/→'], label: t('shortcut.prevChange') + ' / ' + t('shortcut.nextChange') },
          { keys: ['Enter'], label: t('shortcut.hunkMenu') },
          { keys: ['Shift', 'F10'], label: t('shortcut.contextMenu') },
          { keys: ['R'], label: t('shortcut.refresh') },
          { keys: ['?'], label: t('shortcut.helpToggle') },
          { keys: ['Esc'], label: t('shortcut.close') },
        ],
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // Floating window layer (shell.overlay slot)
  //
  // The review panel is not a modal: this entry renders a frame-wide,
  // pointer-transparent layer that holds zero, one or many independent windows.
  // DSH keeps receiving input around and behind the windows, and every window is
  // closed only from its own close button (Esc never closes it).
  // ---------------------------------------------------------------------------
  function focusElement(node) {
    if (!node || typeof node.focus !== 'function') return;
    try {
      node.focus({ preventScroll: true });
    } catch (error) {
      try {
        node.focus();
      } catch (ignored) {
        /* focus is best effort */
      }
    }
  }

  function isWindowControlTarget(target) {
    return !!(target && typeof target.closest === 'function'
      && target.closest('button, a, input, textarea, select, [data-gr-no-window-drag]'));
  }

  /**
   * A click/drag inside the window must also give the window DOM focus: the
   * keyboard shortcuts are bound to the window root, and `beginGesture`'s
   * preventDefault on the title bar suppresses the browser's own focus change.
   * Editable targets are skipped because their default action focuses them.
   */
  function focusWindowRoot(root, event) {
    if (!root || typeof document === 'undefined') return;
    var active = document.activeElement;
    if (active && typeof root.contains === 'function' && root.contains(active)) return;
    var target = event && event.target;
    if (target && typeof target.closest === 'function'
      && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    focusElement(root);
  }

  var ReviewWindow = React.memo(function ReviewWindow(props) {
    var t = props.t;
    var win = props.win;
    var [repoRoot, setRepoRoot] = useState(null);
    /* The open-project control is produced by the review body (it needs the
     * snapshot) and mounted here in the title bar, before minimize/close. */
    var [headAction, setHeadAction] = useState(null);
    var [moving, setMoving] = useState(false);
    var rootRef = useRef(null);
    var gestureCleanupRef = useRef(null);

    /* Take focus when the window is created or explicitly re-opened from the
     * composer button, so keyboard shortcuts work immediately. The window is not
     * a focus trap: clicking back into DSH keeps working. */
    useEffect(function () {
      focusElement(rootRef.current);
    }, [win.openToken, win.focusToken]);

    useEffect(function () {
      return function () {
        if (typeof gestureCleanupRef.current === 'function') gestureCleanupRef.current();
      };
    }, []);

    /* A window created directly through the store has no geometry yet: give it
     * the default cascaded rectangle once it mounts. */
    useEffect(function () {
      if (!win.width || !win.height) {
        state.patchWindow(win.id, defaultWindowGeometry(viewportSize(), props.index));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function saveGeometry() {
      saveWindowGeometry(win.id);
    }

    function closeWindow() {
      saveGeometry();
      state.closeWindow(win.id);
    }

    function toggleMinimize() {
      if (win.minimized) {
        /* Restoring grows the window back to its remembered footprint: re-clamp
         * it against the live work area, otherwise a strip dragged to the
         * bottom edge would come back half off screen. */
        state.patchWindow(win.id, Object.assign(
          { minimized: false },
          clampWindowRect({ x: win.x, y: win.y, width: win.width, height: win.height }, viewportSize()),
        ));
        return;
      }
      state.patchWindow(win.id, { minimized: true });
    }

    function toggleMaximize() {
      if (win.maximized && win.restore) {
        /* The viewport may have shrunk while maximized: clamp the remembered
         * rectangle before restoring, otherwise the window (with its close
         * button) could come back completely off screen. */
        var restored = clampWindowRect(win.restore, viewportSize());
        state.patchWindow(win.id, Object.assign({ maximized: false, minimized: false, restore: null }, restored));
        return;
      }
      state.patchWindow(win.id, Object.assign({
        maximized: true,
        minimized: false,
        restore: { x: win.x, y: win.y, width: win.width, height: win.height },
      }, maximizedWindowGeometry(viewportSize())));
    }

    /**
     * Shared pointer gesture for moving (edge 'move') and resizing
     * (edge 'e' | 's' | 'se'). The start rectangle is captured once, so every
     * move event is computed from the pointer delta instead of the previous
     * patched frame (no drift while the store re-renders).
     */
    function beginGesture(event, edge) {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.defaultPrevented) return;
      /* A maximized window fills the work area: it is neither draggable nor
       * resizable until it is restored. A minimized window is only its title
       * strip, so it can be moved but offers no resize gesture either. */
      if (win.maximized) return;
      if (win.minimized && edge !== 'move') return;
      if (edge === 'move' && isWindowControlTarget(event.target)) return;
      event.preventDefault();
      state.focusWindow(win.id);
      var start = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        rect: { x: win.x, y: win.y, width: win.width, height: win.height },
        viewport: viewportSize(),
      };
      var active = true;
      var onMove = function (moveEvent) {
        if (!active) return;
        var dx = moveEvent.clientX - start.pointerX;
        var dy = moveEvent.clientY - start.pointerY;
        if (edge === 'move') {
          /* The drag clamps against the live footprint: a minimized window is
           * only its title strip, so it uses the strip height instead of the
           * remembered restore height. Only the origin moves; the stored size
           * stays the restore footprint. */
          var dragged = win.minimized
            ? clampMinimizedWindowRect({
                x: start.rect.x + dx,
                y: start.rect.y + dy,
                width: start.rect.width,
                height: start.rect.height,
              }, start.viewport)
            : dragWindowRect(start.rect, dx, dy, start.viewport);
          state.patchWindow(win.id, { x: dragged.x, y: dragged.y });
          return;
        }
        state.patchWindow(win.id, resizeWindowRect(start.rect, dx, dy, edge, start.viewport));
      };
      var cleanup = function () {
        if (!active) return;
        active = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        gestureCleanupRef.current = null;
        setMoving(false);
        saveWindowGeometry(win.id);
      };
      var onUp = function () { cleanup(); };
      gestureCleanupRef.current = cleanup;
      setMoving(true);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    var geometry = {
      x: Number.isFinite(win.x) ? win.x : 0,
      y: Number.isFinite(win.y) ? win.y : 0,
      width: Number.isFinite(win.width) && win.width > 0 ? win.width : 960,
      height: Number.isFinite(win.height) && win.height > 0 ? win.height : 640,
    };
    var className = 'gr-window'
      + (props.focused ? ' gr-window-focused' : '')
      + (win.minimized ? ' gr-window-minimized' : '')
      + (win.maximized ? ' gr-window-maximized' : '')
      + (moving ? ' gr-window-moving' : '');
    var minimizeIcon = win.minimized
      ? h(components.IconArrowUp, { size: components.ICON_SIZE.md })
      : h(components.IconMinus, { size: components.ICON_SIZE.md });

    return h('section', {
      className: className,
      role: 'dialog',
      'aria-label': t('app.title'),
      tabIndex: -1,
      ref: rootRef,
      style: {
        left: geometry.x + 'px',
        top: geometry.y + 'px',
        width: geometry.width + 'px',
        height: (win.minimized ? WINDOW_HEAD_HEIGHT : geometry.height) + 'px',
        zIndex: props.zIndex,
      },
      'data-gr-review-window': win.id,
      onPointerDown: function (event) {
        if (!props.focused) state.focusWindow(win.id);
        focusWindowRoot(rootRef.current, event);
      },
    },
      h('header', {
        className: 'gr-window-head',
        title: t('window.hint'),
        onPointerDown: function (event) { beginGesture(event, 'move'); },
        onDoubleClick: function (event) {
          if (isWindowControlTarget(event.target)) return;
          toggleMaximize();
        },
      },
        h('div', { className: 'gr-window-ident' },
          h(components.ReviewTitle, { t: t, repo: repoRoot ? { root: repoRoot } : null })),
        h('div', { className: 'gr-window-actions' },
          headAction,
          h(components.IconButton, {
            label: win.minimized ? t('window.restore') : t('window.minimize'),
            className: 'gr-window-btn gr-window-btn-min',
            onClick: toggleMinimize,
            t: t,
          }, minimizeIcon),
          h(components.IconButton, {
            label: win.maximized ? t('window.restore') : t('window.maximize'),
            className: 'gr-window-btn gr-window-btn-max',
            onClick: toggleMaximize,
            t: t,
          }, win.maximized
            ? h(components.IconRestore, { size: components.ICON_SIZE.md })
            : h(components.IconMaximize, { size: components.ICON_SIZE.md })),
          h(components.IconButton, {
            label: t('app.close'),
            className: 'gr-window-btn gr-window-btn-close',
            onClick: closeWindow,
            t: t,
          }, h(components.IconClose, { size: components.ICON_SIZE.md })))
      ),
      h('div', { className: 'gr-window-body' },
        h(ReviewBody, {
          target: win.target,
          openToken: win.openToken,
          windowRef: rootRef,
          onRepoChange: setRepoRoot,
          onHeadAction: setHeadAction,
        })),
      h('div', {
        className: 'gr-window-resize gr-window-resize-e',
        'data-gr-no-window-drag': 'true',
        onPointerDown: function (event) { beginGesture(event, 'e'); },
      }),
      h('div', {
        className: 'gr-window-resize gr-window-resize-s',
        'data-gr-no-window-drag': 'true',
        onPointerDown: function (event) { beginGesture(event, 's'); },
      }),
      h('div', {
        className: 'gr-window-resize gr-window-resize-se',
        'data-gr-no-window-drag': 'true',
        onPointerDown: function (event) { beginGesture(event, 'se'); },
      })
    );
  });

  function WindowLayer() {
    var layer = state.useStore(state.windowStore);
    var t = state.useT();

    /* Keep every window inside the live viewport when the DSH page is resized. */
    useEffect(function () {
      if (typeof window === 'undefined' || !window.addEventListener) return undefined;
      var onResize = function () {
        var viewport = viewportSize();
        var windows = state.windowStore.get().windows;
        for (var index = 0; index < windows.length; index += 1) {
          var win = windows[index];
          if (win.maximized) {
            state.patchWindow(win.id, maximizedWindowGeometry(viewport));
            continue;
          }
          var rect = win.minimized
            ? clampMinimizedWindowRect(win, viewport)
            : clampWindowRect({ x: win.x, y: win.y, width: win.width, height: win.height }, viewport);
          if (rect.x !== win.x || rect.y !== win.y || rect.width !== win.width || rect.height !== win.height) {
            state.patchWindow(win.id, rect);
          }
        }
      };
      window.addEventListener('resize', onResize);
      return function () {
        window.removeEventListener('resize', onResize);
      };
    }, []);

    if (layer.windows.length === 0) return null;
    /* The store array order is the stacking order, but the DOM order stays the
     * stable creation order: React must never move a focused window's subtree,
     * otherwise browsers drop focus / text selection. Raising a window only
     * changes its z-index. */
    var stacking = new Map();
    for (var stackIndex = 0; stackIndex < layer.windows.length; stackIndex += 1) {
      stacking.set(layer.windows[stackIndex].id, stackIndex + 1);
    }
    var ordered = layer.windows.slice().sort(function (left, right) {
      return (left.seq || 0) - (right.seq || 0);
    });
    return h('div', { className: 'gr-window-layer', 'data-gr-window-layer': 'true' },
      ordered.map(function (win, index) {
        return h(ReviewWindow, {
          key: win.id,
          win: win,
          t: t,
          focused: win.id === layer.focusedId,
          zIndex: stacking.get(win.id) || index + 1,
          index: index,
        });
      }));
  }

  var PanelEntry = React.memo(WindowLayer);

  // ---------------------------------------------------------------------------
  // Always-mounted style sheet entry (shell.overlay slot)
  //
  // The window layer only renders while at least one window is open, but the
  // composer button must be styled in both states. A separate overlay entry keeps
  // the plugin's style sheet in the document for the whole page lifetime.
  // ---------------------------------------------------------------------------
  function StylesEntry() {
    return h(components.Styles);
  }

  // ---------------------------------------------------------------------------
  // Plugin body
  // ---------------------------------------------------------------------------
  function apply(ctx) {
    var i18n = i18nModule.createI18n();
    state.runtime.i18n = i18n;
    state.runtime.ctx = ctx;
    state.runtime.rpc = rpcModule.createRpc();
    loadSettings();

    // One position in both states: the composer tool row, immediately after the
    // permission / plan controls (DSH renders `conversation.input.left` at that
    // exact seat, before the right-aligned model selector).
    ctx.slots.inject('conversation.input.left', function () {
      return ctx.slots.register({
        name: 'conversation.input.left',
        id: 'dsh-code-review-composer',
        order: 10,
        label: function () { return i18n.t('app.open'); },
      }, HeaderButtonEntry);
    });

    ctx.slots.inject('shell.overlay', function () {
      var disposeStyles = ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-code-review-styles',
        order: 0,
      }, StylesEntry);
      var disposePanel = ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-code-review-panel',
        order: 120,
      }, PanelEntry);
      return function () {
        if (typeof disposePanel === 'function') disposePanel();
        if (typeof disposeStyles === 'function') disposeStyles();
      };
    });

  }

  exports.inject = ['slots'];
  exports.apply = apply;
  /* Pure helpers re-exported for client-source regression tests. */
  exports.expectedFingerprints = expectedFingerprints;
  exports.pushDefaults = pushDefaults;
  exports.groupIdForEntry = groupIdForEntry;
  exports.aiEntriesSignature = aiEntriesSignature;
  exports.aiPathGroups = aiPathGroups;
  exports.groupingSettingsPatch = groupingSettingsPatch;
  exports.commitModeOf = commitModeOf;
  exports.clampWindowSize = clampWindowSize;
  exports.clampWindowRect = clampWindowRect;
  exports.clampMinimizedWindowRect = clampMinimizedWindowRect;
  exports.dragWindowRect = dragWindowRect;
  exports.resizeWindowRect = resizeWindowRect;
  exports.defaultWindowGeometry = defaultWindowGeometry;
  exports.maximizedWindowGeometry = maximizedWindowGeometry;
  exports.windowGeometryForOpen = windowGeometryForOpen;
  exports.rememberWindowGeometry = rememberWindowGeometry;
  exports.frameTopInset = frameTopInset;
  exports.viewportSize = viewportSize;
  exports.WINDOW_LIMITS = {
    margin: WINDOW_MARGIN,
    cascadeStep: WINDOW_CASCADE_STEP,
    headHeight: WINDOW_HEAD_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
  };
});

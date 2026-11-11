__def('state', function (exports, require, React) {
  'use strict';

  var util = require('util');

  /**
   * Process-local runtime shared by every slot entry of this plugin: the DSH
   * Cordis context, the i18n instance and the RPC client. The window store is
   * module state, so the composer button (session-scoped slot) can open a
   * floating review window (root-scoped slot) and switch the current workspace
   * without dropping the windows that are already open.
   */
  var runtime = {
    ctx: null,
    i18n: null,
    rpc: null,
  };

  function createStore(initial) {
    var snapshot = initial;
    var listeners = new Set();
    return {
      get: function () {
        return snapshot;
      },
      set: function (patch) {
        var next = typeof patch === 'function' ? patch(snapshot) : patch;
        if (next === snapshot) return snapshot;
        snapshot = next;
        for (var listener of Array.from(listeners)) {
          try {
            listener();
          } catch (error) {
            console.error('[code-review] store listener failed', error);
          }
        }
        return snapshot;
      },
      update: function (updater) {
        var current = snapshot;
        var next = updater(current);
        if (next === undefined || next === current) return current;
        return this.set(next);
      },
      subscribe: function (listener) {
        listeners.add(listener);
        return function () {
          listeners.delete(listener);
        };
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Floating review windows
  //
  // Each reviewed target (a session, or a plain cwd for a session-less target)
  // owns at most one window. Windows are independent component instances, so
  // their file selection, diff, AI groups and dialogs never bleed into each
  // other; only plugin settings and the per-repository review marks are shared.
  // The array order is the stacking order: the last entry is painted on top.
  // ---------------------------------------------------------------------------
  function windowKeyForTarget(target) {
    var sessionId = target && target.sessionId;
    if (sessionId) return 'session:' + String(sessionId);
    var cwd = target && target.cwd;
    if (cwd) return 'cwd:' + String(cwd);
    return 'none';
  }

  /**
   * Target normalisation keeps the original open-panel contract: an absent
   * `sessionId` field inherits the previous target, while an explicit
   * `null`/empty value clears it, so a blank conversation can never keep
   * reviewing the previous one. `cwd` is taken from the request when present.
   */
  var lastTarget = { sessionId: null, cwd: null, label: '' };

  function normalizeTarget(target) {
    var previous = lastTarget;
    var next = {
      sessionId: previous.sessionId,
      cwd: previous.cwd,
      label: target && target.label ? String(target.label) : previous.label,
    };
    if (target && target.sessionId !== undefined) {
      next.sessionId = target.sessionId === null || target.sessionId === '' ? null : String(target.sessionId);
    }
    if (target && target.cwd !== undefined) {
      next.cwd = target.cwd === null || target.cwd === '' ? null : String(target.cwd);
    }
    return next;
  }

  function copyWindowGeometry(geometry) {
    if (!geometry) return null;
    var out = {};
    var keys = ['x', 'y', 'width', 'height'];
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      if (Number.isFinite(geometry[key])) out[key] = geometry[key];
    }
    return Object.keys(out).length === 4 ? out : null;
  }

  function moveWindowToTop(windows, id) {
    var moving = null;
    var rest = [];
    for (var index = 0; index < windows.length; index += 1) {
      if (windows[index].id === id) moving = windows[index];
      else rest.push(windows[index]);
    }
    if (!moving) return windows;
    if (rest.length === windows.length - 1 && windows[windows.length - 1].id === id) {
      /* Already on top: no store change needed. */
      return windows;
    }
    return rest.concat([moving]);
  }

  var windowStore = createStore({ windows: [], focusedId: null });
  var windowSeq = 0;

  function findWindow(windows, id) {
    for (var index = 0; index < windows.length; index += 1) {
      if (windows[index].id === id) return windows[index];
    }
    return null;
  }

  /**
   * Open (or re-focus) the review window for a target. A target that already
   * owns a window is focused and restored from the minimized state instead of
   * being duplicated; two different targets yield two independent windows.
   * Returns the window id.
   */
  function openPanel(target, geometry) {
    var normalized = normalizeTarget(target);
    lastTarget = normalized;
    var key = windowKeyForTarget(normalized);
    var current = windowStore.get();
    var existing = null;
    for (var index = 0; index < current.windows.length; index += 1) {
      if (current.windows[index].key === key) existing = current.windows[index];
    }
    var nextGeometry = copyWindowGeometry(geometry);
    if (existing) {
      /* Re-opening an existing target only focuses/restores it: the live
       * geometry the user dragged/resized to must not be reset. */
      windowStore.set(function (stateNow) {
        var windows = moveWindowToTop(stateNow.windows, existing.id).map(function (win) {
          if (win.id !== existing.id) return win;
          return Object.assign({}, win, {
            minimized: false,
            focusToken: (win.focusToken || 0) + 1,
          });
        });
        return { windows: windows, focusedId: existing.id };
      });
      return existing.id;
    }
    windowSeq += 1;
    var created = {
      id: 'review-window-' + windowSeq,
      /* Stable creation order: the layer keeps DOM order fixed and raises the
       * focused window with z-index instead of moving nodes (moving a subtree
       * that contains the pressed element can disturb focus and text selection). */
      seq: windowSeq,
      key: key,
      target: normalized,
      openToken: windowSeq,
      focusToken: 0,
      minimized: false,
      maximized: false,
      x: nextGeometry ? nextGeometry.x : 0,
      y: nextGeometry ? nextGeometry.y : 0,
      width: nextGeometry ? nextGeometry.width : 0,
      height: nextGeometry ? nextGeometry.height : 0,
      restore: null,
    };
    windowStore.set(function (stateNow) {
      return {
        windows: stateNow.windows.concat([created]),
        focusedId: created.id,
      };
    });
    return created.id;
  }

  /** Close one window; the next-lower window becomes the focused one. */
  function closeWindow(id) {
    windowStore.set(function (stateNow) {
      var windows = stateNow.windows.filter(function (win) {
        return win.id !== id;
      });
      if (windows.length === stateNow.windows.length) return stateNow;
      var focusedId = stateNow.focusedId;
      if (focusedId === id) {
        focusedId = windows.length > 0 ? windows[windows.length - 1].id : null;
      }
      return { windows: windows, focusedId: focusedId };
    });
  }

  /** Raise one window above the others and mark it as the focused window. */
  function focusWindow(id) {
    windowStore.set(function (stateNow) {
      if (!findWindow(stateNow.windows, id) || stateNow.focusedId === id) {
        /* Even when it is already focused, keep it on top of the stack. */
        var reordered = moveWindowToTop(stateNow.windows, id);
        if (reordered === stateNow.windows) return stateNow;
        return { windows: reordered, focusedId: id };
      }
      return { windows: moveWindowToTop(stateNow.windows, id), focusedId: id };
    });
  }

  /** Merge geometry / minimize / maximize / restore flags into one window. */
  function patchWindow(id, patch) {
    if (!patch) return;
    windowStore.set(function (stateNow) {
      var changed = false;
      var windows = stateNow.windows.map(function (win) {
        if (win.id !== id) return win;
        changed = true;
        return Object.assign({}, win, patch);
      });
      if (!changed) return stateNow;
      return { windows: windows, focusedId: stateNow.focusedId };
    });
  }

  /** True when the given session already owns an open review window. */
  function hasWindowFor(sessionId) {
    if (!sessionId) return false;
    var key = 'session:' + String(sessionId);
    var windows = windowStore.get().windows;
    for (var index = 0; index < windows.length; index += 1) {
      if (windows[index].key === key) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Plugin settings mirror (loaded from the Host half)
  // ---------------------------------------------------------------------------
  var settingsStore = createStore({
    loaded: false,
    saving: false,
    error: null,
    value: { aiClassify: false, aiGrouping: 'role', commitMode: 'commit', maxCandidates: 50, reasoningEffort: null },
    locale: null,
    model: null,
  });

  function useStore(store) {
    return React.useSyncExternalStore(store.subscribe, store.get, store.get);
  }

  /** Re-render on locale change and return the translator. */
  function useT() {
    React.useSyncExternalStore(runtime.i18n.subscribe, runtime.i18n.getLocale, runtime.i18n.getLocale);
    return runtime.i18n.t;
  }

  function useLocale() {
    React.useSyncExternalStore(runtime.i18n.subscribe, runtime.i18n.getLocale, runtime.i18n.getLocale);
  }

  exports.runtime = runtime;
  exports.windowStore = windowStore;
  exports.settingsStore = settingsStore;
  exports.createStore = createStore;
  exports.openPanel = openPanel;
  exports.closeWindow = closeWindow;
  exports.focusWindow = focusWindow;
  exports.patchWindow = patchWindow;
  exports.hasWindowFor = hasWindowFor;
  exports.windowKeyForTarget = windowKeyForTarget;
  exports.normalizeTarget = normalizeTarget;
  exports.useStore = useStore;
  exports.useT = useT;
  exports.useLocale = useLocale;
  exports.util = util;
});

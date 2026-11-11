import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CLIENT_ORDER = ['util', 'i18n', 'state', 'rpc', 'open-in-app', 'diff', 'diff-view', 'styles', 'ui', 'components', 'app'];

const diffViewSource = readFileSync(new URL('../src/client/diff-view.js', import.meta.url), 'utf8');
const componentsSource = readFileSync(new URL('../src/client/components.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../src/client/ui.js', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/client/app.js', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('../src/client/state.js', import.meta.url), 'utf8');

/**
 * Regression guard for a real crash: `markersRef.current` was assigned before
 * the `var markersRef = React.useRef(...)` initialiser ran, so the property
 * write hit `undefined` during the first DiffPane render and deactivated the
 * whole review-panel slot entry. Keep the declaration before every use.
 */
test('DiffPane initialises its refs before reading or writing them', () => {
  const declaration = diffViewSource.indexOf('var markersRef = React.useRef(');
  assert.ok(declaration !== -1, 'markersRef declaration is missing');
  const firstWrite = diffViewSource.indexOf('markersRef.current');
  assert.ok(firstWrite !== -1, 'markersRef is never used');
  assert.ok(
    declaration < firstWrite,
    `markersRef is used at ${firstWrite} before its declaration at ${declaration}`,
  );
});

test('every React ref is declared before its first .current access', () => {
  const names = new Set();
  for (const match of diffViewSource.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*React\.useRef\(/g)) names.add(match[1]);
  assert.ok(names.size > 0, 'no React refs found');
  for (const name of names) {
    const declaration = diffViewSource.search(new RegExp(`var\\s+${name}\\s*=\\s*React\\.useRef\\(`));
    const firstAccess = diffViewSource.search(new RegExp(`${name}\\.current`));
    assert.ok(
      declaration < firstAccess,
      `${name} is accessed at ${firstAccess} before its declaration at ${declaration}`,
    );
  }
});

/* ------------------------------------------------------------------------- */
/* Minimal no-bundle runtime: evaluates the plain-script sources exactly the  */
/* way the generated bundle does (one shared React stub, modules resolved by  */
/* name), so components/state/helpers can be exercised in Node.               */
/* ------------------------------------------------------------------------- */

function createReactStub() {
  function createElement(type) {
    const children = Array.prototype.slice.call(arguments, 2);
    const props = Object.assign({}, arguments[1] || {});
    props.children = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
    return { type, props };
  }
  return {
    createElement,
    Fragment: Symbol('fragment'),
    memo: (component) => component,
    forwardRef: (component) => component,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef: (initial) => ({ current: initial }),
    useImperativeHandle: () => {},
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
}

function createClientRuntime() {
  const factories = new Map();
  const exportsByModule = new Map();
  const react = createReactStub();
  function define(name, factory) {
    factories.set(name, factory);
  }
  function requireModule(name) {
    if (name === 'react') return react;
    if (exportsByModule.has(name)) return exportsByModule.get(name);
    const factory = factories.get(name);
    if (!factory) throw new Error(`unknown client module: ${name}`);
    const exports = {};
    exportsByModule.set(name, exports);
    factory(exports, requireModule, react);
    return exports;
  }
  for (const name of CLIENT_ORDER) {
    const source = readFileSync(new URL(`../src/client/${name}.js`, import.meta.url), 'utf8');
    new Function('__def', source)(define);
  }
  return { require: requireModule, react };
}

function walkElements(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walkElements(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(node, 'type') || !Object.prototype.hasOwnProperty.call(node, 'props')) return;
  visit(node);
  walkElements(node.props.children, visit);
}

function collectElements(node) {
  const out = [];
  walkElements(node, (element) => out.push(element));
  return out;
}

function collectText(node) {
  const parts = [];
  walkElements(node, (element) => {
    const children = element.props.children;
    if (typeof children === 'string' || typeof children === 'number') parts.push(String(children));
  });
  return parts.join(' ');
}

/**
 * Run a test body with an explicit browser viewport. The window geometry
 * helpers read `window.innerWidth/innerHeight`, so injecting a plain object
 * keeps the geometry tests pure without a DOM.
 */
function withViewport(size, run) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  globalThis.window = { innerWidth: size.width, innerHeight: size.height };
  try {
    return run();
  } finally {
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
  }
}

/** Class tokens of a rendered synthetic element. */
function elementClasses(element) {
  return String((element && element.props && element.props.className) || '')
    .split(/\s+/)
    .filter(Boolean);
}

/** Every element in the tree whose class list contains `name`. */
function elementsByClass(tree, name) {
  return collectElements(tree).filter((element) => elementClasses(element).includes(name));
}

/** Local HH:MM:SS the status strip shows in its "updated at" tooltip. */
function localClock(ms) {
  const date = new Date(ms);
  const pad = (part) => String(part).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/* ------------------------------------------------------------------------- */
/* P2-20 — theme-token styles, no literal colours                            */
/* ------------------------------------------------------------------------- */

test('styles.js uses theme tokens, including DSH shadow tokens, and no literal colours', () => {
  assert.doesNotMatch(stylesSource, /rgba?\(/, 'styles.js must not contain rgb()/rgba() literals');
  const hex = stylesSource.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hex, [], `styles.js must not contain literal hex colours: ${hex.join(', ')}`);
  assert.match(stylesSource, /--dsw-shadow-lv/, 'shadows must come from DSH shadow tokens');
  assert.match(stylesSource, /\.gr-modal \{/, 'panel styles stay in the .gr- namespace');
});

/* ------------------------------------------------------------------------- */
/* P2-19 — i18n error catalogue                                              */
/* ------------------------------------------------------------------------- */

test('zh and en dictionaries expose exactly the same keys', () => {
  const runtime = createClientRuntime();
  const i18n = runtime.require('i18n');
  const zh = Object.keys(i18n.DICTIONARIES.zh).sort();
  const en = Object.keys(i18n.DICTIONARIES.en).sort();
  assert.deepEqual(zh, en);
});

test('describeError maps every documented protocol code to localized zh/en text', () => {
  const runtime = createClientRuntime();
  const i18n = runtime.require('i18n');
  const codes = [
    'internal',
    'protocol/unknown-method',
    'transport/bad-json',
    'transport/bad-envelope',
    'repo/no-git',
    'repo/not-found',
    'repo/git-unavailable',
    'repo/locked',
    'repo/error',
    'repo/timeout',
    'repo/output-too-large',
    'entry/not-found',
    'entry/stale',
    'entry/unsupported',
    'entry/conflict',
    'patch/mismatch',
    'commit/empty-index',
    'commit/stale',
    'commit/failed',
    'commit/conflict-pending',
    'commit/invalid-message',
    'push/no-remote',
    'push/no-branch',
    'push/upstream-missing',
    'push/rejected',
    'push/auth',
    'push/network',
    'ai/disabled',
    'ai/invalid',
    'ai/unavailable',
    'ai/aborted',
    'message/no-staged',
    'message/unavailable',
    'message/invalid',
    'message/aborted',
    'settings/invalid',
  ];
  const zh = i18n.createI18n('zh');
  const en = i18n.createI18n('en');
  for (const code of codes) {
    assert.ok(i18n.ERROR_KEYS[code], `missing ERROR_KEYS entry for ${code}`);
    const zhText = i18n.describeError({ code, message: 'host internal detail' }, zh.t);
    const enText = i18n.describeError({ code, message: 'host internal detail' }, en.t);
    assert.ok(zhText && zhText !== code, `zh text missing for ${code}`);
    assert.ok(enText && enText !== code, `en text missing for ${code}`);
    assert.equal(zhText.includes('host internal detail'), false, `zh leaked host message for ${code}`);
    assert.equal(enText.includes('host internal detail'), false, `en leaked host message for ${code}`);
  }
  assert.match(i18n.describeError({ code: 'transport/http-503' }, en.t), /503/);
  const unknown = i18n.describeError({ code: 'weird/code', message: 'C:\\secret\\internal' }, en.t);
  assert.equal(unknown, en.t('error.unknown'));
  assert.equal(unknown.includes('secret'), false);
  assert.equal(i18n.describeError(null, en.t), '');

  // A newer client against an older Host half: the stable unknown-method code
  // must localize into a "restart DSH" hint, never the generic internal error.
  assert.equal(i18n.ERROR_KEYS['protocol/unknown-method'], 'error.protocolUnknownMethod');
  assert.equal(i18n.describeError({ code: 'protocol/unknown-method', message: 'raw host text' }, zh.t),
    zh.t('error.protocolUnknownMethod'));
  assert.equal(i18n.describeError({ code: 'protocol/unknown-method', message: 'raw host text' }, en.t),
    en.t('error.protocolUnknownMethod'));
  assert.ok(zh.t('error.protocolUnknownMethod').includes('重启'), 'zh copy points at a DSH restart');
  assert.match(en.t('error.protocolUnknownMethod'), /restart/i);
  assert.notEqual(zh.t('error.protocolUnknownMethod'), zh.t('error.unknown'),
    'the version-mismatch copy is distinct from the generic unknown error');
  assert.notEqual(en.t('error.protocolUnknownMethod'), en.t('error.unknown'));
});

test('AI failure surfaces the protocol code/reason and never auto-retries', () => {
  // The generic "failed" row made production failures undiagnosable; the panel
  // must name the real code (and details.reason when present).
  assert.match(appSource, /nav\.aiFailedWithReason/);
  assert.match(appSource, /aiState\.notice === 'fallback' && aiState\.signature === entriesSignature/);
  const runtime = createClientRuntime();
  const i18n = runtime.require('i18n');
  const zh = i18n.createI18n('zh');
  const en = i18n.createI18n('en');
  const code = 'ai/unavailable:NO_ADAPTER';
  const zhText = zh.t('nav.aiFailedWithReason', { reason: zh.t('error.aiUnavailable'), code });
  const enText = en.t('nav.aiFailedWithReason', { reason: en.t('error.aiUnavailable'), code });
  assert.ok(zhText.includes(code), 'zh failure row must include the error code');
  assert.ok(enText.includes(code), 'en failure row must include the error code');
  assert.ok(zhText.includes(zh.t('error.aiUnavailable')));
  assert.ok(enText.includes(en.t('error.aiUnavailable')));
});

/* ------------------------------------------------------------------------- */
/* Multi-window review panel — state, stacking and target normalisation       */
/* ------------------------------------------------------------------------- */

test('normalizeTarget keeps the old open-panel target contract', () => {
  const runtime = createClientRuntime();
  const state = runtime.require('state');
  // Absent fields inherit the previous target; explicit null/'' clears one.
  assert.deepEqual(state.normalizeTarget({ sessionId: 'session-A', label: 'session' }),
    { sessionId: 'session-A', cwd: null, label: 'session' });
  assert.deepEqual(state.normalizeTarget({ sessionId: null, label: 'session' }),
    { sessionId: null, cwd: null, label: 'session' });
  assert.deepEqual(state.normalizeTarget({ sessionId: '', label: 'session' }),
    { sessionId: null, cwd: null, label: 'session' }, 'an empty session is explicit too');
  assert.deepEqual(state.normalizeTarget({ cwd: '/repo' }),
    { sessionId: null, cwd: '/repo', label: '' });
  assert.deepEqual(state.normalizeTarget({ cwd: '', label: 'x' }),
    { sessionId: null, cwd: null, label: 'x' }, 'an empty cwd clears the previous one');
  assert.deepEqual(state.normalizeTarget(undefined), { sessionId: null, cwd: null, label: '' });
});

test('windows are keyed by target: a session wins over cwd, otherwise cwd, else none', () => {
  const runtime = createClientRuntime();
  const state = runtime.require('state');
  assert.equal(state.windowKeyForTarget({ sessionId: 'session-A', cwd: '/repo' }), 'session:session-A');
  assert.equal(state.windowKeyForTarget({ sessionId: null, cwd: '/repo' }), 'cwd:/repo');
  assert.equal(state.windowKeyForTarget({ sessionId: '', cwd: '/repo' }), 'cwd:/repo');
  assert.equal(state.windowKeyForTarget({}), 'none');
  assert.equal(state.windowKeyForTarget(null), 'none');
});

test('openPanel normalizes targets: explicit null/empty clears, a missing field inherits', () => {
  const runtime = createClientRuntime();
  const state = runtime.require('state');
  const geometry = { x: 40, y: 60, width: 900, height: 620 };

  const firstId = state.openPanel({ sessionId: 'session-A', label: 'session' }, geometry);
  assert.match(firstId, /^review-window-\d+$/);
  assert.equal(state.windowStore.get().windows[0].target.sessionId, 'session-A');

  // A missing sessionId inherits the previous target -> focuses window A.
  assert.equal(state.openPanel({ label: 'session' }, geometry), firstId);
  assert.equal(state.windowStore.get().windows.length, 1);
  assert.equal(state.windowStore.get().windows[0].target.sessionId, 'session-A', 'a missing field inherits the previous session');

  // Explicit null clears the target and opens the session-less window.
  const noneId = state.openPanel({ sessionId: null }, geometry);
  assert.notEqual(noneId, firstId);
  assert.equal(state.windowStore.get().windows.length, 2);
  const noneWindow = state.windowStore.get().windows.find((win) => win.id === noneId);
  assert.equal(noneWindow.key, 'none');
  assert.equal(noneWindow.target.sessionId, null);

  // An empty string is explicit too: it re-focuses the session-less window.
  assert.equal(state.openPanel({ sessionId: '' }, geometry), noneId);
  assert.equal(state.windowStore.get().windows.length, 2);

  // A cwd-only target gets its own key and never inherits the session above.
  const cwdId = state.openPanel({ cwd: '/repo/cwd' }, geometry);
  const cwdWindow = state.windowStore.get().windows.find((win) => win.id === cwdId);
  assert.equal(cwdWindow.key, 'cwd:/repo/cwd');
  assert.equal(cwdWindow.target.sessionId, null);
});

test('the window manager focuses an open target instead of duplicating it', () => {
  const runtime = createClientRuntime();
  const state = runtime.require('state');
  const firstGeometry = { x: 40, y: 60, width: 900, height: 620 };
  const secondGeometry = { x: 120, y: 140, width: 1000, height: 700 };

  const firstId = state.openPanel({ sessionId: 'session-A', label: 'session' }, firstGeometry);
  const created = state.windowStore.get().windows[0];
  assert.equal(created.id, firstId);
  assert.equal(created.seq, created.openToken, 'seq/openToken record the creation order');
  assert.equal(created.focusToken, 0);
  assert.equal(created.minimized, false);
  assert.equal(created.maximized, false);
  assert.equal(created.restore, null);
  assert.deepEqual(
    { x: created.x, y: created.y, width: created.width, height: created.height },
    firstGeometry,
    'a new window starts at the geometry it was opened with',
  );

  // Same target: focus + restore, one window, live geometry untouched.
  state.patchWindow(firstId, { minimized: true });
  assert.equal(state.openPanel({ sessionId: 'session-A' }, secondGeometry), firstId);
  let store = state.windowStore.get();
  assert.equal(store.windows.length, 1);
  assert.equal(store.focusedId, firstId);
  const reopened = store.windows[0];
  assert.equal(reopened.minimized, false, 'reopening restores a minimized window');
  assert.equal(reopened.focusToken, created.focusToken + 1, 'reopening bumps focusToken');
  assert.equal(reopened.openToken, created.openToken, 'reopening keeps the open token');
  assert.equal(reopened.seq, created.seq, 'seq stays stable across reopen');
  assert.deepEqual(
    { x: reopened.x, y: reopened.y, width: reopened.width, height: reopened.height },
    firstGeometry,
    'reopening never resets the geometry the user dragged/resized to',
  );

  // A different target gets its own independent window on top of the stack.
  const secondId = state.openPanel({ sessionId: 'session-B' }, secondGeometry);
  store = state.windowStore.get();
  assert.equal(store.windows.length, 2);
  assert.notEqual(secondId, firstId);
  assert.equal(store.focusedId, secondId, 'the new window takes focus');
  assert.deepEqual(store.windows.map((win) => win.id), [firstId, secondId], 'the last window is the stacking top');
  assert.ok(store.windows[1].seq > store.windows[0].seq, 'the newer window has the higher seq');
  assert.equal(new Set(store.windows.map((win) => win.key)).size, 2);
  assert.equal(state.hasWindowFor('session-A'), true);
  assert.equal(state.hasWindowFor('session-B'), true);
  assert.equal(state.hasWindowFor('session-C'), false);
  assert.equal(state.hasWindowFor(null), false);
});

test('focusWindow / closeWindow / patchWindow keep the stacking order and focus consistent', () => {
  const runtime = createClientRuntime();
  const state = runtime.require('state');
  const geometry = { x: 16, y: 16, width: 900, height: 600 };
  const [a, b, c] = ['A', 'B', 'C'].map((name) => state.openPanel({ sessionId: 'session-' + name }, geometry));
  const byId = (id) => state.windowStore.get().windows.find((win) => win.id === id);
  const seqById = new Map([a, b, c].map((id) => [id, byId(id).seq]));

  // patchWindow merges its own window only and keeps the focused window.
  state.patchWindow(b, { minimized: true, width: 1234 });
  assert.equal(byId(b).minimized, true);
  assert.equal(byId(b).width, 1234);
  assert.equal(byId(b).height, 600, 'a partial patch keeps the other geometry');
  assert.equal(state.windowStore.get().focusedId, c);

  // Unknown ids are no-ops: the store snapshot is not replaced.
  const stable = state.windowStore.get();
  state.patchWindow('missing', { minimized: true });
  state.closeWindow('missing');
  state.focusWindow('missing');
  assert.equal(state.windowStore.get(), stable);

  // focusWindow raises an older window to the top without changing creation order.
  state.focusWindow(a);
  assert.equal(state.windowStore.get().focusedId, a);
  assert.deepEqual(state.windowStore.get().windows.map((win) => win.id), [b, c, a]);
  assert.deepEqual(
    state.windowStore.get().windows.map((win) => win.seq),
    [seqById.get(b), seqById.get(c), seqById.get(a)],
    'seq is the stable creation order, the array is the stacking order',
  );
  // Focusing the already-top window is a no-op.
  const top = state.windowStore.get();
  state.focusWindow(a);
  assert.equal(state.windowStore.get(), top);

  // Closing the focused window focuses the next-lower window (the new last).
  state.closeWindow(a);
  assert.equal(state.windowStore.get().focusedId, c);
  assert.deepEqual(state.windowStore.get().windows.map((win) => win.id), [b, c]);
  // Closing a background window leaves focus alone.
  state.patchWindow(c, { minimized: false });
  state.closeWindow(b);
  assert.equal(state.windowStore.get().focusedId, c);
  // Closing the last window clears focus.
  state.closeWindow(c);
  assert.deepEqual(state.windowStore.get(), { windows: [], focusedId: null });
  assert.equal(state.hasWindowFor('session-C'), false);
});

/* ------------------------------------------------------------------------- */
/* Multi-window review panel — pure geometry helpers                          */
/* ------------------------------------------------------------------------- */

test('window geometry helpers are pure and exported for the source tests', () => {
  const app = createClientRuntime().require('app');
  for (const name of ['clampWindowSize', 'clampWindowRect', 'clampMinimizedWindowRect', 'dragWindowRect', 'resizeWindowRect',
    'defaultWindowGeometry', 'maximizedWindowGeometry', 'windowGeometryForOpen', 'rememberWindowGeometry']) {
    assert.equal(typeof app[name], 'function', `app.${name} must stay exported for tests`);
  }
  for (const key of ['margin', 'cascadeStep', 'headHeight', 'minWidth', 'minHeight']) {
    assert.ok(Number.isFinite(app.WINDOW_LIMITS[key]) && app.WINDOW_LIMITS[key] > 0,
      `WINDOW_LIMITS.${key} must be a positive number`);
  }
});

test('clamped rectangles stay inside the viewport and honor the minimum size', () => {
  const app = createClientRuntime().require('app');
  const limits = app.WINDOW_LIMITS;
  const viewports = [[1600, 1000], [1280, 800], [1024, 768], [900, 600]];
  for (const [width, height] of viewports) {
    const viewport = { width, height };
    const availableWidth = width - limits.margin * 2;
    const availableHeight = height - limits.margin * 2;
    const minWidth = Math.min(limits.minWidth, availableWidth);
    const minHeight = Math.min(limits.minHeight, availableHeight);
    const rects = [
      { x: -5000, y: -5000, width: 99999, height: 99999 },
      { x: 5000, y: 5000, width: 10, height: 10 },
      { x: 100, y: 120, width: 900, height: 600 },
      { x: 123.6, y: 88.2, width: 1011.4, height: 733.9 },
    ];
    for (const rect of rects) {
      const out = app.clampWindowRect(rect, viewport);
      const label = `${width}x${height} rect ${JSON.stringify(rect)}`;
      assert.ok(out.x >= limits.margin && out.y >= limits.margin, `margin kept: ${label}`);
      assert.ok(out.x + out.width <= width - limits.margin, `right edge inside: ${label}`);
      assert.ok(out.y + out.height <= height - limits.margin, `bottom edge inside: ${label}`);
      assert.ok(out.width >= minWidth && out.height >= minHeight, `minimum size kept: ${label}`);
      assert.ok(out.width <= availableWidth && out.height <= availableHeight, `never larger than the viewport: ${label}`);
      assert.equal(Number.isInteger(out.x) && Number.isInteger(out.y), true, `integer origin: ${label}`);
    }
  }
  // Size clamping is independent of the position clamp.
  assert.deepEqual(app.clampWindowSize(99999, 99999, { width: 1280, height: 800 }),
    { width: 1280 - limits.margin * 2, height: 800 - limits.margin * 2 });
  assert.deepEqual(app.clampWindowSize(NaN, undefined, { width: 1280, height: 800 }),
    { width: limits.minWidth, height: limits.minHeight }, 'missing sizes fall back to the minimum');
});

test('default geometry fits the viewport and cascades by a fixed step', () => {
  const app = createClientRuntime().require('app');
  const limits = app.WINDOW_LIMITS;
  const viewport = { width: 1600, height: 1000 };
  const first = app.defaultWindowGeometry(viewport, 0);
  const second = app.defaultWindowGeometry(viewport, 1);
  const third = app.defaultWindowGeometry(viewport, 2);
  for (const rect of [first, second, third]) {
    assert.ok(rect.x >= limits.margin && rect.y >= limits.margin);
    assert.ok(rect.x + rect.width <= viewport.width - limits.margin);
    assert.ok(rect.y + rect.height <= viewport.height - limits.margin);
    assert.ok(rect.width >= limits.minWidth && rect.height >= limits.minHeight);
  }
  assert.equal(second.width, first.width, 'the cascade keeps the size');
  assert.equal(second.height, first.height);
  // New windows take 85% of the DSH window (the plugin viewport) by default.
  assert.equal(first.width, Math.round(viewport.width * 0.85), 'default width is 85% of the viewport');
  assert.equal(first.height, Math.round(viewport.height * 0.85), 'default height is 85% of the viewport');
  assert.equal(second.x - first.x, limits.cascadeStep, 'each window is offset by one cascade step');
  assert.equal(second.y - first.y, limits.cascadeStep);
  assert.equal(third.x - second.x, limits.cascadeStep);
  // The cascade wraps after five steps so later windows are not pushed off frame.
  assert.deepEqual(app.defaultWindowGeometry(viewport, 5), first);
  assert.deepEqual(app.defaultWindowGeometry(viewport, -2), first, 'negative indexes cascade from zero');
  assert.deepEqual(app.defaultWindowGeometry(viewport, NaN), first, 'non-numeric indexes cascade from zero');
});

test('drag keeps the window fully inside the work area', () => {
  const app = createClientRuntime().require('app');
  const viewport = { width: 1280, height: 800 };
  const rect = { x: 200, y: 150, width: 900, height: 600 };

  assert.deepEqual(app.dragWindowRect(rect, 0, 0, viewport), rect, 'no delta is a no-op');
  const farRight = app.dragWindowRect(rect, 5000, 0, viewport);
  assert.equal(farRight.x, viewport.width - rect.width, 'the right edge stops at the work-area edge');
  assert.equal(farRight.width, rect.width);
  const farLeft = app.dragWindowRect(rect, -5000, 0, viewport);
  assert.equal(farLeft.x, 0, 'the left edge stops at the work-area edge');
  const farDown = app.dragWindowRect(rect, 0, 5000, viewport);
  assert.equal(farDown.y, viewport.height - rect.height, 'the bottom edge stops at the work-area edge');
  assert.equal(app.dragWindowRect(rect, 0, -5000, viewport).y, 0,
    'the title bar never slides under the DSH frame strip');
  assert.equal(farDown.height, rect.height);
  // A window larger than the work area is pinned at the origin rather than
  // pushed to a negative position.
  assert.deepEqual(app.dragWindowRect({ x: 0, y: 0, width: 1400, height: 900 }, 10, 10, viewport),
    { x: 0, y: 0, width: 1400, height: 900 });

  const east = app.resizeWindowRect(rect, 200, 999, 'e', viewport);
  assert.deepEqual(east, { x: rect.x, y: rect.y, width: viewport.width - rect.x, height: rect.height },
    'east ignores vertical input and stops at the right work-area edge');
  const south = app.resizeWindowRect(rect, 999, 100, 's', viewport);
  assert.deepEqual(south, { x: rect.x, y: rect.y, width: rect.width, height: viewport.height - rect.y },
    'south ignores horizontal input and stops at the bottom work-area edge');
  const corner = app.resizeWindowRect(rect, 5000, 5000, 'se', viewport);
  assert.deepEqual(corner, {
    x: rect.x,
    y: rect.y,
    width: viewport.width - rect.x,
    height: viewport.height - rect.y,
  }, 'a corner resize stops at the work-area bounds from the pinned origin');
  const shrunk = app.resizeWindowRect(rect, -5000, -5000, 'se', viewport);
  assert.deepEqual(shrunk, { x: rect.x, y: rect.y, width: app.WINDOW_LIMITS.minWidth, height: app.WINDOW_LIMITS.minHeight });
  assert.equal(east.x, rect.x);
  assert.equal(south.y, rect.y);
});

test('a minimized window drags against its title strip, not its restore height', () => {
  const app = createClientRuntime().require('app');
  const limits = app.WINDOW_LIMITS;
  const viewport = { width: 1280, height: 800 };
  const rect = { x: 200, y: 150, width: 900, height: 700 };

  // A minimized window only occupies its title strip on screen, so it can be
  // dragged all the way to the bottom edge of the work area...
  const bottom = app.clampMinimizedWindowRect({ ...rect, y: 5000 }, viewport);
  assert.equal(bottom.y, viewport.height - limits.headHeight,
    'the strip may reach the bottom work-area edge');
  // ...and up to the top edge, while the stored restore size survives.
  assert.equal(app.clampMinimizedWindowRect({ ...rect, y: -5000 }, viewport).y, 0,
    'the strip never slides under the DSH frame strip');
  assert.equal(bottom.width, rect.width);
  assert.equal(bottom.height, rect.height, 'the stored height is the restore size, not the strip height');
  // Restoring that strip goes through the full-window clamp again, so the
  // restored window is fully visible instead of growing off screen.
  const restored = app.clampWindowRect({ ...rect, y: bottom.y }, viewport);
  assert.equal(restored.y, viewport.height - limits.margin - rect.height);
  assert.equal(restored.height, rect.height);
  // The horizontal clamp keeps using the full width; an oversized stored width
  // is clamped for the live area as well.
  assert.equal(app.clampMinimizedWindowRect({ ...rect, x: 5000 }, viewport).x, viewport.width - rect.width);
  assert.equal(app.clampMinimizedWindowRect({ x: 0, y: 0, width: 99999, height: 700 }, viewport).width,
    viewport.width - limits.margin * 2);
});

test('the work area starts below the DSH frame title strip', () => {
  const app = createClientRuntime().require('app');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.document = { documentElement: {} };
  globalThis.window = {
    innerWidth: 1600,
    innerHeight: 1000,
    getComputedStyle: () => ({
      getPropertyValue: (name) => (name === '--dsh-frame-top-clearance' ? '40px' : ''),
    }),
  };
  try {
    assert.equal(app.frameTopInset(), 40, 'the frame clearance token is read from the root element');
    assert.deepEqual(app.viewportSize(), { width: 1600, height: 960 },
      'the viewport used by the window geometry excludes the DSH title strip');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  // Plain browser documents publish no clearance token: the work area is the viewport.
  assert.equal(app.frameTopInset(), 0);
});

test('maximized geometry fills the DSH work area edge to edge', () => {
  const app = createClientRuntime().require('app');
  for (const viewport of [{ width: 1600, height: 1000 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }]) {
    assert.deepEqual(app.maximizedWindowGeometry(viewport), {
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    }, `maximized ${viewport.width}x${viewport.height}`);
  }
});

test('remembered geometry survives reopen and is re-clamped to the current viewport', () => {
  const app = createClientRuntime().require('app');
  withViewport({ width: 1600, height: 1000 }, () => {
    const fresh = app.windowGeometryForOpen('session:session-A', 0);
    assert.deepEqual(fresh, app.defaultWindowGeometry({ width: 1600, height: 1000 }, 0),
      'a target without remembered geometry gets the cascaded default');
    app.rememberWindowGeometry('session:session-A', { x: 300, y: 120, width: 900, height: 600 });
    assert.deepEqual(app.windowGeometryForOpen('session:session-A', 4),
      { x: 300, y: 120, width: 900, height: 600 }, 'a reopened window keeps its remembered geometry');
    assert.deepEqual(app.windowGeometryForOpen('session:session-B', 0), fresh,
      'geometry is remembered per target key');
  });
  // A viewport change re-clamps the remembered rectangle instead of restoring it off-screen.
  withViewport({ width: 1000, height: 700 }, () => {
    const clamped = app.windowGeometryForOpen('session:session-A', 4);
    assert.ok(clamped.x >= 16 && clamped.y >= 16, 're-clamped geometry keeps the margin');
    assert.ok(clamped.x + clamped.width <= 1000 - 16, 're-clamped geometry stays inside the smaller viewport');
    assert.ok(clamped.y + clamped.height <= 700 - 16);
  });
  // Invalid input is ignored instead of stored.
  app.rememberWindowGeometry('', { x: 1, y: 2, width: 3, height: 4 });
  app.rememberWindowGeometry('session:session-C', null);
  withViewport({ width: 1600, height: 1000 }, () => {
    assert.deepEqual(app.windowGeometryForOpen('session:session-C', 0),
      app.defaultWindowGeometry({ width: 1600, height: 1000 }, 0));
  });
});

/* ------------------------------------------------------------------------- */
/* Settings dialog — DSH-native row layout                                   */
/* ------------------------------------------------------------------------- */

test('settings dialog uses DSH-style rows, controls and switch geometry', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const i18n = runtime.require('i18n');
  const t = i18n.createI18n('zh');
  const tree = components.PanelSettings({
    t: t.t,
    settings: { aiClassify: true, maxCandidates: 50, preclassify: false, locale: 'zh' },
    saving: false,
    modelsInfo: {
      routes: [{ provider: 'deepseek-account', providerName: 'DeepSeek Account', model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }],
      sessionModel: { provider: 'deepseek-account', model: 'deepseek-flash' },
    },
    onChange: function () {},
  });
  const componentTypes = [];
  walkElements(tree, function (element) {
    if (typeof element.type === 'function') componentTypes.push(element.type.name);
  });
  const countOf = function (name) {
    return componentTypes.filter(function (value) { return value === name; }).length;
  };
  assert.ok(countOf('SettingRow') >= 4, 'settings are rendered as DSH-style rows');
  assert.ok(countOf('SettingRow') === 5, 'five setting rows are rendered');
  assert.ok(countOf('SettingRow') >= countOf('SettingSection') + 2, 'rows live inside sections');
  assert.ok(countOf('SettingSection') >= 2, 'AI grouping and interface are separate sections');
  assert.ok(componentTypes.includes('Switch'), 'pre-classify renders as the themed switch');
  assert.ok(componentTypes.includes('Select'), 'the language row renders as the themed dropdown');
  assert.ok(componentTypes.includes('ModelPicker'), 'the model row renders as the model/reasoning picker');
  assert.ok(componentTypes.includes('Textarea'), 'the prompt field uses the shared textarea');
  assert.ok(componentTypes.includes('TextField'), 'the candidate cap uses the shared number field');

  // The shared kit is the single implementation: composed components re-export
  // its primitives instead of carrying duplicates.
  const ui = runtime.require('ui');
  const componentsModule = runtime.require('components');
  assert.equal(componentsModule.Button, ui.Button);
  assert.equal(componentsModule.IconButton, ui.IconButton);
  assert.equal(componentsModule.Spinner, ui.Spinner);
  assert.equal(typeof ui.Modal, 'function');
  assert.equal(typeof ui.Select, 'function');
  assert.equal(typeof ui.Switch, 'function');
  assert.equal(typeof ui.TextField, 'function');
  assert.equal(typeof ui.Textarea, 'function');
  assert.equal(typeof ui.SettingRow, 'function');
  assert.equal(typeof ui.SettingSection, 'function');

  // Geometry copied from DSH's own settings CSS modules.
  assert.match(stylesSource, /\.gr-setting-row \{[^}]*justify-content: space-between/);
  assert.match(stylesSource, /\.gr-setting-row \{[^}]*padding: 16px 0/);
  assert.match(stylesSource, /\.gr-switch \{[^}]*width: 36px/);
  assert.match(stylesSource, /\.gr-switch \{[^}]*height: 20px/);
  assert.match(stylesSource, /\.gr-setting-control-switch \{[^}]*min-width: 60px/);
  assert.match(stylesSource, /\.gr-modal \{ display: flex[^}]*border-radius: var\(--dsw-radius-panel/);

  // Control state precedence: hover uses a neutral border only while unfocused,
  // so a focused field keeps the DSH business border even under the mouse.
  assert.ok(!/\.gr-settings \.gr-textarea:hover \{/.test(stylesSource),
    'settings must not override the focus border with a hover selector');
  assert.match(stylesSource, /\.gr-textarea:hover:not\(:disabled\):not\(:focus\):not\(:focus-visible\)/);
  assert.match(stylesSource, /\.gr-input:hover:not\(:disabled\):not\(:focus\):not\(:focus-visible\)/);
  assert.match(stylesSource, /\.gr-combo-trigger:hover:not\(:disabled\) \{/);
});

/* ------------------------------------------------------------------------- */
/* Shared-kit layout and interaction contracts                               */
/* ------------------------------------------------------------------------- */

test('the grouping selector offers the three modes through the shared Select', () => {
  const runtime = createClientRuntime();
  const ui = runtime.require('ui');
  const components = runtime.require('components');
  const t = runtime.require('i18n').createI18n('zh').t;
  const picked = [];
  const render = (extra) => components.TopBar(Object.assign({
    t,
    status: { repo: null, summary: null },
    repo: null,
    onChangeGrouping: (value) => { picked.push(value); },
  }, extra));
  const selectOf = (tree) => collectElements(tree).find((element) => element.type === ui.Select);

  // Git mode: the selector is present and marks Git status as the active option.
  const git = selectOf(render({ aiMode: false, aiGrouping: 'role' }));
  assert.ok(git, 'the toolbar replaces the Git/AI toggle with the shared Select');
  assert.equal(git.props.className, 'gr-topbar-grouping', 'the compact selector owns the toolbar class');
  assert.equal(git.props.value, 'git');
  assert.equal(git.props.ariaLabel, t('nav.grouping'));
  assert.deepEqual(git.props.options.map((option) => option.value), ['git', 'role', 'logic'],
    'the menu lists Git status and the two AI grouping modes');
  assert.deepEqual(git.props.options.map((option) => option.label),
    [t('nav.gitGroups'), t('nav.aiGroupsRole'), t('nav.aiGroupsLogic')]);
  assert.deepEqual(git.props.options.map((option) => option.title),
    [t('nav.gitGroupsHint'), t('nav.aiGroupsRoleHint'), t('nav.aiGroupsLogicHint')],
    'the option descriptions become the listbox row tooltips');
  // Anchored listbox: the toolbar is a size container, so a fixed layer would be
  // contained and clipped by it.
  assert.equal(git.props.anchorMenu, true);

  // The AI modes surface the persisted mode they belong to.
  const role = selectOf(render({ aiMode: true, aiGrouping: 'role' }));
  assert.equal(role.props.value, 'role');
  const logic = selectOf(render({ aiMode: true, aiGrouping: 'logic' }));
  assert.equal(logic.props.value, 'logic');

  // Choosing an option reports the option value; only a different mode is sent.
  picked.length = 0;
  role.props.onChange('logic');
  role.props.onChange('role');
  assert.deepEqual(picked, ['logic'], 're-selecting the active mode is a no-op');

  // A classify request may be running (`aiBusy`) without locking the selector:
  // users can switch grouping off mid-request and the host aborts it.
  assert.equal(selectOf(render({ aiMode: true, aiBusy: true })).props.disabled, undefined);
  // A Git write does.
  assert.equal(selectOf(render({ aiMode: false, busy: true })).props.disabled, true);

  // The shared kit stays the single implementation: the toolbar selector is the
  // same ui.Select primitive the settings dialog uses, not a bespoke dropdown.
  assert.equal(git.type, ui.Select, 'the toolbar renders the shared Select');
  assert.match(stylesSource, /\.gr-topbar \.gr-topbar-grouping \.gr-combo-trigger \{[^}]*height: 28px/,
    'the toolbar trigger is compact enough for the action row');
  assert.match(stylesSource, /\.gr-combo-menu-anchor \{[^}]*position: absolute/,
    'the toolbar listbox is anchored instead of viewport-fixed');
});

test('settings disclosure retains the full data, operation and fallback explanations', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  for (const locale of ['zh', 'en']) {
    const t = runtime.require('i18n').createI18n(locale).t;
    const tree = components.PanelSettings({ t, settings: {} });
    const disclosure = collectElements(tree).find((element) => element.type === 'details');
    assert.ok(disclosure);
    assert.equal(disclosure.props.open, undefined, 'long explanations start collapsed');
    assert.ok(collectText(disclosure).includes(t('ai.settingsDetails')));
    const summary = collectElements(disclosure).find((element) => element.type === 'summary');
    assert.ok(summary, 'the disclosure has a summary row');
    assert.ok(collectElements(summary).some((element) => element.props.className === 'gr-settings-note-chevron'),
      'the native marker is replaced by the shared Lucide chevron');
    for (const key of ['ai.settingsDataNotice', 'ai.settingsScopeNotice', 'ai.settingsOffNote']) {
      assert.ok(collectText(disclosure).includes(t(key)), `${locale}: missing ${key}`);
    }
    // The settings page explains where the three-way grouping selector lives;
    // the old copy described a two-state toggle in the toolbar.
    assert.ok(collectText(tree).includes(t('ai.settingsSwitchHint')), `${locale}: grouping selector hint`);
  }
  assert.match(stylesSource, /\.gr-settings-note-summary::-webkit-details-marker \{ display: none; \}/);
  assert.match(stylesSource, /\.gr-settings-note\[open\] \.gr-settings-note-chevron \{ transform: rotate\(90deg\)/);
});

test('commit drawer carries the message draft and the split commit action', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const ui = runtime.require('ui');
  const t = runtime.require('i18n').createI18n('en').t;
  let toggles = 0;
  let drafts = 0;
  const base = {
    t, message: 'msg', count: 2,
    onToggle: () => { toggles += 1; },
    onGenerate: () => { drafts += 1; },
    commitMode: 'commit',
    commitBusy: false,
    commitGenerating: false,
    commitCanRun: true,
    commitReasons: [],
    onCommit: () => {},
    onChangeCommitMode: () => {},
  };

  // Collapsed by default: only the header row (title, count, toggle) is there.
  const closed = components.CommitPanel(Object.assign({}, base, { open: false, canGenerate: false }));
  const closedElements = collectElements(closed);
  assert.equal(closedElements.some((element) => element.type === ui.Textarea), false, 'collapsed drawer has no message field');
  assert.ok(collectText(closed).includes(t('commit.checkedFiles', { n: 2 })), 'the checked-file count is in the header');
  // The old always-visible blocking-reason line is gone.
  assert.equal(collectText(closed).includes(t('commit.nothingChecked')), false, 'no blocking-reason line');
  assert.equal(collectText(closed).includes(t('commit.messageRequired')), false, 'no blocking-reason line');
  assert.equal(closedElements.some((element) => String(element.props.className || '').includes('gr-commit-body')), false);
  const toggle = closedElements.find((element) => element.type === 'button' && element.props.className === 'gr-commit-toggle');
  assert.ok(toggle, 'the header row toggles the drawer');
  toggle.props.onClick();
  assert.equal(toggles, 1);

  // Expanded: a multi-line textarea plus the AI draft action and the split
  // commit action (a raw button inside its own split control, not a plain
  // primary Button). The message box binds no keyboard commit shortcut.
  for (const [busy, canGenerate, generateBusy] of [
    [false, true, false],
    [false, false, false],
    [true, true, true],
  ]) {
    const tree = components.CommitPanel(Object.assign({}, base, { open: true, busy, canGenerate, generateBusy }));
    const elements = collectElements(tree);
    const field = elements.find((element) => element.type === ui.Textarea
      && element.props.ariaLabel === t('a11y.commitMessage'));
    assert.ok(field, 'the commit message field is a textarea');
    assert.equal(field.props.rows, 3, 'the message box is multi-line');
    assert.equal(field.props.onKeyDown, undefined, 'the message box binds no keyboard commit shortcut');
    assert.equal(elements.some((element) => element.type === ui.Button && element.props.variant === 'primary'), false,
      'the commit action is a split control, never a plain primary button');
    const draft = elements.find((element) => element.type === ui.IconButton && element.props.label === t('commit.generate'));
    assert.ok(draft, 'the AI draft action is rendered');
    assert.equal(draft.props.busy, generateBusy);
    assert.equal(ui.IconButton(draft.props).props.disabled, !canGenerate || busy ? true : undefined);
    // The tooltip is only the action name — no long explanation, no reason list.
    assert.equal(draft.props.title, undefined, 'the panel passes no long tooltip');
    const draftButton = ui.IconButton(draft.props);
    assert.equal(draftButton.props.title, t('commit.generate'), 'the tooltip is the action name');
    assert.equal(draftButton.props['aria-label'], t('commit.generate'));
    const row = elements.find((element) => element.props.className === 'gr-commit-actions');
    assert.ok(row, 'the actions are grouped');
    const rowChildren = Array.isArray(row.props.children) ? row.props.children : [row.props.children];
    const children = rowChildren.filter(Boolean);
    assert.equal(children.length, 2, 'the drawer action row holds the AI draft and the split commit action');
    assert.equal(children[0].type, ui.IconButton, 'the AI draft stays on the left');
    assert.equal(children[1].type, components.CommitAction, 'the commit split action sits on the right');
    assert.equal(children[1].props.mode, 'commit');
    assert.equal(children[1].props.onCommit, base.onCommit);
  }

  const expanded = components.CommitPanel(Object.assign({}, base, { open: true, canGenerate: true }));
  const expandedElements = collectElements(expanded);
  const draft = expandedElements.find((element) => element.type === ui.IconButton && element.props.label === t('commit.generate'));
  draft.props.onClick();
  assert.equal(drafts, 1, 'the draft action calls onGenerate');

  // Source-level guard: the drawer wires the split action and the old plain
  // commit button / primary label stay gone.
  const panelStart = componentsSource.indexOf('function CommitPanel(');
  const panelEnd = componentsSource.indexOf('function PushDialog(', panelStart);
  assert.ok(panelStart !== -1 && panelEnd > panelStart, 'CommitPanel source region is discoverable');
  const panelSource = componentsSource.slice(panelStart, panelEnd);
  for (const token of ["t('commit.action')", 'commitTitle', 'canCommit']) {
    assert.equal(panelSource.includes(token), false, `CommitPanel must not reference ${token}`);
  }
  assert.ok(panelSource.includes('h(CommitAction, {'), 'CommitPanel renders the split commit action');
});

/* ------------------------------------------------------------------------- */
/* Base buttons — DSH variant hover contract                                 */
/* ------------------------------------------------------------------------- */

test('base buttons keep the DSH variant hover contract', () => {
  const runtime = createClientRuntime();
  const ui = runtime.require('ui');
  const components = runtime.require('components');

  // The shared kit stays the single implementation.
  assert.equal(components.Button, ui.Button);
  assert.equal(components.IconButton, ui.IconButton);
  assert.equal(components.LinkButton, ui.LinkButton);
  assert.equal(typeof ui.Checkbox, 'function');

  // A variant-blind hover rule used to repaint the primary fill with the neutral
  // hover colour while the foreground label kept its light colour (the label
  // disappeared into the button). Hover must stay variant-specific.
  assert.equal(/\.gr-btn:hover:not\(/.test(stylesSource), false,
    'no hover rule may target every button variant');
  assert.match(stylesSource, /\.gr-btn-primary:hover:not\(:disabled\) \{[^}]*--dsw-alias-button-primary-hover/,
    'the solid button hovers with the dedicated primary-hover token');
  assert.match(stylesSource, /\.gr-btn-primary \{[^}]*--dsw-alias-label-primary-foreground/,
    'the solid button label uses the foreground token');
  assert.match(stylesSource, /\.gr-btn-default:hover:not\(:disabled\) \{[^}]*--dsw-alias-interactive-bg-hover/,
    'the normal/outline button hovers with the neutral interactive token');
  assert.match(stylesSource, /\.gr-btn \{ display: inline-flex[^}]*height: 36px/);
  assert.match(stylesSource, /\.gr-btn-sm \{[^}]*height: 28px/);

  // Standard action buttons come from the shared components; the remaining raw
  // <button> elements are specialized list/menu controls.
  assert.match(componentsSource, /h\(IconButton, \{\s*label: t\('nav\.locate'\)/,
    'file-navigation bulk actions use the shared IconButton');
  assert.match(componentsSource, /h\(LinkButton, \{ className: 'gr-empty-nav-action'/,
    'the empty-navigation action uses the shared LinkButton');
});

test('diff headers localize known comparison sources and preserve custom refs', () => {
  const runtime = createClientRuntime();
  const DiffPane = runtime.require('diff-view').DiffPane;
  for (const locale of ['zh', 'en']) {
    const t = runtime.require('i18n').createI18n(locale).t;
    for (const [raw, key] of [
      ['Empty', 'diff.sourceEmpty'], ['Index', 'diff.sourceIndex'],
      ['Worktree', 'diff.sourceWorktree'], ['Untracked', 'status.untracked'],
      ['Index (ours)', 'diff.sourceOurs'], ['HEAD', null], ['feature/review', null],
      ['toString', null],
    ]) {
      const tree = DiffPane({
        t, entry: { key: 'unstaged:a', path: 'a', status: 'unstaged', change: 'modified' },
        entryDiff: { base: { label: raw }, target: { label: raw }, hunks: [] },
      });
      const sources = collectElements(tree).find((element) => element.props.className === 'gr-diff-sources');
      const label = key ? t(key) : raw;
      assert.ok(collectText(sources).includes(t('diff.base', { label })), `${locale}: base ${raw}`);
      assert.ok(collectText(sources).includes(t('diff.target', { label })), `${locale}: target ${raw}`);
    }
  }
});

/* ------------------------------------------------------------------------- */
/* Diff row focus — keyboard-only ring, painted above the sticky gutters     */
/* ------------------------------------------------------------------------- */

test('diff rows paint the focus ring for keyboard focus only', () => {
  // A click focuses the row so arrow keys can keep walking lines, but a pointer
  // click must not leave a selection-looking box behind.
  assert.match(diffViewSource, /onClick: function \(event\) \{[\s\S]{0,600}?event\.currentTarget\.focus\(\)/,
    'the click handler must still focus the row for follow-up arrow navigation');
  assert.match(stylesSource, /\.gr-diff-row:focus \{ outline: none; \}/,
    'pointer focus must not paint the row outline');
  assert.equal(/\.gr-diff-row:focus \{[^}]*outline: 2px/.test(stylesSource), false,
    'the row outline belongs to :focus-visible, not :focus');
  // An overlay ring paints above the opaque sticky gutters (z-index 1); a plain
  // outline is masked by them and shows as two disconnected fragments.
  assert.match(stylesSource, /\.gr-diff-row:focus-visible::after \{[^}]*z-index: 2/);
  assert.match(stylesSource, /\.gr-diff-row:focus-visible::after \{[^}]*outline-offset: -2px/);
});

/* ------------------------------------------------------------------------- */
/* TopBar grouping selector — the compact trigger names the active mode      */
/* ------------------------------------------------------------------------- */

test('the grouping trigger shows the active mode label and a chevron', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const ui = runtime.require('ui');
  const t = runtime.require('i18n').createI18n('zh').t;
  const base = {
    t,
    status: { repo: null, summary: null },
    repo: null,
    onChangeGrouping: function () {},
    onRefresh: function () {},
    onOpenPush: function () {},
  };

  function renderTrigger(extra) {
    const tree = components.TopBar(Object.assign({}, base, extra));
    const element = collectElements(tree).find((candidate) => candidate.type === ui.Select);
    assert.ok(element, 'the grouping selector is missing from the toolbar');
    return ui.Select(element.props); // render the Select one level
  }

  // Git status is the default grouping and is named on the trigger.
  const git = renderTrigger({ aiMode: false });
  const gitTrigger = collectElements(git).find((element) => elementClasses(element).includes('gr-combo-trigger'));
  assert.ok(gitTrigger, 'the selector renders a themed trigger');
  assert.equal(collectText(git), t('nav.gitGroups'));
  assert.equal(gitTrigger.props['aria-label'], t('nav.grouping'));
  assert.equal(gitTrigger.props['aria-haspopup'], 'listbox');
  const chevron = collectElements(gitTrigger).find((element) => elementClasses(element).includes('gr-combo-chevron'));
  assert.ok(chevron, 'the compact trigger carries the DSH menu chevron');
  assert.equal(gitTrigger.props.title, undefined, 'the mode explanation lives on the menu options, not the trigger');

  // The AI modes name themselves, so users can tell role and logic apart at a
  // glance without opening the menu.
  const role = renderTrigger({ aiMode: true, aiGrouping: 'role' });
  assert.equal(collectText(role), t('nav.aiGroupsRole'));
  const logic = renderTrigger({ aiMode: true, aiGrouping: 'logic' });
  assert.equal(collectText(logic), t('nav.aiGroupsLogic'));
  assert.notEqual(t('nav.aiGroupsRole'), t('nav.aiGroupsLogic'));

  // The old toggle (a single pressed button) is gone: the toolbar renders no
  // `gr-btn-ai` element any more.
  assert.equal(elementsByClass(components.TopBar(Object.assign({}, base, { aiMode: true })), 'gr-btn-ai').length, 0);
});

/* ------------------------------------------------------------------------- */
/* Toolbar — bulk ± moved to the file header; reclassify gets its own glyph  */
/* ------------------------------------------------------------------------- */

test('the toolbar no longer renders stage-all/unstage-all bulk buttons', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const t = runtime.require('i18n').createI18n('zh').t;
  const tree = components.TopBar({
    t,
    aiMode: true,
    aiGrouping: 'role',
    busy: false,
    status: { repo: null, summary: null },
    repo: null,
    onChangeGrouping: () => {},
    onReclassify: () => {},
    onRefresh: () => {},
    onOpenPush: () => {},
  });
  const elements = collectElements(tree);
  const labels = elements
    .map((element) => element.props['aria-label'] || element.props.label || element.props.title)
    .filter((label) => typeof label === 'string');
  assert.equal(labels.includes(t('actions.stageAll')), false,
    'stage-all moved to the file navigation select-all');
  assert.equal(labels.includes(t('actions.unstageAll')), false,
    'unstage-all moved to the file navigation select-all');
  assert.equal(elements.some((element) => typeof element.type === 'function'
    && (element.type.name === 'IconPlus' || element.type.name === 'IconMinus')), false,
  'the +/− glyphs are gone from the toolbar');
  // Refresh and push remain the toolbar's operation controls.
  assert.ok(elements.some((element) => element.props.label === t('actions.refresh')));
  assert.ok(elements.some((element) => elementClasses(element).includes('gr-topbar-push')));

  const topBarStart = componentsSource.indexOf('function TopBar(');
  const topBarEnd = componentsSource.indexOf('function ReviewTitle(', topBarStart);
  assert.ok(topBarStart !== -1 && topBarEnd > topBarStart, 'TopBar source region is discoverable');
  const topBarSource = componentsSource.slice(topBarStart, topBarEnd);
  for (const token of ['IconPlus', 'IconMinus', 'actions.stageAll', 'actions.unstageAll',
    'canStageAll', 'canUnstageAll', 'stageAllBusy', 'unstageAllBusy',
    'onStageAll', 'onUnstageAll']) {
    assert.equal(topBarSource.includes(token), false, `TopBar must no longer reference ${token}`);
  }
});

test('reclassify uses the layers glyph while refresh keeps the refresh glyph', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const t = runtime.require('i18n').createI18n('zh').t;
  const render = (aiMode) => components.TopBar({
    t,
    aiMode,
    aiGrouping: 'role',
    status: { repo: null, summary: null },
    repo: null,
    onChangeGrouping: () => {},
    onReclassify: () => {},
    onRefresh: () => {},
    onOpenPush: () => {},
  });

  // Reclassify is only offered while AI grouping is active.
  const withAi = collectElements(render(true));
  const reclassify = withAi.find((element) => element.props.label === t('nav.reclassify'));
  assert.ok(reclassify, 'the reclassify action is offered while AI grouping is on');
  assert.equal(reclassify.props.children.type.name, 'IconLayers',
    'reclassify must not share the refresh glyph any more');
  const refresh = withAi.find((element) => element.props.label === t('actions.refresh'));
  assert.ok(refresh, 'refresh stays in the toolbar');
  assert.equal(refresh.props.children.type.name, 'IconRefresh');

  // The two glyphs are genuinely distinct (not aliases): layered stack vs arrows.
  const layersIcon = reclassify.props.children;
  const layersSvg = layersIcon.type(layersIcon.props);
  assert.equal(layersSvg.type, 'svg');
  assert.equal(layersSvg.props['aria-hidden'], 'true');
  assert.equal(layersSvg.props.children.filter((child) => child && child.type === 'path').length, 3,
    'the layers glyph is the three-path Lucide stack');
  const refreshIcon = refresh.props.children;
  const refreshSvg = refreshIcon.type(refreshIcon.props);
  const shape = (svg) => svg.props.children.map((child) => child.props.d);
  assert.notDeepEqual(shape(layersSvg), shape(refreshSvg), 'the two icons must not share the same paths');

  // AI grouping keeps a selector in place of the old spark toggle, so the two
  // operations (regroup vs refresh) can never be confused with it.
  const ui = runtime.require('ui');
  const groupingSelect = withAi.find((element) => element.type === ui.Select);
  assert.ok(groupingSelect, 'the grouping selector is still in the toolbar');
  assert.equal(groupingSelect.props.value, 'role');
  assert.equal(groupingSelect.props.options.length, 3);

  // Without AI grouping there is no reclassify control to confuse with refresh.
  const gitOnly = collectElements(render(false));
  assert.equal(gitOnly.some((element) => element.props.label === t('nav.reclassify')), false);

  const topBarStart = componentsSource.indexOf('function TopBar(');
  const topBarEnd = componentsSource.indexOf('function ReviewTitle(', topBarStart);
  const topBarSource = componentsSource.slice(topBarStart, topBarEnd);
  const reclassifyStart = topBarSource.indexOf("t('nav.reclassify')");
  const reclassifyEnd = topBarSource.indexOf(') : null', reclassifyStart);
  assert.ok(reclassifyStart !== -1 && reclassifyEnd > reclassifyStart, 'the reclassify branch exists');
  const reclassifyBlock = topBarSource.slice(reclassifyStart, reclassifyEnd);
  assert.ok(reclassifyBlock.includes('IconLayers'));
  assert.equal(reclassifyBlock.includes('IconRefresh'), false,
    'reclassify must not reuse the refresh icon component');
  const refreshStart = topBarSource.indexOf("t('actions.refresh')");
  assert.ok(topBarSource.slice(refreshStart, refreshStart + 300).includes('IconRefresh'));
});

/* ------------------------------------------------------------------------- */
/* Inlined icon set — every icon must render valid host SVG children         */
/* ------------------------------------------------------------------------- */

test('inlined Lucide icons render valid SVG children (composer entry sanity)', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const t = runtime.require('i18n').createI18n('zh').t;

  const button = components.ReviewButton({ t, onOpen: function () {} });
  assert.equal(button.type, 'button');
  const icon = button.props.children;
  assert.equal(typeof icon.type, 'function', 'ReviewButton uses an icon component');

  // Render the icon component one level: ICON_PARTS entries are React children,
  // not [tag, attrs] tuples — a regression there yields `type: undefined`
  // (React throws and DSH abdicates the composer slot entry).
  const svg = icon.type(icon.props);
  assert.equal(svg.type, 'svg');
  assert.equal(svg.props.viewBox, '0 0 24 24');
  assert.ok(Array.isArray(svg.props.children) && svg.props.children.length >= 1);
  for (const child of svg.props.children) {
    assert.equal(typeof child.type, 'string', 'icon child must be a host SVG element');
    assert.ok(['path', 'circle', 'line', 'rect', 'polyline', 'polygon'].includes(child.type), 'unexpected icon child ' + child.type);
  }
});

/* ------------------------------------------------------------------------- */
/* Icon size scale — sm 12 / md 14 / lg 16 (+ xl 20 decorative)              */
/* ------------------------------------------------------------------------- */

test('all icon call sites follow the three-tier size scale', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  assert.deepEqual(
    { md: components.ICON_SIZE.md, lg: components.ICON_SIZE.lg, xl: components.ICON_SIZE.xl },
    { md: 14, lg: 16, xl: 20 },
  );
  assert.match(componentsSource, /function IconReview\(props\) \{ return glyph\('review', iconSize\(props, ICON_SIZE\.md\)\); \}/);

  const allowedRaw = new Set(['14', '16', '20']);
  const allowedToken = /^(ICON_SIZE|iconSizes)\.(md|lg|xl)$/;
  const walk = (name, source, minCount) => {
    const re = /h\((?:components\.)?(Icon[A-Za-z]+),\s*\{[^}]*size:\s*([^,}\s]+)/g;
    let match;
    let seen = 0;
    while ((match = re.exec(source)) !== null) {
      seen += 1;
      assert.ok(allowedToken.test(match[2]) || allowedRaw.has(match[2]),
        `${name}: ${match[1]} uses non-scale icon size ${match[2]}`);
    }
    assert.ok(seen >= minCount, `${name}: expected the icon audit to see real call sites (${seen} < ${minCount})`);
  };
  walk('components.js', componentsSource, 10);
  walk('diff-view.js', diffViewSource, 2);
});

/* ------------------------------------------------------------------------- */
/* Select — follows the DSH Menu primitive, not a custom popover            */
/* ------------------------------------------------------------------------- */

test('select trigger and menu follow the DSH language-selector specs', () => {
  // Trigger: DSH ui-locale LanguageRow selector (36px pill, no border, module fill).
  assert.match(stylesSource, /\.gr-combo-trigger \{[^}]*height: 36px/);
  assert.match(stylesSource, /\.gr-combo-trigger \{[^}]*border: 0/);
  assert.match(stylesSource, /\.gr-combo-trigger \{[^}]*background: var\(--dsw-alias-bg-module-platform/);
  assert.match(stylesSource, /\.gr-combo-trigger \{[^}]*font-size: 14px/);
  assert.ok(!/\.gr-combo-caret\b/.test(stylesSource), 'the CSS caret was replaced by the Lucide chevron');
  assert.match(uiSource, /function chevronGlyph\(size\)/);

  // Menu: DSH Menu primitive surface + item geometry.
  assert.match(stylesSource, /\.gr-combo-menu \{[^}]*--dsw-menu-surface-fill/);
  assert.match(stylesSource, /\.gr-combo-menu \{[^}]*--dsw-menu-backdrop-filter/);
  assert.match(stylesSource, /\.gr-combo-menu \{[^}]*box-shadow: var\(--dsw-elevation-prominent/);
  assert.match(stylesSource, /\.gr-combo-menu \{[^}]*min-width: 0; width: auto/);
  assert.match(stylesSource, /\.gr-combo-menu \{[^}]*max-width: min\(360px/);
  assert.match(stylesSource, /\.gr-combo-option \{[^}]*min-height: 34px/);
  assert.match(stylesSource, /\.gr-combo-check \{[^}]*color: var\(--dsw-alias-label-primary\)/);
  // The reset link is gone and the menu avoids the footer: it flips above the
  // trigger when the space below cannot hold the option list.
  assert.ok(!componentsSource.includes('settingsModelReset'), 'the reset-to-default link must be removed');
  assert.match(uiSource, /var placement = below >= estimated \+ 4 \? 'below' : 'above';/);
  assert.match(uiSource, /next\.bottom = Math\.round\(window\.innerHeight - rect\.top \+ 4\)/);

  // Settings dropdowns are content-sized (DSH inline selector), not fixed widths.
  assert.ok(!/\.gr-setting-control \.gr-combo \{ width: 240px/.test(stylesSource), 'model select must not be fixed at 240px');
  assert.ok(!/\.gr-setting-select-sm \{ width: 180px/.test(stylesSource), 'language select must not be fixed at 180px');
  assert.match(stylesSource, /\.gr-settings \.gr-combo \{ display: inline-flex; width: auto; max-width: min\(320px, 100%\)/);
  assert.match(stylesSource, /\.gr-settings \.gr-combo-trigger \{ width: auto/);

  // Right edge aligns to the trigger, matching DSH's align:end menu.
  assert.match(uiSource, /right: Math\.round\(Math\.max\(8, window\.innerWidth - rect\.right\)\)/);
});

/* ------------------------------------------------------------------------- */
/* Model picker — DSH composer-style model + reasoning ladder                */
/* ------------------------------------------------------------------------- */

test('model picker mirrors the DSH composer model + reasoning picker', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const t = runtime.require('i18n').createI18n('zh').t;

  const tree = components.ModelPicker({
    t,
    routes: [
      { provider: 'deepseek-account', providerName: 'DeepSeek Account', model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
      { provider: 'deepseek-account', providerName: 'DeepSeek Account', model: 'deepseek-pro', name: 'DeepSeek-V4-Pro' },
    ],
    reasoning: {
      route: { provider: 'deepseek-account', model: 'deepseek-flash' },
      efforts: [{ id: 'off', name: '关闭' }, { id: 'high', name: '高' }],
      defaultEffort: 'high',
    },
    current: { provider: 'deepseek-account', model: 'deepseek-flash' },
    reasoningEffort: 'high',
    loading: false,
    saving: false,
    onChange: function () {},
  });
  const elements = collectElements(tree);
  const trigger = elements.find((element) =>
    typeof element.props.className === 'string' && element.props.className.includes('gr-model-trigger'));
  assert.ok(trigger, 'the picker renders its trigger');
  assert.equal(trigger.props['aria-haspopup'], 'menu');
  assert.equal(collectElements(tree).some((element) => element.props.className === 'gr-model-menu'), false,
    'the menu is closed until the trigger is activated');
  assert.ok(collectText(tree).includes('DeepSeek-V4.1-Flash'), 'the trigger shows the current model');

  // Structure is present in source (the menu only mounts after a click, which the
  // hook stub cannot drive here); the real browser test covers the open state.
  assert.ok(componentsSource.includes('function ModelPicker'));
  assert.ok(componentsSource.includes("t('ai.pickerModel')"));
  assert.ok(componentsSource.includes("t('ai.pickerEffort')"));
  assert.ok(componentsSource.includes('gr-model-summary'));
  assert.ok(componentsSource.includes('reasoningEffort: null'), 'picking a model resets the stale effort');
  assert.match(stylesSource, /\.gr-model-row \{/);
  assert.match(stylesSource, /\.gr-model-summary \{/);
  assert.match(appSource, /reasoningEffort/);
  assert.match(appSource, /loadModels/);
});

/* ------------------------------------------------------------------------- */
/* P2-15 — continuous "next change" from a navigation anchor                */
/* ------------------------------------------------------------------------- */

test('next-change advances from the anchor instead of re-selecting the centred row', () => {
  const runtime = createClientRuntime();
  const diffView = runtime.require('diff-view');
  const changes = [5, 15, 25];

  let anchor = diffView.changeAnchorRow(changes, 5);
  assert.equal(anchor, 5);
  const target = diffView.resolveChangeTarget(changes, anchor, 1);
  assert.equal(target, 15);

  // The target is now centred, so the viewport centre is 15; the second click
  // must advance to 25 rather than select 15 again.
  anchor = diffView.changeAnchorRow(changes, target);
  assert.equal(anchor, 15);
  assert.equal(diffView.resolveChangeTarget(changes, anchor, 1), 25);

  // Backwards mirrors the same rule.
  anchor = diffView.changeAnchorRow(changes, 25);
  assert.equal(anchor, 25);
  assert.equal(diffView.resolveChangeTarget(changes, anchor, -1), 15);

  // Ends clamp to the nearest edge change (existing behaviour).
  assert.equal(diffView.resolveChangeTarget(changes, 25, 1), 25);
  assert.equal(diffView.resolveChangeTarget(changes, 5, -1), 5);
  assert.equal(diffView.resolveChangeTarget([], 0, 1), null);
});

/* ------------------------------------------------------------------------- */
/* P2-16 — Escape layering with dropdowns / upper menus                      */
/* ------------------------------------------------------------------------- */

test('dialog Escape defers to an open dropdown or an upper context menu', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const defer = components.dialogEscapeDeferred;
  assert.equal(typeof defer, 'function');
  const combo = { closest: (selector) => (selector.includes('data-gr-combo') ? { tagName: 'DIV' } : null) };
  const menu = { closest: (selector) => (selector.includes('data-gr-menu') ? { tagName: 'DIV' } : null) };
  const plain = { closest: () => null };
  assert.equal(defer({ key: 'Escape', defaultPrevented: false, target: combo }), true);
  assert.equal(defer({ key: 'Escape', defaultPrevented: false, target: menu }), true);
  assert.equal(defer({ key: 'Escape', defaultPrevented: false, target: plain }), false);
  assert.equal(defer({ key: 'Escape', defaultPrevented: true, target: plain }), true);
  assert.equal(defer(null), false);
});

/* ------------------------------------------------------------------------- */
/* P2-17 — push preview error state                                          */
/* ------------------------------------------------------------------------- */

function renderPushDialog(runtime, props) {
  const components = runtime.require('components');
  const i18n = runtime.require('i18n');
  const t = i18n.createI18n('en').t;
  const tree = components.PushDialog(Object.assign({
    t,
    open: true,
    busy: false,
    onClose: () => {},
    onPush: () => {},
    onRemoteChange: () => {},
    onTargetChange: () => {},
  }, props));
  return { tree, t };
}

test('push dialog renders a preview error with a retry button, never a permanent spinner', () => {
  const runtime = createClientRuntime();
  let retries = 0;
  const { tree, t } = renderPushDialog(runtime, {
    preview: null,
    loading: false,
    error: { code: 'push/network' },
    hint: 'network error hint',
    remote: '',
    target: '',
    onRetry: () => { retries += 1; },
  });
  const text = collectText(tree);
  assert.ok(text.includes('network error hint'), `error hint missing; rendered text: ${text}`);
  assert.equal(text.includes(t('state.loading')), false, 'failed preview must not keep the loading text');
  const elements = collectElements(tree);
  assert.equal(elements.some((element) => element.props.className === 'gr-spinner'), false, 'spinner must not render');
  const retry = elements.find((element) => element.props && element.props.onClick
    && element.props.children === t('app.retry'));
  assert.ok(retry, 'retry button missing');
  retry.props.onClick();
  assert.equal(retries, 1);
});

test('push dialog shows a read-only source branch and an editable target branch', () => {
  const runtime = createClientRuntime();
  const { tree } = renderPushDialog(runtime, {
    preview: {
      sourceBranch: 'main',
      targetBranch: 'release',
      remote: 'origin',
      defaultRemote: 'origin',
      remotes: [{ name: 'origin' }],
      upstream: { remote: 'origin', branch: 'release', ref: 'origin/release' },
      commits: [],
      commitsBase: 'abc',
      canPush: true,
    },
    loading: false,
    error: null,
    remote: 'origin',
    target: 'release',
  });
  const elements = collectElements(tree);
  const fields = elements.filter((element) => typeof element.type === 'function' && element.type.name === 'TextField');
  assert.equal(fields.length, 1, 'exactly the target branch is an editable text field');
  assert.equal(fields[0].props.value, 'release');
  assert.equal(fields[0].props.ariaLabel, 'Target branch');
  assert.equal(elements.filter((element) => element.type === 'input').length, 0,
    'input chrome comes from the shared TextField primitive, not raw <input>');
  assert.ok(collectText(tree).includes('main'), 'the source branch must be displayed read-only');

  // The branch flow is three aligned field groups sharing one control height:
  // the local branch is a read-only value box, the remote is a Select and the
  // target is the editable TextField. All three labels sit on one baseline.
  const flow = elements.find((element) => element.props.className === 'gr-push-flow');
  assert.ok(flow, 'the branch flow is a grouped row');
  const flowFields = collectElements(flow).filter((element) => element.props.className
    && String(element.props.className).indexOf('gr-push-field-') !== -1);
  assert.deepEqual(flowFields.map((element) => element.props.className), [
    'gr-field gr-push-field-local',
    'gr-field gr-push-field-remote',
    'gr-field gr-push-field-target',
  ]);
  const localValue = collectElements(flowFields[0]).find((element) => elementClasses(element).includes('gr-field-value'));
  assert.ok(localValue, 'the read-only local branch uses the shared value box');
  const flowSelect = collectElements(flowFields[1]).find((element) => element.type.name === 'Select');
  assert.ok(flowSelect, 'the remote field keeps the shared Select');
  const flowInput = collectElements(flowFields[2]).find((element) => element.type.name === 'TextField');
  assert.ok(flowInput, 'the target field keeps the shared TextField');
  // One control tier: 34px for the value box, Select trigger and text input, and
  // the separators centre on that same row instead of adding their own offset.
  assert.match(stylesSource, /\.gr-push-flow \.gr-field-value \{[^}]*height: 34px/);
  assert.match(stylesSource, /\.gr-push-flow \.gr-input \{ height: 34px; \}/);
  assert.match(stylesSource, /\.gr-push-flow \.gr-combo-trigger \{[^}]*height: 34px[^}]*font-size: 13px/);
  assert.match(stylesSource, /\.gr-push-arrow \{[^}]*align-self: flex-end; height: 34px/);
  assert.match(stylesSource, /\.gr-push-field-local \{[^}]*min-width: 92px/);
  assert.match(stylesSource, /\.gr-push-field-target \{[^}]*flex: 1\.4 1 170px/);
});

/* ------------------------------------------------------------------------- */
/* Persistent bottom status strip — Ready + repository summary (cover)       */
/* ------------------------------------------------------------------------- */

function renderStatusBar(runtime, locale, props) {
  const components = runtime.require('components');
  const i18n = runtime.require('i18n');
  const t = i18n.createI18n(locale).t;
  return { tree: components.StatusBar(Object.assign({ t }, props)), t };
}

test('the status strip only appears once the repository state is readable', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const t = runtime.require('i18n').createI18n('zh').t;

  // Nothing to persist before the first status snapshot arrives; a bare no-git
  // state without a message has nothing to report either.
  assert.equal(components.StatusBar({ t }), null);
  assert.equal(components.StatusBar({ t, status: { state: 'no-git', repo: null } }), null);
  assert.equal(components.StatusBar({ t, status: { state: 'loading' } }), null);

  // Actions and notifications still force the strip before a snapshot exists.
  assert.ok(components.StatusBar({ t, notice: '已自动保存' }), 'a notice keeps the strip visible');
  assert.ok(components.StatusBar({ t, error: { message: 'boom' } }), 'an error keeps the strip visible');
  assert.ok(components.StatusBar({ t, busy: true, operation: '正在刷新…' }), 'an operation keeps the strip visible');

  // Shortcut hints stay in the Keyboard Shortcuts dialog, never in the strip.
  const noticeText = collectText(components.StatusBar({ t, notice: '已自动保存' }));
  assert.equal(noticeText.includes('下一个文件'), false, 'no duplicate file shortcut hints');
  assert.equal(noticeText.includes('关闭面板'), false, 'no duplicate close shortcut hints');
  assert.ok(collectText(components.StatusBar({ t, error: { message: 'boom' } })).includes('boom'),
    'errors remain visible in the strip');
});

test('the idle status strip shows Ready plus the branch and change summary', () => {
  const runtime = createClientRuntime();
  const generatedAt = new Date(2024, 4, 17, 9, 5, 2).getTime();
  const status = {
    state: 'ok',
    generatedAt,
    repo: { root: '/repo/x', branch: 'main', detached: false },
    summary: { files: 8, entries: 8, staged: 3, unstaged: 5, untracked: 0, conflicts: 0 },
  };
  const { tree, t } = renderStatusBar(runtime, 'zh', { status });
  assert.equal(elementsByClass(tree, 'gr-statusbar').length, 1,
    'a readable status keeps the strip visible while idle');
  const text = collectText(tree);
  assert.ok(text.includes(t('status.ready')), `Ready label missing: ${text}`);
  assert.ok(text.includes('main'), `branch name missing: ${text}`);
  assert.ok(text.includes(t('summary.files', { n: '8' })), `file count missing: ${text}`);
  assert.ok(text.includes(t('status.staged') + ' 3'), `staged count missing: ${text}`);
  assert.ok(text.includes(t('status.unstaged') + ' 5'), `unstaged count missing: ${text}`);
  // Empty categories are omitted instead of advertised as zero.
  assert.equal(text.includes(t('status.untracked')), false);
  assert.equal(text.includes(t('status.conflict')), false);

  const summary = elementsByClass(tree, 'gr-statusbar-summary');
  assert.equal(summary.length, 1, 'the repository summary sits on the right');
  assert.equal(summary[0].props.role, 'group');
  assert.equal(summary[0].props['aria-label'], t('a11y.summary'),
    'the summary group is labelled for screen readers');

  // The update time is a tooltip on Ready, not extra visible chrome.
  const ready = elementsByClass(tree, 'gr-statusbar-ready');
  assert.equal(ready.length, 1);
  assert.equal(ready[0].props.title, t('app.updated', { time: localClock(generatedAt) }));
  const dot = elementsByClass(tree, 'gr-statusbar-dot');
  assert.equal(dot.length, 1);
  assert.equal(dot[0].props['aria-hidden'], 'true');

  // Optional categories only join the summary when they carry a count.
  const withExtras = renderStatusBar(runtime, 'en', {
    status: Object.assign({}, status, {
      summary: { files: 8, entries: 10, staged: 3, unstaged: 5, untracked: 2, conflicts: 1 },
    }),
  });
  const extrasText = collectText(withExtras.tree);
  assert.ok(extrasText.includes(withExtras.t('status.untracked') + ' 2'), extrasText);
  assert.ok(extrasText.includes(withExtras.t('status.conflict') + ' 1'), extrasText);
  assert.equal(elementsByClass(withExtras.tree, 'gr-statusbar-untracked').length, 1);
  assert.equal(elementsByClass(withExtras.tree, 'gr-statusbar-conflict').length, 1);

  // The strip is a real footer, not an inline hint: it carries its own layout.
  assert.match(stylesSource, /\.gr-statusbar \{[^}]*display: flex/);
  assert.match(stylesSource, /\.gr-statusbar-ready/);
});

test('busy, error and notice take priority over Ready and keep the summary', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const t = runtime.require('i18n').createI18n('zh').t;
  const status = {
    state: 'ok',
    generatedAt: new Date(2024, 4, 17, 9, 5, 2).getTime(),
    repo: { root: '/repo/x', branch: 'main', detached: false },
    summary: { files: 8, entries: 8, staged: 3, unstaged: 5, untracked: 0, conflicts: 0 },
  };

  const busyTree = components.StatusBar({ t, busy: true, operation: '正在暂存…', status });
  assert.ok(collectText(busyTree).includes('正在暂存…'), 'the running operation is the primary status');
  assert.equal(elementsByClass(busyTree, 'gr-statusbar-busy').length, 1);
  assert.equal(elementsByClass(busyTree, 'gr-statusbar-ready').length, 0);
  assert.equal(elementsByClass(busyTree, 'gr-statusbar-summary').length, 1,
    'the summary stays in view while an operation runs');

  let dismissed = 0;
  const errorTree = components.StatusBar({
    t,
    status,
    error: { message: 'boom' },
    onDismiss: () => { dismissed += 1; },
  });
  const errorText = collectText(errorTree);
  assert.ok(errorText.includes('boom'));
  assert.equal(errorText.includes(t('status.ready')), false, 'an error replaces Ready');
  const dismiss = elementsByClass(errorTree, 'gr-statusbar-dismiss');
  assert.equal(dismiss.length, 1, 'the error carries a dismiss action');
  assert.equal(dismiss[0].props.label, t('app.dismiss'));
  dismiss[0].props.onClick();
  assert.equal(dismissed, 1);

  const noticeTree = components.StatusBar({ t, notice: '已自动保存', status });
  const noticeText = collectText(noticeTree);
  assert.ok(noticeText.includes('已自动保存'));
  assert.equal(noticeText.includes(t('status.ready')), false, 'a notice replaces Ready');
  assert.equal(elementsByClass(noticeTree, 'gr-statusbar-summary').length, 1);
});

/* ------------------------------------------------------------------------- */
/* File navigation — expand all / collapse all                               */
/* ------------------------------------------------------------------------- */

test('file navigation offers locate / expand-all / collapse-all with sensible states', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const i18n = runtime.require('i18n');
  const app = runtime.require('app');
  const ui = runtime.require('ui');
  const t = i18n.createI18n('zh').t;
  const groups = [
    { id: 'git:staged', label: '暂存', entries: [{ key: 'staged:a', status: 'staged', path: 'a' }] },
    { id: 'git:unstaged', label: '未暂存', entries: [{ key: 'unstaged:b', status: 'unstaged', path: 'b' }] },
  ];

  function render(collapsed, calls, selectedKey) {
    return components.FileNav({
      t,
      groups,
      selectedKey: selectedKey === undefined ? 'staged:a' : selectedKey,
      collapsedGroups: new Set(collapsed),
      locateSignal: 0,
      onToggleGroup: function () {},
      onLocate: function () { calls.push('locate'); },
      onExpandAll: function () { calls.push('expand'); },
      onCollapseAll: function () { calls.push('collapse'); },
      onSelect: function () {},
      onContextMenu: function () {},
      search: '',
      onSearch: function () {},
    });
  }

  function bulkButtons(tree) {
    return collectElements(tree).filter((element) =>
      typeof element.props.className === 'string'
      && element.props.className.split(/\s+/).includes('gr-files-bulk-btn'));
  }

  const expandCalls = [];
  const expanded = bulkButtons(render([], expandCalls)).map((button) => ui.IconButton(button.props));
  assert.equal(expanded.length, 3, 'locate + both bulk actions are rendered');
  assert.deepEqual(expanded.map((button) => button.props['aria-label']), ['快速定位当前文件', '全部展开', '全部收起']);
  assert.equal(expanded[0].props.disabled, undefined, 'locate is enabled while a file is selected');
  assert.equal(expanded[1].props.disabled, true, 'expand-all is disabled when nothing is collapsed');
  expanded[0].props.onClick();
  expanded[2].props.onClick();
  assert.deepEqual(expandCalls, ['locate', 'collapse']);

  const noSelection = bulkButtons(render([], [], null)).map((button) => ui.IconButton(button.props));
  assert.equal(noSelection[0].props.disabled, true, 'locate is disabled without a selected file');

  const collapseCalls = [];
  const collapsed = bulkButtons(render(['git:staged', 'git:unstaged'], collapseCalls))
    .map((button) => ui.IconButton(button.props));
  assert.equal(collapsed[1].props.disabled, undefined, 'expand-all is enabled while groups are collapsed');
  assert.equal(collapsed[2].props.disabled, true, 'collapse-all is disabled when everything is collapsed');
  collapsed[1].props.onClick();
  assert.deepEqual(collapseCalls, ['expand']);

  // app.js resolves the selected entry to its group and wires both controls.
  assert.equal(app.groupIdForEntry(groups, 'unstaged:b'), 'git:unstaged');
  assert.equal(app.groupIdForEntry(groups, 'missing'), null);
  assert.match(appSource, /onLocate: locateCurrentFile/);
  assert.match(appSource, /locateSignal: locateNonce/);
  assert.match(appSource, /next\.add\(groupIdOf\(visibleGroups\[groupIndex\], groupIndex\)\)/);
});

/* ------------------------------------------------------------------------- */
/* AI status — inside the toolbar, never a layout row                        */
/* ------------------------------------------------------------------------- */

test('AI status follows the summary and cannot resize the workspace', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const t = runtime.require('i18n').createI18n('zh').t;
  const notice = '已使用缓存的归类结果';
  const repo = { root: '/repo/dsh-code-review', branch: 'main', detached: false };
  const summary = {
    entries: 3, files: 2, staged: 0, unstaged: 0, untracked: 2, conflicts: 0,
    stagedAdditions: 0, stagedDeletions: 0, unstagedAdditions: 0, unstagedDeletions: 0,
  };
  const tree = components.TopBar({
    t,
    status: { repo: repo, summary: summary },
    repo: repo,
    aiNotice: notice,
  });
  // The toolbar root is a fragment (header + its branch popover), so the
  // one-line header is located by class rather than as the tree root.
  const header = collectElements(tree).find((element) => element.props.className === 'gr-topbar');
  assert.ok(header, 'TopBar renders the one-line header');
  const chips = collectElements(tree).filter((element) =>
    String(element.props.className || '').split(/\s+/).includes('gr-ai-row'));
  assert.equal(chips.length, 1, 'the AI status chip is part of the toolbar');
  assert.ok(collectText(chips[0]).includes(notice));
  assert.equal(chips[0].props.title, notice, 'the full notice stays available as a tooltip');
  // The chip rides after the summary marks inside the shrinkable middle slot,
  // so it sits on the left and disappears together with the summary on narrow
  // panels instead of leaving a status-only row behind.
  const mid = collectElements(tree).find((element) => element.props.className === 'gr-topbar-mid');
  assert.ok(mid, 'the toolbar middle slot is rendered');
  const midChildren = (mid.props.children || []).flat(3);
  assert.equal(midChildren[midChildren.length - 1], chips[0], 'the AI chip follows the summary marks');
  assert.ok(midChildren.some((child) => child && child.props
    && String(child.props.className || '').includes('gr-sum')), 'summary marks precede the chip');
  // No full-width status row and no separate row of its own.
  assert.equal(/\bgr-ai-row\b[^]*?height: 26px/.test(stylesSource), false);
  assert.match(stylesSource, /\.gr-ai-row \{[^}]*border-radius: 999px/);
  assert.match(stylesSource, /\.gr-topbar-repo:empty \{ display: none; \}/);
  // Narrow panels keep the summary + status visible: the actions move to their
  // own row instead of hiding the toolbar middle.
  assert.match(stylesSource, /@container gr-topbar \(max-width: 820px\) \{[\s\S]*?\.gr-topbar-actions \{ flex: 1 1 100%/);
  assert.equal(/\.gr-topbar-mid \{ display: none; \}/.test(stylesSource), false);
  assert.equal(/\.gr-topbar-mid \.gr-sum-item,[\s\S]*?display: none/.test(stylesSource), false);
});

/* ------------------------------------------------------------------------- */
/* Narrow layout — toolbar wraps, file title never breaks                    */
/* ------------------------------------------------------------------------- */

test('narrow layout wraps the toolbar and keeps the file title on one line', () => {
  // The toolbar grows to a second row for the action cluster instead of
  // squeezing the identity/summary or clipping actions.
  assert.match(stylesSource, /\.gr-topbar \{[^}]*flex-wrap: wrap/);
  assert.match(stylesSource, /\.gr-topbar \{[^}]*height: auto; min-height: 54px/);
  assert.match(stylesSource, /@container gr-topbar \(max-width: 820px\) \{[\s\S]*?\.gr-topbar-actions \{ flex: 1 1 100%/);
  // The information row (branch + summary + status) stays visible on narrow
  // panels; only the actions wrap to a second row.
  assert.equal(/\.gr-topbar-repo \{ display: none; \}/.test(stylesSource), false);
  assert.equal(/\.gr-topbar-repo \.gr-chip[^}]*display: none/.test(stylesSource), false);
  // The sidebar title ("文件") must never be compressed into a vertical stack.
  assert.match(stylesSource, /\.gr-files-title \{[^}]*flex: 0 0 auto; white-space: nowrap/);
  assert.match(stylesSource, /\.gr-files-head-row \{[^}]*overflow: hidden/);
  // The splitter is clamped by the app against the measured workspace width and
  // backed by a CSS max-width, so nav + splitter + diff always fill the panel.
  assert.match(stylesSource, /\.gr-nav-column \{ max-width: calc\(100% - 246px\); \}/);
  assert.match(appSource, /rect\.width - SPLITTER_WIDTH - MIN_DIFF_WIDTH/);
  assert.match(appSource, /util\.clamp\(startWidth \+ \(moveEvent\.clientX - startX\), MIN_NAV_WIDTH, maxWidth\)/);
  assert.match(appSource, /ref: workspaceRef/);
  // Splitter hover is a soft neutral mix, not the near-black brand fill.
  assert.match(stylesSource, /\.gr-splitter:hover::after[\s\S]*?color-mix\(in srgb, var\(--dsw-alias-label-primary\) 30%, transparent\)/);
  // Narrow diff column: path truncates instead of stacking letters, meta moves
  // to its own row.
  assert.match(stylesSource, /\.gr-diff-path \{[^}]*white-space: nowrap/);
  assert.match(stylesSource, /@container gr-diff \(max-width: 560px\) \{[\s\S]*?\.gr-diff-head \{ padding: 8px 10px/);
});

test('the change counter row keeps a persistent selection and follows clicks', () => {
  const runtime = createClientRuntime();
  const diffView = runtime.require('diff-view');
  const changes = [0, 1, 2, 3];

  // No pinned row: the counter follows the viewport (change at/above its top).
  assert.equal(diffView.changeCounterIndex(changes, 0, null), 0);
  assert.equal(diffView.changeCounterIndex(changes, 40, null), 2);
  // A clicked / navigated row pins the counter until the next manual scroll.
  assert.equal(diffView.changeCounterIndex(changes, 40, 1), 1);
  assert.equal(diffView.changeCounterIndex([], 0, 1), -1);

  // The selection is persistent (not a flash), clicking a change row pins it,
  // and scrolling must not take it away from the user.
  assert.match(diffViewSource, /activeChangeRow === rowIndex && 'gr-change-current'/);
  assert.match(diffViewSource, /setPinnedChangeRow\(rowIndex\)/);
  assert.match(diffViewSource, /pinnedChangeRowRef\.current = pinnedChangeRow;/);
  assert.match(diffViewSource, /if \(pinnedChangeRowRef\.current !== null\) return;/);
  assert.match(stylesSource, /\.gr-change-current::before \{[^}]*z-index: 1/);
});

test('shortcut help advertises the real bindings and modal layers own the keyboard', () => {
  const runtime = createClientRuntime();
  const i18n = runtime.require('i18n');
  for (const locale of ['zh', 'en']) {
    const t = i18n.createI18n(locale).t;
    for (const key of ['shortcut.navRows', 'shortcut.fileEdges', 'shortcut.switchFiles',
      'shortcut.contextMenu', 'shortcut.helpToggle']) {
      assert.notEqual(t(key), key, `${locale}: missing ${key}`);
    }
  }
  // The dialog lists the bindings that actually exist, once each.
  for (const key of ['shortcut.navRows', 'shortcut.fileEdges', 'shortcut.switchFiles',
    'shortcut.prevChange', 'shortcut.hunkMenu', 'shortcut.contextMenu',
    'shortcut.refresh', 'shortcut.helpToggle', 'shortcut.close']) {
    assert.ok(appSource.includes(`'${key}'`), `app shortcuts list is missing ${key}`);
  }
  assert.equal(appSource.includes("'shortcut.nextFile'"), false, 'duplicate file rows are gone');
  assert.equal(appSource.includes("'shortcut.hunks'"), false, 'duplicate hunk row is gone');
  // The Ctrl/Cmd+Enter commit shortcut was removed: no dictionary entry, no
  // advertised row, no message-box key handler and no keycap hint.
  for (const locale of ['zh', 'en']) {
    assert.equal(Object.prototype.hasOwnProperty.call(i18n.DICTIONARIES[locale], 'shortcut.commit'), false,
      `${locale}: the removed commit shortcut must not stay in the dictionary`);
  }
  assert.equal(appSource.includes('shortcut.commit'), false, 'the commit shortcut is no longer advertised');
  assert.equal(componentsSource.includes('shortcut.commit'), false);
  assert.equal(componentsSource.includes('gr-commit-shortcut'), false, 'the keycap hint is gone');
  // While a modal layer owns the keyboard, only Esc (and ? for this help) act.
  assert.match(appSource, /if \(shortcutHelp\) \{/);
  assert.match(appSource, /if \(menu \|\| confirm \|\| pushState\.open \|\| panelSettingsOpen\) return;/);
  assert.match(appSource, /setShortcutHelp\(false\);/, '? can toggle the help dialog closed');
});

test('focus rings use the DSH tokens on the entry and every plugin control', () => {
  // Same ring as the host: token colour/width, no brand-black fill, no
  // !important (that would defeat DSH's pointer-modality suppression).
  assert.match(stylesSource, /\.gr-review-button:focus-visible \{ outline: var\(--dsw-focus-ring-width, 2px\) solid var\(--dsw-focus-ring-color, var\(--dsw-alias-state-business-primary\)\); outline-offset: 0; \}/);
  assert.match(stylesSource, /\.gr-btn:focus-visible \{ outline-style: solid; outline-width: var\(--dsw-focus-ring-width, 2px\); outline-color: var\(--dsw-focus-ring-color, var\(--dsw-alias-state-business-primary\)\)/);
  assert.match(stylesSource, /\.gr-diff-row:focus-visible::after \{[^}]*outline: var\(--dsw-focus-ring-width, 2px\) solid var\(--dsw-focus-ring-color/);
  assert.match(stylesSource, /\.gr-file-row:focus-visible \{ outline: var\(--dsw-focus-ring-width, 2px\) solid var\(--dsw-focus-ring-color/);
  // No focus rule may paint the near-black brand colour or force it through
  // !important (the only allowed override is the Esc focus-silent helper).
  assert.equal(/outline: 2px solid var\(--dsw-alias-brand-primary\)/.test(stylesSource), false);
  assert.equal(/focus-visible[^{}]*\{[^}]*outline[^}]*!important/.test(stylesSource.replace(/\.gr-focus-silent:focus-visible[^}]*\}/, '')), false);
  assert.equal(componentsSource.includes("outline: 'none'"), false, 'the entry button must not hide its own ring inline');
  assert.equal(stylesSource.includes('gr-resizer'), false, 'dead resizer styles are gone');
});

/* ------------------------------------------------------------------------- */
/* Open targets — DSH open-in-app parity                                     */
/* ------------------------------------------------------------------------- */

test('open-in-app helpers reuse the DSH catalog and session remote', async () => {
  const runtime = createClientRuntime();
  const open = runtime.require('open-in-app');

  // Path joining keeps the repository's separator convention.
  assert.equal(open.absoluteRepoPath('E:\\repo', 'src\\a.js'), 'E:\\repo\\src\\a.js');
  assert.equal(open.absoluteRepoPath('/repo/', 'src/a.js'), '/repo/src/a.js');
  assert.equal(open.absoluteRepoPath('/repo', ''), '/repo');

  // The directory catalog uses DSH's route and drops ids this client cannot label.
  const requests = [];
  const apps = await open.folderApps((url) => {
    requests.push(url);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ apps: ['explorer', 'unknown-app', 'intellij'] }) });
  });
  assert.deepEqual(apps, ['explorer', 'intellij']);
  assert.equal(requests[0], 'open-in-app/apps');

  // Launching posts the exact body DSH's open route validates.
  const posts = [];
  const opened = await open.openFolder((url, init) => {
    posts.push({ url, init });
    return Promise.resolve({ ok: true });
  }, 'intellij', 'E:\\repo');
  assert.equal(opened, true);
  assert.equal(posts[0].url, 'open-in-app/open');
  assert.deepEqual(JSON.parse(posts[0].init.body), { app: 'intellij', path: 'E:\\repo' });

  // File open/reveal go through the optional Session Remote envelope.
  const calls = [];
  const session = {
    canOpenWorkspacePath: () => Promise.resolve({ ok: true, value: true }),
    openWorkspacePath: (request) => {
      calls.push(request);
      return Promise.resolve({ ok: true, opened: true });
    },
  };
  assert.equal(await open.canOpenFiles(session), true);
  assert.equal(await open.openFile(session, 'E:\\repo\\a.js'), true);
  assert.equal(await open.openFile(session, 'E:\\repo\\a.js', 'reveal'), true);
  assert.deepEqual(calls, [{ path: 'E:\\repo\\a.js' }, { path: 'E:\\repo\\a.js', action: 'reveal' }]);
  assert.equal(await open.canOpenFiles(null), false);
  assert.equal(await open.openFile(null, 'x'), false);
});

test('app.js only references icon symbols components actually exports', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const used = new Set();
  for (const match of appSource.matchAll(/components\.(Icon[A-Za-z]+|ICON_SIZE)/g)) used.add(match[1]);
  assert.ok(used.size > 0, 'the audit must see real icon references');
  for (const name of used) {
    if (name === 'ICON_SIZE') {
      assert.ok(components.ICON_SIZE && typeof components.ICON_SIZE === 'object', 'components.ICON_SIZE must be exported');
      continue;
    }
    assert.equal(typeof components[name], 'function', `components.${name} is referenced by app.js but not exported`);
  }
});

test('the project header offers DSH-compatible open targets', () => {
  const runtime = createClientRuntime();
  const open = runtime.require('open-in-app');
  const i18n = runtime.require('i18n');
  assert.match(appSource, /var openInApp = require\('open-in-app'\)/);
  assert.match(appSource, /h\(components\.OpenTargetButton/);
  // The open-project control is produced by the window body (it needs the
  // repository snapshot) and mounted by the chrome in the floating window's
  // title bar, before the minimize/close buttons — not in the review toolbar.
  assert.match(appSource, /onHeadAction: setHeadAction/);
  assert.match(appSource, /props\.onHeadAction\(openTargetButton\)/);
  assert.match(appSource, /h\('div', \{ className: 'gr-window-actions' \},\s*headAction,/);
  assert.equal(/leadingAction: openTargetButton/.test(appSource), false, 'the open-project control is back in the title bar, not the toolbar');
  assert.match(appSource, /id: 'open-file'/);
  assert.match(appSource, /id: 'reveal-file'/);
  assert.match(componentsSource, /function OpenTargetButton/);
  assert.match(componentsSource, /className: 'gr-open-main'/);
  assert.match(uiSource, /props\.actions \? h\('div', \{ className: 'gr-modal-actions' \}/);
  assert.match(stylesSource, /\.gr-open-target \{/);
  assert.match(stylesSource, /\.gr-window-head \.gr-open-target \{/);
  assert.match(stylesSource, /\.gr-menu-icon \{/);
  for (const locale of ['zh', 'en']) {
    const translated = i18n.createI18n(locale).t;
    for (const id of Object.keys(open.APP_LABEL_KEYS)) {
      const key = open.APP_LABEL_KEYS[id];
      assert.notEqual(translated(key), key, `${locale}: missing ${key}`);
    }
  }
});

/* ------------------------------------------------------------------------- */
/* Review window title bar — repo identity instead of a fixed title          */
/* ------------------------------------------------------------------------- */

test('the review window title bar shows the repository identity', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const t = runtime.require('i18n').createI18n('zh').t;
  const root = '/repo/dsh-code-review';
  const title = components.ReviewTitle({ t, repo: { root } });
  assert.ok(collectText(title).includes('dsh-code-review'), 'the project name labels the window title');
  const name = collectElements(title).find((element) => element.props.className === 'gr-review-title-name');
  assert.equal(name.props.title, root, 'the full repository path stays in the tooltip');
  assert.ok(collectElements(title).some((element) => element.props.className === 'gr-repo-icon'),
    'the repo icon leads the identity');
  // Without a repository (still loading) the title falls back to the plugin title.
  assert.equal(collectText(components.ReviewTitle({ t, repo: null })), t('app.title'));

  // The floating window chrome owns the title: identity inside the title bar.
  assert.match(appSource, /className: 'gr-window-head'/);
  assert.match(appSource, /className: 'gr-window-ident'/);
  assert.match(appSource, /h\(components\.ReviewTitle, \{ t: t, repo: repoRoot \? \{ root: repoRoot \} : null \}\)/);
  // The old modal title/subtitle pair is gone.
  assert.equal(componentsSource.includes('subtitle: modalHeader'), false);
  assert.equal(/title: h\(components\.ReviewTitle/.test(appSource), false, 'the review window is not a Modal title');
  assert.match(appSource, /'aria-label': t\('app\.title'\)/, 'the window section keeps an accessible label');

  // ...and the toolbar no longer duplicates the repo identity.
  const bar = components.TopBar({ t, status: { repo: null, summary: null }, repo: null });
  assert.equal(collectElements(bar).some((element) =>
    String(element.props.className || '').split(/\s+/).includes('gr-repo-name')), false);
});

/* ------------------------------------------------------------------------- */
/* Review window chrome — drag / minimize / maximize / close / resize        */
/* ------------------------------------------------------------------------- */

test('window chrome exposes drag, minimize, maximize, close and resize handles', () => {
  // Drag: the title bar starts a move gesture; double-click toggles maximize.
  assert.match(appSource, /beginGesture\(event, 'move'\)/);
  assert.match(appSource, /onDoubleClick: function \(event\) \{[\s\S]{0,160}?toggleMaximize\(\)/);
  // Minimize/restore button, maximize/restore button, and the close button as
  // the only close path.
  assert.match(appSource, /label: win\.minimized \? t\('window\.restore'\) : t\('window\.minimize'\)/);
  assert.match(appSource, /className: 'gr-window-btn gr-window-btn-min'/);
  assert.match(appSource, /label: win\.maximized \? t\('window\.restore'\) : t\('window\.maximize'\)/);
  assert.match(appSource, /className: 'gr-window-btn gr-window-btn-max'/);
  assert.match(appSource, /h\(components\.IconMaximize, \{ size: components\.ICON_SIZE\.md \}\)/);
  assert.match(appSource, /h\(components\.IconRestore, \{ size: components\.ICON_SIZE\.md \}\)/);
  assert.match(appSource, /onClick: toggleMaximize/);
  // A maximized window is neither draggable nor resizable until restored, and
  // its resize edges are hidden.
  assert.match(appSource, /if \(win\.maximized\) return;/, 'maximized windows are not draggable or resizable');
  assert.match(stylesSource, /\.gr-window-maximized \.gr-window-resize \{ display: none; \}/);
  // A minimized window is only its title strip: its drag clamps against the
  // strip height instead of the remembered restore height, patches the origin
  // only, and offers no resize gesture or resize edges while minimized.
  assert.match(appSource, /if \(win\.minimized && edge !== 'move'\) return;/,
    'a minimized strip can be moved but not resized');
  assert.match(appSource, /var dragged = win\.minimized/);
  assert.match(appSource, /clampMinimizedWindowRect\(\{[\s\S]{0,260}?\}, start\.viewport\)/,
    'the minimized drag clamps against the title-strip footprint');
  assert.match(appSource, /state\.patchWindow\(win\.id, \{ x: dragged\.x, y: dragged\.y \}\)/,
    'the minimized drag moves the origin and keeps the stored restore size');
  assert.match(appSource, /clampMinimizedWindowRect\(win, viewport\)/,
    'a resize event clamps a minimized window against its strip footprint');
  assert.match(appSource,
    /minimized: false[\s\S]{0,80}?clampWindowRect\(\{ x: win\.x, y: win\.y, width: win\.width, height: win\.height \}, viewportSize\(\)\)/,
    'restoring a minimized strip re-clamps the full window');
  assert.match(stylesSource, /\.gr-window-minimized \.gr-window-resize-e/,
    'the right-edge resize handle is hidden while minimized');
  assert.match(appSource, /className: 'gr-window-btn gr-window-btn-close'/);
  assert.match(appSource, /onClick: closeWindow/);
  // Resize handles: east, south and south-east edges.
  for (const edge of ['e', 's', 'se']) {
    assert.ok(appSource.includes(`className: 'gr-window-resize gr-window-resize-${edge}'`), `missing ${edge} resize handle`);
    assert.ok(appSource.includes(`beginGesture(event, '${edge}')`), `missing ${edge} resize gesture`);
  }
  // Maximize/restore remember the previous rectangle, and the geometry is
  // clamped against the live viewport.
  assert.match(appSource, /maximizedWindowGeometry\(viewportSize\(\)\)/);
  assert.match(appSource, /restore: \{ x: win\.x, y: win\.y, width: win\.width, height: win\.height \}/);
  assert.match(appSource, /clampWindowRect\(\{ x: win\.x, y: win\.y, width: win\.width, height: win\.height \}, viewport\)/);
  // Maximize fills the DSH work area edge to edge: no artificial margin.
  assert.match(appSource, /return \{ x: 0, y: 0, width: vp\.width, height: vp\.height \};/);
  // Regression: restoring after the viewport shrank clamps the remembered
  // rectangle (the window must never come back off screen) and clears the
  // minimized flag, so double-clicking a minimized maximized window restores it.
  assert.match(appSource, /var restored = clampWindowRect\(win\.restore, viewportSize\(\)\);/);
  assert.match(appSource, /Object\.assign\(\{ maximized: false, minimized: false, restore: null \}, restored\)\)/);
});

test('the review window layer is non-modal: no full-page backdrop, pointer-transparent layer', () => {
  const runtime = createClientRuntime();
  const state = runtime.require('state');
  // The old single-panel API is gone, and app.js never references it.
  assert.equal(state.panelStore, undefined, 'panelStore must be removed');
  assert.equal(state.closePanel, undefined, 'closePanel must be removed');
  assert.equal(appSource.includes('panelStore'), false, 'app.js must not reference panelStore');
  assert.equal(appSource.includes('state.closePanel'), false, 'app.js must not reference state.closePanel');
  // The panel entry renders a frame-wide pointer-transparent layer with one
  // section.gr-window per target; there is no modal backdrop for the window.
  assert.match(appSource, /className: 'gr-window-layer', 'data-gr-window-layer': 'true'/);
  assert.match(appSource, /var className = 'gr-window'/);
  assert.equal(appSource.includes('gr-modal-review'), false);
  assert.equal(stylesSource.includes('gr-modal-review'), false);
  assert.match(stylesSource, /\.gr-window-layer \{[^}]*pointer-events: none/);
  // The layer starts below the DSH frame title strip, and the geometry reads the
  // same token, so a maximized window covers the work area without covering the
  // DSH chrome (and a drag can never push it off frame).
  assert.match(stylesSource, /\.gr-window-layer \{[^}]*top: var\(--dsh-frame-top-clearance, 0px\)/);
  assert.match(appSource, /--dsh-frame-top-clearance/);
  assert.match(appSource, /function frameTopInset\(\)/);
  assert.match(appSource, /exports\.frameTopInset = frameTopInset/);
  assert.match(appSource, /exports\.viewportSize = viewportSize/);
  assert.match(stylesSource, /\.gr-window \{[^}]*pointer-events: auto/);
  // The window frame follows the DSH window content radius, not the larger
  // dialogs/cards radius (a desktop-window silhouette, not a dialog blob).
  assert.match(stylesSource, /\.gr-window \{[^}]*border-radius: var\(--dsh-windows-content-radius, var\(--dsw-radius-lg/);
  assert.equal(/\.gr-window \{[^}]*border-radius: var\(--dsw-radius-panel/.test(stylesSource), false,
    'the review window must not use the 28px dialog panel radius');
  // The window section is a plain dialog, not aria-modal: DSH behind it stays usable.
  assert.equal(appSource.includes("'aria-modal': 'true'"), false, 'the review window must not be a modal');
  // DOM order stays the stable creation order; focus raises the window with z-index.
  assert.match(appSource, /var ordered = layer\.windows\.slice\(\)\.sort\(/);
  assert.match(appSource, /return \(left\.seq \|\| 0\) - \(right\.seq \|\| 0\);/);
  assert.match(appSource, /zIndex: stacking\.get\(win\.id\) \|\| index \+ 1/);
  assert.match(stateSource, /seq: windowSeq/);
});

test('keyboard shortcuts are scoped to the focused window and Esc never closes it', () => {
  // The listener lives on the window root DOM node, not on document/window.
  assert.match(appSource, /root\.addEventListener\('keydown', onKeyDown, true\)/);
  assert.match(appSource, /root\.removeEventListener\('keydown', onKeyDown, true\)/);
  assert.equal(/document\.addEventListener\('keydown'/.test(appSource), false,
    'panel shortcuts must not attach to document');
  assert.equal(/window\.addEventListener\('keydown'/.test(appSource), false,
    'panel shortcuts must not attach to window');
  // ReviewBody receives the window section as its root.
  assert.match(appSource, /windowRef: rootRef/);
  // Clicking/dragging a window restores DOM focus to its root, otherwise the
  // root-scoped shortcuts stay dead after the user visited the DSH composer.
  assert.match(appSource, /function focusWindowRoot\(root, event\)/);
  assert.match(appSource, /focusWindowRoot\(rootRef\.current, event\)/);
  assert.match(appSource, /root\.contains\(active\)/);
  assert.match(appSource, /target\.closest\('input, textarea, select, \[contenteditable="true"\]'\)/,
    'editable targets keep their own focus instead of losing it to the window root');
  // Esc only closes the topmost in-window layer; the window itself closes manually.
  assert.match(appSource, /var handleEscape = function \(\) \{/);
  for (const layer of ['closeMenu()', 'setConfirm(null)', 'closePush()', 'setPanelSettingsOpen(false)', 'setShortcutHelp(false)']) {
    assert.ok(appSource.includes(layer), `Esc layer handling is missing ${layer}`);
  }
  assert.equal(appSource.split('state.closeWindow').length - 1, 1,
    'only the explicit window close button may close a window');
  assert.equal(/Escape[\s\S]{0,240}?state\.closeWindow/.test(appSource), false,
    'Esc must never close the review window');
});

test('in-window dialogs cover only their review window with the scoped backdrop', () => {
  const runtime = createClientRuntime();
  const ui = runtime.require('ui');
  // Every dialog the review body renders requests the scoped backdrop.
  for (const name of ['ConfirmDialog', 'PushDialog', 'ShortcutHelp', 'RemoteDialog', 'Modal']) {
    const at = appSource.indexOf('h(components.' + name + ', {');
    assert.ok(at !== -1, `app.js does not render ${name}`);
    assert.ok(appSource.slice(at, at + 800).includes('scoped: true'), `${name} must be rendered with scoped: true`);
  }
  // ConfirmDialog/ShortcutHelp/RemoteDialog forward it to the shared Modal, whose
  // backdrop becomes absolute inside the window instead of fixed over the page.
  assert.equal(componentsSource.split('scoped: !!props.scoped').length - 1, 3,
    'ConfirmDialog, ShortcutHelp and RemoteDialog forward scoped to the Modal');
  assert.match(stylesSource, /\.gr-modal-backdrop\.gr-modal-backdrop-scoped \{ position: absolute; inset: 0/);
  const t = runtime.require('i18n').createI18n('en').t;
  const scopedTree = ui.Modal({ open: true, scoped: true, t, title: 'Dialog', onClose: function () {} });
  assert.ok(String(scopedTree.props.className).split(/\s+/).includes('gr-modal-backdrop-scoped'));
  const pageTree = ui.Modal({ open: true, t, title: 'Dialog', onClose: function () {} });
  assert.equal(String(pageTree.props.className).split(/\s+/).includes('gr-modal-backdrop-scoped'), false,
    'the default backdrop is still page-fixed');
  // PushDialog paints its own scoped layer class.
  assert.match(componentsSource, /cx\('gr-modal-backdrop gr-push-layer', props\.scoped && 'gr-modal-backdrop-scoped'\)/);
});

test('window chrome strings exist in both zh and en dictionaries', () => {
  const runtime = createClientRuntime();
  const i18n = runtime.require('i18n');
  const keys = ['window.minimize', 'window.restore', 'window.maximize', 'window.hint', 'app.close'];
  for (const locale of ['zh', 'en']) {
    const t = i18n.createI18n(locale).t;
    for (const key of keys) {
      const value = t(key);
      assert.equal(typeof value, 'string', `${locale}: ${key} must be a string`);
      assert.notEqual(value, key, `${locale}: missing dictionary entry for ${key}`);
      assert.ok(value.length > 0, `${locale}: ${key} must not be empty`);
    }
    assert.notEqual(t('window.minimize'), t('window.maximize'), `${locale}: minimize/maximize labels must differ`);
  }
});

/* ------------------------------------------------------------------------- */
/* Dialog close — Esc restores focus without the trigger ring                */
/* ------------------------------------------------------------------------- */

test('Esc closing a dialog restores focus without painting the trigger ring', () => {
  // The Escape path flags the close, the cleanup refocuses the previous element
  // and temporarily silences its focus ring.
  assert.match(uiSource, /var escapeClosed = false;/);
  assert.match(uiSource, /escapeClosed = true;/);
  assert.match(uiSource, /previous\.classList\.add\('gr-focus-silent'\)/);
  assert.match(uiSource, /previous\.classList\.remove\('gr-focus-silent'\)/);
  assert.match(stylesSource, /\.gr-focus-silent:focus-visible \{ outline: none !important; box-shadow: none !important; \}/);
});

/* ------------------------------------------------------------------------- */
/* Commit checkboxes — checked files are staged, groups tri-state            */
/* ------------------------------------------------------------------------- */

test('file navigation checkboxes stage/unstage the rows they mirror', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const ui = runtime.require('ui');
  const t = runtime.require('i18n').createI18n('zh').t;
  const groups = [{
    id: 'g1',
    label: '混合',
    entries: [
      { key: 'staged:a', status: 'staged', path: 'a', change: 'modified' },
      { key: 'unstaged:b', status: 'unstaged', path: 'b', change: 'modified' },
      { key: 'untracked:c', status: 'untracked', path: 'c', change: 'added' },
      { key: 'conflict:d', status: 'conflict', path: 'd', change: 'conflict' },
    ],
  }];
  const calls = [];
  const tree = components.FileNav({
    t,
    groups,
    selectedKey: null,
    collapsedGroups: new Set(),
    locateSignal: 0,
    onToggleGroup: function () {},
    onSelect: function () {},
    onContextMenu: function () {},
    search: '',
    onSearch: function () {},
    onToggleStaged: function (entry, next) { calls.push(['row', entry.key, next]); },
    onToggleGroupStaged: function (entries, next) { calls.push(['group', entries.length, next]); },
    onToggleAllStaged: function (entries, next) { calls.push(['all', entries.length, next]); },
  });
  const checks = collectElements(tree).filter((element) => element.type === ui.Checkbox);
  assert.equal(checks.length, 6, 'header select-all + one group checkbox + one per row');
  const classOf = (element) => String(element.props.className || '').split(' ');

  const allCheck = checks.find((element) => classOf(element).includes('gr-files-select-all'));
  assert.ok(allCheck, 'the header offers a select-all checkbox');
  assert.equal(allCheck.props.checked, false);
  assert.equal(allCheck.props.mixed, true, 'one staged entry of three selectable keeps select-all mixed');
  allCheck.props.onChange(true);
  assert.deepEqual(calls[0], ['all', 3, true], 'select-all stages the listed non-conflict entries');

  const groupCheck = checks.find((element) => classOf(element).includes('gr-group-check'));
  assert.ok(groupCheck, 'the group header has a checkbox');
  assert.equal(groupCheck.props.checked, false);
  assert.equal(groupCheck.props.mixed, true, 'one staged row makes the whole group mixed');
  groupCheck.props.onChange(true);
  assert.deepEqual(calls[1], ['group', 4, true], 'checking a mixed group stages the rest of it');

  const rowB = checks.find((element) => classOf(element).includes('gr-file-check')
    && element.props.ariaLabel.indexOf('b') === 0);
  assert.equal(rowB.props.checked, false);
  rowB.props.onChange(true);
  assert.deepEqual(calls[2], ['row', 'unstaged:b', true]);

  const rowA = checks.find((element) => classOf(element).includes('gr-file-check')
    && element.props.ariaLabel.indexOf('a') === 0);
  assert.equal(rowA.props.checked, true, 'a staged row renders checked');

  const rowD = checks.find((element) => classOf(element).includes('gr-file-check')
    && element.props.ariaLabel.indexOf('d') === 0);
  assert.equal(rowD.props.disabled, true, 'conflicted rows cannot be staged from the checkbox');
});

/* ------------------------------------------------------------------------- */
/* File navigation header — tri-state select-all (cover)                     */
/* ------------------------------------------------------------------------- */

function renderFileNav(runtime, props) {
  const components = runtime.require('components');
  const ui = runtime.require('ui');
  const i18n = runtime.require('i18n');
  const locale = props.locale === 'en' ? 'en' : 'zh';
  const t = i18n.createI18n(locale).t;
  const calls = [];
  const tree = components.FileNav(Object.assign({
    t,
    groups: [],
    selectedKey: null,
    collapsedGroups: new Set(),
    locateSignal: 0,
    onToggleGroup: function () {},
    onSelect: function () {},
    onContextMenu: function () {},
    search: '',
    onSearch: function () {},
    onToggleStaged: function () {},
    onToggleGroupStaged: function () {},
    onToggleAllStaged: function (entries, next) { calls.push([entries, next]); },
  }, props));
  const checks = collectElements(tree).filter((element) => element.type === ui.Checkbox);
  const selectAll = checks.find((element) => elementClasses(element).includes('gr-files-select-all'));
  return { tree, checks, selectAll, calls, t, ui };
}

test('the file header offers a tri-state select-all scoped to the listed entries', () => {
  const runtime = createClientRuntime();
  const mixed = renderFileNav(runtime, {
    groups: [{
      id: 'git',
      label: '变更',
      entries: [
        { key: 'staged:a', status: 'staged', path: 'a', change: 'modified' },
        { key: 'unstaged:b', status: 'unstaged', path: 'b', change: 'modified' },
        { key: 'conflict:c', status: 'conflict', path: 'c', change: 'conflict' },
      ],
    }],
  });
  assert.ok(mixed.selectAll, 'the title row renders a select-all checkbox');
  assert.equal(mixed.selectAll.props.checked, false);
  assert.equal(mixed.selectAll.props.mixed, true, 'one staged of two selectable entries is the mixed state');
  assert.equal(mixed.selectAll.props.disabled, undefined, 'a live, writable list leaves the control enabled');
  assert.equal(mixed.selectAll.props.ariaLabel, mixed.t('nav.selectAll'));
  assert.equal(mixed.selectAll.props.title,
    mixed.t('nav.selectAllHint', { n: '2' }) + ' · ' + mixed.t('nav.checkAll'));
  // It leads the title row, before the "files" label/count.
  const headRow = collectElements(mixed.tree)
    .find((element) => elementClasses(element).includes('gr-files-head-row'));
  assert.ok(headRow, 'the title row is rendered');
  const headChildren = (headRow.props.children || []).flat(3).filter(Boolean);
  assert.equal(headChildren[0], mixed.selectAll, 'select-all is the first control of the title row');
  assert.ok(collectText(headRow).includes(mixed.t('nav.files')));

  // Enabled click: only the non-conflict entries, with the requested state.
  mixed.selectAll.props.onChange(true);
  assert.equal(mixed.calls.length, 1);
  assert.equal(mixed.calls[0][1], true);
  assert.deepEqual(mixed.calls[0][0].map((entry) => entry.key), ['staged:a', 'unstaged:b']);
  assert.equal(mixed.calls[0][0].some((entry) => entry.status === 'conflict'), false,
    'conflict entries never enter the bulk write');

  // All selectable entries staged: checked + the uncheck wording.
  const allStaged = renderFileNav(runtime, {
    groups: [{
      id: 'git',
      label: '变更',
      entries: [
        { key: 'staged:a', status: 'staged', path: 'a' },
        { key: 'staged:b', status: 'staged', path: 'b' },
        { key: 'conflict:c', status: 'conflict', path: 'c' },
      ],
    }],
  });
  assert.equal(allStaged.selectAll.props.checked, true, 'a conflict does not prevent the all-staged state');
  assert.equal(allStaged.selectAll.props.mixed, false);
  assert.equal(allStaged.selectAll.props.title,
    allStaged.t('nav.selectAllHint', { n: '2' }) + ' · ' + allStaged.t('nav.uncheckAll'));
  allStaged.selectAll.props.onChange(false);
  assert.deepEqual(allStaged.calls[0][0].map((entry) => entry.key), ['staged:a', 'staged:b']);
  assert.equal(allStaged.calls[0][1], false);

  // Nothing staged yet: unchecked + the check wording.
  const noneStaged = renderFileNav(runtime, {
    groups: [{
      id: 'git',
      label: '变更',
      entries: [
        { key: 'unstaged:a', status: 'unstaged', path: 'a' },
        { key: 'untracked:b', status: 'untracked', path: 'b' },
      ],
    }],
  });
  assert.equal(noneStaged.selectAll.props.checked, false);
  assert.equal(noneStaged.selectAll.props.mixed, false);
  assert.equal(noneStaged.selectAll.props.title,
    noneStaged.t('nav.selectAllHint', { n: '2' }) + ' · ' + noneStaged.t('nav.checkAll'));
});

test('select-all disables with an explicit reason when the bulk write is unavailable', () => {
  const runtime = createClientRuntime();
  const groups = [{
    id: 'git',
    label: '变更',
    entries: [
      { key: 'unstaged:a', status: 'unstaged', path: 'a' },
      { key: 'staged:b', status: 'staged', path: 'b' },
    ],
  }];

  const busy = renderFileNav(runtime, { groups, busy: true });
  assert.equal(busy.selectAll.props.disabled, true, 'a running write blocks the bulk action');
  assert.equal(busy.selectAll.props.title,
    busy.t('actions.disabledReason', { reason: busy.t('reason.busy') }));

  // A host-truncated list must block the whole-repository write even while idle:
  // the passed reason both disables the control and becomes its tooltip.
  const i18n = runtime.require('i18n');
  for (const locale of ['zh', 'en']) {
    const t = i18n.createI18n(locale).t;
    const truncated = renderFileNav(runtime, {
      groups,
      locale,
      selectAllDisabledReason: t('reason.truncated'),
    });
    assert.equal(truncated.selectAll.props.disabled, true,
      `${locale}: a truncated list must disable select-all`);
    assert.equal(truncated.selectAll.props.title,
      truncated.t('actions.disabledReason', { reason: truncated.t('reason.truncated') }));
    assert.equal(truncated.calls.length, 0);
  }

  // A custom reason takes precedence over the generic busy/nothing fallbacks.
  const custom = renderFileNav(runtime, { groups, selectAllDisabledReason: '当前列表无法批量操作' });
  assert.equal(custom.selectAll.props.disabled, true);
  assert.equal(custom.selectAll.props.title,
    custom.t('actions.disabledReason', { reason: '当前列表无法批量操作' }));

  const noCallback = renderFileNav(runtime, { groups, onToggleAllStaged: undefined });
  assert.equal(noCallback.selectAll.props.disabled, true, 'no write callback means no enabled bulk action');

  const nothingToStage = renderFileNav(runtime, {
    groups: [{ id: 'git', label: '变更', entries: [{ key: 'conflict:a', status: 'conflict', path: 'a' }] }],
  });
  assert.equal(nothingToStage.selectAll.props.checked, false);
  assert.equal(nothingToStage.selectAll.props.disabled, true, 'nothing committable to select');
  assert.equal(nothingToStage.selectAll.props.title,
    nothingToStage.t('actions.disabledReason', { reason: nothingToStage.t('reason.nothingToStage') }));

  const empty = renderFileNav(runtime, { groups: [] });
  assert.equal(empty.selectAll.props.disabled, true);
  assert.equal(empty.selectAll.props.title,
    empty.t('actions.disabledReason', { reason: empty.t('reason.nothingToStage') }));
  assert.equal(empty.calls.length, 0, 'a disabled select-all never writes');
});

test('select-all is scoped to the groups currently listed by the search filter', () => {
  const runtime = createClientRuntime();
  const wholeRepo = [
    { id: 'g1', label: 'g1', entries: [
      { key: 'unstaged:a', status: 'unstaged', path: 'src/a.js' },
      { key: 'staged:b', status: 'staged', path: 'src/b.js' },
    ] },
    { id: 'g2', label: 'g2', entries: [
      { key: 'untracked:c', status: 'untracked', path: 'docs/c.md' },
    ] },
  ];
  const full = renderFileNav(runtime, { groups: wholeRepo });
  full.selectAll.props.onChange(true);
  assert.deepEqual(full.calls[0][0].map((entry) => entry.key),
    ['unstaged:a', 'staged:b', 'untracked:c'], 'with no filter the scope is the whole repository');
  assert.equal(full.selectAll.props.title,
    full.t('nav.selectAllHint', { n: '3' }) + ' · ' + full.t('nav.checkAll'));

  // app.js narrows the groups to the search hits before rendering FileNav, so a
  // select-all on a filtered list can only write what is on screen.
  const filtered = renderFileNav(runtime, {
    groups: [{ id: 'g1', label: 'g1', entries: [
      { key: 'unstaged:a', status: 'unstaged', path: 'src/a.js' },
    ] }],
    search: 'a.js',
  });
  filtered.selectAll.props.onChange(true);
  assert.deepEqual(filtered.calls[0][0].map((entry) => entry.key), ['unstaged:a']);
  assert.equal(filtered.selectAll.props.title,
    filtered.t('nav.selectAllHint', { n: '1' }) + ' · ' + filtered.t('nav.checkAll'));

  // Locale-specific scope wording comes from the shared dictionary.
  const en = renderFileNav(runtime, { groups: wholeRepo, locale: 'en' });
  assert.ok(en.selectAll.props.title.startsWith(en.t('nav.selectAllHint', { n: '3' }) + ' · '),
    en.selectAll.props.title);
  assert.equal(en.selectAll.props.ariaLabel, en.t('nav.selectAll'));
});

test('select-all copy exists in both locales with a replaceable scope count', () => {
  const runtime = createClientRuntime();
  const i18n = runtime.require('i18n');
  for (const locale of ['zh', 'en']) {
    const dict = i18n.DICTIONARIES[locale];
    for (const key of ['nav.selectAll', 'nav.selectAllHint', 'nav.checkAll', 'nav.uncheckAll']) {
      assert.equal(typeof dict[key], 'string', `${locale}: missing ${key}`);
      assert.ok(dict[key].length > 0, `${locale}: ${key} must not be empty`);
    }
    assert.ok(dict['nav.selectAllHint'].includes('{n}'), `${locale}: the hint must interpolate the scope count`);
    const t = i18n.createI18n(locale).t;
    const rendered = t('nav.selectAllHint', { n: '3' });
    assert.ok(rendered.includes('3'), `${locale}: scope count missing from ${rendered}`);
    assert.equal(rendered.includes('{n}'), false, `${locale}: unsubstituted placeholder in ${rendered}`);
    assert.notEqual(t('nav.checkAll'), t('nav.uncheckAll'), `${locale}: check/uncheck wording must differ`);
  }
  const zh = i18n.createI18n('zh').t;
  const en = i18n.createI18n('en').t;
  for (const key of ['nav.selectAll', 'nav.selectAllHint', 'nav.checkAll', 'nav.uncheckAll']) {
    assert.notEqual(zh(key), en(key), `${key} must be localized, not shared verbatim`);
  }
  // The disabled title composes the shared reason wrapper with a reason key.
  const disabled = zh('actions.disabledReason', { reason: zh('reason.busy') });
  assert.ok(disabled.includes(zh('reason.busy')));
  assert.equal(disabled.includes('{reason}'), false);
  // The header checkbox keeps its own layout hook.
  assert.match(stylesSource, /\.gr-files-select-all \{/);
});


test('stage/unstage expected maps bind the exact operation set', () => {
  const runtime = createClientRuntime();
  const app = runtime.require('app');
  const fingerprint = (id) => ({ base: 'base-' + id, target: 'target-' + id });
  const entries = [
    { key: 'staged:a', status: 'staged', fingerprint: fingerprint(1) },
    { key: 'unstaged:a', status: 'unstaged', fingerprint: fingerprint(2) },
    { key: 'untracked:b', status: 'untracked', fingerprint: fingerprint(3) },
    { key: 'conflict:c', status: 'conflict', fingerprint: fingerprint(4) },
  ];

  const stageAll = app.expectedFingerprints(entries, 'stage', 'all');
  // Host stage("all") targets are exactly the unstaged rows plus untracked rows;
  // already-staged rows and conflicts are not targets, so they must not be in
  // the exact expected set (the host rejects extra keys as stale).
  assert.deepEqual(Object.keys(stageAll).sort(), ['unstaged:a', 'untracked:b']);
  assert.deepEqual(stageAll['unstaged:a'], fingerprint(2));

  const unstageAll = app.expectedFingerprints(entries, 'unstage', 'all');
  assert.deepEqual(Object.keys(unstageAll), ['staged:a']);

  const single = app.expectedFingerprints(entries, 'stage', ['untracked:b']);
  assert.deepEqual(Object.keys(single), ['untracked:b']);

  assert.deepEqual(app.expectedFingerprints(entries, 'stage', ['missing']), {});
});

test('app.js passes expected fingerprints and targetBranch on the write calls', () => {
  // Source-level guard: stage/unstage must send `expected`, push must send the
  // target branch (never the local source branch as `branch`).
  assert.match(appSource, /expected: expectedFingerprints\(list, 'stage', keys\)/);
  assert.match(appSource, /expected: expectedFingerprints\(list, 'unstage', keys\)/);
  assert.match(appSource, /params\.targetBranch = target/);
  assert.doesNotMatch(appSource, /params\.branch = branch/);
});

test('push defaults keep the requested remote/target and fall back to the preview', () => {
  const runtime = createClientRuntime();
  const app = runtime.require('app');
  const preview = {
    sourceBranch: 'main',
    targetBranch: 'release',
    remote: 'origin',
    defaultRemote: 'origin',
    remotes: [{ name: 'origin' }, { name: 'upstream' }],
  };
  assert.deepEqual(app.pushDefaults(preview, 'upstream', 'hotfix'), { remote: 'upstream', target: 'hotfix' });
  assert.deepEqual(app.pushDefaults(preview, '', ''), { remote: 'origin', target: 'release' });
  assert.deepEqual(app.pushDefaults(null, undefined, undefined), { remote: '', target: '' });
});

/* ------------------------------------------------------------------------- */
/* P2-19 — transport errors are stable codes, not localized text             */
/* ------------------------------------------------------------------------- */

test('rpc transport failures carry stable codes (translated by the UI)', async () => {
  const runtime = createClientRuntime();
  const rpcModule = runtime.require('rpc');
  const httpRpc = rpcModule.createRpc({
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  await assert.rejects(httpRpc.call('status'), (error) => error.code === 'transport/http-503');
  const badJsonRpc = rpcModule.createRpc({
    fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }),
  });
  await assert.rejects(badJsonRpc.call('status'), (error) => error.code === 'transport/bad-json');
  const badEnvelopeRpc = rpcModule.createRpc({
    fetch: async () => ({ ok: true, status: 200, json: async () => [1, 2, 3] }),
  });
  await assert.rejects(badEnvelopeRpc.call('status'), (error) => error.code === 'transport/bad-envelope');
});

/* ------------------------------------------------------------------------- */
/* Branch chip — read-only popover with copy actions (cover)                 */
/* ------------------------------------------------------------------------- */

test('the branch popover lists HEAD/upstream facts and copy actions, never branch switching', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const i18n = runtime.require('i18n');
  const zh = i18n.createI18n('zh').t;
  const repo = {
    root: '/repo/x',
    branch: 'main',
    detached: false,
    headSha: 'abcdef1234567890',
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
  };

  const items = components.branchMenuItems(repo, zh);
  const actionable = items.filter((item) => !item.separator);
  assert.deepEqual(actionable.map((item) => item.id),
    ['info-head', 'info-upstream', 'info-tracking', 'set-remote', 'copy-branch', 'copy-path']);
  assert.equal(items.filter((item) => item.separator).length, 2, 'separators split facts / remote action / copy actions');
  const byId = new Map(actionable.map((item) => [item.id, item]));
  assert.equal(byId.get('info-head').label, zh('branch.head', { sha: 'abcdef12' }));
  assert.equal(byId.get('info-head').disabled, true);
  assert.equal(byId.get('info-upstream').label, zh('branch.upstream', { name: 'origin/main' }));
  assert.equal(byId.get('info-upstream').disabled, true);
  assert.equal(byId.get('info-tracking').label, zh('push.aheadBehind', { ahead: '2', behind: '1' }));
  assert.equal(byId.get('info-tracking').disabled, true);
  // Remote setup sits between the read-only facts and the copy actions and is
  // repo-level, so it stays enabled even with a detached HEAD or no root.
  assert.equal(byId.get('set-remote').label, zh('branch.setRemote'));
  assert.equal(byId.get('set-remote').disabled, undefined);
  const setRemoteIndex = actionable.findIndex((item) => item.id === 'set-remote');
  assert.ok(setRemoteIndex > actionable.findIndex((item) => item.id === 'info-tracking'));
  assert.ok(setRemoteIndex < actionable.findIndex((item) => item.id === 'copy-branch'));
  assert.equal(byId.get('copy-branch').label, zh('branch.copyName'));
  assert.equal(byId.get('copy-branch').disabled, false);
  assert.equal(byId.get('copy-path').label, zh('branch.copyPath'));
  assert.equal(byId.get('copy-path').disabled, false);
  // Read-only by design: the panel reviews the current checkout and cannot
  // switch, create or check out a branch from here.
  assert.equal(actionable.some((item) => /switch|checkout|create/i.test(String(item.id))), false);

  // Copy actions are disabled when there is nothing valid to copy.
  const detached = components.branchMenuItems({ root: '/repo/x', branch: 'main', detached: true }, zh);
  assert.equal(detached.find((item) => item.id === 'copy-branch').disabled, true,
    'detached HEAD has no branch name to copy');
  assert.equal(detached.find((item) => item.id === 'copy-path').disabled, false);

  const emptyBranch = components.branchMenuItems({ root: '/repo/x', branch: '', detached: false }, zh);
  assert.equal(emptyBranch.find((item) => item.id === 'copy-branch').disabled, true,
    'an unknown branch name is not copyable');

  const noRoot = components.branchMenuItems({ branch: 'main', detached: false }, zh);
  assert.equal(noRoot.find((item) => item.id === 'copy-path').disabled, true,
    'a missing repository root is not copyable');

  // Setting a remote is repo-level: it never depends on a branch name or root.
  for (const variant of [detached, emptyBranch, noRoot]) {
    assert.equal(variant.find((item) => item.id === 'set-remote').disabled, undefined);
  }

  // Missing facts simply do not get a row; a missing upstream is stated explicitly.
  const bare = components.branchMenuItems({ root: '/repo/x', branch: 'main', detached: false }, zh);
  assert.equal(bare.find((item) => item.id === 'info-upstream').label, zh('branch.noUpstream'));
  assert.equal(bare.some((item) => item.id === 'info-head'), false, 'no HEAD row without a sha');
  assert.equal(bare.some((item) => item.id === 'info-tracking'), false, 'no tracking row without ahead/behind');
  assert.deepEqual(components.branchMenuItems(null, zh), [], 'no repository means no menu items');

  // Labels come from the shared dictionary in both locales.
  const en = i18n.createI18n('en').t;
  const enItems = components.branchMenuItems(repo, en);
  assert.equal(enItems.find((item) => item.id === 'info-upstream').label,
    en('branch.upstream', { name: 'origin/main' }));
  assert.equal(enItems.find((item) => item.id === 'info-tracking').label,
    en('push.aheadBehind', { ahead: '2', behind: '1' }));
});

test('the toolbar branch chip is an accessible menu trigger that stays closed by default', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const t = runtime.require('i18n').createI18n('zh').t;
  const repo = {
    root: '/repo/x',
    branch: 'main',
    detached: false,
    headSha: 'abcdef123456',
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
  };
  const status = {
    state: 'ok',
    repo,
    summary: { files: 4, entries: 4, staged: 1, unstaged: 1, untracked: 1, conflicts: 1 },
  };
  const tree = components.TopBar({ t, status, repo, onCopy: () => {} });
  // Header + sibling popover: the toolbar is a size container, so a fixed menu
  // descendant would be clipped by it instead of the viewport.
  assert.equal(tree.type, runtime.react.Fragment, 'TopBar root is a fragment of header + branch popover');

  const triggers = elementsByClass(tree, 'gr-branch-trigger');
  assert.equal(triggers.length, 1, 'the branch chip is a real button');
  const trigger = triggers[0];
  assert.equal(trigger.type, 'button');
  assert.ok(elementClasses(trigger).includes('gr-chip'));
  assert.ok(elementClasses(trigger).includes('gr-chip-branch'));
  assert.equal(trigger.props['aria-haspopup'], 'menu');
  assert.equal(trigger.props['aria-expanded'], 'false', 'the popover starts closed');
  assert.equal(trigger.props.title, t('branch.details'));
  assert.ok(collectText(trigger).includes('main'), 'the current branch is labelled on the chip');
  const inside = collectElements(trigger.props.children);
  assert.equal(inside.filter((element) => elementClasses(element).includes('gr-chip-chevron')).length, 1,
    'the chip carries a disclosure chevron');
  assert.ok(inside.some((element) => typeof element.type === 'function'
    && element.type.name === 'IconChevronDown'), 'the chevron is the down glyph');
  // Read-only facts are exposed as the accessible description because disabled
  // menu rows are skipped by roving focus.
  const description = String(trigger.props['aria-description'] || '');
  assert.ok(description.includes(t('branch.head', { sha: 'abcdef12' })), description);
  assert.ok(description.includes(t('branch.upstream', { name: 'origin/main' })), description);

  // Closed popover: no menu is mounted, but the one-line header is.
  assert.equal(elementsByClass(tree, 'gr-menu').length, 0, 'the menu is only mounted while open');
  assert.equal(collectElements(tree).some((element) => element.props['data-gr-menu'] === 'true'), false);
  assert.equal(elementsByClass(tree, 'gr-topbar').length, 1);

  // Without a repository the chip disappears; the toolbar keeps working.
  const bare = components.TopBar({ t, status: { repo: null, summary: null }, repo: null });
  assert.equal(elementsByClass(bare, 'gr-branch-trigger').length, 0);
  assert.equal(elementsByClass(bare, 'gr-topbar').length, 1);

  // A repo without a summary yet (loading) keeps the trigger but no marks.
  const loading = components.TopBar({ t, status: { state: 'loading', repo }, repo });
  assert.equal(elementsByClass(loading, 'gr-branch-trigger').length, 1);
  assert.equal(elementsByClass(loading, 'gr-sum-item').length, 0);

  // Detached HEAD warns on the chip and is labelled as such.
  const detachedRepo = { root: '/repo/x', branch: 'main', detached: true };
  const detached = components.TopBar({ t, status: { repo: detachedRepo, summary: null }, repo: detachedRepo });
  const detachedTrigger = elementsByClass(detached, 'gr-branch-trigger')[0];
  assert.ok(elementClasses(detachedTrigger).includes('gr-chip-warn'));
  assert.ok(collectText(detachedTrigger).includes(t('state.detached')));

  // The two copy rows dispatch through the shared clipboard callback the file
  // menu also uses (interaction itself needs React state, so this stays a
  // contract assertion on the dispatch table).
  assert.match(componentsSource,
    /if \(id === 'copy-branch' && repo\.branch && !repo\.detached\) props\.onCopy\(String\(repo\.branch\)\)/);
  assert.match(componentsSource, /else if \(id === 'copy-path' && repo\.root\) props\.onCopy\(String\(repo\.root\)\)/);
  assert.match(stylesSource, /\.gr-branch-trigger \{/);
  assert.match(stylesSource, /\.gr-chip-chevron \{/);
});

/* ------------------------------------------------------------------------- */
/* Toolbar summary marks — semantic shape, not just colour (cover)           */
/* ------------------------------------------------------------------------- */

test('summary marks use semantic glyphs: check for staged, alert for conflicts, plain rings otherwise', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');

  function mark(kind) {
    const tree = components.statusGlyph(kind);
    assert.equal(tree.type, 'span');
    assert.deepEqual(elementClasses(tree), ['gr-sum-icon', 'gr-sum-icon-' + kind],
      `${kind} mark must carry its semantic class`);
    assert.equal(tree.props['aria-hidden'], 'true', 'marks are decorative and never read as text');
    return tree;
  }

  function iconTypes(tree) {
    return collectElements(tree)
      .filter((element) => typeof element.type === 'function')
      .map((element) => element.type.name);
  }

  const staged = mark('staged');
  assert.ok(iconTypes(staged).includes('IconCheck'), 'staged reads as a check');
  const renderedIcons = [];
  for (const icon of collectElements(staged).filter((element) => typeof element.type === 'function')) {
    walkElements(icon.type(icon.props), (element) => renderedIcons.push(element));
  }
  const stagedSvg = renderedIcons.find((element) => element.type === 'svg');
  assert.ok(stagedSvg, 'the check glyph is an inline svg');
  assert.equal(stagedSvg.props.className, 'gr-ico');
  assert.equal(stagedSvg.props['aria-hidden'], 'true');

  assert.ok(iconTypes(mark('conflict')).includes('IconAlert'), 'conflicts read as an alert');

  for (const kind of ['unstaged', 'untracked']) {
    const plain = mark(kind);
    assert.equal(plain.props.children, undefined, `${kind} uses a plain CSS ring without an icon`);
    assert.equal(iconTypes(plain).length, 0);
    assert.equal(collectElements(plain).filter((element) => element.type === 'svg').length, 0);
  }

  // The toolbar renders exactly the marks the summary carries, each with the
  // matching semantic glyph (so staged/conflicts stay distinguishable by shape).
  const t = runtime.require('i18n').createI18n('zh').t;
  const repo = { root: '/repo/x', branch: 'main', detached: false };
  const summary = { files: 4, entries: 4, staged: 1, unstaged: 1, untracked: 1, conflicts: 1 };
  const toolbar = components.TopBar({ t, status: { repo, summary }, repo });
  assert.equal(elementsByClass(toolbar, 'gr-sum-item').length, 4,
    'one mark per non-empty summary category');
  for (const kind of ['staged', 'unstaged', 'untracked', 'conflict']) {
    assert.equal(elementsByClass(toolbar, 'gr-sum-icon-' + kind).length, 1,
      `missing semantic glyph for ${kind}`);
  }
  assert.match(stylesSource, /\.gr-sum-icon-staged \{/);
  assert.match(stylesSource, /\.gr-sum-icon-conflict \{/);
});

/* ------------------------------------------------------------------------- */
/* Diff header — compact change position, full text in title + sr-only       */
/* ------------------------------------------------------------------------- */

test('the diff header shows a compact change position with the full label as tooltip and sr-only text', () => {
  const runtime = createClientRuntime();
  const i18n = runtime.require('i18n');

  // The visible counter is the tight "{index} / {total}" form; the localized
  // full sentence stays in the tooltip and in an sr-only span.
  const counterStart = diffViewSource.indexOf("className: 'gr-diff-counter'");
  const counterEnd = diffViewSource.indexOf("key: 'nav'", counterStart);
  assert.ok(counterStart !== -1 && counterEnd > counterStart,
    'the diff header still renders a change counter');
  const counterBlock = diffViewSource.slice(counterStart, counterEnd);
  assert.match(counterBlock, /t\('diff\.changePosition'/);
  assert.match(counterBlock, /title: changeCounterLabel/);
  assert.match(counterBlock, /h\('span', \{ className: 'gr-sr-only' \}, changeCounterLabel\)/,
    'the full label is announced to screen readers');
  assert.match(diffViewSource, /var changeCounterLabel = t\('diff\.changeCounter'/);
  assert.match(stylesSource, /\.gr-diff-counter \{[^}]*font-variant-numeric: tabular-nums/);

  for (const locale of ['zh', 'en']) {
    const t = i18n.createI18n(locale).t;
    const positionTemplate = i18n.DICTIONARIES[locale]['diff.changePosition'];
    assert.ok(positionTemplate.includes('{index}') && positionTemplate.includes('{total}'),
      `${locale}: compact counter template must keep {index}/{total}: ${positionTemplate}`);
    const position = t('diff.changePosition', { index: '2', total: '5' });
    assert.ok(position.includes('2') && position.includes('5'), `${locale}: ${position}`);
    assert.equal(position.includes('{'), false, `${locale}: unsubstituted placeholder in ${position}`);
    const full = t('diff.changeCounter', { index: '2', total: '5' });
    assert.ok(full.includes('2') && full.includes('5'), `${locale}: full counter misses index/total`);
    assert.notEqual(position, full, `${locale}: compact counter must differ from the full sentence`);
    // Conventional Commits example, localized but always showing the feat: prefix.
    assert.ok(t('commit.messagePlaceholder').includes('feat:'),
      `${locale}: commit placeholder must demonstrate Conventional Commits`);
  }
});

test('the commit drawer advertises the Conventional Commits placeholder', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const i18n = runtime.require('i18n');
  for (const locale of ['zh', 'en']) {
    const t = i18n.createI18n(locale).t;
    const tree = components.CommitPanel({
      t,
      open: true,
      message: '',
      count: 1,
      onToggle: () => {},
      onMessageChange: () => {},
    });
    const textareas = collectElements(tree).filter((element) =>
      typeof element.type === 'function' && element.type.name === 'Textarea');
    assert.equal(textareas.length, 1, `${locale}: the open drawer has one message field`);
    assert.equal(textareas[0].props.placeholder, t('commit.messagePlaceholder'));
    assert.ok(textareas[0].props.placeholder.includes('feat:'),
      `${locale}: the example must show a Conventional Commit type`);
  }
});

/* ------------------------------------------------------------------------- */
/* Popover trigger contract — outside clicks must not fight the toggle       */
/* ------------------------------------------------------------------------- */

test('the outside-click handler honors the menu trigger so a toggle cannot close-then-reopen', () => {
  // ContextMenu's documented ignoreRef extra: clicks inside the anchor are not
  // "outside", so a toggle button closes the menu instead of close + reopen.
  assert.match(componentsSource, /var ignore = props\.ignoreRef && props\.ignoreRef\.current;/);
  assert.match(componentsSource, /ignore\.contains\(event\.target\)/);
  assert.match(componentsSource, /doc\.addEventListener\('mousedown', onOutside, true\)/);
  assert.match(componentsSource, /doc\.addEventListener\('contextmenu', onOutside, true\)/);
  // Both popover consumers pass their trigger ref.
  assert.equal(componentsSource.split('ignoreRef: branchTriggerRef').length - 1, 1);
  assert.match(componentsSource, /ignoreRef: anchorRef/);
});

/* ------------------------------------------------------------------------- */
/* app wiring — shared clipboard + persistent status payload (cover)         */
/* ------------------------------------------------------------------------- */

test('app wires the shared clipboard and mounts the persistent status strip', () => {
  // One clipboard helper serves both the file-row menu and the branch popover.
  assert.match(appSource, /var copyText = useCallback\(function \(value\)/);
  assert.match(appSource, /onCopy: copyText/);
  assert.match(appSource, /else if \(id === 'copy'\) copyText\(entry\.path\)/);
  assert.match(appSource, /navigator\.clipboard\.writeText/);
  assert.match(appSource, /t\('common\.copied'\)/);

  // The strip gets the live snapshot (Ready + summary) and folds the refresh
  // error into the same error slot as operation errors.
  const start = appSource.indexOf('h(components.StatusBar, {');
  assert.notEqual(start, -1, 'app.js renders StatusBar');
  const block = appSource.slice(start, appSource.indexOf('}),', start) + 3);
  assert.match(block, /status: snapshot/);
  assert.match(block, /repo: snapshot && snapshot\.repo \? snapshot\.repo : null/);
  assert.match(block, /busy: !!busy \|\| commitBusy \|\| commitGenerating/);
  assert.match(block, /operation: busy\s*\? t\('op\.running'\)\s*:\s*commitGenerating\s*\? t\('commit\.generating'\)/);
  assert.match(block, /error: operationError \|\| \(refreshError \? \{ message: describeError\(refreshError, t\) \} : null\)/);
  assert.match(block, /onDismiss: function \(\) \{ setOperationError\(null\); setNotice\(null\); setRefreshError\(null\); \}/);
  // The footer closes the panel body, after the workspace and commit drawer.
  assert.ok(start > appSource.indexOf('h(components.CommitPanel, {'),
    'the status strip is mounted after the commit drawer');
});

/* ------------------------------------------------------------------------- */
/* app wiring — header select-all reuses the group bulk writer (cover)       */
/* ------------------------------------------------------------------------- */

test('app wires the header select-all to the filtered groups and drops toolbar bulk props', () => {
  // One writer serves group checkboxes and the header select-all; it skips
  // conflicts and only writes the direction that applies.
  assert.match(appSource, /onToggleAllStaged: toggleGroupStaged/);
  assert.match(appSource, /selectAllDisabledReason: selectAllDisabledReason/);
  assert.match(appSource, /var selectAllDisabledReason = truncated\s*\? t\('reason\.truncated'\)/);
  assert.match(appSource, /: \(busy \? t\('reason\.busy'\) : ''\);/);
  assert.match(appSource, /var toggleGroupStaged = useCallback\(function \(list, next\) \{[\s\S]{0,700}?item\.status === 'conflict'/);

  // FileNav receives the search-filtered groups plus the shared write guard.
  const fileNavStart = appSource.indexOf('h(components.FileNav, {');
  assert.notEqual(fileNavStart, -1, 'app.js renders FileNav');
  const fileNavBlock = appSource.slice(fileNavStart, appSource.indexOf('var displayedEntry', fileNavStart));
  assert.match(fileNavBlock, /groups: visibleGroups/);
  assert.match(fileNavBlock, /onToggleAllStaged: toggleGroupStaged/);
  assert.match(fileNavBlock, /selectAllDisabledReason: selectAllDisabledReason/);
  assert.match(fileNavBlock, /busy: !!busy/);

  // The toolbar no longer receives any stage-all/unstage-all prop.
  const topBarStart = appSource.indexOf('h(components.TopBar, {');
  assert.notEqual(topBarStart, -1, 'app.js renders TopBar');
  const topBarBlock = appSource.slice(topBarStart, appSource.indexOf('var fileNav', topBarStart));
  for (const prop of ['canStageAll', 'canUnstageAll', 'stageAllBusy', 'unstageAllBusy',
    'stageAllTitle', 'unstageAllTitle', 'stageAllDisabledReason', 'unstageAllDisabledReason',
    'disabledReason:', 'onStageAll', 'onUnstageAll']) {
    assert.equal(topBarBlock.includes(prop), false, `app.js must not pass ${prop} to TopBar`);
  }
});

/* ------------------------------------------------------------------------- */
/* AI grouping stability — staging a file must not reclassify (user report)  */
/* ------------------------------------------------------------------------- */

function signatureCount(signature) {
  return Number(String(signature).split(':').pop());
}

test('the AI grouping signature ignores index state, so staging does not reclassify', () => {
  const runtime = createClientRuntime();
  const app = runtime.require('app');
  assert.equal(typeof app.aiEntriesSignature, 'function');

  const workingTree = [
    { key: 'unstaged:a', status: 'unstaged', path: 'src/a.js', change: 'modified', fingerprint: { base: 'b-a', target: 't-a' } },
    { key: 'untracked:b', status: 'untracked', path: 'docs/b.md', change: 'added', fingerprint: { base: 'b-b', target: 't-b' } },
  ];
  // Checking a checkbox rewrites key/status/fingerprint — never path/change.
  const staged = [
    { key: 'staged:a', status: 'staged', path: 'src/a.js', change: 'modified', fingerprint: { base: 'B-a', target: 'T-a' } },
    workingTree[1],
  ];
  assert.equal(app.aiEntriesSignature(staged), app.aiEntriesSignature(workingTree),
    'the same file set must keep the same signature across stage/unstage (no AI reclassification)');
  // Order does not matter (the signature is sorted), and each file counts once
  // even when it appears as both staged and unstaged rows.
  assert.equal(app.aiEntriesSignature(workingTree.slice().reverse()), app.aiEntriesSignature(workingTree));
  assert.equal(signatureCount(app.aiEntriesSignature([
    { key: 'staged:a', status: 'staged', path: 'src/a.js', change: 'modified' },
    { key: 'unstaged:a', status: 'unstaged', path: 'src/a.js', change: 'modified' },
  ])), 1, 'a file present as staged + unstaged still counts once');

  // New/removed paths and a changed change-kind are real grouping inputs.
  const added = workingTree.concat([{ key: 'unstaged:c', status: 'unstaged', path: 'src/c.js', change: 'added' }]);
  assert.notEqual(app.aiEntriesSignature(added), app.aiEntriesSignature(workingTree));
  assert.notEqual(app.aiEntriesSignature(workingTree.slice(0, 1)), app.aiEntriesSignature(workingTree));
  assert.notEqual(
    app.aiEntriesSignature([{ key: 'u:a', status: 'unstaged', path: 'src/a.js', change: 'added' }]),
    app.aiEntriesSignature([{ key: 'u:a', status: 'unstaged', path: 'src/a.js', change: 'modified' }]),
    'a change-kind switch is a reclassification trigger',
  );
  // A rename carries its old path, so it is a different grouping input.
  assert.notEqual(
    app.aiEntriesSignature([{ key: 's:r', status: 'staged', path: 'new.js', oldPath: 'old.js', change: 'renamed' }]),
    app.aiEntriesSignature([{ key: 's:r', status: 'staged', path: 'new.js', change: 'renamed' }]),
  );
  // Path-less rows contribute nothing to the grouping signature.
  assert.equal(signatureCount(app.aiEntriesSignature([{ key: 'x', status: 'unstaged' }])), 0);
});

test('classification results map entry keys to paths and drop unmappable categories', () => {
  const runtime = createClientRuntime();
  const app = runtime.require('app');
  assert.equal(typeof app.aiPathGroups, 'function');
  const keyPaths = { 'unstaged:a': 'src/a.js', 'staged:b': 'docs/b.md' };
  const result = {
    categories: [
      { name: '界面', description: '前端交互', ids: ['unstaged:a', 'unknown-key'] },
      { name: '文档', ids: ['staged:b'] },
      { name: '空组', ids: ['also-unknown'] },
    ],
  };
  assert.deepEqual(app.aiPathGroups(result, keyPaths), [
    { name: '界面', description: '前端交互', paths: ['src/a.js'] },
    { name: '文档', description: '', paths: ['docs/b.md'] },
  ], 'categories become path groups; unknown ids and empty categories are dropped');

  // Without a usable path mapping the caller must fall back to git groups.
  assert.equal(app.aiPathGroups(result, {}), null);
  assert.equal(app.aiPathGroups(result, null), null);
  assert.equal(app.aiPathGroups(null, keyPaths), null);
  assert.equal(app.aiPathGroups({ categories: [] }, keyPaths), null);
  assert.equal(app.aiPathGroups({ categories: [{ name: 'x' }] }, keyPaths), null);

  // Description is passed through unchanged; name is always a string.
  const named = app.aiPathGroups({ categories: [
    { name: 'x', description: 'why', ids: ['unstaged:a'] },
  ] }, keyPaths);
  assert.equal(named[0].description, 'why');
  assert.equal(typeof named[0].name, 'string');
});

test('the non-functional category keeps its kind and is localized in the navigation', () => {
  const runtime = createClientRuntime();
  const app = runtime.require('app');
  const keyPaths = { 'unstaged:config': 'vite.config.js', 'unstaged:feature': 'src/feature.js' };
  const result = {
    grouping: 'logic',
    categories: [
      { kind: 'non-functional', name: 'NON_FUNCTIONAL', description: '构建与 CI 配置', ids: ['unstaged:config'] },
      { name: '登录功能', description: '登录调用链', ids: ['unstaged:feature'] },
    ],
  };
  // The kind travels from the Host reply to the path groups, so the navigation
  // can localize the machine name (`NON_FUNCTIONAL`) instead of showing it.
  assert.deepEqual(app.aiPathGroups(result, keyPaths), [
    { name: 'NON_FUNCTIONAL', description: '构建与 CI 配置', paths: ['vite.config.js'], kind: 'non-functional' },
    { name: '登录功能', description: '登录调用链', paths: ['src/feature.js'] },
  ]);
  // A non-functional category without a description still carries the kind.
  const bare = app.aiPathGroups({ categories: [
    { kind: 'non-functional', name: 'NON_FUNCTIONAL', ids: ['unstaged:config'] },
  ] }, keyPaths);
  assert.equal(bare[0].kind, 'non-functional');
  assert.equal(bare[0].description, '');
  // The app forwards the kind through the AI group list and the search filter.
  assert.match(appSource, /kind: category\.kind === 'non-functional' \? 'non-functional' : ''/);
  assert.match(appSource, /description: group\.description, kind: group\.kind/);

  const entries = [
    { key: 'unstaged:config', status: 'unstaged', path: 'vite.config.js', change: 'modified' },
    { key: 'unstaged:feature', status: 'unstaged', path: 'src/feature.js', change: 'modified' },
  ];
  for (const locale of ['zh', 'en']) {
    const t = runtime.require('i18n').createI18n(locale).t;
    const tree = renderFileNav(runtime, {
      locale,
      groups: [
        {
          id: 'ai:NON_FUNCTIONAL', label: 'NON_FUNCTIONAL', kind: 'non-functional',
          description: '构建与 CI 配置', tone: 'ai', entries: [entries[0]],
        },
        { id: 'ai:登录功能', label: '登录功能', description: '登录调用链', tone: 'ai', entries: [entries[1]] },
      ],
    });
    const heads = elementsByClass(tree.tree, 'gr-group-head-btn');
    assert.equal(heads.length, 2, `${locale}: both groups render headers`);
    const nonFunctional = heads[0];
    assert.ok(collectText(nonFunctional).includes(t('nav.nonFunctional')),
      `${locale}: the non-functional heading is localized`);
    assert.equal(collectText(nonFunctional).includes('NON_FUNCTIONAL'), false,
      `${locale}: the machine category name is never user-facing`);
    assert.equal(nonFunctional.props.title, '构建与 CI 配置',
      `${locale}: the model description is the group tooltip`);
    // The regular AI category keeps its own label/tooltip untouched.
    assert.ok(collectText(heads[1]).includes('登录功能'));

    // Without a description the tooltip falls back to localized copy.
    const fallback = renderFileNav(runtime, {
      locale,
      groups: [{
        id: 'ai:NON_FUNCTIONAL', label: 'NON_FUNCTIONAL', kind: 'non-functional',
        tone: 'ai', entries: [entries[0]],
      }],
    });
    const fallbackHead = elementsByClass(fallback.tree, 'gr-group-head-btn')[0];
    assert.equal(fallbackHead.props.title, t('nav.nonFunctionalHint'),
      `${locale}: the fallback tooltip explains the non-functional bucket`);
  }

  // The group checkbox keeps the existing per-group staging behavior.
  const calls = [];
  const groupTree = renderFileNav(runtime, {
    locale: 'zh',
    groups: [{
      id: 'ai:NON_FUNCTIONAL', label: 'NON_FUNCTIONAL', kind: 'non-functional',
      tone: 'ai', entries: [entries[0], entries[1]],
    }],
    onToggleGroupStaged: (list, next) => { calls.push([list.length, next]); },
  });
  const groupCheck = elementsByClass(groupTree.tree, 'gr-group-check')[0];
  assert.ok(groupCheck, 'the non-functional group keeps its staging checkbox');
  assert.equal(groupCheck.props.disabled, false);
  groupCheck.props.onChange(true);
  assert.deepEqual(calls, [[2, true]], 'checking the group stages all of its entries');
});

test('the grouping selector maps each option to the persisted settings patch', () => {
  const runtime = createClientRuntime();
  const app = runtime.require('app');
  assert.equal(typeof app.groupingSettingsPatch, 'function');
  assert.deepEqual(app.groupingSettingsPatch('git'), { aiClassify: false },
    'Git status only turns AI grouping off');
  assert.deepEqual(app.groupingSettingsPatch('role'), { aiClassify: true, aiGrouping: 'role' });
  assert.deepEqual(app.groupingSettingsPatch('logic'), { aiClassify: true, aiGrouping: 'logic' });

  // The persisted mode is read back from the Host, merged optimistically and
  // handed to the settings dialog as well.
  assert.match(appSource, /aiGrouping: value && value\.aiGrouping === 'logic' \? 'logic' : 'role'/);
  assert.match(appSource, /if \('aiGrouping' in patch\) nextValue\.aiGrouping = patch\.aiGrouping === 'logic' \? 'logic' : 'role';/);
  assert.match(appSource, /var keys = \['aiClassify', 'aiGrouping', /);
  assert.match(stateSource, /value: \{ aiClassify: false, aiGrouping: 'role', /);
  assert.match(appSource, /aiGrouping: value\.aiGrouping === 'logic' \? 'logic' : 'role',\s*preclassify/);

  // TopBar receives the live mode and the patch writer; the old toggle callback
  // is gone and reclassify just re-requests the active classification.
  assert.match(appSource, /aiMode: aiEnabled,\s*aiGrouping: aiGrouping,/);
  assert.match(appSource, /onChangeGrouping: function \(value\) \{\s*saveSettings\(groupingSettingsPatch\(value\)\)/);
  const topBarStart = appSource.indexOf('h(components.TopBar, {');
  const topBarBlock = appSource.slice(topBarStart, appSource.indexOf('var fileNav', topBarStart));
  assert.equal(topBarBlock.includes('onToggleAiMode'), false, 'the old Git/AI toggle callback is gone');
  assert.match(topBarBlock, /onReclassify: function \(\) \{\s*requestAi\(\{ force: true \}\);/,
    'regroup only asks for a fresh classification of the active mode');
});

test('classify requests carry the grouping mode and replies from another mode are dropped', () => {
  const runtime = createClientRuntime();
  const app = runtime.require('app');
  assert.equal(typeof app.groupingSettingsPatch, 'function');

  // Request: the mode snapshot is part of the protocol payload.
  assert.match(appSource, /var requestedGrouping = aiGroupingRef\.current;/);
  assert.match(appSource, /var params = \{ requestId: requestId, entries: payloadEntries, grouping: requestedGrouping \};/);

  // Reply: only accept a result that names both the requested and the still
  // active grouping mode (a late reply for the old mode is ignored).
  assert.match(appSource, /var activeGrouping = aiGroupingRef\.current;/);
  assert.match(appSource, /value\.grouping === 'role' \|\| value\.grouping === 'logic'/);
  assert.match(appSource, /if \(requestedGrouping !== activeGrouping \|\| responseGrouping !== activeGrouping\) return;/);

  // Switching the mode cancels the in-flight request and resets the rendered
  // state, then the auto-request effect (which depends on aiGrouping) re-runs.
  const resetStart = appSource.indexOf('/* Role and logic grouping produce different categories');
  assert.notEqual(resetStart, -1, 'the mode-switch reset effect is discoverable');
  const resetEnd = appSource.indexOf('}, [aiEnabled, aiGrouping, cancelAiRequest]);', resetStart);
  assert.ok(resetEnd > resetStart, 'the mode-switch reset effect ends where expected');
  const resetBlock = appSource.slice(resetStart, resetEnd);
  assert.match(resetBlock, /if \(previousGroupingRef\.current === aiGrouping\) return;/);
  assert.match(resetBlock, /cancelAiRequest\(\);/);
  assert.match(resetBlock, /setAiState\(\{ signature: null, result: null, pathGroups: null, loading: false, error: null, notice: null, model: null \}\);/);
  assert.match(appSource, /\}, \[aiEnabled, aiGrouping, open, repoRoot, entriesSignature, entries\.length, aiState\.signature, aiState\.result\]\);/,
    'the auto-request effect re-runs when the grouping mode changes');
});

test('grouping selector and non-functional copy exist in both dictionaries', () => {
  const runtime = createClientRuntime();
  const i18n = runtime.require('i18n');
  const zh = i18n.DICTIONARIES.zh;
  const en = i18n.DICTIONARIES.en;
  const keys = [
    'nav.grouping', 'nav.gitGroups', 'nav.gitGroupsHint',
    'nav.aiGroupsRole', 'nav.aiGroupsRoleHint',
    'nav.aiGroupsLogic', 'nav.aiGroupsLogicHint', 'nav.reclassify',
    'nav.nonFunctional', 'nav.nonFunctionalHint',
    'ai.settingsSwitchHint', 'ai.settingsDescription', 'ai.settingsDataNotice',
  ];
  for (const key of keys) {
    for (const [locale, dict] of [['zh', zh], ['en', en]]) {
      assert.equal(typeof dict[key], 'string', `${locale}: missing ${key}`);
      assert.ok(dict[key].trim().length > 0, `${locale}: empty ${key}`);
    }
  }
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'dictionaries stay in lockstep');
  assert.equal(Object.prototype.hasOwnProperty.call(zh, 'nav.aiGroups'), false,
    'the obsolete two-state AI label was removed');
  assert.equal(Object.prototype.hasOwnProperty.call(en, 'nav.aiGroups'), false);
  // The logic mode reads as functional logic in both languages; the
  // non-functional bucket has its own localized user-facing copy.
  assert.match(zh['nav.aiGroupsLogic'], /功能逻辑/);
  assert.match(en['nav.aiGroupsLogic'], /feature logic/i);
  assert.match(zh['nav.nonFunctional'], /非功能/);
  assert.match(en['nav.nonFunctional'], /Non-functional/i);
  assert.notEqual(zh['nav.nonFunctional'], en['nav.nonFunctional']);
  assert.notEqual(zh['nav.aiGroupsRole'], zh['nav.aiGroupsLogic']);
  assert.notEqual(en['nav.aiGroupsRole'], en['nav.aiGroupsLogic']);
  // The settings copy describes the selector, not the removed Git/AI toggle,
  // and the data notice covers both AI modes.
  assert.doesNotMatch(zh['ai.settingsSwitchHint'], /开启后显示「Git 状态」/);
  assert.match(zh['ai.settingsSwitchHint'], /按功能逻辑/);
  assert.match(en['ai.settingsSwitchHint'], /feature logic/i);
  assert.match(zh['ai.settingsDataNotice'], /按职能还是按功能逻辑/);
  assert.match(en['ai.settingsDataNotice'], /either by role or by feature logic/);
});

test('app keeps AI state path-based and preserves the grouping while a request loads', () => {
  // The grouping signature is the path-based helper, never key/status based.
  assert.match(appSource, /var entriesSignature = useMemo\(function \(\) \{\s*return aiEntriesSignature\(entries\);/);
  // requestAi snapshots the key→path table and converts the reply back to paths.
  assert.match(appSource, /var keyPaths = \{\};/);
  assert.match(appSource, /keyPaths\[list\[index\]\.key\] = String\(list\[index\]\.path\);/);
  assert.match(appSource, /pathGroups: aiPathGroups\(value, keyPaths\)/);
  // Loading keeps the previous grouping visible instead of collapsing to git groups.
  assert.match(appSource, /setAiState\(function \(currentState\) \{[\s\S]{0,300}?pathGroups: currentState\.pathGroups, loading: true/);
  // aiGroups maps categories onto entries by path (not by entry key), so a staged
  // entry whose key changed stays in its previous category.
  const aiGroupsStart = appSource.indexOf('var aiGroups = useMemo(');
  const aiGroupsEnd = appSource.indexOf('var groups = aiEnabled && aiGroups', aiGroupsStart);
  assert.ok(aiGroupsStart !== -1 && aiGroupsEnd > aiGroupsStart, 'the aiGroups memo is discoverable');
  const aiGroupsBlock = appSource.slice(aiGroupsStart, aiGroupsEnd);
  assert.match(aiGroupsBlock, /aiState\.pathGroups/);
  assert.match(aiGroupsBlock, /var byPath = new Map\(\);/);
  assert.match(aiGroupsBlock, /String\(entries\[index\]\.path \|\| ''\)/);
  assert.match(aiGroupsBlock, /byPath\.get\(categoryPath\)/);
  assert.equal(aiGroupsBlock.includes('.key'), false, 'AI grouping must not match on entry keys');
  assert.match(appSource, /\}, \[aiState\.pathGroups, entries, t\]\);/);
  // The initial state and failure/switch-repo paths clear the mapped result.
  assert.match(appSource, /useState\(\{ signature: null, result: null, pathGroups: null, loading: false, error: null, notice: null, model: null \}\)/);
  assert.match(appSource, /pathGroups: null,[\s\S]{0,200}?notice: 'fallback'/);
  assert.match(appSource, /aiState\.result\.repo\.root !== repoRoot[\s\S]{0,400}?pathGroups: null/);
});

test('an empty change set clears the stale AI grouping state and notice', () => {
  // User report: after committing everything with AI grouping on, the toolbar
  // kept showing "changes updated, AI grouping is refreshing…" forever. The old
  // classification signature can never match an empty change set, so the sync
  // effect must cancel the request and drop the previous result instead of
  // returning early (the notice was then computed from that stale result).
  assert.equal(appSource.includes('if (entries.length === 0) return;'), false,
    'the bare early return that pinned the stale notice must be gone');

  const effectStart = appSource.indexOf('// Turning AI grouping off, or switching repository, drops any pending result.');
  const effectEnd = appSource.indexOf(
    '}, [aiEnabled, aiGrouping, open, repoRoot, entriesSignature, entries.length, aiState.signature, aiState.result]);',
    effectStart,
  );
  assert.ok(effectStart !== -1 && effectEnd > effectStart, 'the AI sync effect source is discoverable');
  const effectBlock = appSource.slice(effectStart, effectEnd);

  // The empty branch settles an already-settled state and otherwise clears
  // every field of the classification state (result, signature, notice, busy).
  const emptyStart = effectBlock.indexOf('if (entries.length === 0) {');
  const emptyEnd = effectBlock.indexOf('if (aiState.loading &&', emptyStart);
  assert.ok(emptyStart !== -1 && emptyEnd > emptyStart, 'the empty change-set branch is discoverable');
  const emptyBranch = effectBlock.slice(emptyStart, emptyEnd);
  assert.match(emptyBranch, /var aiSettled = !aiState\.result && !aiState\.loading && !aiState\.signature && !aiState\.error && !aiState\.notice;/);
  assert.match(emptyBranch, /if \(aiSettled\) return;/);
  assert.match(emptyBranch, /cancelAiRequest\(\);/);
  assert.match(emptyBranch, /setAiState\(\{ signature: null, result: null, pathGroups: null, loading: false, error: null, notice: null, model: null \}\);/);
  assert.equal(emptyBranch.includes('entries.length === 0) return;'), false);

  // aiNotice only computes while entries exist: an empty repository can never
  // render nav.aiLoading / nav.aiStale (or any other AI notice) again.
  const noticeStart = appSource.indexOf('var aiNotice = null;');
  const noticeEnd = appSource.indexOf('var topBar = h(components.TopBar, {', noticeStart);
  assert.ok(noticeStart !== -1 && noticeEnd > noticeStart, 'the aiNotice computation is discoverable');
  const noticeBlock = appSource.slice(noticeStart, noticeEnd);
  const guardStart = noticeBlock.indexOf('if (aiEnabled && entries.length > 0) {');
  assert.notEqual(guardStart, -1, 'aiNotice requires a non-empty change set');
  assert.equal(noticeBlock.slice(0, guardStart).trim(), 'var aiNotice = null;',
    'every AI notice source lives inside the entries.length > 0 guard');
  const guardedNotices = noticeBlock.slice(guardStart);
  for (const token of ["t('nav.aiLoading')", "t('ai.usedCache')", "t('nav.aiStale')", "t('nav.aiFailed')"]) {
    assert.ok(guardedNotices.includes(token), `missing ${token} inside the guarded AI notice block`);
  }
  assert.match(appSource, /aiNotice: aiNotice,/);
});

/* ------------------------------------------------------------------------- */
/* Diff refresh — a write keeps the previous content on screen (user report) */
/* ------------------------------------------------------------------------- */

test('a same-file diff refresh keeps the previous content and shows the header spinner', () => {
  const runtime = createClientRuntime();
  const t = runtime.require('i18n').createI18n('zh').t;
  const diffView = runtime.require('diff-view');

  // Source contract: the effect updates from the previous state and preserves
  // the value only while the selected path is unchanged.
  assert.match(appSource, /setDiffState\(function \(previous\) \{/);
  assert.match(appSource, /var previousEntry = previousValue && previousValue\.entry \? previousValue\.entry : null;/);
  assert.match(appSource, /var sameFile = !!previousEntry && !!selectedPath && String\(previousEntry\.path \|\| ''\) === selectedPath;/);
  assert.match(appSource, /if \(sameFile\) \{\s*return \{ key: key, loading: true, error: null, value: previousValue \};\s*\}\s*return \{ key: key, loading: true, error: null, value: null \};/);
  // Only a pane without previous content skeletons; busy/loading adds a spinner.
  assert.match(diffViewSource, /if \(loading && !entryDiff\) \{/);
  assert.match(diffViewSource, /busy \|\| loading\s*\? h\('span', \{[\s\S]{0,160}?renderSpinner\(11\)/);

  const entry = { key: 'unstaged:a', path: 'a.js', status: 'unstaged', change: 'modified' };
  const previousDiff = {
    entry,
    base: { label: 'Index', exists: true, text: 'a\nb\nc\n' },
    target: { label: 'Worktree', exists: true, text: 'a\nB\nc\n' },
    hunks: [{ header: '@@ -1,3 +1,3 @@', lines: [] }],
  };
  function renderPane(extra) {
    return diffView.DiffPane(Object.assign({ t, entry, entryDiff: null, loading: false }, extra));
  }

  // First load of a file: no content yet -> full skeleton.
  assert.equal(elementsByClass(renderPane({ loading: true }), 'gr-diff-skeleton').length, 1,
    'a pane without previous content still shows the loading skeleton');

  // The same file refreshed after a write: previous rows stay, no skeleton.
  const refresh = renderPane({ loading: true, entryDiff: previousDiff });
  assert.equal(elementsByClass(refresh, 'gr-diff-skeleton').length, 0,
    'a same-file refresh must not blank the pane');
  assert.ok(elementsByClass(refresh, 'gr-diff-row').length > 0, 'the previous diff rows stay rendered');
  const loadingMeta = elementsByClass(refresh, 'gr-diff-meta');
  assert.equal(loadingMeta.length, 1);
  assert.ok(collectElements(loadingMeta[0]).some((element) => typeof element.type === 'function'
    && element.type.name === 'Spinner'), 'the header shows a small spinner while refreshing');

  // A busy write keeps the header spinner too, without any loading skeleton.
  const busyOnly = renderPane({ entryDiff: previousDiff, busy: true });
  assert.equal(elementsByClass(busyOnly, 'gr-diff-skeleton').length, 0);
  const busyMeta = elementsByClass(busyOnly, 'gr-diff-meta');
  assert.equal(busyMeta.length, 1);
  assert.ok(collectElements(busyMeta[0]).some((element) => typeof element.type === 'function'
    && element.type.name === 'Spinner'), 'busy writes show the header spinner');
});

/* ------------------------------------------------------------------------- */
/* Selection — a stage/unstage refresh follows the path, not the row index   */
/* ------------------------------------------------------------------------- */

test('a stage/unstage refresh keeps the selection on the same path', () => {
  assert.match(appSource, /previousEntriesRef\.current = entries;/);
  assert.match(appSource, /var previousPath = previousEntries\[previousIndex\]\.path;/);
  assert.match(appSource, /if \(entries\[matchAt\]\.path === previousPath\) return entries\[matchAt\]\.key;/);
  // Path matching runs before the old-index fallback, so a changed key never
  // makes the selection jump to whatever row now sits at the old index.
  const pathMatch = appSource.indexOf('if (entries[matchAt].path === previousPath) return entries[matchAt].key;');
  const indexFallback = appSource.indexOf('return entries[Math.min(previousIndex, entries.length - 1)].key;');
  assert.ok(pathMatch !== -1 && indexFallback > pathMatch, 'path match must precede the index fallback');
});

/* ------------------------------------------------------------------------- */
/* File navigation title row — bulk controls cluster on the right            */
/* ------------------------------------------------------------------------- */

test('the file title row clusters locate/bulk controls on the right', () => {
  const runtime = createClientRuntime();
  const nav = renderFileNav(runtime, {
    groups: [{
      id: 'g',
      label: '变更',
      entries: [
        { key: 'unstaged:a', status: 'unstaged', path: 'a.js' },
        { key: 'staged:b', status: 'staged', path: 'b.js' },
      ],
    }],
    selectedKey: 'unstaged:a',
    onLocate: () => {},
    onExpandAll: () => {},
    onCollapseAll: () => {},
  });
  const headRight = elementsByClass(nav.tree, 'gr-files-head-right');
  assert.equal(headRight.length, 1, 'the title row has one right-hand cluster');
  const rightChildren = [].concat(headRight[0].props.children || []).flat(3).filter(Boolean);
  assert.deepEqual(rightChildren.map((element) => elementClasses(element)[0]), ['gr-files-bulk'],
    'the right cluster holds only the bulk controls since review marks were removed');
  // The cluster holds exactly the three navigation buttons.
  assert.equal(elementsByClass(headRight[0], 'gr-files-bulk-btn').length, 3);
  assert.equal(elementsByClass(nav.tree, 'gr-files-progress').length, 0,
    'the reviewed-progress group is gone from the file navigation');

  // Title and count stay on the leading edge: the cluster is the last child.
  const headRow = elementsByClass(nav.tree, 'gr-files-head-row');
  assert.equal(headRow.length, 1);
  const rowChildren = (headRow[0].props.children || []).flat(3).filter(Boolean);
  const headRightIndex = rowChildren.indexOf(headRight[0]);
  assert.equal(headRightIndex, rowChildren.length - 1, 'the cluster is the last element of the title row');
  const titleIndex = rowChildren.findIndex((element) => elementClasses(element).includes('gr-files-title'));
  const countIndex = rowChildren.findIndex((element) => elementClasses(element).includes('gr-files-count'));
  assert.ok(titleIndex !== -1 && countIndex !== -1 && titleIndex < headRightIndex && countIndex < headRightIndex);

  // Right alignment lives on the cluster wrapper (the gutter compensation is
  // covered by the header/scrollbar test below).
  assert.match(stylesSource, /\.gr-files-head-right \{[^}]*margin-left: auto/);
});

/* ------------------------------------------------------------------------- */
/* Commit split action in the drawer — remembered mode drives every action    */
/* ------------------------------------------------------------------------- */

test('the commit split action lives in the drawer and runs the remembered mode', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const ui = runtime.require('ui');
  const i18n = runtime.require('i18n');
  const app = runtime.require('app');
  const t = i18n.createI18n('zh').t;
  const base = {
    t,
    mode: 'commit',
    busy: false,
    generating: false,
    canRun: true,
    reasons: [],
    onCommit: function () {},
    onChangeMode: function () {},
  };
  const render = (extra) => collectElements(components.CommitAction(Object.assign({}, base, extra)));

  // The split control is rendered by CommitAction: a primary half naming the
  // persisted mode plus a chevron that opens the mode menu.
  const initial = render({});
  const target = initial.find((element) => elementClasses(element).includes('gr-commit-target'));
  assert.ok(target, 'the drawer action renders the commit split control');
  const main = initial.find((element) => elementClasses(element).includes('gr-commit-main'));
  const chevron = initial.find((element) => elementClasses(element).includes('gr-commit-mode-chevron'));
  assert.ok(main && chevron, 'the control has a primary half and a mode-menu half');
  assert.equal(chevron.props['aria-haspopup'], 'menu');
  assert.equal(chevron.props['aria-expanded'], 'false');
  assert.equal(chevron.props['aria-label'], t('commit.mode'));
  assert.equal(chevron.props.title, t('commit.mode'));

  // Placement regression: the commit split control lives in the drawer; the
  // top toolbar keeps its old action set (branch / grouping / reclassify /
  // refresh / push / settings / help).
  const toolbarElements = collectElements(components.TopBar({
    t,
    status: { repo: null, summary: null },
    repo: null,
  }));
  assert.equal(toolbarElements.some((element) => elementClasses(element).includes('gr-commit-target')), false,
    'the toolbar must not render the commit split control');
  assert.ok(toolbarElements.some((element) => elementClasses(element).includes('gr-topbar-push')),
    'the ordinary push dialog action stays in the toolbar');

  // Every drawer mode names itself on the primary half and uses its own glyph.
  // The one-click AI·commit+push is a separate toolbar button, not a drawer mode.
  for (const [mode, labelKey, iconName] of [
    ['commit', 'commit.modeCommit', 'IconCommit'],
    ['commitPush', 'commit.modeCommitPush', 'IconPush'],
  ]) {
    const elements = render({ mode: mode });
    const action = elements.find((element) => elementClasses(element).includes('gr-commit-main'));
    assert.ok(collectText(action).includes(t(labelKey)), `${mode}: the active mode is named on the button`);
    assert.equal(action.props['aria-label'], t(labelKey));
    assert.equal(action.props.children[0].type.name, iconName, `${mode}: the mode owns its glyph`);
    assert.equal(action.props.disabled, undefined, `${mode}: a runnable mode is enabled`);
  }
  // Retired / unknown persisted values fall back to the plain commit mode.
  for (const retired of ['aiCommitPush', 'future-mode']) {
    const fallback = render({ mode: retired }).find((element) => elementClasses(element).includes('gr-commit-main'));
    assert.ok(collectText(fallback).includes(t('commit.modeCommit')), `${retired}: degrades to commit`);
    assert.equal(fallback.props['aria-label'], t('commit.modeCommit'));
  }

  // ---- toolbar one-click AI·commit+push ----------------------------------
  const toolbarBase = {
    t,
    status: { repo: null, summary: null },
    repo: null,
    onRefresh: function () {},
    onOpenPush: function () {},
    pushDisabledReason: '',
    aiCommitBusy: false,
    aiCommitCanRun: true,
    aiCommitDisabledReason: null,
    onAiCommitPush: function () {},
    onChangeGrouping: function () {},
  };
  const renderToolbar = (extra) => collectElements(components.TopBar(Object.assign({}, toolbarBase, extra)));
  const aiInitial = renderToolbar({});
  const aiButtonEl = aiInitial.find((element) => elementClasses(element).includes('gr-topbar-ai-commit'));
  assert.ok(aiButtonEl, 'the toolbar offers the one-click AI·commit+push action');
  assert.ok(collectText(aiButtonEl).includes(t('commit.modeAiCommitPush')), 'the AI button is labelled');
  assert.equal(aiButtonEl.props.ariaLabel, t('commit.modeAiCommitPush'));
  assert.equal(aiButtonEl.props.title, t('commit.modeAiPushHint'));
  assert.equal(aiButtonEl.props.disabled, false, 'a runnable AI action is enabled');
  // It sits next to (but is separate from) the push-dialog button: no split
  // control, no mode menu, and the push button keeps its own action.
  assert.ok(aiInitial.some((element) => elementClasses(element).includes('gr-topbar-push')),
    'the push-dialog button stays in the toolbar');
  assert.equal(aiInitial.filter((element) => elementClasses(element).includes('gr-topbar-ai-commit')).length, 1);
  assert.equal(aiInitial.some((element) => elementClasses(element).includes('gr-commit-target')),
    false, 'the toolbar AI action is not the drawer split control');
  let aiRuns = 0;
  renderToolbar({ onAiCommitPush: function () { aiRuns += 1; } })
    .find((element) => elementClasses(element).includes('gr-topbar-ai-commit')).props.onClick();
  assert.equal(aiRuns, 1, 'one click dispatches the AI action without opening the drawer');
  const aiBlocked = renderToolbar({ aiCommitCanRun: false, aiCommitDisabledReason: t('commit.nothingChecked') })
    .find((element) => elementClasses(element).includes('gr-topbar-ai-commit'));
  assert.equal(aiBlocked.props.disabled, true, 'missing guards disable the AI action');
  assert.equal(ui.Button(aiBlocked.props).props.disabled, true);
  assert.equal(aiBlocked.props.title, t('actions.disabledReason', { reason: t('commit.nothingChecked') }));
  const aiBusyEl = renderToolbar({ aiCommitBusy: true, aiCommitDisabledReason: t('commit.generating') })
    .find((element) => elementClasses(element).includes('gr-topbar-ai-commit'));
  assert.equal(aiBusyEl.props.busy, true, 'in-flight AI action shows the shared spinner');
  assert.equal(aiBusyEl.props.disabled, true);
  assert.match(stylesSource, /\.gr-topbar-ai-commit/);
  assert.match(stylesSource, /\.gr-topbar-ai-commit \.gr-ai-commit-label \{ display: none; \}/,
    'narrow toolbars collapse the AI action to its icon + accessible label');
  assert.match(appSource, /onAiCommitPush: function \(\) \{ runCommit\('aiCommitPush'\); \}/,
    'the toolbar button runs the AI mode without changing the persisted drawer mode');
  assert.match(appSource, /var canAiCommitPush = aiCommitReasons\.length === 0;/);
  assert.match(appSource, /var runCommit = useCallback\(function \(modeOverride\) \{/);
  assert.match(appSource, /var mode = modeOverride === 'aiCommitPush' \? 'aiCommitPush' : commitMode;/,
    'the drawer split always runs the remembered mode');
  // The toolbar contract exposes only the AI action, never the remembered mode.
  const topBarStart = componentsSource.indexOf('function TopBar(');
  const topBarEnd = componentsSource.indexOf('function ReviewTitle(', topBarStart);
  const topBarSource = componentsSource.slice(topBarStart, topBarEnd);
  for (const token of ['aiCommitButton', 'onAiCommitPush', 'gr-topbar-ai-commit']) {
    assert.ok(topBarSource.includes(token), `TopBar must wire ${token}`);
  }
  for (const token of ['commitMode', 'onChangeCommitMode', 'gr-commit-target', 'CommitAction']) {
    assert.equal(topBarSource.includes(token), false, `TopBar must not reference ${token}`);
  }

  // Clicking the primary half runs exactly the current action.
  let runs = 0;
  const clicked = render({ onCommit: function () { runs += 1; } });
  clicked.find((element) => elementClasses(element).includes('gr-commit-main')).props.onClick();
  assert.equal(runs, 1, 'the primary half runs the commit action');

  // Blocking reasons keep the action disabled and are exposed through the
  // tooltip (the reason lives in app.js because the state is cross-feature).
  const blocked = render({ canRun: false, reasons: [t('commit.messageRequired')] });
  const blockedMain = blocked.find((element) => elementClasses(element).includes('gr-commit-main'));
  assert.equal(blockedMain.props.disabled, true);
  assert.equal(blockedMain.props.title, t('actions.disabledReason', { reason: t('commit.messageRequired') }));
  blockedMain.props.onClick();
  assert.equal(runs, 1, 'a disabled primary half never dispatches');

  // In-flight commit / AI drafting shows a spinner and disables both halves.
  const busyElements = render({ busy: true });
  const busyMain = busyElements.find((element) => elementClasses(element).includes('gr-commit-main'));
  assert.equal(busyMain.props.disabled, true);
  assert.equal(busyMain.props['aria-busy'], 'true');
  assert.equal(typeof busyMain.props.children[0].type, 'function');
  assert.equal(busyMain.props.children[0].type.name, 'Spinner');
  assert.equal(busyElements.find((element) => elementClasses(element).includes('gr-commit-mode-chevron')).props.disabled, true);
  // A drawer AI draft in flight is not a commit: the tooltip says so.
  const generatingMain = render({ generating: true })
    .find((element) => elementClasses(element).includes('gr-commit-main'));
  assert.equal(generatingMain.props.disabled, true);
  assert.equal(generatingMain.props.title, t('actions.disabledReason', { reason: t('commit.generating') }));

  // The mode menu is rendered by the split action itself and anchored flush above
  // the split control (open upward: the drawer sits at the window bottom), with
  // the remembered mode checked.
  const actionStart = componentsSource.indexOf('function CommitAction(');
  const actionEnd = componentsSource.indexOf('function CommitPanel(', actionStart);
  assert.ok(actionStart !== -1 && actionEnd > actionStart, 'CommitAction source region is discoverable');
  const actionSource = componentsSource.slice(actionStart, actionEnd);
  for (const token of ['checked: item.id === mode', 'ignoreRef: triggerRef',
    "header: t('commit.modeHeader')", 'anchorRef: triggerRef',
    "placement: 'above'", "align: 'end'"]) {
    assert.ok(actionSource.includes(token), `CommitAction must wire ${token}`);
  }
  assert.match(actionSource, /setMenuOpen\(function \(value\) \{ return !value; \}\)/);
  // Anchoring is computed from the measured trigger + menu, not an estimated
  // height, so the menu stays 4px from the button like DSH's own menu buttons.
  const anchored = components.anchorMenuPosition(
    { left: 1200, right: 1300, top: 800, bottom: 828, width: 100, height: 28 },
    { width: 220, height: 140 },
    { placement: 'above', align: 'end', viewport: { width: 1600, height: 1026 } },
  );
  assert.deepEqual(anchored, { x: 1080, y: 656 });
  assert.equal(800 - (anchored.y + 140), 4, 'the menu bottom stays 4px above the trigger');
  assert.equal(anchored.x + 220, 1300, 'the menu right edge aligns with the trigger');
  // Viewport edges: flip to the other side, then clamp inside the viewport.
  const flipped = components.anchorMenuPosition(
    { left: 0, right: 100, top: 100, bottom: 128, width: 100, height: 28 },
    { width: 220, height: 140 },
    { placement: 'above', align: 'end', viewport: { width: 1600, height: 1026 } },
  );
  assert.equal(flipped.x, 4, 'the menu left edge clamps inside the viewport');
  assert.equal(flipped.y, 132, 'upward placement flips below when it does not fit');
  const flippedUp = components.anchorMenuPosition(
    { left: 1200, right: 1300, top: 900, bottom: 928, width: 100, height: 28 },
    { width: 220, height: 140 },
    { placement: 'below', align: 'end', viewport: { width: 1600, height: 1026 } },
  );
  assert.equal(flippedUp.y, 756, 'downward placement flips above when it does not fit');
  assert.match(componentsSource, /anchorMenuPosition\(anchorNode\.getBoundingClientRect\(\), rect/,
    'ContextMenu uses the anchored helper when a trigger ref is provided');
  // The drawer menu holds only the two commit modes; the AI action is a toolbar
  // button and must not creep back in as a hidden third drawer mode.
  assert.equal(actionSource.includes("id: 'aiCommitPush'"), false,
    'CommitAction must not expose the toolbar-only AI action as a drawer mode');

  const menu = components.ContextMenu({
    t,
    open: true,
    x: 10,
    y: 10,
    items: [
      { id: 'commit', label: 'A', checked: true },
      { id: 'commitPush', label: 'B', checked: false },
    ],
    onSelect: function () {},
    onClose: function () {},
  });
  const radios = collectElements(menu).filter((element) => element.type === 'button' && element.props.role === 'menuitemradio');
  assert.equal(radios.length, 2, 'the mode menu rows are radio menu items');
  assert.equal(radios[0].props['aria-checked'], 'true');
  assert.equal(radios[1].props['aria-checked'], 'false');
  assert.equal(elementsByClass(menu, 'gr-menu-check').length, 1, 'only the active mode carries the check mark');
  assert.match(componentsSource, /\[role\^="menuitem"\]/, 'keyboard traversal also covers menu radio items');

  // Styling keeps the split-control and check-mark tiers in the theme sheet.
  assert.match(stylesSource, /\.gr-commit-target \{[^}]*display: inline-flex/);
  assert.match(stylesSource, /\.gr-commit-main \{/);
  assert.match(stylesSource, /\.gr-commit-mode-chevron \{/);
  // The split-control class names must not collide with the commit drawer's
  // header chevron / message label (those are `.gr-commit-chevron` /
  // `.gr-commit-label`); separate names keep both rule sets independent.
  assert.match(stylesSource, /\.gr-commit-mode-label \{/);
  assert.equal(/\.gr-commit-target[^{}]*\.gr-commit-label/.test(stylesSource), false);
  // The split control clips children to its radius, so the focus ring must be
  // painted inside the button box or keyboard focus would be invisible.
  assert.match(stylesSource, /\.gr-commit-main:focus-visible, \.gr-commit-mode-chevron:focus-visible \{[^}]*outline-offset: -2px/);
  assert.match(stylesSource, /\.gr-menu-check \{/);

  // ---- persistence -------------------------------------------------------
  assert.equal(typeof app.commitModeOf, 'function');
  for (const [value, expected] of [['commit', 'commit'], ['commitPush', 'commitPush'],
    ['aiCommitPush', 'commit'], ['push', 'commit'], [null, 'commit'], [undefined, 'commit']]) {
    assert.equal(app.commitModeOf(value), expected, `commitModeOf(${String(value)})`);
  }
  assert.match(appSource, /commitMode: commitModeOf\(value && value\.commitMode\)/,
    'settings bootstrap normalizes the new field');
  assert.match(appSource, /if \('commitMode' in patch\) nextValue\.commitMode = commitModeOf\(patch\.commitMode\);/,
    'the optimistic settings mirror applies the new field');
  assert.match(appSource, /saveSettings\(\{ commitMode: value \}\)\.catch/,
    'picking a mode persists it like the grouping choice');
  assert.equal(componentsSource.includes('exports.CommitAction = CommitAction;'), true,
    'CommitAction is exported for the drawer and for tests');

  // ---- placement + wiring ------------------------------------------------
  const appTopBarStart = appSource.indexOf('h(components.TopBar, {');
  const appTopBarSource = appSource.slice(appTopBarStart, appSource.indexOf('var fileNav', appTopBarStart));
  for (const token of ['commitMode', 'commitBusy', 'commitGenerating', 'commitCanRun',
    'commitReasons', 'onCommit', 'onChangeCommitMode']) {
    assert.equal(appTopBarSource.includes(token), false, `app.js must not pass ${token} to TopBar`);
  }
  for (const token of ['aiCommitBusy: aiCommitBusy,', 'aiCommitCanRun: canAiCommitPush,',
    'aiCommitDisabledReason: aiCommitDisabledReason,', 'onAiCommitPush:']) {
    assert.ok(appTopBarSource.includes(token), `app.js must pass ${token} to TopBar`);
  }
  const appDrawerStart = appSource.indexOf('h(components.CommitPanel, {');
  const appDrawerSource = appSource.slice(appDrawerStart, appSource.indexOf('h(components.StatusBar, {', appDrawerStart));
  for (const token of ['commitMode: commitMode,', 'commitBusy: commitBusy,',
    'commitGenerating: commitGenerating,', 'commitCanRun: canCommit,',
    'commitReasons: commitReasons,', 'onCommit: runCommit,', 'onChangeCommitMode:']) {
    assert.ok(appDrawerSource.includes(token), `app.js must pass ${token} to CommitPanel`);
  }
  // The drawer wires the split action; the plain commit button stays gone.
  const panelStart = componentsSource.indexOf('function CommitPanel(');
  const panelEnd = componentsSource.indexOf('function PushDialog(', panelStart);
  const panelSource = componentsSource.slice(panelStart, panelEnd);
  for (const token of ['h(CommitAction, {', 'mode: props.commitMode',
    'busy: !!props.commitBusy', 'onCommit: props.onCommit',
    'onChangeMode: props.onChangeCommitMode']) {
    assert.ok(panelSource.includes(token), `CommitPanel must wire ${token}`);
  }
  assert.match(stateSource, /commitMode: 'commit'/,
    'the client settings mirror documents the documented default');
  // Both mode labels are localized and differ between zh and en.
  for (const locale of ['zh', 'en']) {
    for (const key of ['commit.mode', 'commit.modeHeader', 'commit.modeCommit', 'commit.modeCommitPush',
      'commit.modeAiCommitPush', 'commit.modePushHint', 'commit.modeAiPushHint',
      'commit.pushSuccess', 'commit.pushAfterCommitFailed']) {
      assert.equal(typeof i18n.DICTIONARIES[locale][key], 'string', `${locale}: missing ${key}`);
      assert.ok(i18n.DICTIONARIES[locale][key].length > 0, `${locale}: empty ${key}`);
    }
  }
  assert.equal(i18n.DICTIONARIES.zh['commit.modeCommit'], '提交');
  assert.equal(i18n.DICTIONARIES.en['commit.modeCommit'], 'Commit');
  assert.notEqual(i18n.DICTIONARIES.zh['commit.modeAiCommitPush'], i18n.DICTIONARIES.en['commit.modeAiCommitPush']);
  assert.ok(i18n.DICTIONARIES.zh['commit.modeAiCommitPush'].includes('AI'));
  for (const key of ['commit.pushSuccess', 'commit.pushAfterCommitFailed']) {
    assert.ok(i18n.DICTIONARIES.zh[key].includes('{'), `${key} interpolates its result`);
    assert.ok(i18n.DICTIONARIES.en[key].includes('{'), `${key} interpolates its result`);
  }

  // ---- one-click commit+push chain (no push dialog) ----------------------
  const runStart = appSource.indexOf('var runCommit = useCallback(');
  const runEnd = appSource.indexOf('/* Push preview:', runStart);
  assert.ok(runStart !== -1 && runEnd > runStart, 'runCommit source region is discoverable');
  const runSource = appSource.slice(runStart, runEnd);
  assert.match(runSource, /var messagePromise = mode === 'aiCommitPush' \? requestCommitMessage\(\) : Promise\.resolve\(commitMessage\);/,
    'the AI mode drafts the message inside the same action');
  assert.match(runSource, /rpc\.call\('commit', params\)\.then/);
  assert.ok(runSource.indexOf("rpc.call('commit', params)") < runSource.indexOf("rpc.call('push', pushParams)"),
    'the push starts only after the commit resolved');
  assert.match(runSource, /var pushParams = \{ setUpstream: true \};/,
    'the one-click push targets the current branch and its remote branch');
  assert.match(runSource, /rpc\.call\('push', pushParams\)\.then/);
  assert.equal(runSource.includes('pushPreview'), false, 'the one-click push must not open the push preview dialog');
  assert.equal(runSource.includes('openPush'), false, 'the one-click push must not open the dialog state');
  assert.match(appSource, /tRef\.current\('commit\.pushSuccess'/);
  assert.match(appSource, /tRef\.current\('commit\.pushAfterCommitFailed'/);
  // A failed commit still surfaces through the drawer's own error slot.
  assert.match(appSource, /var showCommitFailure = useCallback\(function \(error\)/);
  assert.match(appSource, /setCommitOpen\(true\);/);
  // The AI draft request is shared by the drawer button and the combined mode.
  assert.match(appSource, /var requestCommitMessage = useCallback\(/);
  assert.match(appSource, /var messagePromise = mode === 'aiCommitPush' \? requestCommitMessage\(\)/);
});

test('AI commit message drafting is an explicit, cancellable read-only request', () => {
  const runtime = createClientRuntime();
  const i18n = runtime.require('i18n');

  // One read-only protocol call; the Host re-reads the staged set itself, so the
  // client never uploads its snapshot as the model input.
  assert.match(appSource, /rpc\.call\('commitMessage', params, \{ signal: controller\.signal \}\)/);
  assert.match(appSource, /var params = \{ requestId: requestId \};/);
  assert.equal(appSource.includes('params.entries'), false, 'the draft request must not carry entry metadata');
  // Cancelling the browser fetch alone would leave the Host streaming, so the
  // request id is cancelled explicitly on replace / collapse / unmount.
  assert.match(appSource, /rpc\.call\('commitMessageCancel', \{ requestId: requestId \}\)/);
  assert.match(appSource, /cancelCommitGeneration\(\);/);
  // A successful draft lands in the editable message field; it never commits.
  assert.match(appSource, /setCommitMessage\(message\);/);

  // Every user-facing string exists in both dictionaries.
  for (const locale of ['zh', 'en']) {
    const t = i18n.createI18n(locale).t;
    for (const key of ['commit.generate', 'commit.generating',
      'error.messageNoStaged', 'error.messageUnavailable', 'error.messageInvalid', 'error.messageAborted']) {
      assert.notEqual(t(key), key, `${locale}: missing ${key}`);
    }
  }
  const zh = i18n.createI18n('zh').t;
  const en = i18n.createI18n('en').t;
  for (const key of ['commit.generate', 'error.messageUnavailable', 'error.messageInvalid']) {
    assert.notEqual(zh(key), en(key), `${key} must be localized, not shared verbatim`);
  }
});

/* ------------------------------------------------------------------------- */
/* File navigation header — aligned with the file rows (scrollbar gutter)    */
/* ------------------------------------------------------------------------- */

test('the file title row matches the file rows and compensates the scrollbar gutter', () => {
  const runtime = createClientRuntime();

  // The list reserves its scrollbar gutter, so rows never shift when it appears.
  assert.match(stylesSource, /\.gr-files-list \{[^}]*scrollbar-gutter: stable/);
  // The header pads its leading side like a row content box and its trailing
  // side by the measured gutter minus the bulk icon's internal inset (no
  // hardcoded scrollbar width), so the icon edge lands on the row's right edge.
  assert.match(stylesSource, /\.gr-files-head-row \{[^}]*padding: 0 max\(0px, calc\(var\(--gr-files-scrollbar, 0px\) - 2px\)\) 0 14px/);
  assert.match(stylesSource, /\.gr-files-head-right \{[^}]*margin-left: auto/);
  assert.match(componentsSource, /var gutter = Math\.max\(0, Math\.round\(list\.offsetWidth - list\.clientWidth\)\);/);
  assert.match(componentsSource, /root\.style\.setProperty\('--gr-files-scrollbar', gutter \+ 'px'\);/);

  // The measurement lives in FileNav: it reads the list's gutter and writes the
  // number onto the `.gr-files` root, which the header padding reads back.
  const fileNavStart = componentsSource.indexOf('function FileNav(');
  const fileNavEnd = componentsSource.indexOf('function ContextMenu(', fileNavStart);
  assert.ok(fileNavStart !== -1 && fileNavEnd > fileNavStart, 'the FileNav source region is discoverable');
  const fileNavSource = componentsSource.slice(fileNavStart, fileNavEnd);
  assert.match(fileNavSource, /useLayoutEffect\(function \(\) \{[\s\S]{0,300}?var list = innerRef\.current;[\s\S]{0,100}?var root = rootRef\.current;/);
  assert.match(fileNavSource, /\}, \[groups\.length, props\.search\]\);/);
  assert.match(fileNavSource, /return h\('div', \{ className: 'gr-files', ref: rootRef \},/);

  // The rendered root carries the ref the layout effect writes through.
  const nav = renderFileNav(runtime, {
    groups: [{ id: 'g', label: '变更', entries: [
      { key: 'unstaged:a', status: 'unstaged', path: 'a.js' },
      { key: 'staged:b', status: 'staged', path: 'b.js' },
    ] }],
    onLocate: () => {},
    onExpandAll: () => {},
    onCollapseAll: () => {},
  });
  const roots = elementsByClass(nav.tree, 'gr-files');
  assert.equal(roots.length, 1, 'the file navigation root is rendered');
  assert.ok(roots[0].props.ref && typeof roots[0].props.ref === 'object'
    && Object.prototype.hasOwnProperty.call(roots[0].props.ref, 'current'),
  'the root carries the gutter-measuring ref');
  // The right cluster still holds the bulk controls; the reviewed progress that
  // used to share it was removed with the review-mark feature.
  const headRight = elementsByClass(nav.tree, 'gr-files-head-right');
  assert.equal(headRight.length, 1);
  assert.equal(elementsByClass(headRight[0], 'gr-files-bulk').length, 1);
  assert.equal(elementsByClass(nav.tree, 'gr-files-progress').length, 0);
});

/* ------------------------------------------------------------------------- */
/* Review-mark removal — the feature is gone, not just hidden (user report)  */
/* ------------------------------------------------------------------------- */

test('the review-mark feature is fully removed from the client', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const i18n = runtime.require('i18n');
  const t = i18n.createI18n('zh').t;

  // 1) No review-mark copy in either dictionary; the whole `review.*` namespace
  // and the mark-related keys are gone.
  const removedKeys = [
    'nav.markReviewed', 'nav.unmarkReviewed', 'nav.reviewedProgress', 'nav.resetReviewed',
    'actions.markReviewed', 'actions.unmarkReviewed',
    'menu.markReviewed', 'menu.unmarkReviewed', 'a11y.mark',
  ];
  for (const locale of ['zh', 'en']) {
    const dict = i18n.DICTIONARIES[locale];
    for (const key of removedKeys) {
      assert.equal(Object.prototype.hasOwnProperty.call(dict, key), false,
        `${locale}: removed key ${key} is still translated`);
    }
    assert.deepEqual(Object.keys(dict).filter((key) => /^review\./.test(key)), [],
      `${locale}: the whole review.* namespace was removed`);
  }

  // 2) No removed identifiers or class names survive in the client sources.
  const removedTokens = [
    'reviewedKeys', 'reviewedProgress', 'onResetReviewed', 'toggleReviewed',
    'reviewedMap', 'isReviewed', 'reviewVersion',
    'markReviewed', 'unmarkReviewed', 'resetReviewed',
    'gr-review-mark', 'gr-review-track', 'gr-review-fill', 'gr-files-progress', 'gr-files-reset',
    'a11y.mark',
  ];
  for (const [name, source] of [
    ['components.js', componentsSource],
    ['app.js', appSource],
    ['styles.js', stylesSource],
    ['i18n.js', readFileSync(new URL('../src/client/i18n.js', import.meta.url), 'utf8')],
  ]) {
    for (const token of removedTokens) {
      assert.equal(source.includes(token), false, `${name} still references removed ${token}`);
    }
  }
  // The plugin entry button and the window title keep their legitimate
  // `gr-review-*` names; only the review-mark classes were removed.
  assert.match(componentsSource, /className: 'gr-review-button'/);
  assert.match(componentsSource, /className: 'gr-review-title'/);
  assert.match(stylesSource, /\.gr-review-button:/);
  assert.match(stylesSource, /\.gr-review-title \{/);

  // 3) The file-row context menu no longer offers a review action.
  const menuStart = appSource.indexOf('var openEntryMenu = useCallback(');
  const menuEnd = appSource.indexOf('var onMenuSelect = useCallback(', menuStart);
  assert.ok(menuStart !== -1 && menuEnd > menuStart, 'the file context menu source is discoverable');
  const menuBlock = appSource.slice(menuStart, menuEnd);
  assert.equal(menuBlock.includes("'review'"), false, 'the context menu has no review item');
  assert.equal(menuBlock.includes('markReviewed'), false);
  assert.ok(menuBlock.includes("id: 'copy'"), 'the remaining file menu items are still wired');
  assert.equal(appSource.includes("id === 'review'"), false, 'the menu dispatcher has no review branch');

  // 4) The toolbar and file navigation render without review-mark props or UI,
  // and FileNav works with only its required props.
  const toolbar = components.TopBar({ t, status: { repo: null, summary: null }, repo: null });
  assert.equal(elementsByClass(toolbar, 'gr-review-mark').length, 0);
  const minimal = components.FileNav({
    t,
    groups: [{ id: 'g', label: '变更', entries: [
      { key: 'unstaged:a', status: 'unstaged', path: 'a.js' },
    ] }],
  });
  assert.equal(elementsByClass(minimal, 'gr-files').length, 1,
    'FileNav renders with only its required props');
  assert.ok(collectText(minimal).includes(t('nav.files')));
  assert.equal(elementsByClass(minimal, 'gr-files-progress').length, 0);
  assert.equal(elementsByClass(minimal, 'gr-review-mark').length, 0);
  assert.equal(collectElements(minimal).some((element) => elementClasses(element).includes('gr-files-reset')), false);
  // The row still renders: the removal must not have taken the file list with it.
  assert.ok(elementsByClass(minimal, 'gr-file-row').length >= 1, 'the file rows are still rendered');
});

/* ------------------------------------------------------------------------- */
/* Remote configuration — branch menu dialog + remoteSet wiring (task-14)    */
/* ------------------------------------------------------------------------- */

test('the remote dialog edits name/url with existing-remote fill and update hint', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const ui = runtime.require('ui');
  const t = runtime.require('i18n').createI18n('zh').t;
  const remotes = [
    { name: 'origin', url: 'https://example.com/org/repo.git' },
    { name: 'upstream', url: 'git@example.com:org/repo.git' },
  ];
  const calls = { name: [], url: [], pick: [], submit: 0, close: 0 };
  const dialog = components.RemoteDialog({
    t,
    scoped: true,
    open: true,
    name: 'origin',
    url: 'https://example.com/org/repo.git',
    remotes,
    busy: false,
    onNameChange: (value) => calls.name.push(value),
    onUrlChange: (value) => calls.url.push(value),
    onPick: (remote) => calls.pick.push(remote),
    onSubmit: () => { calls.submit += 1; },
    onClose: () => { calls.close += 1; },
  });
  assert.equal(typeof dialog.type, 'function');
  assert.equal(dialog.type.name, 'Modal', 'remote setup uses the shared dialog shell');
  assert.equal(dialog.props.open, true);
  assert.equal(dialog.props.scoped, true, 'the dialog is scoped to its review window');
  assert.equal(dialog.props.title, t('remote.title'));
  assert.equal(dialog.props.subtitle, t('remote.subtitle'));
  assert.equal(typeof dialog.props.onClose, 'function');

  const form = dialog.props.children;
  const formElements = collectElements(form);
  const fields = formElements.filter((element) => element.type === ui.TextField);
  assert.equal(fields.length, 2, 'the dialog has a name field and a URL field');
  const nameField = fields.find((element) => element.props.ariaLabel === t('remote.name'));
  const urlField = fields.find((element) => element.props.ariaLabel === t('remote.url'));
  assert.equal(nameField.props.id, 'gr-remote-name');
  assert.equal(nameField.props.value, 'origin');
  assert.equal(nameField.props.placeholder, t('remote.namePlaceholder'));
  assert.equal(nameField.props.disabled, false);
  assert.equal(urlField.props.id, 'gr-remote-url');
  assert.equal(urlField.props.value, 'https://example.com/org/repo.git');
  assert.equal(urlField.props.placeholder, t('remote.urlPlaceholder'));
  nameField.props.onChange({ target: { value: 'upstream' } });
  urlField.props.onChange({ target: { value: 'https://example.com/new.git' } });
  assert.deepEqual(calls.name, ['upstream']);
  assert.deepEqual(calls.url, ['https://example.com/new.git']);

  // Configured remotes are listed; clicking one fills the form from it.
  const rows = formElements.filter((element) => element.type === 'button'
    && elementClasses(element).includes('gr-remote-row'));
  assert.equal(rows.length, 2, 'one row per configured remote');
  const originRow = rows.find((row) => collectText(row).includes('origin'));
  const upstreamRow = rows.find((row) => collectText(row).includes('upstream'));
  assert.ok(collectText(originRow).includes('https://example.com/org/repo.git'), 'the row shows the current URL');
  assert.ok(elementClasses(originRow).includes('gr-remote-row-active'), 'the remote matching the name field is highlighted');
  assert.ok(elementClasses(upstreamRow).includes('gr-remote-row') && !elementClasses(upstreamRow).includes('gr-remote-row-active'));
  assert.equal(upstreamRow.props.title, t('remote.pick'));
  upstreamRow.props.onClick();
  assert.deepEqual(calls.pick, [remotes[1]], 'clicking a remote hands it back for filling the fields');

  // A name that already exists warns that saving updates it; the generic URL
  // hint is replaced, and the local-only notice always stays visible.
  const formText = collectText(form);
  assert.ok(formText.includes(t('remote.updateHint', { name: 'origin' })), formText);
  assert.equal(formText.includes(t('remote.urlHint')), false);
  assert.ok(formText.includes(t('remote.localOnly')), 'the dialog says only local config is written');
  assert.equal(formText.includes(t('remote.none')), false);

  // Footer: save submits, cancel closes.
  const footerButtons = collectElements(dialog.props.footer).filter((element) => element.type === ui.Button);
  const save = footerButtons.find((element) => element.props.children === t('remote.save'));
  const cancel = footerButtons.find((element) => element.props.children === t('common.cancel'));
  assert.ok(save && cancel);
  assert.equal(save.props.variant, 'primary');
  assert.equal(save.props.disabled, false);
  save.props.onClick();
  assert.equal(calls.submit, 1);
  cancel.props.onClick();
  assert.equal(calls.close, 1);

  // No configured remotes: empty hint instead of the list, generic URL hint
  // instead of the update warning.
  const emptyDialog = components.RemoteDialog({ t, open: true, name: 'origin', url: '', remotes: [] });
  const emptyText = collectText(emptyDialog.props.children);
  assert.ok(emptyText.includes(t('remote.none')));
  assert.ok(emptyText.includes(t('remote.urlHint')));
  assert.equal(emptyText.includes(t('remote.updateHint', { name: 'origin' })), false);
});

test('the remote dialog blocks the form while saving and shows the failure', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const ui = runtime.require('ui');
  const t = runtime.require('i18n').createI18n('zh').t;
  const errorText = t('error.remoteFailed');
  const dialog = components.RemoteDialog({
    t,
    open: true,
    name: 'origin',
    url: 'https://example.com/org/repo.git',
    remotes: [{ name: 'origin', url: 'https://old.example.com/repo.git' }],
    busy: true,
    errorText,
    onClose: () => {},
    onSubmit: () => {},
  });
  assert.equal(dialog.props.busy, true);
  assert.equal(dialog.props.onClose, undefined, 'a saving dialog cannot be dismissed');
  const formElements = collectElements(dialog.props.children);
  const fields = formElements.filter((element) => element.type === ui.TextField);
  assert.equal(fields.length, 2);
  for (const field of fields) assert.equal(field.props.disabled, true, 'inputs are locked while saving');
  const rows = formElements.filter((element) => element.type === 'button'
    && elementClasses(element).includes('gr-remote-row'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].props.disabled, true, 'remote shortcuts are locked while saving');
  const footerButtons = collectElements(dialog.props.footer).filter((element) => element.type === ui.Button);
  const save = footerButtons.find((element) => element.props.children === t('remote.save'));
  assert.equal(save.props.busy, true);
  assert.equal(save.props.disabled, true);
  assert.equal(save.props.busyLabel, t('remote.saving'));
  const cancel = footerButtons.find((element) => element.props.children === t('common.cancel'));
  assert.equal(cancel.props.disabled, true);

  const errorBox = formElements.find((element) => elementClasses(element).includes('gr-error-box'));
  assert.ok(errorBox, 'the failure is rendered inside the dialog');
  assert.equal(errorBox.props.role, 'alert');
  assert.ok(collectText(errorBox).includes(errorText));

  const clean = components.RemoteDialog({ t, open: true, name: 'origin', url: 'https://x', remotes: [] });
  assert.equal(collectElements(clean.props.children).some((element) => elementClasses(element).includes('gr-error-box')), false,
    'no error box without a failure');
});

test('the branch menu offers remote setup and the toolbar dispatches it', () => {
  const runtime = createClientRuntime();
  const components = runtime.require('components');
  const t = runtime.require('i18n').createI18n('zh').t;
  const items = components.branchMenuItems({ root: '/repo/x', branch: 'main', detached: false }, t);
  assert.equal(items.some((item) => item.id === 'set-remote'), true, 'the branch popover offers remote setup');
  // The popover opens through React state, so the selection dispatch stays a
  // source contract (same pattern as the copy actions).
  assert.match(componentsSource, /if \(id === 'set-remote'\) \{[\s\S]{0,140}?props\.onSetRemote\(\)/);
  assert.match(componentsSource, /onCopy\(value\), onSetRemote/, 'TopBar documents the onSetRemote prop');
  assert.match(appSource, /onSetRemote: openRemoteSettings/);
});

test('app writes remoteSet through the write path and refreshes the status', () => {
  assert.match(appSource, /rpc\.call\('remoteSet', params\)/);
  assert.match(appSource, /var params = \{ name: name, url: url \};/);
  assert.match(appSource, /if \(sessionId\) params\.sessionId = sessionId;\s*else if \(target && target\.cwd\) params\.cwd = target\.cwd;/);
  // Success: apply the fresh status (so the push button updates) and announce it.
  assert.match(appSource, /if \(result && result\.status\) applyStatus\(result\.status\);/);
  assert.match(appSource, /tRef\.current\('remote\.saved', \{ name: name \}\)/);
  // Failure: keep the dialog open with the localized error.
  assert.match(appSource, /errorText: remoteState\.error \? describeError\(remoteState\.error, t\) : null/);
  assert.match(appSource, /rpc\.call\('remoteSet', params\)\.then[\s\S]{0,900}?\.catch\(function \(error\)/);
  // Opening seeds the form from an existing remote, preferring origin.
  assert.match(appSource, /remotes\[index\]\.name === 'origin'/);
  assert.match(appSource, /name: preferred \? String\(preferred\.name\) : 'origin'/);
  // The dialog is mounted scoped, fed by the snapshot's remotes.
  const at = appSource.indexOf('h(components.RemoteDialog, {');
  assert.notEqual(at, -1, 'app.js renders RemoteDialog');
  const block = appSource.slice(at, appSource.indexOf('h(components.PushDialog, {', at));
  assert.match(block, /scoped: true/);
  assert.match(block, /remotes: snapshot && snapshot\.repo && Array\.isArray\(snapshot\.repo\.remotes\)/);
  assert.match(block, /onSubmit: submitRemote/);
  assert.match(block, /onClose: closeRemoteSettings/);
});

test('remote configuration copy and error mapping exist in both locales', () => {
  const runtime = createClientRuntime();
  const i18n = runtime.require('i18n');
  const keys = ['branch.setRemote', 'remote.title', 'remote.subtitle', 'remote.name', 'remote.namePlaceholder',
    'remote.url', 'remote.urlPlaceholder', 'remote.urlHint', 'remote.existing', 'remote.none', 'remote.pick',
    'remote.updateHint', 'remote.localOnly', 'remote.save', 'remote.saving', 'remote.saved',
    'error.remoteInvalid', 'error.remoteFailed'];
  for (const locale of ['zh', 'en']) {
    const dict = i18n.DICTIONARIES[locale];
    for (const key of keys) {
      assert.equal(typeof dict[key], 'string', `${locale}: missing ${key}`);
      assert.ok(dict[key].length > 0, `${locale}: empty ${key}`);
    }
    assert.ok(dict['remote.updateHint'].includes('{name}'), `${locale}: update hint interpolates the name`);
    assert.ok(dict['remote.saved'].includes('{name}'), `${locale}: saved notice interpolates the name`);
  }
  const zh = i18n.createI18n('zh').t;
  const en = i18n.createI18n('en').t;
  for (const key of ['branch.setRemote', 'remote.title', 'remote.save', 'remote.saved', 'error.remoteInvalid']) {
    assert.notEqual(zh(key), en(key), `${key} must be localized`);
  }
  const update = zh('remote.updateHint', { name: 'origin' });
  assert.ok(update.includes('origin'));
  assert.equal(update.includes('{name}'), false);
  // The two protocol errors map to the new copy and never leak the host message.
  assert.equal(i18n.ERROR_KEYS['remote/invalid'], 'error.remoteInvalid');
  assert.equal(i18n.ERROR_KEYS['remote/failed'], 'error.remoteFailed');
  assert.equal(i18n.describeError({ code: 'remote/invalid', message: 'C:\\secret' }, zh), zh('error.remoteInvalid'));
  assert.equal(i18n.describeError({ code: 'remote/failed', message: 'C:\\secret' }, en), en('error.remoteFailed'));
  // The disabled push reason points the user at the branch menu.
  assert.match(zh('reason.noRemote'), /分支/);
  assert.match(zh('reason.noRemote'), /远程/);
  assert.match(en('reason.noRemote'), /branch/i);
  assert.match(en('reason.noRemote'), /remote/i);
  // The dialog styles live in the theme-token stylesheet.
  assert.match(stylesSource, /\.gr-remote-form \{/);
  assert.match(stylesSource, /\.gr-remote-row-active \{/);
});

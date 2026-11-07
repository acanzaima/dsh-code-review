/**
 * Bundled-client smoke test: the generated `client.js` must register one
 * DSH module whose factory yields the plugin (`apply` + `inject`), and applying
 * it must contribute exactly the three slot entries this plugin owns.
 *
 * React is replaced with a minimal stub; the point is module wiring, not
 * rendering (rendering is exercised in the GUI).
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CLIENT_BUNDLE = new URL('../client.js', import.meta.url);

function reactStub() {
  const element = (...args) => ({ type: args[0], props: args[1] ?? null });
  return {
    createElement: element,
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

test('client bundle registers the plugin and its three slot entries', async () => {
  assert.equal(existsSync(CLIENT_BUNDLE), true, 'client.js is missing — run `npm run build`');
  const source = await readFile(CLIENT_BUNDLE, 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(/, 'not a DSH client bundle');

  let registration = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry;
      },
    },
  };
  try {
    (0, eval)(source);
  } finally {
    delete globalThis.window;
  }
  assert.ok(registration, 'the bundle did not call window.__ModuleLoader__.load');
  assert.equal(registration.id, 'dsh-code-review');
  assert.equal(typeof registration.factory, 'function');

  const react = reactStub();
  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return react;
    throw new Error(`unexpected module ${specifier}`);
  });
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(Array.isArray(plugin.inject));
  assert.ok(plugin.inject.includes('slots'));

  const registered = [];
  const fakeContext = {
    slots: {
      inject(owner, callback) {
        callback();
        return () => {};
      },
      register(options) {
        registered.push(options);
        return () => {};
      },
    },
    effect: (callback) => callback(),
  };
  plugin.apply(fakeContext);

  const names = registered.map((options) => options.name).sort();
  assert.deepEqual(names, ['conversation.input.left', 'shell.overlay', 'shell.overlay']);
  const ids = registered.map((options) => options.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate slot ids: ${ids.join(', ')}`);
  for (const options of registered) {
    assert.equal(typeof options.id, 'string');
    assert.ok(options.id.length > 0);
    const labelled = options.name === 'conversation.input.left';
    assert.equal(typeof options.label, labelled ? 'function' : 'undefined', `label mismatch for ${options.name}`);
  }
  // Settings live inside the review panel: no settings.section registration.
  assert.equal(registered.some((options) => options.name === 'settings.section'), false, 'settings.section must not be registered');
  // The style sheet entry renders without the review panel being open.
  const styleEntry = registered.find((options) => options.id === 'dsh-code-review-styles');
  assert.ok(styleEntry, 'missing always-mounted style entry');
  assert.equal(styleEntry.name, 'shell.overlay');
  const panelEntry = registered.find((options) => options.id === 'dsh-code-review-panel');
  assert.ok(panelEntry, 'missing review panel entry');

  // The panel ships as a non-modal floating window layer: per-window scoped
  // backdrops only, and the old single-panel/modal shell is gone.
  assert.match(source, /gr-window-layer/, 'client.js must carry the floating window layer');
  assert.match(source, /gr-window-ident/, 'client.js must carry the window title bar');
  assert.match(source, /gr-window-btn-close/, 'client.js must carry the window close button');
  assert.match(source, /gr-modal-backdrop-scoped/, 'in-window dialogs must use the scoped backdrop');
  assert.equal(source.includes('gr-modal-review'), false, 'the old full-page review modal is gone');
  assert.equal(source.includes('panelStore'), false, 'the old single-panel store is gone');
  assert.equal(source.includes('state.closePanel'), false, 'the old closePanel API is gone');
});

test('client bundle styles use theme tokens only', async () => {
  const source = await readFile(CLIENT_BUNDLE, 'utf8');
  assert.equal(/rgba?\(/.test(source), false, 'client.js must not contain literal rgb()/rgba() colours');
  assert.match(source, /--dsw-shadow-lv/, 'modal/menu shadows must use DSH shadow tokens');
});

test('client bundle carries the localized error catalogue for both locales', async () => {
  const source = await readFile(CLIENT_BUNDLE, 'utf8');
  for (const key of ['error.internal', 'error.entryStale', 'error.pushNetwork', 'error.unknown', 'state.truncated']) {
    const occurrences = source.split(key).length - 1;
    assert.ok(occurrences >= 2, `${key} must exist in both zh and en dictionaries (found ${occurrences})`);
  }
  assert.match(source, /transport\/http-/);
});


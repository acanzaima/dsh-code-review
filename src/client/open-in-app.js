/**
 * dsh-code-review — open project / file targets through DSH's own open-in-app
 * capability.
 *
 * The directory catalog and its launcher are DSH routes (the same ones the
 * host's session-header split button uses); specific files use the Session
 * Remote (`remote.session.openWorkspacePath`). Nothing here spawns processes
 * itself: the Host owns desktop opening, including which applications exist.
 *
 * Plain-script contract (`__def(name, function (exports, require, React) {...})`);
 * no ESM, no JSX.
 */
__def('open-in-app', function (exports) {
  'use strict';

  /* Directory applications DSH can announce; unknown ids are dropped so a host
   * catalog addition never renders an unlabeled row. */
  var APP_LABEL_KEYS = {
    finder: 'openApp.finder',
    explorer: 'openApp.explorer',
    filemanager: 'openApp.filemanager',
    cursor: 'openApp.cursor',
    vscode: 'openApp.vscode',
    vscodeinsiders: 'openApp.vscodeinsiders',
    windsurf: 'openApp.windsurf',
    zed: 'openApp.zed',
    sublimetext: 'openApp.sublimetext',
    xcode: 'openApp.xcode',
    androidstudio: 'openApp.androidstudio',
    intellij: 'openApp.intellij',
    pycharm: 'openApp.pycharm',
    webstorm: 'openApp.webstorm',
    phpstorm: 'openApp.phpstorm',
    goland: 'openApp.goland',
    rider: 'openApp.rider',
    rustrover: 'openApp.rustrover',
    fork: 'openApp.fork',
    sourcetree: 'openApp.sourcetree',
    github: 'openApp.github',
    tower: 'openApp.tower',
    gitkraken: 'openApp.gitkraken',
    smartgit: 'openApp.smartgit',
    sublimemerge: 'openApp.sublimemerge',
    ghostty: 'openApp.ghostty',
    warp: 'openApp.warp',
    iterm: 'openApp.iterm',
    kitty: 'openApp.kitty',
    terminal: 'openApp.terminal',
    windowsterminal: 'openApp.windowsterminal',
    gitbash: 'openApp.gitbash',
    gnometerminal: 'openApp.gnometerminal',
    konsole: 'openApp.konsole',
  };

  var FOLDER_APPS_ROUTE = 'open-in-app/apps';
  var FOLDER_OPEN_ROUTE = 'open-in-app/open';
  var FOLDER_ICON_ROUTE = 'open-in-app/icon/';

  function isKnownApp(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(APP_LABEL_KEYS, id);
  }

  function defaultFetcher() {
    return typeof fetch === 'function' ? fetch : null;
  }

  /** Installed directory applications, in the host's menu order. */
  function folderApps(fetcher) {
    var request = typeof fetcher === 'function' ? fetcher : defaultFetcher();
    if (!request) return Promise.resolve([]);
    return Promise.resolve(request(FOLDER_APPS_ROUTE, { headers: { accept: 'application/json' } }))
      .then(function (response) {
        return response && response.ok ? response.json() : null;
      })
      .then(function (payload) {
        var list = payload && Array.isArray(payload.apps) ? payload.apps : [];
        return list.filter(isKnownApp);
      })
      .catch(function () {
        return [];
      });
  }

  function appIconUrl(id) {
    return FOLDER_ICON_ROUTE + encodeURIComponent(String(id == null ? '' : id));
  }

  /** Launch one installed application on the project directory. */
  function openFolder(fetcher, appId, path) {
    var request = typeof fetcher === 'function' ? fetcher : defaultFetcher();
    if (!request || !isKnownApp(appId) || !path) return Promise.resolve(false);
    return Promise.resolve(request(FOLDER_OPEN_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: String(appId), path: String(path) }),
    })).then(function (response) {
      return !!(response && response.ok);
    }).catch(function () {
      return false;
    });
  }

  /** Join a repository-relative path onto the repository root. */
  function absoluteRepoPath(root, relative) {
    var base = String(root == null ? '' : root);
    var rel = String(relative == null ? '' : relative);
    if (!rel) return base;
    if (!base) return rel;
    var separator = base.indexOf('\\') !== -1 ? '\\' : '/';
    return base.replace(/[\\/]+$/, '') + separator + rel.replace(/[\\/]+/g, separator);
  }

  /** Resolve the optional `remote.session` service without a hard dependency. */
  function sessionService(ctx) {
    if (!ctx) return null;
    var service = null;
    if (typeof ctx.get === 'function') {
      try {
        service = ctx.get('remote.session') || null;
      } catch (error) {
        service = null;
      }
    }
    if (!service && ctx.remote && ctx.remote.session) service = ctx.remote.session;
    /* Both shapes exist in DSH: the namespace itself, or an object exposing it. */
    if (service && service.session && typeof service.session.canOpenWorkspacePath === 'function') {
      service = service.session;
    }
    return service && typeof service.openWorkspacePath === 'function' ? service : null;
  }

  /** Whether the Host desktop can open paths (false for e.g. remote sessions). */
  function canOpenFiles(session) {
    if (!session || typeof session.canOpenWorkspacePath !== 'function') return Promise.resolve(false);
    return Promise.resolve(session.canOpenWorkspacePath()).then(function (result) {
      return !!(result && result.ok && result.value);
    }).catch(function () {
      return false;
    });
  }

  /** Open one file with its default application, or reveal it in the file manager. */
  function openFile(session, path, action) {
    if (!session || typeof session.openWorkspacePath !== 'function' || !path) return Promise.resolve(false);
    var request = action === 'reveal'
      ? { path: String(path), action: 'reveal' }
      : { path: String(path) };
    return Promise.resolve(session.openWorkspacePath(request)).then(function (result) {
      /* The generated remote settles as `{ok:true, opened:true}`; a missing
       * field must not be treated as a failure. */
      return !!(result && result.ok !== false && result.opened !== false);
    }).catch(function () {
      return false;
    });
  }

  exports.APP_LABEL_KEYS = APP_LABEL_KEYS;
  exports.FOLDER_APPS_ROUTE = FOLDER_APPS_ROUTE;
  exports.FOLDER_OPEN_ROUTE = FOLDER_OPEN_ROUTE;
  exports.FOLDER_ICON_ROUTE = FOLDER_ICON_ROUTE;
  exports.isKnownApp = isKnownApp;
  exports.folderApps = folderApps;
  exports.appIconUrl = appIconUrl;
  exports.openFolder = openFolder;
  exports.absoluteRepoPath = absoluteRepoPath;
  exports.sessionService = sessionService;
  exports.canOpenFiles = canOpenFiles;
  exports.openFile = openFile;
});

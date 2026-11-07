__def('util', function (exports) {
  'use strict';

  /** Join class names, dropping falsy values. */
  function cx() {
    const out = [];
    for (let index = 0; index < arguments.length; index += 1) {
      const value = arguments[index];
      if (!value) continue;
      if (typeof value === 'string') out.push(value);
      else if (Array.isArray(value)) {
        const nested = cx.apply(null, value);
        if (nested) out.push(nested);
      } else if (typeof value === 'object') {
        for (const key of Object.keys(value)) if (value[key]) out.push(key);
      }
    }
    return out.join(' ');
  }

  /** Basename of a repository-relative path (both separators). */
  function basename(path) {
    const text = String(path || '');
    const at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    return at === -1 ? text : text.slice(at + 1);
  }

  /** Directory part ('' when the path is at the repository root). */
  function dirname(path) {
    const text = String(path || '');
    const at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    return at === -1 ? '' : text.slice(0, at);
  }

  function splitPath(path) {
    return { dir: dirname(path), base: basename(path) };
  }

  function formatCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    return number.toLocaleString('en-US');
  }

  function padStart(text, length) {
    let out = String(text);
    while (out.length < length) out = '0' + out;
    return out;
  }

  /** Small stable string hash for cache keys (not security relevant). */
  function hashString(text) {
    let hash = 2166136261;
    const source = String(text || '');
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  /** Debounce with cancel + immediate trigger. */
  function debounce(fn, delay) {
    let timer = null;
    let lastArgs = null;
    function run() {
      timer = null;
      const args = lastArgs || [];
      lastArgs = null;
      fn.apply(null, args);
    }
    function debounced() {
      lastArgs = Array.prototype.slice.call(arguments);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, delay);
    }
    debounced.cancel = function () {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      lastArgs = null;
    };
    debounced.flush = function () {
      if (timer === null) return;
      clearTimeout(timer);
      run();
    };
    return debounced;
  }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function isMac() {
    if (typeof navigator === 'undefined') return false;
    return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
  }

  function isActivationKey(event) {
    return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
  }

  function formatRelativeTime(time, now) {
    const current = now === undefined ? Date.now() : now;
    const delta = Math.max(0, current - Number(time || 0));
    const seconds = Math.round(delta / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return seconds + 's';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + 'm';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h';
    return Math.round(hours / 24) + 'd';
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Parse `@@ -a,b +c,d @@ section` defensively (the host also sends numbers). */
  function parseHunkHeader(header) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(String(header || ''));
    if (match === null) return null;
    return {
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
      section: match[5] || '',
    };
  }

  /** Deterministic JSON used for cache signatures. */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(function (key) {
      return JSON.stringify(key) + ':' + stableStringify(value[key]);
    }).join(',') + '}';
  }

  /**
   * Cache/operation identity of an entry: the base+target content fingerprints
   * plus the safe identity fields the host adds (`mode`, submodule `gitlink`).
   * Any of these changing must invalidate a shown diff and a review mark.
   */
  function fingerprintKey(entry) {
    const fingerprint = entry && entry.fingerprint ? entry.fingerprint : null;
    if (!fingerprint) return '';
    const parts = [
      String(fingerprint.base === undefined || fingerprint.base === null ? '' : fingerprint.base),
      String(fingerprint.target === undefined || fingerprint.target === null ? '' : fingerprint.target),
    ];
    if (fingerprint.mode) parts.push('m:' + String(fingerprint.mode));
    if (fingerprint.gitlink) {
      parts.push('g:' + String(fingerprint.gitlink.oldSha || '') + ':' + String(fingerprint.gitlink.newSha || ''));
    }
    return parts.join(':');
  }

  function noop() {}

  function safeCall(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  exports.cx = cx;
  exports.basename = basename;
  exports.dirname = dirname;
  exports.splitPath = splitPath;
  exports.formatCount = formatCount;
  exports.padStart = padStart;
  exports.hashString = hashString;
  exports.clamp = clamp;
  exports.debounce = debounce;
  exports.uid = uid;
  exports.isMac = isMac;
  exports.isActivationKey = isActivationKey;
  exports.formatRelativeTime = formatRelativeTime;
  exports.escapeRegExp = escapeRegExp;
  exports.parseHunkHeader = parseHunkHeader;
  exports.stableStringify = stableStringify;
  exports.fingerprintKey = fingerprintKey;
  exports.noop = noop;
  exports.safeCall = safeCall;
});

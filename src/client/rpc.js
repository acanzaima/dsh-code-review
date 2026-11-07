__def('rpc', function (exports) {
  'use strict';

  /**
   * Client half of the Host protocol: one authenticated `POST /api/code-review`
   * route on DSH's own `/api` Connection carrier. The browser cookie is DSH's
   * session cookie, so no token is handled here.
   */
  var ENDPOINT = '/api/code-review';

  /** A protocol failure reported by the Host half. */
  function RpcError(code, message, details) {
    var error = new Error(message || code || 'request failed');
    error.name = 'RpcError';
    error.code = code || 'internal';
    error.details = details;
    return error;
  }

  function createRpc(options) {
    var endpoint = (options && options.endpoint) || ENDPOINT;
    var doFetch = (options && options.fetch) || function (input, init) {
      return globalThis.fetch(input, init);
    };

    /**
     * @param {string} method protocol method name
     * @param {object} [params]
     * @param {{ signal?: AbortSignal }} [options]
     */
    function call(method, params, options) {
      var init = {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, params: params === undefined ? {} : params }),
      };
      if (options && options.signal) init.signal = options.signal;
      return doFetch(endpoint, init).then(function (response) {
        if (!response.ok) {
          /* Stable, localized-by-code message: the UI maps the code to a
           * dictionary string and never shows transport internals. */
          throw RpcError('transport/http-' + response.status, 'HTTP ' + response.status);
        }
        return response.json().catch(function () {
          throw RpcError('transport/bad-json', 'Invalid JSON response');
        });
      }).then(function (body) {
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          throw RpcError('transport/bad-envelope', 'Invalid response envelope');
        }
        if (body.ok === true) return body.value;
        var error = body.error || {};
        throw RpcError(error.code, error.message, error.details);
      });
    }

    return { call: call, endpoint: endpoint };
  }

  exports.createRpc = createRpc;
  exports.RpcError = RpcError;
});

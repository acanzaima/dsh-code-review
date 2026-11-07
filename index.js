/**
 * `dsh-code-review` Host entry.
 *
 * The package root is the Cordis plugin row (see `cordis.patch.yml`); the
 * implementation lives in `src/host/`. The browser half is the generated
 * `client.js` bundle declared by `dsh.client` in package.json.
 */
export { apply } from './src/host/index.js';

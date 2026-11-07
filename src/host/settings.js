/**
 * Plugin-owned settings persistence.
 *
 * DSH keeps per-plugin configuration in the profile patch, but this plugin's
 * settings are changed from its own Settings page at runtime, so they live in
 * one small JSON document under the DSH home directory. Writes are atomic
 * (tmp file + rename) and the last good value is kept in memory. The defaults
 * are the documented defaults: AI classification is OFF.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULTS = Object.freeze({ aiClassify: false, maxCandidates: 50, preclassify: false });

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh');
}

function clampInteger(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return Math.min(max, Math.max(min, rounded));
}

function normalize(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const next = {
    aiClassify: source.aiClassify === true,
    maxCandidates: clampInteger(source.maxCandidates, 1, 1000, DEFAULTS.maxCandidates),
    preclassify: source.preclassify === true,
  };
  if (typeof source.provider === 'string' && source.provider.length > 0) next.provider = source.provider;
  if (typeof source.model === 'string' && source.model.length > 0) next.model = source.model;
  if (typeof source.reasoningEffort === 'string' && source.reasoningEffort.length > 0
    && source.reasoningEffort.length <= 64) next.reasoningEffort = source.reasoningEffort;
  if (source.locale === 'zh' || source.locale === 'en') next.locale = source.locale;
  if (typeof source.customInstructions === 'string') {
    const instructions = source.customInstructions.trim().slice(0, 4000);
    if (instructions.length > 0) next.customInstructions = instructions;
  }
  return next;
}

/**
 * @param {{ logger?: { warn?: (error: Error) => void } }} [options]
 */
export function createSettingsStore(options = {}) {
  const logger = options.logger;
  let cache;
  let writeSequence = 0;

  const file = () => join(dshHome(), 'code-review', 'settings.json');

  async function read() {
    if (cache !== undefined) return { ...cache };
    try {
      const text = await readFile(file(), 'utf8');
      cache = normalize(JSON.parse(text));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(
          new Error(`[code-review] settings file is unreadable, using defaults: ${String(error?.message ?? error)}`),
        );
      }
      cache = { ...DEFAULTS };
    }
    return { ...cache };
  }

  async function write(patch) {
    const current = await read();
    // A null value explicitly clears a field (e.g. "use the session model again").
    const merged = { ...current };
    const changes = patch !== null && typeof patch === 'object' ? patch : {};
    for (const key of Object.keys(changes)) {
      if (changes[key] === null || changes[key] === undefined) delete merged[key];
      else merged[key] = changes[key];
    }
    const next = normalize(merged);
    const target = file();
    await mkdir(join(target, '..'), { recursive: true });
    // Each write owns a unique temporary file so overlapping writes (callers are
    // serialized by the plugin's mutation chain, but this store is also used
    // standalone) can never rename a half-written sibling over the settings.
    writeSequence += 1;
    const temporary = `${target}.${process.pid}.${writeSequence}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
    cache = next;
    return { ...next };
  }

  return { file, read, write };
}

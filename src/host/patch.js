// Unified-diff parsing / single-hunk patch building helpers used by git.js.
//
// Everything is kept byte-exact: patches produced by `git diff` are re-emitted
// from the original raw lines (never re-serialised from decoded text), so CRLF
// content, missing trailing newlines and arbitrary byte sequences survive a
// parse -> build round-trip unchanged. Decoded strings are only used for the
// human-facing fields of the contract's `Hunk` type.
import { createHash } from 'node:crypto';

/** Documented caps shared by git.js and patch.js. */
export const MAX_SIDE_BYTES = 2 * 1024 * 1024; // per diff side
export const MAX_SIDE_LINES = 40000; // per diff side

/** Fingerprint sentinels from docs/protocol.md §3.2. */
export const EMPTY = 'empty';
export const DIR = 'dir';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value == null ? '' : String(value), 'utf8');
}

/** Number of logical lines in a text buffer ("a\nb\n" -> 2, "a\nb" -> 2, "" -> 0). */
export function countTextLines(buf) {
  if (!buf || buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  if (buf[buf.length - 1] !== 0x0a) n++;
  return n;
}

/** git's heuristic: a blob is binary when a NUL byte appears in the first 8000 bytes. */
export function looksBinary(buf) {
  if (!buf || buf.length === 0) return false;
  const end = Math.min(buf.length, 8000);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

export function truncateText(buf, maxLines) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length && lines.length < maxLines; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (lines.length < maxLines && start < buf.length) lines.push(buf.subarray(start));
  return Buffer.concat(lines).toString('utf8');
}

function decode(buf) {
  return buf.toString('utf8');
}

// --- path quoting -----------------------------------------------------------
// `git apply` parses C-style quoted paths in patch headers. We always quote
// (even for plain ASCII) so a path can never be mistaken for an option or be
// split on spaces/tabs; the escaping matches git's quote_c_style().
export function quotePath(relPath) {
  const bytes = Buffer.from(relPath, 'utf8');
  let out = '"';
  for (const byte of bytes) {
    switch (byte) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += '\\\\'; break;
      case 0x07: out += '\\a'; break;
      case 0x08: out += '\\b'; break;
      case 0x09: out += '\\t'; break;
      case 0x0a: out += '\\n'; break;
      case 0x0b: out += '\\v'; break;
      case 0x0c: out += '\\f'; break;
      case 0x0d: out += '\\r'; break;
      default:
        out += byte >= 0x20 && byte <= 0x7e && byte !== 0x22 && byte !== 0x5c
          ? String.fromCharCode(byte)
          : '\\' + byte.toString(8).padStart(3, '0');
    }
  }
  return out + '"';
}

// --- parsing ----------------------------------------------------------------

function splitLines(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push({ buf: buf.subarray(start, i), eol: true });
      start = i + 1;
    }
  }
  if (start < buf.length) lines.push({ buf: buf.subarray(start), eol: false });
  return lines;
}

function newLine(text, eol = true) {
  return { buf: Buffer.from(text, 'utf8'), eol };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function parseHunkHeader(line) {
  const text = decode(line.buf);
  const match = HUNK_HEADER.exec(text);
  if (!match) return null;
  return {
    headerText: text.trimEnd(),
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    section: (match[5] || '').trimEnd(),
  };
}

/**
 * Parse a unified diff into file sections and hunks.
 *
 * Returns { files } where each file is
 *   { headerLines, binary, hunks }
 * and each hunk is
 *   { headerLine, headerText, oldStart, oldLines, newStart, newLines, section,
 *     rawLines, lines }
 * `headerLines` holds the raw `diff --git` .. `+++` lines; `rawLines` holds the
 * hunk body lines verbatim (including "\ No newline at end of file" markers).
 * `lines` is the contract-visible list: only '+'/'-'/' ' entries.
 */
export function parsePatch(input) {
  const buf = toBuffer(input);
  const lines = splitLines(buf);
  const files = [];
  let file = null;
  let hunk = null;

  const startHunk = (line) => {
    const header = parseHunkHeader(line);
    if (!header) return false;
    hunk = { ...header, headerLine: line, rawLines: [], lines: [], oldPos: header.oldStart, newPos: header.newStart };
    if (file) file.hunks.push(hunk);
    return true;
  };

  const endHunk = () => {
    if (!hunk) return;
    // Strip "\ No newline at end of file" bookkeeping: markers stay in rawLines
    // but are not contract lines.
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const first = line.buf.length ? line.buf[0] : -1;

    if (hunk) {
      // Hunk body lines always start with ' ', '+' or '-' (and '\' for the
      // no-newline marker). Anything else ends the hunk.
      if (first === 0x20 || first === 0x2b || first === 0x2d || first === 0x5c) {
        hunk.rawLines.push(line);
        if (first === 0x5c) continue; // marker
        const kind = first === 0x2b ? '+' : first === 0x2d ? '-' : ' ';
        const text = decode(line.buf.subarray(1));
        const oldLine = hunk.oldPos;
        const newLine = hunk.newPos;
        if (kind === ' ') {
          hunk.oldPos++;
          hunk.newPos++;
        } else if (kind === '-') {
          hunk.oldPos++;
        } else {
          hunk.newPos++;
        }
        hunk.lines.push({ kind, text, oldLine, newLine });
        continue;
      }
      endHunk();
      // fall through: this line starts a new file/hunk section
    }

    const text = decode(line.buf);
    if (text.startsWith('diff --git ')) {
      file = { headerLines: [line], binary: false, hunks: [] };
      files.push(file);
      continue;
    }
    if (!file) continue; // preamble such as "* Unmerged path x"
    if (first === 0x40 /* '@' */ && startHunk(line)) continue;
    file.headerLines.push(line);
    if (text.startsWith('Binary files ') || text.startsWith('GIT binary patch')) file.binary = true;
  }
  return { files };
}

/** First file section of a diff, or null. */
export function firstFile(parsed) {
  return parsed && parsed.files && parsed.files.length ? parsed.files[0] : null;
}

/** All hunks of a diff in order (a per-entry diff only ever has one file). */
export function allHunks(parsed) {
  const out = [];
  for (const file of parsed.files) out.push(...file.hunks);
  return out;
}

/**
 * Re-emit the raw bytes of a single hunk together with its exact file header.
 * This is what gets fed to `git apply`.
 */
export function buildSingleHunkPatch(file, hunk) {
  const parts = [];
  for (const line of file.headerLines) parts.push(line.buf, line.eol ? Buffer.from('\n') : Buffer.alloc(0));
  parts.push(hunk.headerLine.buf, hunk.headerLine.eol ? Buffer.from('\n') : Buffer.alloc(0));
  for (const line of hunk.rawLines) parts.push(line.buf, line.eol ? Buffer.from('\n') : Buffer.alloc(0));
  return Buffer.concat(parts);
}

/** Compare two parsed hunks by header and body (used to re-identify a hunk). */
export function findMatchingHunk(hunks, expected, fromIndex = 0) {
  if (!expected) return -1;
  for (let i = Math.max(0, fromIndex); i < hunks.length; i++) {
    const hunk = hunks[i];
    if (hunk.headerText !== expected.headerText) continue;
    if (hunk.lines.length !== expected.lines.length) continue;
    let same = true;
    for (let k = 0; k < hunk.lines.length; k++) {
      const a = hunk.lines[k];
      const b = expected.lines[k];
      if (a.kind !== b.kind || a.text !== b.text) { same = false; break; }
    }
    if (same) return i;
  }
  return -1;
}

// --- synthetic patch for untracked files ------------------------------------

/**
 * Build the parsed-patch equivalent of `git diff` for an untracked file
 * (/dev/null -> content). The result has the same shape as parsePatch() so the
 * normal single-hunk application path can be reused.
 */
export function makeNewFilePatch(relPath, content, mode = '100644') {
  const headerLines = [
    newLine(`diff --git ${quotePath('a/' + relPath)} ${quotePath('b/' + relPath)}`),
    newLine(`new file mode ${mode}`),
    newLine('--- /dev/null'),
    newLine(`+++ ${quotePath('b/' + relPath)}`),
  ];

  const file = { headerLines, binary: false, hunks: [] };
  const buf = toBuffer(content);
  if (buf.length === 0) return { files: [file] };
  const bodyLines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      bodyLines.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  const endsWithNewline = buf.length > 0 && buf[buf.length - 1] === 0x0a;
  if (!endsWithNewline) bodyLines.push(buf.subarray(start));
  const rawLines = [];
  const lines = [];
  for (let i = 0; i < bodyLines.length; i++) {
    // Every patch line is newline-terminated, including the last content line.
    // "No newline at end of file" is a *separate* marker line; only then does
    // the patch apply to bytes that lack a trailing newline.
    rawLines.push({ buf: Buffer.concat([Buffer.from('+'), bodyLines[i]]), eol: true });
    lines.push({ kind: '+', text: bodyLines[i].toString('utf8'), oldLine: 0, newLine: i + 1 });
  }
  if (!endsWithNewline) rawLines.push({ buf: Buffer.from('\\ No newline at end of file'), eol: true });

  const hunk = {
    headerText: `@@ -0,0 +1,${bodyLines.length} @@`,
    headerLine: newLine(`@@ -0,0 +1,${bodyLines.length} @@`),
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: bodyLines.length,
    section: '',
    rawLines,
    lines,
  };
  file.hunks.push(hunk);
  return { files: [file] };
}

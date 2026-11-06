/**
 * Pure helpers shared by the VS Code runtime and its tests.
 *
 * This module deliberately has no dependency on the `vscode` module, so it can
 * be executed with plain Node. The runtime is responsible for converting a
 * dropped file URI with `vscode.Uri.parse(uri).fsPath` (do not decode it before
 * that point) and for passing the result of `formatMention` to the terminal.
 */

import * as path from 'node:path';

/** A zero-based position, matching VS Code's `Position` shape. */
export interface TextPosition {
  readonly line: number;
  readonly character: number;
}

/** A zero-based range, matching VS Code's `Range` shape. */
export interface TextRange {
  readonly start: TextPosition;
  readonly end: TextPosition;
}

/** One-based, inclusive line numbers as used inside an OpenCode mention. */
export interface MentionLines {
  readonly startLine: number;
  readonly endLine: number;
}

export type MentionErrorCode =
  | 'invalid-path'
  | 'invalid-root'
  | 'control-character'
  | 'path-with-spaces'
  | 'invalid-range';

export interface FormatMentionSuccess {
  readonly ok: true;
  /** Example: `@src/core.ts` or `@src/core.ts#200-201`. */
  readonly mention: string;
  /** Normalized path portion, without `@` and without the line suffix. */
  readonly path: string;
  /** True when the file is outside the workspace root. */
  readonly outsideWorkspace: boolean;
  /** Present only when a non-empty selection was supplied. */
  readonly lines?: MentionLines;
}

export interface FormatMentionFailure {
  readonly ok: false;
  readonly code: MentionErrorCode;
  readonly message: string;
}

export type FormatMentionResult = FormatMentionSuccess | FormatMentionFailure;

export type DropSource =
  | 'text/uri-list'
  | 'ResourceURLs'
  | 'CodeFiles'
  | 'CodeEditors';

export type DropWarningCode =
  | 'invalid-json'
  | 'invalid-uri'
  | 'unsupported-scheme'
  | 'invalid-selection'
  | 'unsupported-payload';

export interface DropWarning {
  readonly code: DropWarningCode;
  readonly message: string;
  readonly source?: DropSource;
}

export interface DropTarget {
  /**
   * The URI exactly as supplied by VS Code (percent escapes are preserved).
   * Only `file:` URIs are returned.
   */
  readonly uri: string;
  /** Zero-based selection hint, when the payload contains one. */
  readonly range?: TextRange;
  readonly source: DropSource;
}

/**
 * Accepted by `parseDropPayload`. Callers may either use the named fields or
 * pass a MIME-keyed record, for example:
 *
 * ```ts
 * {
 *   'text/uri-list': dataTransfer.getData('text/uri-list'),
 *   ResourceURLs: dataTransfer.getData('ResourceURLs'),
 *   CodeFiles: dataTransfer.getData('CodeFiles'),
 *   CodeEditors: dataTransfer.getData('CodeEditors'),
 *   'text/plain': dataTransfer.getData('text/plain'),
 * }
 * ```
 */
export interface DropPayload {
  readonly text?: string;
  readonly plainText?: string;
  readonly uriList?: string | readonly string[];
  readonly resourceUrls?: unknown;
  readonly codeFiles?: unknown;
  readonly codeEditors?: unknown;
  readonly [mime: string]: unknown;
}

export interface DropParseResult {
  /** Unique files, in first-seen order. */
  readonly files: readonly DropTarget[];
  /** `text/plain`, returned verbatim and never treated as a path. */
  readonly plainText?: string;
  /** Non-fatal problems encountered while parsing. */
  readonly warnings: readonly DropWarning[];
}

type PathFlavor = 'windows' | 'posix';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;
const URI_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

function failure(code: MentionErrorCode, message: string): FormatMentionFailure {
  return { ok: false, code, message };
}

function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

function absoluteFlavor(value: string): PathFlavor | undefined {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return 'windows';
  }
  // UNC path using backslashes, e.g. \\server\share\file.ts
  if (/^\\\\[^\\/]/.test(value)) {
    return 'windows';
  }
  // UNC path using forward slashes, e.g. //server/share/file.ts
  if (/^\/\/[^/]/.test(value)) {
    return 'windows';
  }
  if (value.startsWith('/')) {
    return 'posix';
  }
  return undefined;
}

function stripTrailingSlashes(value: string): string {
  if (
    value === '/' ||
    /^[A-Za-z]:\/$/.test(value) ||
    /^\/\/[^/]+\/[^/]+\/$/.test(value)
  ) {
    return value;
  }
  return value.replace(/\/+$/, '');
}

function normalizeAbsolute(value: string, flavor: PathFlavor): string {
  const normalized =
    flavor === 'windows'
      ? path.win32.normalize(value).replace(/\\/g, '/')
      : path.posix.normalize(value);
  return stripTrailingSlashes(normalized);
}

interface RelativeResult {
  readonly path: string;
  readonly inside: boolean;
}

function relativeToRoot(
  root: string,
  candidate: string,
  flavor: PathFlavor,
): RelativeResult {
  const relative =
    flavor === 'windows'
      ? path.win32.relative(root, candidate)
      : path.posix.relative(root, candidate);
  const normalized = relative.replace(/\\/g, '/');

  if (normalized === '') {
    return { path: '', inside: true };
  }

  const inside =
    normalized !== '..' &&
    !normalized.startsWith('../') &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.startsWith('//');

  return { path: normalized, inside };
}

function isPosition(value: unknown): value is TextPosition {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const position = value as { line?: unknown; character?: unknown };
  return (
    Number.isSafeInteger(position.line) &&
    (position.line as number) >= 0 &&
    Number.isSafeInteger(position.character) &&
    (position.character as number) >= 0
  );
}

interface RangeConversion {
  readonly ok: boolean;
  readonly lines?: MentionLines;
  readonly message?: string;
}

/**
 * Converts a zero-based VS Code range to one-based inclusive mention lines.
 * `end.character === 0` means the end line itself is excluded.
 */
function convertRange(range: TextRange): RangeConversion {
  const value = range as unknown;
  if (value === null || typeof value !== 'object') {
    return { ok: false, message: 'Selection range must be an object.' };
  }

  const candidate = value as { start?: unknown; end?: unknown };
  if (!isPosition(candidate.start) || !isPosition(candidate.end)) {
    return {
      ok: false,
      message: 'Selection start and end must have non-negative integer lines and characters.',
    };
  }

  const start = candidate.start;
  const end = candidate.end;

  if (
    end.line < start.line ||
    (end.line === start.line && end.character < start.character)
  ) {
    return {
      ok: false,
      message: 'Selection end must not be before its start.',
    };
  }

  // An end at the start of a later line excludes that line from the selection.
  let lastLine = end.line;
  if (end.character === 0 && end.line > start.line) {
    lastLine = end.line - 1;
  }

  // A zero-width selection on one line carries no line range.
  if (
    end.character === 0 &&
    end.line === start.line &&
    start.character === 0
  ) {
    return { ok: true };
  }

  return {
    ok: true,
    lines: {
      startLine: start.line + 1,
      endLine: lastLine + 1,
    },
  };
}

/**
 * Formats a file path (and optional zero-based selection) as an OpenCode
 * mention.
 *
 * - Paths inside `rootPath` become relative mentions such as `@src/core.ts`.
 * - Paths outside `rootPath` remain absolute, with `/` as separator.
 * - Windows `\` separators and drive letters are preserved as `C:/...`.
 * - Paths containing spaces are rejected rather than guessing a quoting
 *   syntax that OpenCode may not support.
 * - Control characters are rejected to prevent terminal injection.
 * - A range with `end.character === 0` excludes the end line, so lines
 *   `199..200` (0-based) with an end character of `0` produce `#200-200`.
 */
export function formatMention(
  filePath: string,
  rootPath: string,
  range?: TextRange,
): FormatMentionResult {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return failure('invalid-path', 'File path must be a non-empty string.');
  }
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    return failure('invalid-root', 'Workspace root must be a non-empty absolute path.');
  }
  if (hasControlCharacters(rootPath)) {
    return failure('invalid-root', 'Workspace root contains control characters.');
  }
  if (hasControlCharacters(filePath)) {
    return failure('control-character', 'File path contains control characters.');
  }
  if (WINDOWS_DRIVE_RELATIVE.test(filePath)) {
    return failure(
      'invalid-path',
      'Drive-relative paths such as "C:file.ts" are ambiguous; use an absolute path.',
    );
  }

  const rootFlavor = absoluteFlavor(rootPath);
  if (rootFlavor === undefined) {
    return failure('invalid-root', 'Workspace root must be an absolute POSIX or Windows path.');
  }
  const root = normalizeAbsolute(rootPath, rootFlavor);

  let lines: MentionLines | undefined;
  if (range !== undefined) {
    const converted = convertRange(range);
    if (!converted.ok) {
      return failure('invalid-range', converted.message ?? 'Invalid selection range.');
    }
    lines = converted.lines;
  }

  const fileFlavor = absoluteFlavor(filePath);
  let mentionPath: string;
  let outsideWorkspace: boolean;

  if (fileFlavor !== undefined) {
    const absolute = normalizeAbsolute(filePath, fileFlavor);
    if (fileFlavor === rootFlavor) {
      const relative = relativeToRoot(root, absolute, rootFlavor);
      if (relative.inside) {
        if (relative.path === '') {
          return failure('invalid-path', 'File path resolves to the workspace root, not a file.');
        }
        mentionPath = relative.path;
        outsideWorkspace = false;
      } else {
        mentionPath = absolute;
        outsideWorkspace = true;
      }
    } else {
      mentionPath = absolute;
      outsideWorkspace = true;
    }
  } else {
    // `path.resolve` handles `..` segments. If the result escapes the workspace,
    // the absolute form is used.
    const absoluteRaw =
      rootFlavor === 'windows'
        ? path.win32.resolve(root, filePath)
        : path.posix.resolve(root, filePath);
    const absolute = normalizeAbsolute(absoluteRaw, rootFlavor);
    const relative = relativeToRoot(root, absolute, rootFlavor);

    if (relative.inside && relative.path !== '') {
      mentionPath = relative.path;
      outsideWorkspace = false;
    } else if (relative.inside) {
      return failure('invalid-path', 'File path resolves to the workspace root, not a file.');
    } else {
      mentionPath = absolute;
      outsideWorkspace = true;
    }
  }

  if (hasControlCharacters(mentionPath)) {
    return failure('control-character', 'Normalized file path contains control characters.');
  }
  if (mentionPath.includes(' ')) {
    return failure(
      'path-with-spaces',
      'OpenCode mention paths containing spaces are not supported. ' +
        'This extension does not invent a quoting syntax; rename or move the file to a path without spaces.',
    );
  }
  if (mentionPath.includes('#')) {
    return failure(
      'invalid-path',
      'OpenCode mention paths containing "#" are ambiguous with the line suffix ' +
        '("#200-201"). This extension does not guess an escaping syntax; ' +
        'rename or move the file to a path without "#".',
    );
  }
  if (mentionPath.length === 0 || mentionPath === '.') {
    return failure('invalid-path', 'File path does not identify a file.');
  }

  const suffix =
    lines === undefined ? '' : `#${lines.startLine}-${lines.endLine}`;

  return {
    ok: true,
    mention: `@${mentionPath}${suffix}`,
    path: mentionPath,
    outsideWorkspace,
    ...(lines === undefined ? {} : { lines }),
  };
}

function dropWarning(
  code: DropWarningCode,
  message: string,
  source?: DropSource,
): DropWarning {
  return source === undefined ? { code, message } : { code, message, source };
}

function readMime(
  payload: Record<string, unknown>,
  names: readonly string[],
): unknown {
  const values = new Map<string, unknown>();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    values.set(key.toLowerCase(), value);
  }

  for (const name of names) {
    const value = values.get(name.toLowerCase());
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function decodeJson(
  raw: unknown,
  source: DropSource,
  warnings: DropWarning[],
): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }

  const text = raw.trim();
  if (text.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    warnings.push(
      dropWarning(
        'invalid-json',
        `${source} payload is not valid JSON and was ignored.`,
        source,
      ),
    );
    return undefined;
  }
}

function firstDefined(
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function uriFromComponents(value: Record<string, unknown>): string | undefined {
  const scheme = value.scheme;
  const uriPath = value.path;
  if (typeof scheme !== 'string' || typeof uriPath !== 'string') {
    return undefined;
  }

  const authority =
    typeof value.authority === 'string' ? value.authority : undefined;

  let uri: string;
  if (scheme.toLowerCase() === 'file') {
    const pathPart = uriPath.startsWith('/') ? uriPath : `/${uriPath}`;
    uri = `${scheme}://${authority ?? ''}${pathPart}`;
  } else {
    uri = `${scheme}:`;
    if (authority !== undefined) {
      uri += `//${authority}`;
    }
    uri += uriPath;
  }

  if (typeof value.query === 'string' && value.query.length > 0) {
    uri += `?${value.query}`;
  }
  if (typeof value.fragment === 'string' && value.fragment.length > 0) {
    uri += `#${value.fragment}`;
  }

  return uri;
}

function uriFromValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const nested = firstDefined(record, ['external', 'uri', 'url']);
  if (typeof nested === 'string') {
    return nested;
  }
  return uriFromComponents(record);
}

function parseRange(value: unknown): TextRange | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as { start?: unknown; end?: unknown };
  if (!isPosition(record.start) || !isPosition(record.end)) {
    return undefined;
  }
  if (
    record.end.line < record.start.line ||
    (record.end.line === record.start.line &&
      record.end.character < record.start.character)
  ) {
    return undefined;
  }

  return {
    start: { line: record.start.line, character: record.start.character },
    end: { line: record.end.line, character: record.end.character },
  };
}

function readSelection(
  record: Record<string, unknown>,
  source: DropSource,
  warnings: DropWarning[],
): TextRange | undefined {
  let raw = record.selection;
  if (raw === undefined) {
    raw = record.range;
  }
  if (raw === undefined && Array.isArray(record.selections) && record.selections.length > 0) {
    raw = record.selections[0];
  }
  if (raw === undefined) {
    return undefined;
  }

  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const wrapper = raw as Record<string, unknown>;
    if (wrapper.start === undefined && wrapper.range !== undefined) {
      raw = wrapper.range;
    }
  }

  const range = parseRange(raw);
  if (range === undefined) {
    warnings.push(
      dropWarning(
        'invalid-selection',
        `${source} entry contains an invalid selection; the file is kept without a line range.`,
        source,
      ),
    );
  }
  return range;
}

function makeTarget(
  rawUri: unknown,
  source: DropSource,
  range: TextRange | undefined,
  warnings: DropWarning[],
): DropTarget | undefined {
  if (typeof rawUri !== 'string') {
    warnings.push(
      dropWarning('invalid-uri', `${source} entry is not a URI string.`, source),
    );
    return undefined;
  }

  const uri = rawUri.trim();
  if (uri.length === 0) {
    warnings.push(
      dropWarning('invalid-uri', `${source} entry contains an empty URI.`, source),
    );
    return undefined;
  }
  if (hasControlCharacters(uri)) {
    warnings.push(
      dropWarning(
        'invalid-uri',
        `${source} entry contains control characters and was ignored.`,
        source,
      ),
    );
    return undefined;
  }

  const match = URI_SCHEME.exec(uri);
  if (match === null) {
    warnings.push(
      dropWarning('invalid-uri', `${source} entry is not a valid URI.`, source),
    );
    return undefined;
  }

  const scheme = match[1];
  if (scheme.toLowerCase() !== 'file') {
    warnings.push(
      dropWarning(
        'unsupported-scheme',
        `Unsupported URI scheme "${scheme}:". Only file: URIs are accepted.`,
        source,
      ),
    );
    return undefined;
  }

  if (uri.length <= match[0].length) {
    warnings.push(
      dropWarning('invalid-uri', `${source} entry has no file URI path.`, source),
    );
    return undefined;
  }

  // Reject authority-only URIs such as `file://` that carry no path at all.
  const pathPart = uri
    .slice(match[0].length)
    .replace(/^\/\/[^/?#]*/, '');
  if (
    pathPart.length === 0 ||
    pathPart === '/' ||
    pathPart.startsWith('?') ||
    pathPart.startsWith('#')
  ) {
    warnings.push(
      dropWarning('invalid-uri', `${source} entry has no file URI path.`, source),
    );
    return undefined;
  }

  return range === undefined
    ? { uri, source }
    : { uri, range, source };
}

/**
 * Parses a VS Code drop payload without decoding file URIs.
 *
 * Supported data:
 * - `text/uri-list` (newline-separated URIs, `#` comments ignored)
 * - `ResourceURLs`, `CodeFiles`, `CodeEditors` (JSON text or already-parsed)
 * - plain text via `text`, `plainText`, or `text/plain`
 *
 * Only `file:` URIs are accepted. Plain text is returned in `plainText` and is
 * never guessed to be a file path. Malformed data produces warnings instead of
 * throwing, so a drop can still use whichever parts are valid.
 */
export function parseDropPayload(payload: unknown): DropParseResult {
  const warnings: DropWarning[] = [];

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      files: [],
      warnings: [
        dropWarning(
          'unsupported-payload',
          'Drop payload must be an object keyed by MIME type.',
        ),
      ],
    };
  }

  const record = payload as Record<string, unknown>;
  const files = new Map<string, DropTarget>();

  const addUri = (
    rawUri: unknown,
    source: DropSource,
    range?: TextRange,
  ): void => {
    const target = makeTarget(rawUri, source, range, warnings);
    if (target === undefined) {
      return;
    }

    const existing = files.get(target.uri);
    if (existing === undefined) {
      files.set(target.uri, target);
      return;
    }

    // Prefer a richer entry that carries a selection over one that does not.
    if (existing.range === undefined && target.range !== undefined) {
      files.set(target.uri, { ...existing, range: target.range });
    }
  };

  const uriList = readMime(record, ['uri-list', 'text/uri-list', 'uriList']);
  if (uriList !== undefined) {
    if (typeof uriList === 'string') {
      for (const line of uriList.split(/\r?\n/)) {
        const value = line.trim();
        if (value.length === 0 || value.startsWith('#')) {
          continue;
        }
        addUri(value, 'text/uri-list');
      }
    } else if (Array.isArray(uriList)) {
      for (const value of uriList) {
        addUri(value, 'text/uri-list');
      }
    } else {
      warnings.push(
        dropWarning(
          'unsupported-payload',
          'text/uri-list must be a string or an array of URI strings.',
          'text/uri-list',
        ),
      );
    }
  }

  const jsonFields: ReadonlyArray<{
    readonly names: readonly string[];
    readonly source: DropSource;
  }> = [
    { names: ['ResourceURLs', 'resourceUrls', 'resourceURLs'], source: 'ResourceURLs' },
    { names: ['CodeFiles', 'codeFiles'], source: 'CodeFiles' },
    { names: ['CodeEditors', 'codeEditors'], source: 'CodeEditors' },
  ];

  for (const field of jsonFields) {
    const raw = readMime(record, field.names);
    if (raw === undefined) {
      continue;
    }

    const decoded = decodeJson(raw, field.source, warnings);
    if (decoded === undefined) {
      continue;
    }

    const entries = Array.isArray(decoded) ? decoded : [decoded];
    for (const entry of entries) {
      if (typeof entry === 'string') {
        addUri(entry, field.source);
        continue;
      }

      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        warnings.push(
          dropWarning(
            'invalid-uri',
            `${field.source} entry is not a URI string or object.`,
            field.source,
          ),
        );
        continue;
      }

      const item = entry as Record<string, unknown>;
      const range = readSelection(item, field.source, warnings);
      const uriValue = firstDefined(item, ['uri', 'url', 'resource', 'external']);
      const uri = uriFromValue(uriValue);

      if (uri === undefined) {
        warnings.push(
          dropWarning(
            'invalid-uri',
            `${field.source} entry does not contain a usable URI.`,
            field.source,
          ),
        );
        continue;
      }

      addUri(uri, field.source, range);
    }
  }

  const rawText = readMime(record, ['text', 'plainText', 'text/plain']);
  let plainText: string | undefined;
  if (rawText !== undefined) {
    if (typeof rawText === 'string') {
      if (rawText.length > 0) {
        plainText = rawText;
      }
    } else {
      warnings.push(
        dropWarning(
          'unsupported-payload',
          'Plain text drop data must be a string.',
        ),
      );
    }
  }

  return plainText === undefined
    ? { files: [...files.values()], warnings }
    : { files: [...files.values()], plainText, warnings };
}

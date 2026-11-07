/**
 * Pure runtime helpers shared by `extension.ts` and its tests.
 *
 * This module has no dependency on the `vscode` module so message validation,
 * selection matching and clipboard/PTY protocol policy can be tested with
 * plain Node. The reference-list and native-terminal registry helpers are kept
 * for backwards-compatible tests; 0.0.2 embeds its own PTY and no longer uses
 * an attachment drawer.
 */

import { formatMention, type TextRange } from './core';

export const MAX_WEBVIEW_IDS = 200;
export const MAX_ID_LENGTH = 128;
export const MAX_DROP_FIELD_LENGTH = 200_000;
export const MAX_TOTAL_MESSAGE_LENGTH = 500_000;
export const MAX_ATTACHMENTS = 200;
export const MAX_SELECTION_CACHE = 100;
export const MAX_SELECTION_TEXT_LENGTH = 200_000;
export const MAX_INSERT_TEXT_LENGTH = 200_000;
export const MAX_LAUNCH_COMMAND_LENGTH = 500;
export const SELECTION_TTL_MS = 5 * 60 * 1000;
export const MAX_PTY_INPUT_LENGTH = 100_000;
export const MAX_PTY_COLS = 1_000;
export const MAX_PTY_ROWS = 1_000;
export const MAX_CLIPBOARD_TEXT_LENGTH = 200_000;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  field: string,
  max: number,
  options: { readonly allowEmpty?: boolean } = {},
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string.` };
  }
  if (!options.allowEmpty && value.length === 0) {
    return { ok: false, error: `${field} must not be empty.` };
  }
  if (value.length > max) {
    return { ok: false, error: `${field} exceeds the ${max} character limit.` };
  }
  return { ok: true, value };
}

export type WebviewInboundMessage =
  | { readonly type: 'ready'; readonly cols?: number; readonly rows?: number }
  | { readonly type: 'attach'; readonly cols?: number; readonly rows?: number }
  | { readonly type: 'start' }
  | { readonly type: 'restart' }
  | { readonly type: 'focusTerminal' }
  | { readonly type: 'chooseWorkspace' }
  | { readonly type: 'pickFiles' }
  | { readonly type: 'addActiveSelection' }
  | { readonly type: 'clear' }
  | { readonly type: 'copyClipboard'; readonly text: string }
  | {
      readonly type: 'ptyInput';
      readonly sessionId: string;
      readonly data: string;
    }
  | {
      readonly type: 'ptyResize';
      readonly sessionId: string;
      readonly cols: number;
      readonly rows: number;
    }
  | {
      readonly type: 'drop';
      readonly uriList?: string;
      readonly codeUriList?: string;
      readonly resourceUrls?: string;
      readonly codeFiles?: string;
      readonly codeEditors?: string;
      readonly plainText?: string;
    }
  | {
      readonly type: 'insert' | 'copy' | 'remove';
      readonly ids: readonly string[];
    };

export type WebviewMessageResult =
  | { readonly ok: true; readonly message: WebviewInboundMessage }
  | { readonly ok: false; readonly error: string };

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function parseSessionId(
  value: unknown,
): { readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly error: string } {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH || !SAFE_ID.test(value)) {
    return { ok: false, error: 'sessionId is invalid.' };
  }
  return { ok: true, sessionId: value };
}

function parseIds(value: unknown): { readonly ok: true; readonly ids: string[] } | { readonly ok: false; readonly error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'ids must be an array.' };
  }
  if (value.length === 0) {
    return { ok: false, error: 'ids must not be empty.' };
  }
  if (value.length > MAX_WEBVIEW_IDS) {
    return { ok: false, error: `ids must contain at most ${MAX_WEBVIEW_IDS} entries.` };
  }

  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > MAX_ID_LENGTH || !SAFE_ID.test(item)) {
      return { ok: false, error: 'ids contain an invalid reference id.' };
    }
    ids.push(item);
  }
  return { ok: true, ids };
}

/**
 * Validates a message posted by the webview. The webview is treated as an
 * untrusted boundary: unknown types, oversized strings and malformed ids are
 * rejected before the extension touches any state.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessageResult {
  if (!isRecord(raw)) {
    return { ok: false, error: 'Message must be an object.' };
  }

  const type = raw.type;
  if (typeof type !== 'string') {
    return { ok: false, error: 'Message type must be a string.' };
  }

  switch (type) {
    case 'start':
    case 'restart':
    case 'focusTerminal':
    case 'chooseWorkspace':
    case 'pickFiles':
    case 'addActiveSelection':
    case 'clear':
      return { ok: true, message: { type } };

    case 'ready':
    case 'attach': {
      if (
        (raw.cols !== undefined &&
          !boundedInteger(raw.cols, 1, MAX_PTY_COLS)) ||
        (raw.rows !== undefined && !boundedInteger(raw.rows, 1, MAX_PTY_ROWS))
      ) {
        return { ok: false, error: 'terminal dimensions are outside the supported bounds.' };
      }
      return {
        ok: true,
        message: {
          type: type as 'ready' | 'attach',
          ...(raw.cols === undefined ? {} : { cols: raw.cols }),
          ...(raw.rows === undefined ? {} : { rows: raw.rows }),
        },
      };
    }

    case 'copyClipboard': {
      const text = raw.text;
      if (typeof text !== 'string') {
        return { ok: false, error: 'text must be a string.' };
      }
      if (text.length > MAX_CLIPBOARD_TEXT_LENGTH) {
        return {
          ok: false,
          error: `text exceeds the ${MAX_CLIPBOARD_TEXT_LENGTH} character limit.`,
        };
      }
      return { ok: true, message: { type: 'copyClipboard', text } };
    }

    case 'ptyInput': {
      const session = parseSessionId(raw.sessionId);
      if (!session.ok) {
        return { ok: false, error: session.error };
      }
      // Do not trim or filter: Ctrl+C, ESC and arrow-key sequences are valid.
      if (typeof raw.data !== 'string' || raw.data.length === 0) {
        return { ok: false, error: 'PTY input must be a non-empty string.' };
      }
      if (raw.data.length > MAX_PTY_INPUT_LENGTH) {
        return {
          ok: false,
          error: `PTY input exceeds the ${MAX_PTY_INPUT_LENGTH} character limit.`,
        };
      }
      return {
        ok: true,
        message: { type: 'ptyInput', sessionId: session.sessionId, data: raw.data },
      };
    }

    case 'ptyResize': {
      const session = parseSessionId(raw.sessionId);
      if (!session.ok) {
        return { ok: false, error: session.error };
      }
      if (
        !boundedInteger(raw.cols, 1, MAX_PTY_COLS) ||
        !boundedInteger(raw.rows, 1, MAX_PTY_ROWS)
      ) {
        return { ok: false, error: 'PTY resize dimensions are outside the supported bounds.' };
      }
      return {
        ok: true,
        message: {
          type: 'ptyResize',
          sessionId: session.sessionId,
          cols: raw.cols,
          rows: raw.rows,
        },
      };
    }

    case 'insert':
    case 'copy':
    case 'remove': {
      const ids = parseIds(raw.ids);
      return ids.ok
        ? { ok: true, message: { type, ids: ids.ids } }
        : { ok: false, error: ids.error };
    }

    case 'drop': {
      const fields = {
        uriList: raw.uriList,
        codeUriList: raw.codeUriList,
        resourceUrls: raw.resourceUrls,
        codeFiles: raw.codeFiles,
        codeEditors: raw.codeEditors,
        plainText: raw.plainText,
      } as const;

      const message: {
        type: 'drop';
        uriList?: string;
        codeUriList?: string;
        resourceUrls?: string;
        codeFiles?: string;
        codeEditors?: string;
        plainText?: string;
      } = { type: 'drop' };
      let total = 0;

      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) {
          continue;
        }
        const checked = boundedString(value, key, MAX_DROP_FIELD_LENGTH, {
          allowEmpty: true,
        });
        if (!checked.ok) {
          return { ok: false, error: checked.error };
        }
        total += checked.value.length;
        if (total > MAX_TOTAL_MESSAGE_LENGTH) {
          return { ok: false, error: 'Drop payload is too large.' };
        }
        message[key as 'uriList'] = checked.value;
      }

      return { ok: true, message };
    }

    default:
      return { ok: false, error: 'Unsupported message type.' };
  }
}

export type LaunchCommandResult =
  | { readonly ok: true; readonly command: string }
  | { readonly ok: false; readonly message: string };

/**
 * The setting is a shell command by design (documented as such and restricted
 * to machine scope). Newlines and control characters are rejected so a
 * workspace cannot inject a second command or terminal escape sequence.
 */
export function validateLaunchCommand(value: unknown): LaunchCommandResult {
  if (typeof value !== 'string') {
    return { ok: false, message: 'OpenCode launch command must be a string.' };
  }
  const command = value.trim();
  if (command.length === 0) {
    return { ok: false, message: 'OpenCode launch command must not be empty.' };
  }
  if (command.length > MAX_LAUNCH_COMMAND_LENGTH) {
    return {
      ok: false,
      message: `OpenCode launch command exceeds ${MAX_LAUNCH_COMMAND_LENGTH} characters.`,
    };
  }
  if (CONTROL_CHARACTERS.test(command)) {
    return {
      ok: false,
      message:
        'OpenCode launch command contains control characters or newlines. ' +
        'Use a single command line without line breaks.',
    };
  }
  return { ok: true, command };
}

/** Minimal map keyed by a workspace folder URI, used to reuse terminals. */
export class TerminalRegistry<T> {
  private readonly terminals = new Map<string, T>();

  acquire(
    key: string,
    create: () => T,
    isUsable: (terminal: T) => boolean,
  ): { readonly terminal: T; readonly created: boolean } {
    const existing = this.terminals.get(key);
    if (existing !== undefined && isUsable(existing)) {
      return { terminal: existing, created: false };
    }

    if (existing !== undefined) {
      this.terminals.delete(key);
    }
    const terminal = create();
    this.terminals.set(key, terminal);
    return { terminal, created: true };
  }

  get(key: string): T | undefined {
    return this.terminals.get(key);
  }

  /** Adopts an already-running terminal, e.g. one recovered after a reload. */
  adopt(key: string, terminal: T): void {
    this.terminals.set(key, terminal);
  }

  remove(key: string): T | undefined {
    const terminal = this.terminals.get(key);
    if (terminal !== undefined) {
      this.terminals.delete(key);
    }
    return terminal;
  }

  removeValue(value: T): string | undefined {
    for (const [key, terminal] of this.terminals) {
      if (terminal === value) {
        this.terminals.delete(key);
        return key;
      }
    }
    return undefined;
  }

  keys(): readonly string[] {
    return [...this.terminals.keys()];
  }

  get size(): number {
    return this.terminals.size;
  }
}

export interface StoredReference {
  readonly id: string;
  /** Absolute path of the referenced file. */
  readonly filePath: string;
  /** Absolute workspace root used to build a relative mention. */
  readonly rootPath: string;
  readonly folderKey: string;
  readonly folderName: string;
  readonly range?: TextRange;
  readonly outsideWorkspace: boolean;
  readonly addedAt: number;
}

export type AppendReferenceResult =
  | { readonly added: true; readonly references: readonly StoredReference[] }
  | {
      readonly added: false;
      readonly references: readonly StoredReference[];
      readonly reason: 'invalid' | 'duplicate' | 'limit';
    };

/** Re-formats a stored reference through the core validator. */
export function referenceMention(reference: StoredReference): string | undefined {
  const result = formatMention(reference.filePath, reference.rootPath, reference.range);
  return result.ok ? result.mention : undefined;
}

export function appendReference(
  references: readonly StoredReference[],
  reference: StoredReference,
  max = MAX_ATTACHMENTS,
): AppendReferenceResult {
  const mention = referenceMention(reference);
  if (mention === undefined) {
    return { added: false, references, reason: 'invalid' };
  }

  const duplicate = references.some(
    (existing) =>
      existing.folderKey === reference.folderKey &&
      referenceMention(existing) === mention,
  );
  if (duplicate) {
    return { added: false, references, reason: 'duplicate' };
  }
  if (references.length >= max) {
    return { added: false, references, reason: 'limit' };
  }

  return { added: true, references: [...references, reference] };
}

export function removeReferences(
  references: readonly StoredReference[],
  ids: readonly string[],
): readonly StoredReference[] {
  const remove = new Set(ids);
  return references.filter((reference) => !remove.has(reference.id));
}

export function pickReferences(
  references: readonly StoredReference[],
  ids: readonly string[],
): readonly StoredReference[] {
  const wanted = new Set(ids);
  return references.filter((reference) => wanted.has(reference.id));
}

function parseStoredRange(value: unknown): TextRange | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  const start = value.start;
  const end = value.end;
  if (!isRecord(start) || !isRecord(end)) {
    return null;
  }
  const values = [start.line, start.character, end.line, end.character];
  if (!values.every((item) => Number.isSafeInteger(item) && (item as number) >= 0)) {
    return null;
  }
  return {
    start: { line: start.line as number, character: start.character as number },
    end: { line: end.line as number, character: end.character as number },
  };
}

/**
 * Rehydrates references from extension state. Every entry is validated through
 * `formatMention` again; malformed or unsafe entries are dropped silently.
 */
export function restoreReferences(value: unknown): readonly StoredReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const restored: StoredReference[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = entry.id;
    const filePath = entry.filePath;
    const rootPath = entry.rootPath;
    const folderKey = entry.folderKey;
    const folderName = entry.folderName;
    const outsideWorkspace = entry.outsideWorkspace;
    const addedAt = entry.addedAt;

    if (
      typeof id !== 'string' ||
      !SAFE_ID.test(id) ||
      typeof filePath !== 'string' ||
      typeof rootPath !== 'string' ||
      typeof folderKey !== 'string' ||
      folderKey.length === 0 ||
      typeof folderName !== 'string' ||
      typeof outsideWorkspace !== 'boolean' ||
      !Number.isSafeInteger(addedAt)
    ) {
      continue;
    }

    const range = parseStoredRange(entry.range);
    if (range === null) {
      continue;
    }

    const reference: StoredReference = {
      id,
      filePath,
      rootPath,
      folderKey,
      folderName,
      outsideWorkspace,
      addedAt: addedAt as number,
      ...(range === undefined ? {} : { range }),
    };
    if (referenceMention(reference) === undefined) {
      continue;
    }

    const appended = appendReference(restored, reference);
    if (appended.added) {
      restored.push(reference);
    }
  }

  return restored;
}

export interface SelectionSnapshot {
  /** `TextDocument.uri.toString()` of the editor. */
  readonly uri: string;
  /** Exact selected text; never sent to the terminal directly. */
  readonly text: string;
  readonly range: TextRange;
  readonly capturedAt: number;
}

export type SelectionMatchReason =
  | 'empty'
  | 'too-long'
  | 'no-match'
  | 'expired'
  | 'ambiguous';

export type SelectionMatch =
  | { readonly ok: true; readonly entry: SelectionSnapshot }
  | { readonly ok: false; readonly reason: SelectionMatchReason };

function samePosition(
  a: { readonly line: number; readonly character: number },
  b: { readonly line: number; readonly character: number },
): boolean {
  return a.line === b.line && a.character === b.character;
}

function sameRange(a: TextRange, b: TextRange): boolean {
  return samePosition(a.start, b.start) && samePosition(a.end, b.end);
}

/**
 * Records a non-empty selection and expires old entries. Duplicate snapshots
 * of the same URI/range/text collapse so an unambiguous match stays possible.
 */
export function recordSelection(
  entries: readonly SelectionSnapshot[],
  snapshot: SelectionSnapshot,
  now: number,
  ttl = SELECTION_TTL_MS,
  max = MAX_SELECTION_CACHE,
): readonly SelectionSnapshot[] {
  if (
    snapshot.text.length === 0 ||
    snapshot.text.length > MAX_SELECTION_TEXT_LENGTH ||
    snapshot.uri.length === 0
  ) {
    return entries;
  }

  const fresh = entries.filter(
    (entry) => now - entry.capturedAt >= 0 && now - entry.capturedAt <= ttl,
  );
  const withoutSame = fresh.filter(
    (entry) =>
      !(
        entry.uri === snapshot.uri &&
        entry.text === snapshot.text &&
        sameRange(entry.range, snapshot.range)
      ),
  );
  const next = [...withoutSame, snapshot];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Drops every cached selection for one document. Called when the document text
 * changes so a stale line range can never be reused.
 */
export function invalidateSelectionCache(
  entries: readonly SelectionSnapshot[],
  uri: string,
): readonly SelectionSnapshot[] {
  return entries.filter((entry) => entry.uri !== uri);
}

/**
 * Matches dropped plain text against the short-lived selection cache.
 *
 * A code mention is only produced when exactly one distinct URI/range matches.
 * Ambiguous, expired and missing matches deliberately produce no range: the
 * caller must never guess.
 */
export function matchSelection(
  entries: readonly SelectionSnapshot[],
  text: string,
  now: number,
  ttl = SELECTION_TTL_MS,
  uri?: string,
): SelectionMatch {
  if (text.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (text.length > MAX_SELECTION_TEXT_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }

  const candidates = entries.filter(
    (entry) => entry.text === text && (uri === undefined || entry.uri === uri),
  );
  if (candidates.length === 0) {
    return { ok: false, reason: 'no-match' };
  }

  const fresh = candidates.filter(
    (entry) => now - entry.capturedAt >= 0 && now - entry.capturedAt <= ttl,
  );
  if (fresh.length === 0) {
    return { ok: false, reason: 'expired' };
  }

  const distinct: SelectionSnapshot[] = [];
  for (const entry of fresh) {
    if (
      !distinct.some(
        (existing) => existing.uri === entry.uri && sameRange(existing.range, entry.range),
      )
    ) {
      distinct.push(entry);
    }
  }

  if (distinct.length > 1) {
    return { ok: false, reason: 'ambiguous' };
  }
  return { ok: true, entry: distinct[0] };
}

export type TerminalStatusKind =
  | 'no-workspace'
  | 'untrusted'
  | 'idle'
  | 'created'
  | 'closed';

export function terminalStatusText(
  kind: TerminalStatusKind,
  folderName?: string,
): string {
  const suffix = folderName === undefined ? '' : `（${folderName}）`;
  switch (kind) {
    case 'no-workspace':
      return '未打开工作区。请先打开一个文件夹，再启动 OpenCode。';
    case 'untrusted':
      return '当前工作区处于限制模式（Workspace Trust 未启用），已禁止启动 OpenCode。';
    case 'idle':
      return folderName === undefined
        ? '尚未创建 OpenCode 终端。请选择工作区并点击“启动 OpenCode”。'
        : `尚未创建 OpenCode 终端${suffix}。点击“启动 OpenCode”会在该工作区运行配置的命令。`;
    case 'created':
      return folderName === undefined
        ? '终端已创建，请确认 OpenCode 已就绪（扩展不会验证 CLI 是否运行）。'
        : `已创建${suffix}终端，请确认 OpenCode 已就绪（扩展不会验证 CLI 是否运行）。`;
    case 'closed':
      return folderName === undefined
        ? '终端已关闭。引用仍保留，可重新启动后插入。'
        : `${folderName} 的终端已关闭。引用仍保留，可重新启动后插入。`;
  }
}

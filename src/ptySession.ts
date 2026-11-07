/**
 * Pure, injectable PTY session management for the embedded terminal.
 *
 * This module imports neither `vscode` nor `node-pty`. The runtime passes a
 * `spawn` implementation (usually a thin wrapper around `node-pty.spawn`) and
 * forwards PTY output to the webview.
 *
 * Design notes:
 * - One active shell per workspace key.
 * - The configured launch command is written exactly once, followed by `\r`.
 * - Input keeps terminal control bytes (Ctrl+C, escape sequences, arrow keys);
 *   only type, emptiness, size and session ownership are validated.
 * - Resize dimensions are bounded before touching the PTY.
 * - Output is kept in a bounded raw buffer. It is raw ANSI text, so a
 *   truncated buffer may start in the middle of an escape sequence or a
 *   multi-byte grapheme. The webview should treat the backlog as best-effort
 *   screen recovery, not as a lossless transcript.
 * - Every emitted event carries a monotonically increasing session sequence.
 *   A consumer that observes a gap can request `snapshot()` instead of assuming
 *   it saw every chunk.
 */

export const DEFAULT_MAX_OUTPUT_BUFFER = 200_000;
export const DEFAULT_MAX_INPUT_LENGTH = 100_000;
export const DEFAULT_MAX_COLS = 1_000;
export const DEFAULT_MAX_ROWS = 1_000;
export const MIN_COLS = 1;
export const MIN_ROWS = 1;

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface PtyDisposable {
  dispose(): void;
}

export interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number;
}

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable;
}

export interface PtySpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly cols: number;
  readonly rows: number;
}

export type PtySpawn = (
  shellPath: string,
  args: string | string[],
  options: PtySpawnOptions,
) => PtyProcess;

export interface PtyLaunchConfig {
  readonly shellPath: string;
  readonly args?: string | string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Fixed workspace directory. */
  readonly cwd: string;
  /** Written once as `launchCommand + '\r'`; omitted/empty means no write. */
  readonly launchCommand?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export interface PtySnapshot {
  readonly sessionId: string;
  /** Last emitted event sequence for this session. */
  readonly sequence: number;
  /** Bounded raw ANSI output, oldest bytes dropped first. */
  readonly backlog: string;
  readonly truncated: boolean;
}

export type PtyEvent =
  | {
      readonly type: 'data';
      readonly workspaceKey: string;
      readonly sessionId: string;
      readonly sequence: number;
      readonly data: string;
    }
  | {
      readonly type: 'exit';
      readonly workspaceKey: string;
      readonly sessionId: string;
      readonly sequence: number;
      readonly exitCode: number;
      readonly signal?: number;
    };

export type PtyClientMessage =
  | {
      readonly type: 'input';
      readonly sessionId: string;
      readonly data: string;
    }
  | {
      readonly type: 'resize';
      readonly sessionId: string;
      readonly cols: number;
      readonly rows: number;
    };

export type PtyMessageErrorCode =
  | 'invalid-message'
  | 'invalid-session'
  | 'invalid-input'
  | 'invalid-resize';

export type PtyMessageResult =
  | { readonly ok: true; readonly message: PtyClientMessage }
  | { readonly ok: false; readonly code: PtyMessageErrorCode; readonly message: string };

export type PtyErrorCode =
  | 'disposed'
  | 'invalid-arguments'
  | 'invalid-message'
  | 'invalid-input'
  | 'invalid-resize'
  | 'stale-session'
  | 'inactive'
  | 'spawn-failed'
  | 'launch-write-failed'
  | 'write-failed'
  | 'resize-failed';

export type PtyOperationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PtyErrorCode; readonly message: string };

export interface PtyEnsureResult {
  readonly ok: true;
  readonly created: boolean;
  readonly session: PtySnapshot;
}

export type PtyEnsureOutcome =
  | PtyEnsureResult
  | { readonly ok: false; readonly code: PtyErrorCode | 'invalid-arguments'; readonly message: string };

export interface PtySessionManagerOptions {
  readonly maxOutputBuffer?: number;
  readonly maxInputLength?: number;
  readonly maxCols?: number;
  readonly maxRows?: number;
  /** Injectable for deterministic tests; must satisfy the session id format. */
  readonly createSessionId?: () => string;
}

interface ActiveSession {
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly process: PtyProcess;
  buffer: string;
  truncated: boolean;
  sequence: number;
  exited: boolean;
  dataSubscription?: PtyDisposable;
  exitSubscription?: PtyDisposable;
}

let sessionCounter = 0;

function defaultSessionId(): string {
  sessionCounter += 1;
  return `pty-${sessionCounter}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validWorkspaceKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

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

/** Validates an input/resize message from the untrusted webview. */
export function parsePtyClientMessage(
  raw: unknown,
  maxInputLength = DEFAULT_MAX_INPUT_LENGTH,
  maxCols = DEFAULT_MAX_COLS,
  maxRows = DEFAULT_MAX_ROWS,
): PtyMessageResult {
  if (!isRecord(raw)) {
    return { ok: false, code: 'invalid-message', message: 'Message must be an object.' };
  }

  const type = raw.type;
  if (type !== 'input' && type !== 'resize') {
    return {
      ok: false,
      code: 'invalid-message',
      message: 'Message type must be "input" or "resize".',
    };
  }

  if (!validSessionId(raw.sessionId)) {
    return { ok: false, code: 'invalid-session', message: 'Invalid PTY session id.' };
  }

  if (type === 'input') {
    if (typeof raw.data !== 'string' || raw.data.length === 0) {
      return {
        ok: false,
        code: 'invalid-input',
        message: 'PTY input must be a non-empty string.',
      };
    }
    if (raw.data.length > maxInputLength) {
      return {
        ok: false,
        code: 'invalid-input',
        message: `PTY input exceeds the ${maxInputLength} character limit.`,
      };
    }
    // Input is intentionally not trimmed or filtered: control bytes such as
    // Ctrl+C, escape sequences and arrow keys are valid terminal input.
    return {
      ok: true,
      message: { type: 'input', sessionId: raw.sessionId, data: raw.data },
    };
  }

  if (!boundedInteger(raw.cols, MIN_COLS, maxCols) || !boundedInteger(raw.rows, MIN_ROWS, maxRows)) {
    return {
      ok: false,
      code: 'invalid-resize',
      message: `PTY resize requires integer cols in ${MIN_COLS}..${maxCols} and rows in ${MIN_ROWS}..${maxRows}.`,
    };
  }

  return {
    ok: true,
    message: {
      type: 'resize',
      sessionId: raw.sessionId,
      cols: raw.cols,
      rows: raw.rows,
    },
  };
}

function operationError(code: PtyErrorCode, message: string): PtyOperationResult {
  return { ok: false, code, message };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return 'Unknown error.';
}

/**
 * Owns active shells keyed by workspace folder URI. A webview must present both
 * the workspace key and the session id; a mismatch is rejected so input from a
 * stale webview can never reach a newer shell.
 */
export class PtySessionManager {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly listeners = new Set<(event: PtyEvent) => void>();
  private readonly maxOutputBuffer: number;
  private readonly maxInputLength: number;
  private readonly maxCols: number;
  private readonly maxRows: number;
  private readonly createSessionId: () => string;
  private disposed = false;

  constructor(
    private readonly spawn: PtySpawn,
    options: PtySessionManagerOptions = {},
  ) {
    this.maxOutputBuffer = options.maxOutputBuffer ?? DEFAULT_MAX_OUTPUT_BUFFER;
    this.maxInputLength = options.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH;
    this.maxCols = options.maxCols ?? DEFAULT_MAX_COLS;
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    this.createSessionId = options.createSessionId ?? defaultSessionId;
  }

  /**
   * Returns the active session for a workspace or spawns a new one. The launch
   * command is written only for a newly spawned process.
   */
  ensure(workspaceKey: string, config: PtyLaunchConfig): PtyEnsureOutcome {
    if (this.disposed) {
      return { ok: false, code: 'disposed', message: 'PTY session manager has been disposed.' };
    }
    if (!validWorkspaceKey(workspaceKey)) {
      return { ok: false, code: 'invalid-arguments', message: 'Invalid workspace key.' };
    }
    if (
      typeof config.shellPath !== 'string' ||
      config.shellPath.length === 0 ||
      typeof config.cwd !== 'string' ||
      config.cwd.length === 0
    ) {
      return {
        ok: false,
        code: 'invalid-arguments',
        message: 'A shell path and working directory are required.',
      };
    }

    const existing = this.sessions.get(workspaceKey);
    if (existing !== undefined && !existing.exited) {
      return { ok: true, created: false, session: this.snapshotSession(existing) };
    }
    if (existing !== undefined) {
      this.removeSession(existing);
      safeKill(existing.process);
    }

    const cols = config.cols ?? 80;
    const rows = config.rows ?? 24;
    if (!boundedInteger(cols, MIN_COLS, this.maxCols) || !boundedInteger(rows, MIN_ROWS, this.maxRows)) {
      return {
        ok: false,
        code: 'invalid-arguments',
        message: 'Initial PTY size is outside the supported bounds.',
      };
    }

    const launchCommand = config.launchCommand;
    if (launchCommand !== undefined && typeof launchCommand !== 'string') {
      return { ok: false, code: 'invalid-arguments', message: 'Launch command must be a string.' };
    }
    if (launchCommand !== undefined && launchCommand.length > 0) {
      if (launchCommand.length > 10_000 || /[\r\n\u0000]/.test(launchCommand)) {
        return {
          ok: false,
          code: 'invalid-arguments',
          message: 'Launch command must be a single line without control characters.',
        };
      }
    }

    const args = normalizeArgs(config.args);
    if (args === undefined) {
      return {
        ok: false,
        code: 'invalid-arguments',
        message: 'PTY arguments must be a string or an array of strings.',
      };
    }

    const env: Record<string, string> = {};
    if (config.env !== undefined) {
      if (!isRecord(config.env)) {
        return { ok: false, code: 'invalid-arguments', message: 'PTY environment must be an object.' };
      }
      for (const [key, value] of Object.entries(config.env)) {
        if (typeof value !== 'string') {
          return {
            ok: false,
            code: 'invalid-arguments',
            message: 'PTY environment values must be strings.',
          };
        }
        env[key] = value;
      }
    }

    let process: PtyProcess;
    try {
      process = this.spawn(config.shellPath, args, {
        cwd: config.cwd,
        env,
        cols,
        rows,
      });
    } catch (error) {
      return {
        ok: false,
        code: 'spawn-failed',
        message: `Failed to spawn the shell: ${errorMessage(error)}`,
      };
    }

    const session: ActiveSession = {
      workspaceKey,
      sessionId: this.createSessionId(),
      process,
      buffer: '',
      truncated: false,
      sequence: 0,
      exited: false,
    };

    try {
      session.dataSubscription = process.onData((data) => {
        this.handleData(session, data);
      });
      session.exitSubscription = process.onExit((event) => {
        this.handleExit(session, event);
      });
    } catch (error) {
      this.discardSession(session);
      return {
        ok: false,
        code: 'spawn-failed',
        message: `Failed to attach to the shell process: ${errorMessage(error)}`,
      };
    }

    if (session.exited) {
      this.discardSession(session);
      return {
        ok: false,
        code: 'spawn-failed',
        message: 'The shell process exited before it could be used.',
      };
    }

    this.sessions.set(workspaceKey, session);

    if (launchCommand !== undefined && launchCommand.length > 0) {
      try {
        process.write(`${launchCommand}\r`);
      } catch (error) {
        this.removeSession(session);
        safeKill(process);
        return {
          ok: false,
          code: 'launch-write-failed',
          message: `Failed to write the launch command: ${errorMessage(error)}`,
        };
      }
    }

    return { ok: true, created: true, session: this.snapshotSession(session) };
  }

  /** Returns a copy of the current backlog and sequence for recovery. */
  snapshot(workspaceKey: string): PtySnapshot | undefined {
    const session = this.sessions.get(workspaceKey);
    return session === undefined ? undefined : this.snapshotSession(session);
  }

  getSessionId(workspaceKey: string): string | undefined {
    return this.sessions.get(workspaceKey)?.sessionId;
  }

  /**
   * Stops the shell for a workspace. The exit event is intentionally not
   * emitted: callers use this for an explicit restart and immediately obtain a
   * new snapshot for the replacement session.
   */
  stop(workspaceKey: string): boolean {
    const session = this.sessions.get(workspaceKey);
    if (session === undefined) {
      return false;
    }
    this.removeSession(session);
    safeKill(session.process);
    return true;
  }

  isActive(workspaceKey: string, sessionId: string): boolean {
    const session = this.sessions.get(workspaceKey);
    return (
      session !== undefined &&
      !session.exited &&
      session.sessionId === sessionId
    );
  }

  /** Sends validated input only to the current, matching session. */
  sendInput(workspaceKey: string, sessionId: string, data: string): PtyOperationResult {
    if (this.disposed) {
      return operationError('disposed', 'PTY session manager has been disposed.');
    }
    if (typeof data !== 'string' || data.length === 0) {
      return operationError('invalid-input', 'PTY input must be a non-empty string.');
    }
    if (data.length > this.maxInputLength) {
      return operationError(
        'invalid-input',
        `PTY input exceeds the ${this.maxInputLength} character limit.`,
      );
    }

    const session = this.sessions.get(workspaceKey);
    if (session === undefined || session.exited) {
      return operationError('inactive', 'No active PTY session for this workspace.');
    }
    if (session.sessionId !== sessionId) {
      return operationError('stale-session', 'The PTY session id is no longer active.');
    }

    try {
      session.process.write(data);
      return { ok: true };
    } catch (error) {
      return operationError('write-failed', `Failed to write PTY input: ${errorMessage(error)}`);
    }
  }

  /** Resizes the current session after bounding the dimensions. */
  resize(workspaceKey: string, sessionId: string, cols: number, rows: number): PtyOperationResult {
    if (this.disposed) {
      return operationError('disposed', 'PTY session manager has been disposed.');
    }
    if (!boundedInteger(cols, MIN_COLS, this.maxCols) || !boundedInteger(rows, MIN_ROWS, this.maxRows)) {
      return operationError(
        'invalid-resize',
        `PTY resize requires integer cols in ${MIN_COLS}..${this.maxCols} and rows in ${MIN_ROWS}..${this.maxRows}.`,
      );
    }

    const session = this.sessions.get(workspaceKey);
    if (session === undefined || session.exited) {
      return operationError('inactive', 'No active PTY session for this workspace.');
    }
    if (session.sessionId !== sessionId) {
      return operationError('stale-session', 'The PTY session id is no longer active.');
    }

    try {
      session.process.resize(cols, rows);
      return { ok: true };
    } catch (error) {
      return operationError('resize-failed', `Failed to resize the PTY: ${errorMessage(error)}`);
    }
  }

  /** Parses then routes a webview input/resize message. */
  handleMessage(workspaceKey: string, raw: unknown): PtyOperationResult {
    const parsed = parsePtyClientMessage(
      raw,
      this.maxInputLength,
      this.maxCols,
      this.maxRows,
    );
    if (!parsed.ok) {
      return operationError(
        parsed.code === 'invalid-resize'
          ? 'invalid-resize'
          : parsed.code === 'invalid-session'
            ? 'stale-session'
            : parsed.code === 'invalid-message'
              ? 'invalid-message'
              : 'invalid-input',
        parsed.message,
      );
    }

    return parsed.message.type === 'input'
      ? this.sendInput(workspaceKey, parsed.message.sessionId, parsed.message.data)
      : this.resize(
          workspaceKey,
          parsed.message.sessionId,
          parsed.message.cols,
          parsed.message.rows,
        );
  }

  subscribe(listener: (event: PtyEvent) => void): PtyDisposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const session of [...this.sessions.values()]) {
      this.removeSession(session);
      safeKill(session.process);
    }
    this.sessions.clear();
    this.listeners.clear();
  }

  get size(): number {
    return this.sessions.size;
  }

  private snapshotSession(session: ActiveSession): PtySnapshot {
    return {
      sessionId: session.sessionId,
      sequence: session.sequence,
      backlog: session.buffer,
      truncated: session.truncated,
    };
  }

  private handleData(session: ActiveSession, data: string): void {
    if (session.exited || this.disposed || typeof data !== 'string' || data.length === 0) {
      return;
    }

    session.buffer += data;
    if (session.buffer.length > this.maxOutputBuffer) {
      session.buffer = session.buffer.slice(session.buffer.length - this.maxOutputBuffer);
      session.truncated = true;
    }

    session.sequence += 1;
    this.emit({
      type: 'data',
      workspaceKey: session.workspaceKey,
      sessionId: session.sessionId,
      sequence: session.sequence,
      data,
    });
  }

  private handleExit(session: ActiveSession, event: PtyExitEvent): void {
    if (session.exited) {
      return;
    }
    session.exited = true;

    const current = this.sessions.get(session.workspaceKey);
    if (current === session) {
      this.sessions.delete(session.workspaceKey);
    }
    this.disposeSubscriptions(session);

    if (this.disposed) {
      return;
    }

    session.sequence += 1;
    this.emit({
      type: 'exit',
      workspaceKey: session.workspaceKey,
      sessionId: session.sessionId,
      sequence: session.sequence,
      exitCode: event.exitCode,
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    });
  }

  private removeSession(session: ActiveSession): void {
    const current = this.sessions.get(session.workspaceKey);
    if (current === session) {
      this.sessions.delete(session.workspaceKey);
    }
    session.exited = true;
    this.disposeSubscriptions(session);
  }

  private discardSession(session: ActiveSession): void {
    session.exited = true;
    this.disposeSubscriptions(session);
    safeKill(session.process);
  }

  private disposeSubscriptions(session: ActiveSession): void {
    session.dataSubscription?.dispose();
    session.exitSubscription?.dispose();
    session.dataSubscription = undefined;
    session.exitSubscription = undefined;
  }

  private emit(event: PtyEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One misbehaving consumer must not stop other subscribers or the PTY.
      }
    }
  }
}

function normalizeArgs(value: string | string[] | undefined): string | string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return undefined;
    }
  }
  return [...value];
}

function safeKill(process: PtyProcess): void {
  try {
    process.kill();
  } catch {
    // The process may already have exited.
  }
}

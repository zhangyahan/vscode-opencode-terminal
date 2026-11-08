/**
 * Small, DOM-free interaction helpers shared by the webview bundle and Node
 * tests. This module must not import xterm or touch browser globals: the
 * extension's `tsconfig.json` compiles it for Node, while
 * `tsconfig.webview.json` type-checks it together with the webview entry.
 */

/** Debounce used before fitting xterm after a size/font/theme change. */
export const FIT_DEBOUNCE_MS = 175;

/** OpenCode's default newline binding is Ctrl+J, which sends a bare LF. */
export const NEWLINE_INPUT = '\n';

export interface TerminalKeyEventLike {
  readonly type?: string;
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

export type TerminalKeyDecision =
  | { readonly action: 'pass' }
  | { readonly action: 'consume' }
  | { readonly action: 'input'; readonly data: string }
  | { readonly action: 'copy' }
  | { readonly action: 'native-paste' };

export interface TerminalKeyOptions {
  readonly hasSelection: boolean;
}

export type TerminalKeyMessage = {
  readonly type: 'copyClipboard';
  readonly text: string;
};

/**
 * Browser-side effects injected by the webview. Tests use the same helper with
 * recording fakes, so key handling and its side effects cannot drift apart.
 */
export interface TerminalKeyEffects {
  readonly hasSelection: () => boolean;
  readonly getSelection: () => string;
  readonly input: (data: string) => void;
  readonly post: (message: TerminalKeyMessage) => void;
  readonly preventDefault: () => void;
}

/**
 * IME composition must win over every custom binding. Enter during candidate
 * selection must reach the IME instead of submitting the prompt.
 */
export function isImeCompositionEvent(event: TerminalKeyEventLike): boolean {
  return (
    event.isComposing === true ||
    event.keyCode === 229 ||
    event.key === 'Process'
  );
}

function isShiftOnly(event: TerminalKeyEventLike): boolean {
  return (
    event.shiftKey === true &&
    event.ctrlKey !== true &&
    event.altKey !== true &&
    event.metaKey !== true
  );
}

function isEnter(event: TerminalKeyEventLike): boolean {
  return event.key === 'Enter';
}

/**
 * Decide what the webview should do with an xterm custom key handler event.
 *
 * - Shift+Enter (without Ctrl/Alt/Meta) is the only binding we translate: the
 *   caller sends exactly one LF through `terminal.input('\n')`.
 * - Plain Enter and every other key pass through so xterm can send CR,
 *   Ctrl+C keeps its selection-copy semantics.
 * - Ctrl/Cmd+V is blocked from xterm's raw Ctrl+V (`\x16`) path, but never
 *   reads the clipboard from the extension host. The browser's native paste
 *   event remains the single owner and delivers data through `terminal.onData`.
 * - `keypress` for Shift+Enter is consumed as well, but never produces a
 *   second LF, so a browser that still emits it cannot duplicate the newline.
 */
export function decideTerminalKey(
  event: TerminalKeyEventLike,
  options: TerminalKeyOptions,
): TerminalKeyDecision {
  if (event.type !== undefined && event.type !== 'keydown') {
    if (
      event.type === 'keypress' &&
      isEnter(event) &&
      isShiftOnly(event) &&
      !isImeCompositionEvent(event)
    ) {
      return { action: 'consume' };
    }
    return { action: 'pass' };
  }

  if (isImeCompositionEvent(event)) {
    return { action: 'pass' };
  }

  if (isEnter(event) && isShiftOnly(event)) {
    return { action: 'input', data: NEWLINE_INPUT };
  }

  const ctrl = event.ctrlKey === true || event.metaKey === true;
  if (!ctrl) {
    return { action: 'pass' };
  }

  const key = event.key.toLowerCase();
  if (key === 'c') {
    if (options.hasSelection) {
      return { action: 'copy' };
    }
    return event.shiftKey === true
      ? { action: 'consume' }
      : { action: 'pass' };
  }

  if (key === 'v' && event.shiftKey !== true) {
    return { action: 'native-paste' };
  }

  return { action: 'pass' };
}

/**
 * Apply a key decision to the webview without touching the clipboard.
 *
 * Ctrl/Cmd+V returns `false` so xterm does not emit its raw `\x16` control
 * byte; the browser-native paste event is left to deliver the text exactly
 * once through xterm's `onData`. No message is posted for paste, so the host
 * can never read the clipboard or replay a second `pasteText`.
 */
export function applyTerminalKey(
  event: TerminalKeyEventLike,
  effects: TerminalKeyEffects,
): boolean {
  const decision = decideTerminalKey(event, {
    hasSelection: effects.hasSelection(),
  });

  switch (decision.action) {
    case 'pass':
      return true;
    case 'consume':
      effects.preventDefault();
      return false;
    case 'input':
      // Shift+Enter is translated to OpenCode's default Ctrl+J newline (LF).
      // onData remains the single path to the PTY, so no double post occurs.
      effects.preventDefault();
      effects.input(decision.data);
      return false;
    case 'copy': {
      const selection = effects.getSelection();
      if (selection.length > 0) {
        effects.post({ type: 'copyClipboard', text: selection });
      }
      effects.preventDefault();
      return false;
    }
    case 'native-paste':
      // Block only xterm's raw Ctrl+V path. Do not read the clipboard here:
      // the VSCode webview's native DOM paste event remains the single owner.
      effects.preventDefault();
      return false;
  }
}

export interface WorkspaceButtonState {
  readonly workspaceMode: boolean;
  readonly ownerName: string;
  readonly workingDirectory: string;
  readonly workspaceCount: number;
  readonly trusted: boolean;
}

export interface WorkspaceButtonView {
  readonly label: string;
  readonly title: string;
  readonly disabled: boolean;
}

function cwdBasename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) {
    return '';
  }
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

/**
 * Toolbar workspace button. In workspace mode it shows the real cwd (never the
 * project/owner name) and stays clickable even for a single-root
 * `.code-workspace`. A normal single folder keeps the old workspace switcher.
 */
export function workspaceButtonView(
  state: WorkspaceButtonState,
): WorkspaceButtonView {
  const ownerName = state.ownerName.length > 0 ? state.ownerName : '工作区';
  if (!state.workspaceMode) {
    const disabled = state.workspaceCount < 2 || !state.trusted;
    return {
      label: ownerName,
      title: state.workspaceCount < 2 ? '当前工作区' : '切换工作区',
      disabled,
    };
  }

  const cwdName = cwdBasename(state.workingDirectory);
  return {
    label:
      cwdName.length > 0 ? `工作目录：${cwdName}` : '工作目录：未选择',
    title:
      state.workingDirectory.length > 0
        ? `当前工作目录：${state.workingDirectory}\n` +
          `项目（owner）：${ownerName}\n点击选择实际工作目录`
        : `尚未选择实际工作目录\n` +
          `项目（owner）：${ownerName}\n点击选择实际工作目录`,
    disabled: state.workspaceCount === 0 || !state.trusted,
  };
}

export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Hard cap for the floating notice overlay; longer messages still auto-hide. */
export const NOTICE_MAX_TIMEOUT_MS = 6000;

export interface NotificationHostNotice {
  readonly epoch: string;
  readonly id: number;
  readonly kind: 'error';
  readonly message: string;
}

/**
 * Only a real host error notice may use the floating overlay. Successful info
 * notices, status text and restart hints stay in the toolbar, so a routine
 * start/attach/copy can never cover the TUI.
 */
export function hostErrorNotice(value: unknown): NotificationHostNotice | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const notice = value as Record<string, unknown>;
  if (notice.kind !== 'error') {
    return null;
  }
  if (typeof notice.message !== 'string' || notice.message.length === 0) {
    return null;
  }
  if (typeof notice.epoch !== 'string' || notice.epoch.length === 0) {
    return null;
  }
  if (!Number.isSafeInteger(notice.id) || (notice.id as number) <= 0) {
    return null;
  }
  return {
    epoch: notice.epoch,
    id: notice.id as number,
    kind: 'error',
    message: notice.message,
  };
}

/**
 * A state message may carry an error, but status/restart/info fields never
 * become an overlay. Keeping this a pure function makes the webview policy
 * testable without a DOM.
 */
export function stateErrorNotice(state: unknown): NotificationHostNotice | null {
  if (state === null || typeof state !== 'object') {
    return null;
  }
  return hostErrorNotice((state as Record<string, unknown>).notice);
}

export interface NotificationControllerOptions {
  readonly scheduler: TimerScheduler;
  readonly render: (message: string) => void;
  readonly clear: () => void;
  readonly timeoutMs?: number;
  /** Persisted host epoch, so a rebuilt webview never replays an old event. */
  readonly initialLastNoticeEpoch?: string;
  /** Persisted host id; only meaningful together with the matching epoch. */
  readonly initialLastNoticeId?: number;
}

/**
 * Epoch + monotonic-id based overlay policy. Every extension-host activation
 * gets a fresh random epoch, so a restarted host that reuses local id 1 is
 * still a new event. Within one epoch repeated postState/attach/snapshot
 * replays of the same id neither re-render nor renew the timer. Dismissing
 * keeps the epoch/id so the same event cannot bounce back, while a new user
 * action gets a new id and may show the same text again. Local DOM failures
 * (for example a failed drop) use the same timer/close path without consuming
 * a host epoch/id.
 */
export class NotificationController {
  private lastEpoch: string;
  private lastHostId: number;
  private handle: unknown = null;
  private disposed = false;
  private readonly timeoutMs: number;

  constructor(private readonly options: NotificationControllerOptions) {
    const configured = options.timeoutMs ?? NOTICE_MAX_TIMEOUT_MS;
    this.timeoutMs = Math.max(0, Math.min(configured, NOTICE_MAX_TIMEOUT_MS));
    const initialEpoch = options.initialLastNoticeEpoch ?? '';
    this.lastEpoch =
      typeof initialEpoch === 'string' && initialEpoch.length > 0
        ? initialEpoch
        : '';
    const initial = options.initialLastNoticeId ?? 0;
    this.lastHostId =
      this.lastEpoch.length > 0 &&
      Number.isSafeInteger(initial) &&
      initial > 0
        ? initial
        : 0;
  }

  /** Last accepted host epoch; persist this in the webview state. */
  get lastNoticeEpoch(): string {
    return this.lastEpoch;
  }

  /** Last accepted host id; persist this in the webview state. */
  get lastNoticeId(): number {
    return this.lastHostId;
  }

  handleHostNotice(value: unknown): boolean {
    if (this.disposed) {
      return false;
    }
    const notice = hostErrorNotice(value);
    if (notice === null) {
      return false;
    }
    if (notice.epoch === this.lastEpoch) {
      if (notice.id <= this.lastHostId) {
        return false;
      }
    } else {
      // A new extension-host activation restarts its local id sequence. Accept
      // its first error even when that id is lower than the persisted one.
      this.lastEpoch = notice.epoch;
      this.lastHostId = 0;
    }
    this.lastHostId = notice.id;
    this.show(notice.message);
    return true;
  }

  showLocalError(message: string): boolean {
    if (this.disposed || message.length === 0) {
      return false;
    }
    this.show(message);
    return true;
  }

  dismiss(): void {
    this.cancelTimer();
    this.options.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private show(message: string): void {
    if (this.disposed) {
      return;
    }
    this.cancelTimer();
    this.options.render(message);
    if (this.timeoutMs > 0) {
      this.handle = this.options.scheduler.setTimeout(() => {
        this.handle = null;
        this.options.clear();
      }, this.timeoutMs);
    }
  }

  private cancelTimer(): void {
    if (this.handle !== null) {
      const handle = this.handle;
      this.handle = null;
      this.options.scheduler.clearTimeout(handle);
    }
  }
}

export interface TerminalFitEnvironment {
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly visible: boolean;
}

export interface TerminalFitDebouncerOptions {
  readonly scheduler: TimerScheduler;
  readonly fit: () => void;
  readonly readEnvironment: () => TerminalFitEnvironment;
  readonly delayMs?: number;
}

/**
 * FitAddon clamps a zero-sized terminal to 2x1. Never call `fit` unless the
 * wrapper has real dimensions and is visible.
 */
export function canFitTerminal(environment: TerminalFitEnvironment): boolean {
  return (
    environment.visible &&
    environment.clientWidth > 0 &&
    environment.clientHeight > 0
  );
}

/**
 * Trailing-edge debouncer for FitAddon. Resize/font/theme notifications only
 * restart the timer; the fit (and therefore the PTY SIGWINCH) runs once after
 * the user stops changing the sidebar size. `fitNow` is reserved for the
 * initial ready/attach path and snapshot replay, where first paint matters.
 */
export class TerminalFitDebouncer {
  private handle: unknown = null;
  private disposed = false;
  private readonly delayMs: number;

  constructor(private readonly options: TerminalFitDebouncerOptions) {
    this.delayMs = options.delayMs ?? FIT_DEBOUNCE_MS;
  }

  schedule(): void {
    if (this.disposed) {
      return;
    }
    this.cancelTimer();
    this.handle = this.options.scheduler.setTimeout(() => {
      this.handle = null;
      this.fitNow();
    }, this.delayMs);
  }

  fitNow(): void {
    this.cancelTimer();
    if (this.disposed) {
      return;
    }
    if (!canFitTerminal(this.options.readEnvironment())) {
      return;
    }
    this.options.fit();
  }

  cancel(): void {
    this.cancelTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.handle !== null) {
      const handle = this.handle;
      this.handle = null;
      this.options.scheduler.clearTimeout(handle);
    }
  }
}

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
  | { readonly action: 'paste' };

export interface TerminalKeyOptions {
  readonly hasSelection: boolean;
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
 *   Ctrl+C/Ctrl+V keep their previous selection/clipboard semantics.
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
    return { action: 'paste' };
  }

  return { action: 'pass' };
}

export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
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

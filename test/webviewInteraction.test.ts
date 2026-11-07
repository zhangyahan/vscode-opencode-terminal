import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIT_DEBOUNCE_MS,
  NEWLINE_INPUT,
  TerminalFitDebouncer,
  applyTerminalKey,
  canFitTerminal,
  decideTerminalKey,
  isImeCompositionEvent,
  type TerminalFitEnvironment,
  type TerminalKeyDecision,
  type TerminalKeyEventLike,
  type TerminalKeyMessage,
  type TimerScheduler,
} from '../media/src/interaction';

class FakeScheduler implements TimerScheduler {
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { readonly callback: () => void; readonly delayMs: number }
  >();
  readonly delays: number[] = [];
  setCalls = 0;
  clearCalls = 0;

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { callback, delayMs });
    this.delays.push(delayMs);
    this.setCalls += 1;
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle !== 'number') {
      return;
    }
    if (this.timers.delete(handle)) {
      this.clearCalls += 1;
    }
  }

  get pending(): number {
    return this.timers.size;
  }

  runAll(): void {
    while (this.timers.size > 0) {
      const entry = this.timers.entries().next().value;
      assert.ok(entry, 'expected a pending timer');
      const [id, timer] = entry;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

interface SimulatedWebview {
  readonly decisions: TerminalKeyDecision[];
  readonly writes: string[];
  readonly posts: TerminalKeyMessage[];
  readonly handled: boolean[];
  preventDefaults: number;
  send(
    event: TerminalKeyEventLike,
    hasSelection?: boolean,
    selection?: string,
  ): TerminalKeyDecision;
  /** Models the browser-native paste -> xterm onData -> ptyInput path. */
  nativePaste(data: string): void;
}

function simulateWebview(): SimulatedWebview {
  const decisions: TerminalKeyDecision[] = [];
  const writes: string[] = [];
  const posts: TerminalKeyMessage[] = [];
  const handled: boolean[] = [];
  const webview: SimulatedWebview = {
    decisions,
    writes,
    posts,
    handled,
    preventDefaults: 0,
    send(event, hasSelection = false, selection = '') {
      const decision = decideTerminalKey(event, { hasSelection });
      decisions.push(decision);
      handled.push(
        applyTerminalKey(event, {
          hasSelection: () => hasSelection,
          getSelection: () => selection,
          input: (data) => writes.push(data),
          post: (message) => posts.push(message),
          preventDefault: () => {
            webview.preventDefaults += 1;
          },
        }),
      );
      return decision;
    },
    nativePaste(data) {
      writes.push(data);
    },
  };
  return webview;
}

test('Shift+Enter produces exactly one LF across keydown/keypress/keyup and never CR', () => {
  const webview = simulateWebview();

  assert.deepEqual(
    webview.send({ type: 'keydown', key: 'Enter', shiftKey: true }),
    { action: 'input', data: NEWLINE_INPUT },
  );
  assert.deepEqual(
    webview.send({ type: 'keypress', key: 'Enter', shiftKey: true }),
    { action: 'consume' },
  );
  assert.deepEqual(
    webview.send({ type: 'keyup', key: 'Enter', shiftKey: true }),
    { action: 'pass' },
  );

  assert.deepEqual(webview.writes, ['\n']);
  assert.equal(webview.writes.includes('\r'), false);
  assert.equal(webview.writes.filter((value) => value === '\n').length, 1);
});

test('plain Enter still passes through to xterm for CR submission', () => {
  const webview = simulateWebview();

  assert.deepEqual(webview.send({ type: 'keydown', key: 'Enter' }), {
    action: 'pass',
  });
  assert.deepEqual(webview.send({ type: 'keypress', key: 'Enter' }), {
    action: 'pass',
  });

  assert.deepEqual(webview.writes, []);
});

test('IME composition always wins, including Enter used to pick a candidate', () => {
  const webview = simulateWebview();

  assert.equal(
    isImeCompositionEvent({ key: 'Enter', isComposing: true }),
    true,
  );
  assert.equal(isImeCompositionEvent({ key: 'Enter', keyCode: 229 }), true);
  assert.equal(isImeCompositionEvent({ key: 'Process' }), true);

  for (const event of [
    { type: 'keydown', key: 'Enter', shiftKey: true, isComposing: true },
    { type: 'keydown', key: 'Enter', shiftKey: true, keyCode: 229 },
    { type: 'keydown', key: 'Process' },
    { type: 'keydown', key: 'Enter' },
  ] satisfies TerminalKeyEventLike[]) {
    assert.equal(webview.send(event).action, 'pass');
  }

  assert.deepEqual(webview.writes, []);
});

test('Shift+Enter with Ctrl, Alt or Meta is not translated; Ctrl+J stays native', () => {
  const webview = simulateWebview();

  for (const event of [
    { type: 'keydown', key: 'Enter', shiftKey: true, ctrlKey: true },
    { type: 'keydown', key: 'Enter', shiftKey: true, altKey: true },
    { type: 'keydown', key: 'Enter', shiftKey: true, metaKey: true },
    { type: 'keydown', key: 'j', ctrlKey: true },
  ] satisfies TerminalKeyEventLike[]) {
    assert.equal(webview.send(event).action, 'pass');
  }

  assert.deepEqual(webview.writes, []);
});

test('Ctrl+C selection copy still posts once and Ctrl+Shift+C stays consumed', () => {
  const webview = simulateWebview();

  assert.deepEqual(
    webview.send({ type: 'keydown', key: 'c', ctrlKey: true }, true, 'selected'),
    { action: 'copy' },
  );
  assert.deepEqual(webview.posts, [
    { type: 'copyClipboard', text: 'selected' },
  ]);
  assert.equal(webview.handled[0], false);
  assert.equal(webview.preventDefaults, 1);

  assert.deepEqual(
    webview.send({ type: 'keydown', key: 'c', ctrlKey: true }, false),
    { action: 'pass' },
  );
  assert.equal(webview.handled[1], true);
  assert.deepEqual(
    webview.send(
      { type: 'keydown', key: 'C', ctrlKey: true, shiftKey: true },
      false,
    ),
    { action: 'consume' },
  );
  assert.equal(webview.handled[2], false);
  assert.equal(webview.posts.length, 1, 'consume must not copy anything else');
  assert.deepEqual(webview.writes, []);
});

test('Ctrl+V and Cmd+V block only raw xterm input and never read the clipboard or write PTY data', () => {
  for (const event of [
    { type: 'keydown', key: 'v', ctrlKey: true },
    { type: 'keydown', key: 'V', ctrlKey: true },
    { type: 'keydown', key: 'v', metaKey: true },
    { type: 'keydown', key: 'V', metaKey: true },
  ] satisfies TerminalKeyEventLike[]) {
    const webview = simulateWebview();

    assert.deepEqual(webview.send(event, false), { action: 'native-paste' });
    assert.equal(webview.handled[0], false, 'raw Ctrl+V must be blocked');
    assert.equal(webview.preventDefaults, 1);
    assert.deepEqual(webview.posts, [], 'paste must not post readClipboard');
    assert.deepEqual(webview.writes, [], 'keydown must not write \\x16 or text');
  }
});

test('native DOM paste is the single data path and identical consecutive pastes are not deduplicated', () => {
  const webview = simulateWebview();

  webview.nativePaste('same text');
  assert.deepEqual(webview.writes, ['same text']);

  webview.nativePaste('same text');
  assert.deepEqual(
    webview.writes,
    ['same text', 'same text'],
    'two independent identical pastes must both reach onData',
  );
  assert.deepEqual(webview.posts, []);
  assert.equal(webview.preventDefaults, 0);
});

test('Ctrl+Shift+V, keypress and keyup keep their pass-through semantics without paste side effects', () => {
  const webview = simulateWebview();

  assert.deepEqual(
    webview.send({ type: 'keydown', key: 'V', ctrlKey: true, shiftKey: true }),
    { action: 'pass' },
  );
  assert.deepEqual(
    webview.send({ type: 'keypress', key: 'v', ctrlKey: true }, false),
    { action: 'pass' },
  );
  assert.deepEqual(
    webview.send({ type: 'keyup', key: 'v', ctrlKey: true }, false),
    { action: 'pass' },
  );

  assert.deepEqual(webview.handled, [true, true, true]);
  assert.equal(webview.preventDefaults, 0);
  assert.deepEqual(webview.posts, []);
  assert.deepEqual(webview.writes, [], 'keypress/keyup must not duplicate a paste');
});

test('fit gate rejects zero-sized and hidden wrappers', () => {
  assert.equal(FIT_DEBOUNCE_MS, 175);
  assert.equal(
    canFitTerminal({ clientWidth: 800, clientHeight: 400, visible: true }),
    true,
  );
  assert.equal(
    canFitTerminal({ clientWidth: 0, clientHeight: 400, visible: true }),
    false,
  );
  assert.equal(
    canFitTerminal({ clientWidth: 800, clientHeight: 0, visible: true }),
    false,
  );
  assert.equal(
    canFitTerminal({ clientWidth: 800, clientHeight: 400, visible: false }),
    false,
  );
});

test('100 continuous resize notifications produce one trailing fit after 175ms', () => {
  const scheduler = new FakeScheduler();
  let fits = 0;
  const debouncer = new TerminalFitDebouncer({
    scheduler,
    fit: () => {
      fits += 1;
    },
    readEnvironment: () => ({
      clientWidth: 900,
      clientHeight: 500,
      visible: true,
    }),
  });

  for (let index = 0; index < 100; index += 1) {
    debouncer.schedule();
  }

  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.setCalls, 100);
  assert.equal(scheduler.clearCalls, 99);
  assert.deepEqual(new Set(scheduler.delays), new Set([175]));
  assert.equal(fits, 0, 'no fit may run while the user is still resizing');

  scheduler.runAll();
  assert.equal(fits, 1);
  assert.equal(scheduler.pending, 0);
});

test('fitNow is immediate for initial ready/snapshot attach and cancels a pending debounce', () => {
  const scheduler = new FakeScheduler();
  let fits = 0;
  const debouncer = new TerminalFitDebouncer({
    scheduler,
    fit: () => {
      fits += 1;
    },
    readEnvironment: () => ({
      clientWidth: 900,
      clientHeight: 500,
      visible: true,
    }),
  });

  debouncer.fitNow();
  assert.equal(fits, 1);
  assert.equal(scheduler.pending, 0);

  debouncer.schedule();
  assert.equal(scheduler.pending, 1);
  debouncer.cancel();
  assert.equal(scheduler.pending, 0);
  scheduler.runAll();
  assert.equal(fits, 1, 'a cancelled trailing fit must not run');
});

test('hidden or zero-sized terminal is not fitted, then fits again after recovery', () => {
  const scheduler = new FakeScheduler();
  let fits = 0;
  let environment: TerminalFitEnvironment = {
    clientWidth: 0,
    clientHeight: 0,
    visible: true,
  };
  const debouncer = new TerminalFitDebouncer({
    scheduler,
    fit: () => {
      fits += 1;
    },
    readEnvironment: () => environment,
  });

  debouncer.fitNow();
  debouncer.schedule();
  scheduler.runAll();
  assert.equal(fits, 0);

  environment = { clientWidth: 800, clientHeight: 400, visible: false };
  debouncer.schedule();
  scheduler.runAll();
  assert.equal(fits, 0);

  environment = { clientWidth: 800, clientHeight: 400, visible: true };
  debouncer.schedule();
  assert.equal(scheduler.pending, 1);
  scheduler.runAll();
  assert.equal(fits, 1);
});

test('dispose clears the pending timer and blocks later fits', () => {
  const scheduler = new FakeScheduler();
  let fits = 0;
  const debouncer = new TerminalFitDebouncer({
    scheduler,
    fit: () => {
      fits += 1;
    },
    readEnvironment: () => ({
      clientWidth: 800,
      clientHeight: 400,
      visible: true,
    }),
  });

  debouncer.schedule();
  debouncer.dispose();
  assert.equal(scheduler.pending, 0);

  debouncer.schedule();
  debouncer.fitNow();
  scheduler.runAll();
  assert.equal(fits, 0);
});

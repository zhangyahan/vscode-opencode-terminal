import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIT_DEBOUNCE_MS,
  NEWLINE_INPUT,
  NOTICE_MAX_TIMEOUT_MS,
  NotificationController,
  TerminalFitDebouncer,
  applyTerminalKey,
  canFitTerminal,
  decideTerminalKey,
  hostErrorNotice,
  isImeCompositionEvent,
  stateErrorNotice,
  workspaceButtonView,
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

test('workspace-mode toolbar shows the real cwd basename and stays enabled for a single-root workspace file', () => {
  const workspace = workspaceButtonView({
    workspaceMode: true,
    ownerName: 'demo-project',
    workingDirectory: 'D:/Workspace/FR',
    workspaceCount: 1,
    trusted: true,
  });
  assert.equal(workspace.label, '工作目录：FR');
  assert.equal(workspace.disabled, false, 'a single-root .code-workspace must stay clickable');
  assert.match(workspace.title, /D:\/Workspace\/FR/);
  assert.match(workspace.title, /项目（owner）：demo-project/);

  const unselected = workspaceButtonView({
    workspaceMode: true,
    ownerName: 'demo-project',
    workingDirectory: '',
    workspaceCount: 1,
    trusted: true,
  });
  assert.equal(unselected.label, '工作目录：未选择');
  assert.equal(unselected.disabled, false);

  const untrusted = workspaceButtonView({
    workspaceMode: true,
    ownerName: 'demo-project',
    workingDirectory: 'D:/Workspace/FR',
    workspaceCount: 1,
    trusted: false,
  });
  assert.equal(untrusted.disabled, true);

  const normal = workspaceButtonView({
    workspaceMode: false,
    ownerName: 'demo',
    workingDirectory: 'C:/demo',
    workspaceCount: 1,
    trusted: true,
  });
  assert.equal(normal.label, 'demo');
  assert.equal(normal.disabled, true, 'normal single-folder behavior is unchanged');
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

interface NotificationHarness {
  readonly scheduler: FakeScheduler;
  readonly rendered: string[];
  readonly controller: NotificationController;
  clears: number;
}

const TEST_EPOCH = 'epoch-test';

function notificationHarness(
  initialLastNoticeEpoch = '',
  initialLastNoticeId = 0,
  timeoutMs?: number,
): NotificationHarness {
  const scheduler = new FakeScheduler();
  const rendered: string[] = [];
  const harness: NotificationHarness = {
    scheduler,
    rendered,
    clears: 0,
    controller: new NotificationController({
      scheduler,
      render: (message) => rendered.push(message),
      clear: () => {
        harness.clears += 1;
      },
      initialLastNoticeEpoch,
      initialLastNoticeId,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
  };
  return harness;
}

test('notification policy never overlays info notices, status text or restart hints', () => {
  const harness = notificationHarness();

  assert.equal(
    harness.controller.handleHostNotice({
      epoch: TEST_EPOCH,
      id: 1,
      kind: 'info',
      message: '已在 demo 启动 PTY。',
    }),
    false,
  );
  assert.equal(harness.controller.handleHostNotice(null), false);
  assert.equal(
    stateErrorNotice({ status: 'PTY 未启动。请点击“重启”。', ptyActive: false }),
    null,
  );
  assert.equal(
    stateErrorNotice({
      status: 'PTY 运行中',
      restartRecommended: true,
      notice: null,
    }),
    null,
  );
  assert.equal(
    stateErrorNotice({
      notice: {
        epoch: TEST_EPOCH,
        id: 2,
        kind: 'info',
        message: '已复制到剪贴板。',
      },
    }),
    null,
  );

  assert.deepEqual(harness.rendered, []);
  assert.equal(harness.scheduler.pending, 0);
});

test('a host error renders once and auto-dismisses after at most six seconds', () => {
  const harness = notificationHarness();
  const notice = stateErrorNotice({
    notice: {
      epoch: TEST_EPOCH,
      id: 7,
      kind: 'error',
      message: '写入 PTY 失败。',
    },
  });

  assert.deepEqual(notice, {
    epoch: TEST_EPOCH,
    id: 7,
    kind: 'error',
    message: '写入 PTY 失败。',
  });
  assert.equal(NOTICE_MAX_TIMEOUT_MS, 6000);
  assert.equal(harness.controller.handleHostNotice(notice), true);
  assert.deepEqual(harness.rendered, ['写入 PTY 失败。']);
  assert.deepEqual(harness.scheduler.delays, [6000]);
  assert.equal(harness.scheduler.pending, 1);

  harness.scheduler.runAll();
  assert.equal(harness.clears, 1);

  const capped = notificationHarness(TEST_EPOCH, 0, 60_000);
  assert.equal(
    capped.controller.handleHostNotice({
      epoch: TEST_EPOCH,
      id: 70,
      kind: 'error',
      message: '超长超时也必须截断。',
    }),
    true,
  );
  assert.deepEqual(capped.scheduler.delays, [6000]);
});

test('replaying the same notice id neither re-renders nor renews the timer', () => {
  const harness = notificationHarness();
  const notice = {
    epoch: TEST_EPOCH,
    id: 8,
    kind: 'error',
    message: '同一事件。',
  };

  assert.equal(harness.controller.handleHostNotice(notice), true);
  assert.equal(harness.scheduler.setCalls, 1);
  assert.equal(harness.scheduler.clearCalls, 0);

  assert.equal(harness.controller.handleHostNotice(notice), false);
  assert.equal(harness.controller.handleHostNotice({ ...notice }), false);
  assert.equal(harness.scheduler.setCalls, 1, 'same id must not restart the timer');
  assert.equal(harness.scheduler.clearCalls, 0);
  assert.deepEqual(harness.rendered, ['同一事件。']);
});

test('dismiss keeps the epoch and id so the same event cannot bounce back', () => {
  const harness = notificationHarness();
  const notice = {
    epoch: TEST_EPOCH,
    id: 9,
    kind: 'error',
    message: '可关闭错误。',
  };

  assert.equal(harness.controller.handleHostNotice(notice), true);
  harness.controller.dismiss();
  assert.equal(harness.clears, 1);
  assert.equal(harness.scheduler.pending, 0);

  assert.equal(harness.controller.handleHostNotice(notice), false);
  assert.deepEqual(harness.rendered, ['可关闭错误。']);
});

test('a new id with identical text can be shown after the previous event', () => {
  const harness = notificationHarness();

  assert.equal(
    harness.controller.handleHostNotice({
      epoch: TEST_EPOCH,
      id: 10,
      kind: 'error',
      message: '同样的文案。',
    }),
    true,
  );
  harness.controller.dismiss();
  assert.equal(
    harness.controller.handleHostNotice({
      epoch: TEST_EPOCH,
      id: 11,
      kind: 'error',
      message: '同样的文案。',
    }),
    true,
    'a new user operation must not be deduplicated by message text',
  );
  assert.deepEqual(harness.rendered, ['同样的文案。', '同样的文案。']);
});

test('same-epoch webview rebuild ignores replayed ids but accepts newer errors', () => {
  const harness = notificationHarness(TEST_EPOCH, 20);

  assert.equal(
    harness.controller.handleHostNotice({
      epoch: TEST_EPOCH,
      id: 20,
      kind: 'error',
      message: '旧事件。',
    }),
    false,
  );
  assert.deepEqual(harness.rendered, []);

  assert.equal(
    harness.controller.handleHostNotice({
      epoch: TEST_EPOCH,
      id: 21,
      kind: 'error',
      message: '新错误。',
    }),
    true,
  );
  assert.deepEqual(harness.rendered, ['新错误。']);
});

test('a new host epoch accepts its id 1 and resets the replay boundary', () => {
  const harness = notificationHarness('old-epoch', 50);

  assert.equal(
    harness.controller.handleHostNotice({
      epoch: 'new-epoch',
      id: 1,
      kind: 'error',
      message: '扩展宿主重启后的第一个错误。',
    }),
    true,
    'a restarted host must not be swallowed by the persisted old id',
  );
  assert.equal(harness.controller.lastNoticeEpoch, 'new-epoch');
  assert.equal(harness.controller.lastNoticeId, 1);
  assert.deepEqual(harness.rendered, ['扩展宿主重启后的第一个错误。']);

  assert.equal(
    harness.controller.handleHostNotice({
      epoch: 'new-epoch',
      id: 1,
      kind: 'error',
      message: '扩展宿主重启后的第一个错误。',
    }),
    false,
    'the same new-epoch event still cannot replay',
  );

  assert.equal(
    harness.controller.handleHostNotice({
      epoch: 'third-epoch',
      id: 1,
      kind: 'error',
      message: '再次重启后的错误。',
    }),
    true,
    'another distinct host epoch accepts its own id 1',
  );
  assert.equal(harness.controller.lastNoticeEpoch, 'third-epoch');
});

test('local drop errors use the same auto-dismiss path without a host epoch', () => {
  const harness = notificationHarness(TEST_EPOCH, 5);

  assert.equal(harness.controller.showLocalError('未识别到文件。'), true);
  assert.deepEqual(harness.rendered, ['未识别到文件。']);
  assert.deepEqual(harness.scheduler.delays, [6000]);
  harness.controller.dismiss();
  assert.equal(harness.clears, 1);
  assert.equal(harness.controller.lastNoticeEpoch, TEST_EPOCH);
  assert.equal(harness.controller.lastNoticeId, 5);
});

test('dispose clears the pending notice timer and ignores later notices', () => {
  const harness = notificationHarness();

  assert.equal(
    harness.controller.handleHostNotice({
      epoch: TEST_EPOCH,
      id: 30,
      kind: 'error',
      message: '等待超时。',
    }),
    true,
  );
  assert.equal(harness.scheduler.pending, 1);

  harness.controller.dispose();
  assert.equal(harness.scheduler.pending, 0);
  assert.equal(
    harness.controller.handleHostNotice({
      epoch: 'new-epoch',
      id: 1,
      kind: 'error',
      message: '不应显示。',
    }),
    false,
  );
  harness.scheduler.runAll();
  assert.deepEqual(harness.rendered, ['等待超时。']);
});

test('hostErrorNotice rejects missing epoch or id so an old protocol cannot stick forever', () => {
  assert.equal(
    hostErrorNotice({ kind: 'error', message: '没有 id。' }),
    null,
  );
  assert.equal(
    hostErrorNotice({
      epoch: TEST_EPOCH,
      id: 1.5,
      kind: 'error',
      message: '非整数 id。',
    }),
    null,
  );
  assert.equal(
    hostErrorNotice({
      epoch: TEST_EPOCH,
      id: 0,
      kind: 'error',
      message: '零 id。',
    }),
    null,
  );
  assert.equal(
    hostErrorNotice({
      epoch: TEST_EPOCH,
      id: 3,
      kind: 'error',
      message: '',
    }),
    null,
  );
  assert.equal(
    hostErrorNotice({ id: 3, kind: 'error', message: '没有 epoch。' }),
    null,
  );
  assert.equal(
    hostErrorNotice({
      epoch: '',
      id: 3,
      kind: 'error',
      message: '空 epoch。',
    }),
    null,
  );
});

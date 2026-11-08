import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_COLS,
  DEFAULT_MAX_ROWS,
  PtySessionManager,
  parsePtyClientMessage,
  type PtyDisposable,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawn,
  type PtySpawnOptions,
} from '../src/ptySession';

class FakeProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }> = [];
  killCount = 0;
  failNextWrite: Error | undefined;

  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  write(data: string): void {
    if (this.failNextWrite !== undefined) {
      const error = this.failNextWrite;
      this.failNextWrite = undefined;
      throw error;
    }
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killCount += 1;
  }

  onData(listener: (data: string) => void): PtyDisposable {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  emitData(data: string): void {
    for (const listener of [...this.dataListeners]) {
      listener(data);
    }
  }

  emitExit(event: PtyExitEvent = { exitCode: 0 }): void {
    for (const listener of [...this.exitListeners]) {
      listener(event);
    }
  }

  get listenerCount(): number {
    return this.dataListeners.size + this.exitListeners.size;
  }
}

interface SpawnCall {
  readonly shellPath: string;
  readonly args: string | string[];
  readonly options: PtySpawnOptions;
}

interface Harness {
  readonly manager: PtySessionManager;
  readonly calls: SpawnCall[];
  readonly processes: FakeProcess[];
}

function createHarness(
  options: {
    readonly maxOutputBuffer?: number;
    readonly maxInputLength?: number;
    readonly maxCols?: number;
    readonly maxRows?: number;
    readonly onCreate?: (process: FakeProcess, index: number) => void;
  } = {},
): Harness {
  const calls: SpawnCall[] = [];
  const processes: FakeProcess[] = [];
  let nextId = 0;

  const spawn: PtySpawn = (shellPath, args, spawnOptions) => {
    const process = new FakeProcess();
    calls.push({ shellPath, args, options: spawnOptions });
    processes.push(process);
    options.onCreate?.(process, processes.length - 1);
    return process;
  };

  const manager = new PtySessionManager(spawn, {
    ...(options.maxOutputBuffer === undefined
      ? {}
      : { maxOutputBuffer: options.maxOutputBuffer }),
    ...(options.maxInputLength === undefined
      ? {}
      : { maxInputLength: options.maxInputLength }),
    ...(options.maxCols === undefined ? {} : { maxCols: options.maxCols }),
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    createSessionId: () => {
      nextId += 1;
      return `session-${nextId}`;
    },
  });

  return { manager, calls, processes };
}

function launch(overrides: Partial<Parameters<PtySessionManager['ensure']>[1]> = {}) {
  return {
    shellPath: '/bin/bash',
    args: ['-l'],
    env: { PATH: '/bin' },
    cwd: '/work',
    launchCommand: 'opencode',
    cols: 100,
    rows: 30,
    ...overrides,
  };
}

test('ensure spawns once, writes the launch command once and reuses the session', () => {
  const harness = createHarness();
  const first = harness.manager.ensure('file:///work', launch());

  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }
  assert.equal(first.created, true);
  assert.equal(first.session.sessionId, 'session-1');
  assert.equal(first.session.sequence, 0);
  assert.equal(first.session.backlog, '');
  assert.equal(first.session.truncated, false);

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].shellPath, '/bin/bash');
  assert.deepEqual(harness.calls[0].args, ['-l']);
  assert.deepEqual(harness.calls[0].options, {
    cwd: '/work',
    env: { PATH: '/bin' },
    cols: 100,
    rows: 30,
  });
  assert.deepEqual(harness.processes[0].writes, ['opencode\r']);

  harness.processes[0].emitData('hello');

  const second = harness.manager.ensure('file:///work', launch());
  assert.equal(second.ok, true);
  if (!second.ok) {
    return;
  }
  assert.equal(second.created, false);
  assert.equal(second.session.sessionId, 'session-1');
  assert.equal(second.session.backlog, 'hello');
  assert.equal(second.session.sequence, 1);
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.processes[0].writes, ['opencode\r']);
});

test('getWorkingDirectory returns the recorded spawn cwd only for the current session', () => {
  const harness = createHarness();
  const first = harness.manager.ensure(
    'file:///work',
    launch({ cwd: 'D:/Workspace/FR' }),
  );
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }

  assert.equal(
    harness.manager.getWorkingDirectory('file:///work', first.session.sessionId),
    'D:/Workspace/FR',
  );
  assert.equal(
    harness.manager.getWorkingDirectory('file:///work', 'session-stale'),
    undefined,
    'a stale session id must not expose another session cwd',
  );
  assert.equal(
    harness.manager.getWorkingDirectory('file:///other', first.session.sessionId),
    undefined,
  );

  harness.processes[0].emitExit({ exitCode: 0 });
  assert.equal(
    harness.manager.getWorkingDirectory('file:///work', first.session.sessionId),
    undefined,
    'an exited session has no working directory',
  );
});

test('a replacement session reports its own spawn cwd and never the previous one', () => {
  const harness = createHarness();
  harness.manager.ensure('file:///work', launch({ cwd: 'D:/Workspace/FR' }));
  harness.manager.stop('file:///work');
  const second = harness.manager.ensure(
    'file:///work',
    launch({ cwd: 'D:/Workspace/other' }),
  );
  assert.equal(second.ok, true);
  if (!second.ok) {
    return;
  }

  assert.equal(
    harness.manager.getWorkingDirectory('file:///work', 'session-1'),
    undefined,
  );
  assert.equal(
    harness.manager.getWorkingDirectory('file:///work', second.session.sessionId),
    'D:/Workspace/other',
  );
});

test('a Windows argument string is passed through unchanged', () => {
  const harness = createHarness();
  const result = harness.manager.ensure('file:///work', {
    shellPath: 'C:\\Windows\\System32\\cmd.exe',
    args: '/k echo hi',
    cwd: 'C:\\work',
    cols: 80,
    rows: 24,
  });

  assert.equal(result.ok, true);
  assert.equal(harness.calls[0].args, '/k echo hi');
  assert.deepEqual(harness.processes[0].writes, []);
});

test('invalid launch settings are rejected before spawning', () => {
  const harness = createHarness();
  assert.equal(
    harness.manager.ensure('file:///work', launch({ launchCommand: 'echo one\necho two' })).ok,
    false,
  );
  assert.equal(
    harness.manager.ensure('file:///work', launch({ cols: 0 })).ok,
    false,
  );
  assert.equal(
    harness.manager.ensure('file:///work', launch({ args: [1 as unknown as string] })).ok,
    false,
  );
  assert.equal(harness.calls.length, 0);
});

test('spawn failures are reported without leaving a session behind', () => {
  const manager = new PtySessionManager(() => {
    throw new Error('spawn exploded');
  });

  const result = manager.ensure('file:///work', launch());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'spawn-failed');
    assert.match(result.message, /spawn exploded/);
  }
  assert.equal(manager.size, 0);
  assert.equal(manager.snapshot('file:///work'), undefined);
});

test('a failed launch write kills and removes the process', () => {
  const harness = createHarness({
    onCreate: (process, index) => {
      if (index === 0) {
        process.failNextWrite = new Error('write failed');
      }
    },
  });

  const result = harness.manager.ensure('file:///work', launch());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'launch-write-failed');
  }
  assert.equal(harness.processes[0].killCount, 1);
  assert.equal(harness.manager.size, 0);
  assert.equal(harness.manager.snapshot('file:///work'), undefined);

  const retry = harness.manager.ensure('file:///work', launch());
  assert.equal(retry.ok, true);
  if (retry.ok) {
    assert.equal(retry.created, true);
    assert.equal(retry.session.sessionId, 'session-2');
  }
});

test('output events carry a sequence and the backlog is bounded raw ANSI', () => {
  const harness = createHarness({ maxOutputBuffer: 5 });
  const events: Array<{ type: string; sequence: number; data?: string; sessionId: string }> = [];
  const subscription = harness.manager.subscribe((event) => {
    events.push(
      event.type === 'data'
        ? { type: event.type, sequence: event.sequence, data: event.data, sessionId: event.sessionId }
        : { type: event.type, sequence: event.sequence, sessionId: event.sessionId },
    );
  });

  const result = harness.manager.ensure('file:///work', launch());
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  harness.processes[0].emitData('\u001b[31mabc');
  harness.processes[0].emitData('def');

  assert.deepEqual(events, [
    { type: 'data', sequence: 1, data: '\u001b[31mabc', sessionId: result.session.sessionId },
    { type: 'data', sequence: 2, data: 'def', sessionId: result.session.sessionId },
  ]);

  const snapshot = harness.manager.snapshot('file:///work');
  assert.ok(snapshot);
  if (snapshot !== undefined) {
    assert.equal(snapshot.backlog.length, 5);
    assert.equal(snapshot.backlog, 'bcdef');
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.sequence, 2);
  }

  subscription.dispose();
  harness.processes[0].emitData('ignored');
  assert.equal(events.length, 2);
});

test('input keeps terminal control bytes and is bounded by length', () => {
  const harness = createHarness({ maxInputLength: 5 });
  const result = harness.manager.ensure('file:///work', launch());
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  const sessionId = result.session.sessionId;
  const control = '\u0003\u001b[A\r';
  assert.equal(harness.manager.sendInput('file:///work', sessionId, control).ok, true);
  assert.equal(harness.processes[0].writes[1], control);

  const empty = harness.manager.sendInput('file:///work', sessionId, '');
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.equal(empty.code, 'invalid-input');
  }

  const tooLong = harness.manager.sendInput('file:///work', sessionId, '123456');
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) {
    assert.equal(tooLong.code, 'invalid-input');
  }

  const routed = harness.manager.handleMessage('file:///work', {
    type: 'input',
    sessionId,
    data: '\u0004',
  });
  assert.equal(routed.ok, true);
  assert.equal(harness.processes[0].writes.at(-1), '\u0004');
});

test('a failed input write is reported but leaves the session usable', () => {
  const harness = createHarness();
  const result = harness.manager.ensure('file:///work', launch());
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  harness.processes[0].failNextWrite = new Error('broken pipe');
  const failed = harness.manager.sendInput(
    'file:///work',
    result.session.sessionId,
    'x',
  );
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.code, 'write-failed');
  }
  assert.equal(harness.manager.isActive('file:///work', result.session.sessionId), true);
  assert.equal(
    harness.manager.sendInput('file:///work', result.session.sessionId, 'y').ok,
    true,
  );
});

test('exit clears the session, and stale ids cannot write to a rebuilt session', () => {
  const harness = createHarness();
  const events: Array<{ type: string; sessionId: string; exitCode?: number }> = [];
  harness.manager.subscribe((event) => {
    events.push(
      event.type === 'exit'
        ? { type: event.type, sessionId: event.sessionId, exitCode: event.exitCode }
        : { type: event.type, sessionId: event.sessionId },
    );
  });

  const first = harness.manager.ensure('file:///work', launch());
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }

  harness.processes[0].emitExit({ exitCode: 7 });
  assert.equal(harness.manager.isActive('file:///work', first.session.sessionId), false);
  assert.equal(harness.manager.snapshot('file:///work'), undefined);
  assert.deepEqual(events, [
    { type: 'exit', sessionId: first.session.sessionId, exitCode: 7 },
  ]);
  assert.equal(harness.processes[0].listenerCount, 0);

  const inactive = harness.manager.sendInput(
    'file:///work',
    first.session.sessionId,
    'x',
  );
  assert.equal(inactive.ok, false);
  if (!inactive.ok) {
    assert.equal(inactive.code, 'inactive');
  }

  const second = harness.manager.ensure('file:///work', launch());
  assert.equal(second.ok, true);
  if (!second.ok) {
    return;
  }
  assert.equal(second.created, true);
  assert.equal(second.session.sessionId, 'session-2');
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(harness.processes[1].writes, ['opencode\r']);

  const stale = harness.manager.sendInput(
    'file:///work',
    first.session.sessionId,
    'x',
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.code, 'stale-session');
  }
  assert.deepEqual(harness.processes[1].writes, ['opencode\r']);

  assert.equal(
    harness.manager.sendInput('file:///work', second.session.sessionId, 'x').ok,
    true,
  );
});

test('resize is bounded and routed only to the active session', () => {
  const harness = createHarness();
  const result = harness.manager.ensure('file:///work', launch());
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const sessionId = result.session.sessionId;

  assert.equal(harness.manager.resize('file:///work', sessionId, 120, 40).ok, true);
  assert.deepEqual(harness.processes[0].resizes, [{ cols: 120, rows: 40 }]);

  for (const [cols, rows] of [
    [0, 40],
    [DEFAULT_MAX_COLS + 1, 40],
    [80, 0],
    [80, DEFAULT_MAX_ROWS + 1],
    [80.5, 40],
  ] as const) {
    const failure = harness.manager.resize('file:///work', sessionId, cols, rows);
    assert.equal(failure.ok, false);
    if (!failure.ok) {
      assert.equal(failure.code, 'invalid-resize');
    }
  }
  assert.equal(harness.processes[0].resizes.length, 1);

  const stale = harness.manager.resize('file:///work', 'session-999', 80, 24);
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.code, 'stale-session');
  }

  assert.equal(
    harness.manager.handleMessage('file:///work', {
      type: 'resize',
      sessionId,
      cols: 90,
      rows: 20,
    }).ok,
    true,
  );
  assert.deepEqual(harness.processes[0].resizes.at(-1), { cols: 90, rows: 20 });
});

test('workspace isolation keeps input and exits separate', () => {
  const harness = createHarness();
  const one = harness.manager.ensure('file:///one', launch());
  const two = harness.manager.ensure('file:///two', launch());
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  if (!one.ok || !two.ok) {
    return;
  }
  assert.notEqual(one.session.sessionId, two.session.sessionId);

  assert.equal(
    harness.manager.sendInput('file:///one', one.session.sessionId, 'one').ok,
    true,
  );
  assert.equal(
    harness.manager.sendInput('file:///two', two.session.sessionId, 'two').ok,
    true,
  );
  assert.deepEqual(harness.processes[0].writes, ['opencode\r', 'one']);
  assert.deepEqual(harness.processes[1].writes, ['opencode\r', 'two']);

  harness.processes[0].emitExit({ exitCode: 0 });
  assert.equal(harness.manager.isActive('file:///one', one.session.sessionId), false);
  assert.equal(harness.manager.isActive('file:///two', two.session.sessionId), true);
  assert.equal(
    harness.manager.sendInput('file:///two', two.session.sessionId, 'still').ok,
    true,
  );
});

test('stop kills one workspace session and allows a fresh session', () => {
  const harness = createHarness();
  const first = harness.manager.ensure('file:///work', launch());
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }

  assert.equal(harness.manager.stop('file:///work'), true);
  assert.equal(harness.processes[0].killCount, 1);
  assert.equal(harness.manager.size, 0);
  assert.equal(harness.manager.snapshot('file:///work'), undefined);
  assert.equal(harness.processes[0].listenerCount, 0);
  assert.equal(harness.manager.stop('file:///work'), false);

  const second = harness.manager.ensure('file:///work', launch());
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.created, true);
    assert.equal(second.session.sessionId, 'session-2');
  }
  assert.equal(harness.calls.length, 2);
});

test('dispose kills every shell, clears state and rejects new work', () => {
  const harness = createHarness();
  const one = harness.manager.ensure('file:///one', launch());
  const two = harness.manager.ensure('file:///two', launch());
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  if (!one.ok || !two.ok) {
    return;
  }

  const subscription = harness.manager.subscribe(() => undefined);
  harness.manager.dispose();

  assert.equal(harness.manager.size, 0);
  assert.equal(harness.processes[0].killCount, 1);
  assert.equal(harness.processes[1].killCount, 1);
  assert.equal(harness.manager.isActive('file:///one', one.session.sessionId), false);
  assert.equal(harness.manager.snapshot('file:///one'), undefined);

  const disposed = harness.manager.ensure('file:///one', launch());
  assert.equal(disposed.ok, false);
  if (!disposed.ok) {
    assert.equal(disposed.code, 'disposed');
  }
  const input = harness.manager.sendInput('file:///one', one.session.sessionId, 'x');
  assert.equal(input.ok, false);
  if (!input.ok) {
    assert.equal(input.code, 'disposed');
  }

  subscription.dispose();
  harness.manager.dispose();
  assert.equal(harness.processes[0].killCount, 1);
});

test('parsePtyClientMessage validates types, ids, input size and resize bounds', () => {
  const validInput = parsePtyClientMessage({
    type: 'input',
    sessionId: 'session-1',
    data: '\u0003\u001b[A\r',
  });
  assert.equal(validInput.ok, true);
  if (validInput.ok) {
    assert.equal(validInput.message.type, 'input');
  }

  const validResize = parsePtyClientMessage(
    { type: 'resize', sessionId: 'session-1', cols: 80, rows: 24 },
    100,
    120,
    60,
  );
  assert.equal(validResize.ok, true);

  assert.equal(parsePtyClientMessage(null).ok, false);
  assert.equal(parsePtyClientMessage({ type: 'paste', sessionId: 'session-1' }).ok, false);
  assert.equal(
    parsePtyClientMessage({ type: 'input', sessionId: 'bad id!', data: 'x' }).ok,
    false,
  );
  assert.equal(
    parsePtyClientMessage({ type: 'input', sessionId: 'session-1', data: '' }).ok,
    false,
  );
  assert.equal(
    parsePtyClientMessage(
      { type: 'input', sessionId: 'session-1', data: '123456' },
      5,
    ).ok,
    false,
  );
  assert.equal(
    parsePtyClientMessage(
      { type: 'resize', sessionId: 'session-1', cols: 121, rows: 24 },
      100,
      120,
      60,
    ).ok,
    false,
  );
  assert.equal(
    parsePtyClientMessage(
      { type: 'resize', sessionId: 'session-1', cols: 0, rows: 24 },
      100,
      120,
      60,
    ).ok,
    false,
  );
  assert.equal(
    parsePtyClientMessage(
      { type: 'resize', sessionId: 'session-1', cols: 80, rows: 24.5 },
      100,
      120,
      60,
    ).ok,
    false,
  );
});

test('handleMessage rejects malformed messages before writing', () => {
  const harness = createHarness();
  const result = harness.manager.ensure('file:///work', launch());
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  const unknown = harness.manager.handleMessage('file:///work', { type: 'paste' });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.code, 'invalid-message');
  }

  const badSession = harness.manager.handleMessage('file:///work', {
    type: 'input',
    sessionId: 'session-999',
    data: 'x',
  });
  assert.equal(badSession.ok, false);
  if (!badSession.ok) {
    assert.equal(badSession.code, 'stale-session');
  }

  assert.deepEqual(harness.processes[0].writes, ['opencode\r']);
});

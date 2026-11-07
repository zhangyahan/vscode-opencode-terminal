import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ATTACHMENTS,
  MAX_DROP_FIELD_LENGTH,
  MAX_LAUNCH_COMMAND_LENGTH,
  MAX_PTY_INPUT_LENGTH,
  MAX_WEBVIEW_IDS,
  SELECTION_TTL_MS,
  TerminalRegistry,
  appendReference,
  invalidateSelectionCache,
  matchSelection,
  parseWebviewMessage,
  pickReferences,
  recordSelection,
  referenceMention,
  removeReferences,
  restoreReferences,
  terminalStatusText,
  validateLaunchCommand,
  type SelectionSnapshot,
  type StoredReference,
} from '../src/runtime';
import type { TextRange } from '../src/core';

function range(startLine: number, endLine: number, endCharacter = 0): TextRange {
  return {
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: endCharacter },
  };
}

function reference(overrides: Partial<StoredReference> = {}): StoredReference {
  return {
    id: 'ref-1',
    filePath: '/work/src/a.ts',
    rootPath: '/work',
    folderKey: 'file:///work',
    folderName: 'work',
    outsideWorkspace: false,
    addedAt: 1,
    ...overrides,
  };
}

test('parseWebviewMessage accepts simple and drop messages', () => {
  const ready = parseWebviewMessage({ type: 'ready' });
  assert.equal(ready.ok, true);
  if (ready.ok) {
    assert.equal(ready.message.type, 'ready');
  }

  const drop = parseWebviewMessage({
    type: 'drop',
    uriList: 'file:///work/a.ts',
    codeUriList: 'file:///work/b.ts',
    plainText: 'const a = 1;',
  });
  assert.equal(drop.ok, true);
  if (drop.ok && drop.message.type === 'drop') {
    assert.equal(drop.message.uriList, 'file:///work/a.ts');
    assert.equal(drop.message.codeUriList, 'file:///work/b.ts');
    assert.equal(drop.message.plainText, 'const a = 1;');
  }
});

test('parseWebviewMessage validates ids in insert/copy/remove messages', () => {
  for (const type of ['insert', 'copy', 'remove'] as const) {
    const valid = parseWebviewMessage({ type, ids: ['abc-123', 'def_456'] });
    assert.equal(valid.ok, true);
    if (valid.ok && valid.message.type === type) {
      assert.deepEqual(valid.message.ids, ['abc-123', 'def_456']);
    }

    assert.equal(parseWebviewMessage({ type, ids: 'abc' }).ok, false);
    assert.equal(parseWebviewMessage({ type, ids: [] }).ok, false);
    assert.equal(parseWebviewMessage({ type, ids: ['bad id'] }).ok, false);
    assert.equal(
      parseWebviewMessage({
        type,
        ids: Array.from({ length: MAX_WEBVIEW_IDS + 1 }, (_, index) => `id-${index}`),
      }).ok,
      false,
    );
  }
});

test('parseWebviewMessage rejects unknown and malformed messages', () => {
  for (const value of [null, undefined, 42, 'ready', [], { type: 42 }, { type: 'unknown' }]) {
    assert.equal(parseWebviewMessage(value).ok, false);
  }
});

test('parseWebviewMessage rejects oversized or non-string drop fields', () => {
  const oversized = parseWebviewMessage({
    type: 'drop',
    uriList: 'a'.repeat(MAX_DROP_FIELD_LENGTH + 1),
  });
  assert.equal(oversized.ok, false);

  const wrongType = parseWebviewMessage({
    type: 'drop',
    codeEditors: { resource: 'file:///work/a.ts' },
  });
  assert.equal(wrongType.ok, false);

  const empty = parseWebviewMessage({ type: 'drop' });
  assert.equal(empty.ok, true);
});

test('validateLaunchCommand only accepts a single safe command line', () => {
  assert.deepEqual(validateLaunchCommand('opencode'), {
    ok: true,
    command: 'opencode',
  });
  assert.deepEqual(validateLaunchCommand('  opencode --foo  '), {
    ok: true,
    command: 'opencode --foo',
  });

  for (const value of [
    '',
    '   ',
    'opencode --foo\nrm -rf /',
    'opencode\r\nwhoami',
    'opencode\u001b[31m',
    'a'.repeat(MAX_LAUNCH_COMMAND_LENGTH + 1),
    undefined,
    42,
  ]) {
    assert.equal(validateLaunchCommand(value).ok, false);
  }
});

test('terminalStatusText reports created without claiming the CLI runs', () => {
  const created = terminalStatusText('created', 'demo');
  assert.match(created, /已创建/);
  assert.match(created, /请确认 OpenCode 已就绪/);
  assert.match(created, /不会验证/);

  assert.match(terminalStatusText('untrusted'), /限制模式/);
  assert.match(terminalStatusText('no-workspace'), /未打开工作区/);
  assert.match(terminalStatusText('closed', 'demo'), /已关闭/);
});

test('TerminalRegistry reuses usable terminals per workspace key', () => {
  const registry = new TerminalRegistry<{ id: number; alive: boolean }>();
  let nextId = 1;
  const create = () => ({ id: nextId++, alive: true });

  const first = registry.acquire('file:///a', create, (terminal) => terminal.alive);
  assert.equal(first.created, true);
  assert.equal(first.terminal.id, 1);

  const reused = registry.acquire('file:///a', create, (terminal) => terminal.alive);
  assert.equal(reused.created, false);
  assert.equal(reused.terminal, first.terminal);

  const other = registry.acquire('file:///b', create, (terminal) => terminal.alive);
  assert.equal(other.created, true);
  assert.equal(other.terminal.id, 2);
  assert.equal(registry.size, 2);

  first.terminal.alive = false;
  const replaced = registry.acquire('file:///a', create, (terminal) => terminal.alive);
  assert.equal(replaced.created, true);
  assert.equal(replaced.terminal.id, 3);
  assert.equal(registry.get('file:///a'), replaced.terminal);
});

test('TerminalRegistry removes terminals both by key and by value', () => {
  const registry = new TerminalRegistry<{ id: number }>();
  let nextId = 1;
  const create = () => ({ id: nextId++ });

  const first = registry.acquire('a', create, () => true);
  registry.acquire('b', create, () => true);

  assert.equal(registry.removeValue(first.terminal), 'a');
  assert.equal(registry.get('a'), undefined);
  assert.deepEqual(registry.keys(), ['b']);

  assert.deepEqual(registry.remove('b'), { id: 2 });
  assert.equal(registry.size, 0);
});

test('appendReference validates, deduplicates and enforces the limit', () => {
  const firstRef = reference();
  const first = appendReference([], firstRef);
  assert.equal(first.added, true);
  if (first.added) {
    assert.equal(first.references.length, 1);
  }
  const existing = first.references;

  const duplicate = appendReference(existing, {
    ...firstRef,
    id: 'ref-2',
  });
  assert.equal(duplicate.added, false);
  if (!duplicate.added) {
    assert.equal(duplicate.reason, 'duplicate');
  }

  const spaced = appendReference(existing, {
    ...firstRef,
    id: 'ref-3',
    filePath: '/work/src/a file.ts',
  });
  assert.equal(spaced.added, false);
  if (!spaced.added) {
    assert.equal(spaced.reason, 'invalid');
  }

  const atLimit = appendReference(
    [
      reference({ id: 'a', filePath: '/work/a.ts' }),
      reference({ id: 'b', filePath: '/work/b.ts' }),
    ],
    reference({ id: 'c', filePath: '/work/c.ts' }),
    2,
  );
  assert.equal(atLimit.added, false);
  if (!atLimit.added) {
    assert.equal(atLimit.reason, 'limit');
  }
});

test('referenceMention applies range formatting through the core', () => {
  assert.equal(referenceMention(reference()), '@src/a.ts');
  assert.equal(
    referenceMention(reference({ range: range(0, 1) })),
    '@src/a.ts#1-1',
  );
  assert.equal(
    referenceMention(reference({ filePath: '/work/a b.ts' })),
    undefined,
  );
});

test('restoreReferences drops unsafe entries and duplicates', () => {
  const restored = restoreReferences([
    reference(),
    reference({ id: 'ref-2' }),
    reference({ id: 'ref-3', filePath: '/work/a b.ts' }),
    reference({ id: 'bad id', filePath: '/work/other.ts' }),
    {
      ...reference({ id: 'ref-4', filePath: '/work/b.ts' }),
      range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } },
    },
  ]);

  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, 'ref-1');
  assert.deepEqual(restoreReferences('not-an-array'), []);
});

test('removeReferences and pickReferences preserve requested ids only', () => {
  const list = [
    reference({ id: 'a', filePath: '/work/a.ts' }),
    reference({ id: 'b', filePath: '/work/b.ts' }),
    reference({ id: 'c', filePath: '/work/c.ts' }),
  ];

  assert.deepEqual(
    removeReferences(list, ['b']).map((item) => item.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    pickReferences(list, ['c', 'missing', 'a']).map((item) => item.id),
    ['a', 'c'],
  );
});

test('selection cache records only non-empty, bounded selections', () => {
  const snapshot: SelectionSnapshot = {
    uri: 'file:///work/a.ts',
    text: 'const a = 1;',
    range: range(0, 0, 12),
    capturedAt: 1000,
  };

  const recorded = recordSelection([], snapshot, 2000);
  assert.equal(recorded.length, 1);

  const empty = recordSelection(recorded, { ...snapshot, text: '' }, 2000);
  assert.equal(empty.length, 1);

  const same = recordSelection(recorded, { ...snapshot, capturedAt: 3000 }, 4000);
  assert.equal(same.length, 1);
  assert.equal(same[0].capturedAt, 3000);
});

test('invalidateSelectionCache clears only the changed document', () => {
  const a: SelectionSnapshot = {
    uri: 'file:///work/a.ts',
    text: 'a',
    range: range(0, 0, 1),
    capturedAt: 1000,
  };
  const b: SelectionSnapshot = {
    ...a,
    uri: 'file:///work/b.ts',
    text: 'b',
  };

  const remaining = invalidateSelectionCache([a, b], 'file:///work/a.ts');
  assert.deepEqual(
    remaining.map((entry) => entry.uri),
    ['file:///work/b.ts'],
  );
  assert.deepEqual(
    invalidateSelectionCache([a, b], 'file:///work/missing.ts').length,
    2,
  );
});

test('matchSelection requires an exact unique fresh match', () => {
  const snapshot: SelectionSnapshot = {
    uri: 'file:///work/a.ts',
    text: 'const a = 1;',
    range: range(0, 0, 12),
    capturedAt: 1000,
  };

  assert.deepEqual(matchSelection([snapshot], 'const a = 1;', 2000), {
    ok: true,
    entry: snapshot,
  });
  assert.deepEqual(matchSelection([snapshot], 'const a = 1', 2000), {
    ok: false,
    reason: 'no-match',
  });
  assert.deepEqual(matchSelection([snapshot], '', 2000), {
    ok: false,
    reason: 'empty',
  });
  assert.deepEqual(
    matchSelection([snapshot], 'const a = 1;', 1000 + SELECTION_TTL_MS + 1),
    { ok: false, reason: 'expired' },
  );
});

test('matchSelection treats different URI/range matches as ambiguous', () => {
  const base: SelectionSnapshot = {
    uri: 'file:///work/a.ts',
    text: 'selected',
    range: range(0, 0, 8),
    capturedAt: 1000,
  };

  const sameRange = matchSelection(
    [base, { ...base, capturedAt: 1200 }],
    'selected',
    2000,
  );
  assert.equal(sameRange.ok, true);

  const ambiguous = matchSelection(
    [base, { ...base, range: range(2, 2, 8) }],
    'selected',
    2000,
  );
  assert.deepEqual(ambiguous, { ok: false, reason: 'ambiguous' });

  const filtered = matchSelection(
    [base, { ...base, uri: 'file:///work/b.ts', range: range(2, 2, 8) }],
    'selected',
    2000,
    SELECTION_TTL_MS,
    'file:///work/b.ts',
  );
  assert.equal(filtered.ok, true);
  if (filtered.ok) {
    assert.equal(filtered.entry.uri, 'file:///work/b.ts');
  }
});

test('selection cache expires old entries and caps its size', () => {  const old: SelectionSnapshot = {
    uri: 'file:///work/a.ts',
    text: 'old',
    range: range(0, 0, 3),
    capturedAt: 1000,
  };
  const newSnapshot: SelectionSnapshot = {
    ...old,
    text: 'new',
    capturedAt: 1000 + SELECTION_TTL_MS + 1,
  };

  const recorded = recordSelection([old], newSnapshot, 1000 + SELECTION_TTL_MS + 1);
  assert.deepEqual(recorded.map((item) => item.text), ['new']);

  const capped = recordSelection([], newSnapshot, newSnapshot.capturedAt, SELECTION_TTL_MS, 2);
  assert.equal(capped.length, 1);

  let entries: readonly SelectionSnapshot[] = [];
  for (let index = 0; index < 5; index++) {
    entries = recordSelection(
      entries,
      { ...newSnapshot, text: `text-${index}` },
      newSnapshot.capturedAt,
      SELECTION_TTL_MS,
      3,
    );
  }
  assert.deepEqual(
    entries.map((item) => item.text),
    ['text-2', 'text-3', 'text-4'],
  );
});

test('MAX_ATTACHMENTS is exposed for UI and validation', () => {
  assert.equal(Number.isSafeInteger(MAX_ATTACHMENTS), true);
  assert.equal(MAX_ATTACHMENTS > 0, true);
});

test('parseWebviewMessage validates PTY input, resize, attach and clipboard messages', () => {
  const control = parseWebviewMessage({
    type: 'ptyInput',
    sessionId: 'session-1',
    data: '\u0003\u001b[A',
  });
  assert.equal(control.ok, true);
  if (control.ok && control.message.type === 'ptyInput') {
    assert.equal(control.message.data, '\u0003\u001b[A');
  }

  assert.equal(
    parseWebviewMessage({ type: 'ptyInput', sessionId: 'bad id', data: 'x' }).ok,
    false,
  );
  assert.equal(
    parseWebviewMessage({ type: 'ptyInput', sessionId: 'session-1', data: '' }).ok,
    false,
  );
  assert.equal(
    parseWebviewMessage({
      type: 'ptyInput',
      sessionId: 'session-1',
      data: 'a'.repeat(MAX_PTY_INPUT_LENGTH + 1),
    }).ok,
    false,
  );

  assert.equal(
    parseWebviewMessage({
      type: 'ptyResize',
      sessionId: 'session-1',
      cols: 120,
      rows: 40,
    }).ok,
    true,
  );
  assert.equal(
    parseWebviewMessage({
      type: 'ptyResize',
      sessionId: 'session-1',
      cols: 0,
      rows: 40,
    }).ok,
    false,
  );

  const ready = parseWebviewMessage({ type: 'ready', cols: 101, rows: 19 });
  assert.equal(ready.ok, true);
  if (ready.ok && ready.message.type === 'ready') {
    assert.equal(ready.message.cols, 101);
    assert.equal(ready.message.rows, 19);
  }
  assert.equal(
    parseWebviewMessage({ type: 'ready', cols: 0, rows: 19 }).ok,
    false,
  );
  assert.equal(
    parseWebviewMessage({ type: 'attach', cols: 80, rows: 24 }).ok,
    true,
  );
  assert.equal(
    parseWebviewMessage({ type: 'attach', cols: 0, rows: 24 }).ok,
    false,
  );
  assert.equal(parseWebviewMessage({ type: 'copyClipboard', text: 'x' }).ok, true);
  assert.equal(parseWebviewMessage({ type: 'copyClipboard', text: 1 }).ok, false);
});

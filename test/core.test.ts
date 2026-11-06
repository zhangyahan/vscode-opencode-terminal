import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatMention,
  parseDropPayload,
  type FormatMentionSuccess,
  type TextRange,
} from '../src/core';

function expectMention(filePath: string, rootPath: string, range?: TextRange): FormatMentionSuccess {
  const result = formatMention(filePath, rootPath, range);
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  return result as FormatMentionSuccess;
}

test('formatMention makes a POSIX path inside the workspace relative', () => {
  const result = expectMention('/workspace/src/core.ts', '/workspace');
  assert.equal(result.mention, '@src/core.ts');
  assert.equal(result.path, 'src/core.ts');
  assert.equal(result.outsideWorkspace, false);
  assert.equal(result.lines, undefined);
});

test('formatMention normalizes Windows separators and matches drive case', () => {
  const result = expectMention('C:\\Work\\src\\core.ts', 'c:/work');
  assert.equal(result.mention, '@src/core.ts');
  assert.equal(result.path, 'src/core.ts');
  assert.equal(result.outsideWorkspace, false);
});

test('formatMention keeps absolute paths outside the workspace', () => {
  const windows = expectMention('D:\\other\\src\\a.ts', 'C:\\Work');
  assert.equal(windows.mention, '@D:/other/src/a.ts');
  assert.equal(windows.outsideWorkspace, true);

  const posix = expectMention('/other/src/a.ts', '/workspace');
  assert.equal(posix.mention, '@/other/src/a.ts');
  assert.equal(posix.outsideWorkspace, true);
});

test('formatMention resolves relative paths and escapes outside the workspace', () => {
  const inside = expectMention('src/../src/a.ts', '/workspace');
  assert.equal(inside.mention, '@src/a.ts');

  const escaped = expectMention('../outside/a.ts', '/workspace/project');
  assert.equal(escaped.mention, '@/workspace/outside/a.ts');
  assert.equal(escaped.outsideWorkspace, true);
});

test('formatMention strips backslashes from UNC paths inside the share root', () => {
  const result = expectMention(
    '\\\\server\\share\\src\\a.ts',
    '\\\\server\\share',
  );
  assert.equal(result.mention, '@src/a.ts');
  assert.equal(result.outsideWorkspace, false);
});

test('formatMention allows a space-free relative path under a workspace with spaces', () => {
  const result = expectMention(
    '/work/my project/src/a.ts',
    '/work/my project',
  );
  assert.equal(result.mention, '@src/a.ts');
});

test('formatMention rejects mention paths that contain spaces', () => {
  const relative = formatMention('src/a file.ts', '/workspace');
  assert.equal(relative.ok, false);
  if (!relative.ok) {
    assert.equal(relative.code, 'path-with-spaces');
    assert.match(relative.message, /quoting syntax/i);
  }

  const outside = formatMention('/work/my project2/a.ts', '/work/my project');
  assert.equal(outside.ok, false);
  if (!outside.ok) {
    assert.equal(outside.code, 'path-with-spaces');
  }
});

test('formatMention rejects "#" because it is ambiguous with the line suffix', () => {
  const relative = formatMention('src/a#b.ts', '/workspace');
  assert.equal(relative.ok, false);
  if (!relative.ok) {
    assert.equal(relative.code, 'invalid-path');
    assert.match(relative.message, /ambiguous/i);
  }

  const absolute = formatMention('/work/a#b.ts', '/workspace');
  assert.equal(absolute.ok, false);
  if (!absolute.ok) {
    assert.equal(absolute.code, 'invalid-path');
  }
});

test('formatMention rejects control characters to prevent terminal injection', () => {
  const newline = formatMention('/workspace/src/a\n.ts', '/workspace');
  assert.equal(newline.ok, false);
  if (!newline.ok) {
    assert.equal(newline.code, 'control-character');
  }

  const escape = formatMention('/workspace/src/a\u001b[31m.ts', '/workspace');
  assert.equal(escape.ok, false);
  if (!escape.ok) {
    assert.equal(escape.code, 'control-character');
  }
});

test('formatMention rejects invalid roots and drive-relative paths', () => {
  const relativeRoot = formatMention('/work/a.ts', 'relative/root');
  assert.equal(relativeRoot.ok, false);
  if (!relativeRoot.ok) {
    assert.equal(relativeRoot.code, 'invalid-root');
  }

  const driveRelative = formatMention('C:a.ts', 'C:\\work');
  assert.equal(driveRelative.ok, false);
  if (!driveRelative.ok) {
    assert.equal(driveRelative.code, 'invalid-path');
  }

  const empty = formatMention('', '/work');
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.equal(empty.code, 'invalid-path');
  }
});

test('formatMention converts zero-based multi-line ranges to one-based lines', () => {
  const result = expectMention('/workspace/src/core.ts', '/workspace', {
    start: { line: 199, character: 0 },
    end: { line: 200, character: 5 },
  });
  assert.equal(result.mention, '@src/core.ts#200-201');
  assert.deepEqual(result.lines, { startLine: 200, endLine: 201 });
});

test('formatMention excludes the end line when end.character is zero', () => {
  const result = expectMention('/workspace/src/core.ts', '/workspace', {
    start: { line: 199, character: 4 },
    end: { line: 200, character: 0 },
  });
  assert.equal(result.mention, '@src/core.ts#200-200');
  assert.deepEqual(result.lines, { startLine: 200, endLine: 200 });
});

test('formatMention handles single-line and empty selections', () => {
  const single = expectMention('/workspace/src/core.ts', '/workspace', {
    start: { line: 4, character: 2 },
    end: { line: 4, character: 10 },
  });
  assert.equal(single.mention, '@src/core.ts#5-5');

  const empty = expectMention('/workspace/src/core.ts', '/workspace', {
    start: { line: 4, character: 0 },
    end: { line: 4, character: 0 },
  });
  assert.equal(empty.mention, '@src/core.ts');
  assert.equal(empty.lines, undefined);
});

test('formatMention rejects malformed ranges', () => {
  const backwards = formatMention('/workspace/a.ts', '/workspace', {
    start: { line: 5, character: 0 },
    end: { line: 4, character: 0 },
  });
  assert.equal(backwards.ok, false);
  if (!backwards.ok) {
    assert.equal(backwards.code, 'invalid-range');
  }

  const negative = formatMention('/workspace/a.ts', '/workspace', {
    start: { line: -1, character: 0 },
    end: { line: 2, character: 0 },
  });
  assert.equal(negative.ok, false);
  if (!negative.ok) {
    assert.equal(negative.code, 'invalid-range');
  }
});

test('parseDropPayload parses text/uri-list comments and preserves encoding', () => {
  const result = parseDropPayload({
    'text/uri-list':
      'file:///c%3A/Work/a%20b.ts\r\n# a comment\r\nfile:///c%3A/Work/c.ts\r\n',
  });

  assert.deepEqual(result.files.map((file) => file.uri), [
    'file:///c%3A/Work/a%20b.ts',
    'file:///c%3A/Work/c.ts',
  ]);
  assert.equal(result.plainText, undefined);
  assert.deepEqual(result.warnings, []);
});

test('parseDropPayload parses ResourceURLs and CodeFiles JSON', () => {
  const result = parseDropPayload({
    ResourceURLs: JSON.stringify(['file:///work/a.ts', 'file:///work/b.ts']),
    CodeFiles: ['file:///work/c.ts'],
  });

  assert.deepEqual(result.files.map((file) => file.uri), [
    'file:///work/a.ts',
    'file:///work/b.ts',
    'file:///work/c.ts',
  ]);
  assert.deepEqual(result.warnings, []);
});

test('parseDropPayload extracts a CodeEditors resource and selection', () => {
  const result = parseDropPayload({
    CodeEditors: JSON.stringify([
      {
        resource: 'file:///work/a.ts',
        selections: [
          {
            start: { line: 199, character: 0 },
            end: { line: 200, character: 0 },
          },
        ],
      },
    ]),
  });

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].uri, 'file:///work/a.ts');
  assert.deepEqual(result.files[0].range, {
    start: { line: 199, character: 0 },
    end: { line: 200, character: 0 },
  });
  assert.deepEqual(result.warnings, []);
});

test('parseDropPayload rebuilds a file URI from URI components without decoding', () => {
  const result = parseDropPayload({
    CodeEditors: [
      {
        resource: { scheme: 'file', path: '/c%3A/Work/a%20b.ts' },
        selection: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 },
        },
      },
    ],
  });

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].uri, 'file:///c%3A/Work/a%20b.ts');
  assert.deepEqual(result.files[0].range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 4 },
  });
});

test('parseDropPayload prefers a selection when the same file appears twice', () => {
  const result = parseDropPayload({
    'text/uri-list': 'file:///work/a.ts',
    CodeEditors: [
      {
        resource: 'file:///work/a.ts',
        selections: [
          {
            start: { line: 1, character: 0 },
            end: { line: 2, character: 0 },
          },
        ],
      },
    ],
  });

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].source, 'text/uri-list');
  assert.deepEqual(result.files[0].range, {
    start: { line: 1, character: 0 },
    end: { line: 2, character: 0 },
  });
});

test('parseDropPayload rejects non-file schemes', () => {
  const result = parseDropPayload({
    'text/uri-list': [
      'http://example.com/a.ts',
      'javascript:alert(1)',
      'file:///work/ok.ts',
    ].join('\n'),
  });

  assert.deepEqual(result.files.map((file) => file.uri), ['file:///work/ok.ts']);
  assert.equal(result.warnings.length, 2);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['unsupported-scheme', 'unsupported-scheme'],
  );
});

test('parseDropPayload reports invalid JSON and keeps other sources', () => {
  const result = parseDropPayload({
    ResourceURLs: '{not json',
    CodeFiles: ['file:///work/ok.ts'],
  });

  assert.deepEqual(result.files.map((file) => file.uri), ['file:///work/ok.ts']);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'invalid-json');
  assert.equal(result.warnings[0].source, 'ResourceURLs');
});

test('parseDropPayload ignores invalid entries and bad selections', () => {
  const result = parseDropPayload({
    ResourceURLs: JSON.stringify([42, '', 'not a uri', 'file:///work/ok.ts']),
    CodeEditors: [
      {
        resource: 'file:///work/bad-selection.ts',
        selections: [
          {
            start: { line: 2, character: 0 },
            end: { line: 1, character: 0 },
          },
        ],
      },
    ],
  });

  assert.deepEqual(result.files.map((file) => file.uri), [
    'file:///work/ok.ts',
    'file:///work/bad-selection.ts',
  ]);
  assert.equal(result.files[1].range, undefined);
  assert.equal(
    result.warnings.filter((warning) => warning.code === 'invalid-uri').length,
    3,
  );
  assert.equal(
    result.warnings.filter((warning) => warning.code === 'invalid-selection').length,
    1,
  );
});

test('parseDropPayload returns plain text separately and never as a file', () => {
  const code = 'const value = 1;\nconsole.log(value);\n@src/core.ts';
  const result = parseDropPayload({ 'text/plain': code });

  assert.deepEqual(result.files, []);
  assert.equal(result.plainText, code);
  assert.deepEqual(result.warnings, []);
});

test('parseDropPayload returns both files and plain text when both are present', () => {
  const result = parseDropPayload({
    'text/plain': 'selected code',
    'text/uri-list': 'file:///work/a.ts',
  });

  assert.equal(result.plainText, 'selected code');
  assert.deepEqual(result.files.map((file) => file.uri), ['file:///work/a.ts']);
});

test('parseDropPayload rejects unsupported payload containers', () => {
  for (const payload of [null, undefined, 42, 'text/uri-list']) {
    const result = parseDropPayload(payload);
    assert.deepEqual(result.files, []);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, 'unsupported-payload');
  }
});

test('parseDropPayload rejects invalid payload field types', () => {
  const result = parseDropPayload({
    'text/uri-list': 42,
    'text/plain': { not: 'a string' },
  });

  assert.deepEqual(result.files, []);
  assert.equal(result.plainText, undefined);
  assert.equal(
    result.warnings.filter((warning) => warning.code === 'unsupported-payload').length,
    2,
  );
});

test('parseDropPayload warns about file URIs with no path or control characters', () => {
  const result = parseDropPayload({
    'text/uri-list': [
      'file:',
      'file://',
      'file:///',
      'file:///work/a\u0000b.ts',
      'file:///work/ok.ts',
    ].join('\n'),
  });

  assert.deepEqual(result.files.map((file) => file.uri), ['file:///work/ok.ts']);
  assert.equal(result.warnings.length, 4);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['invalid-uri', 'invalid-uri', 'invalid-uri', 'invalid-uri'],
  );
});

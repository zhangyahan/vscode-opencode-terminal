import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REFERENCES,
  planReference,
  referenceKey,
  uniqueReferences,
  type ReferenceTarget,
} from '../src/references';

function target(
  range?: ReferenceTarget['range'],
  overrides: Partial<ReferenceTarget> = {},
): ReferenceTarget {
  return {
    uri: 'file:///C:/demo/src/a.ts',
    filePath: 'C:/demo/src/a.ts',
    rootPath: 'C:/demo',
    ...(range === undefined ? {} : { range }),
    ...overrides,
  };
}

test('whole-file references are always plain @path text without a fabricated range', () => {
  const plan = planReference(target());
  assert.equal(plan.kind, 'text');
  if (plan.kind === 'text') {
    assert.equal(plan.reason, 'whole-file-text');
    assert.equal(plan.mention, '@src/a.ts');
    assert.equal(plan.mention.includes('#'), false);
    assert.match(plan.message, /纯文本/);
    assert.match(plan.message, /手动确认/);
    assert.match(plan.message, /回车/);
  }

});

test('multi-line selection converts to one-based lines and uses the bridge', () => {
  const plan = planReference(
    target({
      start: { line: 10, character: 0 },
      end: { line: 12, character: 4 },
    }),
  );
  assert.equal(plan.kind, 'bridge');
  if (plan.kind === 'bridge') {
    assert.deepEqual(plan.lines, { startLine: 11, endLine: 13 });
    assert.equal(plan.mention, '@src/a.ts#11-13');
  }
});

test('end.character === 0 excludes the end line for multi-line selections', () => {
  const plan = planReference(
    target({
      start: { line: 10, character: 2 },
      end: { line: 12, character: 0 },
    }),
  );
  assert.equal(plan.kind, 'bridge');
  if (plan.kind === 'bridge') {
    assert.deepEqual(plan.lines, { startLine: 11, endLine: 12 });
    assert.equal(plan.mention, '@src/a.ts#11-12');
  }
});

test('single-line selections always fall back instead of widening to end of file', () => {
  const plan = planReference(
    target({
      start: { line: 4, character: 2 },
      end: { line: 4, character: 10 },
    }),
  );
  assert.equal(plan.kind, 'text');
  if (plan.kind === 'text') {
    assert.equal(plan.reason, 'single-line');
    assert.equal(plan.mention, '@src/a.ts#5-5');
    assert.match(plan.message, /单行/);
  }

  // A selection that starts at the beginning of the next line is still a
  // single line after the end.character === 0 correction.
  const collapsed = planReference(
    target({
      start: { line: 8, character: 3 },
      end: { line: 9, character: 0 },
    }),
  );
  assert.equal(collapsed.kind, 'text');
  if (collapsed.kind === 'text') {
    assert.equal(collapsed.reason, 'single-line');
  }
});

test('zero-width selections behave as whole-file plain text references', () => {
  const plan = planReference(
    target({
      start: { line: 4, character: 0 },
      end: { line: 4, character: 0 },
    }),
  );
  assert.equal(plan.kind, 'text');
  if (plan.kind === 'text') {
    assert.equal(plan.reason, 'whole-file-text');
    assert.equal(plan.mention, '@src/a.ts');
  }
});

test('invalid paths, ranges and missing URIs fall back without inventing a range', () => {
  const unsafe = planReference(
    target({ start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, {
      filePath: 'C:/demo/src/a b.ts',
    }),
  );
  assert.equal(unsafe.kind, 'text');
  if (unsafe.kind === 'text') {
    assert.equal(unsafe.reason, 'invalid-path');
    assert.equal(unsafe.mention, undefined);
  }

  const backwards = planReference(
    target({ start: { line: 5, character: 0 }, end: { line: 4, character: 0 } }),
  );
  assert.equal(backwards.kind, 'text');
  if (backwards.kind === 'text') {
    assert.equal(backwards.reason, 'invalid-range');
  }

  // A whole-file reference needs no URI because it is plain text; only a
  // bridge candidate reports a missing URI.
  const missingUriWholeFile = planReference(
    target(undefined, { uri: '' }),
  );
  assert.equal(missingUriWholeFile.kind, 'text');
  if (missingUriWholeFile.kind === 'text') {
    assert.equal(missingUriWholeFile.reason, 'whole-file-text');
    assert.equal(missingUriWholeFile.mention, '@src/a.ts');
  }

  const missingUriBridge = planReference(
    target(
      { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
      { uri: '' },
    ),
  );
  assert.equal(missingUriBridge.kind, 'text');
  if (missingUriBridge.kind === 'text') {
    assert.equal(missingUriBridge.reason, 'missing-uri');
    assert.equal(missingUriBridge.mention, '@src/a.ts#1-2');
  }
});

test('reference keys keep URI and range distinct and dedupe in first-seen order', () => {
  const whole = target();
  const multiA = target({
    start: { line: 0, character: 0 },
    end: { line: 1, character: 0 },
  });
  const multiB = target({
    start: { line: 2, character: 0 },
    end: { line: 3, character: 0 },
  });
  assert.notEqual(referenceKey(whole), referenceKey(multiA));
  assert.notEqual(referenceKey(multiA), referenceKey(multiB));

  const unique = uniqueReferences([whole, multiA, whole, multiB]);
  assert.deepEqual(unique, [whole, multiA, multiB]);

  const many = Array.from({ length: MAX_REFERENCES + 5 }, (_, index) =>
    target(undefined, { uri: `file:///C:/demo/src/${index}.ts` }),
  );
  assert.equal(uniqueReferences(many).length, MAX_REFERENCES);
});

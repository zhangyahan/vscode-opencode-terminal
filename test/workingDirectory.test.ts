import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveWorkingDirectory,
  type WorkingDirectoryResult,
} from '../src/workingDirectory';

const WINDOWS_WORKSPACE = 'D:/Workspace/FR';
const WINDOWS_HOME = 'C:/Users/tester';

function resolve(
  value: unknown,
  overrides: {
    readonly workspacePath?: string;
    readonly userHome?: string;
    readonly platform?: string;
  } = {},
): WorkingDirectoryResult {
  return resolveWorkingDirectory({
    value,
    workspacePath: overrides.workspacePath ?? WINDOWS_WORKSPACE,
    userHome: overrides.userHome ?? WINDOWS_HOME,
    platform: overrides.platform ?? 'win32',
  });
}

function pathOf(result: WorkingDirectoryResult): string {
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  return result.ok ? result.path : '';
}

test('empty or whitespace workingDirectory falls back to the workspace folder', () => {
  for (const value of [undefined, null, '', '   ']) {
    const result = resolve(value);
    assert.deepEqual(result, {
      ok: true,
      path: WINDOWS_WORKSPACE,
      source: 'workspace',
    });
  }

  assert.equal(
    pathOf(resolve(undefined, { workspacePath: 'D:\\Workspace\\FR' })),
    'D:\\Workspace\\FR',
    'the fallback must be the exact folder.fsPath',
  );
});

test('absolute workingDirectory is normalized without executing a shell', () => {
  assert.deepEqual(resolve('D:\\Workspace\\FR\\'), {
    ok: true,
    path: 'D:/Workspace/FR',
    source: 'configured',
  });
  assert.equal(pathOf(resolve('D:/Workspace/FR/apps/mobile/')), 'D:/Workspace/FR/apps/mobile');
});

test('only workspaceFolder, workspaceFolderBasename and userHome variables expand', () => {
  assert.equal(
    pathOf(resolve('${workspaceFolder}/sai-qx-student-client')),
    'D:/Workspace/FR/sai-qx-student-client',
  );
  assert.equal(
    pathOf(resolve('D:/Workspaces/${workspaceFolderBasename}/apps/mobile')),
    'D:/Workspaces/FR/apps/mobile',
  );
  assert.equal(pathOf(resolve('${userHome}/projects/fr')), 'C:/Users/tester/projects/fr');
});

test('env, command, unknown and unexpanded variables are rejected', () => {
  for (const value of [
    '${env:USERPROFILE}/projects/fr',
    '${command:some.command}/fr',
    '${unknownVariable}/fr',
    '${workspaceFolder/fr',
    '$env:USERPROFILE/projects/fr',
    '$(pwd)/projects/fr',
  ]) {
    const result = resolve(value);
    assert.equal(result.ok, false, `expected rejection: ${value}`);
    if (!result.ok) {
      assert.equal(
        result.code === 'unknown-variable' || result.code === 'command-substitution',
        true,
        `${value} -> ${result.code}`,
      );
    }
  }
});

test('control characters, drive-relative and non-absolute paths are rejected', () => {
  const control = resolve('D:/Workspace/FR\u0000/apps');
  assert.equal(control.ok, false);
  if (!control.ok) {
    assert.equal(control.code, 'control-character');
  }

  const driveRelative = resolve('D:Workspace/FR');
  assert.equal(driveRelative.ok, false);
  if (!driveRelative.ok) {
    assert.equal(driveRelative.code, 'drive-relative');
  }

  const relative = resolve('apps/mobile');
  assert.equal(relative.ok, false);
  if (!relative.ok) {
    assert.equal(relative.code, 'not-absolute');
  }

  const rootedWithoutDrive = resolve('/Workspace/FR');
  assert.equal(rootedWithoutDrive.ok, false);
  if (!rootedWithoutDrive.ok) {
    assert.equal(rootedWithoutDrive.code, 'not-absolute');
  }
});

test('non-string settings and invalid workspace paths are rejected', () => {
  const nonString = resolve(42);
  assert.equal(nonString.ok, false);
  if (!nonString.ok) {
    assert.equal(nonString.code, 'invalid-value');
  }

  const badWorkspace = resolve('D:/Workspace/FR', { workspacePath: 'relative/folder' });
  assert.equal(badWorkspace.ok, false);
  if (!badWorkspace.ok) {
    assert.equal(badWorkspace.code, 'invalid-workspace');
  }
});

test('UNC and POSIX absolute paths are accepted', () => {
  assert.equal(pathOf(resolve('//server/share/fr')), '//server/share/fr');
  assert.equal(
    pathOf(resolve('/home/tester/fr', { platform: 'linux' })),
    '/home/tester/fr',
  );
});

test('workingDirectory may contain spaces (unlike @ mention paths)', () => {
  assert.equal(
    pathOf(resolve('D:/Workspace/FR Project')),
    'D:/Workspace/FR Project',
  );
});

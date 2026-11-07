import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveShellProfile,
  type ShellLaunchConfig,
  type ShellProfileSnapshot,
} from '../src/shellProfile';

function posixSnapshot(overrides: Partial<ShellProfileSnapshot> = {}): ShellProfileSnapshot {
  return {
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin:/bin', HOME: '/home/dev', KEEP: 'base' },
    workspacePath: '/work/project',
    home: '/home/dev',
    fileExists: () => false,
    ...overrides,
  };
}

function windowsSnapshot(overrides: Partial<ShellProfileSnapshot> = {}): ShellProfileSnapshot {
  return {
    platform: 'win32',
    baseEnv: { Path: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    workspacePath: 'C:\\work',
    home: 'C:\\Users\\dev',
    fileExists: () => false,
    ...overrides,
  };
}

function expectOk(snapshot: ShellProfileSnapshot): ShellLaunchConfig {
  const result = resolveShellProfile(snapshot);
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  return result as ShellLaunchConfig;
}

test('explicit profile picks the first existing path and preserves args/env/cwd', () => {
  const config = expectOk(
    posixSnapshot({
      defaultProfile: 'zsh',
      envShell: '/bin/bash',
      profiles: {
        zsh: {
          path: ['/usr/bin/missing', '/usr/bin/zsh', '/bin/zsh'],
          args: ['-l'],
          env: { PROFILE: 'zsh', KEEP: 'profile', DELETE_ME: null },
        },
      },
      baseEnv: { PATH: '/usr/bin:/bin', KEEP: 'base', DELETE_ME: 'old' },
      integratedEnv: { KEEP: 'integrated', INTEGRATED: 'yes' },
      fileExists: (candidate) => candidate === '/usr/bin/zsh',
    }),
  );

  assert.equal(config.shellPath, '/usr/bin/zsh');
  assert.deepEqual(config.args, ['-l']);
  assert.equal(config.cwd, '/work/project');
  assert.equal(config.profileName, 'zsh');
  assert.equal(config.env.KEEP, 'profile');
  assert.equal(config.env.INTEGRATED, 'yes');
  assert.equal(config.env.PROFILE, 'zsh');
  assert.equal(config.env.DELETE_ME, undefined);
});

test('profile path and args expand userHome, workspaceFolder and env variables', () => {
  const config = expectOk(
    posixSnapshot({
      defaultProfile: 'custom',
      profiles: {
        custom: {
          path: ['~/bin/missing', '~/bin/zsh'],
          args: ['--login', '${workspaceFolder}', '${workspaceFolderBasename}'],
          env: {
            FOLDER: '${workspaceFolder}',
            BASENAME: '${workspaceFolderBasename}',
            HOME_COPY: '${userHome}',
            FLAGS: '${env:FLAGS}',
            SEP: '${pathSeparator}',
          },
        },
      },
      baseEnv: {
        PATH: '/usr/bin:/bin',
        FLAGS: '-x',
      },
      home: '/home/dev',
      fileExists: (candidate) => candidate === '/home/dev/bin/zsh',
    }),
  );

  assert.equal(config.shellPath, '/home/dev/bin/zsh');
  assert.deepEqual(config.args, ['--login', '/work/project', 'project']);
  assert.equal(config.env.FOLDER, '/work/project');
  assert.equal(config.env.BASENAME, 'project');
  assert.equal(config.env.HOME_COPY, '/home/dev');
  assert.equal(config.env.FLAGS, '-x');
  assert.equal(config.env.SEP, ':');
});

test('source-based profile prefers the shell detected by VS Code', () => {
  const config = expectOk(
    windowsSnapshot({
      defaultProfile: 'PowerShell',
      profiles: { PowerShell: { source: 'PowerShell' } },
      envShell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      fileExists: () => false,
    }),
  );

  assert.equal(config.shellPath, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.notEqual(config.shellPath.toLowerCase(), 'powershell.exe');
  assert.equal(config.profileName, 'PowerShell');
  assert.ok(
    config.warnings.some((warning) => warning.code === 'profile-source-fallback'),
  );
});

test('auto-detected profile missing from profiles still uses the detected shell', () => {
  const config = expectOk(
    posixSnapshot({
      defaultProfile: 'Git Bash',
      profiles: {},
      envShell: '/usr/bin/bash',
    }),
  );

  assert.equal(config.shellPath, '/usr/bin/bash');
  assert.ok(config.warnings.some((warning) => warning.code === 'profile-source-fallback'));
});

test('a source profile without a detected shell fails instead of guessing PowerShell', () => {
  const result = resolveShellProfile(
    windowsSnapshot({
      defaultProfile: 'PowerShell',
      profiles: { PowerShell: { source: 'PowerShell' } },
      envShell: undefined,
      baseEnv: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'unsupported-profile');
    assert.match(result.message, /PowerShell/i);
    assert.match(result.message, /explicit path|detected default shell/i);
    assert.ok(result.warnings.some((warning) => warning.code === 'profile-unsupported'));
  }
});

test('missing explicit path candidates fail without silently using another profile', () => {
  const result = resolveShellProfile(
    posixSnapshot({
      defaultProfile: 'zsh',
      envShell: '/bin/bash',
      profiles: { zsh: { path: ['/opt/missing/zsh', 'zsh'] } },
      fileExists: () => false,
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'unsupported-profile');
    assert.ok(result.warnings.some((warning) => warning.code === 'profile-path-missing'));
  }
});

test('no explicit profile uses vscode.env.shell', () => {
  const config = expectOk(posixSnapshot({ envShell: '/bin/bash' }));

  assert.equal(config.shellPath, '/bin/bash');
  assert.equal(config.profileName, undefined);
  assert.deepEqual(config.warnings, []);
});

test('fallback uses ComSpec on Windows and /bin/sh on POSIX with a warning', () => {
  const windows = expectOk(
    windowsSnapshot({
      envShell: undefined,
      baseEnv: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    }),
  );
  assert.equal(windows.shellPath, 'C:\\Windows\\System32\\cmd.exe');
  assert.ok(windows.warnings.some((warning) => warning.code === 'shell-fallback'));

  const posix = expectOk(posixSnapshot({ envShell: undefined, baseEnv: { PATH: '/bin' } }));
  assert.equal(posix.shellPath, '/bin/sh');
  assert.ok(posix.warnings.some((warning) => warning.code === 'shell-fallback'));

  const missing = resolveShellProfile(
    windowsSnapshot({ envShell: undefined, baseEnv: {} }),
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, 'missing-shell');
  }
});

test('Windows keeps a single argument string; POSIX rejects a string instead of splitting', () => {
  const windows = expectOk(
    windowsSnapshot({
      defaultProfile: 'cmd',
      profiles: { cmd: { path: 'C:\\Windows\\System32\\cmd.exe', args: '/k echo hi' } },
      fileExists: (candidate) => candidate === 'C:\\Windows\\System32\\cmd.exe',
    }),
  );
  assert.equal(windows.args, '/k echo hi');

  const posix = resolveShellProfile(
    posixSnapshot({
      defaultProfile: 'bash',
      profiles: { bash: { path: '/bin/bash', args: '-l -i' } },
      fileExists: (candidate) => candidate === '/bin/bash',
    }),
  );
  assert.equal(posix.ok, false);
  if (!posix.ok) {
    assert.equal(posix.code, 'unsupported-args');
    assert.match(posix.message, /cannot split|array/i);
    assert.ok(posix.warnings.some((warning) => warning.code === 'args-rejected'));
  }
});

test('profile env merges over integrated env with case-insensitive Windows keys and null deletion', () => {
  const config = expectOk(
    windowsSnapshot({
      defaultProfile: 'cmd',
      profiles: {
        cmd: {
          path: 'C:\\Windows\\System32\\cmd.exe',
          env: {
            electron_enable_logging: '1',
            PATH: '${env:Path};C:\\Tools',
            BASENAME: '${workspaceFolderBasename}',
            HOME_COPY: '${userHome}',
            KEEP: 'profile',
          },
        },
      },
      baseEnv: {
        Path: 'C:\\Windows',
        ELECTRON_RUN_AS_NODE: '1',
        delete_me: 'old',
        KEEP: 'base',
      },
      integratedEnv: {
        PATH: 'C:\\Integrated;${env:Path}',
        ELECTRON_NO_ATTACH_CONSOLE: '1',
        DELETE_ME: null,
        KEEP: 'integrated',
      },
      fileExists: (candidate) => candidate === 'C:\\Windows\\System32\\cmd.exe',
    }),
  );

  const pathKeys = Object.keys(config.env).filter((key) => key.toLowerCase() === 'path');
  assert.deepEqual(pathKeys, ['Path']);
  assert.equal(config.env.Path, 'C:\\Integrated;C:\\Windows;C:\\Tools');
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(config.env.ELECTRON_NO_ATTACH_CONSOLE, undefined);
  assert.equal(config.env.electron_enable_logging, undefined);
  assert.equal(config.env.DELETE_ME, undefined);
  assert.equal(config.env.delete_me, undefined);
  assert.equal(config.env.KEEP, 'profile');
  assert.equal(config.env.BASENAME, 'work');
  assert.equal(config.env.HOME_COPY, 'C:\\Users\\dev');
});

test('profile path resolves bare command names through the injected PATH probe', () => {
  const windows = expectOk(
    windowsSnapshot({
      defaultProfile: 'pwsh',
      profiles: { pwsh: { path: 'pwsh' } },
      baseEnv: {
        Path: 'C:\\Windows;C:\\Program Files\\PowerShell',
        PATHEXT: '.EXE;.CMD',
      },
      fileExists: (candidate) =>
        candidate.toLowerCase() === 'c:\\program files\\powershell\\pwsh.exe',
    }),
  );
  assert.equal(
    windows.shellPath.toLowerCase(),
    'c:\\program files\\powershell\\pwsh.exe',
  );

  const posix = expectOk(
    posixSnapshot({
      defaultProfile: 'zsh',
      profiles: { zsh: { path: 'zsh' } },
      baseEnv: { PATH: '/usr/local/bin:/usr/bin' },
      fileExists: (candidate) => candidate === '/usr/bin/zsh',
    }),
  );
  assert.equal(posix.shellPath, '/usr/bin/zsh');
});

test('unresolved variables warn by name and never expose environment values', () => {
  const config = expectOk(
    posixSnapshot({
      envShell: '/bin/bash',
      integratedEnv: { TOKEN: 'super-secret-value' },
      profiles: {
        bash: {
          path: '/bin/bash',
          env: { COPY: '${env:TOKEN}', MISSING: '${env:NOT_SET}', UNKNOWN: '${notAVariable}' },
        },
      },
      defaultProfile: 'bash',
      fileExists: (candidate) => candidate === '/bin/bash',
    }),
  );

  assert.equal(config.env.COPY, 'super-secret-value');
  assert.equal(config.env.MISSING, '');
  assert.equal(config.env.UNKNOWN, '${notAVariable}');
  assert.ok(config.warnings.some((warning) => warning.code === 'env-variable-unresolved'));
  assert.ok(config.warnings.some((warning) => warning.code === 'unknown-variable'));

  const serializedWarnings = JSON.stringify(config.warnings);
  assert.equal(serializedWarnings.includes('super-secret-value'), false);
  assert.match(serializedWarnings, /NOT_SET/);
});

test('an invalid workspace path is rejected before spawning', () => {
  const result = resolveShellProfile(
    posixSnapshot({ workspacePath: '', envShell: '/bin/bash' }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'invalid-workspace');
  }
});

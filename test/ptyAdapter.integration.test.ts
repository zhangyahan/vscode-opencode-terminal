import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';

import { spawnPty } from '../src/ptyAdapter';

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

test('prebuilt N-API node-pty loads and runs a short child process', async () => {
  const windows = process.platform === 'win32';
  const shell = windows ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh';
  const args = windows
    ? ['/d', '/c', 'echo PTY_NATIVE_OK']
    : ['-c', 'printf PTY_NATIVE_OK'];

  const child = spawnPty(shell, args, {
    cwd: os.tmpdir(),
    env: {
      ...baseEnv(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
    cols: 80,
    rows: 24,
  });

  let output = '';
  let exitCode: number | undefined;
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill();
      } catch {
        // The child may already be gone.
      }
      reject(new Error(`PTY smoke test timed out. Output so far: ${JSON.stringify(output)}`));
    }, 15_000);

    child.onData((data) => {
      output += data;
    });
    child.onExit((event) => {
      exitCode = event.exitCode;
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });

  assert.equal(exitCode, 0);
  assert.match(output, /PTY_NATIVE_OK/);
  // This proves the prebuilt native module loads and spawns under plain Node.
  // It does not by itself prove Electron ABI compatibility; see README.
});

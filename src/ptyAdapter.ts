/**
 * Thin adapter around the prebuilt N-API build of node-pty.
 *
 * The native module is loaded lazily so activating the extension in an
 * untrusted workspace never touches it. `@lydell/node-pty` publishes
 * platform-specific optional packages with prebuilt binaries and never runs
 * node-gyp.
 */

import type { PtyDisposable, PtyProcess, PtySpawn } from './ptySession';

type NodePtyModule = typeof import('@lydell/node-pty');

let cached: NodePtyModule | undefined;

function loadNodePty(): NodePtyModule {
  if (cached === undefined) {
    cached = require('@lydell/node-pty') as NodePtyModule;
  }
  return cached;
}

/**
 * Default spawn implementation used by the extension. Tests inject their own
 * `PtySpawn`, so this file is the only place that links the native module.
 */
export const spawnPty: PtySpawn = (shellPath, args, options): PtyProcess => {
  const pty = loadNodePty();
  const child = pty.spawn(shellPath, args, {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
  });

  return {
    write(data: string): void {
      child.write(data);
    },
    resize(cols: number, rows: number): void {
      child.resize(cols, rows);
    },
    kill(): void {
      try {
        child.kill();
      } catch {
        // The process may have exited between the call and the signal.
      }
    },
    onData(listener: (data: string) => void): PtyDisposable {
      return child.onData(listener);
    },
    onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): PtyDisposable {
      return child.onExit((event) => {
        listener(event);
      });
    },
  };
};

import * as vscode from 'vscode';

import { TerminalRegistry } from './runtime';

export const TERMINAL_OWNER_ENV = 'OPENCODE_TERMINAL_OWNER';
export const TERMINAL_FOLDER_ENV = 'OPENCODE_TERMINAL_FOLDER';
export const TERMINAL_OWNER_VALUE = 'vscode-opencode-terminal';

export interface ClosedTerminal {
  readonly folderKey: string;
  readonly terminal: vscode.Terminal;
}

export interface EnsureTerminalResult {
  readonly terminal: vscode.Terminal;
  readonly created: boolean;
  /** True when an existing terminal was adopted after an extension reload. */
  readonly restored: boolean;
}

function ownedFolderKey(terminal: vscode.Terminal): string | undefined {
  const options = terminal.creationOptions as vscode.TerminalOptions;
  const env = options.env;
  if (env === undefined) {
    return undefined;
  }
  if (env[TERMINAL_OWNER_ENV] !== TERMINAL_OWNER_VALUE) {
    return undefined;
  }
  const folderKey = env[TERMINAL_FOLDER_ENV];
  return typeof folderKey === 'string' && folderKey.length > 0
    ? folderKey
    : undefined;
}

/**
 * Owns OpenCode terminals, one per workspace folder.
 *
 * The terminal is a regular VS Code integrated terminal. VS Code does not allow
 * a webview to embed the terminal surface, so the webview only shows the
 * reference list and the terminal stays in the panel.
 *
 * Terminals carry an env marker and their workspace URI. After an extension
 * reload the registry is empty but the user's terminal survives, so the
 * constructor adopts matching live terminals instead of starting a second
 * OpenCode process.
 */
export class OpenCodeTerminals implements vscode.Disposable {
  private readonly registry = new TerminalRegistry<vscode.Terminal>();
  private readonly closeListener: vscode.Disposable;
  private readonly closeEmitter = new vscode.EventEmitter<ClosedTerminal>();

  readonly onDidClose = this.closeEmitter.event;

  constructor() {
    this.closeListener = vscode.window.onDidCloseTerminal((terminal) => {
      const folderKey = this.registry.removeValue(terminal);
      if (folderKey !== undefined) {
        this.closeEmitter.fire({ folderKey, terminal });
      }
    });
    this.adoptExistingTerminals();
  }

  get(folderKey: string): vscode.Terminal | undefined {
    return this.registry.get(folderKey);
  }

  /**
   * Returns the existing terminal for a folder or creates it and sends the
   * configured command. Restored/reused terminals never receive the start
   * command again. `created` lets the caller avoid focusing a terminal on every
   * webview visibility change.
   */
  ensure(folder: vscode.WorkspaceFolder, command: string): EnsureTerminalResult {
    const folderKey = folder.uri.toString();
    const existing = this.registry.get(folderKey);
    if (existing !== undefined && existing.exitStatus === undefined) {
      return { terminal: existing, created: false, restored: false };
    }
    if (existing !== undefined) {
      this.registry.remove(folderKey);
    }

    const restored = this.findOwnedTerminal(folderKey);
    if (restored !== undefined) {
      this.registry.adopt(folderKey, restored);
      return { terminal: restored, created: false, restored: true };
    }

    const acquired = this.registry.acquire(
      folderKey,
      () => {
        const terminal = vscode.window.createTerminal({
          name: `OpenCode — ${folder.name}`,
          cwd: folder.uri,
          location: vscode.TerminalLocation.Panel,
          iconPath: new vscode.ThemeIcon('terminal'),
          env: {
            [TERMINAL_OWNER_ENV]: TERMINAL_OWNER_VALUE,
            [TERMINAL_FOLDER_ENV]: folderKey,
          },
        });
        // Starting the configured command is allowed to submit; inserting a
        // reference later deliberately uses sendText(text, false).
        terminal.sendText(command, true);
        return terminal;
      },
      (terminal) => terminal.exitStatus === undefined,
    );
    return { ...acquired, restored: false };
  }

  dispose(): void {
    this.closeListener.dispose();
    this.closeEmitter.dispose();
  }

  private adoptExistingTerminals(): void {
    const folders = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((folder) =>
        folder.uri.toString(),
      ),
    );
    for (const terminal of vscode.window.terminals) {
      if (terminal.exitStatus !== undefined) {
        continue;
      }
      const folderKey = ownedFolderKey(terminal);
      if (folderKey !== undefined && folders.has(folderKey)) {
        this.registry.adopt(folderKey, terminal);
      }
    }
  }

  private findOwnedTerminal(folderKey: string): vscode.Terminal | undefined {
    for (const terminal of vscode.window.terminals) {
      if (terminal.exitStatus !== undefined) {
        continue;
      }
      if (ownedFolderKey(terminal) === folderKey) {
        return terminal;
      }
    }
    return undefined;
  }
}

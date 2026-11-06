import { test } from 'node:test';
import assert from 'node:assert/strict';

const moduleLoader = require('node:module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

class MockUri {
  readonly value: string;
  readonly scheme: string;
  readonly fsPath: string;

  constructor(value: string, scheme: string, fsPath: string) {
    this.value = value;
    this.scheme = scheme;
    this.fsPath = fsPath;
  }

  static file(filePath: string): MockUri {
    const normalized = filePath.replace(/\\/g, '/');
    return new MockUri(
      `file:///${normalized.replace(/^\/+/, '')}`,
      'file',
      filePath,
    );
  }

  static parse(value: string): MockUri {
    if (value.startsWith('file:///')) {
      return new MockUri(
        value,
        'file',
        decodeURIComponent(value.slice('file:///'.length)),
      );
    }
    return new MockUri(value, value.split(':')[0], value);
  }

  static joinPath(base: MockUri, ...parts: string[]): MockUri {
    return new MockUri(
      `${base.value.replace(/\/+$/, '')}/${parts.join('/')}`,
      'file',
      `${base.fsPath.replace(/[\\/]+$/, '')}/${parts.join('/')}`,
    );
  }

  toString(): string {
    return this.value;
  }
}

class MockEventEmitter {
  private readonly listeners = new Set<(value: unknown) => void>();

  readonly event = (listener: (value: unknown) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: unknown): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

interface MockTerminal {
  exitStatus: { readonly code: number } | undefined;
  creationOptions: Record<string, unknown>;
  sendText(text: string, submit: boolean): void;
  show(): void;
}

interface MockContext {
  subscriptions: Array<{ dispose(): void }>;
  extensionUri: MockUri;
  workspaceState: {
    get(key: string): unknown;
    update(key: string, value: unknown): Promise<void>;
  };
}

test('mock VS Code integration: commands, CSP, terminal reuse and reload recovery', async () => {
  const folder = { name: 'demo', uri: MockUri.file('C:/demo') };
  const extensionUri = MockUri.file('C:/extension');
  const workspaceState = new Map<string, unknown>();
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const terminals: MockTerminal[] = [];
  const closeListeners = new Set<(terminal: MockTerminal) => void>();
  const startTexts: Array<{ text: string; submit: boolean }> = [];
  const createOptions: Record<string, unknown>[] = [];
  let createCount = 0;
  let showCount = 0;
  let registeredProvider: { resolveWebviewView: Function } | undefined;
  let messageHandler: ((message: unknown) => void) | undefined;
  const posted: unknown[] = [];

  const disposable = { dispose() {} };
  const vscodeMock: Record<string, unknown> = {
    Uri: MockUri,
    EventEmitter: MockEventEmitter,
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    TerminalLocation: { Panel: 1 },
    FileType: { File: 1, Directory: 2 },
    workspace: {
      workspaceFolders: [folder],
      isTrusted: true,
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      getWorkspaceFolder: () => folder,
      onDidChangeWorkspaceFolders: () => disposable,
      onDidGrantWorkspaceTrust: () => disposable,
      onDidChangeTextDocument: () => disposable,
      fs: { stat: async () => ({ type: 1 }) },
    },
    window: {
      terminals,
      activeTextEditor: undefined,
      onDidChangeTextEditorSelection: () => disposable,
      onDidCloseTerminal: (listener: (terminal: MockTerminal) => void) => {
        closeListeners.add(listener);
        return { dispose: () => closeListeners.delete(listener) };
      },
      registerWebviewViewProvider: (
        _id: string,
        provider: { resolveWebviewView: Function },
      ) => {
        registeredProvider = provider;
        return disposable;
      },
      createTerminal: (options: Record<string, unknown>) => {
        createCount += 1;
        createOptions.push(options);
        const terminal: MockTerminal = {
          exitStatus: undefined,
          creationOptions: options,
          sendText: (text, submit) => {
            startTexts.push({ text, submit });
          },
          show: () => {
            showCount += 1;
          },
        };
        terminals.push(terminal);
        return terminal;
      },
      showOpenDialog: async () => undefined,
      showQuickPick: async () => undefined,
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    },
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        commands.set(id, handler);
        return {
          dispose: () => {
            if (commands.get(id) === handler) {
              commands.delete(id);
            }
          },
        };
      },
      executeCommand: async () => undefined,
    },
    env: { clipboard: { writeText: async () => undefined } },
  };

  const originalLoad = moduleLoader._load;
  moduleLoader._load = (request, parent, isMain) =>
    request === 'vscode'
      ? vscodeMock
      : originalLoad(request, parent, isMain);

  try {
    const extension = require('../src/extension') as {
      activate(context: MockContext): void;
    };

    function makeContext(): MockContext {
      return {
        subscriptions: [],
        extensionUri,
        workspaceState: {
          get: (key) => workspaceState.get(key),
          update: async (key, value) => {
            workspaceState.set(key, value);
          },
        },
      };
    }

    async function runCommand(id: string): Promise<unknown> {
      const handler = commands.get(id);
      if (handler === undefined) {
        throw new Error(`Missing command ${id}`);
      }
      return handler();
    }

    const first = makeContext();
    extension.activate(first);

    const expectedCommands = [
      'opencodeTerminal.open',
      'opencodeTerminal.start',
      'opencodeTerminal.focusTerminal',
      'opencodeTerminal.addSelection',
      'opencodeTerminal.pickFiles',
      'opencodeTerminal.addFile',
      'opencodeTerminal.clear',
      'opencodeTerminal.copyAll',
    ];
    assert.deepEqual([...commands.keys()].sort(), [...expectedCommands].sort());
    assert.ok(registeredProvider !== undefined);

    await runCommand('opencodeTerminal.start');
    assert.equal(createCount, 1);
    assert.equal(startTexts.length, 1);
    assert.deepEqual(startTexts[0], { text: 'opencode', submit: true });

    const options = createOptions[0];
    assert.equal(options.cwd, folder.uri);
    assert.equal(options.location, (vscodeMock.TerminalLocation as { Panel: number }).Panel);
    const env = options.env as Record<string, string>;
    assert.equal(env.OPENCODE_TERMINAL_OWNER, 'vscode-opencode-terminal');
    assert.equal(env.OPENCODE_TERMINAL_FOLDER, folder.uri.toString());

    await runCommand('opencodeTerminal.start');
    assert.equal(createCount, 1, 'second start must reuse the terminal');
    assert.equal(startTexts.length, 1, 'reuse must not send the start command again');

    // Simulate an extension reload: dispose the first provider but keep the
    // terminal in the mocked window.terminals.
    for (const subscription of first.subscriptions) {
      subscription.dispose();
    }
    assert.equal(commands.size, 0);

    const second = makeContext();
    extension.activate(second);

    await runCommand('opencodeTerminal.focusTerminal');
    assert.equal(showCount, 3, 'constructor adoption must find the surviving terminal');
    await runCommand('opencodeTerminal.start');
    assert.equal(createCount, 1, 'reload must restore instead of creating a terminal');
    assert.equal(startTexts.length, 1, 'restore must not resend the start command');

    const webview = {
      cspSource: 'vscode-resource:',
      options: undefined as unknown,
      html: '',
      asWebviewUri: (uri: MockUri) => uri,
      onDidReceiveMessage: (handler: (message: unknown) => void) => {
        messageHandler = handler;
        return disposable;
      },
      postMessage: async (message: unknown) => {
        posted.push(message);
      },
    };
    const view = {
      webview,
      onDidDispose: () => disposable,
    };
    assert.ok(registeredProvider !== undefined);
    registeredProvider.resolveWebviewView(view, {}, {});

    assert.match(webview.html, /Content-Security-Policy/);
    assert.match(webview.html, /script-src 'nonce-[a-f0-9]{32}'/);
    assert.match(webview.html, /media\/webview\.js/);
    assert.match(webview.html, /media\/webview\.css/);
    const localRoots = (webview.options as { localResourceRoots: MockUri[] })
      .localResourceRoots;
    assert.equal(localRoots.length, 1);
    assert.ok(messageHandler !== undefined);

    messageHandler!({ type: 'ready' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const state = posted
      .filter(
        (message): message is { type: string } =>
          message !== null &&
          typeof message === 'object' &&
          (message as { type?: unknown }).type === 'state',
      )
      .at(-1);
    assert.ok(state !== undefined);

    // Closing the terminal clears the registry; the next explicit start builds
    // exactly one new terminal and sends the start command once.
    const terminal = terminals[0];
    terminal.exitStatus = { code: 0 };
    for (const listener of [...closeListeners]) {
      listener(terminal);
    }
    await runCommand('opencodeTerminal.start');
    assert.equal(createCount, 2);
    assert.equal(startTexts.length, 2);
  } finally {
    moduleLoader._load = originalLoad;
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type {
  EditorBridgeLike,
  EditorMentionParams,
  EditorMentionResult,
} from '../src/editorBridge';

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
      filePath.replace(/\\/g, '/'),
    );
  }

  static parse(value: string): MockUri {
    if (value.startsWith('file:///')) {
      const fsPath = decodeURIComponent(value.slice('file:///'.length));
      return new MockUri(value, 'file', fsPath);
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

class MockTreeItem {
  label: string;
  collapsibleState: number;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;

  constructor(label: string, collapsibleState = 0) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
} as const;

class MockThemeIcon {
  constructor(readonly id: string) {}
}

class FakeProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }> = [];
  killCount = 0;

  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { readonly exitCode: number; readonly signal?: number }) => void
  >();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killCount += 1;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(
    listener: (event: { readonly exitCode: number; readonly signal?: number }) => void,
  ): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of [...this.dataListeners]) {
      listener(data);
    }
  }

  emitExit(exitCode = 0): void {
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode });
    }
  }
}

class FakeEditorBridge implements EditorBridgeLike {
  readonly sent: EditorMentionParams[] = [];
  ready = false;
  startCount = 0;
  stopCount = 0;

  constructor(
    private readonly portValue: number,
    private readonly startError?: Error,
  ) {}

  get port(): number {
    return this.portValue;
  }

  async start(): Promise<number> {
    this.startCount += 1;
    if (this.startError !== undefined) {
      throw this.startError;
    }
    return this.portValue;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready && this.stopCount === 0;
  }

  sendMention(params: EditorMentionParams): EditorMentionResult {
    if (!this.isReady()) {
      return {
        ok: false,
        reason: 'not-ready',
        message: 'Fake bridge is not ready.',
      };
    }
    this.sent.push(params);
    return { ok: true };
  }
}

interface SpawnCall {
  readonly shellPath: string;
  readonly args: string | string[];
  readonly options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly cols: number;
    readonly rows: number;
  };
}

interface HarnessOptions {
  readonly trusted?: boolean;
  readonly command?: unknown;
  readonly defaultProfile?: string;
  readonly userProfilePath?: string;
  readonly globalEnv?: Record<string, string | null>;
  readonly workspaceEnv?: Record<string, string | null>;
  readonly envShell?: string;
  readonly warningChoice?: string;
  readonly statType?: (uri: MockUri) => number;
  readonly createEditorBridge?: () => FakeEditorBridge;
  readonly documentLineCount?: number;
  readonly fileSize?: number;
}

interface MockTreeViewRegistration {
  readonly id: string;
  readonly options: Record<string, unknown>;
}

interface Harness {
  readonly folder: { readonly name: string; readonly uri: MockUri; readonly fsPath: string };
  readonly context: MockContext;
  readonly extension: {
    activate(context: MockContext, dependencies?: unknown): void;
    deactivate(): void;
  };
  readonly commands: Map<string, (...args: unknown[]) => unknown>;
  readonly spawnCalls: SpawnCall[];
  readonly processes: FakeProcess[];
  readonly bridges: FakeEditorBridge[];
  readonly posted: Array<Record<string, unknown>>;
  readonly selectionListeners: Set<(event: unknown) => void>;
  readonly warningCalls: unknown[][];
  readonly errorMessages: string[];
  readonly treeViews: MockTreeViewRegistration[];
  readonly outputLines: string[];
  readonly openDocuments: MockUri[];
  readonly clipboard: { value: string; reads: number };
  setActiveEditor(editor: unknown): void;
  resolveView(): { readonly html: string };
  sendMessage(message: unknown): void;
  removeFolder(): void;
  waitFor(predicate: () => boolean, message: string): Promise<void>;
  postedOfType(type: string): Array<Record<string, unknown>>;
}

interface MockContext {
  subscriptions: Array<{ dispose(): void }>;
  extensionUri: MockUri;
  workspaceState: {
    get(key: string): unknown;
    update(key: string, value: unknown): Promise<void>;
  };
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const trusted = options.trusted ?? true;
  const folder = {
    name: 'demo',
    uri: MockUri.file('C:/demo'),
    fsPath: 'C:/demo',
  };
  const extensionUri = MockUri.file('C:/extension');
  const workspaceState = new Map<string, unknown>();
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const spawnCalls: SpawnCall[] = [];
  const processes: FakeProcess[] = [];
  const bridges: FakeEditorBridge[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const selectionListeners = new Set<(event: unknown) => void>();
  const warningCalls: unknown[][] = [];
  const errorMessages: string[] = [];
  const treeViews: MockTreeViewRegistration[] = [];
  const outputLines: string[] = [];
  const openDocuments: MockUri[] = [];
  const clipboard = { value: '', reads: 0 };
  const folderChangeListeners = new Set<(event: unknown) => void>();
  let folders = [folder];
  let nextSession = 0;
  let messageHandler: ((message: unknown) => void) | undefined;
  let registeredProvider:
    | {
        resolveWebviewView(
          view: unknown,
          context: unknown,
          token: unknown,
        ): void;
      }
    | undefined;
  let activeEditor: unknown;

  const terminalEnv = options.workspaceEnv ?? options.globalEnv ?? {};
  const userProfile = {
    ...(options.userProfilePath === undefined
      ? { source: 'PowerShell' }
      : { path: options.userProfilePath }),
    args: ['-NoLogo'],
    env: { PROFILE_ENV: 'yes' },
  };
  const inspectEntries = new Map<string, Record<string, unknown>>([
    [
      'defaultProfile.windows',
      {
        globalValue: options.defaultProfile ?? 'PowerShell',
        defaultValue: undefined,
      },
    ],
    [
      'profiles.windows',
      {
        globalValue: { PowerShell: userProfile },
        defaultValue: {},
      },
    ],
    [
      'env.windows',
      {
        globalValue: options.globalEnv ?? {},
        workspaceValue: options.workspaceEnv,
        defaultValue: {},
      },
    ],
  ]);

  const terminalConfiguration = {
    get(key: string, fallback?: unknown): unknown {
      switch (key) {
        case 'defaultProfile.windows':
          return options.defaultProfile ?? 'PowerShell';
        case 'profiles.windows':
          return { PowerShell: userProfile };
        case 'env.windows':
          return terminalEnv;
        default:
          return fallback;
      }
    },
    inspect(key: string): unknown {
      return inspectEntries.get(key);
    },
  };

  const commandConfiguration = {
    get(key: string, fallback?: unknown): unknown {
      return key === 'command'
        ? options.command ?? 'opencode'
        : fallback;
    },
    inspect(): unknown {
      return undefined;
    },
  };

  const disposable = { dispose() {} };
  const vscodeMock: Record<string, unknown> = {
    Uri: MockUri,
    EventEmitter: MockEventEmitter,
    TreeItem: MockTreeItem,
    TreeItemCollapsibleState,
    ThemeIcon: MockThemeIcon,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      get workspaceFolders() {
        return folders;
      },
      get isTrusted() {
        return trusted;
      },
      getConfiguration: (section: string) =>
        section === 'terminal.integrated'
          ? terminalConfiguration
          : commandConfiguration,
      getWorkspaceFolder: (uri: MockUri) => {
        for (const candidate of folders) {
          if (
            uri.fsPath === candidate.fsPath ||
            uri.fsPath.startsWith(`${candidate.fsPath}/`)
          ) {
            return candidate;
          }
        }
        return undefined;
      },
      onDidChangeWorkspaceFolders: (listener: (event: unknown) => void) => {
        folderChangeListeners.add(listener);
        return {
          dispose: () => folderChangeListeners.delete(listener),
        };
      },
      onDidGrantWorkspaceTrust: () => disposable,
      onDidChangeTextDocument: () => disposable,
      onDidChangeConfiguration: () => disposable,
      openTextDocument: async (uri: MockUri) => {
        openDocuments.push(uri);
        return {
          uri,
          lineCount: options.documentLineCount ?? 42,
        };
      },
      fs: {
        stat: async (uri: MockUri) => ({
          type: options.statType?.(uri) ?? 1,
          size: options.fileSize,
        }),
      },
    },
    window: {
      get activeTextEditor() {
        return activeEditor;
      },
      onDidChangeTextEditorSelection: (listener: (event: unknown) => void) => {
        selectionListeners.add(listener);
        return {
          dispose: () => selectionListeners.delete(listener),
        };
      },
      registerWebviewViewProvider: (
        _id: string,
        provider: {
          resolveWebviewView(view: unknown, context: unknown, token: unknown): void;
        },
      ) => {
        registeredProvider = provider;
        return disposable;
      },
      createTreeView: (id: string, viewOptions: Record<string, unknown>) => {
        treeViews.push({ id, options: viewOptions });
        return { dispose() {} };
      },
      createOutputChannel: (_name: string) => ({
        appendLine: (line: string) => {
          outputLines.push(line);
        },
        append: () => undefined,
        show: () => undefined,
        clear: () => undefined,
        dispose: () => undefined,
      }),
      showOpenDialog: async () => undefined,
      showQuickPick: async () => undefined,
      showWarningMessage: async (...args: unknown[]) => {
        warningCalls.push(args);
        return options.warningChoice;
      },
      showInformationMessage: async () => undefined,
      showErrorMessage: async (message: string) => {
        errorMessages.push(message);
        return undefined;
      },
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
    env: {
      shell: options.envShell ?? 'C:/Program Files/PowerShell/7/pwsh.exe',
      clipboard: {
        readText: async () => {
          clipboard.reads += 1;
          return clipboard.value;
        },
        writeText: async (value: string) => {
          clipboard.value = value;
        },
      },
    },
  };

  const originalLoad = moduleLoader._load;
  moduleLoader._load = (request, parent, isMain) =>
    request === 'vscode'
      ? vscodeMock
      : originalLoad(request, parent, isMain);

  try {
    delete require.cache[require.resolve('../src/extension')];
    delete require.cache[require.resolve('../src/fileDropView')];
    const extension = require('../src/extension') as Harness['extension'];
    const context: MockContext = {
      subscriptions: [],
      extensionUri,
      workspaceState: {
        get: (key) => workspaceState.get(key),
        update: async (key, value) => {
          workspaceState.set(key, value);
        },
      },
    };

    extension.activate(context, {
      spawn: (
        shellPath: string,
        args: string | string[],
        spawnOptions: SpawnCall['options'],
      ) => {
        const process = new FakeProcess();
        spawnCalls.push({ shellPath, args, options: spawnOptions });
        processes.push(process);
        return process;
      },
      createSessionId: () => {
        nextSession += 1;
        return `session-${nextSession}`;
      },
      createEditorBridge: () => {
        const bridge =
          options.createEditorBridge?.() ??
          new FakeEditorBridge(42000 + bridges.length);
        bridges.push(bridge);
        return bridge;
      },
    });

    function resolveView(): { readonly html: string } {
      const webview = {
        cspSource: 'vscode-resource:',
        options: undefined as unknown,
        html: '',
        asWebviewUri: (uri: MockUri) => uri,
        onDidReceiveMessage: (handler: (message: unknown) => void) => {
          messageHandler = handler;
          return disposable;
        },
        postMessage: async (message: Record<string, unknown>) => {
          posted.push(message);
        },
      };
      const view = {
        webview,
        onDidDispose: () => disposable,
        show: () => undefined,
      };
      if (registeredProvider === undefined) {
        throw new Error('Provider was not registered.');
      }
      registeredProvider.resolveWebviewView(view, {}, {});
      return webview;
    }

    async function waitFor(
      predicate: () => boolean,
      message: string,
    ): Promise<void> {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for ${message}`);
    }

    return {
      folder,
      context,
      extension,
      commands,
      spawnCalls,
      processes,
      bridges,
      posted,
      selectionListeners,
      warningCalls,
      errorMessages,
      treeViews,
      outputLines,
      openDocuments,
      clipboard,
      setActiveEditor(editor: unknown) {
        activeEditor = editor;
      },
      resolveView,
      sendMessage(message: unknown) {
        if (messageHandler === undefined) {
          throw new Error('Webview message handler was not registered.');
        }
        messageHandler(message);
      },
      removeFolder() {
        folders = folders.filter((candidate) => candidate !== folder);
        for (const listener of [...folderChangeListeners]) {
          listener({ added: [], removed: [folder] });
        }
      },
      waitFor,
      postedOfType(type: string) {
        return posted.filter((message) => message.type === type);
      },
    };
  } finally {
    moduleLoader._load = originalLoad;
  }
}

test('auto-start spawns once with profile args/env/cwd, streams output, input, resize and exit', async () => {
  const previousElectron = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const harness = makeHarness({
      globalEnv: {
        WORKSPACE_ENV: 'value',
        ELECTRON_RUN_AS_NODE: '1',
        OPENCODE_EDITOR_SSE_PORT: '1111',
        CLAUDE_CODE_SSE_PORT: '2222',
        claude_code_sse_port: '3333',
      },
    });

    harness.resolveView();
    harness.sendMessage({ type: 'ready', cols: 101, rows: 19 });
    await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
    await harness.waitFor(
      () => harness.postedOfType('ptySnapshot').length > 0,
      'snapshot',
    );

    const call = harness.spawnCalls[0];
    assert.equal(call.shellPath, 'C:/Program Files/PowerShell/7/pwsh.exe');
    assert.deepEqual(call.args, ['-NoLogo']);
    assert.equal(call.options.cwd, harness.folder.fsPath);
    assert.equal(call.options.cols, 101, 'spawn must use the webview width');
    assert.equal(call.options.rows, 19, 'spawn must use the webview height');
    assert.equal(call.options.env.TERM, 'xterm-256color');
    assert.equal(call.options.env.COLORTERM, 'truecolor');
    assert.equal(call.options.env.PROFILE_ENV, 'yes');
    assert.equal(call.options.env.WORKSPACE_ENV, 'value');
    assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(harness.bridges.length, 1);
    assert.equal(harness.bridges[0].startCount, 1);
    assert.equal(call.options.env.OPENCODE_EDITOR_SSE_PORT, String(harness.bridges[0].port));
    assert.equal(call.options.env.CLAUDE_CODE_SSE_PORT, String(harness.bridges[0].port));
    assert.equal(
      Object.keys(call.options.env).filter(
        (key) => key.toLowerCase() === 'opencode_editor_sse_port',
      ).length,
      1,
    );
    assert.equal(
      Object.keys(call.options.env).filter(
        (key) => key.toLowerCase() === 'claude_code_sse_port',
      ).length,
      1,
    );
    assert.deepEqual(harness.processes[0].writes, ['opencode\r']);

    const snapshot = harness.postedOfType('ptySnapshot').at(-1) as {
      session?: { sessionId?: string; sequence?: number };
    };
    assert.equal(snapshot.session?.sessionId, 'session-1');
    assert.equal(snapshot.session?.sequence, 0);

    // An attach after a real resize must resize the already-running PTY even
    // though its earlier onResize (with no session) was ignored.
    harness.sendMessage({ type: 'attach', cols: 111, rows: 22 });
    await harness.waitFor(
      () =>
        harness.processes[0].resizes.some(
          (resize) => resize.cols === 111 && resize.rows === 22,
        ),
      'attach resize',
    );
    assert.deepEqual(harness.processes[0].resizes.at(-1), {
      cols: 111,
      rows: 22,
    });

    harness.processes[0].emitData('hello');
    harness.processes[0].emitData(' world');
    await harness.waitFor(
      () => harness.postedOfType('ptyOutput').length > 0,
      'batched output',
    );
    const output = harness.postedOfType('ptyOutput').at(-1) as {
      data?: string;
      fromSequence?: number;
      sequence?: number;
    };
    assert.equal(output.data, 'hello world');
    assert.equal(output.fromSequence, 1);
    assert.equal(output.sequence, 2);

    harness.sendMessage({
      type: 'ptyInput',
      sessionId: 'session-1',
      data: '\u0003\u001b[A',
    });
    assert.equal(harness.processes[0].writes.at(-1), '\u0003\u001b[A');

    harness.sendMessage({
      type: 'ptyInput',
      sessionId: 'session-stale',
      data: 'x',
    });
    assert.equal(
      harness.processes[0].writes.includes('x'),
      false,
      'a stale session id must not write',
    );

    harness.sendMessage({
      type: 'ptyResize',
      sessionId: 'session-1',
      cols: 120,
      rows: 40,
    });
    assert.deepEqual(harness.processes[0].resizes.at(-1), { cols: 120, rows: 40 });

    harness.processes[0].emitExit(7);
    await harness.waitFor(
      () => harness.postedOfType('ptyExit').length > 0,
      'exit event',
    );
    assert.equal(
      (harness.postedOfType('ptyExit').at(-1) as { exitCode?: number }).exitCode,
      7,
    );
  } finally {
    if (previousElectron === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE;
    } else {
      process.env.ELECTRON_RUN_AS_NODE = previousElectron;
    }
  }
});

test('legacy readClipboard messages are rejected without reading or reposting the clipboard', async () => {
  const harness = makeHarness();
  harness.resolveView();
  harness.sendMessage({ type: 'ready' });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
  await harness.waitFor(
    () => harness.postedOfType('ptySnapshot').length > 0,
    'snapshot',
  );

  const writesBefore = [...harness.processes[0].writes];
  harness.clipboard.value = 'SENTINEL_PASTE';
  harness.clipboard.reads = 0;
  const postedBefore = harness.posted.length;

  harness.sendMessage({ type: 'readClipboard' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(
    harness.clipboard.reads,
    0,
    'the removed readClipboard protocol must never touch the host clipboard',
  );
  assert.equal(
    harness.postedOfType('pasteText').length,
    0,
    'the host must never replay pasteText to the webview',
  );
  assert.deepEqual(
    harness.processes[0].writes,
    writesBefore,
    'rejecting the legacy message must not write to the PTY',
  );
  assert.equal(
    harness.posted.length,
    postedBefore + 1,
    'only the error state notice is posted',
  );
  const state = harness.postedOfType('state').at(-1) as {
    notice?: { kind?: string; message?: string };
  };
  assert.equal(state.notice?.kind, 'error');
  assert.match(String(state.notice?.message), /已忽略无效的 webview 消息/);
});

test('drop writes @mentions without Enter and never executes arbitrary plain text', async () => {
  const harness = makeHarness();
  harness.resolveView();
  harness.sendMessage({ type: 'ready' });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
  await harness.waitFor(
    () => harness.postedOfType('ptySnapshot').length > 0,
    'snapshot',
  );

  const document = {
    uri: MockUri.file('C:/demo/src/a.ts'),
    getText: () => 'const a = 1;',
  };
  const selection = {
    isEmpty: false,
    start: { line: 0, character: 0 },
    end: { line: 0, character: 12 },
  };
  const editor = { document, selection, selections: [selection] };
  harness.setActiveEditor(editor);
  for (const listener of harness.selectionListeners) {
    listener({ textEditor: editor, selections: [selection] });
  }

  harness.sendMessage({ type: 'drop', plainText: 'const a = 1;' });
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'selection mention write',
  );
  assert.equal(harness.processes[0].writes[1], '@src/a.ts#1-1');
  assert.equal(harness.processes[0].writes[1].includes('\r'), false);

  harness.sendMessage({ type: 'drop', plainText: 'rm -rf /' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    harness.processes[0].writes.some((write) => write.includes('rm -rf')),
    false,
    'unmatched plain text must never reach the PTY',
  );

  harness.sendMessage({
    type: 'drop',
    uriList: 'file:///C:/demo/src/a.ts',
  });
  await harness.waitFor(
    () => harness.processes[0].writes.length === 3,
    'file mention write',
  );
  assert.equal(harness.processes[0].writes[2], '@src/a.ts');
  assert.equal(harness.processes[0].writes[2].includes('\r'), false);
});

test('a ready editor bridge sends multi-line references while whole files stay plain text', async () => {
  const harness = makeHarness({ documentLineCount: 42 });
  harness.resolveView();
  harness.sendMessage({ type: 'ready' });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
  await harness.waitFor(
    () => harness.postedOfType('ptySnapshot').length > 0,
    'snapshot',
  );

  const bridge = harness.bridges[0];
  bridge.ready = true;

  const document = {
    uri: MockUri.file('C:/demo/src/a.ts'),
    getText: () => 'const a = 1;',
    lineCount: 42,
  };
  const selection = {
    isEmpty: false,
    start: { line: 10, character: 0 },
    end: { line: 12, character: 0 },
  };
  const editor = { document, selection, selections: [selection] };
  harness.setActiveEditor(editor);

  const addSelection = harness.commands.get('opencodeTerminal.addSelection') as
    | (() => Promise<void>)
    | undefined;
  assert.ok(addSelection);
  await addSelection();
  await harness.waitFor(() => bridge.sent.length === 1, 'multi-line bridge send');
  assert.deepEqual(bridge.sent[0], {
    filePath: 'C:/demo/src/a.ts',
    lineStart: 11,
    lineEnd: 12,
  });
  const selectionNotice = harness.postedOfType('state').at(-1) as {
    notice?: { message?: string };
  };
  assert.match(
    String(selectionNotice.notice?.message),
    /已发送 1 个引用添加请求（未提交/,
  );
  assert.match(String(selectionNotice.notice?.message), /无 ACK/);

  // A whole file (right-click "添加文件") is always plain `@path`, even with a
  // ready bridge: the internal protocol has no whole-file range, so no line
  // count is read and no fabricated range is sent.
  const addFile = harness.commands.get('opencodeTerminal.addFile') as
    | ((uri: MockUri) => Promise<void>)
    | undefined;
  assert.ok(addFile);
  await addFile(MockUri.file('C:/demo/src/b.ts'));
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'whole-file text write',
  );
  assert.equal(harness.processes[0].writes[1], '@src/b.ts');
  assert.equal(harness.processes[0].writes[1].includes('#'), false);
  assert.equal(/[\r\n\t]/.test(harness.processes[0].writes[1]), false);
  assert.equal(bridge.sent.length, 1, 'whole files must not use the bridge');
  assert.deepEqual(harness.openDocuments, [], 'whole files must not be opened');

  const notice = harness.postedOfType('state').at(-1) as {
    notice?: { message?: string };
  };
  assert.match(String(notice.notice?.message), /整文件以纯文本/);
  assert.match(String(notice.notice?.message), /需手动确认/);
  assert.doesNotMatch(String(notice.notice?.message), /已发送 1 个引用添加请求/);

  // A single-line selection is never sent through the bridge even when it is
  // ready; it falls back to one text mention with no Enter/Tab.
  const single = {
    isEmpty: false,
    start: { line: 4, character: 2 },
    end: { line: 4, character: 10 },
  };
  harness.setActiveEditor({ document, selection: single, selections: [single] });
  await addSelection();
  await harness.waitFor(
    () => harness.processes[0].writes.length === 3,
    'single-line text fallback',
  );
  assert.equal(harness.processes[0].writes[2], '@src/a.ts#5-5');
  assert.equal(/[\r\n\t]/.test(harness.processes[0].writes[2]), false);
  assert.equal(bridge.sent.length, 1);
  const fallbackNotice = harness.postedOfType('state').at(-1) as {
    notice?: { message?: string };
  };
  assert.match(String(fallbackNotice.notice?.message), /需手动确认/);
});

test('a disconnected editor bridge falls back to text for whole-file and multi-line references', async () => {
  const harness = makeHarness({ documentLineCount: 9 });
  harness.resolveView();
  harness.sendMessage({ type: 'ready' });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
  await harness.waitFor(
    () => harness.postedOfType('ptySnapshot').length > 0,
    'snapshot',
  );

  const bridge = harness.bridges[0];
  assert.equal(bridge.isReady(), false);

  const document = {
    uri: MockUri.file('C:/demo/src/a.ts'),
    lineCount: 9,
  };
  const selection = {
    isEmpty: false,
    start: { line: 0, character: 0 },
    end: { line: 2, character: 0 },
  };
  harness.setActiveEditor({ document, selection, selections: [selection] });

  const addSelection = harness.commands.get('opencodeTerminal.addSelection') as
    | (() => Promise<void>)
    | undefined;
  assert.ok(addSelection);
  await addSelection();
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'multi-line text fallback',
  );

  const addFile = harness.commands.get('opencodeTerminal.addFile') as
    | ((uri: MockUri) => Promise<void>)
    | undefined;
  assert.ok(addFile);
  await addFile(MockUri.file('C:/demo/src/b.ts'));
  await harness.waitFor(
    () => harness.processes[0].writes.length === 3,
    'whole-file text fallback',
  );

  assert.equal(harness.processes[0].writes[1], '@src/a.ts#1-2');
  assert.equal(harness.processes[0].writes[2], '@src/b.ts');
  for (const write of harness.processes[0].writes.slice(1)) {
    assert.equal(/[\r\n\t]/.test(write), false);
  }
  assert.equal(bridge.sent.length, 0);
  const notice = harness.postedOfType('state').at(-1) as {
    notice?: { message?: string };
  };
  assert.match(String(notice.notice?.message), /需手动确认/);
  assert.match(String(notice.notice?.message), /未按回车/);
});

test('a PTY exit stops its bridge and a dead session never receives a mention', async () => {
  const harness = makeHarness({ documentLineCount: 5 });
  harness.resolveView();
  harness.sendMessage({ type: 'ready' });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
  await harness.waitFor(
    () => harness.postedOfType('ptySnapshot').length > 0,
    'snapshot',
  );

  const bridge = harness.bridges[0];
  bridge.ready = true;
  harness.processes[0].emitExit(0);
  await harness.waitFor(() => bridge.stopCount > 0, 'PTY exit bridge stop');

  const document = { uri: MockUri.file('C:/demo/src/a.ts'), lineCount: 5 };
  const selection = {
    isEmpty: false,
    start: { line: 0, character: 0 },
    end: { line: 2, character: 0 },
  };
  harness.setActiveEditor({ document, selection, selections: [selection] });
  const addSelection = harness.commands.get('opencodeTerminal.addSelection') as
    | (() => Promise<void>)
    | undefined;
  assert.ok(addSelection);
  await addSelection();

  assert.equal(bridge.sent.length, 0);
  assert.deepEqual(harness.processes[0].writes, ['opencode\r']);
  const notice = harness.postedOfType('state').at(-1) as {
    notice?: { message?: string };
  };
  assert.match(String(notice.notice?.message), /PTY 未运行/);
});

test('an editor bridge start failure clears inherited ports and still allows text fallback', async () => {
  const harness = makeHarness({
    globalEnv: {
      OPENCODE_EDITOR_SSE_PORT: '1111',
      CLAUDE_CODE_SSE_PORT: '2222',
    },
    createEditorBridge: () =>
      new FakeEditorBridge(43000, new Error('listen failed')),
  });
  harness.resolveView();
  harness.sendMessage({ type: 'ready' });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
  await harness.waitFor(
    () => harness.postedOfType('ptySnapshot').length > 0,
    'snapshot',
  );

  const spawn = harness.spawnCalls[0];
  assert.equal(spawn.options.env.OPENCODE_EDITOR_SSE_PORT, undefined);
  assert.equal(spawn.options.env.CLAUDE_CODE_SSE_PORT, undefined);
  assert.equal(
    Object.keys(spawn.options.env).some((key) =>
      key.toLowerCase().endsWith('_editor_sse_port'),
    ),
    false,
  );

  const document = { uri: MockUri.file('C:/demo/src/a.ts'), lineCount: 3 };
  const selection = {
    isEmpty: true,
    start: { line: 1, character: 0 },
    end: { line: 1, character: 0 },
  };
  harness.setActiveEditor({ document, selection, selections: [selection] });
  const addSelection = harness.commands.get('opencodeTerminal.addSelection') as
    | (() => Promise<void>)
    | undefined;
  assert.ok(addSelection);
  await addSelection();
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'text fallback after bridge failure',
  );
  assert.equal(harness.processes[0].writes[1], '@src/a.ts');
});

test('trusted workspace terminal settings require explicit confirmation', async () => {
  const safeShell = process.execPath;
  const harness = makeHarness({
    warningChoice: '仅使用用户配置',
    userProfilePath: safeShell,
    envShell: 'C:/workspace/evil-shell.exe',
    globalEnv: { USER_ENV: 'user' },
    workspaceEnv: { INJECTED: 'workspace' },
  });
  harness.resolveView();
  harness.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');

  assert.equal(harness.warningCalls.length, 1);
  assert.match(String(harness.warningCalls[0][0]), /工作区/);

  const spawn = harness.spawnCalls[0];
  assert.equal(spawn.shellPath, safeShell);
  assert.notEqual(spawn.shellPath, 'C:/workspace/evil-shell.exe');
  assert.equal(spawn.options.env.USER_ENV, 'user');
  assert.equal(spawn.options.env.INJECTED, undefined);
});

test('rejecting workspace settings cannot fall back to a workspace-resolved env.shell', async () => {
  const harness = makeHarness({
    warningChoice: '仅使用用户配置',
    envShell: 'C:/workspace/evil-shell.exe',
    workspaceEnv: { INJECTED: 'workspace' },
  });
  harness.resolveView();
  harness.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(
    harness.spawnCalls.length,
    0,
    'source-only user profile plus rejected workspace settings must not spawn',
  );
  assert.equal(harness.warningCalls.length, 1);
  const notice = (
    harness.postedOfType('state').at(-1) as {
      notice?: { message?: string };
    }
  ).notice;
  assert.match(String(notice?.message), /显式 path|工作区终端配置/);
});

test('removing a workspace kills and forgets its PTY session', async () => {
  const harness = makeHarness();
  harness.resolveView();
  harness.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
  await harness.waitFor(
    () => harness.postedOfType('ptySnapshot').length > 0,
    'snapshot',
  );

  const process = harness.processes[0];
  harness.removeFolder();
  await harness.waitFor(() => process.killCount === 1, 'removed PTY kill');
  await harness.waitFor(
    () => harness.bridges[0].stopCount > 0,
    'removed editor bridge stop',
  );
  await harness.waitFor(
    () =>
      (harness.postedOfType('ptySnapshot').at(-1) as {
        session?: unknown;
      }).session === null,
    'cleared snapshot',
  );

  assert.equal(harness.spawnCalls.length, 1);
  const state = harness.postedOfType('state').at(-1) as {
    workspaceKey?: string | null;
    ptyActive?: boolean;
  };
  assert.equal(state.ptyActive, false);
  assert.equal(state.workspaceKey, null);
});

test('untrusted workspaces never spawn, and dispose kills the PTY', async () => {
  const untrusted = makeHarness({ trusted: false });
  untrusted.resolveView();
  untrusted.sendMessage({ type: 'ready' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(untrusted.spawnCalls.length, 0);
  assert.equal(untrusted.bridges.length, 0, 'untrusted workspaces must not start a bridge');
  const untrustedState = untrusted.postedOfType('state').at(-1) as {
    trusted?: boolean;
  };
  assert.equal(untrustedState.trusted, false);

  const harness = makeHarness();
  harness.resolveView();
  harness.sendMessage({ type: 'ready' });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
  harness.extension.deactivate();
  assert.equal(harness.processes[0].killCount, 1);
  await harness.waitFor(
    () => harness.bridges[0].stopCount > 0,
    'disposed editor bridge stop',
  );
});

interface DropController {
  handleDrop(
    target: unknown,
    dataTransfer: unknown,
    token: { readonly isCancellationRequested: boolean },
  ): Promise<void>;
}

interface MockTransferEntry {
  readonly text?: string;
  readonly fileUri?: MockUri;
  readonly asStringError?: string;
}

function nativeTransfer(
  entries: Readonly<Record<string, MockTransferEntry>>,
): unknown {
  const map = new Map(
    Object.entries(entries).map(([mime, entry]) => [
      mime.toLowerCase(),
      {
        asString: async () => {
          if (entry.asStringError !== undefined) {
            throw new Error(entry.asStringError);
          }
          return entry.text ?? '';
        },
        asFile: () =>
          entry.fileUri === undefined ? undefined : { uri: entry.fileUri },
      },
    ]),
  );
  return {
    get(mime: string) {
      return map.get(mime.toLowerCase());
    },
  };
}

function dropController(harness: Harness): DropController {
  const registration = harness.treeViews.find(
    (view) => view.id === 'opencodeTerminal.drop',
  );
  assert.ok(registration, 'native tree view was not registered');
  const controller = registration.options.dragAndDropController as
    | DropController
    | undefined;
  assert.ok(controller, 'tree drag and drop controller was not registered');
  return controller;
}

test('native tree drop writes multiple real URI files without Enter and skips directories', async () => {
  const harness = makeHarness({
    statType: (uri) => (uri.fsPath.endsWith('/dir.ts') ? 2 : 1),
  });
  harness.resolveView();
  harness.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
  await harness.waitFor(
    () => harness.postedOfType('ptySnapshot').length > 0,
    'snapshot',
  );

  const controller = dropController(harness);
  const transfer = nativeTransfer({
    'text/uri-list': {
      text: [
        'file:///C:/demo/src/a.ts',
        'file:///C:/demo/src/b.ts',
        'file:///C:/demo/src/dir.ts',
        'file:///C:/demo/src/a.ts',
      ].join('\r\n'),
    },
  });

  await controller.handleDrop(undefined, transfer, {
    isCancellationRequested: false,
  });
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'native tree mention write',
  );

  assert.equal(
    harness.processes[0].writes[1],
    '@src/a.ts @src/b.ts',
    'multi-select must keep all unique files',
  );
  assert.equal(harness.processes[0].writes[1].includes('\r'), false);
  assert.equal(
    harness.processes[0].writes.some((write) => write.includes('dir.ts')),
    false,
    'directories must not be written',
  );
  assert.equal(
    harness.outputLines.some(
      (line) => line.includes('source=text/uri-list') && line.includes('files=3'),
    ),
    true,
    JSON.stringify(harness.outputLines),
  );
  assert.equal(
    harness.outputLines.every((line) => !line.includes('C:/demo/src/a.ts')),
    true,
    'diagnostics must not log file paths or contents',
  );
});

test('native tree drop of whole files and multi-select uses only plain @paths with a ready bridge', async () => {
  const harness = makeHarness({ documentLineCount: 42 });
  harness.resolveView();
  harness.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
  await harness.waitFor(
    () => harness.postedOfType('ptySnapshot').length > 0,
    'snapshot',
  );

  const bridge = harness.bridges[0];
  bridge.ready = true;

  const controller = dropController(harness);
  await controller.handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': {
        text: [
          'file:///C:/demo/src/a.ts',
          'file:///C:/demo/src/b.ts',
          'file:///C:/demo/src/a.ts',
        ].join('\r\n'),
      },
    }),
    { isCancellationRequested: false },
  );
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'native whole-file text write',
  );

  assert.equal(harness.processes[0].writes[1], '@src/a.ts @src/b.ts');
  assert.equal(harness.processes[0].writes[1].includes('#'), false);
  assert.equal(harness.processes[0].writes[1].includes('\r'), false);
  assert.equal(bridge.sent.length, 0, 'whole files must not use the bridge');
  assert.deepEqual(harness.openDocuments, [], 'whole files must not be opened');
  const state = harness.postedOfType('state').at(-1) as {
    notice?: { message?: string };
  };
  assert.match(String(state.notice?.message), /需手动确认/);
  assert.match(String(state.notice?.message), /整文件以纯文本/);
});

test('native tree CodeFiles native absolute paths and asFile URIs are accepted', async () => {
  const harness = makeHarness();
  harness.resolveView();
  harness.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
  await harness.waitFor(
    () => harness.postedOfType('ptySnapshot').length > 0,
    'snapshot',
  );

  const controller = dropController(harness);
  await controller.handleDrop(
    undefined,
    nativeTransfer({
      CodeFiles: {
        text: JSON.stringify([
          'C:\\demo\\src\\c.ts',
          'C:\\demo\\src\\d.ts',
        ]),
      },
      files: { fileUri: MockUri.file('C:/demo/src/from-file.ts') },
    }),
    { isCancellationRequested: false },
  );
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'CodeFiles mention write',
  );

  assert.equal(
    harness.processes[0].writes[1],
    '@src/from-file.ts @src/c.ts @src/d.ts',
  );
  assert.equal(harness.processes[0].writes[1].includes('\r'), false);
});

test('native tree drop with only unsupported MIME does not write', async () => {
  const harness = makeHarness();
  harness.resolveView();
  harness.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');

  const controller = dropController(harness);
  await controller.handleDrop(
    undefined,
    nativeTransfer({ 'application/x-unsupported': { text: 'ignored' } }),
    { isCancellationRequested: false },
  );

  assert.equal(harness.processes[0].writes.length, 1, 'only launch command');
  const state = harness.postedOfType('state').at(-1) as {
    notice?: { kind?: string; message?: string };
  };
  assert.equal(state.notice?.kind, 'error');
  assert.match(String(state.notice?.message), /未写入引用/);
});

test('native tree drop without an active PTY reports start instead of writing', async () => {
  const harness = makeHarness();
  harness.resolveView();

  const controller = dropController(harness);
  await controller.handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': { text: 'file:///C:/demo/src/a.ts' },
    }),
    { isCancellationRequested: false },
  );

  assert.equal(harness.spawnCalls.length, 0);
  const state = harness.postedOfType('state').at(-1) as {
    notice?: { message?: string };
  };
  assert.match(String(state.notice?.message), /PTY 未运行/);
});

test('native tree drop in an untrusted workspace does not write or spawn', async () => {
  const harness = makeHarness({ trusted: false });
  const controller = dropController(harness);

  await controller.handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': { text: 'file:///C:/demo/src/a.ts' },
    }),
    { isCancellationRequested: false },
  );

  assert.equal(harness.spawnCalls.length, 0);
  assert.equal(
    harness.errorMessages.some((message) => /限制模式/.test(message)),
    true,
  );
});

test('native tree drop reports an async asString failure without writing', async () => {
  const harness = makeHarness();
  harness.resolveView();
  harness.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');

  const controller = dropController(harness);
  await controller.handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': { asStringError: 'denied' },
    }),
    { isCancellationRequested: false },
  );

  assert.equal(harness.processes[0].writes.length, 1);
  const state = harness.postedOfType('state').at(-1) as {
    notice?: { message?: string };
  };
  assert.match(String(state.notice?.message), /异步读取失败|未写入引用/);
});

test('toolbar HTML keeps restart but no longer renders the file button', () => {
  const harness = makeHarness();
  const webview = harness.resolveView();

  assert.match(webview.html, /id="restart-button"/);
  assert.doesNotMatch(webview.html, /files-button/);
  assert.doesNotMatch(webview.html, />\s*文件\s*</);
});

test('webview script has no binding for the removed file button', () => {
  const source = readFileSync(
    resolvePath(__dirname, '../../media/src/webview.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /files-button|filesButton|pickFiles/);

  const bundle = readFileSync(
    resolvePath(__dirname, '../../media/webview.js'),
    'utf8',
  );
  assert.doesNotMatch(bundle, /files-button/);
});

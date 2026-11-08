import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath, win32 as win32Path } from 'node:path';

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

interface MockFolder {
  readonly name: string;
  readonly uri: MockUri;
  readonly fsPath: string;
}

/**
 * VS Code compares workspace folders by URI path, which on Windows is
 * case-insensitive and segment-boundary aware. Resolve through win32 so
 * `C:/demo` never matches `C:/demo-two` and nested roots can win by length.
 */
function canonicalWorkspacePath(fsPath: string): string {
  const resolved = win32Path.resolve(fsPath);
  const trimmed =
    resolved.length > 3 ? resolved.replace(/[\\/]+$/, '') : resolved;
  return trimmed.toLowerCase();
}

function isSameOrInsidePath(target: string, root: string): boolean {
  if (target === root) {
    return true;
  }
  const prefix = root.endsWith('\\') ? root : `${root}\\`;
  return target.startsWith(prefix);
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
  readonly workingDirectory?: unknown;
  readonly userProfileArgs?: readonly string[];
  readonly directories?: readonly string[];
  readonly invalidDirectories?: readonly string[];
  readonly workspaceFile?: MockUri;
  readonly folderPaths?: readonly string[];
  readonly workspaceStateSeed?: Readonly<Record<string, unknown>>;
  readonly openDialogChoice?:
    | readonly MockUri[]
    | ((
        options: Record<string, unknown>,
      ) =>
        | readonly MockUri[]
        | undefined
        | Promise<readonly MockUri[] | undefined>);
}

interface MockTreeViewRegistration {
  readonly id: string;
  readonly options: Record<string, unknown>;
}

interface Harness {
  readonly folder: MockFolder;
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
  readonly dialogCalls: Array<Record<string, unknown>>;
  readonly quickPickCalls: Array<{
    readonly items: unknown;
    readonly options: Record<string, unknown> | undefined;
  }>;
  readonly workspaceState: Map<string, unknown>;
  readonly workspaceStateWrites: Array<{ readonly key: string; readonly value: unknown }>;
  setActiveEditor(editor: unknown): void;
  setWarningChoice(value: string | undefined): void;
  resolveView(): { readonly html: string };
  sendMessage(message: unknown): void;
  addRoot(fsPath: string, name?: string): MockFolder;
  workspaceFolders(): readonly MockFolder[];
  getWorkspaceFolder(uri: MockUri): MockFolder | undefined;
  removeFolder(): void;
  setWorkingDirectory(value: unknown): void;
  fireConfigurationChange(...sections: string[]): void;
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
  const createFolder = (fsPath: string, name: string): MockFolder => {
    const uri = MockUri.file(fsPath);
    return { name, uri, fsPath: uri.fsPath };
  };
  const folderNames = options.folderPaths ?? ['C:/demo'];
  const folder = createFolder(folderNames[0] ?? 'C:/demo', 'demo');
  const extensionUri = MockUri.file('C:/extension');
  const workspaceState = new Map<string, unknown>(
    Object.entries(options.workspaceStateSeed ?? {}),
  );
  const workspaceStateWrites: Array<{
    readonly key: string;
    readonly value: unknown;
  }> = [];
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
  const dialogCalls: Array<Record<string, unknown>> = [];
  const quickPickCalls: Harness['quickPickCalls'] = [];
  const folderChangeListeners = new Set<(event: unknown) => void>();
  const configurationChangeListeners = new Set<
    (event: { affectsConfiguration(section: string): boolean }) => void
  >();
  let workingDirectoryValue: unknown = options.workingDirectory ?? '';
  let warningChoice = options.warningChoice;
  let folders: MockFolder[] = folderNames.map((fsPath, index) =>
    index === 0
      ? folder
      : createFolder(
          fsPath,
          fsPath
            .replace(/\\/g, '/')
            .replace(/\/+$/, '')
            .split('/')
            .filter((part) => part.length > 0)
            .at(-1) ?? fsPath,
        ),
  );
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
    args: [...(options.userProfileArgs ?? ['-NoLogo'])],
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
      if (key === 'command') {
        return options.command ?? 'opencode';
      }
      if (key === 'workingDirectory') {
        return workingDirectoryValue;
      }
      return fallback;
    },
    inspect(): unknown {
      return undefined;
    },
  };

  const disposable = { dispose() {} };
  function findWorkspaceFolder(uri: MockUri): MockFolder | undefined {
    const target = canonicalWorkspacePath(uri.fsPath);
    let best: { readonly folder: MockFolder; readonly length: number } | undefined;
    for (const candidate of folders) {
      const root = canonicalWorkspacePath(candidate.fsPath);
      if (!isSameOrInsidePath(target, root)) {
        continue;
      }
      if (best === undefined || root.length > best.length) {
        best = { folder: candidate, length: root.length };
      }
    }
    return best?.folder;
  }
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
      get workspaceFile() {
        return options.workspaceFile;
      },
      get isTrusted() {
        return trusted;
      },
      getConfiguration: (
        section: string,
        _scope?: unknown,
      ) =>
        section === 'terminal.integrated'
          ? terminalConfiguration
          : commandConfiguration,
      getWorkspaceFolder: (uri: MockUri) => findWorkspaceFolder(uri),
      onDidChangeWorkspaceFolders: (listener: (event: unknown) => void) => {
        folderChangeListeners.add(listener);
        return {
          dispose: () => folderChangeListeners.delete(listener),
        };
      },
      onDidGrantWorkspaceTrust: () => disposable,
      onDidChangeTextDocument: () => disposable,
      onDidChangeConfiguration: (
        listener: (event: {
          affectsConfiguration(section: string): boolean;
        }) => void,
      ) => {
        configurationChangeListeners.add(listener);
        return {
          dispose: () => configurationChangeListeners.delete(listener),
        };
      },
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
      showOpenDialog: async (dialogOptions: Record<string, unknown>) => {
        dialogCalls.push(dialogOptions);
        const choice = options.openDialogChoice;
        return typeof choice === 'function'
          ? await choice(dialogOptions)
          : choice;
      },
      showQuickPick: async (
        items: unknown,
        pickOptions?: Record<string, unknown>,
      ) => {
        quickPickCalls.push({ items, options: pickOptions });
        return undefined;
      },
      showWarningMessage: async (...args: unknown[]) => {
        warningCalls.push(args);
        return warningChoice;
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
          workspaceStateWrites.push({ key, value });
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
      statDirectory: async (fsPath: string) => {
        const target = canonicalWorkspacePath(fsPath);
        if (
          (options.invalidDirectories ?? []).some(
            (candidate) => canonicalWorkspacePath(candidate) === target,
          )
        ) {
          return false;
        }
        if (
          (options.directories ?? []).some(
            (candidate) => canonicalWorkspacePath(candidate) === target,
          )
        ) {
          return true;
        }
        return folders.some(
          (candidate) => canonicalWorkspacePath(candidate.fsPath) === target,
        );
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
      dialogCalls,
      quickPickCalls,
      workspaceState,
      workspaceStateWrites,
      setActiveEditor(editor: unknown) {
        activeEditor = editor;
      },
      setWarningChoice(value: string | undefined) {
        warningChoice = value;
      },
      resolveView,
      sendMessage(message: unknown) {
        if (messageHandler === undefined) {
          throw new Error('Webview message handler was not registered.');
        }
        messageHandler(message);
      },
      addRoot(fsPath: string, name?: string) {
        const fallbackName =
          fsPath
            .replace(/\\/g, '/')
            .replace(/\/+$/, '')
            .split('/')
            .filter((part) => part.length > 0)
            .at(-1) ?? fsPath;
        const added = createFolder(fsPath, name ?? fallbackName);
        folders = [...folders, added];
        for (const listener of [...folderChangeListeners]) {
          listener({ added: [added], removed: [] });
        }
        return added;
      },
      workspaceFolders() {
        return [...folders];
      },
      getWorkspaceFolder(uri: MockUri) {
        return findWorkspaceFolder(uri);
      },
      removeFolder() {
        folders = folders.filter((candidate) => candidate !== folder);
        for (const listener of [...folderChangeListeners]) {
          listener({ added: [], removed: [folder] });
        }
      },
      setWorkingDirectory(value: unknown) {
        workingDirectoryValue = value;
      },
      fireConfigurationChange(...sections: string[]) {
        for (const listener of [...configurationChangeListeners]) {
          listener({
            affectsConfiguration(section: string) {
              return sections.some(
                (candidate) =>
                  section === candidate || section.startsWith(`${candidate}.`),
              );
            },
          });
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

test('a normal single-folder workspace keeps the auto root without any picker', async () => {
  const harness = makeHarness();
  await startReady(harness);

  assert.equal(harness.dialogCalls.length, 0, 'no folder dialog');
  assert.equal(harness.quickPickCalls.length, 0, 'no project QuickPick');
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].options.cwd, harness.folder.fsPath);
  const state = lastState(harness);
  assert.equal(state.workspaceMode, false);
  assert.equal(state.workspaceName, 'demo');
  assert.equal(state.workingDirectory, harness.folder.fsPath);
  assert.equal(state.workingDirectorySource, 'owner');
});

test('a single-root .code-workspace selects the real working directory and formats references from it', async () => {
  const workspaceFile = MockUri.file('C:/workspaces/demo.code-workspace');
  const harness = makeHarness({
    workspaceFile,
    directories: ['D:/Workspace/FR'],
    openDialogChoice: [MockUri.file('D:/Workspace/FR')],
  });
  await startReady(harness);

  assert.equal(harness.quickPickCalls.length, 0, 'workspace mode must not show a project QuickPick');
  assert.equal(harness.dialogCalls.length, 1);
  assert.equal(harness.dialogCalls[0].canSelectFolders, true);
  assert.equal(harness.dialogCalls[0].canSelectFiles, false);
  assert.equal(harness.dialogCalls[0].canSelectMany, false);
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].options.cwd, 'D:/Workspace/FR');

  const state = lastState(harness);
  assert.equal(state.workspaceMode, true);
  assert.equal(state.workspaceKey, harness.folder.uri.toString());
  assert.equal(state.workspaceName, 'demo', 'the owner remains the project folder');
  assert.equal(state.workingDirectory, 'D:/Workspace/FR');
  assert.equal(state.workingDirectorySource, 'chosen');
  assert.equal(state.spawnWorkingDirectory, 'D:/Workspace/FR');
  assert.match(String(state.status), /项目（owner）：demo/);
  assert.match(String(state.status), /工作目录：D:\/Workspace\/FR/);

  const saved = harness.workspaceState.get(
    'opencodeTerminal.chosenWorkingDirectories.v1',
  ) as Record<string, unknown>;
  assert.equal(
    saved[`${workspaceFile.toString()}|${harness.folder.uri.toString()}`],
    'D:/Workspace/FR',
    'the user choice must be remembered before the session starts',
  );

  await dropController(harness).handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': {
        text:
          'file:///D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts',
      },
    }),
    { isCancellationRequested: false },
  );
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'workspace cwd reference write',
  );
  assert.equal(
    harness.processes[0].writes[1],
    '@sai-qx-student-client/apps/mobile/src/a.ts',
    'references must be relative to the selected real cwd, not absolute',
  );
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(
    lastState(harness).workspaceKey,
    harness.folder.uri.toString(),
    'choosing a cwd must not create a virtual owner folder',
  );
});

test('multi-root workspaces use the same directory picker without a project QuickPick', async () => {
  const harness = makeHarness({
    folderPaths: ['C:/demo', 'D:/other'],
    directories: ['D:/Workspace/FR'],
    openDialogChoice: [MockUri.file('D:/Workspace/FR')],
  });
  await startReady(harness);

  assert.equal(harness.quickPickCalls.length, 0);
  assert.equal(harness.dialogCalls.length, 1);
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].options.cwd, 'D:/Workspace/FR');
  const state = lastState(harness);
  assert.equal(state.workspaceMode, true);
  assert.equal(state.workspaceKey, harness.folder.uri.toString());
  assert.equal(state.workspaceName, 'demo');
  assert.equal(state.workingDirectory, 'D:/Workspace/FR');
});

test('canceled working-directory selection spawns nothing and writes no workspace state', async () => {
  const harness = makeHarness({
    workspaceFile: MockUri.file('C:/workspaces/demo.code-workspace'),
  });
  harness.resolveView();
  harness.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await harness.waitFor(
    () => harness.dialogCalls.length === 1,
    'working-directory dialog',
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(harness.spawnCalls.length, 0);
  assert.equal(harness.bridges.length, 0);
  assert.equal(harness.quickPickCalls.length, 0);
  assert.deepEqual(
    harness.workspaceStateWrites,
    [],
    'canceling must not persist a remembered cwd or an active folder',
  );
});

test('an explicit workingDirectory setting wins without a dialog in workspace mode, and manual switching explains the conflict', async () => {
  const harness = makeHarness({
    workspaceFile: MockUri.file('C:/workspaces/demo.code-workspace'),
    workingDirectory: 'D:/Workspace/FR',
    directories: ['D:/Workspace/FR'],
  });
  await startReady(harness);

  assert.equal(harness.dialogCalls.length, 0);
  assert.equal(harness.quickPickCalls.length, 0);
  assert.equal(harness.spawnCalls[0].options.cwd, 'D:/Workspace/FR');
  assert.equal(lastState(harness).workingDirectorySource, 'configured');

  const kills = harness.processes[0].killCount;
  harness.sendMessage({ type: 'chooseWorkspace' });
  await harness.waitFor(
    () => /工作目录由设置/.test(String(lastState(harness).notice?.message)),
    'configured directory explanation',
  );
  assert.equal(harness.dialogCalls.length, 0, 'the setting must not be silently overridden');
  assert.equal(harness.processes[0].killCount, kills);
  assert.equal(harness.spawnCalls.length, 1);
});

test('restart reuses the remembered working directory without asking again', async () => {
  const harness = makeHarness({
    workspaceFile: MockUri.file('C:/workspaces/demo.code-workspace'),
    directories: ['D:/Workspace/FR'],
    openDialogChoice: [MockUri.file('D:/Workspace/FR')],
  });
  await startReady(harness);
  assert.equal(harness.dialogCalls.length, 1);

  harness.sendMessage({ type: 'restart' });
  await harness.waitFor(() => harness.spawnCalls.length === 2, 'remembered restart');
  assert.equal(harness.dialogCalls.length, 1, 'restart must reuse the saved choice');
  assert.equal(harness.quickPickCalls.length, 0);
  assert.equal(harness.spawnCalls[1].options.cwd, 'D:/Workspace/FR');
});

test('a missing remembered directory is re-picked instead of silently using the project root', async () => {
  const workspaceFile = MockUri.file('C:/workspaces/demo.code-workspace');
  const owner = MockUri.file('C:/demo');
  const namespace = `${workspaceFile.toString()}|${owner.toString()}`;
  const harness = makeHarness({
    workspaceFile,
    directories: ['D:/Workspace/valid'],
    openDialogChoice: [MockUri.file('D:/Workspace/valid')],
    workspaceStateSeed: {
      'opencodeTerminal.chosenWorkingDirectories.v1': {
        [namespace]: 'D:/Workspace/missing',
      },
    },
  });
  await startReady(harness);

  assert.equal(harness.dialogCalls.length, 1);
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].options.cwd, 'D:/Workspace/valid');
  const saved = harness.workspaceState.get(
    'opencodeTerminal.chosenWorkingDirectories.v1',
  ) as Record<string, unknown>;
  assert.equal(saved[namespace], 'D:/Workspace/valid');
});

test('a .code-workspace without folders never spawns and asks for a workspace folder', async () => {
  const harness = makeHarness({
    workspaceFile: MockUri.file('C:/workspaces/empty.code-workspace'),
    folderPaths: [],
  });
  harness.resolveView();
  harness.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await harness.waitFor(
    () => lastState(harness)?.workspaceMode === true,
    'empty workspace state',
  );
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(harness.dialogCalls.length, 0);
  assert.equal(harness.quickPickCalls.length, 0);
  assert.equal(harness.spawnCalls.length, 0);
  assert.equal(harness.bridges.length, 0);
  assert.match(
    String(lastState(harness).status),
    /添加至少一个工作区文件夹/,
  );
});

test('switching the working directory confirms before killing an active PTY and uses exactly one picker', async () => {
  const choices = [
    MockUri.file('D:/Workspace/FR'),
    MockUri.file('D:/Workspace/NEW'),
    MockUri.file('D:/Workspace/NEW'),
  ];
  let choiceIndex = 0;
  const harness = makeHarness({
    workspaceFile: MockUri.file('C:/workspaces/demo.code-workspace'),
    directories: ['D:/Workspace/FR', 'D:/Workspace/NEW'],
    openDialogChoice: () => [choices[choiceIndex++]],
  });
  await startReady(harness);
  assert.equal(harness.dialogCalls.length, 1);

  harness.setWarningChoice(undefined);
  harness.sendMessage({ type: 'chooseWorkspace' });
  await harness.waitFor(() => harness.warningCalls.length === 1, 'switch confirmation');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.dialogCalls.length, 2, 'only the directory picker runs');
  assert.equal(harness.processes[0].killCount, 0, 'cancel must not kill the PTY');
  assert.equal(harness.spawnCalls.length, 1);
  const savedAfterCancel = harness.workspaceState.get(
    'opencodeTerminal.chosenWorkingDirectories.v1',
  ) as Record<string, unknown>;
  assert.equal(
    savedAfterCancel[
      `${MockUri.file('C:/workspaces/demo.code-workspace').toString()}|${harness.folder.uri.toString()}`
    ],
    'D:/Workspace/FR',
  );

  harness.setWarningChoice('结束会话并重启');
  harness.sendMessage({ type: 'chooseWorkspace' });
  await harness.waitFor(() => harness.spawnCalls.length === 2, 'switched cwd spawn');
  assert.equal(harness.dialogCalls.length, 3, 'switching must not show a second picker');
  assert.equal(harness.processes[0].killCount, 1, 'confirmed switch ends the old session');
  assert.equal(harness.spawnCalls[1].options.cwd, 'D:/Workspace/NEW');
  const state = lastState(harness);
  assert.equal(state.workingDirectory, 'D:/Workspace/NEW');
  assert.equal(state.workspaceKey, harness.folder.uri.toString());
  assert.equal(harness.quickPickCalls.length, 0);
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

async function startReady(harness: Harness): Promise<void> {
  harness.resolveView();
  harness.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await harness.waitFor(() => harness.spawnCalls.length === 1, 'PTY spawn');
  await harness.waitFor(
    () => harness.postedOfType('ptySnapshot').length > 0,
    'snapshot',
  );
}

function lastState(harness: Harness): {
  workspaceKey?: string | null;
  workspaceName?: string | null;
  workspaceMode?: boolean;
  workingDirectory?: string | null;
  workingDirectorySource?: string | null;
  ptyActive?: boolean;
  status?: string;
  restartRecommended?: boolean;
  referenceBase?: string | null;
  spawnWorkingDirectory?: string | null;
  referenceBaseOverride?: boolean;
  notice?: { kind?: string; message?: string; epoch?: string; id?: number };
} {
  return harness.postedOfType('state').at(-1) as {
    workspaceKey?: string | null;
    workspaceName?: string | null;
    workspaceMode?: boolean;
    workingDirectory?: string | null;
    workingDirectorySource?: string | null;
    ptyActive?: boolean;
    status?: string;
    restartRecommended?: boolean;
    referenceBase?: string | null;
    spawnWorkingDirectory?: string | null;
    referenceBaseOverride?: boolean;
    notice?: { kind?: string; message?: string; epoch?: string; id?: number };
  };
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

test('native tree drop accepts other registered roots and keeps nested roots relative', async () => {
  const harness = makeHarness();
  await startReady(harness);

  const other = harness.addRoot('D:/other', 'other');
  const mobile = harness.addRoot('C:/demo/apps/mobile', 'mobile');
  const caseRoot = harness.addRoot('C:/OtherRoot', 'CaseRoot');

  assert.deepEqual(
    harness.workspaceFolders().map((folder) => folder.fsPath),
    ['C:/demo', 'D:/other', 'C:/demo/apps/mobile', 'C:/OtherRoot'],
    'the added roots must be real workspace folders, not undefined externals',
  );
  assert.equal(
    harness.getWorkspaceFolder(MockUri.file('D:/other/src/b.ts'))?.uri.toString(),
    other.uri.toString(),
  );
  assert.equal(
    harness
      .getWorkspaceFolder(MockUri.file('C:/demo/apps/mobile/src/x.ts'))
      ?.uri.toString(),
    mobile.uri.toString(),
    'the longest nested root must win',
  );
  assert.equal(
    harness.getWorkspaceFolder(MockUri.file('c:/otherroot/src/c.ts'))?.uri.toString(),
    caseRoot.uri.toString(),
    'Windows workspace matching must be case-insensitive',
  );
  assert.equal(
    harness.getWorkspaceFolder(MockUri.file('C:/demo-two/src/z.ts')),
    undefined,
    'a sibling prefix that is not a path segment must not match C:/demo',
  );

  const controller = dropController(harness);
  await controller.handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': {
        text: [
          'file:///D:/other/src/b.ts',
          'file:///C:/demo/apps/mobile/src/x.ts',
          'file:///c:/otherroot/src/c.ts',
        ].join('\r\n'),
      },
    }),
    { isCancellationRequested: false },
  );
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'cross-root native mention write',
  );

  assert.equal(
    harness.processes[0].writes[1],
    '@D:/other/src/b.ts @apps/mobile/src/x.ts @c:/otherroot/src/c.ts',
  );
  assert.equal(/[\r\n\t]/.test(harness.processes[0].writes[1]), false);
  assert.equal(
    harness.processes[0].writes[1].includes('#'),
    false,
    'whole files must not gain a range suffix',
  );
  assert.equal(harness.spawnCalls.length, 1, 'adding roots must not spawn another PTY');
  assert.equal(harness.spawnCalls[0].options.cwd, harness.folder.fsPath);
  assert.equal(
    lastState(harness).workspaceKey,
    harness.folder.uri.toString(),
    'the active session folder must not change',
  );
});

test('webview drop accepts cross-root and outside files as absolute mentions', async () => {
  const harness = makeHarness();
  await startReady(harness);
  harness.addRoot('D:/other', 'other');
  harness.addRoot('C:/demo/apps/mobile', 'mobile');

  harness.sendMessage({
    type: 'drop',
    uriList: [
      'file:///D:/other/src/b.ts',
      'file:///C:/demo/apps/mobile/src/x.ts',
      'file:///C:/external/outside.ts',
    ].join('\r\n'),
  });
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'cross-root webview drop write',
  );

  assert.equal(
    harness.processes[0].writes[1],
    '@D:/other/src/b.ts @apps/mobile/src/x.ts @C:/external/outside.ts',
  );
  assert.equal(harness.processes[0].writes[1].includes('\r'), false);
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].options.cwd, harness.folder.fsPath);
});

test('Explorer addFile accepts cross-root and nested files without switching sessions', async () => {
  const harness = makeHarness();
  await startReady(harness);
  harness.addRoot('D:/other', 'other');
  harness.addRoot('C:/demo/apps/mobile', 'mobile');

  const addFile = harness.commands.get('opencodeTerminal.addFile') as
    | ((uri: MockUri) => Promise<void>)
    | undefined;
  assert.ok(addFile);

  await addFile(MockUri.file('D:/other/src/b.ts'));
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'cross-root addFile write',
  );
  assert.equal(harness.processes[0].writes[1], '@D:/other/src/b.ts');

  await addFile(MockUri.file('C:/demo/apps/mobile/src/x.ts'));
  await harness.waitFor(
    () => harness.processes[0].writes.length === 3,
    'nested addFile write',
  );
  assert.equal(harness.processes[0].writes[2], '@apps/mobile/src/x.ts');
  assert.equal(
    /[\r\n\t]/.test(harness.processes[0].writes.slice(1).join('')),
    false,
  );
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].options.cwd, harness.folder.fsPath);
  assert.equal(lastState(harness).workspaceKey, harness.folder.uri.toString());
});

test('cross-root selections use the active session root and bridge absolute paths', async () => {
  const harness = makeHarness({ documentLineCount: 42 });
  await startReady(harness);
  harness.addRoot('D:/other', 'other');

  const bridge = harness.bridges[0];
  bridge.ready = true;
  const document = {
    uri: MockUri.file('D:/other/src/b.ts'),
    getText: () => 'const b = 2;',
    lineCount: 42,
  };
  const selection = {
    isEmpty: false,
    start: { line: 10, character: 0 },
    end: { line: 12, character: 0 },
  };
  harness.setActiveEditor({ document, selection, selections: [selection] });

  const addSelection = harness.commands.get('opencodeTerminal.addSelection') as
    | (() => Promise<void>)
    | undefined;
  assert.ok(addSelection);
  await addSelection();
  await harness.waitFor(() => bridge.sent.length === 1, 'cross-root bridge send');
  assert.deepEqual(bridge.sent[0], {
    filePath: 'D:/other/src/b.ts',
    lineStart: 11,
    lineEnd: 12,
  });

  const single = {
    isEmpty: false,
    start: { line: 4, character: 2 },
    end: { line: 4, character: 10 },
  };
  harness.setActiveEditor({ document, selection: single, selections: [single] });
  await addSelection();
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'cross-root single-line fallback',
  );
  assert.equal(harness.processes[0].writes[1], '@D:/other/src/b.ts#5-5');
  assert.equal(/[\r\n\t]/.test(harness.processes[0].writes[1]), false);
  assert.equal(bridge.sent.length, 1, 'single-line selections stay text-only');
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].options.cwd, harness.folder.fsPath);
  assert.equal(
    lastState(harness).workspaceKey,
    harness.folder.uri.toString(),
    'referencing another root must not switch the active session',
  );
});

test('multi-root support still rejects directories and untrusted writes', async () => {
  const trusted = makeHarness({
    statType: (uri) => (uri.fsPath.endsWith('/dir.ts') ? 2 : 1),
  });
  await startReady(trusted);
  trusted.addRoot('D:/other', 'other');

  await dropController(trusted).handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': { text: 'file:///D:/other/src/dir.ts' },
    }),
    { isCancellationRequested: false },
  );
  assert.equal(trusted.processes[0].writes.length, 1, 'directories must not be written');
  assert.match(
    String(lastState(trusted).notice?.message),
    /不支持文件夹|未写入引用/,
  );

  trusted.processes[0].emitExit(0);
  await trusted.waitFor(
    () => lastState(trusted).ptyActive === false,
    'PTY exit state',
  );
  await dropController(trusted).handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': { text: 'file:///D:/other/src/b.ts' },
    }),
    { isCancellationRequested: false },
  );
  assert.equal(
    trusted.processes[0].writes.length,
    1,
    'an exited/inactive PTY must not receive cross-root references',
  );
  assert.match(String(lastState(trusted).notice?.message), /PTY 未运行/);

  const untrusted = makeHarness({ trusted: false });
  untrusted.addRoot('D:/other', 'other');
  await dropController(untrusted).handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': { text: 'file:///D:/other/src/b.ts' },
    }),
    { isCancellationRequested: false },
  );
  assert.equal(untrusted.spawnCalls.length, 0);
  assert.equal(untrusted.processes.length, 0);
  assert.equal(
    untrusted.errorMessages.some((message) => /限制模式/.test(message)),
    true,
  );
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

test('workingDirectory config spawns FR while the workspace owner and key stay on the project', async () => {
  const harness = makeHarness({
    workingDirectory: 'D:/Workspace/FR',
    directories: ['D:/Workspace/FR'],
  });
  await startReady(harness);

  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].options.cwd, 'D:/Workspace/FR');
  assert.equal(harness.spawnCalls[0].options.cwd, harness.spawnCalls[0].options.cwd.trim());
  assert.equal(
    lastState(harness).workspaceKey,
    harness.folder.uri.toString(),
    'a configured cwd must not change the workspace/session owner',
  );
  assert.equal(lastState(harness).workspaceName, harness.folder.name);
  assert.equal(lastState(harness).spawnWorkingDirectory, 'D:/Workspace/FR');

  await dropController(harness).handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': {
        text:
          'file:///D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts',
      },
    }),
    { isCancellationRequested: false },
  );
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'FR reference write',
  );

  assert.equal(
    harness.processes[0].writes[1],
    '@sai-qx-student-client/apps/mobile/src/a.ts',
    'the spawn cwd must be the reference base without any cd detection',
  );
  assert.equal(harness.spawnCalls.length, 1, 'referencing must not spawn again');
  assert.equal(
    lastState(harness).workspaceKey,
    harness.folder.uri.toString(),
  );
});

test('workingDirectory keeps shell profile workspace variables synchronized with the effective cwd', async () => {
  const harness = makeHarness({
    workingDirectory: 'D:/Workspace/FR',
    directories: ['D:/Workspace/FR'],
    userProfileArgs: [
      '${workspaceFolder}',
      '${workspaceFolderBasename}',
      '${userHome}',
    ],
  });
  await startReady(harness);

  assert.deepEqual(harness.spawnCalls[0].args.slice(0, 3), [
    'D:/Workspace/FR',
    'FR',
    homedir(),
  ]);
  assert.equal(
    harness.spawnCalls[0].args[0],
    harness.spawnCalls[0].options.cwd,
    'profile expansion and the spawn cwd must agree',
  );
});

test('changing workingDirectory at runtime only recommends a restart and keeps the current reference base', async () => {
  const harness = makeHarness();
  await startReady(harness);

  harness.setWorkingDirectory('D:/Workspace/FR');
  harness.fireConfigurationChange('opencodeTerminal.workingDirectory');
  await harness.waitFor(
    () => lastState(harness).restartRecommended === true,
    'restart recommendation',
  );

  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].options.cwd, harness.folder.fsPath);
  assert.equal(lastState(harness).referenceBase, harness.folder.fsPath);
  assert.match(String(lastState(harness).status), /重启 PTY 后生效/);

  await dropController(harness).handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': { text: 'file:///C:/demo/src/a.ts' },
    }),
    { isCancellationRequested: false },
  );
  await harness.waitFor(
    () => harness.processes[0].writes.length === 2,
    'current-base reference write',
  );
  assert.equal(
    harness.processes[0].writes[1],
    '@src/a.ts',
    'a pending setting change must not change the running session base',
  );
});

test('setReferenceBase changes only later @ mentions without writing, spawning or killing', async () => {
  const harness = makeHarness({
    directories: ['D:/Workspace/FR'],
    openDialogChoice: [MockUri.file('D:/Workspace/FR')],
  });
  await startReady(harness);
  const writesBefore = harness.processes[0].writes.length;
  const killBefore = harness.processes[0].killCount;
  const bridgeStopsBefore = harness.bridges[0].stopCount;

  const setReferenceBase = harness.commands.get(
    'opencodeTerminal.setReferenceBase',
  ) as (() => Promise<void>) | undefined;
  assert.ok(setReferenceBase);
  await setReferenceBase();

  assert.equal(harness.dialogCalls.length, 1);
  assert.equal(
    harness.dialogCalls[0].canSelectFolders,
    true,
    'the native folder dialog must be used',
  );
  assert.equal(harness.dialogCalls[0].canSelectFiles, false);
  assert.equal(
    (harness.dialogCalls[0].defaultUri as MockUri).fsPath,
    harness.folder.fsPath,
    'the dialog must default to the current reference base',
  );
  assert.equal(
    harness.processes[0].writes.length,
    writesBefore,
    'the command must never write to the PTY',
  );
  assert.equal(harness.spawnCalls.length, 1, 'the command must not spawn');
  assert.equal(harness.processes[0].killCount, killBefore);
  assert.equal(harness.bridges[0].stopCount, bridgeStopsBefore);
  assert.equal(lastState(harness).referenceBaseOverride, true);
  assert.equal(lastState(harness).referenceBase, 'D:/Workspace/FR');
  assert.equal(lastState(harness).spawnWorkingDirectory, harness.folder.fsPath);
  assert.match(String(lastState(harness).status), /仅本会话手动设置/);
  assert.match(String(lastState(harness).status), /未执行 cd/);
  assert.match(String(lastState(harness).notice?.message), /只影响之后的 @ 引用/);
  assert.match(String(lastState(harness).notice?.message), /重启 PTY 后恢复启动目录/);
  assert.equal(
    lastState(harness).workspaceKey,
    harness.folder.uri.toString(),
    'the active owner must not switch',
  );

  await dropController(harness).handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': {
        text:
          'file:///D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts',
      },
    }),
    { isCancellationRequested: false },
  );
  await harness.waitFor(
    () => harness.processes[0].writes.length === writesBefore + 1,
    'override reference write',
  );
  assert.equal(
    harness.processes[0].writes.at(-1),
    '@sai-qx-student-client/apps/mobile/src/a.ts',
  );
  assert.equal(harness.spawnCalls.length, 1);
});

test('an invalid configured workingDirectory prevents both bridge and PTY spawn', async () => {
  const harness = makeHarness({
    workingDirectory: 'D:/Workspace/missing',
    directories: ['C:/demo'],
  });
  harness.resolveView();
  harness.sendMessage({ type: 'ready', cols: 100, rows: 30 });

  await harness.waitFor(
    () => lastState(harness).notice?.kind === 'error',
    'invalid working directory error',
  );
  assert.match(
    String(lastState(harness).notice?.message),
    /工作目录不存在或不是文件夹/,
  );
  assert.equal(
    Number.isSafeInteger(lastState(harness).notice?.id),
    true,
    'host notices need a monotonic id for webview deduplication',
  );
  assert.equal(
    typeof lastState(harness).notice?.epoch,
    'string',
    'host notices need a provider-activation epoch',
  );
  assert.ok(
    (lastState(harness).notice?.epoch ?? '').length > 0,
    'the notice epoch must not be empty',
  );
  const firstEpoch = lastState(harness).notice?.epoch;
  const firstId = lastState(harness).notice?.id;
  const stateCount = harness.postedOfType('state').length;
  harness.sendMessage({ type: 'attach', cols: 100, rows: 30 });
  await harness.waitFor(
    () => harness.postedOfType('state').length > stateCount,
    'replayed state',
  );
  assert.equal(
    lastState(harness).notice?.id,
    firstId,
    'postState replay must keep the same notice id instead of renewing it',
  );
  assert.equal(
    lastState(harness).notice?.epoch,
    firstEpoch,
    'postState replay must keep the same notice epoch',
  );
  assert.equal(harness.spawnCalls.length, 0);
  assert.equal(harness.bridges.length, 0);
  assert.equal(harness.processes.length, 0);
});

test('a new provider activation gets a new notice epoch so id 1 is not swallowed', async () => {
  const options = {
    workingDirectory: 'D:/Workspace/missing',
    directories: ['C:/demo'],
  };
  const first = makeHarness(options);
  first.resolveView();
  first.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await first.waitFor(
    () => lastState(first).notice?.kind === 'error',
    'first provider error',
  );

  const second = makeHarness(options);
  second.resolveView();
  second.sendMessage({ type: 'ready', cols: 100, rows: 30 });
  await second.waitFor(
    () => lastState(second).notice?.kind === 'error',
    'second provider error',
  );

  const firstNotice = lastState(first).notice;
  const secondNotice = lastState(second).notice;
  assert.equal(firstNotice?.id, 1);
  assert.equal(secondNotice?.id, 1);
  assert.ok(firstNotice?.epoch, 'the first provider must send an epoch');
  assert.ok(secondNotice?.epoch, 'the second provider must send an epoch');
  assert.notEqual(
    firstNotice?.epoch,
    secondNotice?.epoch,
    'a restarted extension host must not reuse the old epoch',
  );
});

test('setReferenceBase requires an active PTY and opens no dialog without one', async () => {
  const harness = makeHarness({
    directories: ['D:/Workspace/FR'],
    openDialogChoice: [MockUri.file('D:/Workspace/FR')],
  });
  harness.resolveView();

  const command = harness.commands.get(
    'opencodeTerminal.setReferenceBase',
  ) as () => Promise<void>;
  await command();

  assert.equal(harness.dialogCalls.length, 0);
  assert.equal(harness.spawnCalls.length, 0);
  assert.match(
    String(lastState(harness).notice?.message),
    /PTY 未运行/,
  );
});

test('setReferenceBase rejects invalid directories and untrusted workspaces', async () => {
  const invalid = makeHarness({
    directories: ['C:/demo'],
    openDialogChoice: [MockUri.file('D:/Workspace/missing')],
  });
  await startReady(invalid);
  const command = invalid.commands.get(
    'opencodeTerminal.setReferenceBase',
  ) as () => Promise<void>;
  await command();

  assert.equal(lastState(invalid).referenceBaseOverride, false);
  assert.match(
    String(lastState(invalid).notice?.message),
    /引用基准目录不存在或不是文件夹/,
  );
  await dropController(invalid).handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': {
        text: 'file:///D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts',
      },
    }),
    { isCancellationRequested: false },
  );
  await invalid.waitFor(
    () => invalid.processes[0].writes.length === 2,
    'absolute fallback after invalid dialog directory',
  );
  assert.equal(
    invalid.processes[0].writes[1],
    '@D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts',
  );

  const untrusted = makeHarness({
    trusted: false,
    directories: ['D:/Workspace/FR'],
    openDialogChoice: [MockUri.file('D:/Workspace/FR')],
  });
  const untrustedCommand = untrusted.commands.get(
    'opencodeTerminal.setReferenceBase',
  ) as () => Promise<void>;
  await untrustedCommand();
  assert.equal(untrusted.dialogCalls.length, 0, 'must fail before opening a dialog');
  assert.equal(untrusted.spawnCalls.length, 0);
  assert.equal(
    untrusted.errorMessages.some((message) => /限制模式/.test(message)),
    true,
  );
});

test('setReferenceBase refuses to save when the PTY session changed during the dialog', async () => {
  let harness: Harness;
  harness = makeHarness({
    directories: ['D:/Workspace/FR'],
    openDialogChoice: () => {
      harness.processes[0].emitExit(0);
      return [MockUri.file('D:/Workspace/FR')];
    },
  });
  await startReady(harness);

  const command = harness.commands.get(
    'opencodeTerminal.setReferenceBase',
  ) as () => Promise<void>;
  await command();
  await harness.waitFor(
    () => lastState(harness).notice?.kind === 'error',
    'session-change rejection',
  );
  assert.match(
    String(lastState(harness).notice?.message),
    /活动 PTY 会话已变化|PTY 未运行/,
  );
  assert.equal(lastState(harness).referenceBaseOverride, false);

  const startCommand = harness.commands.get('opencodeTerminal.start') as
    | (() => Promise<void>)
    | undefined;
  assert.ok(startCommand);
  await startCommand();
  await harness.waitFor(() => harness.spawnCalls.length === 2, 'new session');
  await dropController(harness).handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': {
        text: 'file:///D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts',
      },
    }),
    { isCancellationRequested: false },
  );
  await harness.waitFor(
    () => harness.processes[1].writes.length === 2,
    'absolute reference after rejected override',
  );
  assert.equal(
    harness.processes[1].writes[1],
    '@D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts',
  );
});

test('restart and exit discard the in-memory reference base override', async () => {
  const harness = makeHarness({
    directories: ['D:/Workspace/FR'],
    openDialogChoice: [MockUri.file('D:/Workspace/FR')],
  });
  await startReady(harness);
  const setReferenceBase = harness.commands.get(
    'opencodeTerminal.setReferenceBase',
  ) as () => Promise<void>;
  await setReferenceBase();
  assert.equal(lastState(harness).referenceBaseOverride, true);

  harness.sendMessage({ type: 'restart' });
  await harness.waitFor(() => harness.spawnCalls.length === 2, 'restarted PTY');
  await harness.waitFor(
    () => lastState(harness).referenceBaseOverride === false,
    'override cleared on restart',
  );
  assert.equal(lastState(harness).referenceBase, harness.folder.fsPath);
  assert.equal(lastState(harness).spawnWorkingDirectory, harness.folder.fsPath);

  await dropController(harness).handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': {
        text: 'file:///D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts',
      },
    }),
    { isCancellationRequested: false },
  );
  await harness.waitFor(
    () => harness.processes[1].writes.length === 2,
    'absolute reference after restart',
  );
  assert.equal(
    harness.processes[1].writes[1],
    '@D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts',
  );

  await setReferenceBase();
  assert.equal(lastState(harness).referenceBaseOverride, true);
  harness.processes[1].emitExit(0);
  await harness.waitFor(
    () => lastState(harness).referenceBaseOverride === false,
    'override cleared on exit',
  );
  assert.equal(lastState(harness).referenceBase, null);
});

test('removing a workspace discards its reference base override', async () => {
  const harness = makeHarness({
    directories: ['D:/Workspace/FR'],
    openDialogChoice: [MockUri.file('D:/Workspace/FR')],
  });
  await startReady(harness);
  const setReferenceBase = harness.commands.get(
    'opencodeTerminal.setReferenceBase',
  ) as () => Promise<void>;
  await setReferenceBase();
  assert.equal(lastState(harness).referenceBaseOverride, true);

  harness.removeFolder();
  await harness.waitFor(
    () => lastState(harness).workspaceKey === null,
    'workspace removal',
  );
  harness.addRoot('C:/demo', 'demo');
  const startCommand = harness.commands.get('opencodeTerminal.start') as
    | (() => Promise<void>)
    | undefined;
  assert.ok(startCommand);
  await startCommand();
  await harness.waitFor(() => harness.spawnCalls.length === 2, 're-added session');

  await dropController(harness).handleDrop(
    undefined,
    nativeTransfer({
      'text/uri-list': {
        text: 'file:///D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts',
      },
    }),
    { isCancellationRequested: false },
  );
  await harness.waitFor(
    () => harness.processes[1].writes.length === 2,
    'absolute reference after folder re-add',
  );
  assert.equal(
    harness.processes[1].writes[1],
    '@D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts',
  );
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

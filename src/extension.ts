import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { formatMention, parseDropPayload, type TextRange } from './core';
import {
  EditorBridge,
  type EditorBridgeLike,
} from './editorBridge';
import { FileDropView } from './fileDropView';
import { spawnPty } from './ptyAdapter';
import {
  PtySessionManager,
  type PtyEvent,
  type PtySpawn,
} from './ptySession';
import {
  MAX_REFERENCES,
  planReference,
  uniqueReferences,
  type ReferenceFallbackReason,
  type ReferenceTarget,
} from './references';
import {
  resolveShellProfile,
  type ShellLaunchConfig,
  type ShellProfile,
  type ShellProfileWarning,
} from './shellProfile';
import {
  MAX_CLIPBOARD_TEXT_LENGTH,
  MAX_PTY_INPUT_LENGTH,
  MAX_SELECTION_TEXT_LENGTH,
  SELECTION_TTL_MS,
  invalidateSelectionCache,
  matchSelection,
  parseWebviewMessage,
  recordSelection,
  validateLaunchCommand,
  type SelectionMatchReason,
  type SelectionSnapshot,
  type WebviewInboundMessage,
} from './runtime';
import {
  sanitizeEnv,
  sanitizeProfiles,
  terminalPlatformKey,
  terminalSettingKeys,
  withEditorBridgeEnvironment,
  withTerminalEnvironment,
} from './terminalConfig';

const VIEW_ID = 'opencodeTerminal.main';
const CONFIG_SECTION = 'opencodeTerminal';
const STATE_LAST_FOLDER = 'opencodeTerminal.lastFolder.v1';
const OUTPUT_BATCH_MS = 8;
const MAX_OUTPUT_BATCH_CHARS = 64 * 1024;

type DropMessage = Extract<WebviewInboundMessage, { readonly type: 'drop' }>;

type WorkspaceConfigChoice = 'workspace' | 'user';

interface ShellRuntimeInfo {
  readonly label: string;
  readonly warnings: readonly string[];
}

interface Notice {
  readonly kind: 'info' | 'error';
  readonly message: string;
}

interface OutputBatch {
  readonly sessionId: string;
  readonly fromSequence: number;
  toSequence: number;
  data: string;
}

export interface ExtensionDependencies {
  /** Injectable for tests; defaults to the prebuilt N-API node-pty adapter. */
  readonly spawn?: PtySpawn;
  readonly createSessionId?: () => string;
  /** Injectable for tests; one bridge is created per started workspace PTY. */
  readonly createEditorBridge?: () => EditorBridgeLike;
}

interface EditorBridgeEntry {
  readonly bridge: EditorBridgeLike;
  sessionId: string | undefined;
}

class OpenCodeViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private selectionCache: readonly SelectionSnapshot[] = [];
  private lastFolderKey: string | undefined;
  private activeFolderKey: string | undefined;
  private readonly exitedFolders = new Set<string>();
  private readonly shellByFolder = new Map<string, ShellRuntimeInfo>();
  private readonly workspaceConfigChoices = new Map<string, WorkspaceConfigChoice>();
  private notice: Notice | undefined;
  private autoStartAttempted = false;
  private restartRecommended = false;
  private lastMentionText: string | undefined;
  private lastCols = 80;
  private lastRows = 24;
  private focusRequested = false;

  private attached = false;
  private streamSessionId: string | undefined;
  private streamSequence = 0;
  private outputBatch: OutputBatch | undefined;
  private outputTimer: NodeJS.Timeout | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private viewDisposables: vscode.Disposable[] = [];
  private readonly pty: PtySessionManager;
  private readonly bridges = new Map<string, EditorBridgeEntry>();
  private readonly createEditorBridge: () => EditorBridgeLike;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
    dependencies: ExtensionDependencies = {},
  ) {
    const savedFolder = context.workspaceState.get<string>(STATE_LAST_FOLDER);
    if (typeof savedFolder === 'string') {
      this.lastFolderKey = savedFolder;
    }

    this.createEditorBridge =
      dependencies.createEditorBridge ?? (() => new EditorBridge());
    this.pty = new PtySessionManager(dependencies.spawn ?? spawnPty, {
      ...(dependencies.createSessionId === undefined
        ? {}
        : { createSessionId: dependencies.createSessionId }),
    });
    this.disposables.push(this.pty);
    this.disposables.push(
      this.pty.subscribe((event) => {
        this.handlePtyEvent(event);
      }),
    );

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.captureSelection(event.textEditor, event.selections);
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        const uri = event.document.uri.toString();
        this.selectionCache = invalidateSelectionCache(this.selectionCache, uri);
        const active = vscode.window.activeTextEditor;
        if (active !== undefined && active.document.uri.toString() === uri) {
          this.captureSelection(active, active.selections);
        }
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        let activeRemoved = false;
        for (const folder of event.removed) {
          const folderKey = folder.uri.toString();
          if (this.activeFolderKey === folderKey) {
            activeRemoved = true;
          }
          this.forgetFolder(folderKey);
        }
        this.reconcileActiveFolder();

        if (!activeRemoved) {
          this.postState();
          return;
        }

        // If exactly one workspace remains, show it; otherwise clear the
        // active terminal view until the user picks a folder.
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (this.activeFolderKey === undefined && folders.length === 1) {
          this.activeFolderKey = folders[0].uri.toString();
        }
        if (this.view !== undefined) {
          this.sendSnapshot();
        } else {
          this.postState();
        }
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.postState();
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        const shellChanged =
          event.affectsConfiguration('terminal.integrated.defaultProfile') ||
          event.affectsConfiguration('terminal.integrated.profiles') ||
          event.affectsConfiguration('terminal.integrated.env');
        const commandChanged = event.affectsConfiguration(
          `${CONFIG_SECTION}.command`,
        );
        if (!shellChanged && !commandChanged) {
          return;
        }
        if (shellChanged) {
          this.workspaceConfigChoices.clear();
        }
        if (this.activeFolderKey !== undefined) {
          this.restartRecommended = true;
        }
        this.postState();
      }),
    );

    const active = vscode.window.activeTextEditor;
    if (active !== undefined) {
      this.captureSelection(active, active.selections);
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    const nonce = randomBytes(16).toString('hex');
    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js'),
    );
    const styleUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css'),
    );
    webviewView.webview.html = buildWebviewHtml(
      webviewView.webview.cspSource,
      nonce,
      scriptUri,
      styleUri,
    );

    const messageListener = webviewView.webview.onDidReceiveMessage((raw) => {
      void this.handleWebviewMessage(raw);
    });
    const disposeListener = webviewView.onDidDispose(() => {
      messageListener.dispose();
      if (this.view === webviewView) {
        this.view = undefined;
        this.attached = false;
        this.clearOutputTimer();
      }
    });
    for (const disposable of this.viewDisposables) {
      disposable.dispose();
    }
    this.viewDisposables = [messageListener, disposeListener];
    this.postState();
  }

  dispose(): void {
    this.disposed = true;
    this.clearOutputTimer();
    this.attached = false;
    for (const folderKey of [...this.bridges.keys()]) {
      void this.stopBridge(folderKey);
    }
    for (const disposable of this.viewDisposables) {
      disposable.dispose();
    }
    this.viewDisposables = [];
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.view = undefined;
  }

  async start(): Promise<void> {
    this.notice = undefined;
    // An explicit start supplies its own folder choice; do not race the
    // first-resolve auto-start with a second Quick Pick.
    this.autoStartAttempted = true;
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    const folder = await this.requireActiveOrChooseFolder('选择要运行 OpenCode 的工作区');
    if (folder === undefined) {
      this.postState();
      return;
    }
    await this.startSession(folder, { restart: false });
  }

  async restart(): Promise<void> {
    this.notice = undefined;
    if (!vscode.workspace.isTrusted) {
      this.reportError('当前工作区处于限制模式，已禁止启动 PTY。');
      return;
    }
    const folder = await this.requireActiveOrChooseFolder('选择要重启 OpenCode 的工作区');
    if (folder === undefined) {
      this.postState();
      return;
    }
    await this.startSession(folder, { restart: true });
  }

  async focusTerminal(): Promise<void> {
    this.notice = undefined;
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    if (this.view === undefined) {
      this.focusRequested = true;
      return;
    }
    this.view.show?.(true);
    this.postMessage({ type: 'focusPty' });
  }

  async addActiveSelection(): Promise<void> {
    this.notice = undefined;
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      this.reportError('请先打开一个文本编辑器，再添加选区。');
      return;
    }
    if (editor.document.uri.scheme !== 'file') {
      this.reportError('仅支持本地文件中的选区。');
      return;
    }

    const folder = this.activeFolderOrContaining(editor.document.uri);
    if (folder === undefined) {
      this.reportError('请先选择 OpenCode 工作区。');
      return;
    }
    const containing = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (
      containing !== undefined &&
      this.activeFolderKey !== undefined &&
      containing.uri.toString() !== this.activeFolderKey
    ) {
      this.reportError('该文件属于其他工作区，未写入当前 PTY。请先切换工作区。');
      return;
    }
    const range = editor.selection.isEmpty
      ? undefined
      : toTextRange(editor.selection);
    const problems: string[] = [];
    const reference = this.makeReference(
      editor.document.uri,
      folder,
      range,
      problems,
    );
    if (reference === undefined) {
      this.reportError(problems[0] ?? '无法读取当前选区的引用信息。');
      return;
    }
    await this.writeReferences([reference], folder);
  }

  async addExplorerUris(uris: readonly vscode.Uri[]): Promise<void> {
    this.notice = undefined;
    if (uris.length === 0) {
      this.reportError('请从 Explorer 选择一个或多个文件。');
      return;
    }
    const folder = await this.requireActiveOrChooseFolder('选择引用的工作区');
    if (folder === undefined) {
      this.postState();
      return;
    }
    if (this.activeFolderKey === undefined) {
      // A tree drop can activate the extension before the webview has sent
      // ready/attach. Record the chosen folder so writeMentions can report the
      // real "PTY 未运行" state instead of a misleading cross-workspace error.
      this.setActiveFolder(folder);
    }
    await this.addUris(uris, folder);
  }

  /**
   * Entry point for the native TreeView drop target. It deliberately reuses
   * `addExplorerUris` (stat, workspace check, mention formatting, PTY write)
   * and only adds deduplication plus focusing the existing webview. It never
   * creates another terminal and never sends an Enter key.
   */
  async addDroppedUris(uris: readonly vscode.Uri[]): Promise<void> {
    this.notice = undefined;
    const unique = new Map<string, vscode.Uri>();
    for (const uri of uris) {
      const key = uri.toString();
      if (!unique.has(key)) {
        unique.set(key, uri);
      }
    }
    if (unique.size === 0) {
      this.reportError('未识别到可用的本地文件。请从 VS Code Explorer 拖入文件。');
      return;
    }

    await this.focusTerminal();
    await this.addExplorerUris([...unique.values()]);
  }

  reportDropError(message: string): void {
    this.reportError(message);
  }

  async pickFiles(): Promise<void> {
    this.notice = undefined;
    const folder = await this.requireActiveOrChooseFolder('选择引用的工作区');
    if (folder === undefined) {
      this.postState();
      return;
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: '插入为 @ 引用',
      title: '选择要插入为 OpenCode 引用的文件',
    });
    if (uris === undefined || uris.length === 0) {
      return;
    }
    await this.addUris(uris, folder);
  }

  async copyLastMentions(): Promise<void> {
    this.notice = undefined;
    if (this.lastMentionText === undefined || this.lastMentionText.length === 0) {
      this.reportError('没有可复制的引用。拖入文件或使用“添加文件”命令后会保存最近一次引用。');
      return;
    }
    await this.copyText(this.lastMentionText);
  }

  clearTerminal(): void {
    this.notice = { kind: 'info', message: '已清除 xterm 滚动缓冲；没有向 PTY 发送内容。' };
    this.postMessage({ type: 'clearTerminal' });
    this.postState();
  }

  private async handleWebviewMessage(raw: unknown): Promise<void> {
    const parsed = parseWebviewMessage(raw);
    if (!parsed.ok) {
      this.reportError(`已忽略无效的 webview 消息：${parsed.error}`);
      return;
    }

    try {
      switch (parsed.message.type) {
        case 'ready':
          await this.handleReady(parsed.message.cols, parsed.message.rows);
          return;
        case 'attach':
          await this.handleAttach(parsed.message.cols, parsed.message.rows);
          return;
        case 'start':
          await this.start();
          return;
        case 'restart':
          await this.restart();
          return;
        case 'focusTerminal':
          await this.focusTerminal();
          return;
        case 'chooseWorkspace':
          await this.chooseWorkspace();
          return;
        case 'pickFiles':
          await this.pickFiles();
          return;
        case 'addActiveSelection':
          await this.addActiveSelection();
          return;
        case 'clear':
          this.clearTerminal();
          return;
        case 'copyClipboard':
          await this.copyText(parsed.message.text);
          return;
        case 'ptyInput':
          this.handlePtyInput(parsed.message.sessionId, parsed.message.data);
          return;
        case 'ptyResize':
          this.handlePtyResize(
            parsed.message.sessionId,
            parsed.message.cols,
            parsed.message.rows,
          );
          return;
        case 'drop':
          await this.handleDrop(parsed.message);
          return;
        case 'insert':
        case 'copy':
        case 'remove':
          this.reportError('引用抽屉已移除；请直接拖放，或使用右键/“添加文件”命令插入 @ 引用。');
          return;
      }
    } catch (error) {
      this.reportError(toErrorMessage(error));
    }
  }

  private async handleReady(cols?: number, rows?: number): Promise<void> {
    if (this.view === undefined) {
      return;
    }
    if (cols !== undefined) {
      this.lastCols = cols;
    }
    if (rows !== undefined) {
      this.lastRows = rows;
    }

    if (!this.autoStartAttempted) {
      this.autoStartAttempted = true;
      await this.initialAutoStart(cols, rows);
    }
    if (this.view === undefined) {
      return;
    }
    await this.handleAttach(cols, rows);
    if (this.focusRequested) {
      this.focusRequested = false;
      this.postMessage({ type: 'focusPty' });
    }
  }

  private async initialAutoStart(cols?: number, rows?: number): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.postState();
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.postState();
      return;
    }

    let folder: vscode.WorkspaceFolder | undefined;
    if (folders.length === 1) {
      folder = folders[0];
    } else {
      folder = await this.chooseFolder('选择首次运行 OpenCode 的工作区');
    }
    if (folder === undefined || this.view === undefined) {
      this.postState();
      return;
    }
    await this.startSession(folder, { restart: false, cols, rows });
  }

  private async handleAttach(cols?: number, rows?: number): Promise<void> {
    if (cols !== undefined) {
      this.lastCols = cols;
    }
    if (rows !== undefined) {
      this.lastRows = rows;
    }
    this.reconcileActiveFolder();
    if (this.activeFolderKey === undefined) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 1 && vscode.workspace.isTrusted) {
        this.activeFolderKey = folders[0].uri.toString();
      }
    }

    // The initial fit happens before xterm has a session, so its onResize does
    // not reach the PTY. A ready/attach message carries the real dimensions;
    // resize an already-running PTY even when FitAddon will not fire again.
    const folderKey = this.activeFolderKey;
    if (folderKey !== undefined && cols !== undefined && rows !== undefined) {
      const snapshot = this.pty.snapshot(folderKey);
      if (snapshot !== undefined) {
        const resized = this.pty.resize(
          folderKey,
          snapshot.sessionId,
          cols,
          rows,
        );
        if (
          !resized.ok &&
          resized.code !== 'stale-session' &&
          resized.code !== 'inactive'
        ) {
          this.reportError(`无法同步 PTY 尺寸：${resized.message}`);
        }
      }
    }
    this.sendSnapshot();
  }

  private sendSnapshot(): void {
    const folder = this.activeFolder();
    const folderKey = folder?.uri.toString();
    const snapshot =
      folderKey === undefined ? undefined : this.pty.snapshot(folderKey);
    const shell = folderKey === undefined ? undefined : this.shellByFolder.get(folderKey);

    this.attached = true;
    this.streamSessionId = snapshot?.sessionId;
    this.streamSequence = snapshot?.sequence ?? 0;
    this.clearOutputTimer();
    this.outputBatch = undefined;

    this.postMessage({
      type: 'ptySnapshot',
      workspaceKey: folderKey ?? null,
      folderName: folder?.name ?? null,
      shellLabel: shell?.label ?? null,
      session: snapshot ?? null,
      truncated: snapshot?.truncated === true,
      displayCols: this.lastCols,
      displayRows: this.lastRows,
    });
    this.postState();
  }

  private async startSession(
    folder: vscode.WorkspaceFolder,
    options: {
      readonly restart: boolean;
      readonly cols?: number;
      readonly rows?: number;
    },
  ): Promise<void> {
    this.notice = undefined;
    if (!vscode.workspace.isTrusted) {
      this.reportError('当前工作区处于限制模式，已禁止启动 PTY。');
      return;
    }

    const folderKey = folder.uri.toString();
    this.setActiveFolder(folder);

    const configured = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<unknown>('command', 'opencode');
    const command = validateLaunchCommand(configured);
    if (!command.ok) {
      this.reportError(`OpenCode 启动命令无效：${command.message}`);
      return;
    }

    const shell = await this.resolveShell(folder);
    if (shell === undefined) {
      this.postState();
      return;
    }

    if (options.restart) {
      this.pty.stop(folderKey);
      await this.stopBridge(folderKey);
    }
    if (this.disposed) {
      return;
    }

    // Start the bridge before the shell so both editor port environment
    // variables are present for OpenCode's first process.
    const bridgeEntry = await this.ensureBridge(folderKey);
    if (this.disposed) {
      if (bridgeEntry !== undefined) {
        await this.stopBridge(folderKey);
      }
      return;
    }

    const result = this.pty.ensure(folderKey, {
      shellPath: shell.shellPath,
      args: shell.args,
      env: withEditorBridgeEnvironment(
        withTerminalEnvironment(shell.env),
        bridgeEntry?.bridge.port,
      ),
      cwd: folder.uri.fsPath,
      launchCommand: command.command,
      cols: options.cols ?? this.lastCols,
      rows: options.rows ?? this.lastRows,
    });

    if (!result.ok) {
      if (bridgeEntry !== undefined) {
        await this.stopBridge(folderKey);
      }
      this.reportError(
        `无法启动 PTY：${result.message}` +
          (shell.warnings.length > 0 ? '（终端配置存在警告，详见设置）' : ''),
      );
      if (this.view !== undefined) {
        this.sendSnapshot();
      }
      return;
    }

    if (bridgeEntry !== undefined) {
      bridgeEntry.sessionId = result.session.sessionId;
    }

    this.exitedFolders.delete(folderKey);
    this.restartRecommended = false;
    if (result.created) {
      this.shellByFolder.set(folderKey, shellInfo(shell));
      this.notice = {
        kind: 'info',
        message: `已在 ${folder.name} 启动 PTY 并执行配置的启动命令（未验证 OpenCode 是否已进入前台）。`,
      };
    } else {
      if (!this.shellByFolder.has(folderKey)) {
        this.shellByFolder.set(folderKey, shellInfo(shell));
      }
      this.notice = {
        kind: 'info',
        message: `已复用 ${folder.name} 的现有 PTY；没有重复发送启动命令。`,
      };
    }

    if (this.view !== undefined) {
      this.sendSnapshot();
    } else {
      this.postState();
    }
  }

  private async ensureBridge(
    folderKey: string,
  ): Promise<EditorBridgeEntry | undefined> {
    const existing = this.bridges.get(folderKey);
    if (existing !== undefined) {
      try {
        await existing.bridge.start();
        return existing;
      } catch {
        await this.stopBridge(folderKey);
      }
    }

    let bridge: EditorBridgeLike;
    try {
      bridge = this.createEditorBridge();
    } catch {
      return undefined;
    }
    const entry: EditorBridgeEntry = { bridge, sessionId: undefined };
    this.bridges.set(folderKey, entry);
    try {
      await bridge.start();
      return entry;
    } catch {
      this.bridges.delete(folderKey);
      try {
        await bridge.stop();
      } catch {
        // Startup failed; stop is best-effort.
      }
      return undefined;
    }
  }

  private async stopBridge(folderKey: string): Promise<void> {
    const entry = this.bridges.get(folderKey);
    if (entry === undefined) {
      return;
    }
    this.bridges.delete(folderKey);
    try {
      await entry.bridge.stop();
    } catch {
      // Bridge teardown is best-effort; the socket is already closed.
    }
  }

  private async resolveShell(
    folder: vscode.WorkspaceFolder,
  ): Promise<ShellLaunchConfig | undefined> {
    const platform = process.platform;
    const platformKey = terminalPlatformKey(platform);
    const configuration = vscode.workspace.getConfiguration(
      'terminal.integrated',
      folder.uri,
    );

    const workspaceKeys = terminalSettingKeys(platform).filter((key) =>
      hasWorkspaceValue(configuration, key),
    );
    let choice: WorkspaceConfigChoice = 'workspace';
    if (workspaceKeys.length > 0) {
      const folderKey = folder.uri.toString();
      const remembered = this.workspaceConfigChoices.get(folderKey);
      if (remembered !== undefined) {
        choice = remembered;
      } else {
        const picked = await vscode.window.showWarningMessage(
          '当前工作区包含 terminal.integrated 的 shell、profile 或 env 设置。',
          {
            modal: true,
            detail:
              '使用工作区配置会把这些设置（包括环境变量）合并进 PTY。' +
              '扩展不会记录或显示环境变量值。选择“仅使用用户配置”可避免工作区注入。',
          },
          '使用工作区配置',
          '仅使用用户配置',
        );
        if (picked === undefined) {
          return undefined;
        }
        choice = picked === '使用工作区配置' ? 'workspace' : 'user';
        this.workspaceConfigChoices.set(folderKey, choice);
      }
    }

    const read = (key: string): unknown =>
      choice === 'user'
        ? userScopedValue(configuration, key)
        : configuration.get<unknown>(key);

    const defaultProfileValue = read(`defaultProfile.${platformKey}`);
    const defaultProfile =
      typeof defaultProfileValue === 'string' && defaultProfileValue.length > 0
        ? defaultProfileValue
        : undefined;

    const profiles = sanitizeProfiles(read(`profiles.${platformKey}`));
    const integratedEnv = sanitizeEnv(read(`env.${platformKey}`));

    // `vscode.env.shell` is VS Code's currently resolved default shell. The
    // public API does not reveal whether a workspace profile selected it, so
    // when the user rejects workspace terminal settings we must not use it as
    // a fallback. Only explicit user/default profile paths may be used then.
    const rejectedWorkspaceConfig =
      choice === 'user' && workspaceKeys.length > 0;
    if (rejectedWorkspaceConfig) {
      const selectedProfile =
        defaultProfile === undefined ? undefined : profiles[defaultProfile];
      if (!hasExplicitProfilePath(selectedProfile)) {
        this.reportError(
          `已拒绝工作区终端配置，但无法仅从用户/默认设置安全确定 shell 路径。` +
            `请在用户设置中为 terminal.integrated.profiles.${platformKey} 的默认 profile 配置显式 path，` +
            `或重新启动并允许工作区终端配置。`,
        );
        return undefined;
      }
    }
    const envShell = rejectedWorkspaceConfig
      ? undefined
      : usableEnvShell(vscode.env.shell);

    const result = resolveShellProfile({
      platform,
      ...(defaultProfile === undefined ? {} : { defaultProfile }),
      profiles,
      ...(envShell === undefined ? {} : { envShell }),
      baseEnv: process.env,
      integratedEnv,
      workspacePath: folder.uri.fsPath,
      home: os.homedir(),
      fileExists: (candidate) => {
        try {
          return fs.existsSync(candidate);
        } catch {
          return false;
        }
      },
    });

    if (!result.ok) {
      const details = result.warnings
        .slice(0, 3)
        .map((warning) => warning.message)
        .join(' ');
      const workspaceHint =
        rejectedWorkspaceConfig &&
        (result.code === 'unsupported-profile' || result.code === 'missing-shell')
          ? ` 已拒绝工作区终端配置，且无法仅从用户/默认设置安全确定 shell 路径。` +
            `请在用户设置中为 terminal.integrated.profiles.${platformKey} 的默认 profile 配置显式 path，` +
            `或重新启动并允许工作区终端配置。`
          : '';
      this.reportError(
        `无法使用当前终端配置中的 shell：${result.message}` +
          workspaceHint +
          (details.length > 0 ? ` ${details}` : ''),
      );
      return undefined;
    }

    return result;
  }

  private async chooseWorkspace(): Promise<void> {
    this.notice = undefined;
    if (!vscode.workspace.isTrusted) {
      this.reportError('当前工作区处于限制模式，已禁止启动 PTY。');
      return;
    }
    const folder = await this.chooseFolder('切换 OpenCode 工作区');
    if (folder === undefined) {
      this.postState();
      return;
    }
    this.setActiveFolder(folder);
    const key = folder.uri.toString();
    if (this.pty.snapshot(key) === undefined) {
      await this.startSession(folder, { restart: false });
    } else {
      this.sendSnapshot();
    }
  }

  private handlePtyInput(sessionId: string, data: string): void {
    if (!vscode.workspace.isTrusted) {
      this.reportError('当前工作区处于限制模式，已禁止向 PTY 写入。');
      return;
    }
    const folderKey = this.activeFolderKey;
    if (folderKey === undefined) {
      this.reportError('没有活动工作区；输入未发送。');
      return;
    }
    if (data.length > MAX_PTY_INPUT_LENGTH) {
      this.reportError('输入过长，未发送到 PTY。');
      return;
    }

    const result = this.pty.sendInput(folderKey, sessionId, data);
    if (result.ok) {
      return;
    }
    if (result.code === 'stale-session' || result.code === 'inactive') {
      this.reportError('PTY 已不活跃；输入未发送。请先启动/重启 PTY。');
      const snapshot = this.pty.snapshot(folderKey);
      if (snapshot !== undefined && snapshot.sessionId !== sessionId) {
        // A replacement session exists but the webview still has the old id.
        this.sendSnapshot();
      } else {
        this.postState();
      }
      return;
    }
    this.reportError(`无法写入 PTY：${result.message}`);
  }

  private handlePtyResize(sessionId: string, cols: number, rows: number): void {
    this.lastCols = cols;
    this.lastRows = rows;
    const folderKey = this.activeFolderKey;
    if (folderKey === undefined) {
      return;
    }
    const result = this.pty.resize(folderKey, sessionId, cols, rows);
    if (!result.ok && result.code !== 'stale-session' && result.code !== 'inactive') {
      this.reportError(`无法调整 PTY 尺寸：${result.message}`);
    }
  }

  private async handleDrop(message: DropMessage): Promise<void> {
    this.notice = undefined;
    if (!vscode.workspace.isTrusted) {
      this.reportError('当前工作区处于限制模式，已禁止拖放写入。');
      return;
    }

    const folder = this.activeFolder();
    if (folder === undefined) {
      this.reportError('没有活动工作区。请先选择工作区并启动 PTY。');
      return;
    }

    const payload: Record<string, unknown> = {};
    if (message.uriList !== undefined) {
      payload['text/uri-list'] = message.uriList;
    }
    if (message.codeUriList !== undefined) {
      payload['application/vnd.code.uri-list'] = message.codeUriList;
    }
    if (message.resourceUrls !== undefined) {
      payload.ResourceURLs = message.resourceUrls;
    }
    if (message.codeFiles !== undefined) {
      payload.CodeFiles = message.codeFiles;
    }
    if (message.codeEditors !== undefined) {
      payload.CodeEditors = message.codeEditors;
    }
    if (message.plainText !== undefined) {
      payload['text/plain'] = message.plainText;
    }

    const parsed = parseDropPayload(payload);
    const plainText = parsed.plainText;
    if (
      parsed.files.length === 0 &&
      (plainText === undefined || plainText.length === 0)
    ) {
      const warning = parsed.warnings[0]?.message;
      this.reportError(
        warning === undefined
          ? '未能识别拖入的内容。请从 VS Code Explorer 拖入文件，或从编辑器拖入选区。'
          : `未能识别拖入的内容：${warning}`,
      );
      return;
    }

    const references: ReferenceTarget[] = [];
    const problems: string[] = [];
    const folderKey = folder.uri.toString();

    for (const target of parsed.files) {
      let uri: vscode.Uri;
      try {
        if (target.path !== undefined) {
          uri = vscode.Uri.file(target.path);
        } else if (target.uri !== undefined) {
          uri = vscode.Uri.parse(target.uri);
        } else {
          problems.push('拖入的文件条目既没有路径也没有 URI。');
          continue;
        }
      } catch {
        problems.push('拖入的文件路径或 URI 无效。');
        continue;
      }
      if (uri.scheme !== 'file') {
        problems.push(`不支持的文件类型：${uri.toString()}`);
        continue;
      }
      const containing = vscode.workspace.getWorkspaceFolder(uri);
      if (containing !== undefined && containing.uri.toString() !== folderKey) {
        problems.push(`文件属于其他工作区：${uri.fsPath}`);
        continue;
      }

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) {
          problems.push(`不支持文件夹：${uri.fsPath}`);
          continue;
        }
      } catch {
        problems.push(`无法读取文件：${uri.fsPath}`);
        continue;
      }

      const reference = this.makeReference(uri, folder, target.range, problems);
      if (reference !== undefined) {
        references.push(reference);
      }
    }

    if (
      parsed.files.length === 0 &&
      plainText !== undefined &&
      plainText.length > 0
    ) {
      const match = matchSelection(
        this.selectionCache,
        plainText,
        Date.now(),
        SELECTION_TTL_MS,
      );
      if (match.ok) {
        let uri: vscode.Uri | undefined;
        try {
          uri = vscode.Uri.parse(match.entry.uri);
        } catch {
          uri = undefined;
        }
        if (uri === undefined || uri.scheme !== 'file') {
          problems.push('缓存的选区 URI 无效，未添加引用。');
        } else {
          const reference = this.makeReference(
            uri,
            folder,
            match.entry.range,
            problems,
          );
          if (reference !== undefined) {
            references.push(reference);
          }
        }
      } else {
        problems.push(selectionMatchMessage(match.reason));
      }
    }

    await this.writeReferences(
      this.finishReferenceCollection(references, problems),
      folder,
      problems,
    );
  }

  private async addUris(
    uris: readonly vscode.Uri[],
    folder: vscode.WorkspaceFolder,
  ): Promise<void> {
    const references: ReferenceTarget[] = [];
    const problems: string[] = [];
    const folderKey = folder.uri.toString();

    for (const uri of uris) {
      if (uri.scheme !== 'file') {
        problems.push(`仅支持本地文件：${uri.toString()}`);
        continue;
      }
      const containing = vscode.workspace.getWorkspaceFolder(uri);
      if (containing !== undefined && containing.uri.toString() !== folderKey) {
        problems.push(`文件属于其他工作区：${uri.fsPath}`);
        continue;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) {
          problems.push(`不支持文件夹：${uri.fsPath}`);
          continue;
        }
      } catch {
        problems.push(`无法读取文件：${uri.fsPath}`);
        continue;
      }

      const reference = this.makeReference(uri, folder, undefined, problems);
      if (reference !== undefined) {
        references.push(reference);
      }
    }

    await this.writeReferences(
      this.finishReferenceCollection(references, problems),
      folder,
      problems,
    );
  }

  private makeReference(
    uri: vscode.Uri,
    folder: vscode.WorkspaceFolder,
    range: TextRange | undefined,
    problems: string[],
  ): ReferenceTarget | undefined {
    const formatted = formatMention(uri.fsPath, folder.uri.fsPath, range);
    if (!formatted.ok) {
      problems.push(formatted.message);
      return undefined;
    }
    return {
      uri: uri.toString(),
      filePath: uri.fsPath,
      rootPath: folder.uri.fsPath,
      ...(range === undefined ? {} : { range }),
    };
  }

  private finishReferenceCollection(
    references: readonly ReferenceTarget[],
    problems: string[],
  ): readonly ReferenceTarget[] {
    if (references.length > MAX_REFERENCES) {
      problems.push(`引用数量超过 ${MAX_REFERENCES} 个，超出部分已忽略。`);
    }
    const unique = uniqueReferences(references);
    if (unique.length === 0) {
      const shown = problems.slice(0, 3).join('；');
      this.reportError(
        shown.length > 0
          ? `未写入引用：${shown}${problems.length > 3 ? '…' : ''}`
          : '未找到可写入的引用。',
      );
    }
    return unique;
  }

  private async writeReferences(
    references: readonly ReferenceTarget[],
    folder: vscode.WorkspaceFolder,
    problems: readonly string[] = [],
  ): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.reportError('当前工作区处于限制模式，已禁止写入 PTY。');
      return;
    }
    if (references.length === 0) {
      return;
    }

    const folderKey = folder.uri.toString();
    if (folderKey !== this.activeFolderKey) {
      this.reportError('该工作区不是当前活动 PTY。请切换工作区后再试。');
      return;
    }
    const snapshot = this.pty.snapshot(folderKey);
    if (snapshot === undefined) {
      this.reportError(
        'PTY 未运行，引用未写入。请先点击“重启”启动 PTY，再重新拖放/添加。',
      );
      return;
    }

    const bridgeEntry = this.bridges.get(folderKey);
    const bridgeBound =
      bridgeEntry !== undefined &&
      bridgeEntry.sessionId === snapshot.sessionId &&
      this.pty.isActive(folderKey, snapshot.sessionId);

    const allMentions: string[] = [];
    const fallbackMentions: string[] = [];
    const fallbackNotes = new Set<string>();
    let bridgeSent = 0;
    let unrepresentable = 0;

    for (const reference of references) {
      const plan = planReference(reference);
      if (plan.mention !== undefined) {
        allMentions.push(plan.mention);
      }

      if (plan.kind === 'text') {
        if (plan.mention !== undefined) {
          fallbackMentions.push(plan.mention);
        } else {
          unrepresentable += 1;
        }
        fallbackNotes.add(referenceFallbackNote(plan.reason));
        continue;
      }

      if (!bridgeBound || bridgeEntry === undefined) {
        fallbackMentions.push(plan.mention);
        fallbackNotes.add('引用桥接未连接（需重启 PTY 采用新端口）');
        continue;
      }

      const sent = bridgeEntry.bridge.sendMention({
        filePath: plan.filePath,
        lineStart: plan.lines.startLine,
        lineEnd: plan.lines.endLine,
      });
      if (sent.ok) {
        bridgeSent += 1;
        continue;
      }
      // Never retry a failed/sent mention: a retry could duplicate it in the
      // TUI. Fall back to one text mention for this reference only.
      fallbackMentions.push(plan.mention);
      fallbackNotes.add(
        sent.reason === 'disconnected' || sent.reason === 'disposed'
          ? '引用桥接已断开，已文本回退'
          : '引用桥接尚未完成握手，已文本回退',
      );
    }

    const uniqueFallback = [...new Set(fallbackMentions)];
    const text = uniqueFallback.join(' ');
    if (text.length > MAX_PTY_INPUT_LENGTH) {
      this.reportError('引用文本过长，未写入。请分批拖入。');
      return;
    }

    let textWritten = false;
    if (text.length > 0) {
      const result = this.pty.sendInput(folderKey, snapshot.sessionId, text);
      if (!result.ok) {
        if (result.code === 'write-failed') {
          await this.copyText(text, '写入 PTY 失败，已复制到剪贴板。');
          return;
        }
        const bridgePart =
          bridgeSent > 0
            ? `已发送 ${bridgeSent} 个引用添加请求（未提交）；`
            : '';
        this.reportError(
          `${bridgePart}文本回退未写入（${result.code}）：${result.message}。` +
            '扩展不会把引用盲目写进 shell，也不会重试已发送的桥接请求。',
        );
        return;
      }
      textWritten = true;
    }

    if (bridgeSent === 0 && !textWritten) {
      const shown = problems.slice(0, 3).join('；');
      this.reportError(
        shown.length > 0
          ? `未写入引用：${shown}${problems.length > 3 ? '…' : ''}`
          : unrepresentable > 0
            ? '引用无法转换为可写入的格式。'
            : '没有可写入的引用。',
      );
      return;
    }

    this.lastMentionText =
      allMentions.length > 0 ? [...new Set(allMentions)].join(' ') : undefined;

    const parts: string[] = [];
    if (bridgeSent > 0) {
      parts.push(
        `已发送 ${bridgeSent} 个引用添加请求（未提交；内部接口无 ACK，未收到 TUI 确认）`,
      );
    }
    if (textWritten) {
      parts.push(
        `已将 ${uniqueFallback.length} 个引用作为文本写入 PTY（未按回车；需手动确认，未提交）`,
      );
    }
    if (fallbackNotes.size > 0) {
      parts.push([...fallbackNotes].slice(0, 2).join('；'));
    }
    if (problems.length > 0) {
      parts.push(`${problems.length} 项被忽略`);
    }
    this.notice = {
      kind: problems.length > 0 || unrepresentable > 0 ? 'error' : 'info',
      message: `${parts.join('；')}。`,
    };
    this.postState();
  }

  private async copyText(
    text: string,
    message = '已复制到剪贴板。',
  ): Promise<void> {
    if (text.length > MAX_CLIPBOARD_TEXT_LENGTH) {
      this.reportError('内容过长，未复制。');
      return;
    }
    try {
      await vscode.env.clipboard.writeText(text);
    } catch (error) {
      this.reportError(`复制失败：${toErrorMessage(error)}`);
      return;
    }
    this.notice = { kind: 'info', message };
    this.postState();
  }

  private handlePtyEvent(event: PtyEvent): void {
    if (event.type === 'exit') {
      // The editor bridge belongs to this PTY session. Do not leave it
      // listening for a shell that no longer exists.
      void this.stopBridge(event.workspaceKey);
    }
    if (event.workspaceKey !== this.activeFolderKey) {
      return;
    }

    if (event.type === 'data') {
      if (!this.attached || this.streamSessionId !== event.sessionId) {
        return;
      }
      this.queueOutput(event);
      return;
    }

    this.flushOutput();
    if (this.streamSessionId !== event.sessionId) {
      return;
    }
    this.attached = false;
    this.streamSessionId = undefined;
    this.exitedFolders.add(event.workspaceKey);
    this.postMessage({
      type: 'ptyExit',
      sessionId: event.sessionId,
      exitCode: event.exitCode,
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    });
    this.postState();
  }

  private queueOutput(event: Extract<PtyEvent, { readonly type: 'data' }>): void {
    if (event.sequence <= this.streamSequence) {
      return;
    }
    const current = this.outputBatch;
    if (
      current === undefined ||
      current.sessionId !== event.sessionId ||
      current.toSequence + 1 !== event.sequence ||
      current.data.length + event.data.length > MAX_OUTPUT_BATCH_CHARS
    ) {
      this.flushOutput();
      this.outputBatch = {
        sessionId: event.sessionId,
        fromSequence: event.sequence,
        toSequence: event.sequence,
        data: event.data,
      };
    } else {
      current.data += event.data;
      current.toSequence = event.sequence;
    }
    this.scheduleOutputFlush();
  }

  private scheduleOutputFlush(): void {
    if (this.outputTimer !== undefined) {
      return;
    }
    this.outputTimer = setTimeout(() => {
      this.outputTimer = undefined;
      this.flushOutput();
    }, OUTPUT_BATCH_MS);
  }

  private flushOutput(): void {
    if (this.outputTimer !== undefined) {
      clearTimeout(this.outputTimer);
      this.outputTimer = undefined;
    }
    const batch = this.outputBatch;
    this.outputBatch = undefined;
    if (batch === undefined || !this.attached) {
      return;
    }
    if (batch.sessionId !== this.streamSessionId) {
      return;
    }
    if (batch.fromSequence !== this.streamSequence + 1) {
      // A gap means output would be lost. Ask for a fresh snapshot instead of
      // displaying a partial stream.
      this.sendSnapshot();
      return;
    }
    this.streamSequence = batch.toSequence;
    this.postMessage({
      type: 'ptyOutput',
      sessionId: batch.sessionId,
      fromSequence: batch.fromSequence,
      sequence: batch.toSequence,
      data: batch.data,
    });
  }

  private clearOutputTimer(): void {
    if (this.outputTimer !== undefined) {
      clearTimeout(this.outputTimer);
      this.outputTimer = undefined;
    }
  }

  private captureSelection(
    editor: vscode.TextEditor | undefined,
    selections: readonly vscode.Selection[],
  ): void {
    if (editor === undefined || editor.document.uri.scheme !== 'file') {
      return;
    }

    const now = Date.now();
    for (const selection of selections) {
      if (selection.isEmpty) {
        continue;
      }
      const text = editor.document.getText(selection);
      if (text.length === 0 || text.length > MAX_SELECTION_TEXT_LENGTH) {
        continue;
      }
      this.selectionCache = recordSelection(
        this.selectionCache,
        {
          uri: editor.document.uri.toString(),
          text,
          range: toTextRange(selection),
          capturedAt: now,
        },
        now,
      );
    }
  }

  private async requireActiveOrChooseFolder(
    placeHolder: string,
  ): Promise<vscode.WorkspaceFolder | undefined> {
    if (!vscode.workspace.isTrusted) {
      this.reportError('当前工作区处于限制模式，已禁止启动 PTY 或写入。');
      return undefined;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.reportError('未打开工作区。请先打开一个文件夹。');
      return undefined;
    }
    const active = this.activeFolder();
    if (active !== undefined) {
      return active;
    }
    return this.chooseFolder(placeHolder);
  }

  private activeFolder(): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (this.activeFolderKey !== undefined) {
      const found = folders.find(
        (folder) => folder.uri.toString() === this.activeFolderKey,
      );
      if (found !== undefined) {
        return found;
      }
    }
    return folders.length === 1 ? folders[0] : undefined;
  }

  private activeFolderOrContaining(
    uri: vscode.Uri,
  ): vscode.WorkspaceFolder | undefined {
    const active = this.activeFolder();
    if (active !== undefined) {
      return active;
    }
    return vscode.workspace.getWorkspaceFolder(uri);
  }

  private forgetFolder(folderKey: string): void {
    this.pty.stop(folderKey);
    void this.stopBridge(folderKey);
    this.exitedFolders.delete(folderKey);
    this.shellByFolder.delete(folderKey);
    this.workspaceConfigChoices.delete(folderKey);
    if (this.lastFolderKey === folderKey) {
      this.lastFolderKey = undefined;
    }
    if (this.activeFolderKey === folderKey) {
      this.activeFolderKey = undefined;
      this.attached = false;
      this.streamSessionId = undefined;
      this.streamSequence = 0;
      this.outputBatch = undefined;
      this.clearOutputTimer();
    }
  }

  private reconcileActiveFolder(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (this.activeFolderKey === undefined) {
      return;
    }
    if (!folders.some((folder) => folder.uri.toString() === this.activeFolderKey)) {
      this.activeFolderKey = undefined;
    }
  }

  private setActiveFolder(folder: vscode.WorkspaceFolder): void {
    const folderKey = folder.uri.toString();
    this.activeFolderKey = folderKey;
    this.lastFolderKey = folderKey;
    this.exitedFolders.delete(folderKey);
    void this.context.workspaceState.update(STATE_LAST_FOLDER, folderKey);
  }

  private async chooseFolder(
    placeHolder: string,
  ): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return undefined;
    }
    if (folders.length === 1) {
      return folders[0];
    }

    const items = folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    }));
    items.sort((a, b) => {
      if (a.folder.uri.toString() === this.lastFolderKey) {
        return -1;
      }
      if (b.folder.uri.toString() === this.lastFolderKey) {
        return 1;
      }
      return a.label.localeCompare(b.label);
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: 'OpenCode 工作区',
      placeHolder,
      ignoreFocusOut: true,
    });
    if (picked === undefined) {
      return undefined;
    }
    this.lastFolderKey = picked.folder.uri.toString();
    await this.context.workspaceState.update(
      STATE_LAST_FOLDER,
      this.lastFolderKey,
    );
    return picked.folder;
  }

  private postState(): void {
    if (this.view === undefined) {
      return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = this.activeFolder();
    const folderKey = folder?.uri.toString();
    const snapshot =
      folderKey === undefined ? undefined : this.pty.snapshot(folderKey);
    const shell = folderKey === undefined ? undefined : this.shellByFolder.get(folderKey);
    const trusted = vscode.workspace.isTrusted;

    let status: string;
    if (!trusted) {
      status = '限制模式：不会启动 PTY，也不会向终端写入。';
    } else if (folders.length === 0) {
      status = '未打开工作区。';
    } else if (folder === undefined) {
      status = '请选择工作区。';
    } else if (snapshot !== undefined) {
      status = `PTY 运行中（${shell?.label ?? 'shell'}）。扩展无法判断 OpenCode 是否仍在前台。`;
    } else if (this.exitedFolders.has(folderKey ?? '')) {
      status = 'PTY 已退出。引用不会写入 shell；请点击“重启”。';
    } else {
      status = 'PTY 未启动。请点击“重启”或打开侧栏自动启动。';
    }
    if (this.restartRecommended) {
      status += ' 终端配置已更改，重启 PTY 后生效。';
    }

    this.postMessage({
      type: 'state',
      workspaceName: folder?.name ?? null,
      workspaceCount: folders.length,
      workspaceKey: folderKey ?? null,
      shellLabel: shell?.label ?? null,
      shellWarnings: shell?.warnings ?? [],
      status,
      ptyActive: snapshot !== undefined,
      sessionId: snapshot?.sessionId ?? null,
      trusted,
      restartRecommended: this.restartRecommended,
      notice: this.notice ?? null,
    });
  }

  private reportError(message: string): void {
    this.notice = { kind: 'error', message };
    this.postState();
    if (this.view === undefined) {
      void vscode.window.showErrorMessage(message);
    }
  }

  private postMessage(message: unknown): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage(message);
  }
}

function referenceFallbackNote(reason: ReferenceFallbackReason): string {
  switch (reason) {
    case 'whole-file-text':
      return '整文件以纯文本 @ 引用插入（不使用行范围）';
    case 'single-line':
      return '单行选区只能文本回退（内部协议会丢失 end 行）';
    case 'invalid-range':
      return '选区范围无法结构化引用，已文本回退';
    case 'invalid-path':
      return '路径无法转换为引用，已忽略';
    case 'missing-uri':
      return '引用缺少 URI，已文本回退';
  }
}

function selectionMatchMessage(reason: SelectionMatchReason): string {
  switch (reason) {
    case 'empty':
      return '拖入的文本为空。';
    case 'too-long':
      return '拖入的文本过长，未尝试匹配选区。';
    case 'expired':
      return '最近的选区缓存已过期（5 分钟）。请重新选择后拖入，或使用右键“添加当前选区”。';
    case 'ambiguous':
      return '拖入的文本匹配到多个最近选区，无法确定行号。请使用右键“添加当前选区”。';
    case 'no-match':
      return '拖入的纯文本没有匹配到唯一的最近非空选区（仅做精确匹配）。请使用右键“添加当前选区”，扩展不会把任意文本写入终端。';
  }
}

function shellInfo(config: ShellLaunchConfig): ShellRuntimeInfo {
  const executable = path.basename(config.shellPath);
  const label =
    config.profileName === undefined
      ? executable
      : `${config.profileName} · ${executable}`;
  return {
    label,
    warnings: formatWarnings(config.warnings),
  };
}

function formatWarnings(warnings: readonly ShellProfileWarning[]): readonly string[] {
  return warnings.slice(0, 3).map((warning) => warning.message);
}

function usableEnvShell(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return undefined;
  }
  return value;
}

function hasExplicitProfilePath(
  profile: ShellProfile | undefined,
): boolean {
  if (profile === undefined) {
    return false;
  }
  if (typeof profile.path === 'string') {
    return profile.path.trim().length > 0;
  }
  return (
    Array.isArray(profile.path) &&
    profile.path.some((candidate) => candidate.trim().length > 0)
  );
}

function hasWorkspaceValue(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
): boolean {
  const inspected = configuration.inspect<unknown>(key);
  return (
    inspected !== undefined &&
    (inspected.workspaceValue !== undefined ||
      inspected.workspaceFolderValue !== undefined)
  );
}

function userScopedValue(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
): unknown {
  const inspected = configuration.inspect<unknown>(key);
  if (inspected === undefined) {
    return undefined;
  }
  return inspected.globalValue === undefined
    ? inspected.defaultValue
    : inspected.globalValue;
}

function toTextRange(range: vscode.Range): TextRange {
  return {
    start: {
      line: range.start.line,
      character: range.start.character,
    },
    end: {
      line: range.end.line,
      character: range.end.character,
    },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildWebviewHtml(
  cspSource: string,
  nonce: string,
  scriptUri: vscode.Uri,
  styleUri: vscode.Uri,
): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src ${cspSource} data:; font-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src 'none';">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>OpenCode</title>
</head>
<body>
  <div id="app" class="app">
    <header class="toolbar">
      <button id="workspace-button" class="workspace" type="button" title="切换工作区">
        <span id="workspace-name">工作区</span>
      </button>
      <span id="shell-label" class="shell" title="当前 shell">shell</span>
      <span class="spacer"></span>
      <button id="restart-button" type="button" title="重启 PTY">重启</button>
    </header>
    <div id="notice" class="notice" role="status" aria-live="polite" hidden></div>
    <main id="terminal-wrap" class="terminal-wrap">
      <div id="terminal" class="terminal" aria-label="OpenCode 终端"></div>
    </main>
    <div id="drop-overlay" class="drop-overlay" hidden>拖放文件或选区以插入 @ 引用</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

let activeProvider: OpenCodeViewProvider | undefined;

export function activate(
  context: vscode.ExtensionContext,
  dependencies: ExtensionDependencies = {},
): void {
  const provider = new OpenCodeViewProvider(
    context,
    context.extensionUri,
    dependencies,
  );
  activeProvider = provider;

  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const dropOutput = vscode.window.createOutputChannel('OpenCode 拖放');
  context.subscriptions.push(dropOutput);
  context.subscriptions.push(
    new FileDropView({
      addUris: (uris) => provider.addDroppedUris(uris),
      reportError: (message) => provider.reportDropError(message),
      log: (line) => dropOutput.appendLine(line),
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeTerminal.open', () =>
      provider.focusTerminal(),
    ),
    vscode.commands.registerCommand('opencodeTerminal.start', () =>
      provider.start(),
    ),
    vscode.commands.registerCommand('opencodeTerminal.focusTerminal', () =>
      provider.focusTerminal(),
    ),
    vscode.commands.registerCommand('opencodeTerminal.addSelection', () =>
      provider.addActiveSelection(),
    ),
    vscode.commands.registerCommand('opencodeTerminal.pickFiles', () =>
      provider.pickFiles(),
    ),
    vscode.commands.registerCommand('opencodeTerminal.addFile', (...args: unknown[]) => {
      const uris: vscode.Uri[] = [];
      for (const arg of args) {
        collectUris(arg, uris);
      }
      return provider.addExplorerUris(uris);
    }),
    vscode.commands.registerCommand('opencodeTerminal.clear', () => {
      provider.clearTerminal();
    }),
    vscode.commands.registerCommand('opencodeTerminal.copyAll', () =>
      provider.copyLastMentions(),
    ),
  );
}

export function deactivate(): void {
  // Kill every PTY this extension owns. A shell cannot survive an extension
  // host reload because the native child process belongs to this host.
  activeProvider?.dispose();
  activeProvider = undefined;
}

function collectUris(value: unknown, output: vscode.Uri[]): void {
  if (value instanceof vscode.Uri) {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUris(item, output);
    }
  }
}

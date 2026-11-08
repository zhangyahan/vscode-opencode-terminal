import { randomBytes, randomUUID } from 'node:crypto';
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
import {
  isWorkspaceMode,
  resolveWorkingDirectory,
} from './workingDirectory';

const VIEW_ID = 'opencodeTerminal.main';
const CONFIG_SECTION = 'opencodeTerminal';
const STATE_LAST_FOLDER = 'opencodeTerminal.lastFolder.v1';
const STATE_CHOSEN_WORKING_DIRECTORIES =
  'opencodeTerminal.chosenWorkingDirectories.v1';
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
  /** Random per provider activation; a restarted host starts a new epoch. */
  readonly epoch: string;
  /** Monotonic within one epoch; the webview uses it to ignore replays. */
  readonly id: number;
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
  /** Injectable for tests; verifies the effective PTY cwd is real. */
  readonly statDirectory?: (fsPath: string) => Promise<boolean>;
}

interface EditorBridgeEntry {
  readonly bridge: EditorBridgeLike;
  sessionId: string | undefined;
}

interface ReferenceBaseOverride {
  /** The session this override was explicitly set for. */
  readonly sessionId: string;
  /** Directory used only to format subsequent @ mentions. */
  readonly basePath: string;
}

type WorkingDirectorySource = 'configured' | 'chosen' | 'owner';

interface LaunchDirectory {
  readonly path: string;
  readonly source: WorkingDirectorySource;
}

type LaunchDirectoryResult =
  | ({ readonly ok: true } & LaunchDirectory)
  | { readonly ok: false; readonly reason: 'cancelled' | 'invalid' };

type PickWorkingDirectoryResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: 'cancelled' | 'invalid' };

interface DisplayWorkingDirectory {
  readonly path: string | undefined;
  readonly source: WorkingDirectorySource | undefined;
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
  /** Fresh on every provider activation; never derived from wall clock. */
  private readonly noticeEpoch = randomUUID();
  private noticeSerial = 0;
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
  private readonly statDirectory: (fsPath: string) => Promise<boolean>;
  /** In-memory only; cleared when its session ends or the folder is removed. */
  private readonly referenceBaseOverrides = new Map<string, ReferenceBaseOverride>();
  /**
   * Workspace-mode choices keyed by workspace file + owner folder. These are
   * persisted so a later panel/extension host can reuse the same real cwd.
   */
  private readonly chosenWorkingDirectories = new Map<string, string>();
  /** Last successfully resolved launch directory for UI state (never guessed). */
  private readonly launchDirectories = new Map<string, LaunchDirectory>();
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
    const savedChoices = context.workspaceState.get<unknown>(
      STATE_CHOSEN_WORKING_DIRECTORIES,
    );
    if (
      savedChoices !== null &&
      typeof savedChoices === 'object' &&
      !Array.isArray(savedChoices)
    ) {
      for (const [namespace, value] of Object.entries(savedChoices)) {
        if (typeof value === 'string' && value.length > 0) {
          this.chosenWorkingDirectories.set(namespace, value);
        }
      }
    }

    this.createEditorBridge =
      dependencies.createEditorBridge ?? (() => new EditorBridge());
    this.statDirectory = dependencies.statDirectory ?? isDirectoryOnDisk;
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
        const workingDirectoryChanged = event.affectsConfiguration(
          `${CONFIG_SECTION}.workingDirectory`,
        );
        if (!shellChanged && !commandChanged && !workingDirectoryChanged) {
          return;
        }
        if (shellChanged) {
          this.workspaceConfigChoices.clear();
        }
        if (this.activeFolderKey !== undefined) {
          // Existing PTYs keep their spawn cwd and any per-session reference
          // base. Only a restart/new session applies the new setting.
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
    this.referenceBaseOverrides.clear();
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

  /**
   * Sets the directory used to format subsequent @ mentions for the current
   * session. It never writes to the PTY, spawns a process, stops the bridge or
   * changes the active workspace owner. The user still performs `/cd` in
   * OpenCode themselves; this only tells the extension which directory that
   * was. The override is in-memory and bound to the current session id.
   */
  async setReferenceBase(): Promise<void> {
    this.notice = undefined;
    if (!vscode.workspace.isTrusted) {
      this.reportError('当前工作区处于限制模式，已拒绝设置引用基准。');
      return;
    }
    const folder = this.activeFolder();
    const folderKey = folder?.uri.toString();
    const snapshot =
      folderKey === undefined ? undefined : this.pty.snapshot(folderKey);
    if (
      folder === undefined ||
      folderKey === undefined ||
      snapshot === undefined ||
      !this.pty.isActive(folderKey, snapshot.sessionId)
    ) {
      this.reportError('PTY 未运行或不是当前活动会话；未设置引用基准。');
      return;
    }

    const currentBase = this.referenceBase(folder, snapshot.sessionId);
    let picked: readonly vscode.Uri[] | undefined;
    try {
      picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '设为引用基准',
        title: '选择 OpenCode 引用基准目录（不执行 cd）',
        defaultUri: vscode.Uri.file(currentBase),
      });
    } catch (error) {
      this.reportError(`无法选择引用基准目录：${toErrorMessage(error)}`);
      return;
    }
    if (picked === undefined || picked.length === 0) {
      return;
    }

    // The dialog is async. Never bind an override to a session that ended or
    // was replaced while the user was choosing.
    const currentFolder = this.activeFolder();
    const currentSnapshot =
      currentFolder === undefined
        ? undefined
        : this.pty.snapshot(currentFolder.uri.toString());
    if (
      currentFolder === undefined ||
      currentFolder.uri.toString() !== folderKey ||
      currentSnapshot === undefined ||
      currentSnapshot.sessionId !== snapshot.sessionId ||
      !this.pty.isActive(folderKey, snapshot.sessionId)
    ) {
      this.reportError('活动 PTY 会话已变化，未保存引用基准；请重新执行命令。');
      return;
    }

    const selected = picked[0];
    if (selected.scheme !== 'file') {
      this.reportError('引用基准必须是本地文件夹。');
      return;
    }
    const basePath = selected.fsPath;
    if (!(await this.statDirectory(basePath))) {
      this.reportError(`引用基准目录不存在或不是文件夹：${basePath}`);
      return;
    }
    if (this.disposed) {
      return;
    }
    // Directory validation is async too; re-check before binding the override.
    if (!this.isCurrentPtySession(folderKey, snapshot.sessionId)) {
      this.reportError('活动 PTY 会话已变化，未保存引用基准；请重新执行命令。');
      return;
    }

    this.referenceBaseOverrides.set(folderKey, {
      sessionId: snapshot.sessionId,
      basePath,
    });
    this.setNotice(
      'info',
      `已为当前 PTY 会话设置引用基准：${basePath}。` +
        '只影响之后的 @ 引用；请确保与你在 OpenCode 中 /cd 后的目录相同，扩展未执行 cd；' +
        '重启 PTY 后恢复启动目录。',
    );
    this.postState();
  }

  clearTerminal(): void {
    this.setNotice('info', '已清除 xterm 滚动缓冲；没有向 PTY 发送内容。');
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

    const folder = this.ownerFolder();
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
      const owner = this.ownerFolder();
      if (owner !== undefined && vscode.workspace.isTrusted) {
        this.activeFolderKey = owner.uri.toString();
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
    const workingDirectory = this.displayWorkingDirectory(folder);

    this.attached = true;
    this.streamSessionId = snapshot?.sessionId;
    this.streamSequence = snapshot?.sequence ?? 0;
    this.clearOutputTimer();
    this.outputBatch = undefined;

    this.postMessage({
      type: 'ptySnapshot',
      workspaceKey: folderKey ?? null,
      workspaceName: folder?.name ?? null,
      folderName: folder?.name ?? null,
      workspaceMode: this.workspaceMode(),
      workingDirectory: workingDirectory.path ?? null,
      workingDirectorySource: workingDirectory.source ?? null,
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
      /** Directory already chosen/confirmed by the user for this launch. */
      readonly workingDirectory?: string;
    },
  ): Promise<void> {
    this.notice = undefined;
    if (!vscode.workspace.isTrusted) {
      this.reportError('当前工作区处于限制模式，已禁止启动 PTY。');
      return;
    }

    const configuration = vscode.workspace.getConfiguration(
      CONFIG_SECTION,
      folder.uri,
    );
    const configured = configuration.get<unknown>('command', 'opencode');
    const command = validateLaunchCommand(configured);
    if (!command.ok) {
      this.reportError(`OpenCode 启动命令无效：${command.message}`);
      return;
    }

    const launch = await this.resolveLaunchDirectory(
      folder,
      options.workingDirectory,
    );
    if (!launch.ok) {
      if (launch.reason === 'cancelled') {
        this.setNotice('info', '已取消选择工作目录；未启动 PTY。');
      }
      this.postState();
      return;
    }
    if (this.disposed) {
      return;
    }

    const shell = await this.resolveShell(folder, launch.path);
    if (shell === undefined) {
      this.postState();
      return;
    }
    if (this.disposed) {
      return;
    }

    // The workspace owner is only a session/config namespace. The spawn cwd
    // above is the real user-selected directory and is never a fake folder.
    const owner = this.ownerFolder();
    if (owner === undefined || owner.uri.toString() !== folder.uri.toString()) {
      this.reportError('工作区已变化，未启动 PTY；请重新选择工作目录。');
      return;
    }

    const folderKey = folder.uri.toString();
    this.setActiveFolder(folder);
    this.launchDirectories.set(folderKey, {
      path: shell.cwd,
      source: launch.source,
    });

    if (options.restart) {
      this.pty.stop(folderKey);
      this.referenceBaseOverrides.delete(folderKey);
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
      // `resolveShell` received the effective cwd as its workspacePath, so
      // this remains synchronized with `${workspaceFolder}` expansion.
      cwd: shell.cwd,
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
    if (result.created) {
      // A new session must never inherit a reference base from an older one.
      this.referenceBaseOverrides.delete(folderKey);
    }

    this.exitedFolders.delete(folderKey);
    this.restartRecommended = false;
    if (result.created) {
      this.shellByFolder.set(folderKey, shellInfo(shell));
      this.launchDirectories.set(folderKey, {
        path: shell.cwd,
        source: launch.source,
      });
      this.setNotice(
        'info',
        this.workspaceMode()
          ? `已在项目“${folder.name}”的工作目录 ${shell.cwd} 启动 PTY 并执行配置的启动命令（未验证 OpenCode 是否已进入前台）。`
          : `已在 ${folder.name} 启动 PTY 并执行配置的启动命令（未验证 OpenCode 是否已进入前台）。工作目录：${shell.cwd}。`,
      );
    } else {
      if (!this.shellByFolder.has(folderKey)) {
        this.shellByFolder.set(folderKey, shellInfo(shell));
      }
      const runningCwd =
        this.pty.getWorkingDirectory(folderKey, result.session.sessionId) ??
        shell.cwd;
      this.launchDirectories.set(folderKey, {
        path: runningCwd,
        source: launch.source,
      });
      this.setNotice(
        'info',
        `已复用 ${folder.name} 的现有 PTY（工作目录：${runningCwd}）；` +
          '没有重复发送启动命令。',
      );
    }

    if (this.view !== undefined) {
      this.sendSnapshot();
    } else {
      this.postState();
    }
  }

  /**
   * Resolves the real PTY cwd before any process/bridge starts.
   *
   * Priority: an explicit `opencodeTerminal.workingDirectory` setting, then a
   * user-confirmed override for this launch, then (workspace mode only) the
   * remembered choice or a native folder picker. A normal single-folder
   * workspace keeps using its root. Cancellation/invalid choices never fall
   * back to the project root and never write remembered state.
   */
  private async resolveLaunchDirectory(
    folder: vscode.WorkspaceFolder,
    confirmedWorkingDirectory?: string,
  ): Promise<LaunchDirectoryResult> {
    const configured = this.configuredWorkingDirectory(folder);
    if (!configured.ok) {
      this.reportError(
        `OpenCode 工作目录设置无效：${configured.message}`,
      );
      return { ok: false, reason: 'invalid' };
    }
    if (configured.source === 'configured') {
      if (!(await this.statDirectory(configured.path))) {
        this.reportError(
          `OpenCode 工作目录不存在或不是文件夹：${configured.path}。未启动 PTY。`,
        );
        return { ok: false, reason: 'invalid' };
      }
      return { ok: true, path: configured.path, source: 'configured' };
    }

    if (confirmedWorkingDirectory !== undefined) {
      if (!(await this.statDirectory(confirmedWorkingDirectory))) {
        this.reportError(
          `OpenCode 工作目录不存在或不是文件夹：${confirmedWorkingDirectory}。未启动 PTY。`,
        );
        return { ok: false, reason: 'invalid' };
      }
      return {
        ok: true,
        path: confirmedWorkingDirectory,
        source: 'chosen',
      };
    }

    if (!this.workspaceMode()) {
      if (!(await this.statDirectory(folder.uri.fsPath))) {
        this.reportError(
          `OpenCode 工作目录不存在或不是文件夹：${folder.uri.fsPath}。未启动 PTY。`,
        );
        return { ok: false, reason: 'invalid' };
      }
      return { ok: true, path: folder.uri.fsPath, source: 'owner' };
    }

    const folderKey = folder.uri.toString();
    const remembered = this.rememberedWorkingDirectory(folderKey);
    if (remembered !== undefined) {
      if (await this.statDirectory(remembered)) {
        return { ok: true, path: remembered, source: 'chosen' };
      }
      this.setNotice(
        'info',
        `已保存的工作目录不存在或不是文件夹：${remembered}。请重新选择。`,
      );
    }

    const picked = await this.pickWorkingDirectory(
      vscode.Uri.file(folder.uri.fsPath),
    );
    if (!picked.ok) {
      return picked;
    }
    await this.rememberWorkingDirectory(folderKey, picked.path);
    return { ok: true, path: picked.path, source: 'chosen' };
  }
  private async pickWorkingDirectory(
    defaultUri: vscode.Uri,
  ): Promise<PickWorkingDirectoryResult> {
    let picked: readonly vscode.Uri[] | undefined;
    try {
      picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '选择工作目录',
        title: '选择 OpenCode 的实际工作目录（不是项目根）',
        defaultUri,
      });
    } catch (error) {
      this.reportError(`无法选择工作目录：${toErrorMessage(error)}`);
      return { ok: false, reason: 'invalid' };
    }
    if (picked === undefined || picked.length === 0) {
      return { ok: false, reason: 'cancelled' };
    }

    const selected = picked[0];
    if (selected.scheme !== 'file') {
      this.reportError('OpenCode 工作目录必须是本地文件夹。');
      return { ok: false, reason: 'invalid' };
    }
    const selectedPath = selected.fsPath;
    if (!(await this.statDirectory(selectedPath))) {
      this.reportError(
        `OpenCode 工作目录不存在或不是文件夹：${selectedPath}。未启动 PTY。`,
      );
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, path: selectedPath };
  }

  private configuredWorkingDirectory(
    folder: vscode.WorkspaceFolder,
  ):
    | { readonly ok: true; readonly path: string; readonly source: 'workspace' | 'configured' }
    | { readonly ok: false; readonly message: string } {
    const configuration = vscode.workspace.getConfiguration(
      CONFIG_SECTION,
      folder.uri,
    );
    const resolved = resolveWorkingDirectory({
      value: configuration.get<unknown>('workingDirectory', ''),
      workspacePath: folder.uri.fsPath,
      userHome: os.homedir(),
      platform: process.platform,
    });
    return resolved.ok
      ? { ok: true, path: resolved.path, source: resolved.source }
      : { ok: false, message: resolved.message };
  }

  private workspaceMode(): boolean {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return isWorkspaceMode(vscode.workspace.workspaceFile, folders.length);
  }

  private workingDirectoryNamespace(folderKey: string): string {
    const workspaceFile = vscode.workspace.workspaceFile;
    return `${workspaceFile?.toString() ?? 'folder'}|${folderKey}`;
  }

  private rememberedWorkingDirectory(folderKey: string): string | undefined {
    return this.chosenWorkingDirectories.get(
      this.workingDirectoryNamespace(folderKey),
    );
  }

  private async rememberWorkingDirectory(
    folderKey: string,
    path: string,
  ): Promise<void> {
    const namespace = this.workingDirectoryNamespace(folderKey);
    if (this.chosenWorkingDirectories.get(namespace) === path) {
      return;
    }
    this.chosenWorkingDirectories.set(namespace, path);
    await this.context.workspaceState.update(
      STATE_CHOSEN_WORKING_DIRECTORIES,
      Object.fromEntries(this.chosenWorkingDirectories),
    );
  }

  private forgetWorkingDirectory(folderKey: string): void {
    if (this.chosenWorkingDirectories.delete(this.workingDirectoryNamespace(folderKey))) {
      void this.context.workspaceState.update(
        STATE_CHOSEN_WORKING_DIRECTORIES,
        Object.fromEntries(this.chosenWorkingDirectories),
      );
    }
  }

  private displayWorkingDirectory(
    folder: vscode.WorkspaceFolder | undefined,
  ): DisplayWorkingDirectory {
    if (folder === undefined) {
      return { path: undefined, source: undefined };
    }
    const folderKey = folder.uri.toString();
    const snapshot = this.pty.snapshot(folderKey);
    if (snapshot !== undefined) {
      const spawnPath = this.pty.getWorkingDirectory(
        folderKey,
        snapshot.sessionId,
      );
      if (spawnPath !== undefined) {
        return {
          path: spawnPath,
          source: this.launchDirectories.get(folderKey)?.source,
        };
      }
    }
    const launch = this.launchDirectories.get(folderKey);
    if (launch !== undefined) {
      return launch;
    }
    if (this.workspaceMode()) {
      // A remembered path must be stat-validated by the async launch flow;
      // never show an unverified saved path as the current working directory.
      return { path: undefined, source: undefined };
    }
    return { path: folder.uri.fsPath, source: 'owner' };
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
    workingDirectory: string,
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
      // Keep profile `${workspaceFolder}`/`${cwd}` args/env consistent with
      // the effective spawn cwd; shell-profile resolution semantics are
      // otherwise unchanged.
      workspacePath: workingDirectory,
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
    if (this.workspaceMode()) {
      await this.chooseWorkingDirectory();
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

  /**
   * Workspace mode entry point for the toolbar button. It always chooses the
   * real working directory, not a project root. If a PTY is running the user
   * must confirm that it will be ended before the new directory is saved and
   * used for the replacement session.
   */
  private async chooseWorkingDirectory(): Promise<void> {
    this.notice = undefined;
    if (!vscode.workspace.isTrusted) {
      this.reportError('当前工作区处于限制模式，已禁止切换工作目录。');
      return;
    }
    const folder = this.ownerFolder();
    if (folder === undefined) {
      this.reportError(
        vscode.workspace.workspaceFile !== undefined
          ? '未打开工作区文件夹。请先在资源管理器中把文件夹添加到当前 .code-workspace。'
          : '未打开工作区文件夹。',
      );
      return;
    }

    const configured = this.configuredWorkingDirectory(folder);
    if (!configured.ok) {
      this.reportError(`OpenCode 工作目录设置无效：${configured.message}`);
      return;
    }
    if (configured.source === 'configured') {
      this.setNotice(
        'info',
        `工作目录由设置 opencodeTerminal.workingDirectory 指定：${configured.path}。` +
          '手动选择不会覆盖该设置；如需更换，请先在设置中修改或清空该项。',
      );
      this.postState();
      return;
    }

    const current = this.displayWorkingDirectory(folder).path;
    const picked = await this.pickWorkingDirectory(
      vscode.Uri.file(current ?? folder.uri.fsPath),
    );
    if (!picked.ok) {
      if (picked.reason === 'cancelled') {
        this.postState();
      }
      return;
    }

    const folderKey = folder.uri.toString();
    // The picker is async. Re-read the session so a PTY that started while the
    // dialog was open is still protected by the confirmation.
    const snapshot = this.pty.snapshot(folderKey);
    if (snapshot !== undefined) {
      const running =
        this.pty.getWorkingDirectory(folderKey, snapshot.sessionId) ??
        this.displayWorkingDirectory(folder).path ??
        '未知';
      const confirmed = await vscode.window.showWarningMessage(
        '切换工作目录将结束当前 OpenCode 会话并用新目录重启。',
        {
          modal: true,
          detail:
            `当前工作目录：${running}\n` +
            `新的工作目录：${picked.path}\n` +
            '当前会话会被结束，未提交的输入或运行中的任务可能丢失。',
        },
        '结束会话并重启',
        '取消',
      );
      if (confirmed !== '结束会话并重启') {
        this.postState();
        return;
      }
      if (this.disposed) {
        return;
      }
    }

    // Save only after a confirmed, valid selection and before starting.
    await this.rememberWorkingDirectory(folderKey, picked.path);
    if (this.disposed) {
      return;
    }
    await this.startSession(folder, {
      restart: snapshot !== undefined,
      workingDirectory: picked.path,
    });
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

    for (const uri of uris) {
      if (uri.scheme !== 'file') {
        problems.push(`仅支持本地文件：${uri.toString()}`);
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
    const rootPath = this.currentReferenceBase(folder);
    const formatted = formatMention(uri.fsPath, rootPath, range);
    if (!formatted.ok) {
      problems.push(formatted.message);
      return undefined;
    }
    return {
      uri: uri.toString(),
      filePath: uri.fsPath,
      rootPath,
      ...(range === undefined ? {} : { range }),
    };
  }

  /**
   * Prefers a same-session manual override, then the actual spawn cwd recorded
   * by the PTY manager. Without a session, uses the resolved launch directory
   * (workspace mode) or the workspace folder so the existing "PTY 未运行"
   * guard still reports the real state.
   */
  private currentReferenceBase(folder: vscode.WorkspaceFolder): string {
    const folderKey = folder.uri.toString();
    const snapshot = this.pty.snapshot(folderKey);
    if (snapshot === undefined) {
      return (
        this.displayWorkingDirectory(folder).path ?? folder.uri.fsPath
      );
    }
    return this.referenceBase(folder, snapshot.sessionId);
  }

  private referenceBase(
    folder: vscode.WorkspaceFolder,
    sessionId: string,
  ): string {
    const folderKey = folder.uri.toString();
    const override = this.referenceBaseOverrides.get(folderKey);
    if (override !== undefined && override.sessionId === sessionId) {
      return override.basePath;
    }
    return (
      this.pty.getWorkingDirectory(folderKey, sessionId) ??
      this.displayWorkingDirectory(folder).path ??
      folder.uri.fsPath
    );
  }

  private isCurrentPtySession(folderKey: string, sessionId: string): boolean {
    const folder = this.activeFolder();
    return (
      folder !== undefined &&
      folder.uri.toString() === folderKey &&
      this.pty.isActive(folderKey, sessionId)
    );
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
    const activeFolder = this.activeFolder();
    if (
      activeFolder === undefined ||
      activeFolder.uri.toString() !== folderKey
    ) {
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
    this.setNotice(
      problems.length > 0 || unrepresentable > 0 ? 'error' : 'info',
      `${parts.join('；')}。`,
    );
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
    this.setNotice('info', message);
    this.postState();
  }

  private handlePtyEvent(event: PtyEvent): void {
    if (event.type === 'exit') {
      const override = this.referenceBaseOverrides.get(event.workspaceKey);
      if (override !== undefined && override.sessionId === event.sessionId) {
        this.referenceBaseOverrides.delete(event.workspaceKey);
      }
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
    _placeHolder: string,
  ): Promise<vscode.WorkspaceFolder | undefined> {
    if (!vscode.workspace.isTrusted) {
      this.reportError('当前工作区处于限制模式，已禁止启动 PTY 或写入。');
      return undefined;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.reportError(
        vscode.workspace.workspaceFile !== undefined
          ? '未打开工作区文件夹。请先在资源管理器中把文件夹添加到当前 .code-workspace，再启动 OpenCode。'
          : '未打开工作区。请先打开一个文件夹。',
      );
      return undefined;
    }
    // Workspace mode never shows a project Quick Pick. The owner is always the
    // first folder; the real cwd is resolved separately through a directory
    // picker.
    const owner = this.ownerFolder();
    if (owner === undefined) {
      this.reportError('未找到可用的工作区文件夹。');
    }
    return owner;
  }

  private ownerFolder(): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return undefined;
    }
    if (this.workspaceMode()) {
      return folders[0];
    }
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

  private activeFolder(): vscode.WorkspaceFolder | undefined {
    return this.ownerFolder();
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
    this.referenceBaseOverrides.delete(folderKey);
    this.launchDirectories.delete(folderKey);
    this.forgetWorkingDirectory(folderKey);
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
    const workspaceMode = this.workspaceMode();
    const folder = this.activeFolder();
    const folderKey = folder?.uri.toString();
    const snapshot =
      folderKey === undefined ? undefined : this.pty.snapshot(folderKey);
    const shell = folderKey === undefined ? undefined : this.shellByFolder.get(folderKey);
    const trusted = vscode.workspace.isTrusted;
    const workingDirectory = this.displayWorkingDirectory(folder);
    const spawnWorkingDirectory =
      folderKey === undefined || snapshot === undefined
        ? undefined
        : this.pty.getWorkingDirectory(folderKey, snapshot.sessionId) ??
          workingDirectory.path;
    const override =
      folderKey === undefined
        ? undefined
        : this.referenceBaseOverrides.get(folderKey);
    const overrideActive =
      snapshot !== undefined &&
      override !== undefined &&
      override.sessionId === snapshot.sessionId;
    const referenceBase =
      folder === undefined || snapshot === undefined
        ? undefined
        : this.referenceBase(folder, snapshot.sessionId);

    let status: string;
    if (!trusted) {
      status = '限制模式：不会启动 PTY，也不会向终端写入。';
    } else if (folders.length === 0) {
      status =
        vscode.workspace.workspaceFile !== undefined
          ? '未打开工作区文件夹。.code-workspace 需要先添加至少一个工作区文件夹。'
          : '未打开工作区。';
    } else if (folder === undefined) {
      status = '未找到可用的工作区文件夹。';
    } else if (snapshot !== undefined) {
      const ownerDescription = workspaceMode
        ? `项目（owner）：${folder.name}；`
        : '';
      const baseDescription = overrideActive
        ? `引用基准：${referenceBase}（仅本会话手动设置，未执行 cd；spawn cwd：${spawnWorkingDirectory ?? '未知'}）`
        : `引用基准：${referenceBase}（会话启动目录）`;
      status =
        `PTY 运行中（${shell?.label ?? 'shell'}）。` +
        ownerDescription +
        `工作目录：${spawnWorkingDirectory ?? workingDirectory.path ?? '未知'}。` +
        `${baseDescription}。扩展无法判断 OpenCode 是否仍在前台。`;
    } else if (this.exitedFolders.has(folderKey ?? '')) {
      status =
        'PTY 已退出。引用不会写入 shell；请点击“重启”。' +
        (workingDirectory.path === undefined
          ? ''
          : `原工作目录：${workingDirectory.path}。`);
    } else if (workspaceMode && workingDirectory.path === undefined) {
      status =
        '尚未选择实际工作目录。请点击左上角“工作目录”按钮选择目录后启动 PTY。';
    } else {
      status =
        'PTY 未启动。' +
        (workingDirectory.path === undefined
          ? ''
          : `工作目录：${workingDirectory.path}。`) +
        '请点击“重启”或打开面板自动启动。';
    }
    if (this.restartRecommended) {
      status += ' 终端或工作目录配置已更改，重启 PTY 后生效。';
    }

    this.postMessage({
      type: 'state',
      workspaceName: folder?.name ?? null,
      workspaceCount: folders.length,
      workspaceKey: folderKey ?? null,
      workspaceMode,
      workingDirectory: workingDirectory.path ?? null,
      workingDirectorySource: workingDirectory.source ?? null,
      spawnWorkingDirectory: spawnWorkingDirectory ?? null,
      shellLabel: shell?.label ?? null,
      shellWarnings: shell?.warnings ?? [],
      status,
      ptyActive: snapshot !== undefined,
      sessionId: snapshot?.sessionId ?? null,
      referenceBase: referenceBase ?? null,
      referenceBaseOverride: overrideActive,
      trusted,
      restartRecommended: this.restartRecommended,
      notice: this.notice ?? null,
    });
  }

  private setNotice(kind: Notice['kind'], message: string): void {
    this.noticeSerial += 1;
    this.notice = {
      kind,
      message,
      epoch: this.noticeEpoch,
      id: this.noticeSerial,
    };
  }

  private reportError(message: string): void {
    this.setNotice('error', message);
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

async function isDirectoryOnDisk(fsPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(fsPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
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
      <button id="workspace-button" class="workspace" type="button" title="选择工作目录">
        <span id="workspace-name">工作目录</span>
      </button>
      <span id="shell-label" class="shell" title="当前 shell">shell</span>
      <span class="spacer"></span>
      <button id="restart-button" type="button" title="重启 PTY">重启</button>
    </header>
    <div id="notice" class="notice error" role="status" aria-live="polite" hidden>
      <span id="notice-text" class="notice-text"></span>
      <button id="notice-close" class="notice-close" type="button" aria-label="关闭通知" title="关闭通知">×</button>
    </div>
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
    vscode.commands.registerCommand('opencodeTerminal.setReferenceBase', () =>
      provider.setReferenceBase(),
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

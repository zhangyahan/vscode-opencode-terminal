import { randomBytes, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

import { formatMention, parseDropPayload, type TextRange } from './core';
import {
  MAX_ATTACHMENTS,
  MAX_INSERT_TEXT_LENGTH,
  MAX_SELECTION_TEXT_LENGTH,
  SELECTION_TTL_MS,
  appendReference,
  invalidateSelectionCache,
  matchSelection,
  parseWebviewMessage,
  pickReferences,
  recordSelection,
  referenceMention,
  removeReferences,
  restoreReferences,
  terminalStatusText,
  validateLaunchCommand,
  type SelectionMatchReason,
  type SelectionSnapshot,
  type StoredReference,
  type TerminalStatusKind,
  type WebviewInboundMessage,
} from './runtime';
import { OpenCodeTerminals } from './terminal';

const VIEW_ID = 'opencodeTerminal.main';
const CONFIG_SECTION = 'opencodeTerminal';
const STATE_REFERENCES = 'opencodeTerminal.references.v1';
const STATE_LAST_FOLDER = 'opencodeTerminal.lastFolder.v1';

type DropMessage = Extract<WebviewInboundMessage, { readonly type: 'drop' }>;

interface ViewStatus {
  readonly kind: TerminalStatusKind;
  readonly text: string;
  readonly canStart: boolean;
  readonly canInsert: boolean;
  readonly folderName?: string;
}

interface ViewAttachment {
  readonly id: string;
  readonly mention: string;
  readonly folderName: string;
  readonly outsideWorkspace: boolean;
}

interface Notice {
  readonly kind: 'info' | 'error';
  readonly message: string;
}

interface ReferenceOperation {
  fallback?: vscode.WorkspaceFolder;
  cancelled?: boolean;
}

interface AddOutcome {
  readonly added: boolean;
  readonly message?: string;
}

class OpenCodeViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private references: readonly StoredReference[];
  private selectionCache: readonly SelectionSnapshot[] = [];
  private lastFolderKey: string | undefined;
  private readonly closedFolders = new Set<string>();
  private notice: Notice | undefined;
  private autoStartAttempted = false;
  private readonly disposables: vscode.Disposable[] = [];
  private viewDisposables: vscode.Disposable[] = [];
  private readonly terminals: OpenCodeTerminals;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.references = restoreReferences(
      context.workspaceState.get(STATE_REFERENCES),
    );
    const savedFolder = context.workspaceState.get<string>(STATE_LAST_FOLDER);
    this.lastFolderKey =
      typeof savedFolder === 'string' ? savedFolder : undefined;

    this.terminals = new OpenCodeTerminals();
    this.disposables.push(this.terminals);
    this.disposables.push(
      this.terminals.onDidClose(({ folderKey }) => {
        this.closedFolders.add(folderKey);
        this.postState();
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
        if (
          active !== undefined &&
          active.document.uri.toString() === uri
        ) {
          this.captureSelection(active, active.selections);
        }
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.postState();
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
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
      }
    });
    for (const disposable of this.viewDisposables) {
      disposable.dispose();
    }
    this.viewDisposables = [messageListener, disposeListener];
    this.postState();

    // Start once, only when there is a single unambiguous workspace. Multi-root
    // workspaces require an explicit choice. Closing the terminal never loops
    // back into a start.
    if (!this.autoStartAttempted) {
      this.autoStartAttempted = true;
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (vscode.workspace.isTrusted && folders.length === 1) {
        void this.start(folders[0], { auto: true });
      }
    }
  }

  dispose(): void {
    for (const disposable of this.viewDisposables) {
      disposable.dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  async runCommand(command: 'clear' | 'copyAll'): Promise<void> {
    if (command === 'clear') {
      await this.confirmClear();
      return;
    }
    await this.copy(this.references.map((reference) => reference.id));
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

    const range = editor.selection.isEmpty
      ? undefined
      : toTextRange(editor.selection);
    await this.addFileUris([editor.document.uri], range);
  }

  async addExplorerUris(uris: readonly vscode.Uri[]): Promise<void> {
    this.notice = undefined;
    if (uris.length === 0) {
      this.reportError('请从 Explorer 选择一个或多个文件。');
      return;
    }

    const unique = new Map<string, vscode.Uri>();
    for (const uri of uris) {
      unique.set(uri.toString(), uri);
    }
    await this.addFileUris([...unique.values()]);
  }

  async pickFiles(): Promise<void> {
    this.notice = undefined;
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: '添加为引用',
      title: '选择要添加为 OpenCode 引用的文件',
    });
    if (uris === undefined || uris.length === 0) {
      return;
    }
    await this.addFileUris(uris);
  }

  async start(
    folder?: vscode.WorkspaceFolder,
    options: { readonly auto: boolean } = { auto: false },
  ): Promise<void> {
    this.notice = undefined;

    if (!vscode.workspace.isTrusted) {
      this.reportError(
        '当前工作区处于限制模式（Workspace Trust 未启用），已禁止启动 OpenCode。',
      );
      return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.reportError('未打开工作区。请先打开一个文件夹。');
      return;
    }

    const target =
      folder ??
      (await this.chooseFolder('选择要运行 OpenCode 的工作区', !options.auto));
    if (target === undefined) {
      this.postState();
      return;
    }

    const configured = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<unknown>('command', 'opencode');
    const command = validateLaunchCommand(configured);
    if (!command.ok) {
      this.reportError(`OpenCode 启动命令无效：${command.message}`);
      return;
    }

    const folderKey = target.uri.toString();
    this.lastFolderKey = folderKey;
    this.closedFolders.delete(folderKey);
    await this.context.workspaceState.update(STATE_LAST_FOLDER, folderKey);

    let result: {
      terminal: vscode.Terminal;
      created: boolean;
      restored: boolean;
    };
    try {
      result = this.terminals.ensure(target, command.command);
    } catch (error) {
      this.reportError(`无法创建终端：${toErrorMessage(error)}`);
      return;
    }

    this.notice = result.created
      ? {
          kind: 'info',
          message:
            `已在 ${target.name} 创建终端并执行配置的启动命令。` +
            '扩展不会验证 CLI 是否运行，请确认 OpenCode 已就绪。',
        }
      : result.restored
        ? {
            kind: 'info',
            message:
              `已恢复 ${target.name} 的现有 OpenCode 终端，` +
              '没有重复发送启动命令。扩展不会验证 CLI 是否运行。',
          }
        : {
            kind: 'info',
            message: `已复用 ${target.name} 的现有 OpenCode 终端。`,
          };

    // A manual start should reveal the terminal. Auto-start deliberately does
    // not steal focus; otherwise opening the panel would hide the webview.
    if (!options.auto) {
      result.terminal.show();
    }
    this.postState();
  }

  async focusTerminal(): Promise<void> {
    this.notice = undefined;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.reportError('未打开工作区。请先打开一个文件夹。');
      return;
    }

    const folder = this.currentFolder(folders) ?? (await this.chooseFolder('选择工作区'));
    if (folder === undefined) {
      this.postState();
      return;
    }

    const terminal = this.terminals.get(folder.uri.toString());
    if (terminal === undefined) {
      this.reportError(
        `尚未为 ${folder.name} 创建 OpenCode 终端。请先点击“启动 OpenCode”。`,
      );
      return;
    }
    terminal.show();
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
          this.postState();
          return;
        case 'start':
          await this.start();
          return;
        case 'focusTerminal':
          await this.focusTerminal();
          return;
        case 'pickFiles':
          await this.pickFiles();
          return;
        case 'addActiveSelection':
          await this.addActiveSelection();
          return;
        case 'drop':
          await this.handleDrop(parsed.message);
          return;
        case 'insert':
          await this.insert(parsed.message.ids);
          return;
        case 'copy':
          await this.copy(parsed.message.ids);
          return;
        case 'remove':
          await this.remove(parsed.message.ids);
          return;
        case 'clear':
          await this.confirmClear();
          return;
      }
    } catch (error) {
      this.reportError(toErrorMessage(error));
    }
  }

  private async handleDrop(message: DropMessage): Promise<void> {
    this.notice = undefined;

    const payload: Record<string, unknown> = {};
    if (message.uriList !== undefined) {
      payload['text/uri-list'] = message.uriList;
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
    const problems: string[] = [];
    let added = 0;
    const operation: ReferenceOperation = {};
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

    for (const target of parsed.files) {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(target.uri);
      } catch {
        problems.push('拖入的文件 URI 无效。');
        continue;
      }
      if (uri.scheme !== 'file') {
        problems.push(`不支持的文件类型：${uri.toString()}`);
        continue;
      }

      let range = target.range;
      if (
        range === undefined &&
        plainText !== undefined &&
        plainText.length > 0
      ) {
        const match = matchSelection(
          this.selectionCache,
          plainText,
          Date.now(),
          SELECTION_TTL_MS,
          uri.toString(),
        );
        if (match.ok) {
          range = match.entry.range;
        } else if (match.reason === 'ambiguous') {
          problems.push(
            `拖入文本匹配到多个选区，未使用行号：${uri.fsPath}`,
          );
        }
      }

      const outcome = await this.addOne(uri, range, operation);
      if (outcome.added) {
        added++;
      } else if (outcome.message !== undefined) {
        problems.push(outcome.message);
      }
      if (operation.cancelled === true) {
        break;
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
        let uri: vscode.Uri;
        try {
          uri = vscode.Uri.parse(match.entry.uri);
        } catch {
          this.reportError('缓存的选区 URI 无效，未添加引用。');
          return;
        }
        const outcome = await this.addOne(uri, match.entry.range, operation);
        if (outcome.added) {
          added++;
        } else if (outcome.message !== undefined) {
          problems.push(outcome.message);
        }
      } else {
        problems.push(selectionMatchMessage(match.reason));
      }
    }

    if (operation.cancelled === true && added === 0) {
      this.postState();
      return;
    }

    const parts: string[] = [];
    if (added > 0) {
      parts.push(`已添加 ${added} 个引用。`);
    }
    if (problems.length > 0) {
      const shown = problems.slice(0, 3).join('；');
      parts.push(
        `未添加 ${problems.length} 项：${shown}${problems.length > 3 ? '…' : ''}`,
      );
    }
    if (parsed.warnings.length > 0) {
      parts.push(`忽略了 ${parsed.warnings.length} 条无法识别的拖放数据。`);
    }
    if (parts.length === 0) {
      this.postState();
      return;
    }

    this.notice = {
      kind: added > 0 && problems.length === 0 ? 'info' : 'error',
      message:
        parts.join(' ') +
        (added > 0
          ? ' 点击列表中的“插入”才会写入终端；插入不会自动按回车。'
          : ''),
    };
    this.postState();
  }

  private async addFileUris(
    uris: readonly vscode.Uri[],
    range?: TextRange,
  ): Promise<void> {
    const problems: string[] = [];
    const operation: ReferenceOperation = {};
    let added = 0;

    for (const uri of uris) {
      const outcome = await this.addOne(uri, range, operation);
      if (outcome.added) {
        added++;
      } else if (outcome.message !== undefined) {
        problems.push(outcome.message);
      }
      if (operation.cancelled === true) {
        break;
      }
    }

    if (operation.cancelled === true && added === 0) {
      this.postState();
      return;
    }

    if (added === 0 && problems.length === 0) {
      this.postState();
      return;
    }

    if (problems.length > 0) {
      const shown = problems.slice(0, 3).join('；');
      this.notice = {
        kind: 'error',
        message:
          (added > 0 ? `已添加 ${added} 个引用。` : '') +
          `未添加 ${problems.length} 项：${shown}${problems.length > 3 ? '…' : ''}`,
      };
    } else {
      this.notice = {
        kind: 'info',
        message:
          `已添加 ${added} 个引用。` +
          '点击列表中的“插入”才会写入终端；插入不会自动按回车。',
      };
    }
    this.postState();
  }

  private async addOne(
    uri: vscode.Uri,
    range: TextRange | undefined,
    operation: ReferenceOperation,
  ): Promise<AddOutcome> {
    if (uri.scheme !== 'file') {
      return { added: false, message: `仅支持本地文件：${uri.toString()}` };
    }

    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return { added: false, message: `无法读取文件：${uri.fsPath}` };
    }
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      return { added: false, message: `不支持文件夹：${uri.fsPath}` };
    }

    const folder = await this.folderForUri(uri, operation);
    if (folder === undefined) {
      return operation.cancelled === true
        ? { added: false }
        : { added: false, message: '没有可用的工作区。' };
    }

    const formatted = formatMention(uri.fsPath, folder.uri.fsPath, range);
    if (!formatted.ok) {
      return { added: false, message: formatted.message };
    }

    const reference: StoredReference = {
      id: randomUUID(),
      filePath: uri.fsPath,
      rootPath: folder.uri.fsPath,
      folderKey: folder.uri.toString(),
      folderName: folder.name,
      ...(range === undefined ? {} : { range }),
      outsideWorkspace: formatted.outsideWorkspace,
      addedAt: Date.now(),
    };

    const appended = appendReference(this.references, reference);
    if (!appended.added) {
      switch (appended.reason) {
        case 'duplicate':
          return {
            added: false,
            message: `引用已存在：${formatted.mention}`,
          };
        case 'limit':
          return {
            added: false,
            message: `引用数量已达上限（${MAX_ATTACHMENTS}）。`,
          };
        case 'invalid':
          return { added: false, message: '引用未通过安全校验。' };
      }
    }

    this.references = appended.references;
    await this.persist();
    return { added: true };
  }

  private async folderForUri(
    uri: vscode.Uri,
    operation: ReferenceOperation,
  ): Promise<vscode.WorkspaceFolder | undefined> {
    const containing = vscode.workspace.getWorkspaceFolder(uri);
    if (containing !== undefined) {
      return containing;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return undefined;
    }
    if (folders.length === 1) {
      return folders[0];
    }
    if (operation.fallback !== undefined) {
      return operation.fallback;
    }

    const picked = await this.chooseFolder(
      '该文件不在任何工作区中。选择引用相对路径要使用的工作区',
      false,
    );
    if (picked === undefined) {
      operation.cancelled = true;
      return undefined;
    }
    operation.fallback = picked;
    return picked;
  }

  private async chooseFolder(
    placeHolder: string,
    remember = true,
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
    if (remember) {
      this.lastFolderKey = picked.folder.uri.toString();
      await this.context.workspaceState.update(
        STATE_LAST_FOLDER,
        this.lastFolderKey,
      );
    }
    return picked.folder;
  }

  private async insert(ids: readonly string[]): Promise<void> {
    this.notice = undefined;

    if (!vscode.workspace.isTrusted) {
      this.reportError('当前工作区处于限制模式，已禁止向终端插入引用。');
      return;
    }

    const references = pickReferences(this.references, ids);
    if (references.length === 0) {
      this.reportError('没有可插入的引用。');
      return;
    }

    const folderKeys = new Set(references.map((reference) => reference.folderKey));
    if (folderKeys.size !== 1) {
      this.reportError(
        '所选引用来自不同工作区。请分别插入，避免写入错误的 OpenCode 终端。',
      );
      return;
    }
    const folderKey = references[0].folderKey;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = folders.find((item) => item.uri.toString() === folderKey);
    if (folder === undefined) {
      this.reportError('引用所属的工作区已不在当前窗口中，无法插入。');
      return;
    }

    const mentions: string[] = [];
    for (const reference of references) {
      // Re-run the core validator immediately before anything can reach the
      // terminal. Stored state is not trusted blindly.
      const formatted = formatMention(
        reference.filePath,
        reference.rootPath,
        reference.range,
      );
      if (!formatted.ok) {
        this.reportError(
          `引用未通过安全校验，未插入任何内容：${formatted.message}`,
        );
        return;
      }
      mentions.push(formatted.mention);
    }

    const text = mentions.join(' ');
    if (text.length > MAX_INSERT_TEXT_LENGTH) {
      this.reportError('所选引用过长，未插入。请分批插入。');
      return;
    }

    const terminal = this.terminals.get(folderKey);
    if (terminal === undefined) {
      const choice = await vscode.window.showWarningMessage(
        `尚未为 ${folder.name} 创建 OpenCode 终端。`,
        {
          modal: true,
          detail: '可以先启动 OpenCode，再重新点击“插入”。本操作不会自动提交内容。',
        },
        '启动 OpenCode',
        '复制到剪贴板',
      );
      if (choice === '启动 OpenCode') {
        await this.start(folder, { auto: false });
        return;
      }
      if (choice === '复制到剪贴板') {
        await this.copyText(text);
        return;
      }
      this.postState();
      return;
    }

    const preview =
      text.length > 800 ? `${text.slice(0, 800)}…` : text;
    const choice = await vscode.window.showWarningMessage(
      '确认 OpenCode TUI 仍在该终端中运行？扩展无法验证 CLI 进程；若已退出，输入可能进入 shell。',
      {
        modal: true,
        detail: `工作区：${folder.name}\n将插入（不会按回车）：\n${preview}`,
      },
      '插入到终端',
      '复制到剪贴板',
    );

    if (choice === '插入到终端') {
      if (this.terminals.get(folderKey) !== terminal) {
        this.reportError('终端在确认期间已关闭，未插入。');
        return;
      }
      try {
        // false = do not press Enter / do not auto-submit.
        terminal.sendText(text, false);
      } catch (error) {
        this.reportError(`无法写入终端：${toErrorMessage(error)}`);
        return;
      }
      this.notice = {
        kind: 'info',
        message: `已插入 ${references.length} 个引用到终端，未按回车。请确认 OpenCode TUI 后自行提交。`,
      };
      this.postState();
      return;
    }

    if (choice === '复制到剪贴板') {
      await this.copyText(text);
      return;
    }
    this.postState();
  }

  private async copy(ids: readonly string[]): Promise<void> {
    this.notice = undefined;
    const references = pickReferences(this.references, ids);
    if (references.length === 0) {
      this.reportError('没有可复制的引用。');
      return;
    }

    const mentions: string[] = [];
    for (const reference of references) {
      const formatted = formatMention(
        reference.filePath,
        reference.rootPath,
        reference.range,
      );
      if (!formatted.ok) {
        this.reportError(`引用未通过安全校验，未复制：${formatted.message}`);
        return;
      }
      mentions.push(formatted.mention);
    }
    await this.copyText(mentions.join(' '));
  }

  private async copyText(text: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(text);
      this.notice = { kind: 'info', message: '已复制到剪贴板。' };
    } catch (error) {
      this.reportError(`复制失败：${toErrorMessage(error)}`);
      return;
    }
    this.postState();
  }

  private async remove(ids: readonly string[]): Promise<void> {
    this.notice = undefined;
    const next = removeReferences(this.references, ids);
    if (next.length === this.references.length) {
      this.notice = { kind: 'info', message: '没有找到可移除的引用。' };
      this.postState();
      return;
    }
    this.references = next;
    await this.persist();
    this.notice = { kind: 'info', message: '已移除引用。' };
    this.postState();
  }

  private async confirmClear(): Promise<void> {
    this.notice = undefined;
    if (this.references.length === 0) {
      this.postState();
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `清空全部 ${this.references.length} 个引用？`,
      { modal: true },
      '清空',
    );
    if (choice !== '清空') {
      this.postState();
      return;
    }
    this.references = [];
    await this.persist();
    this.notice = { kind: 'info', message: '已清空引用。' };
    this.postState();
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

  private currentFolder(
    folders: readonly vscode.WorkspaceFolder[],
  ): vscode.WorkspaceFolder | undefined {
    if (this.lastFolderKey !== undefined) {
      const saved = folders.find(
        (folder) => folder.uri.toString() === this.lastFolderKey,
      );
      if (saved !== undefined) {
        return saved;
      }
    }
    return folders.length === 1 ? folders[0] : undefined;
  }

  private computeStatus(): ViewStatus {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!vscode.workspace.isTrusted) {
      return {
        kind: 'untrusted',
        text: terminalStatusText('untrusted'),
        canStart: false,
        canInsert: false,
      };
    }
    if (folders.length === 0) {
      return {
        kind: 'no-workspace',
        text: terminalStatusText('no-workspace'),
        canStart: false,
        canInsert: false,
      };
    }

    const folder = this.currentFolder(folders);
    const canInsert = this.references.length > 0;
    if (folder === undefined) {
      return {
        kind: 'idle',
        text: terminalStatusText('idle'),
        canStart: true,
        canInsert,
      };
    }

    const folderKey = folder.uri.toString();
    if (this.terminals.get(folderKey) !== undefined) {
      return {
        kind: 'created',
        text: terminalStatusText('created', folder.name),
        canStart: true,
        canInsert,
        folderName: folder.name,
      };
    }
    if (this.closedFolders.has(folderKey)) {
      return {
        kind: 'closed',
        text: terminalStatusText('closed', folder.name),
        canStart: true,
        canInsert,
        folderName: folder.name,
      };
    }
    return {
      kind: 'idle',
      text: terminalStatusText('idle', folder.name),
      canStart: true,
      canInsert,
      folderName: folder.name,
    };
  }

  private postState(): void {
    if (this.view === undefined) {
      return;
    }

    const attachments: ViewAttachment[] = [];
    for (const reference of this.references) {
      const mention = referenceMention(reference);
      if (mention === undefined) {
        continue;
      }
      attachments.push({
        id: reference.id,
        mention,
        folderName: reference.folderName,
        outsideWorkspace: reference.outsideWorkspace,
      });
    }

    void this.view.webview.postMessage({
      type: 'state',
      attachments,
      status: this.computeStatus(),
      notice: this.notice,
      maxAttachments: MAX_ATTACHMENTS,
    });
  }

  private reportError(message: string): void {
    this.notice = { kind: 'error', message };
    this.postState();
    if (this.view === undefined) {
      void vscode.window.showErrorMessage(message);
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.context.workspaceState.update(
        STATE_REFERENCES,
        this.references,
      );
    } catch {
      // Persistence is best effort; the in-memory list remains usable.
    }
  }
}

function selectionMatchMessage(reason: SelectionMatchReason): string {
  switch (reason) {
    case 'empty':
      return '拖入的文本为空。';
    case 'too-long':
      return '拖入的文本过长，未尝试匹配选区。';
    case 'expired':
      return '最近的选区缓存已过期（5 分钟）。请重新选择后拖入，或使用“添加当前选区”。';
    case 'ambiguous':
      return '拖入的文本匹配到多个最近选区，无法确定 URI/行号。请从编辑器直接拖入选区，或使用“添加当前选区”。';
    case 'no-match':
      return '拖入的文本没有匹配到唯一的最近非空选区（仅做精确匹配，不猜测）。请使用“添加当前选区”或从编辑器拖入选区。';
  }
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src ${cspSource} data:; style-src ${cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>OpenCode</title>
</head>
<body>
  <header class="header">
    <div class="header-text">
      <h1>OpenCode</h1>
      <p id="status" class="status" role="status" aria-live="polite">正在加载…</p>
    </div>
    <div class="header-actions">
      <button id="start-button" class="primary" type="button">启动 OpenCode</button>
      <button id="focus-terminal-button" type="button" hidden>显示终端</button>
    </div>
  </header>

  <section id="notice" class="notice" role="alert" hidden></section>

  <section id="drop-zone" class="drop-zone" aria-label="拖放文件或编辑器选区">
    <p class="drop-title">拖动文件或编辑器选区到这里</p>
    <p class="drop-hint">支持 VS Code Explorer 文件与编辑器选区。若拖放被 VS Code 拦截，请尝试按住 Shift 再拖入；仍无效请使用下方按钮或右键命令。</p>
  </section>

  <div class="toolbar">
    <button id="add-selection-button" type="button">添加当前选区</button>
    <button id="pick-files-button" type="button">添加文件…</button>
    <button id="clear-button" type="button">清空</button>
  </div>

  <section class="references" aria-label="待插入引用">
    <div class="list-header">
      <h2>待插入引用</h2>
      <span id="count" class="count">0 个</span>
    </div>
    <ul id="reference-list" class="reference-list"></ul>
    <p id="empty-state" class="empty">暂无引用。拖入文件或选区后会显示在这里，只有点击“插入”才会写入终端。</p>
    <div class="footer-actions">
      <button id="insert-all-button" type="button">插入全部到终端</button>
      <button id="copy-all-button" type="button">复制全部</button>
    </div>
  </section>

  <footer class="footnote">插入不会自动按回车或提交；每次插入前都会弹窗确认 OpenCode TUI 仍在运行，并提供复制到剪贴板的替代方案。</footer>

  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new OpenCodeViewProvider(context, context.extensionUri);

  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeTerminal.open', () =>
      vscode.commands.executeCommand(`${VIEW_ID}.focus`),
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
    vscode.commands.registerCommand('opencodeTerminal.clear', async () => {
      await provider.runCommand('clear');
    }),
    vscode.commands.registerCommand('opencodeTerminal.copyAll', async () => {
      await provider.runCommand('copyAll');
    }),
  );
}

export function deactivate(): void {
  // Terminals are intentionally left alone so a user's OpenCode session is not
  // killed when the extension host reloads.
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

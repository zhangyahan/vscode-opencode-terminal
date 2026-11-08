/**
 * Native TreeView drop target shown to the left of the xterm webview in the
 * same `opencodeTerminalBottom` bottom Panel container. It uses only stable
 * VS Code tree drag/drop APIs: the webview cannot reliably receive Explorer
 * drags because of the platform iframe boundary, while a native tree view can.
 */

import * as vscode from 'vscode';

import {
  MAX_DROP_ENTRIES,
  parseDropPayload,
  type DropTarget,
} from './core';
import {
  MAX_DROP_FIELD_LENGTH,
  MAX_TOTAL_MESSAGE_LENGTH,
} from './runtime';

export const FILE_DROP_VIEW_ID = 'opencodeTerminal.drop';

/**
 * `files` carries OS file objects (their `asFile()?.uri` may be unavailable).
 * The other fields cover VS Code Explorer/editor drops. `text/uri-list` is the
 * documented stable representation; `application/vnd.code.uri-list` is merged
 * too instead of picking only the first non-empty field.
 */
export const FILE_DROP_MIME_TYPES: readonly string[] = [
  'text/uri-list',
  'application/vnd.code.uri-list',
  'files',
  'CodeFiles',
  'ResourceURLs',
  'CodeEditors',
  'text/plain',
];

export interface FileDropViewOptions {
  /** Reuses the extension's existing Explorer mention/stat/PTY path. */
  addUris(uris: readonly vscode.Uri[]): Promise<void> | void;
  /** Routes extraction failures through the existing webview notice path. */
  reportError(message: string): void;
  /** Optional diagnostics: source and counts only, never file contents/env. */
  log?(line: string): void;
}

interface NativeDropData {
  readonly payload: Record<string, unknown>;
  /** MIME sources that actually contributed data, for diagnostics only. */
  readonly sources: readonly string[];
  readonly warnings: readonly string[];
}

class FileDropHint extends vscode.TreeItem {
  constructor() {
    super('将文件拖到此处（可多选）', vscode.TreeItemCollapsibleState.None);
    this.description = '不按回车，仅插入 @ 引用';
    this.tooltip =
      '位于底部面板 TUI 左侧。从 VS Code Explorer 拖入一个或多个文件。' +
      '目录、非 file: URI、未启动的 PTY 以及受限工作区都不会写入。';
    this.contextValue = 'opencodeDropHint';
    this.iconPath = new vscode.ThemeIcon('files');
  }
}

class FileDropTreeDataProvider
  implements vscode.TreeDataProvider<FileDropHint>
{
  private readonly hint = new FileDropHint();

  getTreeItem(element: FileDropHint): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FileDropHint): FileDropHint[] {
    return element === undefined ? [this.hint] : [];
  }
}

function byteLength(value: string): number {
  return value.length;
}

function boundedString(
  value: string,
  mime: string,
  warnings: string[],
): string | undefined {
  if (value.length === 0) {
    return undefined;
  }
  if (value.length > MAX_DROP_FIELD_LENGTH) {
    warnings.push(`${mime} 数据超过长度上限，已忽略。`);
    return undefined;
  }
  return value;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * CodeFiles is a JSON array of native absolute paths in real VS Code drops.
 * Validate the structure and bound it before handing it to the pure parser.
 * This function cannot inspect file existence; stat/formatMention still do.
 */
function boundedCodeFiles(
  raw: string,
  warnings: string[],
): string | undefined {
  if (raw.length > MAX_DROP_FIELD_LENGTH) {
    warnings.push('CodeFiles 数据超过长度上限，已忽略。');
    return undefined;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    warnings.push('CodeFiles 不是有效 JSON 数组，已忽略。');
    return undefined;
  }
  if (!Array.isArray(decoded)) {
    warnings.push('CodeFiles 必须是 JSON 数组，已忽略。');
    return undefined;
  }
  if (decoded.length > MAX_DROP_ENTRIES) {
    warnings.push(
      `CodeFiles 超过 ${MAX_DROP_ENTRIES} 个条目，多余条目已忽略。`,
    );
  }

  for (const entry of decoded.slice(0, MAX_DROP_ENTRIES)) {
    if (typeof entry === 'string') {
      if (entry.length > MAX_DROP_FIELD_LENGTH) {
        warnings.push('CodeFiles 中存在超长路径条目，已忽略。');
        return undefined;
      }
      continue;
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push('CodeFiles 中存在非字符串、非对象条目，已忽略。');
      return undefined;
    }
  }

  return JSON.stringify(decoded.slice(0, MAX_DROP_ENTRIES));
}

async function readTransferString(
  dataTransfer: vscode.DataTransfer,
  mime: string,
  warnings: string[],
): Promise<string | undefined> {
  let item: vscode.DataTransferItem | undefined;
  try {
    item = dataTransfer.get(mime);
  } catch (error) {
    warnings.push(`${mime} 无法读取：${asErrorMessage(error)}`);
    return undefined;
  }
  if (item === undefined) {
    return undefined;
  }

  try {
    const value = await item.asString();
    return typeof value === 'string' ? value : undefined;
  } catch (error) {
    warnings.push(`${mime} 异步读取失败：${asErrorMessage(error)}`);
    return undefined;
  }
}

async function collectDropData(
  dataTransfer: vscode.DataTransfer,
): Promise<NativeDropData> {
  const warnings: string[] = [];
  const sources: string[] = [];
  const payload: Record<string, unknown> = {};
  let total = 0;

  const read = async (mime: string): Promise<string | undefined> => {
    const raw = await readTransferString(dataTransfer, mime, warnings);
    if (raw === undefined) {
      return undefined;
    }
    const bounded = boundedString(raw, mime, warnings);
    if (bounded === undefined) {
      return undefined;
    }
    if (total + byteLength(bounded) > MAX_TOTAL_MESSAGE_LENGTH) {
      warnings.push('拖放数据总量超过上限，后续字段已忽略。');
      return undefined;
    }
    total += byteLength(bounded);
    sources.push(mime);
    return bounded;
  };

  const textUriList = await read('text/uri-list');
  const internalUriList = await read('application/vnd.code.uri-list');

  if (internalUriList !== undefined) {
    // Preserve the complete internal list; the pure parser merges it with
    // text/uri-list instead of using only the first non-empty field.
    payload['application/vnd.code.uri-list'] = internalUriList;
  }

  const codeFiles = await read('CodeFiles');
  if (codeFiles !== undefined) {
    const validated = boundedCodeFiles(codeFiles, warnings);
    if (validated !== undefined) {
      payload.CodeFiles = validated;
    }
  }

  const resourceUrls = await read('ResourceURLs');
  if (resourceUrls !== undefined) {
    payload.ResourceURLs = resourceUrls;
  }

  const codeEditors = await read('CodeEditors');
  if (codeEditors !== undefined) {
    payload.CodeEditors = codeEditors;
  }

  // DataTransferItem.asFile()?.uri is accepted when it exists. If it does not,
  // never guess a path from file.name or from a drag label.
  const asFileUris: string[] = [];
  try {
    const fileItem = dataTransfer.get('files');
    if (fileItem !== undefined) {
      const file = fileItem.asFile();
      if (file !== undefined) {
        if (file.uri !== undefined) {
          asFileUris.push(file.uri.toString());
          sources.push('files');
        } else {
          warnings.push(
            '系统文件管理器拖入的文件没有暴露本地路径（VS Code 公开 API 限制）；' +
              '请拖到原生区域的文件 URI，或使用“OpenCode: 选择文件插入 @ 引用”命令。',
          );
        }
      }
    }
  } catch (error) {
    warnings.push(`files 拖放数据无法读取：${asErrorMessage(error)}`);
  }

  const uriLines: string[] = [];
  if (textUriList !== undefined) {
    uriLines.push(textUriList);
  }
  if (asFileUris.length > 0) {
    uriLines.push(...asFileUris);
  }
  if (uriLines.length > 0) {
    payload['text/uri-list'] = uriLines.join('\r\n');
  }

  const plainText = await read('text/plain');
  if (plainText !== undefined) {
    // The native file target does not use plain text as a path. Keeping it in
    // the payload is harmless and lets the pure parser report it separately.
    payload['text/plain'] = plainText;
  }

  return { payload, sources, warnings };
}

function convertTarget(target: DropTarget): vscode.Uri | undefined {
  try {
    if (target.path !== undefined) {
      return vscode.Uri.file(target.path);
    }
    if (target.uri !== undefined) {
      return vscode.Uri.parse(target.uri);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

class FileDropController
  implements vscode.TreeDragAndDropController<FileDropHint>
{
  readonly dropMimeTypes = FILE_DROP_MIME_TYPES;
  /** This view is a drop target only; it does not originate drags. */
  readonly dragMimeTypes: readonly string[] = [];

  constructor(private readonly options: FileDropViewOptions) {}

  async handleDrop(
    _target: FileDropHint | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }

    try {
      const data = await collectDropData(dataTransfer);
      if (token.isCancellationRequested) {
        return;
      }

      const parsed = parseDropPayload(data.payload);
      const warnings = [...data.warnings, ...parsed.warnings.map((entry) => entry.message)];
      const uris: vscode.Uri[] = [];
      const seen = new Set<string>();

      for (const target of parsed.files) {
        const uri = convertTarget(target);
        if (uri === undefined) {
          warnings.push('拖入的文件路径或 URI 无效。');
          continue;
        }
        const key = uri.toString();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        uris.push(uri);
      }

      this.options.log?.(
        `[tree-drop] source=${data.sources.join(',') || 'none'} ` +
          `files=${uris.length} warnings=${warnings.length}`,
      );

      if (uris.length === 0) {
        const detail =
          warnings[0] ??
          '没有识别到可用的本地文件 URI。请从 VS Code Explorer 拖入文件。';
        this.options.reportError(`未写入引用：${detail}`);
        return;
      }

      await this.options.addUris(uris);
    } catch (error) {
      this.options.reportError(`处理拖放文件失败：${asErrorMessage(error)}`);
    }
  }
}

/** Registers the native drop target to the left of the TUI in the bottom Panel container. */
export class FileDropView implements vscode.Disposable {
  private readonly treeView: vscode.TreeView<FileDropHint>;

  constructor(options: FileDropViewOptions) {
    this.treeView = vscode.window.createTreeView(FILE_DROP_VIEW_ID, {
      treeDataProvider: new FileDropTreeDataProvider(),
      showCollapseAll: false,
      canSelectMany: false,
      dragAndDropController: new FileDropController(options),
    });
  }

  dispose(): void {
    this.treeView.dispose();
  }
}

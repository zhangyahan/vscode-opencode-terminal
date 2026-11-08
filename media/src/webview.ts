/**
 * Webview entry point. esbuild bundles this file, xterm.js, the fit addon and
 * the stylesheets into media/webview.js + media/webview.css.
 *
 * The webview is untrusted: it only forwards validated terminal input and drop
 * payloads to the extension host. Output is rendered by xterm.js.
 */

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  NotificationController,
  TerminalFitDebouncer,
  applyTerminalKey,
  stateErrorNotice,
  workspaceButtonView,
} from './interaction';
import './webview.css';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface StateMessage {
  readonly type: 'state';
  readonly workspaceName?: unknown;
  readonly workspaceCount?: unknown;
  readonly workspaceKey?: unknown;
  readonly workspaceMode?: unknown;
  readonly workingDirectory?: unknown;
  readonly workingDirectorySource?: unknown;
  readonly shellLabel?: unknown;
  readonly shellWarnings?: unknown;
  readonly status?: unknown;
  readonly ptyActive?: unknown;
  readonly sessionId?: unknown;
  readonly trusted?: unknown;
  readonly restartRecommended?: unknown;
  readonly notice?: unknown;
}

interface SnapshotMessage {
  readonly type: 'ptySnapshot';
  readonly workspaceName?: unknown;
  readonly folderName?: unknown;
  readonly workspaceMode?: unknown;
  readonly workingDirectory?: unknown;
  readonly shellLabel?: unknown;
  readonly session?: unknown;
  readonly truncated?: unknown;
  readonly displayCols?: unknown;
  readonly displayRows?: unknown;
}

interface OutputChunk {
  readonly fromSequence: number;
  readonly sequence: number;
  readonly data: string;
}

const vscode = acquireVsCodeApi();

const workspaceButton = document.getElementById('workspace-button') as HTMLButtonElement;
const workspaceName = document.getElementById('workspace-name') as HTMLSpanElement;
const shellLabel = document.getElementById('shell-label') as HTMLSpanElement;
const restartButton = document.getElementById('restart-button') as HTMLButtonElement;
const noticeEl = document.getElementById('notice') as HTMLDivElement;
const noticeTextEl = document.getElementById('notice-text') as HTMLSpanElement;
const noticeClose = document.getElementById('notice-close') as HTMLButtonElement;
const appEl = document.getElementById('app') as HTMLDivElement;
const terminalWrap = document.getElementById('terminal-wrap') as HTMLElement;
const terminalEl = document.getElementById('terminal') as HTMLDivElement;
const dropOverlay = document.getElementById('drop-overlay') as HTMLDivElement;

function post(message: unknown): void {
  vscode.postMessage(message);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

interface PersistedWebviewState {
  readonly lastNoticeEpoch?: unknown;
  readonly lastNoticeId?: unknown;
}

function readPersistedNoticeEpoch(): string {
  const state = vscode.getState() as PersistedWebviewState | null | undefined;
  if (state !== null && typeof state === 'object') {
    const value = state.lastNoticeEpoch;
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}

function readPersistedNoticeId(): number {
  const state = vscode.getState() as PersistedWebviewState | null | undefined;
  if (state !== null && typeof state === 'object') {
    const value = state.lastNoticeId;
    if (Number.isSafeInteger(value) && (value as number) > 0) {
      return value as number;
    }
  }
  return 0;
}

function persistNoticeId(): void {
  const current = vscode.getState();
  const base =
    current !== null && typeof current === 'object'
      ? (current as Record<string, unknown>)
      : {};
  vscode.setState({
    ...base,
    lastNoticeEpoch: notification.lastNoticeEpoch,
    lastNoticeId: notification.lastNoticeId,
  });
}

function renderNotice(message: string): void {
  noticeTextEl.textContent = message;
  noticeEl.className = 'notice error';
  noticeEl.hidden = false;
}

function clearNotice(): void {
  noticeEl.hidden = true;
  noticeTextEl.textContent = '';
  noticeEl.className = 'notice';
}

const notification = new NotificationController({
  scheduler: {
    setTimeout(callback, delayMs) {
      return window.setTimeout(callback, delayMs);
    },
    clearTimeout(handle) {
      window.clearTimeout(handle as number);
    },
  },
  render: renderNotice,
  clear: clearNotice,
  initialLastNoticeEpoch: readPersistedNoticeEpoch(),
  initialLastNoticeId: readPersistedNoticeId(),
});

const terminal = new Terminal({
  convertEol: false,
  cursorBlink: true,
  scrollback: 5000,
  allowProposedApi: false,
  fontFamily: 'monospace',
  fontSize: 13,
  lineHeight: 1.1,
  macOptionIsMeta: true,
});

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalEl);

let sessionId: string | null = null;
let lastSequence = 0;
let snapshotGeneration = 0;
let outputReady = false;
let pendingOutput: OutputChunk[] = [];
let resyncPending = false;
let dragDepth = 0;
let workspaceMode = false;
let ownerName = '';
let workingDirectory = '';
let workspaceCount = 0;
let workspaceTrusted = false;
let shellStatusTitle = '当前 shell';
let shellWarningsTitle = '';
let toolbarNote = '';

function renderShellLabelTitle(): void {
  const parts = [shellStatusTitle, shellWarningsTitle, toolbarNote].filter(
    (part) => part.length > 0,
  );
  shellLabel.title = parts.length > 0 ? parts.join('\n') : '当前 shell';
}

function renderWorkspaceButton(): void {
  const view = workspaceButtonView({
    workspaceMode,
    ownerName,
    workingDirectory,
    workspaceCount,
    trusted: workspaceTrusted,
  });
  workspaceName.textContent = view.label;
  workspaceButton.title = view.title;
  workspaceButton.disabled = view.disabled;
}

/** Applies state/snapshot fields without ever treating the owner as cwd. */
function applyWorkspaceState(
  workspaceModeValue: unknown,
  ownerValue: unknown,
  cwdValue: unknown,
): void {
  workspaceMode = workspaceModeValue === true;
  ownerName = text(ownerValue);
  workingDirectory = text(cwdValue);
  renderWorkspaceButton();
}

function cssValue(name: string, fallback: string): string {
  const styles = getComputedStyle(document.body);
  const value = styles.getPropertyValue(name).trim();
  if (value.length > 0) {
    return value;
  }
  const rootValue = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return rootValue.length > 0 ? rootValue : fallback;
}

function applyTheme(): void {
  const fontSize = Number.parseFloat(cssValue('--vscode-editor-font-size', '13px'));
  terminal.options.fontFamily = cssValue(
    '--vscode-editor-font-family',
    'Consolas, "Courier New", monospace',
  );
  if (Number.isFinite(fontSize) && fontSize >= 6 && fontSize <= 40) {
    terminal.options.fontSize = fontSize;
  }
  terminal.options.theme = {
    background: cssValue(
      '--vscode-terminal-background',
      cssValue('--vscode-panel-background', '#1e1e1e'),
    ),
    foreground: cssValue('--vscode-terminal-foreground', '#cccccc'),
    cursor: cssValue('--vscode-terminalCursor-foreground', '#ffffff'),
    cursorAccent: cssValue('--vscode-terminal-background', '#1e1e1e'),
    selectionBackground: cssValue(
      '--vscode-terminal-selectionBackground',
      cssValue('--vscode-editor-selectionBackground', '#264f78'),
    ),
  };
}

applyTheme();
const themeObserver = new MutationObserver(() => {
  applyTheme();
  scheduleFit();
});
themeObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['class', 'style'],
});
themeObserver.observe(document.body, {
  attributes: true,
  attributeFilter: ['class', 'style'],
});

const fitDebouncer = new TerminalFitDebouncer({
  scheduler: {
    setTimeout(callback, delayMs) {
      return window.setTimeout(callback, delayMs);
    },
    clearTimeout(handle) {
      window.clearTimeout(handle as number);
    },
  },
  fit: () => {
    try {
      fitAddon.fit();
    } catch {
      // The panel can be detached or mid-layout; the next observer tick will
      // fit it again after the debounce window.
    }
  },
  readEnvironment: () => ({
    clientWidth: terminalWrap.clientWidth,
    clientHeight: terminalWrap.clientHeight,
    visible: !document.hidden && terminalWrap.getClientRects().length > 0,
  }),
});

function scheduleFit(): void {
  fitDebouncer.schedule();
}

function fitNow(): void {
  fitDebouncer.fitNow();
}

const resizeObserver = new ResizeObserver(() => {
  scheduleFit();
});
resizeObserver.observe(terminalWrap);

function handleWindowResize(): void {
  scheduleFit();
}
window.addEventListener('resize', handleWindowResize);

window.addEventListener('pagehide', () => {
  notification.dispose();
  persistNoticeId();
  fitDebouncer.dispose();
  resizeObserver.disconnect();
  themeObserver.disconnect();
  window.removeEventListener('resize', handleWindowResize);
});

terminal.onResize(({ cols, rows }) => {
  if (sessionId !== null) {
    post({ type: 'ptyResize', sessionId, cols, rows });
  }
});

terminal.onData((data) => {
  if (sessionId !== null && data.length > 0) {
    post({ type: 'ptyInput', sessionId, data });
  }
});

terminal.attachCustomKeyEventHandler((event) =>
  applyTerminalKey(event, {
    hasSelection: () => terminal.hasSelection(),
    getSelection: () => terminal.getSelection(),
    input: (data) => terminal.input(data),
    post,
    preventDefault: () => event.preventDefault(),
  }),
);

function requestAttach(): void {
  if (resyncPending) {
    return;
  }
  resyncPending = true;
  post({
    type: 'attach',
    cols: terminal.cols,
    rows: terminal.rows,
  });
}

function processChunk(chunk: OutputChunk): void {
  if (sessionId === null) {
    return;
  }
  if (chunk.sequence <= lastSequence) {
    return;
  }
  if (chunk.fromSequence !== lastSequence + 1) {
    pendingOutput = [];
    outputReady = false;
    requestAttach();
    return;
  }
  terminal.write(chunk.data);
  lastSequence = chunk.sequence;
}

function drainOutput(): void {
  if (!outputReady) {
    return;
  }
  while (pendingOutput.length > 0) {
    const chunk = pendingOutput.shift() as OutputChunk;
    processChunk(chunk);
    if (!outputReady) {
      return;
    }
  }
}

function resetStream(): void {
  sessionId = null;
  lastSequence = 0;
  pendingOutput = [];
  outputReady = false;
  resyncPending = false;
  snapshotGeneration += 1;
}

function handleSnapshot(message: SnapshotMessage): void {
  const session =
    message.session !== null && typeof message.session === 'object'
      ? (message.session as Record<string, unknown>)
      : undefined;
  const nextSessionId =
    session !== undefined && typeof session.sessionId === 'string'
      ? session.sessionId
      : null;
  const sequence =
    session !== undefined && Number.isSafeInteger(session.sequence)
      ? (session.sequence as number)
      : 0;
  const backlog =
    session !== undefined && typeof session.backlog === 'string'
      ? session.backlog
      : '';

  resetStream();
  sessionId = nextSessionId;
  lastSequence = sequence;
  const generation = snapshotGeneration;

  terminal.reset();
  terminal.clear();

  applyWorkspaceState(
    message.workspaceMode,
    message.workspaceName ?? message.folderName,
    message.workingDirectory,
  );
  if (text(message.shellLabel).length > 0) {
    shellLabel.textContent = text(message.shellLabel);
  }

  if (backlog.length > 0) {
    terminal.write(backlog, () => {
      if (generation !== snapshotGeneration) {
        return;
      }
      outputReady = true;
      drainOutput();
      if (sessionId !== null) {
        fitNow();
      }
    });
  } else {
    outputReady = true;
    if (sessionId !== null) {
      fitNow();
    }
  }

  toolbarNote =
    message.truncated === true
      ? 'PTY 输出缓冲已截断；较早的屏幕内容无法恢复。'
      : '';
  renderShellLabelTitle();
  if (sessionId !== null) {
    terminal.focus();
  }
}

function handleOutput(message: {
  readonly sessionId?: unknown;
  readonly fromSequence?: unknown;
  readonly sequence?: unknown;
  readonly data?: unknown;
}): void {
  if (
    typeof message.sessionId !== 'string' ||
    message.sessionId !== sessionId ||
    !Number.isSafeInteger(message.fromSequence) ||
    !Number.isSafeInteger(message.sequence) ||
    typeof message.data !== 'string'
  ) {
    return;
  }
  const chunk: OutputChunk = {
    fromSequence: message.fromSequence as number,
    sequence: message.sequence as number,
    data: message.data,
  };
  if (!outputReady) {
    pendingOutput.push(chunk);
    return;
  }
  processChunk(chunk);
}

function handleState(message: StateMessage): void {
  const count =
    typeof message.workspaceCount === 'number' ? message.workspaceCount : 0;
  const trusted = message.trusted === true;
  const ptyActive = message.ptyActive === true;

  workspaceCount = count;
  workspaceTrusted = trusted;
  applyWorkspaceState(
    message.workspaceMode,
    message.workspaceName,
    message.workingDirectory,
  );
  shellLabel.textContent = text(message.shellLabel) || 'shell';
  shellStatusTitle =
    text(message.status).length > 0 ? text(message.status) : '当前 shell';

  restartButton.disabled = !trusted;
  const restartRecommended = message.restartRecommended === true;
  restartButton.classList.toggle('restart-recommended', restartRecommended);
  restartButton.title = restartRecommended
    ? '终端或工作目录配置已更改，重启 PTY 后生效。'
    : '重启 PTY';

  if (!ptyActive && sessionId !== null) {
    resetStream();
  }

  // Only a real error uses the overlay. Info notices, status text and the
  // restart hint stay in the toolbar; a visible error is never hidden just
  // because a later state carries an info notice.
  if (notification.handleHostNotice(stateErrorNotice(message))) {
    persistNoticeId();
  }

  const warnings = Array.isArray(message.shellWarnings)
    ? message.shellWarnings.filter((entry): entry is string => typeof entry === 'string')
    : [];
  shellWarningsTitle = warnings.length > 0 ? warnings.join('\n') : '';
  renderShellLabelTitle();
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message === null || typeof message !== 'object') {
    return;
  }
  const type = (message as { type?: unknown }).type;
  switch (type) {
    case 'state':
      handleState(message as StateMessage);
      return;
    case 'ptySnapshot':
      handleSnapshot(message as SnapshotMessage);
      return;
    case 'ptyOutput':
      handleOutput(message as Record<string, unknown>);
      return;
    case 'ptyExit': {
      const exitSession = (message as { sessionId?: unknown }).sessionId;
      if (typeof exitSession === 'string' && exitSession === sessionId) {
        resetStream();
        notification.showLocalError(
          'PTY 已退出。引用不会写入 shell；请点击“重启”。',
        );
      }
      return;
    }
    case 'focusPty':
      terminal.focus();
      return;
    case 'clearTerminal':
      terminal.clear();
      return;
    default:
      return;
  }
});

workspaceButton.addEventListener('click', () => {
  post({ type: 'chooseWorkspace' });
});

restartButton.addEventListener('click', () => {
  post({ type: 'restart' });
});

noticeClose.addEventListener('click', () => {
  notification.dismiss();
  persistNoticeId();
});

function readData(dataTransfer: DataTransfer, type: string): string {
  try {
    return dataTransfer.getData(type) || '';
  } catch {
    return '';
  }
}

function firstNonEmpty(values: readonly string[]): string {
  for (const value of values) {
    if (value.length > 0) {
      return value;
    }
  }
  return '';
}

function collectDrop(dataTransfer: DataTransfer): Record<string, string> {
  return {
    // Keep both lists. The extension merges text/uri-list with the internal
    // application/vnd.code.uri-list instead of keeping only the first field,
    // so a multi-select Explorer drag cannot be reduced to one file.
    uriList: readData(dataTransfer, 'text/uri-list'),
    codeUriList: readData(dataTransfer, 'application/vnd.code.uri-list'),
    resourceUrls: firstNonEmpty([
      readData(dataTransfer, 'ResourceURLs'),
      readData(dataTransfer, 'resourceurls'),
      readData(dataTransfer, 'application/vnd.code.resource-urls'),
    ]),
    codeFiles: firstNonEmpty([
      readData(dataTransfer, 'CodeFiles'),
      readData(dataTransfer, 'codefiles'),
      readData(dataTransfer, 'application/vnd.code.code-files'),
    ]),
    codeEditors: firstNonEmpty([
      readData(dataTransfer, 'CodeEditors'),
      readData(dataTransfer, 'codeeditors'),
      readData(dataTransfer, 'application/vnd.code.code-editors'),
    ]),
    plainText: firstNonEmpty([
      readData(dataTransfer, 'text/plain'),
      readData(dataTransfer, 'text'),
    ]),
  };
}

function hasDropData(payload: Record<string, string>): boolean {
  return Object.values(payload).some((value) => value.length > 0);
}

function stopDropEvent(event: DragEvent): void {
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer !== null) {
    event.dataTransfer.dropEffect = 'copy';
  }
}

document.addEventListener(
  'dragenter',
  (event) => {
    stopDropEvent(event);
    dragDepth += 1;
    dropOverlay.hidden = false;
    appEl.classList.add('dragging');
  },
  true,
);

document.addEventListener(
  'dragover',
  (event) => {
    stopDropEvent(event);
    dropOverlay.hidden = false;
    appEl.classList.add('dragging');
  },
  true,
);

document.addEventListener(
  'dragleave',
  (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropOverlay.hidden = true;
      appEl.classList.remove('dragging');
    }
  },
  true,
);

document.addEventListener(
  'drop',
  (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    dropOverlay.hidden = true;
    appEl.classList.remove('dragging');

    const dataTransfer = event.dataTransfer;
    if (dataTransfer === null) {
      notification.showLocalError('拖放数据为空，未写入引用。');
      return;
    }
    const payload = collectDrop(dataTransfer);
    if (!hasDropData(payload)) {
      let fileCount = 0;
      try {
        fileCount = dataTransfer.files ? dataTransfer.files.length : 0;
      } catch {
        fileCount = 0;
      }
      notification.showLocalError(
        fileCount > 0
          ? '系统文件管理器拖入的文件没有暴露本地路径（VS Code webview 限制）。请拖到底部面板中 TUI 左侧的“拖入文件”原生区域，或使用命令面板的“OpenCode: 选择文件插入 @ 引用”。'
          : '未识别到文件或选区。请把文件拖到底部面板中 TUI 左侧的“拖入文件”原生区域；webview 内的 Explorer 拖放受 VS Code 平台限制，不保证可用。不要拖入任意纯文本。',
      );
      return;
    }
    post({ type: 'drop', ...payload });
    terminal.focus();
  },
  true,
);

fitNow();
post({ type: 'ready', cols: terminal.cols, rows: terminal.rows });

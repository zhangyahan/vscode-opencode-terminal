(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const statusEl = document.getElementById('status');
  const noticeEl = document.getElementById('notice');
  const startButton = document.getElementById('start-button');
  const focusTerminalButton = document.getElementById('focus-terminal-button');
  const dropZone = document.getElementById('drop-zone');
  const addSelectionButton = document.getElementById('add-selection-button');
  const pickFilesButton = document.getElementById('pick-files-button');
  const clearButton = document.getElementById('clear-button');
  const referenceList = document.getElementById('reference-list');
  const emptyState = document.getElementById('empty-state');
  const countEl = document.getElementById('count');
  const insertAllButton = document.getElementById('insert-all-button');
  const copyAllButton = document.getElementById('copy-all-button');

  let currentAttachments = [];
  let canInsert = false;

  function post(message) {
    vscode.postMessage(message);
  }

  function showLocalNotice(message) {
    noticeEl.textContent = message;
    noticeEl.className = 'notice error';
    noticeEl.hidden = false;
  }

  function text(value) {
    return typeof value === 'string' ? value : '';
  }

  function renderNotice(notice) {
    if (
      notice === null ||
      typeof notice !== 'object' ||
      typeof notice.message !== 'string' ||
      notice.message.length === 0
    ) {
      noticeEl.hidden = true;
      noticeEl.textContent = '';
      return;
    }
    noticeEl.textContent = notice.message;
    noticeEl.className =
      'notice ' + (notice.kind === 'error' ? 'error' : 'info');
    noticeEl.hidden = false;
  }

  function makeButton(label, action, disabled) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', action);
    return button;
  }

  function renderReferences(attachments) {
    referenceList.replaceChildren();

    for (const attachment of attachments) {
      if (
        attachment === null ||
        typeof attachment !== 'object' ||
        typeof attachment.id !== 'string' ||
        typeof attachment.mention !== 'string'
      ) {
        continue;
      }

      const item = document.createElement('li');
      item.className = 'reference';

      const main = document.createElement('div');
      main.className = 'reference-main';

      const mention = document.createElement('code');
      mention.className = 'mention';
      mention.textContent = attachment.mention;

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent =
        text(attachment.folderName) +
        (attachment.outsideWorkspace === true ? ' · 工作区外' : '');

      main.appendChild(mention);
      main.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'reference-actions';
      actions.appendChild(
        makeButton(
          '插入终端',
          function () {
            post({ type: 'insert', ids: [attachment.id] });
          },
          !canInsert,
        ),
      );
      actions.appendChild(
        makeButton('复制', function () {
          post({ type: 'copy', ids: [attachment.id] });
        }, false),
      );
      actions.appendChild(
        makeButton('移除', function () {
          post({ type: 'remove', ids: [attachment.id] });
        }, false),
      );

      item.appendChild(main);
      item.appendChild(actions);
      referenceList.appendChild(item);
    }

    emptyState.hidden = attachments.length > 0;
    countEl.textContent = attachments.length + ' 个';
  }

  function renderState(message) {
    const attachments = Array.isArray(message.attachments)
      ? message.attachments
      : [];
    currentAttachments = attachments;

    const status =
      message.status !== null && typeof message.status === 'object'
        ? message.status
        : {};
    canInsert = status.canInsert === true;

    statusEl.textContent =
      text(status.text) || '终端已创建，请确认 OpenCode 已就绪。';
    startButton.disabled = status.canStart !== true;
    focusTerminalButton.hidden = status.kind !== 'created';

    renderNotice(message.notice);
    renderReferences(attachments);

    clearButton.disabled = attachments.length === 0;
    insertAllButton.disabled = !canInsert || attachments.length === 0;
    copyAllButton.disabled = attachments.length === 0;

    if (
      typeof message.maxAttachments === 'number' &&
      message.maxAttachments > 0
    ) {
      countEl.textContent =
        attachments.length + ' / ' + message.maxAttachments + ' 个';
    }
  }

  function ids() {
    const result = [];
    for (const attachment of currentAttachments) {
      if (
        attachment !== null &&
        typeof attachment === 'object' &&
        typeof attachment.id === 'string'
      ) {
        result.push(attachment.id);
      }
    }
    return result;
  }

  startButton.addEventListener('click', function () {
    post({ type: 'start' });
  });

  focusTerminalButton.addEventListener('click', function () {
    post({ type: 'focusTerminal' });
  });

  addSelectionButton.addEventListener('click', function () {
    post({ type: 'addActiveSelection' });
  });

  pickFilesButton.addEventListener('click', function () {
    post({ type: 'pickFiles' });
  });

  clearButton.addEventListener('click', function () {
    post({ type: 'clear' });
  });

  insertAllButton.addEventListener('click', function () {
    const all = ids();
    if (all.length === 0) {
      showLocalNotice('没有可插入的引用。');
      return;
    }
    post({ type: 'insert', ids: all });
  });

  copyAllButton.addEventListener('click', function () {
    const all = ids();
    if (all.length === 0) {
      showLocalNotice('没有可复制的引用。');
      return;
    }
    post({ type: 'copy', ids: all });
  });

  function readType(dataTransfer, type) {
    let value = '';
    try {
      value = dataTransfer.getData(type) || '';
    } catch {
      value = '';
    }
    if (value.length > 0) {
      return value;
    }

    let types = [];
    try {
      types = Array.from(dataTransfer.types || []);
    } catch {
      types = [];
    }
    const match = types.find(function (item) {
      return item.toLowerCase() === type.toLowerCase();
    });
    if (match === undefined) {
      return '';
    }
    try {
      return dataTransfer.getData(match) || '';
    } catch {
      return '';
    }
  }

  function firstNonEmpty(values) {
    for (const value of values) {
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return '';
  }

  function collectDrop(dataTransfer) {
    return {
      uriList: firstNonEmpty([
        readType(dataTransfer, 'text/uri-list'),
        readType(dataTransfer, 'application/vnd.code.uri-list'),
      ]),
      resourceUrls: firstNonEmpty([
        readType(dataTransfer, 'ResourceURLs'),
        readType(dataTransfer, 'resourceurls'),
        readType(dataTransfer, 'application/vnd.code.resource-urls'),
      ]),
      codeFiles: firstNonEmpty([
        readType(dataTransfer, 'CodeFiles'),
        readType(dataTransfer, 'codefiles'),
        readType(dataTransfer, 'application/vnd.code.code-files'),
      ]),
      codeEditors: firstNonEmpty([
        readType(dataTransfer, 'CodeEditors'),
        readType(dataTransfer, 'codeeditors'),
        readType(dataTransfer, 'application/vnd.code.code-editors'),
      ]),
      plainText: firstNonEmpty([
        readType(dataTransfer, 'text/plain'),
        readType(dataTransfer, 'text'),
      ]),
    };
  }

  for (const type of ['dragenter', 'dragover']) {
    dropZone.addEventListener(type, function (event) {
      event.preventDefault();
      if (event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = 'copy';
      }
      dropZone.classList.add('dragging');
    });
  }

  dropZone.addEventListener('dragleave', function (event) {
    if (event.target === dropZone) {
      dropZone.classList.remove('dragging');
    }
  });

  dropZone.addEventListener('drop', function (event) {
    event.preventDefault();
    dropZone.classList.remove('dragging');

    const dataTransfer = event.dataTransfer;
    if (dataTransfer === null) {
      showLocalNotice('拖放数据为空，未添加引用。');
      return;
    }

    const payload = collectDrop(dataTransfer);
    const hasData =
      payload.uriList.length > 0 ||
      payload.resourceUrls.length > 0 ||
      payload.codeFiles.length > 0 ||
      payload.codeEditors.length > 0 ||
      payload.plainText.length > 0;

    if (!hasData) {
      let fileCount = 0;
      try {
        fileCount = dataTransfer.files ? dataTransfer.files.length : 0;
      } catch {
        fileCount = 0;
      }
      showLocalNotice(
        fileCount > 0
          ? '拖放的本地文件没有暴露路径。请从 VS Code Explorer 拖入，或使用“添加文件…”。'
          : '未识别到文件或选区。请从 VS Code Explorer 或编辑器拖入。',
      );
      return;
    }

    post({
      type: 'drop',
      uriList: payload.uriList,
      resourceUrls: payload.resourceUrls,
      codeFiles: payload.codeFiles,
      codeEditors: payload.codeEditors,
      plainText: payload.plainText,
    });
  });

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (
      message === null ||
      typeof message !== 'object' ||
      message.type !== 'state'
    ) {
      return;
    }
    renderState(message);
  });

  post({ type: 'ready' });
})();

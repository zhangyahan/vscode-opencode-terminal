# OpenCode Terminal for VS Code

仓库：[zhangyahan/vscode-opencode-terminal](https://github.com/zhangyahan/vscode-opencode-terminal)。预编译 VSIX 见 [Releases](https://github.com/zhangyahan/vscode-opencode-terminal/releases)；本扩展仅通过 GitHub 分发，未发布到 VS Code Marketplace。

在 VS Code 底部面板中提供 **OpenCode** 视图，并在当前工作区打开一个原生集成终端运行 OpenCode。扩展可以把拖入的文件、编辑器选区转换成 OpenCode 的 `@文件` / `@文件#起始行-结束行` 引用，先放入待发送列表；只有用户明确点击“插入终端”时才会写入终端，且**不会自动按回车或提交**。

## 功能

- 底部面板（`viewsContainers.panel`）注册 OpenCode webview 视图，与 Terminal、Problems 等面板位于同一区域。
- 使用原生 `vscode.window.createTerminal` 创建终端，`cwd` 为选中的工作区目录，位置为 Panel。
- 终端按工作区复用：同一个工作区不会重复启动 OpenCode；多个工作区（multi-root）会弹出选择。
- 支持从 VS Code Explorer 拖入文件、从编辑器拖入选区，也提供命令和按钮：
  - `OpenCode: 添加当前选区/文件为引用`
  - `OpenCode: 添加文件为引用`（Explorer 右键，多选可用）
  - `OpenCode: 从磁盘添加文件引用`（打开系统文件选择框）
  - 视图内按钮：启动、添加当前选区、添加文件、插入、复制、移除、清空、显示终端
- 拖入的引用先显示在列表中，不会直接进入终端。
- 插入前弹出模态确认，提示先确认 OpenCode TUI 仍在终端中运行；如果终端已退出，输入可能进入 shell。可选择“复制到剪贴板”作为安全替代。
- 引用保存在扩展的 workspace state 中，切换视图或暂时隐藏面板不会丢失；终端关闭后引用仍保留。
- 所有发送内容在插入前再次通过 `src/core.ts` 的 `formatMention` 校验，拒绝控制字符、带空格的路径、带 `#` 的歧义路径。

## 环境要求

- VS Code `^1.94.0`。
- 本地已安装 OpenCode CLI，并能在 VS Code 集成终端所在环境中执行 `opencode`。
  - 请参考 OpenCode 官方文档安装；安装后可用 `opencode --version` 确认。
  - 本扩展按 OpenCode V2 的行为设计：默认执行 `opencode` 即启动 TUI，不假设存在 `--port`、`/tui/append-prompt` 等 V1 内部接口，也不进行 HTTP 探测。
- 工作区必须处于 **Workspace Trust** 状态。限制模式（untrusted）下扩展会显示面板，但禁止启动 OpenCode 和插入内容。

## 安装与运行

### 从源码 F5 调试

```powershell
npm install
npm run compile
```

在 VS Code 中打开本目录，按 **F5**（Run Extension），会启动一个扩展开发宿主窗口。打开一个文件夹后，点击底部面板的 **OpenCode** 图标。

### 安装 VSIX

```powershell
npx @vscode/vsce package --allow-missing-repository
code --install-extension vscode-opencode-terminal-0.0.1.vsix
```

VSIX 文件名以实际打包结果为准。

## 使用说明

### 启动

- 单根工作区：首次打开 OpenCode 面板时会自动启动一次终端并执行配置的启动命令。扩展不会因为面板显示/隐藏或终端关闭而循环重启。
- 多根工作区：点击“启动 OpenCode”，在 Quick Pick 中选择工作区。每个工作区维护独立终端。
- 通过面板按钮或命令启动时会显示原生终端；自动启动不抢焦点，以免把 webview 面板切走。
- 扩展重载后会通过终端 env 标识恢复本扩展创建、同一工作区且仍存活的终端，不会给已有终端重复发送启动命令。
- 状态文案会写“终端已创建，请确认 OpenCode 已就绪”，**不会声称已经验证 CLI 正在运行**。扩展无法可靠判断 TUI 是否还在前台。

### 添加文件和选区

- 从 Explorer 拖动一个或多个文件到 OpenCode 面板。
- 从编辑器拖动选区到 OpenCode 面板。
- 使用编辑器右键菜单、Explorer 右键菜单或视图按钮添加。
- 若拖放被 VS Code 拦截，请尝试按住 **Shift** 再拖入；仍无效请使用面板按钮或编辑器/Explorer 右键命令。
- 文件引用会变成 `@相对路径`；如果文件在工作区外，则保留绝对路径（`/` 分隔）。
- 选区引用会变成 `@路径#起始行-结束行`（OpenCode 使用 1-based 行号）。
- 路径包含空格时拒绝添加，并明确报错。扩展不会自创 OpenCode 的引号/转义语法。
- 路径包含 `#` 时同样拒绝，因为会与行号后缀产生歧义。

### 选区缓存与拖入文本

编辑器的非空选区会进入一个 **5 分钟**的短期缓存（最多 100 条）。当拖放 payload 只有纯文本、没有携带 URI/range 时：

1. 只有拖入文本与缓存中的文本**完全一致**；
2. 并且只匹配到唯一的 URI + range；

才会生成代码选区引用。过期、无匹配或匹配到多个选区时不会猜测、不会把拖入的纯文本直接发送到终端，而是提示使用“添加当前选区”或重新拖入。文档内容发生变化时会立即清除该文档的全部选区缓存，再按当前有效选区重新采样，避免使用过期行号。

如果拖放数据本身带有文件 URI 和 range（例如 `CodeEditors`），则直接使用该 range。文件 URI 没有 range 且同时有纯文本时，会尝试在该文件对应的缓存中做唯一匹配。

### 插入到终端

- 点击列表中的“插入终端”或“插入全部到终端”。
- 每次插入都会弹出模态确认，提醒确认 OpenCode TUI 仍在该终端中运行。
- 确认后使用 `terminal.sendText(text, false)`：只输入引用，**不按回车、不自动提交**。
- 如果用户选择“复制到剪贴板”，则只复制引用文本，不写终端。
- 如果终端已经关闭，会提示先启动，或提供复制到剪贴板。
- 引用来自不同工作区时会拒绝一次性插入，避免写错终端。

## 安全设计

- 启动命令配置 `opencodeTerminal.command` 为 **machine 作用域**，工作区设置无法覆盖；默认值 `opencode`。
- 该配置明确是 **用户可信的 shell 命令**（不是可执行文件路径 + 参数，也不是沙箱）。扩展不解析、不转义命令内容；安全相关校验仅拒绝控制字符（含换行），另有空命令和长度上限。单行命令本身仍可包含 `&&`、管道等 shell 语法。由于设置是 machine 作用域，工作区设置不能覆盖它。
- 未启用 Workspace Trust 时禁止启动和插入。
- Webview 使用 CSP nonce，只加载 `media/` 下的外部 JS/CSS；不使用内联脚本。
- Webview 通过 `textContent` 构建 DOM，不把消息内容当 HTML。
- 扩展对 webview 消息做类型、字段、长度和 ID 白名单校验；插入/复制/移除只传引用 ID，不传任意待发送文本。
- 拖放 payload 的纯文本只用于选区匹配，不会直接进入终端；所有插入的 mention 都会再次通过 `formatMention` 校验。
- 拖放 JSON 字段和单条消息都有长度上限。
- 不实现任何猜测的 HTTP/API 调用，也不依赖 OpenCode V1 的内部接口。

## 已知限制

1. **VS Code 原生终端不能嵌入 webview。** 因此 OpenCode 视图和 OpenCode 终端是面板中的两个标签页；扩展不会伪造一个终端控件。
2. 扩展无法验证 OpenCode CLI 是否仍在运行。状态只表示“终端已创建/已复用/已关闭”。
3. 启动命令是单行 shell 命令，不支持多行脚本；单行内仍可包含 `&&`、管道等 shell 语法。扩展不会解析或自动转义任意 shell 命令，也不会提供沙箱隔离。
4. 路径中含空格或 `#` 的文件不会被添加为引用；这是有意的安全/歧义限制。
5. 纯文本拖放只有在 5 分钟缓存中存在唯一精确匹配的选区时才生成行号；不保证所有编辑器拖放源都会提供可识别的 MIME 数据。
6. 多根工作区中，工作区外的文件添加引用时需要选择使用哪个工作区来计算相对路径。
7. 当前只接受本地 `file:` URI；Remote/WSL 等虚拟文件系统 URI 不会被添加为引用。命令在 VS Code 集成终端环境中执行，远程场景还需要该环境中可执行 `opencode`。
8. 未进行 Marketplace 发布配置；`publisher` 是本地占位值。

## 开发与测试

```powershell
npm run check    # 类型检查
npm run compile  # 编译到 out/
npm test         # 编译并运行 core + runtime + mock VS Code 集成测试
```

测试不依赖真实 VS Code 或真实 OpenCode：核心格式化、拖放解析、webview 消息校验、选区缓存匹配、终端复用/关闭逻辑由纯函数或纯类覆盖；`test/extension.integration.test.ts` 使用 mock `vscode` 覆盖激活命令注册、panel CSP、终端 cwd/nativePanel、启动一次、复用、关闭重建和扩展重载后的终端恢复。

### 手工测试清单

1. 打开单根工作区，执行 `npm run compile` 后按 F5；点击底部 OpenCode 图标，确认终端创建且执行了 `opencode`。
2. 再次打开面板或点击“启动”，确认复用同一终端，没有重复终端。
3. 在设置中确认 `OpenCode Terminal › Command` 是 machine 作用域；尝试在 `.vscode/settings.json` 覆盖它，确认不生效。
4. 将 Explorer 中的文件拖到面板，确认列表出现 `@...`，但终端没有立即收到内容。
5. 在编辑器中选中几行拖入，确认显示 `@文件#行-行`；用“插入”后确认弹窗出现，选择插入后终端只输入文本、不回车。
6. 在插入确认框选择“复制到剪贴板”，确认剪贴板内容正确。
7. 关闭 OpenCode 终端，确认状态变为已关闭、引用仍保留；再次启动后引用可继续插入。
8. 打开多根工作区，点击启动，确认出现工作区选择；分别启动两个工作区，确认各自终端独立。
9. 打开不受信任的工作区，确认启动和插入被禁止，面板仍能显示。
10. 尝试添加路径含空格或 `#` 的文件，确认显示明确错误，而不是生成错误引用。
11. 拖入一段与最近选区不匹配的纯文本，确认被拒绝且不会发送到终端。
12. 打开面板后切换标签/隐藏面板再回来，确认引用列表仍在。
13. 启动 OpenCode 后重载扩展宿主/窗口，再次启动或打开面板，确认恢复现有终端且没有重复执行启动命令。

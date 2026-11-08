# OpenCode Terminal by ZhangYahan

在 VS Code **底部 Panel（面板）**中直接运行 **OpenCode 的真实 TUI**。同一个 `opencodeTerminalBottom` 容器中，左侧是小型原生 **“拖入文件”** TreeView，右侧是 xterm/OpenCode webview 主区域：把 Explorer 中选中的多个文件拖到左侧原生区域，0.0.12 会始终以纯文本 `@路径` 插入**整文件**引用；只有多行编辑器选区才通过 OpenCode 内部 editor WebSocket 结构化插入，单行选区回退为 `@路径#行-行`。所有情况都**不会按回车/Tab，也不会执行任意拖入文本**，引用需在 OpenCode 中手动确认。

仓库：[zhangyahan/vscode-opencode-terminal](https://github.com/zhangyahan/vscode-opencode-terminal)。发布配置使用 VS Code Marketplace Publisher `zhangyahan`，扩展 ID 为 `zhangyahan.vscode-opencode-terminal`；Marketplace 条目生效前，请使用下方 VSIX 安装。

## 0.0.12 的变化

- **默认注册到底部 Panel**：`viewsContainers` 只贡献新的 `opencodeTerminalBottom` Panel 容器，不再默认注册到 Secondary Sidebar（辅助侧边栏）。新容器 ID 与早先的 `opencodeTerminal`、0.0.7–0.0.11 使用的 `opencodeTerminalSecondary` 都不同，避免沿用旧容器持久化的尺寸/位置。
- **拖入文件在左、TUI 在右**：同一 Panel 内视图顺序为 `opencodeTerminal.drop`（原生 TreeView）在前、`opencodeTerminal.main`（xterm TUI webview）在后，`initialSize` 为 1/99。该值只是首次布局的 flex 权重，不是固定像素宽度；VS Code 会给每个 Panel pane 施加自己的原生最小宽度（约 200px 量级，具体数值由 VS Code 版本决定），因此“拖入文件”区域不会小于该原生下限，扩展也无法通过 manifest 禁用拖动分隔线。需要更大/更小时请手动拖动两个视图之间的分隔线。
- 视图 ID `opencodeTerminal.drop` / `opencodeTerminal.main` 和全部命令 ID 保持不变；主命令文案从“打开侧栏”改为“OpenCode: 打开面板”。0.0.11 的 `opencodeTerminal.workingDirectory`、引用基准目录、多根工作区等行为全部保留。
- 升级后请 **完整 Reload Window**。扩展不写入 VS Code storage 布局，也不重置全部视图；如果某个视图曾被手动移动/固定，VS Code 可能保留旧位置，请在对应视图标题菜单选择 **Reset Location**（只影响该视图）。
- 版本 `0.0.12`。布局验证只检查 manifest 契约，**未在真实 VS Code 宿主中截图验证 Panel 分栏宽度或拖动结果**。

## 0.0.11 的变化

- **显式工作目录，不自动检测 `/cd`**：新增 `opencodeTerminal.workingDirectory`（默认空，`machine-overridable`）。空值使用所选工作区文件夹；支持绝对路径和 `${workspaceFolder}`、`${workspaceFolderBasename}`、`${userHome}` 三个简单变量，不支持 `${env:...}`、`${command:...}`、`$(...)`、未知变量或 shell 展开；拒绝控制字符、Windows drive-relative 和非绝对路径。启动前会对目录做 `fs.stat` 验证，失败时不 spawn，也不启动 editor bridge。该 cwd 只改变新 PTY 的启动目录，**不改变 workspaceKey、活动会话 owner 或 bridge 绑定**；运行中修改设置只提示重启，不改变已有会话的引用基准。
- **已运行会话的引用基准**：新增命令 `OpenCode: 设置引用基准目录（不执行 cd）`（也可从主视图标题的文件夹图标进入）。命令要求 Workspace Trust 和活动的 PTY，使用 VS Code 原生文件夹选择框（默认当前基准），验证本地真实目录后，仅把 override 绑定到**当前 sessionId**。它不向 PTY 写任何字符、不 spawn、不杀 bridge、不切换活动 owner。override 只影响之后的 `@` 引用；请自行确保所选目录与你在 OpenCode 中 `/cd` 后的目录一致，扩展不会执行 cd，也不会猜测你的 shell 当前目录。重启、退出、移除工作区或 dispose 后 override 失效，新会话不继承。
- 多根工作区仍需你**显式**提供基准：扩展不会自动推断所有 root 的公共父目录，也不会把它作为默认值。没有配置且没有当前会话 override 时，其它 root 文件继续使用绝对 `@D:/...`；配置或手动选择基准后，才会按该基准生成相对 `@project/...`。跨 root 的读取权限仍由 OpenCode 决定。
- 版本 `0.0.11`。升级后请 **完整 Reload Window** 让新的扩展宿主代码生效。自动化测试只覆盖注入式行为，**未在真实宿主/OpenCode 中执行 `/cd` 或跨 root e2e 验证**。

## 0.0.10 的变化

- **多根工作区不再把其它 root 的文件当成错误**：当前 OpenCode 会话仍然只选择一个工作区文件夹作为 PTY 的 `cwd`；拖动、Explorer 右键“添加文件”和编辑器选区可以引用同一窗口内其它 root 的文件，统一按既有外部文件策略生成绝对 `@D:/path/file.ts` 引用。扩展不会自动切换会话、不会改 `cwd`、不会为另一个 root 启动新 PTY。
- **嵌套 root 仍以当前会话 root 为基准**：如果另一个已注册 root 物理上位于当前会话 `cwd` 内，引用仍使用当前会话 root 生成相对路径（例如 `@apps/mobile/src/a.ts`），不会被改成错误的嵌套 root 相对路径。
- 同一会话 root 内文件、窗口外文件、整文件 `@path`、多行/单行选区、粘贴/换行/resize 和默认右侧布局的行为均未改变。扩展不创建虚拟目录；跨 root 的绝对路径引用能否被 OpenCode 读取由其自身权限/沙箱决定，本轮只做了自动化行为测试，**未在真实宿主中 e2e 验证跨 root 绝对路径**。
- 版本 `0.0.10`。升级后请 **完整 Reload Window** 让新的 webview/扩展宿主代码生效。

## 0.0.9 的变化

- **粘贴改为单一路径，修复 Ctrl+V 双份**：keydown 中的 Ctrl/Cmd+V 仍会被拦截，避免 xterm 把原始 `\x16` 控制字节写入 PTY；但扩展不再主动发送 `readClipboard`、extension host 不再读取剪贴板，也不再向 webview 回发 `pasteText`。粘贴文本只由 VS Code webview/xterm 的原生 DOM paste 事件经 `terminal.onData` 写入一次。
- 不做按时间窗或文本内容的去重：连续两次粘贴相同内容会得到两次写入，这是独立粘贴的正常语义。Ctrl+Shift+V 的既有放行语义不变；Cmd+V 与 Ctrl+V 走同一条拦截路径。复制（Ctrl+C 选区、`copyClipboard`）与右键原生粘贴、拖放行为不变。
- 移除 `readClipboard`/`pasteText` 死协议；旧 webview 发来的 `readClipboard` 会被拒绝，绝不读取剪贴板或回发粘贴内容。
- 版本 `0.0.9`。升级后请 **完整 Reload Window** 让新的 webview 脚本生效。粘贴修复的自动化测试是行为级模拟，**不能替代真实 VS Code host 中的 Ctrl+V/Cmd+V、右键粘贴和 IME 验证**。

## 0.0.8 的变化

- **两个视图保持原生折叠**：上方 TUI webview 与下方“拖入文件”TreeView 仍是同一 `opencodeTerminalSecondary` 容器中的两个原生视图。点击各自视图标题的折叠/展开控件，或使用 VS Code 视图标题菜单中的折叠操作即可；扩展不注入自定义折叠按钮，也不修改 90/10 初始布局和视图引用。
- **Shift+Enter 专门换行**：仅当 `Shift+Enter` 且没有 Ctrl/Alt/Meta、也不处于 IME 组合输入时，webview 才发送 OpenCode 默认换行绑定 **Ctrl+J** 的裸 LF `\n`（不是 CR），经 xterm 唯一的 `onData` 路径写入 PTY，因此不会提交；同时阻止该 keydown 的默认行为，并对后续 keypress 只阻断、不重复发送。普通 Enter 仍由 xterm 发送 CR 提交；Ctrl+J 原有换行不变，其他修饰键组合不主动扩展。若用户在 OpenCode `cli.json` 中把换行键重新绑定到别的键，Shift+Enter 映射到 Ctrl+J 的默认假设可能不再适用；本扩展不会修改用户的 `cli.json`。
- **IME 安全边界**：`event.isComposing`、keyCode `229` 或 key `Process` 的自定义按键处理最高优先级直接放行，中文/日文选词时按 Enter 不会被本扩展当成换行或提交吞掉。Ctrl+C/Ctrl+V 的选区复制、无选区中断和剪贴板粘贴语义在 0.0.8 保持不变；0.0.9 起 Ctrl+V 改为原生 paste 单一路径，详见上节。
- **侧栏尺寸 trailing 防抖 175ms**：ResizeObserver、窗口 resize、字体/主题变化只重置计时器，用户停止拖动 175ms 后才执行一次 FitAddon 和 PTY resize（SIGWINCH），不再逐帧 rAF fit。初始 `ready` 与 snapshot attach 仍即时 fit 以保证首屏正确；容器隐藏或 `terminalWrap.clientWidth/clientHeight` 为 0 时跳过 fit，避免 FitAddon 把终端 clamp 成 2x1。防抖期间 xterm 可能按旧尺寸暂时裁切输出；这里的限制只针对 fit/PTY 尺寸通知，不承诺 TUI 输出在拖动中完全冻结。
- 版本 `0.0.8`。升级后请 **完整 Reload Window** 让新的 webview 脚本生效。

## 0.0.7 的变化

- **注册到 Secondary Sidebar（辅助侧边栏）**：`viewsContainers` 只贡献 `opencodeTerminalSecondary` 的 `secondarySidebar`，不再贡献底部 Panel 的 `opencodeTerminal` 容器。默认位置由 VS Code 决定，通常是右侧；用户全局布局仍可把辅助侧边栏放到左侧，本扩展不修改全局布局。
- 同一容器内顺序改为 **TUI 主 webview 在上、原生“拖入文件”TreeView 在下**，`initialSize` 分别为 90/10。该值只表示首次布局的 flex 权重，不是固定像素高度；原生区域的最小高度由 VS Code 决定，可拖动分隔线调整。
- 视图 ID `opencodeTerminal.main` / `opencodeTerminal.drop`、命令 ID 与拖放写入行为保持不变；主命令文案从“打开面板”改为“打开侧栏”。
- 升级到 0.0.7 需要 **完整 Reload Window**。扩展不写 VS Code storage 布局，也不重置全部视图；如果曾手动移动/固定过这些视图，可能需要在视图标题菜单选择 **Reset Location** 才会回到新的辅助侧边栏容器。
- 版本要求提升到 VS Code `^1.106.0`（`secondarySidebar` contribution 自 1.106 起可用）。

> 以下 0.0.8 及更早章节是历史变更记录；其中的“底部面板”“原生区域在上”等只描述当时版本。0.0.12 的当前行为以 0.0.12 章节和“功能”章节为准。

## 0.0.6 的变化

- **移除顶部工具栏右侧的“文件”按钮**及其 webview DOM 绑定，避免元素不存在时的空引用。文件引用仍可通过 Explorer 右键“添加文件”、命令面板“OpenCode: 选择文件插入 @ 引用”、原生“拖入文件”TreeView 和 webview 拖放使用；重启按钮、默认底部布局以及不自动 Enter/Tab 的行为均未改变。

## 0.0.5 的变化

- **整文件引用改为纯文本 `@path`**。上游内部 `at_mentioned` 要求 `lineStart`/`lineEnd` 并强制显示 `#`，没有“整文件”表示；0.0.5 不再读取文件总行数、不再构造 `1..lineCount`，也不把 `0/0` 当作无范围传给上游。右键“添加文件”、命令面板“选择文件插入 @ 引用”、原生“拖入文件”TreeView 与 webview 拖放的行为一致：整文件只写 `@path`，需手动确认。
- 多行编辑器选区仍通过 editor bridge 发送 1-based 行区间；单行选区仍文本回退 `@path#line-line`，避免 TUI 把单行范围扩展到文件尾。
- 扩展不再为了整文件引用调用 `openTextDocument` 或读取文件内容/大小/行数；桥接协议与 OpenCode 上游均未修改。不发送自动 Enter/Tab，不提交消息。

## 0.0.4 的变化

- 文件/代码引用优先通过 OpenCode TUI 的内部 editor WebSocket 协议结构化插入：扩展在 `127.0.0.1` 的随机端口启动一次性桥接，并把同一端口写入 `OPENCODE_EDITOR_SSE_PORT` 与 `CLAUDE_CODE_SSE_PORT`（同时覆盖从宿主环境继承的其他编辑器端口）。TUI 完成 `initialize`（protocolVersion `2025-11-25`）与 `notifications/initialized` 握手后，扩展只发送 `at_mentioned`；TUI 侧走 `insertFileMention`，**不会自动按 Enter/Tab**。
- 结构化引用保留源 URI 与零基选区，不把 `@...` 字符串反解析成 URI。多行选区使用既有 core 的 1-based 闭区间转换（`end.character === 0` 会排除结束行）；整文件使用 `1..document.lineCount`（单行文件为 `1..1`，与 TUI 的整文件语义一致）。
- **单行选区明确回退为文本 `@path#line-line`**：上游 TUI 在 `lineStart === lineEnd` 时会丢弃 `end`，导致范围扩展到文件尾；本扩展不会扩大范围伪装成功。桥接未连接/断开/启动失败时同样只做一次文本回退，并提示“需手动确认”，不延时按键、不重试已发送的 mention。
- 整文件结构化引用受大小/行数/疑似二进制限制（5 MB、200,000 行）；超限或无法读取 `lineCount` 时回退文本。
- 桥接是内部接口，没有 ACK：扩展最多只能提示“已发送引用添加请求（未提交）”，无法证明 TUI 已插入。升级后需要**重启 PTY**，让新的 OpenCode 进程读取新的端口环境变量。
- 0.0.3 的原生“拖入文件”TreeView、拖放解析、shell/profile/env 处理与键盘输入行为保持不变。

## 0.0.3 的变化

- 同一 `viewsContainers.panel` / `opencodeTerminal` 容器内新增原生 TreeView：`opencodeTerminal.drop`（标题“拖入文件”），作为稳定的文件拖放目标；下方仍是原来的 xterm webview TUI。
- `onView:opencodeTerminal.drop` 会在用户首次把文件拖到该区域时自动激活扩展，并聚焦现有 OpenCode webview；不会创建第二个终端。
- 原生拖放支持多文件、去重、`text/uri-list`、`application/vnd.code.uri-list`、`files`/`DataTransferItem.asFile()?.uri` 与 `CodeFiles`。目录、非 `file:` URI、相对路径、控制字符及危险 scheme 仍由现有 host `stat`/`formatMention` 校验拒绝。
- 修正 `CodeFiles` 的真实格式：VS Code 传的是原生绝对路径数组（如 `C:\Work\a.ts`、UNC、`/work/a.ts`），不是 `file:` URI；0.0.3 仅对 `CodeFiles` 信任绝对路径，并保留原有 `file:` URI 兼容。`text/plain` 永远不会被猜成文件路径。
- webview 的拖放监听改为 `document` capture，覆盖工具栏和 notice；`application/vnd.code.uri-list` 与 `text/uri-list` 会同时送到 host 合并，不再只保留第一个字段。webview 内的 Explorer 拖放仍受 VS Code 平台限制，不保证可用；请优先使用原生“拖入文件”区域。

## 0.0.2 的变化

- 侧栏主区域是一个占满高度的 xterm 终端，直接显示 shell / OpenCode TUI 的 ANSI 输出。
- 顶部只有一条很小的工具栏：工作区、当前 shell 状态、重启 PTY、插入文件。
- 删除了旧的大引用列表、插入全部、每次插入前的模态确认框和附件抽屉。
- 从 Explorer/编辑器拖放后，引用立即写入活动 PTY；引用之间使用空格分隔。
- 拖放的事件在 xterm 容器上以 capture 阶段拦截 `drop`，阻止默认导航/文件打开行为。
- 旧的 command ID 全部保留，但 `opencodeTerminal.focusTerminal` 现在聚焦嵌入式 xterm，不再调用原生 `createTerminal`。

## 功能

- Bottom Panel（`viewsContainers.panel`）注册 OpenCode 容器 `opencodeTerminalBottom`：左侧是原生“拖入文件”TreeView，右侧是 OpenCode webview/xterm TUI；两个视图都可使用 VS Code 原生折叠操作收起/展开，扩展不注入折叠按钮。
- 每个工作区拥有独立的 PTY 会话；单根工作区首次打开面板自动启动，多根工作区用 Quick Pick 选择。多根窗口只选择一个文件夹作为当前会话 owner；`cwd` 可由 `opencodeTerminal.workingDirectory` 显式指定（空值即该文件夹）。引用其它 root 的文件时，未显式设置基准则使用绝对 `@路径`；不会切换活动会话或另起 PTY。
- xterm 使用 FitAddon + ResizeObserver 适应面板尺寸：尺寸/字体/主题变化采用 175ms trailing 防抖，停止变化后只 fit 一次；初始 ready 和 snapshot 恢复仍即时 fit，隐藏或零尺寸时不 fit。手动键盘输入原样送入 PTY（Ctrl+C、ESC、方向键等控制键不做过滤），仅 `Shift+Enter` 映射为 Ctrl+J 的 LF 换行。
- 拖放/引用：
  - 整文件引用：始终写纯文本 `@src/core.ts`（不构造行范围、不读取总行数），需手动确认。
  - 多行编辑器选区：结构化桥接时发送 1-based 行区间；否则文本回退 `@src/core.ts#12-20`。
  - 单行选区：始终文本回退 `@src/core.ts#12-12`，避免 TUI 把单行范围扩展到文件尾；提示需手动确认。
  - 纯文本只有在 5 分钟选区缓存中**精确且唯一**匹配时才生成行号；无匹配时提示使用右键“添加当前选区”，不会把任意文本执行到终端。
- 支持 Ctrl+C 复制 xterm 选区（有选区时不向 PTY 发送 Ctrl+C；无选区时 Ctrl+C 仍作为终端中断发送）。Ctrl+V/Cmd+V 只拦截 xterm 原始 `\x16`，不再读取宿主剪贴板；粘贴文本由 VS Code webview 的原生 DOM paste 经 `terminal.onData` 写入 PTY 一次。连续相同内容粘贴两次会写入两次，不做去重；右键原生粘贴和拖放保持原样。
- 支持 Shift+Enter 换行：映射为 OpenCode 默认 Ctrl+J 的裸 LF，不发送 CR、不提交；普通 Enter 仍提交。IME 组合输入期间（`isComposing`/keyCode 229/key `Process`）本扩展的按键处理全部放行，不会吞掉选词回车。
- 有限输出缓冲（约 200 KB）。超过时 webview 会提示较早的输出已截断；这是屏幕恢复缓冲，不是无损日志。

## 环境要求

- VS Code `^1.106.0`（沿用既有最低版本基线，本版本未降低或抬高）。
- **Windows x64**：0.0.12 的已构建 VSIX 只声明并验证了 `win32-x64`。其他平台的理论依赖已由上游提供，但本版本没有验证，也不会声称支持。
- 本地已安装 OpenCode CLI，并且在 VS Code 默认终端环境中能执行 `opencode`。
- 工作区必须处于 **Workspace Trust**。限制模式下扩展不会 spawn PTY 或向终端写入任何内容。

## 安装

Marketplace 扩展 ID：`zhangyahan.vscode-opencode-terminal`（`win32-x64`，VS Code `^1.106.0`）。

```powershell
code --install-extension zhangyahan.vscode-opencode-terminal
```

Marketplace 条目生效前，或需要离线安装当前 0.0.12 构建时：

```powershell
code --install-extension vscode-opencode-terminal-0.0.12-win32-x64.vsix
```

Marketplace：[zhangyahan.vscode-opencode-terminal](https://marketplace.visualstudio.com/items?itemName=zhangyahan.vscode-opencode-terminal)。此前通过本地 `publisher: local` 构建的 VSIX 安装用户，Marketplace 版本会使用新的扩展 ID `zhangyahan.vscode-opencode-terminal`；安装后不会自动替换或卸载旧的 `local.vscode-opencode-terminal` 条目，请自行确认并卸载旧条目。本扩展不会自动卸载任何扩展。

安装或升级后请 **完整 Reload Window**。当前版本贡献的是新的底部 Panel 容器 `opencodeTerminalBottom`，不再默认注册到辅助侧边栏；如果曾手动移动/固定过 OpenCode 视图，可能需要在视图标题菜单选择 **Reset Location**。扩展不会写入 VS Code storage 布局，也不会重置全部视图。

VSIX 内含 `@lydell/node-pty` 的 N-API 预编译产物，以及桥接使用的锁定版本 `ws` 运行依赖；安装扩展不需要 Visual Studio Build Tools、node-gyp 或全局编译器。

## 使用

### 启动与重启

- 单根工作区：首次打开面板时自动启动一次 PTY，并执行 `opencodeTerminal.command`（默认 `opencode`）。
- 多根工作区：首次打开面板会弹出工作区选择；之后可在顶部工作区按钮切换。
- 顶部“重启”会杀掉当前工作区的 PTY 并重新启动；不会恢复上一个终端里的进程。
- 面板隐藏/切走时会保留 PTY 和 xterm 上下文。关闭面板视图不会立刻杀掉 PTY，重新打开会通过 snapshot 恢复；扩展 dispose/deactivate 或窗口重载会杀掉本扩展创建的 PTY，无法恢复会话。
- 从多根工作区移除某个文件夹时，扩展会立即 kill 对应 PTY、清理 backlog/活动状态；如果移除的是当前活动工作区，会清空 xterm 或切换到唯一剩余工作区。

### Shell 配置

扩展通过公开 API 读取当前工作区作用域下的：

- `terminal.integrated.defaultProfile.<platform>`
- `terminal.integrated.profiles.<platform>`
- `terminal.integrated.env.<platform>`

在没有工作区 shell 配置冲突时，用 `vscode.env.shell` 作为 VS Code 已检测到的默认 shell 路径 fallback。支持 profile 的 `path`、`args`、`env`、`${env:...}`、`${userHome}`、`${workspaceFolder}` 等变量；Windows 上参数可以是单个 CommandLine 字符串，POSIX 上要求参数数组（不会猜测引号拆分规则）。

安全约束：

- PTY 的启动 `cwd` 由 `opencodeTerminal.workingDirectory` 决定；空值使用选中的工作区 `folder.fsPath`。扩展只把它作为 `spawn` 参数和 shell profile 的 `${workspaceFolder}` 展开基准，不做 `/cd` 检测、不执行 shell 展开、不读取环境变量来推导路径。
- 合并环境变量时会清理 `ELECTRON_RUN_AS_NODE` 等 Electron 宿主变量，并设置 `TERM=xterm-256color`、`COLORTERM=truecolor`。
- 如果工作区设置包含 `terminal.integrated.profiles/env/defaultProfile`，首次启动会明确弹窗询问：使用工作区配置，或仅使用用户/默认配置。选择结果只缓存在当前扩展会话；相关设置变化后会重新询问。
- 选择“仅使用用户配置”后，扩展**不会**使用 `vscode.env.shell` fallback：公开 API 无法判断该路径是否已被工作区 profile/defaultProfile 改写，因此只允许 user/default profile 的显式 `path`。如果用户默认 profile 只有 `source` 而没有 `path`，扩展会明确报错并要求在用户设置中补充 `terminal.integrated.profiles.<platform>` 的 `path`，不会猜测旧版 PowerShell 路径，也不会静默使用工作区路径。
- 扩展不会把环境变量值写入日志或 webview。
- 无法解析所选 profile 时会显示明确错误，不会偷偷换成另一个 shell。Windows Terminal 只是 VS Code 的宿主终端，不需要也不内嵌 `wt.exe`。
- 默认 shell/profile/env 设置变化后，状态中会提示“重启 PTY 后生效”；扩展不会自动杀掉正在运行的 TUI。

### 多根工作区与引用基准（0.0.11）

如果 `D:/Workspace/FR` 下有多个 VS Code roots（例如 `FR`、`sai-qx-student-client`），且你在 OpenCode 中执行了 `/cd D:/Workspace/FR`，希望拖入 `D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts` 时得到 `@sai-qx-student-client/apps/mobile/src/a.ts`，有两种显式做法：

1. **新会话（永久设置）**：在 `.code-workspace` 的 `settings` 中写：

   ```json
   {
     "settings": {
       "opencodeTerminal.workingDirectory": "D:/Workspace/FR"
     }
   }
   ```

   然后 **完整 Reload Window**，或点击面板上的“重启”让新 PTY 生效。扩展会把 `D:/Workspace/FR` 作为 shell/OpenCode 的启动 cwd；它不会自动检测 `/cd`，也不会自动推断多个 root 的公共父目录作为默认值。若目录不存在或不是文件夹，扩展不会 spawn PTY，也不会启动 editor bridge。

2. **已经在现有 OpenCode 会话中 `/cd` 过**：打开命令面板执行 **`OpenCode: 设置引用基准目录（不执行 cd）`**，在原生文件夹选择框中选择 `D:/Workspace/FR`。该操作**不会重启会话、不会写 PTY、不会执行 cd**，只影响之后生成的 `@` 引用。你必须自己确保所选目录与 OpenCode 中 `/cd` 后的目录相同；扩展无法读取 OpenCode 的动态 cwd。重启 PTY、PTY 退出、移除工作区或扩展 dispose 后，这个内存 override 失效，恢复启动目录，新会话不会继承。

配置/选择基准后，期待得到的是相对**该基准**的 `@sai-qx-student-client/apps/mobile/...`，不是 VS Code 工作区虚拟路径。未设置基准时，其它 root 的文件仍按绝对 `@D:/...` 生成。跨 root 的读取/沙箱权限由 OpenCode 决定；只有你显式设置基准后，扩展才会生成相对引用。状态/提示会分别标出“引用基准”和实际 spawn cwd；手动 override 会明确标注“仅本会话手动设置，未执行 cd”。

### 拖放与引用

- **推荐入口**：底部面板中 TUI 左侧是原生“拖入文件”区域（TreeView）。从 **VS Code Explorer** 多选文件后拖到该区域即可；拖到根空白或提示项都支持，扩展会去重并只写入一次引用。
- 原生区域是唯一的稳定 Explorer 拖放入口。VS Code 1.145.2 中，Explorer 内部拖拽到 webview/xterm 区域可能被平台 iframe 的 pointer-events 边界拦截；扩展不会调用私有 DOM API，也不会强行修改 iframe pointer-events 来宣称“webview 一定能接收”。
- webview 仍保留 `document` capture 的拖放监听，能收到的事件会照常处理（工具栏、notice 和 xterm 区域都覆盖）。从编辑器拖入选区时，如果 payload 只有纯文本，会按“完整文本 + 唯一 URI/range”在 5 分钟缓存中匹配。
- 有明确文件来源时（Explorer/CodeFiles/text/uri-list），不会再把 Explorer 的路径 label 当成编辑器文本去匹配行号；只有完全没有文件、仅有纯文本的拖放才会走选区匹配。
- 系统文件管理器（Windows Explorer/Finder 等）拖入的 `files` 只有在 `DataTransferItem.asFile()?.uri` 存在时才接受；没有路径时绝不根据文件名猜路径，会提示改用原生区域或命令面板的“选择文件插入 @ 引用”。
- 文档内容变化会立即清除该文档的选区缓存，避免使用过期行号。
- 所有路径引用都经过 `src/core.ts` 的 `formatMention`：
  - 工作区内使用相对路径；
  - 工作区外保留绝对路径；
  - 拒绝控制字符、空格路径和带 `#` 的歧义路径。
- `CodeFiles` 按 VS Code 的真实负载解析为原生绝对路径（Windows `C:\...`、UNC、POSIX `/...`），host 使用 `vscode.Uri.file(path)`；仍兼容旧的 `file:` URI 条目，且 URI 字符串不会被提前 decode。
- 写入前会确认 PTY 仍活跃、bridge 绑定的 sessionId 与当前 PTY 一致；未启动时只提示先启动/重启，**不会盲目把引用写进 shell**，也不会创建另一个终端。
- 多行选区的结构化桥接只发送 `at_mentioned` JSON-RPC 通知，不向 PTY 写 `@...`；整文件与单行选区始终调用 `sendInput(text)` 写入纯文本引用，文本不含 CR/LF/Tab，不附加 `\r`，并提示需手动确认。是否提交由用户自己决定。
- 拖入的任意纯文本不会直接写入 PTY，也不会被当作 shell 命令执行。
- 两个视图的默认顺序是左侧原生“拖入文件”、右侧 TUI。`initialSize` 1/99 只表示首次布局的 flex 权重，不是固定像素宽度；每个 Panel pane 仍受 VS Code 原生最小宽度约束（约 200px 量级，具体由 VS Code 版本决定），扩展无法通过 manifest 取消该下限或禁用拖动分隔线。如果区域太大或太小，拖动两个视图之间的分隔线调整即可。

## 安全设计

- Workspace Trust 未启用时绝不 spawn PTY 或写入。扩展也不主动读取宿主剪贴板（复制仅使用 xterm 选区文本写入剪贴板）。
- Webview CSP：`default-src 'none'`，脚本只允许 nonce 外部文件，不使用 CDN；xterm 需要内联 style，因此仅对 `style-src`/`style-src-attr` 显式开放 `'unsafe-inline'`，没有放开脚本内联。
- 所有 webview 消息都做类型、长度、会话 ID、尺寸边界校验；PTY 写入同时校验工作区 key 和 sessionId，跨工作区/过期会话不能写入。
- 输出使用带 sequence 的 snapshot + 增量 batch 协议；webview 按 sequence 去重，发现缺口会重新请求 snapshot，避免静默丢输出。
- 拖放 MIME 字段和单条消息有大小上限；引用最终文本再次经过 core 校验。
- editor bridge 只监听 loopback（`127.0.0.1`），拒绝带 `Origin` 的浏览器式连接和非 loopback 来源；单连接替换式重连，`maxPayload` 64 KB，握手超时 5 秒。初始化响应只含 `capabilities: {}` 与固定 `serverInfo`，不读取或回传环境变量。
- 桥接没有未完成握手的持久队列：TUI 未发 `notifications/initialized` 前 `sendMention` 直接失败并回退文本，不会把引用转交给之后的新连接。PTY 退出、重启、移除工作区、扩展 dispose 都会关闭 socket/server/定时器。
- 不调用 OpenCode HTTP/API，也不读取 `cli.json`、不写 `claude.ide` 锁文件；只使用上游 TUI 已实现的 editor WebSocket 协议。

## 已知限制

1. **VS Code 没有公开 API 可以把原生集成终端嵌入 webview。** 本扩展自己用 node-pty 启动 shell；它不是复刻 VS Code 终端进程，因此不会有 VS Code 终端标签页里的任务/变量解析等全部能力。
2. **扩展无法判断 OpenCode 是否仍在前台。** PTY 里如果 OpenCode 已退出，用户随后直接敲键盘仍会进入 shell。拖放写入只检查 PTY 是否活跃，无法检查当前前台程序；这是终端协议本身的限制。
3. **窗口重载/扩展重载会结束 PTY。** 原生子进程属于扩展宿主，deactivate 时会主动 kill，避免孤儿进程；会话无法跨重载恢复。
4. 路径含空格或 `#` 的文件不会被添加为引用；这是有意的安全/歧义限制。
5. 只接受本地 `file:` URI；Remote/WSL/虚拟文件系统不在此版本的验证范围。
6. 纯文本拖放只在缓存存在唯一精确匹配时生成行号；原生“拖入文件”区域只处理文件/URI，不把文件名或纯文本猜成路径。
7. `vscode.env.shell` 只能返回“最终解析后的路径”，公开 API 无法说明它是否来自工作区 profile/defaultProfile。因此在用户拒绝工作区终端配置时，扩展不会使用它；用户默认 profile 若依赖 VS Code 自动检测（只有 `source` 没有 `path`），需要改为显式 `path`。
8. 系统文件管理器拖入的文件只有在公开 API 暴露 `DataTransferItem.asFile()?.uri` 时才能使用；没有路径时只提示，不猜测。Explorer 内部拖到 webview 区域仍可能被平台 iframe 拦截，原生“拖入文件”区域是稳定入口。
9. 已构建 VSIX 只针对 `win32-x64`，不声称支持 macOS/Linux。
10. `initialSize` 1/99 只影响首次布局权重，不是固定宽度；VS Code 会按容器可用空间和每个 pane 的原生最小宽度调整，用户可拖动分隔线，扩展无法保证固定的最小/最大像素值。
11. `publisher` 已配置为 `zhangyahan`（扩展 ID `zhangyahan.vscode-opencode-terminal`）；Marketplace 实际可见性以市场页面为准。已构建 VSIX 只针对 `win32-x64`。
12. editor WebSocket 是 OpenCode TUI 的内部接口（`packages/tui/src/context/editor.ts`），不是公开稳定 API；协议版本或 `clientInfo.name` 变化时扩展会拒绝握手并回退文本。只有 TUI 明确支持 `initialize` / `notifications/initialized` / `at_mentioned` 时才可能结构化插入。
13. 桥接没有 ACK/确认帧；“已发送引用添加请求（未提交）”只表示帧已写入 socket，不表示 OpenCode 已完成插入。
14. 整文件引用始终是纯文本 `@path`；多行选区在桥接未连接/握手未完成时也只能文本回退；单行选区固定文本回退。所有文本仍需用户在 OpenCode 中手动确认。
15. 已经运行的旧 OpenCode 进程不会自动获得新端口；升级后必须重启 PTY（顶部“重启”）才会尝试使用结构化桥接。
16. 扩展只贡献底部 Panel 容器，不修改工作台全局 Panel 位置。若曾把某个视图手动移动到其他位置，VS Code 可能保留该位置，升级后可能需要在对应视图标题菜单选择 **Reset Location**。

## 版本与平台

- 版本：`0.0.12`
- 扩展 ID：`zhangyahan.vscode-opencode-terminal`
- 目标平台：`win32-x64`（最低 VS Code `^1.106.0`）
- VSIX：`vscode-opencode-terminal-0.0.12-win32-x64.vsix`

## 开发与测试

```powershell
npm install
npm run check        # 扩展 + webview TypeScript 类型检查
npm run build        # check + 编译扩展 + esbuild 打包 xterm
npm test             # 编译并运行全部非 native Node 测试（不使用 --force-exit）
npm run test:native  # 单独运行 node-pty N-API smoke（该文件需要 --test-force-exit）
npm run smoke:native # test:native 的别名
npm run package      # 生成 win32-x64 VSIX
```

测试覆盖：

- `core` / `runtime`：mention/range 格式化、拖放解析（含真实 Windows/POSIX/UNC `CodeFiles` 路径、URI 兼容、多字段合并去重）、webview 协议、选区缓存、命令校验。
- `references`：整文件/空选区固定纯文本 `@path`、多行选区、`end.character === 0`、单行回退、无效路径/范围、缺失 URI、URI+range 去重与数量上限。
- `editorBridge`：真实 `ws` 客户端完成 `initialize -> notifications/initialized -> at_mentioned`；断开、未握手、Origin、非 opencode 初始化、替换旧连接、stop 清理均不得发送。
- `workingDirectory`：空值回退、绝对路径/UNC/POSIX 归一化、三个受支持变量、env/command/未知/未展开变量拒绝、控制字符、drive-relative、非绝对路径与非字符串设置拒绝。
- `ptySession` / `shellProfile`：会话生命周期、输入/尺寸边界、输出 sequence/backlog、dispose；实际 spawn cwd 的只读查询和 stale session 拒绝；VS Code terminal profile 解析、环境合并、错误回退。
- `ptyAdapter.integration`：真实加载随包安装的 N-API 预编译 node-pty，运行一个短命令 `echo PTY_NATIVE_OK`，不启动 OpenCode。该文件沿用 `--test-force-exit` 仅用于关闭 node-pty 的 native handle；新增 bridge 测试不依赖它。
- `webviewInteraction`：行为级模拟 keydown/keypress/keyup、IME、普通 Enter 与 Ctrl+C/Ctrl+V；注入 post/input/selection 副作用，断言 Ctrl+V/Cmd+V keydown 只阻止原始 `\x16`，不读取剪贴板、不写 PTY；模拟原生 paste 一次只产生一次 onData，两次相同 paste 产生两次且无去重；Ctrl+Shift+V、keypress/keyup 不产生额外粘贴。另用注入的 fake scheduler 验证 100 次连续 resize 只触发一次 trailing fit、初始/快照 fitNow 即时执行、取消/隐藏/零尺寸不 fit、恢复后重新 fit。测试不加载 xterm 真实 DOM。
- `extension.integration`：mock VS Code 下验证自动 spawn 一次、profile args/env/cwd、bridge 端口 env 覆盖、ready/attach 实际尺寸与已运行 PTY resize、输入/输出/退出、多行选区走结构化桥接、整文件仅写 `@path` 且不打开文档/不调用 bridge、单行与断开时仅文本无 Enter、bridge 启动失败清理、PTY 退出/移除工作区/dispose 关闭 bridge、untrusted 不启动 bridge、CodeEditors options.selection、工作区配置确认、拒绝工作区配置时不用 workspace 解析的 `vscode.env.shell`；旧 `readClipboard` 消息被拒绝且不读取剪贴板、不回发 `pasteText`；另用 mock 原生 TreeView/DataTransfer 验证多文件整文件仅 `@路径` 不含 `#`、`CodeFiles` 原生路径、`asFile()?.uri`、目录跳过、非法 MIME、无 PTY、untrusted 与异步 `asString` 失败均不误写。多根用例先启动单 root 会话，再通过真实的 `workspaceFolders` 事件注册其它 root；`getWorkspaceFolder` mock 按平台路径、大小写和最长 root 边界匹配，覆盖原生 TreeView/webview drop/Explorer addFile 跨 root、嵌套 root 相对路径、异盘/case、跨 root 多行 bridge 绝对路径与单行文本回退，并断言 spawn 次数、cwd、活动会话不变。0.0.11 另验证配置 cwd 启动 FR 但 owner/workspaceKey 仍为项目、引用生成 `@project/...`、shell profile 的 `${workspaceFolder}`/`${workspaceFolderBasename}` 与有效 cwd 同步；运行中改配置只提示重启且不改变当前引用基准；`setReferenceBase` 不写 PTY/不 spawn/不杀 bridge，目录选择默认当前基准；无效配置目录不 spawn/bridge、无效选择与 untrusted 不保存 override；选择期间会话变化拒绝保存；restart/exit/移除工作区后 override 失效。harness 注入 `statDirectory`、原生 folder dialog 返回值和可触发的配置变更事件。
- `manifest`：契约检查只贡献底部 `panel` 容器 `opencodeTerminalBottom` 且无 `secondarySidebar`、drop/TUI 视图顺序与 1/99 `initialSize`、旧 view/命令 ID 保留、VS Code 最低版本 `^1.106.0`、0.0.12 VSIX 文件名、`workingDirectory` 的 `machine-overridable` 设置与 `setReferenceBase` 命令/标题/图标/`view/title` 入口，以及 Marketplace publisher/安装 ID 为 `zhangyahan.vscode-opencode-terminal`。

当前测试数：**160 个通过**（`npm test`，不含单独运行的 1 个 node-pty native smoke）。这些 bridge 测试使用真实 WebSocket 客户端，但仍是协议级 mock，不等于已证明真实 OpenCode TUI 插入成功；`webviewInteraction` 也不等于真实浏览器 IME、剪贴板或拖动 UI 验证；跨 root 绝对/相对 `@path` 与 `/cd` 同步均未在真实宿主/OpenCode 中 e2e 验证。

### 原生加载证据与限制

`npm run smoke:native` 在系统 Node 中真实 `require('@lydell/node-pty')` 并 spawn 短命令，证明预编译 N-API 二进制能加载和创建子进程。

本次构建还额外使用 VS Code 自带的 Electron 43.8.3（`ELECTRON_RUN_AS_NODE=1`，N-API 10，win32-x64）运行同一短命令，结果为 `ok: true`、`exitCode: 0`。这不是完整的 Extension Host 测试，但证明 Electron 的 N-API ABI 能加载该预编译二进制并创建子进程。最终扩展宿主内的运行仍需安装 VSIX 后手工确认。

### 手工测试清单

1. 安装/加载 0.0.12 后 **完整 Reload Window**，打开单根工作区，确认 OpenCode 出现在底部 Panel，左侧为小型“拖入文件”原生区域、右侧为 TUI。若某个视图仍停留在旧位置，使用对应视图标题菜单的 **Reset Location**。
2. 确认自动执行 `opencode` 一次；再次打开面板不重复 spawn。
3. 分别点击“拖入文件”和 TUI 视图标题的折叠控件，确认两个视图可独立折叠/展开，且展开后内容仍在；扩展不会新增折叠按钮或改变分隔线布局。
4. 在 TUI 输入框执行 `Shift+Enter`，确认只换行不提交；普通 `Enter` 提交；`Ctrl+J` 仍换行。使用中文输入法选词时按 `Enter`，确认选词正常、不会被吞掉或误提交。
5. 从 Explorer 多选文件拖到“拖入文件”区域（根空白或提示项均可）。确认出现去重后的纯文本 `@路径`（不含 `#行号`、不打开文档、不经过桥接）并提示需手动确认，不会执行、不会创建第二个终端。
6. 如果 Explorer 内部拖拽无法进入 xterm webview，确认扩展给出平台限制提示，而不是宣称 webview 直接拖放一定可用。
7. 在编辑器选中多行/单行后拖入或使用右键“添加当前选区”：多行在 bridge 可用时结构化插入；单行始终回退为文本 `@文件#行-行` 并提示需手动确认；整文件（右键“添加文件”或命令面板“选择文件插入 @ 引用”）始终为纯文本 `@文件`；无匹配纯文本只提示，不写入。多根工作区可先启动 root A，再把 root B 注册到同一窗口，从 B 拖入/添加文件或选区，确认写入绝对 `@B/...`，活动会话、cwd 和 spawn 次数不变；若 B 是 A 内的嵌套 root，确认仍按 A 生成相对路径。该跨 root 绝对路径场景未在真实宿主中 e2e 验证。
8. 有选区时 Ctrl+C 复制，不向 PTY 发 Ctrl+C；无选区时 Ctrl+C 照常中断。
9. 在真实 VS Code 中分别验证 Ctrl+V（Windows/Linux）与 Cmd+V（macOS）：每次只粘贴一份，不出现原始 `^V` 控制字符，也不自动回车；连续两次粘贴相同内容应得到两份。再用右键菜单原生粘贴一次，确认同样只粘贴一份；拖放行为保持不变。自动化测试只覆盖注入式 keydown/onData 行为，**本轮没有在真实 VS Code host 中执行这些手工步骤**。
10. 在真实 VS Code 中使用中文/日文 IME 选词并按 Enter，确认候选确认正常；IME 行为仍需实际 VS Code + 浏览器层验证，不能由 Node 测试替代。
11. 连续拖动 Panel 分隔线改变 TUI 宽度约 2 秒后停手，确认只在停止约 175ms 后发生一次终端重排/PTY resize，而不是拖动过程中每帧重排；首屏仍按真实尺寸显示，隐藏面板再打开不应出现 2x1 clamp。拖动过程中输出按旧尺寸临时裁切属已知现象。
12. 关闭/隐藏再打开面板，确认内容通过 snapshot 恢复；重启扩展宿主后确认旧 PTY 结束且没有孤儿进程。
13. 在设置中修改默认 shell 或 profile，确认出现“重启 PTY 后生效”提示。
14. 在工作区 `.vscode/settings.json` 写 `terminal.integrated.env.windows`，确认首次启动出现工作区配置确认；选择“仅使用用户配置”后不注入该 env，并确认没有使用工作区 profile 解析出的 `vscode.env.shell`。
15. 用户默认 profile 只有 `source`、没有 `path` 时选择“仅使用用户配置”，确认明确报错要求补充用户 profile `path`，而不是启动可疑路径。
16. 未启动 PTY 时直接从原生区域拖入文件，确认只提示先启动/重启，不写入。
17. 从系统文件管理器拖文件到原生区域，确认没有 `asFile()?.uri` 时只提示，不猜测路径。
18. 在多根工作区移除当前活动文件夹，确认对应 PTY 被 kill、xterm 缓冲清空，且没有孤儿进程。
19. 打开不受信任工作区，确认不会 spawn、不会写入，面板仍可见。
20. 拖动两个视图之间的分隔线，确认原生区域可以缩小，TUI 主区域保持可用；同时确认原生区域无法小于 VS Code 的约 200px pane 最小宽度，且扩展没有提供禁用拖动/固定像素的开关。
21. 启动 PTY 后，整文件引用应直接写纯文本 `@路径` 并提示需手动确认；多行选区在 OpenCode 支持内部 editor 协议时显示“已发送引用添加请求（未提交）”。两种情况都没有自动 Enter/Tab。
22. 检查状态提示没有声称“TUI 已确认插入”；断开桥接或停止 PTY 后再次添加引用，确认不会向旧 session/旧 bridge 发送。
23. 在 `.code-workspace` 设置 `"opencodeTerminal.workingDirectory": "D:/Workspace/FR"` 并重启 PTY，确认新会话的 spawn cwd 是 FR，但活动工作区/owner 未改变；拖入 `D:/Workspace/FR/sai-qx-student-client/apps/mobile/src/a.ts` 得到 `@sai-qx-student-client/apps/mobile/src/a.ts`。把该设置改成不存在的目录，确认不 spawn PTY、不启动 bridge 并出现明确错误。
24. 在已在 OpenCode 中 `/cd D:/Workspace/FR` 的现有会话执行 **OpenCode: 设置引用基准目录（不执行 cd）** 并选择 FR：确认命令没有向 PTY 写入、没有重启、截图/状态区分“引用基准”和“spawn cwd”，之后的引用按 FR 生成相对路径；执行 `/cd` 仍由用户自己完成。重启 PTY 或移除工作区后确认 override 失效并恢复启动目录。

# vscode-opencode-terminal

帮我实现一个vscode扩展，这个扩展具有以下几点功能：

1. 扩展位置注册在底部 Terminal 所在面板处，与当前profile terminal / spell checker 所在一处
2. 点击后在vscode当前项目运行opencode
3. opencode使用的终端为vscode终端中内置终端（在内置终端中运行opencode）
4. 支持拖动vscode内文件到窗口，将文件路径处理为opencode支持的路径 @ 开头
5. 支持拖动选中的代码到窗口，并将代码处理 @文件#200-201 此类opencode支持的格式

# NotePlan for Windows

一款受 [NotePlan](https://noteplan.co) 启发的 Windows 桌面笔记应用，基于 Electron + CodeMirror 6 构建。
核心哲学与 NotePlan 一致：**你的笔记就是磁盘上的纯 Markdown 文件**，随时可以用其它编辑器打开，
也方便放入 OneDrive / Dropbox / Git 等同步盘。

![界面预览](assets/icon.png)

## 功能特性

- **所见即所得编辑器**（CodeMirror 6，Obsidian 式 Live Preview）：标题放大、语法标记在
  光标离开的行**完全隐藏**（`**` `==` `[[ ]]` `#` 等），行内图片直接显示预览，表格渲染为
  真实表格，标题可折叠（行首 ▸），代码块整块渲染；任务复选框可直接点击勾选。
- **自动补全**：输入 `[[` 补全笔记标题（不存在标记为"新建"）；输入 `#` 补全标签；
  输入 `>` 补全日期（支持 `今天` / `明天` / `后天` 关键字与日期前缀）；输入 `@` 补全提及。
- **日历视图**：主界面可在 笔记 / 周计划 / 月历 / 年 之间切换。
  - **周计划**：一周七列总览本周排期任务，复选框直接勾选完成（自动写回源文件，
    循环任务自动重建）、拖拽改期、每列底部快速添加任务（写入当天每日笔记）；
    "本周目标"卡片自动保存到 `Notes/周计划/年-W周.md`，排了期的目标会出现在对应
    日期列（点击目标上的 📅 日期角标可定位并高亮该列）；顶部显示本周任务完成率。
  - **月历**：每格显示日历事件、任务时间块、待办与"有笔记"标记；拖入任务即改期；
    双击某天打开每日笔记。
  - **年视图**：12 个迷你月历，蓝点=有笔记、紫点=有事件、蓝色数字=当天有未完成任务，
    点月份进入月视图。
  - **日历事件**：支持订阅 ICS（设置 → 日历订阅，填 iCloud/Google 公开日历链接或本地
    `.ics` 文件），支持 RRULE 基本循环展开（DAILY/WEEKLY/MONTHLY/YEARLY）。
  - **法定节假日**：月历 / 年视图 / 周计划 / 周条 / 侧栏日历中，红色日期为中国大陆法定
    节假日（休），蓝色「班」角标为调休上班日；内置
    2024–2026 年官方数据（含 9 天春节等新规），浏览到其它年份时自动从 holiday-cn
    拉取并缓存到本地（每天至多尝试一次，离线不影响，设置里可关闭自动更新）；
    也可以在 `src/js/cn-holidays.js` 手动追加数据（native-wpf 版对应 `CnHolidays.cs`）。
  - **农历与二十四节气**：月历每格日期下方显示农历日（初一显示月名）、节气（绿色）
    与传统农历节日（春节 / 元宵 / 端午 / 中秋 / 重阳 / 腊八 / 除夕等，红色），悬浮提示
    显示完整干支年 + 生肖 + 农历日期；算法覆盖 1900–2100 年。
  - 日历以**周日为第一列**；侧栏日历 / 月历 / 年视图一致（周计划仍为 ISO 周一起始）。
- **每日笔记**：侧边栏月历 + 编辑器上方周条，每一天都有对应笔记（`Calendar/YYYY-MM-DD.md`）。
- **任务管理**：
  - `- [ ] 任务`，编辑器与预览中均可点击勾选；
  - **选中文字快速生成待办**：编辑器/预览中选中内容右键 →「转为待办任务」（选中各行批量
    加复选框）或「添加为今日待办」（追加到今天每日笔记，每行一条，toast 可一键打开）；
    `Ctrl+L` 支持切换当前行或选区内所有行；
  - 勾选自动追加 `@done(2026-09-01)`，取消自动移除；
  - 任务后写 `>2026-09-05` 排期，会聚合到那一天的每日笔记（"来自其它笔记"区域）；
  - 时间块：`- [ ] 任务 >2026-09-05 14:00-15:30`，出现在月历上；
  - **循环任务**：任务带 `every day / every 2 weeks / 每天 / 每2周` 等标记时，完成即自动
    在下一周期日期的每日笔记中重建；
  - **任务总览**：右侧"任务"面板按 今天 / 已过期 / 已排期 / 未排期 / 已完成 分组展示全库任务；
    分组可点击折叠（已完成默认折叠，状态记忆）；点击任务在编辑器中定位到对应行
    （从月历 / 周计划等任意视图点击都会自动切回笔记视图并跳转）。
  - **回收站**：删除的笔记进入应用内回收站（侧栏底部入口），支持恢复（冲突自动重命名）、
    永久删除、清空；删除后的 toast 可直接撤销。
- **拖拽排期**：把任务面板中的任务拖到周条某一天上即完成改期（写入源文件的 `>日期`）。
- **双向链接**：`[[笔记标题]]`，右侧"反向链接"面板显示引用。
- **命令面板**：`Ctrl+K` 搜笔记、搜全文、执行命令；`#标签` 一键搜索。
- **编辑 / 分栏 / 预览**三种视图；深色 / 浅色 / 跟随系统主题；笔记内搜索（`Ctrl+F`）。
- **纯本地**：所有数据都是笔记库文件夹里的 `.md` 文件，无数据库、无锁定。

## 快速开始

依赖：Node.js ≥ 18（仅开发时需要；打包后的安装包不依赖 Node）。

```bat
:: Electron 版（方案 A）
cd electron
npm install
npm run build   :: 构建 CodeMirror 编辑器 bundle（仓库已附带产物，可跳过）
npm start
```

```bat
:: WebView2 + .NET 版（方案 B），需要 .NET 8 SDK
cd webview2
dotnet build -c Release
:: 运行：binRelease
et8.0-windowsNotePlan for Windows.exe
```

```bat
:: Tauri v2 版（方案 C），需要 Rust 1.75+ (MSVC) 与 VS2022 Build Tools
cd tauri\src-tauri
cargo tauri dev     :: 开发模式（热重载）
cargo tauri build   :: 产出 NSIS 安装包
```

首次启动出现引导页：**创建示例笔记库**（在 `文档NotePlan 笔记库` 生成示例内容），
或**选择已有文件夹**。之后在 设置（`Ctrl+,`）里可随时更换笔记库位置。

## 目录结构

```
NotePlan/
├── electron/    方案 A：Electron 实现（main.js / preload.js / src / dist）
├── webview2/    方案 B：WebView2 + .NET 8 WPF 宿主（已停止更新，冻结保留）
├── tauri/       方案 C：Tauri v2 实现（Rust 后端 + 复用 electron/src 前端）
├── native-wpf/  方案 D（实验）：WPF + AvalonEdit 原生预览版
├── scripts/     开发与测试工具（CDP 驱动的端到端测试等，各版通用）
└── README.md
```

各版共用同一套界面代码；区别只在宿主（Node 主进程 ↔ C# 宿主 ↔ Rust 后端）
与 `window.api` 的注入方式（contextBridge ↔ postMessage 桥 ↔ Tauri invoke 桥）。

### 方案 C：Tauri v2 版（Rust 后端，安装包最小）

`tauri/` 用 Rust 重写了 Electron main.js 的全部数据操作（设置 / 笔记库 / 笔记 CRUD /
应用内回收站 / 搜索 / 任务 / 标签 / ICS 日历 / 系统调用），前端直接复制 `electron/src/`
并通过 `src/js/api-shim-tauri.js` 桥接——`app.js` 无需任何修改即可运行：

- 后端：`tauri/src-tauri/src/commands.rs`（32 个 `#[tauri::command]`，返回结构与
  Electron 版逐字段对齐）、`lib.rs`（启动 / 原生菜单 / `vault://` 自定义协议 /
  notify 文件监听 350ms 防抖 / 系统主题变化事件）
- 桥接：`window.__TAURI__.core.invoke`（`withGlobalTauri`），事件经 Tauri event
  system（`vault:changed` / `theme:changed` / `menu:*`）；笔记库内图片经
  `vault://`（WebView2 下为 `http://vault.localhost/`）自定义协议由 Rust 读取
- 配置存于 `%LOCALAPPDATA%\NotePlanTauri\config.json`

测试与 Electron 版同一套脚本：设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
启动应用（WebView2 支持 CDP），然后 `node scripts/test-functions.js`（31 项全部通过）。

```bat
cd tauri\src-tauri
cargo tauri dev
cargo tauri build   :: 产出 target/release/noteplan-tauri.exe 与 NSIS 安装包
```

### 方案 D：原生预览版（无 Web 技术，WPF + AvalonEdit）

```bat
cd native-wpf
dotnet build -c Release
bin\\Release\\net8.0-windows\\NotePlanNative.exe
```

需要 .NET 8 SDK（开发）/ .NET 8 Desktop Runtime（运行）。预览版范围：侧栏 + 日历 + 笔记列表 +
AvalonEdit 编辑器（Markdown 高亮 + 折叠）+ 回收站 + 删除撤销。数据层直接链接 C# 服务。

## 常用快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+K` | 命令面板 / 快速打开 / 全文搜索 |
| `Ctrl+Shift+F` | 全库搜索（同面板） |
| `Ctrl+N` | 新建笔记 |
| `Ctrl+J` | 打开今日笔记 |
| `Ctrl+E` | 编辑 / 分栏 / 预览 循环切换 |
| `Ctrl+L` | 切换当前行 / 选区内各行任务（自动 `@done` / 循环任务重建） |
| `Ctrl+F` | 笔记内搜索 |
| `Ctrl+Z` | 撤销（编辑器内） |
| `Ctrl+Shift+L` | 深色 / 浅色主题切换 |
| `Ctrl+S` | 立即保存（平时自动保存） |
| `Ctrl+,` | 设置 |
| `F2` | 重命名当前笔记 |
| `Tab` / `Shift+Tab` | 缩进 / 反缩进 |
| `Enter` | 自动续写列表 / 任务 / 引用 |

## 书写语法

```markdown
# 一级标题
## 二级标题

- [ ] 待办任务，可以安排到某天：>2026-09-05
- [x] 已完成任务（勾选时自动追加 @done(日期)）
- [ ] 每周循环任务 every week >2026-09-01
- [ ] 每天循环：每天 / 每2周 / every 3 days 均可
  - 嵌套子项
- 普通列表项，带 #标签 和 @提及

[[笔记标题]] 双链；[[笔记标题|显示别名]] 带别名。

==高亮文本==、**加粗**、*斜体*、~~删除线~~、`行内代码`、%%注释%%

> 引用块

```js
// 代码块
console.log('hello');
```

| 表格 | 支持 |
| --- | --- |
| 单元格 | 单元格 |

![图片](图片.png)   ← 相对路径会从笔记库内读取（vault:// 协议）
```

## 数据格式

笔记库就是一个普通文件夹：

```
NotePlan 笔记库/
├── Calendar/            每日笔记
│   ├── 2026-09-01.md
│   └── 2026-09-02.md
└── Notes/               普通笔记（支持子文件夹）
    ├── 欢迎使用 NotePlan for Windows.md
    └── 项目/
        └── 示例项目.md
```

删除的笔记暂存在笔记库的 `.trash/` 隐藏目录（含 index.json 索引），清空回收站后彻底删除。
应用设置：Electron 版在 `%APPDATA%\noteplan-windows\config.json`，WebView2 版在
`%LOCALAPPDATA%\NotePlanWpf\config.json`，Tauri 版在 `%LOCALAPPDATA%\NotePlanTauri\config.json`
（笔记库路径、主题、日历订阅等）。

## 原生预览版（WPF + AvalonEdit，实验性）

`native-wpf/` 是**无 Web 技术**的原生 WPF 实现（预览版）：

- 直接编译链接 `webview2/AppServices.cs`、`IcsService.cs`（C# 数据层单一来源）
- AvalonEdit 编辑器：Markdown 高亮、标题折叠（后续再加标记隐藏与内联组件）
- 侧栏：月历（日期点击开每日笔记）、本月笔记、笔记列表（过滤）、回收站（恢复/永久删除/清空）
- 与另两版**共用同一笔记库格式**，可同时打开同一笔记库

```bat
cd native-wpf
dotnet build -c Release
binRelease
et8.0-windowsNotePlanNative.exe
```

需要 .NET 8 SDK（开发）/ .NET 8 Desktop Runtime（运行）。预览版范围：侧栏 + 编辑器 +
回收站；月历主视图、时间轴、命令面板仍在 Web 版中，后续逐步移植。

## 打包发行

### GitHub Actions 自动打包

仓库内置 `.github/workflows/build.yml`：

- **推送到 `main`**：自动构建 Electron 与 Tauri 两个方案，安装包在构建页 Artifacts 下载；
- **推送 `v*` 标签**（`git tag v0.1.0 && git push origin v0.1.0`）：构建后把两个安装包自动发布为 GitHub Release；
- **Actions 页面手动触发**：workflow_dispatch 同效。

> 方案 B（WebView2 + .NET）已停止更新：不参与 CI 打包与前端同步，代码冻结保留仅供参考。

### 版本规范（SemVer）

每次提交按**修改范围**更新版本号（9 处配置统一由脚本修改）：

| 修改范围 | 版本位 | 示例 |
| --- | --- | --- |
| Bug 修复、文案与样式微调，无新功能 | `0.1.0 → 0.1.1`（patch） | 修复周条角标时序问题 |
| 新功能、界面/交互变化 | `0.1.1 → 0.2.0`（minor） | 新增农历节气、右键生成待办 |
| 破坏性变更（数据格式、语法、快捷键不兼容） | `0.2.0 → 1.0.0`（major） | 更改笔记库目录结构 |

操作：

```bat
node scripts\bump-version.js 0.2.1     :: 升版本（同步 9 处配置）
git commit -am "..."                   :: 提交
git tag v0.2.1 && git push origin main --tags   :: 推送后 CI 自动发布该版本 Release
```

未打标签的 main 提交只构建不出 Release；安装包请从 Releases 页或 Actions Artifacts 获取。

本地一键打包（Electron + Tauri，含国内镜像与工作区外输出目录，避免 asar 被索引器锁定）：

```bat
scripts\local-pack.bat
```

本地打包命令见下（GitHub Actions 也可手动触发）。

### 方案 A：Electron（在 electron/ 下）

```bat
cd electron
npm run dist
```

产出 `electron/dist/`：

- `NotePlan-for-Windows-Setup-0.1.0.exe` — NSIS 安装包（约 77 MB，安装后约 270 MB，x64）
- `win-unpacked/` — 免安装目录

### 方案 B：WebView2 + .NET（已停止更新）

> **⚠ 此方案已停止更新**：不再参与 CI 打包与前端功能同步，代码冻结保留仅供参考
> （功能停留在与 Electron/Tauri 同步的最后版本）。构建方法如下，仍可自行编译。

```bat
cd webview2NotePlanWpf
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true ^
  -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -o publish-selfcontained
cd ..
mkdir dist 2>nul
makensis setup.nsi
```

makensis 可直接使用 electron-builder 缓存里的 NSIS：
`%LOCALAPPDATA%\\electron-builder\\Cache\\nsis-3.0.4.1\\nsis-3.0.4.1-w8az6\\makensis.exe`
（PowerShell 下调用带引号路径记得加 & 调用运算符。）

产出 `webview2/dist/NotePlan-for-Windows-Setup-0.1.0-webview2.exe`（约 63 MB）。另有框架依赖发布
（`webview2/NotePlanWpf/publish-framework/`，exe 仅 0.95 MB，需目标机装有 .NET 8 Desktop Runtime）。

### 方案 C：Tauri v2（在 tauri/src-tauri/ 下）

```bat
cd tauri\src-tauri
cargo tauri build
```

产出 `target/release/bundle/nsis/NotePlan for Windows_0.1.0_x64-setup.exe`（NSIS 安装包），
以及免安装的 `target/release/noteplan-tauri.exe`。运行时使用系统内置的 WebView2，
无任何运行时依赖。

实测（同机同库）：

| | Electron | WebView2 + .NET | Tauri v2 |
| --- | --- | --- | --- |
| 安装包 | 76.6 MB | 62.8 MB | **2.6 MB** |
| 主程序体积 | — | — | 9.0 MB |
| 私有内存（应用全部进程） | 约 256 MB | 约 244 MB | 约 202 MB |

开发环境依赖：Rust 1.75+（MSVC target）、VS2022 Build Tools（C++ 桌面开发）、
`cargo-tauri` CLI（`cargo install tauri-cli` 或直接下载预编译版；前端为纯静态文件，
**无需 Node.js**）。测试时另需 Node（任意便携版即可）驱动 CDP 脚本。

应用未做代码签名，首次运行 SmartScreen 可能提示，属正常现象。

## 项目结构

```
NotePlan/
├── electron/               方案 A：Electron 实现（独立文件夹）
│   ├── main.js             主进程：文件库/搜索/任务/ICS/文件监听/菜单/vault 协议
│   ├── preload.js          contextBridge 暴露 window.api
│   ├── build.js            esbuild 打包 CodeMirror 扩展 → src/js/cm-bundle.js
│   ├── package.json        含 electron-builder 打包配置
│   ├── src/                界面 + 编辑器 + 渲染器（与本目录 assets/ 配套）
│   └── dist/               安装包输出
├── webview2/               方案 B：WebView2 + .NET 8 WPF 宿主（已停止更新，冻结保留）
│   ├── NotePlanWpf.csproj  net8.0-windows + Microsoft.Web.WebView2
│   ├── MainWindow.xaml(.cs) 原生菜单 + WebView2 + JSON 消息分发 + 文件监听 + vault 文件服务
│   ├── AppServices.cs      文件库/搜索/任务/标签（Electron main.js 的 C# 移植）
│   ├── IcsService.cs       ICS 拉取/解析/RRULE 展开
│   ├── NativeMethods.cs    回收站（SHFileOperation）
│   ├── setup.nsi           NSIS 安装包脚本
│   ├── src/ assets/        与 electron 各自独立的渲染层拷贝
│   └── publish-*、dist/    发布输出
├── tauri/                  方案 C：Tauri v2（Rust 后端）
│   ├── src/                复制自 electron/src 的前端 + js/api-shim-tauri.js 桥
│   ├── src-tauri/Cargo.toml
│   ├── src-tauri/tauri.conf.json   withGlobalTauri / 窗口 / NSIS 打包配置
│   ├── src-tauri/capabilities/     Tauri v2 权限（事件系统等 core 能力）
│   └── src-tauri/src/
│       ├── commands.rs     32 个 #[tauri::command]（与 Electron API 逐字段对齐）
│       └── lib.rs          启动 / 原生菜单 / vault:// 协议 / 文件监听 / 主题事件
├── scripts/                开发/测试工具（两版通用，非实现代码）
│   ├── cdp-eval.js         通过 CDP 在页面里执行 JS
│   ├── cdp-type.js         通过 CDP 发送真实键盘事件
│   ├── cdp-shot.js         通过 CDP 截取页面
│   ├── test-functions.js   31 项端到端功能测试
│   ├── test-completion.js  自动补全测试（4 项）
│   ├── test-markdown.js    渲染器冒烟测试
│   └── gen-icon.js / gen-ico.js  生成应用图标
└── README.md
```

两版功能完全一致，共用同一套界面设计；`src/` 在两处各有一份拷贝（有意为之，
两版完全独立），如需修改界面请同时更新两处（或改完一处后复制到另一处）。

## 路线图（v0.3 候选）

- [ ] 任务聚合区支持直接勾选（当前只读，点击跳转来源笔记）
- [ ] 拖拽移动笔记到文件夹
- [ ] 主界面月视图 / 时间块
- [ ] electron-builder 打包安装程序（nsis）
- [ ] 多笔记库窗口

## 许可

MIT。NotePlan 是 NotePlan.app 的商标，本项目与其无隶属关系，仅为个人学习性质的同类功能实现。

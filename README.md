# NotePlan for Windows

一款受 [NotePlan](https://noteplan.co) 启发的 Windows 桌面笔记应用，提供 **Electron** 与
**Tauri v2** 两种打包方案，共用同一套界面代码（CodeMirror 6 + 原生 JS）。
核心哲学与 NotePlan 一致：**你的笔记就是磁盘上的纯 Markdown 文件**，随时可以用其它编辑器打开，
也方便放入 OneDrive / Dropbox / Git 等同步盘。

![界面预览](electron/assets/icon.png)

## 功能特性

### 编辑器（Live Preview 即视图）

- **所见即所得**（CodeMirror 6，Obsidian 式 Live Preview）：视图即编辑器，不再区分
  编辑/预览模式——标题放大、语法标记在光标离开的行**完全隐藏**（`**` `==` `[[ ]]` `#` 等），
  行内图片直接显示预览，表格渲染为真实表格，标题可折叠（行首 ▸），代码块整块渲染；
  任务复选框直接点击勾选。
- **自动补全**：输入 `[[` 补全笔记标题（不存在标记为"新建"）；输入 `#` 补全标签；
  输入 `>` 补全日期（支持 `今天` / `明天` / `后天` 关键字与日期前缀）；输入 `@` 补全提及。

### 界面布局

- **主视图**：顶部在 笔记 / 周计划 / 月历 / 年 之间切换。
- **右栏（仅「笔记」视图展示，其余视图自动隐藏并铺满区域）**：
  - **月历**：橙色 CW 列为 ISO 周数（点击打开周计划）；日期旁红点=法定节假日（休）、
    蓝点=调休上班日；点击日期切换右栏日程，双击打开当日笔记；
  - **当日日程**：all-day 区列出当天无时间任务（可直接勾选、点击跳到原文），
    时间轴（默认 08:00–20:00，按内容自动扩展）把带时间的任务和日历事件按起止时间
    定位成色块（任务蜜桃色、事件彩色粉底），重叠时段自动并排分列。
- **周数行**：每日笔记正文顶部显示所属周（`WEEK 39 · 9/20 – 9/26`），点击打开本周周计划。
- **周条**：编辑器上方的七日卡片（周日起始），显示当天待办数与节假日圆点，点击打开当天笔记。

### 视图

- **周计划**：一周七列总览本周排期任务，拖拽改期；周日起始；"本周目标"卡片自动保存到
  `Notes/周计划/年-W周.md`，行内快速添加（☑ 待办 / ≡ 普通内容），排期的目标汇入对应日列；
  顶部显示本周任务完成率。
- **月历**：每格显示日历事件、任务时间块（蜜桃色）、待办与"有笔记"标记；拖入任务即改期；
  双击某天打开每日笔记；日期行均分撑满可用高度。
- **年视图**：12 个迷你月历，蓝点=有笔记、紫点=有事件、蓝色数字=当天有未完成任务，
  点月份进入月视图。
- **日历事件**：支持订阅 ICS（设置 → 日历订阅，填 iCloud/Google 公开日历链接或本地
  `.ics` 文件），支持 RRULE 基本循环展开（DAILY/WEEKLY/MONTHLY/YEARLY）。
- **法定节假日**：日历日期旁**红点**=法定节假日（休）、**蓝点**=调休上班日（节假日只是
  日期提示，不是待办）；月历格与日程头部显示假期名；内置 2024–2026 年官方数据，
  浏览其它年份时自动从 holiday-cn 拉取并缓存（设置里可关闭自动更新）。
- **农历与二十四节气**：月历每格日期下方显示农历日（初一显示月名）、节气（绿色）
  与传统农历节日（红色）；悬浮提示显示完整干支年 + 生肖 + 农历日期；算法覆盖 1900–2100 年。
- 所有日历均以**周日为第一列**（右栏月历、月历、年视图、周计划、周条一致）。

### 任务管理

- `- [ ] 待办` / `- [x] 已完成`（勾选自动追加 `@done(日期)`，取消自动移除）/
  `- [-] 已废弃`（右键任务行 → 标记废弃；废弃任务不进任务统计）；
- **时间粒度**：`>2026-09-05` 排期到某天；`14:00-15:30` 时间段或 `14:00` 单点时间
  （默认占 1 小时）进入右栏当日时间轴与月历时间块；暂不支持跨天；
- **循环任务**：带 `every day / every 2 weeks / 每天 / 每2周` 等标记时，完成即自动
  在下一周期日期的每日笔记中重建；
- **任务提醒**：
  - **每日提醒**：当天到期（排期今天 / 每日笔记隐式今天 / 循环命中今天）、未排期、
    过期未完成的任务，在配置的每日提醒时间（默认 **17:00**）汇总提醒一条；
  - **到期前提醒**：带开始时间的任务在「开始时间 − 提前分钟数」（默认 **15 分钟**，
    可配置 0–240）单独提醒；
  - 触达方式：系统通知 + 应用内 toast（可点击跳转到任务所在行）；已完成 / 废弃任务
    不提醒；每个任务每天最多提醒一次；
  - 配置入口：设置（`Ctrl+,`）→ 任务提醒；配置保存在本机 localStorage（设备级，
    不同步到笔记库）。
- **选中文字快速生成待办**：右键 →「转为待办任务」/「添加为今日待办」；
  `Ctrl+L` 切换当前行（或选区内各行）任务状态；
- **任务总览**：右栏「任务」页签按 今天 / 已过期 / 已排期 / 未排期 / 已完成 分组展示全库
  任务，分组可折叠（状态记忆），点击任务定位到对应行；
- **拖拽排期**：把任务拖到周条 / 月历某天上即完成改期（写入源文件 `>日期`）。

### 其它

- **每日笔记**：`Calendar/YYYY-MM-DD.md`，命令面板 / 周条 / 日历均可直达；
- **双向链接**：`[[笔记标题]]`，右栏「链接」页签显示反向链接；「大纲」页签按标题跳转；
- **命令面板**：`Ctrl+K` 搜笔记、搜全文、执行命令；`#标签` 一键搜索；
- **标签管理**：右键标签云中的标签 → 重命名 / 删除（跨全库改写笔记内容，不可撤销）；
  点击标签搜索；`@提及` 输入补全；
- **主题**：深色 / 浅色 / 跟随系统；笔记内搜索（`Ctrl+F`）；
- **保存与外部修改**：停止输入约 0.8 秒自动保存；笔记被外部改动时**不打断编辑**
  （状态栏弱提示并暂停自动覆盖保存），切换/关闭时才确认；`Ctrl+S` 明确保存；
- **回收站**：删除的笔记进应用内回收站，支持恢复、永久删除、清空，删除 toast 可撤销；
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
:: Tauri v2 版（方案 C），需要 Rust 1.75+ (MSVC) 与 VS2022 Build Tools
cd tauri\src-tauri
cargo tauri dev     :: 开发模式（热重载）
cargo tauri build   :: 产出 NSIS 安装包
```

首次启动出现引导页：**创建示例笔记库**（在 `文档\NotePlan 笔记库` 生成示例内容），
或**选择已有文件夹**。之后在 设置（`Ctrl+,`）里可随时更换笔记库位置。

## 目录结构

```
NotePlan/
├── electron/    方案 A：Electron 实现（main.js / preload.js / src）
├── tauri/       方案 C：Tauri v2 实现（Rust 后端 + 复用 electron/src 前端）
├── scripts/     开发与测试工具（CDP 驱动的截图/调试脚本等，两版通用）
└── README.md
```

两版共用同一套界面代码；`tauri/src` 为主副本，`tauri/sync-frontend.ps1` 负责把它同步到
`electron/src`（并剥离 Tauri 专用桥接脚本）。区别只在宿主（Node 主进程 ↔ Rust 后端）
与 `window.api` 的注入方式（contextBridge ↔ Tauri invoke 桥）。

### 方案 C：Tauri v2 版（Rust 后端，安装包最小）

- 后端：`tauri/src-tauri/src/commands.rs`（`#[tauri::command]` 与 Electron 版逐字段对齐）、
  `lib.rs`（启动 / 原生菜单 / `vault://` 自定义协议 / notify 文件监听 / 系统主题事件）
- 桥接：`window.__TAURI__.core.invoke`（`withGlobalTauri`），事件经 Tauri event system；
  笔记库内图片经 `vault://` 自定义协议由 Rust 读取
- 配置存于 `%LOCALAPPDATA%\NotePlanTauri\config.json`

```bat
cd tauri\src-tauri
cargo tauri dev
cargo tauri build   :: 产出 NSIS 安装包
```

## 常用快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+K` | 命令面板 / 快速打开 / 全文搜索 |
| `Ctrl+Shift+F` | 全库搜索（同面板） |
| `Ctrl+N` | 新建笔记 |
| `Ctrl+J` | 打开今日笔记 |
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

````markdown
# 一级标题
## 二级标题

- [ ] 待办任务，可以安排到某天：>2026-09-05
- [x] 已完成任务（勾选时自动追加 @done(日期)）
- [-] 已废弃任务（不进任务统计）
- [ ] 时间段任务 >2026-09-05 14:00-15:30（进入右栏当日时间轴）
- [ ] 每周循环任务 every week >2026-09-01
  - 嵌套子任务
	> 任务下缩进的引用行会渲染为备注引用块
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
````

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
应用设置：Electron 版在 `%APPDATA%\noteplan-windows\config.json`，Tauri 版在
`%LOCALAPPDATA%\NotePlanTauri\config.json`（笔记库路径、主题、日历订阅等）。

## 打包发行

### 代码签名与 SmartScreen

安装/首次运行时出现「Microsoft Defender SmartScreen 阻止了无法识别的应用启动…
发行者：发布者未知」，原因是安装包**没有代码签名证书**。本仓库是个人学习项目，
未购买商业证书；消除或绕过的方式如下：

**临时绕过（不推荐长期依赖）**

- 在 SmartScreen 弹窗点「更多信息」→「仍要运行」；
- 或右键安装包 → 属性 → 勾选「解除锁定」→ 确定（PowerShell：`Unblock-File .\安装包.exe`）。

**正式签名（购买证书后）**

| 方式 | 大致成本 | 效果 |
| --- | --- | --- |
| OV 代码签名证书（DigiCert / Sectigo / SSL.com 等） | 约 $200+/年 | 显示发行者；SmartScreen 信誉需积累一段时间 |
| EV 代码签名证书 | 约 $300+/年，硬件/云令牌 | 立即获得 SmartScreen 信誉 |
| Azure Trusted Signing（微软官方） | $9.99/月 | 需身份验证（个人/组织），即时信誉 |
| 自签名证书 | 免费 | **不能**消除 SmartScreen 警告，仅适合本机/内网测试 |

拿到证书后，Electron 打包走环境变量即可自动签名（electron-builder 原生支持）：

```bat
set CSC_LINK=D:\certs\codesign.pfx
set CSC_KEY_PASSWORD=证书密码
npm run dist
```

或手动对已产出的 exe 签名（带时间戳，过期后仍有效）：

```bat
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
  /f codesign.pfx /p 证书密码 "NotePlan-for-Windows-Setup-x.y.z.exe"
```

Tauri 侧在 `tauri.conf.json` 的 `bundle.windows` 中配置 `certificateThumbprint`
（证书装入本机证书库后按指纹签名），或打包后用同样的 signtool 命令补签。

### GitHub Actions 自动打包

仓库内置 `.github/workflows/build.yml`：

- **推送到 `main`**：自动构建 Electron 与 Tauri 两个方案，安装包在构建页 Artifacts 下载；
- **推送 `v*` 标签**（`git tag v0.4.3 && git push origin v0.4.3`）：构建后把两个安装包自动
  发布为 GitHub Release；
- **Actions 页面手动触发**：workflow_dispatch 同效。

历史版本安装包见 [Releases](https://github.com/SUMARKER/NotePlan/releases)。

### 版本规范（SemVer）

每次提交按**修改范围**更新版本号（6 处配置统一由脚本修改）：

| 修改范围 | 版本位 | 示例 |
| --- | --- | --- |
| Bug 修复、文案与样式微调，无新功能 | `0.4.1 → 0.4.2`（patch） | 弹窗居中、文案更新 |
| 新功能、界面/交互变化 | `0.4.2 → 0.5.0`（minor） | 新增右栏当日日程 |
| 破坏性变更（数据格式、语法、快捷键不兼容） | `0.4.2 → 1.0.0`（major） | 更改笔记库目录结构 |

操作：

```bat
node scripts\bump-version.js 0.4.3     :: 升版本（同步 6 处配置）
git commit -am "..."                   :: 提交
git tag v0.4.3 && git push origin main --tags   :: 推送后 CI 自动发布该版本 Release
```

未打标签的 main 提交只构建不出 Release；安装包请从 Releases 页或 Actions Artifacts 获取。

本地一键打包（Electron + Tauri，含国内镜像与工作区外输出目录，避免 asar 被索引器锁定）：

```bat
scripts\local-pack.bat
```

### 方案 A：Electron（在 electron/ 下）

```bat
cd electron
npm run dist
```

产出安装目录：

- `NotePlan-for-Windows-Setup-<版本>.exe` — NSIS 安装包（约 77 MB，安装后约 270 MB，x64）
- `win-unpacked/` — 免安装目录

### 方案 C：Tauri v2（在 tauri/src-tauri/ 下）

```bat
cargo tauri build
```

产出 `target/release/bundle/nsis/NotePlan for Windows_<版本>_x64-setup.exe`（NSIS 安装包）。
运行时使用系统内置的 WebView2，无任何运行时依赖。

实测（同机同库）：

| | Electron | Tauri v2 |
| --- | --- | --- |
| 安装包 | 76.6 MB | **2.6 MB** |
| 主程序体积 | — | 9.0 MB |

应用未做代码签名，首次运行 SmartScreen 可能提示，属正常现象。

## 项目结构

```
NotePlan/
├── electron/               方案 A：Electron 实现（独立文件夹）
│   ├── main.js             主进程：文件库/搜索/任务/ICS/文件监听/菜单/vault 协议
│   ├── preload.js          contextBridge 暴露 window.api
│   ├── build.js            esbuild 打包 CodeMirror 扩展 → src/js/cm-bundle.js
│   ├── package.json        含 electron-builder 打包配置
│   └── src/                界面 + 编辑器 + 渲染器（与本目录 assets/ 配套）
├── tauri/                  方案 C：Tauri v2（Rust 后端）
│   ├── src/                前端主副本 + js/api-shim-tauri.js 桥
│   ├── sync-frontend.ps1   把 src 同步到 electron/src（剥离 Tauri 桥）
│   └── src-tauri/
│       ├── commands.rs     #[tauri::command]（与 Electron API 逐字段对齐）
│       └── lib.rs          启动 / 原生菜单 / vault:// 协议 / 文件监听 / 主题事件
├── scripts/                开发/测试工具（两版通用，非实现代码）
│   ├── cdp-eval.js         通过 CDP 在页面里执行 JS
│   ├── cdp-shot.js         通过 CDP 截取整页
│   ├── cdp-shot-clip.js    通过 CDP 截取局部放大图
│   ├── test-markdown.js    渲染器冒烟测试
│   ├── bump-version.js     版本号统一升级（6 处配置）
│   ├── local-pack.bat      本地一键打包（Electron + Tauri）
│   └── gen-icon.js / gen-ico.js  生成应用图标
└── README.md
```

## 路线图（候选）

- [ ] 日程时间轴支持拖拽调整任务时间
- [ ] 拖拽移动笔记到文件夹
- [ ] 多笔记库窗口

## 免责声明

- 本项目为**个人学习性质的非商业开源实现**，与 NotePlan.app 及其开发方
  [Modum B.V.](https://noteplan.co) 无任何隶属、授权或合作关系；NotePlan 名称归其权利人所有。
- 软件按「现状」提供，**不附带任何明示或默示的担保**。作者不对使用本软件造成的任何
  数据丢失、文件损坏、同步冲突或其他直接/间接损失承担责任——你的笔记库是普通文件夹，
  请**定期自行备份**（纳入 Git / 网盘同步均可）。
- 安装包请**仅从本仓库的 GitHub Releases 页面获取**，谨防第三方仿冒分发。
- 应用未做商业代码签名，首次运行可能触发 SmartScreen 提示，见上文
  「代码签名与 SmartScreen」。

## 许可

MIT。

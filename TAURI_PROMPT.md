# Tauri 版 NotePlan for Windows — 实现提示词

> 将以下内容作为完整提示词交给 AI 助手（或作为自查清单自己实现），
> 即可在现有代码库基础上完成 Tauri 版的构建。

---

## 提示词正文

请基于现有代码库实现 NotePlan for Windows 的 Tauri 版本。

### 项目背景

`D:\workspace\NotePlan\` 是一个受 NotePlan 启发的桌面笔记应用，已有两个可运行的实现：

- **Electron 版**（`electron/`）：完整功能，31 项端到端测试全通过
- **WebView2 + .NET 版**（`webview2/`）：C# 宿主 + 同一份前端代码，功能完全一致
- 另有 **WPF + AvalonEdit 原生预览版**（`native-wpf/`，实验性）

三个版本**共用同一份笔记库格式**：`文档\NotePlan 笔记库\` 下的纯 Markdown 文件
（`Calendar/YYYY-MM-DD.md` 为每日笔记，`Notes/` 为普通笔记）。

目标：创建 `tauri/` 目录下的 **Tauri v2 版本**，用 Rust 后端替代 Electron 的 Node 主进程
和 WebView2 的 C# 宿主，前端代码从现有 `electron/src/` 复用并做最小适配。
相比 Electron（安装包 76.6 MB / 内存 ~256 MB），Tauri 版预期安装包 < 10 MB、内存 < 150 MB。

### 前置要求

- Rust 1.75+（MSVC target）
- Visual Studio Build Tools 2022（含 C++ 桌面开发工作负载）
- Node.js ≥ 18 + `@tauri-apps/cli`
- WebView2 运行时（Win10/11 通常已内置）

### 现有代码库——必须复用的文件

```
electron/src/               ← 前端渲染层，复制到 tauri/src/ 使用
├── index.html              入口页（三栏布局 + 命令面板 + 弹窗 + 引导页）
├── css/app.css             主题样式（浅色/深色 + CodeMirror 配色）
├── editor-src/main.js      CodeMirror 6 扩展（需 esbuild 打包为 js/cm-bundle.js）
└── js/
    ├── cm-bundle.js        CodeMirror 打包产物（已提交，无需重新构建）
    ├── errtrap.js          错误陷阱
    ├── markdown.js         NotePlan 风格 Markdown 渲染器（纯 JS，零依赖）
    ├── editor.js           textarea 兜底编辑行为
    └── app.js              主控制器（侧栏/日历/月历/回收站/命令面板/状态管理）
```

**关键约束**：`app.js` 通过 `window.api` 调用后端，通过 `window.__np` / `window.__edApi`
暴露调试钩子。Tauri 版需要提供一个 `api-shim-tauri.js` 脚本在 Tauri 环境中实现相同的
`window.api` 接口（使用 `window.__TAURI__.core.invoke` 或 `@tauri-apps/api` 的 `invoke`），
使 `app.js` 无需任何修改即可工作。

### 后端必须实现的完整 API 列表

以下每个方法对应一个 `#[tauri::command]`，返回 `Result<Value, String>`。
前端 `api-shim-tauri.js` 通过 `invoke(method_name, args)` 调用。

#### 设置
```
get_settings() -> {vaultPath, theme, lastNote, sidebarView, calendars, vaultExists}
set_settings(patch: HashMap<String, Value>) -> settings_snapshot
```
- 配置持久化到 `%LOCALAPPDATA%\NotePlanTauri\config.json`
- `vaultExists` 是计算字段（vaultPath 目录存在 = true），不存储

#### 笔记库
```
open_vault(dir: String, create_sample: bool) -> {ok}
get_vault_path() -> String
default_vault_path() -> String   // "%USERPROFILE%\Documents\NotePlan 笔记库"
```
- `create_sample = true` 时在目标目录生成示例文件（Calendar/今日.md、Notes/欢迎使用.md 等）

#### 笔记 CRUD
```
list_notes() -> [{rel, name, md, mtimeMs, size, title}]
read_note(rel) -> {ok, content, mtimeMs}
write_note(rel, content) -> {ok, mtimeMs}
create_note(folder, title, content: Option<String>) -> {ok, rel}
rename_note(rel, new_name) -> {ok, rel}
move_note(rel, dest_folder) -> {ok, rel}
open_daily(date_str) -> {ok, rel}   // date_str = "YYYY-MM-DD"
```
- 所有路径必须通过 safe_resolve 校验（防止路径穿越）
- `list_notes` 递归扫描 vault，跳过 `.trash/`、`.git/`、隐藏文件
- `title` 从文件内容第一个非空行的 `# 标题` 提取
- `create_note` 遇到同名文件自动加后缀 " 2"、" 3"…

#### 搜索
```
search(q) -> [{rel, name, line, text}]           // 全文搜索，最多 200 条
backlinks(title) -> [{rel, name, line, text}]     // 查找包含 [[title]] 或 [[title| 的行
scheduled_tasks(date) -> [{rel, name, line, text, done}]  // 查找包含 ">date" 的任务行
```

#### 任务
```
tasks_all() -> [{rel, name, title, line, text, done, doneDate, scheduled, start, end, recurring}]
reschedule_task(rel, line, new_date, time: Option<{start, end}>) -> {ok}
daily_append(date_str, line_text) -> {ok, rel}
```
- 任务行正则：`^\s*[-*+]\s+\[([ xX])\]\s*(.*)$`
- 完成标记：`@done(YYYY-MM-DD)` 或 `@done`
- 排期标记：`>YYYY-MM-DD`
- 时间块：`HH:MM-HH:MM`
- 循环：`every day/week/month/year`、`every N days/weeks`、`每天/每周/每N天`

#### 标签
```
list_tags() -> {tags: [{tag, count}], mentions: [{name, count}]}
```
- 提及排除 `@done`、`@due` 等功能标记
- 行内代码（含反引号）里的 `#` 不算标签

#### 回收站
```
trash_note(rel) -> {ok, trashId}
trash_folder(rel) -> {ok}
trash_list() -> [{id, name, origRel, deletedAt, type}]
trash_restore(id) -> {ok, rel}
trash_purge(id) -> {ok}
trash_empty() -> {ok}
```
- 移入笔记库 `.trash/items/` 目录（扫描时跳过 `.trash/`）
- 索引存 `.trash/index.json`（`{items: [{id, name, origRel, deletedAt, type, store}]}`）
- 恢复时如原路径被占自动加 " (2)" 后缀
- 永久删除 = `fs::remove_file/dir_all`

#### 日历事件（ICS 订阅）
```
cal_events(range_start, range_end) -> [{date, startHM, endHM, allDay, title, loc, cal}]
```
- 支持 URL 订阅（30 分钟内存缓存）和本地 `.ics` 文件
- 解析 VEVENT：DTSTART/DTEND（含 VALUE=DATE 和 UTC Z 后缀）、SUMMARY、LOCATION
- RRULE 基本展开：FREQ=DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL + COUNT + UNTIL

#### 系统
```
open_path(rel)          // 系统默认程序打开文件
show_in_folder()        // 资源管理器打开笔记库
open_external(url)      // 系统默认浏览器打开 URL
```

### 前端适配

1. 复制 `electron/src/` → `tauri/src/`（全部文件）
2. 新建 `tauri/src/js/api-shim-tauri.js`（在 index.html 中排在 errtrap.js 之前）：

```js
// 如果 window.api 已存在（Electron preload），跳过
if (!window.api && window.__TAURI__) {
  const { invoke } = window.__TAURI__.core;
  let seq = 0;
  const api = {};
  const METHODS = [/* 同 preload.js 中的所有方法名 */];
  for (const m of METHODS) {
    api[m] = (...args) => invoke(m, { args });
  }
  api.flushSaveNow = (rel, content) => invoke('write_note', { args: [rel, content] });
  // 事件通过 Tauri 的 event system
  api.onVaultChanged = (cb) => window.__TAURI__.event.listen('vault:changed', cb);
  api.onThemeChanged = (cb) => window.__TAURI__.event.listen('theme:changed', cb);
  api.onMenu = (name, cb) => window.__TAURI__.event.listen('menu:' + name, cb);
  window.api = api;
}
```

3. `app.js` 需要确认 `window.api` 的调用签名与 Rust 命令参数名匹配
   （Tauri invoke 默认将 JS camelCase 参数映射到 Rust snake_case 参数）

### Rust 依赖

```toml
[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = "0.4"
walkdir = "2"
regex = "1"
```

### 注意事项

- 所有文件路径必须经过 safe_resolve 校验（canonicalize 后必须以 vault 根目录开头）
- `.trash/`、`.git/`、隐藏文件在扫描时跳过
- mtimeMs = Unix 毫秒时间戳
- vault 路径在 app 启动时从 config.json 恢复（等价于 Electron 版启动时的 setVault 恢复）
- 删除 = 移入 `.trash/items/`（不是系统回收站）
- 永久删除 = `fs::remove_file` / `fs::remove_dir_all`
- 文件监听：使用 `notify` crate（v6）或 Tauri 内置的 fs watcher，350ms 防抖
- 编辑器在打开笔记时设置 `suppressDirty = true` 避免 setDoc 触发脏标记
- 任务行解析正则：`^\s*[-*+]\s+\[([ xX])\]\s*(.*)$`

### 测试

现有 `scripts/test-functions.js`（31 项端到端测试）通过 CDP 连接页面运行。
Tauri 版可通过设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
环境变量启用 CDP，复用同一套测试脚本。

### 构建命令

```bash
# 开发模式（带热重载）
cargo tauri dev

# 生产构建（产出 NSIS 安装包）
cargo tauri build

# 仅编译 Rust（快速检查编译错误）
cd src-tauri && cargo build
```

---

以上为完整提示词。核心思路：**Rust 后端实现全部数据操作，前端代码从 Electron 版复制并
通过 api-shim 桥接**，使三个版本（Electron / WebView2 / Tauri）共用同一套 UI 代码。

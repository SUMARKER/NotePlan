'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, protocol, net, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/* 全局状态                                                            */
/* ------------------------------------------------------------------ */

let mainWindow = null;

let vaultPath = null;          // 当前笔记库根目录（绝对路径）
let watcher = null;            // fs.watch 实例
let watchDebounce = null;
// 记录本应用自己写入的文件 (absPath -> mtimeMs)，用于忽略自身触发的变更事件
const selfWrites = new Map();
const SELF_WRITE_TTL = 2500;

const CAL_DIR = 'Calendar';
const NOTE_DIR = 'Notes';
const TRASH_DIR_REL = '.trash';
const TRASH_INDEX_REL = '.trash/index.json';

/* ------------------------------------------------------------------ */
/* 设置持久化                                                          */
/* ------------------------------------------------------------------ */

function settingsFile() {
  return path.join(app.getPath('userData'), 'config.json');
}

let settings = {
  vaultPath: null,
  theme: 'auto',        // 'auto' | 'light' | 'dark'
  lastNote: null,       // 相对路径
  sidebarView: 'calendar', // 'calendar' | 'notes'
  calendars: [],        // ICS 日历源：[{src}]，src 为 URL 或 .ics 文件路径
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    Object.assign(settings, JSON.parse(raw));
  } catch (_) { /* 首次运行没有配置文件 */ }
}

function saveSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('保存设置失败:', err);
  }
}

/* ------------------------------------------------------------------ */
/* 路径安全工具                                                        */
/* ------------------------------------------------------------------ */

/** 把相对路径解析到笔记库内，防止越界访问（.. 等），失败返回 null */
function safeResolve(rel) {
  if (!vaultPath || typeof rel !== 'string' || rel.length === 0) return null;
  const abs = path.resolve(vaultPath, rel);
  const root = path.resolve(vaultPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function toRel(abs) {
  return path.relative(vaultPath, abs).split(path.sep).join('/');
}

function isMarkdown(name) {
  return /\.(md|markdown|txt)$/i.test(name);
}

/* ------------------------------------------------------------------ */
/* 笔记库扫描                                                          */
/* ------------------------------------------------------------------ */

/** 递归遍历笔记库，返回全部文件的元信息（跳过隐藏目录/文件与常见垃圾目录） */
async function scanVault() {
  if (!vaultPath) return [];
  const out = [];
  const SKIP = new Set(['.git', '.obsidian', '.trash', 'node_modules', '$RECYCLE.BIN', 'System Volume Information', '.DS_Store', 'desktop.ini']);

  async function walk(dir, relBase) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || SKIP.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const rel = relBase ? relBase + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        await walk(abs, rel);
      } else if (ent.isFile()) {
        let st = null;
        try { st = await fsp.stat(abs); } catch (_) { continue; }
        out.push({ rel, name: ent.name, md: isMarkdown(ent.name), mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  }

  await walk(vaultPath, '');
  out.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hans-CN'));
  return out;
}

/** 遍历所有子文件夹（不含根与隐藏目录），用于把空文件夹也展示到笔记树 */
async function scanDirs() {
  if (!vaultPath) return [];
  const out = [];
  const SKIP = new Set(['.git', '.obsidian', '.trash', 'node_modules', '$RECYCLE.BIN', 'System Volume Information', '.DS_Store', 'desktop.ini']);

  async function walk(dir, relBase) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || SKIP.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const rel = relBase ? relBase + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        out.push({ rel, name: ent.name });
        await walk(abs, rel);
      }
    }
  }

  await walk(vaultPath, '');
  return out;
}

/** 读取文件开头若干字节，提取第一个 `# 标题` 作为显示标题 */
function extractTitle(content) {
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
    // 首个非空行不是标题就停止，避免把正文当标题
    return null;
  }
  return null;
}

/** 内容是否只有开头一个 `# 标题` 行加空白（只是点开过、没写过内容的空笔记） */
function isEmptyNote(content) {
  let seenHeading = false;
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!seenHeading) {
      if (!t) continue;
      if (/^#\s/.test(t)) { seenHeading = true; continue; }
      return false;
    }
    if (t) return false;
  }
  return true;
}

async function readHead(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.slice(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/* ------------------------------------------------------------------ */
/* 文件监听                                                           */
/* ------------------------------------------------------------------ */

function startWatching() {
  stopWatching();
  if (!vaultPath) return;
  try {
    watcher = fs.watch(vaultPath, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) { scheduleVaultChanged(); return; }
      const abs = path.resolve(vaultPath, filename);
      const recorded = selfWrites.get(abs);
      if (recorded !== undefined) {
        let mtime = 0;
        try { mtime = fs.statSync(abs).mtimeMs; } catch (_) { return scheduleVaultChanged(); }
        if (Math.abs(mtime - recorded) < 2) { // 自己的写入，忽略
          selfWrites.delete(abs);
          return;
        }
        selfWrites.delete(abs);
      }
      scheduleVaultChanged();
    });
  } catch (err) {
    console.error('启动文件监听失败:', err);
  }
}

function stopWatching() {
  if (watcher) { try { watcher.close(); } catch (_) {} watcher = null; }
  if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = null; }
}

function scheduleVaultChanged() {
  if (watchDebounce) clearTimeout(watchDebounce);
  watchDebounce = setTimeout(() => {
    watchDebounce = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vault:changed');
    }
  }, 350);
}

function markSelfWrite(abs) {
  try {
    selfWrites.set(path.resolve(abs), fs.statSync(abs).mtimeMs);
    if (selfWrites.size > 200) {
      // Map 保持插入顺序，超限时丢弃最早的一半记录
      let n = Math.floor(selfWrites.size / 2);
      for (const k of selfWrites.keys()) {
        selfWrites.delete(k);
        if (--n <= 0) break;
      }
    }
  } catch (_) { /* 写入失败时无需记录 */ }
}

/* ------------------------------------------------------------------ */
/* 笔记库初始化 / 示例内容                                             */
/* ------------------------------------------------------------------ */

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const SAMPLE_WELCOME = `# 欢迎使用 NotePlan for Windows

这是一款受 [NotePlan](https://noteplan.co) 启发的桌面笔记应用。你的所有笔记都是**磁盘上的纯 Markdown 文件**，随时可以用其它编辑器打开，也方便放入 OneDrive / Dropbox / Git 等同步盘。

## 核心概念

- **每日笔记**：侧边栏的日历里，每一天都有一篇笔记，用来记录当天的事项。
- **普通笔记**：存放在 \`Notes\` 文件夹（支持子文件夹）。
- **双向链接**：输入 \`[[笔记标题]]\` 即可链接到另一篇笔记，右侧"反向链接"面板会显示谁引用了它。
- **任务**：用 \`- [ ] 待办事项\` 创建任务，点击预览中的复选框即可打钩。

## 试试这些语法（在预览中查看效果）

- [ ] 这是一个未完成任务，可以安排到某天：>2026-09-01
- [x] 这是一个已完成任务
- 这是一个普通列表项，包含一个标签 #示例 和一次提及 @我自己
- 用 \`[[欢迎使用 NotePlan for Windows]]\` 链接回本篇
- ==高亮文本==、**加粗**、*斜体*、\`行内代码\`、~~删除线~~

> 引用块：笔记的最终目的是行动。

\`\`\`js
// 代码块
console.log('Hello, NotePlan for Windows!');
\`\`\`

## 常用快捷键

| 快捷键 | 功能 |
| --- | --- |
| Ctrl+K | 命令面板 / 快速打开 |
| Ctrl+N | 新建笔记 |
| Ctrl+J | 打开今日笔记 |
| Ctrl+E | 切换 编辑 / 预览 / 分栏 |
| Ctrl+L | 勾选 / 取消当前行任务 |
| Ctrl+S | 立即保存（平时会自动保存） |
| Ctrl+Shift+F | 全库搜索 |

打开左侧 [[使用技巧]] 了解更多。
`;

const SAMPLE_TIPS = `# 使用技巧

## 每日笔记
- 按 \`Ctrl+J\` 或点击侧边栏日历中的日期，即可打开/创建当天的笔记。
- 在任意笔记里写 \`>2026-09-01\`（日期可变），这条任务就会出现在那一天的每日笔记预览的"来自其它笔记"区域。

## 任务管理
- 任务语法：\`- [ ] 买东西\`，完成后在预览中点复选框，或编辑器里按 \`Ctrl+L\`。
- 可以给任务加日期、标签：\`- [ ] 交房租 >2026-10-01 #生活\`。

## 双向链接
- \`[[标题]]\` 创建链接；标题不存在时，点击链接会自动创建那篇笔记。
- 每篇笔记右侧的"反向链接"面板列出所有引用它的位置。

## 文件即数据
- 笔记库就是一个普通文件夹，\`Calendar\` 里是每日笔记，\`Notes\` 里是普通笔记。
- 设置里可以随时更换笔记库位置；把文件夹放进同步盘即可多设备同步。

## 小贴士
- 命令面板 \`Ctrl+K\` 几乎能到达任何地方：搜笔记、执行命令。
- #标签 可以点击，点击后即进入全库搜索。
`;

const SAMPLE_PROJECT = `# 示例项目：整理书房

状态：进行中 #项目

## 待办

- [ ] 清点书架上的书 >2026-09-05
- [ ] 处理不要的书（二手出售 / 捐赠）
- [ ] 买两个收纳盒 #购物
- [x] 拍照记录整理前的样子

## 想法

- 参考 [[使用技巧]] 里的任务语法，把截止日期写在任务后面。

相关每日笔记：[[2026-09-01]]
`;

function createSampleVault(root) {
  fs.mkdirSync(path.join(root, NOTE_DIR), { recursive: true });
  fs.mkdirSync(path.join(root, CAL_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, NOTE_DIR, '欢迎使用 NotePlan for Windows.md'), SAMPLE_WELCOME, 'utf8');
  fs.writeFileSync(path.join(root, NOTE_DIR, '使用技巧.md'), SAMPLE_TIPS, 'utf8');
  const projDir = path.join(root, NOTE_DIR, '项目');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, '示例项目：整理书房.md'), SAMPLE_PROJECT, 'utf8');
  const today = path.join(root, CAL_DIR, todayStr() + '.md');
  if (!fs.existsSync(today)) {
    fs.writeFileSync(today, `# ${todayStr()}\n\n`, 'utf8');
  }
}

async function setVault(newPath, { createSampleIfEmpty = false } = {}) {
  vaultPath = newPath;
  settings.vaultPath = newPath;
  settings.lastNote = null;
  saveSettings();
  if (createSampleIfEmpty) createSampleVault(newPath);
  startWatching();
}

/* ------------------------------------------------------------------ */
/* 任务行解析（主进程侧；渲染端 editor-src 有对应正则，注意同步）        */
/* ------------------------------------------------------------------ */

const RE_TASK_LINE = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/;
const RE_DONE_TAG = /\s*@done(?:\(([^)]*)\))?/i;
const RE_SCHEDULE_IN = />\s*(\d{4}-\d{2}-\d{2})/;
// 连续任务：>起 ~ 止（分隔符支持 ~ – — 至 到）
const RE_SCHEDULE_RANGE = />\s*(\d{4}-\d{2}-\d{2})\s*(?:~|–|—|至|到)\s*(\d{4}-\d{2}-\d{2})/;
const RE_TIME_RANGE = /(\d{1,2}:\d{2})\s*(?:-|–|—|~|至|到)\s*(\d{1,2}:\d{2})/;
const RE_RECURRENCE = /\b(?:every\s+(?:(\d+)\s+)?(day|week|month|year)s?)\b|\b每(?:天|日|周|星期|月|年)\b|\b每\s*(\d+)\s*(?:天|周|星期|月|年)\b/i;

function normHM(s) {
  const [h, m] = s.split(':').map(Number);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function addHour(hm) {
  const [h, m] = hm.split(':').map(Number);
  return `${String(Math.min(23, h + 1)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseTaskLine(raw) {
  const m = raw.match(RE_TASK_LINE);
  if (!m) return null;
  const text = m[2];
  const doneMark = m[1] !== ' ' || RE_DONE_TAG.test(text);
  const doneDateM = text.match(RE_DONE_TAG);
  const rangeM = text.match(RE_SCHEDULE_RANGE);
  const schedM = rangeM ? null : text.match(RE_SCHEDULE_IN);
  const timeM = text.match(RE_TIME_RANGE);
  const recM = text.match(RE_RECURRENCE);
  return {
    done: doneMark,
    doneDate: doneDateM ? (doneDateM[1] || null) : null,
    scheduled: rangeM ? rangeM[1] : (schedM ? schedM[1] : null),
    endDate: rangeM ? rangeM[2] : null,
    start: timeM ? normHM(timeM[1]) : null,
    end: timeM ? normHM(timeM[2]) : null,
    recurring: !!recM,
    body: text,
  };
}

/* ------------------------------------------------------------------ */
/* 唯一文件名                                                          */
/* ------------------------------------------------------------------ */

function sanitizeName(name) {
  let n = String(name || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '').trim();
  return n.slice(0, 120);
}

async function uniquePath(dirAbs, base, ext) {
  let candidate = path.join(dirAbs, base + ext);
  let i = 1;
  // 若同名文件就是"无标题笔记"占位，允许复用
  while (fs.existsSync(candidate)) {
    i += 1;
    candidate = path.join(dirAbs, `${base} ${i}${ext}`);
  }
  return candidate;
}

/* ------------------------------------------------------------------ */
/* IPC 处理                                                            */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('settings:get', () => ({ ...settings, vaultExists: !!(settings.vaultPath && fs.existsSync(settings.vaultPath)) }));

  ipcMain.handle('settings:set', (_e, patch) => {
    const allowed = ['theme', 'lastNote', 'sidebarView', 'calendars'];
    for (const k of allowed) if (k in patch) settings[k] = patch[k];
    if ('theme' in patch) applyTheme();
    saveSettings();
    return { ...settings };
  });

  ipcMain.handle('vault:choose', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择笔记库文件夹',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.vaultPath || app.getPath('documents'),
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('vault:open', async (_e, dirPath, createSampleIfEmpty) => {
    try {
      // 目录不存在则创建（"创建示例笔记库"的目标路径是全新的）
      await fsp.mkdir(dirPath, { recursive: true });
      const stat = await fsp.stat(dirPath);
      if (!stat.isDirectory()) return { ok: false, error: '所选路径不是文件夹' };
      await setVault(dirPath, { createSampleIfEmpty: !!createSampleIfEmpty });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('vault:path', () => vaultPath);

  ipcMain.handle('notes:list', async () => {
    const files = await scanVault();
    const notes = [];
    for (const f of files) {
      if (!f.md) { notes.push({ rel: f.rel, name: f.name, md: false, mtimeMs: f.mtimeMs, size: f.size, title: null, empty: false }); continue; }
      let title = null;
      let empty = false;
      try {
        const head = await readHead(safeResolve(f.rel));
        title = extractTitle(head);
        empty = isEmptyNote(head);
      } catch (_) {}
      notes.push({ rel: f.rel, name: f.name, md: true, mtimeMs: f.mtimeMs, size: f.size, title, empty });
    }
    // 空文件夹也返回（md:false + dir:true），否则「＋文件夹」后笔记树看不到它
    try {
      for (const d of await scanDirs()) {
        notes.push({ rel: d.rel, name: d.name, md: false, dir: true, mtimeMs: 0, size: 0, title: null, empty: true });
      }
    } catch (_) {}
    return { vaultPath, notes };
  });

  ipcMain.handle('note:read', async (_e, rel) => {
    const abs = safeResolve(rel);
    if (!abs) return { ok: false, error: '非法路径' };
    try {
      const [content, st] = await Promise.all([fsp.readFile(abs, 'utf8'), fsp.stat(abs)]);
      return { ok: true, content, mtimeMs: st.mtimeMs };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('note:write', async (_e, rel, content) => {
    const abs = safeResolve(rel);
    if (!abs) return { ok: false, error: '非法路径' };
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf8');
      markSelfWrite(abs);
      return { ok: true, mtimeMs: (await fsp.stat(abs)).mtimeMs };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('note:create', async (_e, folder, title, content) => {
    if (!vaultPath) return { ok: false, error: '未设置笔记库' };
    const clean = sanitizeName(title) || '无标题笔记';
    const dirAbs = safeResolve(folder || NOTE_DIR);
    if (!dirAbs) return { ok: false, error: '非法文件夹' };
    try {
      fs.mkdirSync(dirAbs, { recursive: true });
      const abs = await uniquePath(dirAbs, clean, '.md');
      const body = content != null ? content : `# ${clean}\n\n`;
      fs.writeFileSync(abs, body, 'utf8');
      markSelfWrite(abs);
      return { ok: true, rel: toRel(abs) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('note:daily', async (_e, dateStr) => {
    if (!vaultPath) return { ok: false, error: '未设置笔记库' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return { ok: false, error: '日期格式错误' };
    const rel = `${CAL_DIR}/${dateStr}.md`;
    const abs = safeResolve(rel);
    try {
      if (!fs.existsSync(abs)) {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        // 不再写入默认的 `# 日期` 标题：日期已由界面（面包屑/周数行/右栏）展示
        await fsp.writeFile(abs, '', 'utf8');
      }
      markSelfWrite(abs);
      return { ok: true, rel };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('note:rename', async (_e, rel, newName) => {
    const abs = safeResolve(rel);
    if (!abs) return { ok: false, error: '非法路径' };
    const clean = sanitizeName(newName);
    if (!clean) return { ok: false, error: '名称不能为空' };
    const ext = path.extname(abs) || '.md';
    const absNew = await uniquePath(path.dirname(abs), clean, ext);
    try {
      await fsp.rename(abs, absNew);
      markSelfWrite(absNew);
      if (settings.lastNote === rel) { settings.lastNote = toRel(absNew); saveSettings(); }
      return { ok: true, rel: toRel(absNew) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  /* ---------------- 应用内回收站 ---------------- */

  const trashIndexPath = () => safeResolve(TRASH_INDEX_REL);
  const trashItemsDir = () => safeResolve(TRASH_DIR_REL + '/items');

  async function readTrashIndex() {
    const p = trashIndexPath();
    if (!p || !fs.existsSync(p)) return { items: [] };
    try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return { items: [] }; }
  }
  async function writeTrashIndex(index) {
    const p = trashIndexPath();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, JSON.stringify(index, null, 2), 'utf8');
    markSelfWrite(p);
  }

  async function moveToTrash(rel, type) {
    if (!vaultPath) return { ok: false, error: '未设置笔记库' };
    const abs = safeResolve(rel);
    if (!abs || !fs.existsSync(abs)) return { ok: false, error: '文件不存在' };
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const itemsDir = trashItemsDir();
    await fsp.mkdir(itemsDir, { recursive: true });
    const storeName = type === 'dir' ? id : id + path.extname(abs);
    await fsp.rename(abs, path.join(itemsDir, storeName));
    const index = await readTrashIndex();
    index.items.push({
      id,
      name: path.basename(abs),
      origRel: rel,
      deletedAt: new Date().toISOString(),
      type,
      store: storeName,
    });
    await writeTrashIndex(index);
    return { ok: true, trashId: id };
  }

  ipcMain.handle('note:trash', async (_e, rel) => {
    const r = await moveToTrash(rel, 'file');
    if (r.ok && settings.lastNote === rel) { settings.lastNote = null; saveSettings(); }
    return r;
  });

  ipcMain.handle('trash:list', async () => {
    const index = await readTrashIndex();
    const itemsDir = trashItemsDir();
    const items = [];
    for (const it of index.items) {
      if (!fs.existsSync(path.join(itemsDir, it.store))) continue;
      items.push({ id: it.id, name: it.name, origRel: it.origRel, deletedAt: it.deletedAt, type: it.type });
    }
    return items.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  });

  ipcMain.handle('trash:restore', async (_e, id) => {
    const index = await readTrashIndex();
    const it = index.items.find(x => x.id === id);
    if (!it) return { ok: false, error: '记录不存在' };
    const storeAbs = path.join(trashItemsDir(), it.store);
    if (!fs.existsSync(storeAbs)) return { ok: false, error: '内容已丢失' };
    const target = safeResolve(it.origRel);
    if (!target) return { ok: false, error: '原始路径非法' };
    let finalTarget = target;
    if (fs.existsSync(finalTarget)) {
      const ext = it.type === 'dir' ? '' : path.extname(target);
      const baseName = it.type === 'dir' ? path.basename(target) : path.basename(target, path.extname(target));
      let n = 2;
      do { finalTarget = path.join(path.dirname(target), baseName + ' (' + n + ')' + ext); n++; } while (fs.existsSync(finalTarget));
    }
    await fsp.mkdir(path.dirname(finalTarget), { recursive: true });
    await fsp.rename(storeAbs, finalTarget);
    index.items = index.items.filter(x => x.id !== id);
    await writeTrashIndex(index);
    return { ok: true, rel: toRel(finalTarget) };
  });

  ipcMain.handle('trash:purge', async (_e, id) => {
    const index = await readTrashIndex();
    const it = index.items.find(x => x.id === id);
    if (!it) return { ok: false, error: '记录不存在' };
    await fsp.rm(path.join(trashItemsDir(), it.store), { recursive: true, force: true });
    index.items = index.items.filter(x => x.id !== id);
    await writeTrashIndex(index);
    return { ok: true };
  });

  ipcMain.handle('trash:empty', async () => {
    const index = await readTrashIndex();
    const itemsDir = trashItemsDir();
    for (const it of index.items) {
      await fsp.rm(path.join(itemsDir, it.store), { recursive: true, force: true });
    }
    index.items = [];
    await writeTrashIndex(index);
    return { ok: true };
  });

  ipcMain.handle('note:move', async (_e, rel, destFolder) => {
    const abs = safeResolve(rel);
    const dirAbs = safeResolve(destFolder);
    if (!abs || !dirAbs) return { ok: false, error: '非法路径' };
    try {
      fs.mkdirSync(dirAbs, { recursive: true });
      const absNew = await uniquePath(dirAbs, path.basename(abs, path.extname(abs)), path.extname(abs));
      await fsp.rename(abs, absNew);
      markSelfWrite(absNew);
      if (settings.lastNote === rel) { settings.lastNote = toRel(absNew); saveSettings(); }
      return { ok: true, rel: toRel(absNew) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('folder:create', async (_e, parentRel, name) => {
    if (!vaultPath) return { ok: false, error: '未设置笔记库' };
    const parent = safeResolve(parentRel || NOTE_DIR);
    if (!parent) return { ok: false, error: '非法路径' };
    const clean = sanitizeName(name);
    if (!clean) return { ok: false, error: '名称不能为空' };
    const abs = path.join(parent, clean);
    try {
      fs.mkdirSync(abs, { recursive: true });
      return { ok: true, rel: toRel(abs) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('folder:trash', async (_e, rel) => {
    if (!vaultPath) return { ok: false, error: '未设置笔记库' };
    const abs = safeResolve(rel);
    if (!abs || abs === path.resolve(vaultPath)) return { ok: false, error: '非法路径' };
    return moveToTrash(rel, 'dir');
  });

  /* ---------------- 搜索 ---------------- */

  ipcMain.handle('search:query', async (_e, query) => {
    if (!vaultPath) return [];
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const files = (await scanVault()).filter((f) => f.md);
    const results = [];
    for (const f of files) {
      let content = '';
      try { content = await fsp.readFile(safeResolve(f.rel), 'utf8'); } catch (_) { continue; }
      const lines = content.split(/\r?\n/);
      let hits = 0;
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].toLowerCase().indexOf(q);
        if (idx === -1) continue;
        hits += 1;
        if (results.length < 300 && hits <= 5) {
          results.push({ rel: f.rel, name: f.name, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
    }
    return results;
  });

  ipcMain.handle('search:backlinks', async (_e, title) => {
    if (!vaultPath || !title) return [];
    const needle = `[[${String(title).trim()}]]`.toLowerCase();
    const files = (await scanVault()).filter((f) => f.md);
    const results = [];
    for (const f of files) {
      let content = '';
      try { content = await fsp.readFile(safeResolve(f.rel), 'utf8'); } catch (_) { continue; }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const low = lines[i].toLowerCase();
        const p1 = low.indexOf(needle);
        // 也匹配 [[标题|别名]] 形式
        const p2 = low.indexOf(`[[${String(title).trim()}|`.toLowerCase());
        if (p1 === -1 && p2 === -1) continue;
        results.push({ rel: f.rel, name: f.name, line: i + 1, text: lines[i].trim().slice(0, 200) });
        break; // 每个文件只列一条
      }
    }
    return results;
  });

  ipcMain.handle('search:scheduled', async (_e, dateStr) => {
    if (!vaultPath || !dateStr) return [];
    const files = (await scanVault()).filter((f) => f.md);
    const out = [];
    for (const f of files) {
      if (f.rel.startsWith(CAL_DIR + '/')) continue; // 每日本身不重复抓取
      let content = '';
      try { content = await fsp.readFile(safeResolve(f.rel), 'utf8'); } catch (_) { continue; }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t.includes('>')) continue;
        const p = parseTaskLine(t);
        if (!p) continue;
        // 连续任务：日期落在区间内即算覆盖；普通任务：排期日等于该日
        let covers = false;
        if (p.scheduled) {
          covers = p.endDate ? (p.scheduled <= dateStr && dateStr <= p.endDate) : p.scheduled === dateStr;
        }
        if (!covers) continue;
        out.push({ rel: f.rel, name: f.name, line: i + 1, text: t.slice(0, 240), done: p.done, endDate: p.endDate });
      }
    }
    return out;
  });

  /* ---------------- 任务总览 / 排期 / 循环任务 ---------------- */

  // 全库任务索引：供"任务"面板与周视图使用
  ipcMain.handle('tasks:all', async () => {
    if (!vaultPath) return [];
    const files = (await scanVault()).filter((f) => f.md);
    const out = [];
    for (const f of files) {
      let content = '';
      try { content = await fsp.readFile(safeResolve(f.rel), 'utf8'); } catch (_) { continue; }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t.startsWith('- [') && !/^\s*[-*+]\s+\[/.test(lines[i])) continue;
        const p = parseTaskLine(t);
        if (!p) continue;
        out.push({
          rel: f.rel,
          name: f.name,
          title: extractTitle(await readHead(safeResolve(f.rel)).catch(() => '')) || f.name.replace(/\.(md|markdown|txt)$/i, ''),
          line: i + 1,
          text: t.slice(0, 240),
          done: p.done,
          doneDate: p.doneDate,
          scheduled: p.scheduled,
          endDate: p.endDate,
          start: p.start,
          end: p.end,
          recurring: p.recurring,
        });
      }
    }
    return out;
  });

  // 把某文件第 line 行任务改期/改时间
  // time: {start:'14:00', end?:'15:00'} 设置时间块；{clear:true} 清除；null 不动时间
  ipcMain.handle('task:reschedule', async (_e, rel, line, newDate, time) => {
    const abs = safeResolve(rel);
    if (!abs || !/^\d{4}-\d{2}-\d{2}$/.test(String(newDate || ''))) return { ok: false, error: '参数错误' };
    try {
      const content = await fsp.readFile(abs, 'utf8');
      const lines = content.split(/\r?\n/);
      const idx = line - 1;
      if (idx < 0 || idx >= lines.length) return { ok: false, error: '行号越界' };
      if (!parseTaskLine(lines[idx])) return { ok: false, error: '该行不是任务' };
      let l = lines[idx];
      const rangeM = l.match(RE_SCHEDULE_RANGE);
      if (rangeM) {
        // 连续任务：改期时整个区间平移
        if (rangeM[1] !== newDate) {
          const msDay = 86400000;
          const oldStart = Date.UTC(+rangeM[1].slice(0, 4), +rangeM[1].slice(5, 7) - 1, +rangeM[1].slice(8, 10));
          const oldEnd = Date.UTC(+rangeM[2].slice(0, 4), +rangeM[2].slice(5, 7) - 1, +rangeM[2].slice(8, 10));
          const newStart = Date.UTC(+newDate.slice(0, 4), +newDate.slice(5, 7) - 1, +newDate.slice(8, 10));
          const newEnd = new Date(oldEnd + (newStart - oldStart));
          const pad = (n) => String(n).padStart(2, '0');
          const endStr = `${newEnd.getUTCFullYear()}-${pad(newEnd.getUTCMonth() + 1)}-${pad(newEnd.getUTCDate())}`;
          l = l.replace(RE_SCHEDULE_RANGE, `>${newDate} ~ ${endStr}`);
        }
      } else if (RE_SCHEDULE_IN.test(l)) {
        l = l.replace(RE_SCHEDULE_IN, `>${newDate}`);
      } else {
        l = l.replace(/\s+$/, '') + ` >${newDate}`;
      }
      if (time && time.start) {
        const s = normHM(String(time.start));
        const e = time.end ? normHM(String(time.end)) : addHour(s);
        if (RE_TIME_RANGE.test(l)) {
          l = l.replace(RE_TIME_RANGE, `${s}-${e}`);
        } else {
          l = l.replace(/\s+$/, '') + ` ${s}-${e}`;
        }
      } else if (time && time.clear) {
        l = l.replace(new RegExp(`\\s*${RE_TIME_RANGE.source}`), '');
      }
      lines[idx] = l;
      await fsp.writeFile(abs, lines.join('\n'), 'utf8');
      markSelfWrite(abs);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // 向某天的每日笔记追加一行（循环任务重建用）；文件不存在则创建
  ipcMain.handle('daily:append', async (_e, dateStr, lineText) => {
    if (!vaultPath) return { ok: false, error: '未设置笔记库' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return { ok: false, error: '日期格式错误' };
    const rel = `${CAL_DIR}/${dateStr}.md`;
    const abs = safeResolve(rel);
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      let content = `# ${dateStr}\n\n`;
      if (fs.existsSync(abs)) content = await fsp.readFile(abs, 'utf8');
      if (!content.endsWith('\n')) content += '\n';
      content += String(lineText).replace(/\r?\n/g, ' ').slice(0, 400) + '\n';
      await fsp.writeFile(abs, content, 'utf8');
      markSelfWrite(abs);
      return { ok: true, rel };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('tags:list', async () => {
    if (!vaultPath) return { tags: [], mentions: [] };
    const files = (await scanVault()).filter((f) => f.md);
    const counts = new Map();
    const mentionCounts = new Map();
    const NOT_MENTIONS = new Set(['done', 'due', 'captured', 'reviewed', 'start', 'repeat']);
    const tagRe = /(^|[\s(（])#([^\s#.,!?;:，。！？；：()（）\[\]{}'"，、]+)$/u;
    for (const f of files) {
      let content = '';
      try { content = await fsp.readFile(safeResolve(f.rel), 'utf8'); } catch (_) { continue; }
      for (const raw of content.split(/\r?\n/)) {
        if (raw.trimStart().startsWith('#')) continue; // 跳过标题行
        for (const token of raw.split(/\s+/)) {
          if (token.includes('`')) continue; // 行内代码里的 # 不算标签（启发式）
          const m = token.match(tagRe) || (token.startsWith('#') ? token.match(/^#(.+)$/u) : null);
          if (m) {
            const tag = (m[2] || m[1]).replace(/[.,!?;:，。！？；：]+$/u, '');
            if (tag && !/^\d+$/.test(tag)) counts.set(tag, (counts.get(tag) || 0) + 1);
          }
          // @提及（排除 @done 等功能标记）
          const am = token.match(/^@([^\s@，。！？；：()（）]+)/);
          if (am) {
            const name = am[1].replace(/[.,!?;:，。！？；：]+$/u, '');
            if (name && !NOT_MENTIONS.has(name.toLowerCase()) && !/^\d/.test(name)) {
              mentionCounts.set(name, (mentionCounts.get(name) || 0) + 1);
            }
          }
        }
      }
    }
    const tags = [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 60);
    const mentions = [...mentionCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 40);
    return { tags, mentions };
  });

  /* ---------------- 系统 ---------------- */

  ipcMain.handle('shell:openPath', (_e, rel) => {
    const abs = safeResolve(rel);
    if (!abs) return false;
    return shell.openPath(abs);
  });

  ipcMain.handle('shell:showInFolder', () => {
    if (vaultPath) shell.openPath(vaultPath);
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
  });

  ipcMain.handle('vault:defaultPath', () => {
    return path.join(app.getPath('documents'), 'NotePlan 笔记库');
  });

  // 渲染进程退出前同步保存（sendSync），保证最后几秒的修改不丢
  ipcMain.on('note:write-sync', (e, rel, content) => {
    const abs = safeResolve(rel);
    if (!abs) { e.returnValue = { ok: false, error: '非法路径' }; return; }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      markSelfWrite(abs);
      e.returnValue = { ok: true };
    } catch (err) {
      e.returnValue = { ok: false, error: String(err && err.message || err) };
    }
  });

  /* ---------------- 日历事件（ICS 订阅） ---------------- */

  const icsMemCache = new Map(); // src -> { fetchedAt, text }

  async function fetchIcsText(src) {
    const REFRESH = 30 * 60 * 1000;
    const mem = icsMemCache.get(src);
    if (/^https?:\/\//i.test(src)) {
      if (mem && Date.now() - mem.fetchedAt < REFRESH) return mem.text;
      try {
        const res = await net.fetch(src);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        icsMemCache.set(src, { fetchedAt: Date.now(), text });
        return text;
      } catch (err) {
        if (mem) return mem.text; // 网络失败时用旧缓存
        throw err;
      }
    }
    // 本地 .ics 文件（相对笔记库或绝对路径）
    const abs = path.isAbsolute(src) ? src : safeResolve(src);
    if (!abs) throw new Error('非法日历文件路径');
    const text = await fsp.readFile(abs, 'utf8');
    icsMemCache.set(src, { fetchedAt: Date.now(), text });
    return text;
  }

  /** 解析 ICS 文本 → VEVENT 数组（{start:Date,end:Date|null,allDay,title,loc}） */
  function parseIcs(text) {
    const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
      const events = [];
    const blocks = unfolded.split(/BEGIN:VEVENT/).slice(1);
    for (const b of blocks) {
      const body = b.split(/END:VEVENT/)[0];
      if (!body) continue;
      const props = {};
      for (const line of body.split(/\r?\n/)) {
        const ci = line.indexOf(':');
        if (ci === -1) continue;
        const head = line.slice(0, ci);
        const si = head.indexOf(';');
        const name = si === -1 ? head : head.slice(0, si);
        const params = si === -1 ? '' : head.slice(si);
        if (!/^[A-Z\-]+$/.test(name)) continue;
        props[name] = { params, value: line.slice(ci + 1).trim() };
      }
      const dtStart = props.DTSTART;
      if (!dtStart) continue;
      const start = parseIcsDate(dtStart.value, dtStart.params);
      if (!start) continue;
      const allDay = /VALUE=DATE/i.test(dtStart.params) || /^\d{8}$/.test(dtStart.value);
      let end = null;
      if (props.DTEND) end = parseIcsDate(props.DTEND.value, props.DTEND.params);
      events.push({
        start,
        end,
        allDay,
        title: props.SUMMARY ? props.SUMMARY.value.replace(/\\,/g, ',').replace(/\\n/gi, ' ') : '(无标题)',
        loc: props.LOCATION ? props.LOCATION.value.replace(/\\,/g, ',') : '',
        rrule: props.RRULE ? props.RRULE.value : null,
      });
    }
    return events;
  }

  /** DTSTART 值 → Date（无时区信息按本地时间；Z 结尾按 UTC） */
  function parseIcsDate(value, params) {
    if (!params) params = '';
    if (/VALUE=DATE/i.test(params) || /^\d{8}$/.test(value)) {
      const y = +value.slice(0, 4), mo = +value.slice(4, 6), d = +value.slice(6, 8);
      return new Date(y, mo - 1, d, 0, 0);
    }
    const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    if (z === 'Z') {
      return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
    }
    return new Date(+y, +mo - 1, +d, +h, +mi, +s);
  }

  /** RRULE 基本展开：FREQ=DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL + COUNT + UNTIL */
  function expandRrule(ev, rruleStr, rangeStart, rangeEnd) {
    const out = [];
    const parts = {};
    for (const seg of rruleStr.split(';')) {
      const [k, v] = seg.split('=');
      if (k) parts[k.toUpperCase()] = v;
    }
    const freq = (parts.FREQ || '').toUpperCase();
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
      return ev.start >= rangeStart && ev.start <= rangeEnd ? [ev] : [];
    }
    const interval = Math.max(1, parseInt(parts.INTERVAL || '1', 10));
    const count = parts.COUNT ? parseInt(parts.COUNT, 10) : 366 * 2;
    const until = parts.UNTIL ? parseIcsDate(parts.UNTIL, '') : null;
    const stepDays = { DAILY: interval, WEEKLY: 7 * interval, MONTHLY: 0, YEARLY: 0 };

    let cur = new Date(ev.start);
    const made = [];
    for (let i = 0; i < count && made.length < 400; i++) {
      if (until && cur > until) break;
      if (cur > rangeEnd) break;
      if (cur >= rangeStart) {
        made.push({
          start: new Date(cur),
          end: ev.end ? new Date(ev.end.getTime() + (cur - ev.start)) : null,
          allDay: ev.allDay,
          title: ev.title,
          loc: ev.loc,
        });
      }
      if (freq === 'DAILY') cur = new Date(cur.getTime() + stepDays.DAILY * 86400000);
      else if (freq === 'WEEKLY') cur = new Date(cur.getTime() + 7 * interval * 86400000);
      else if (freq === 'MONTHLY') cur = new Date(cur.getFullYear(), cur.getMonth() + interval, cur.getDate(), cur.getHours(), cur.getMinutes());
      else cur = new Date(cur.getFullYear() + interval, cur.getMonth(), cur.getDate(), cur.getHours(), cur.getMinutes());
    }
    return made;
  }

  ipcMain.handle('cal:events', async (_e, rangeStartStr, rangeEndStr) => {
    const calendars = Array.isArray(settings.calendars) ? settings.calendars : [];
    if (!calendars.length) return [];
    const rangeStart = parseDateStr(rangeStartStr);
    const rangeEnd = parseDateStr(rangeEndStr);
    if (!rangeStart || !rangeEnd) return [];

    const out = [];
    for (let i = 0; i < calendars.length; i++) {
      const cal = calendars[i];
      const src = typeof cal === 'string' ? cal : cal.src;
      if (!src) continue;
      try {
        const text = await fetchIcsText(src);
        for (const ev of parseIcs(text)) {
          const list = ev.rrule
            ? expandRrule(ev, ev.rrule, rangeStart, rangeEnd)
            : (ev.start >= rangeStart && ev.start <= rangeEnd ? [ev] : []);
          for (const e of list) {
            out.push({
              date: fmtDate(e.start),
              startHM: e.allDay ? null : `${String(e.start.getHours()).padStart(2, '0')}:${String(e.start.getMinutes()).padStart(2, '0')}`,
              endHM: e.end && !e.allDay ? `${String(e.end.getHours()).padStart(2, '0')}:${String(e.end.getMinutes()).padStart(2, '0')}` : null,
              allDay: e.allDay,
              title: e.title,
              loc: e.loc,
              cal: i,
            });
          }
        }
      } catch (err) {
        console.error('日历源读取失败:', src, err);
      }
    }
    return out;
  });

  function parseDateStr(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0);
  }

  function fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  ipcMain.handle('app:quit', () => app.quit());

  // 渲染进程确认完未保存的修改后放行关闭
  ipcMain.handle('app:confirm-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.__forceClose = true;
      mainWindow.close();
    }
  });
}

/* ------------------------------------------------------------------ */
/* 菜单                                                                */
/* ------------------------------------------------------------------ */

function sendToWindow(ch, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, ...args);
}

function buildMenu() {
  // 快捷键由渲染进程统一处理（避免与页面按键重复触发），
  // 菜单项标签里写明快捷键作为提示。
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建笔记　Ctrl+N', click: () => sendToWindow('menu:new-note') },
        { label: '打开今日笔记　Ctrl+J', click: () => sendToWindow('menu:open-today') },
        { label: '周计划', click: () => sendToWindow('menu:week-plan') },
        { type: 'separator' },
        { label: '命令面板　Ctrl+K', click: () => sendToWindow('menu:palette') },
        { label: '全库搜索　Ctrl+Shift+F', click: () => sendToWindow('menu:search') },
        { type: 'separator' },
        { label: '更换笔记库…', click: () => sendToWindow('menu:choose-vault') },
        { label: '在资源管理器中打开笔记库', click: () => { if (vaultPath) shell.openPath(vaultPath); } },
        { type: 'separator' },
        { label: '设置…　Ctrl+,', click: () => sendToWindow('menu:settings') },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '切换当前行任务　Ctrl+L', click: () => sendToWindow('menu:toggle-task') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '切换深色 / 浅色主题　Ctrl+Shift+L', click: () => sendToWindow('menu:toggle-theme') },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '快捷键与语法说明', click: () => sendToWindow('menu:help') },
        { label: '关于', click: () => sendToWindow('menu:about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

function applyTheme() {
  if (settings.theme === 'dark') nativeTheme.themeSource = 'dark';
  else if (settings.theme === 'light') nativeTheme.themeSource = 'light';
  else nativeTheme.themeSource = 'system';
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow() {
  // 默认尺寸在小屏幕上按工作区收缩（任务栏除外），避免窗口超出屏幕
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.min(1320, workAreaSize.width);
  const height = Math.min(860, workAreaSize.height);
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(980, width),
    minHeight: Math.min(620, height),
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d23' : '#f7f8fa',
    autoHideMenuBar: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

    // 外部链接一律用系统默认浏览器打开；阻止页面自行跳转
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

    mainWindow.once('ready-to-show', () => { mainWindow.__ready = true; mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 关窗先交给渲染进程确认未保存的修改（保存/放弃），确认后经 app:confirm-close 放行
  mainWindow.on('close', (e) => {
    if (mainWindow.__forceClose || !mainWindow.__ready) return;
    e.preventDefault();
    try {
      mainWindow.webContents.send('app:close-request');
    } catch (_) {
      mainWindow.__forceClose = true;
      mainWindow.close();
    }
  });
}

/* ------------------------------------------------------------------ */
/* 自定义协议：vault:///<相对路径>，用于在预览中显示笔记库内的图片        */
/* ------------------------------------------------------------------ */

function registerVaultProtocol() {
  protocol.handle('vault', async (request) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      // vault://Notes/img.png 形式时 hostname 是首段
      if (url.hostname && !rel.toLowerCase().startsWith(url.hostname.toLowerCase())) {
        rel = url.hostname + '/' + rel;
      }
      const abs = safeResolve(rel);
      if (!abs) return new Response('forbidden', { status: 403 });
      try {
        return await net.fetch('file:///' + encodeURI(abs.split(path.sep).join('/')));
      } catch (_) {
        return new Response('not found', { status: 404 });
      }
    } catch (err) {
      return new Response('bad request', { status: 400 });
    }
  });
}

/* ------------------------------------------------------------------ */
/* 启动流程                                                            */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    loadSettings();
    applyTheme();
    registerVaultProtocol();
    registerIpc();
    buildMenu();

    // 系统主题变化时通知渲染进程（用于"跟随系统"模式）
    nativeTheme.on('updated', () => {
      sendToWindow('theme:changed', nativeTheme.shouldUseDarkColors);
    });

    if (settings.vaultPath && fs.existsSync(settings.vaultPath)) {
      setVault(settings.vaultPath);
    }

    createWindow();

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    stopWatching();
    app.quit();
  });
}

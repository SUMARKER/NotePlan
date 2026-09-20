'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 订阅主进程事件，返回取消订阅函数 */
function on(channel, listener) {
  const wrapped = (_event, ...args) => listener(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('api', {
  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 笔记库
  chooseVault: () => ipcRenderer.invoke('vault:choose'),
  openVault: (dir, createSampleIfEmpty) => ipcRenderer.invoke('vault:open', dir, createSampleIfEmpty),
  getVaultPath: () => ipcRenderer.invoke('vault:path'),

  // 笔记与文件夹
  listNotes: () => ipcRenderer.invoke('notes:list'),
  readNote: (rel) => ipcRenderer.invoke('note:read', rel),
  writeNote: (rel, content) => ipcRenderer.invoke('note:write', rel, content),
  createNote: (folder, title, content) => ipcRenderer.invoke('note:create', folder, title, content),
  openDaily: (dateStr) => ipcRenderer.invoke('note:daily', dateStr),
  renameNote: (rel, newName) => ipcRenderer.invoke('note:rename', rel, newName),
  trashNote: (rel) => ipcRenderer.invoke('note:trash', rel),
  trashList: () => ipcRenderer.invoke('trash:list'),
  trashRestore: (id) => ipcRenderer.invoke('trash:restore', id),
  trashPurge: (id) => ipcRenderer.invoke('trash:purge', id),
  trashEmpty: () => ipcRenderer.invoke('trash:empty'),
  moveNote: (rel, destFolder) => ipcRenderer.invoke('note:move', rel, destFolder),
  createFolder: (parent, name) => ipcRenderer.invoke('folder:create', parent, name),
  trashFolder: (rel) => ipcRenderer.invoke('folder:trash', rel),

  // 搜索
  search: (q) => ipcRenderer.invoke('search:query', q),
  backlinks: (title) => ipcRenderer.invoke('search:backlinks', title),
  scheduledTasks: (dateStr) => ipcRenderer.invoke('search:scheduled', dateStr),
  listTags: () => ipcRenderer.invoke('tags:list'),

  // 任务
  tasksAll: () => ipcRenderer.invoke('tasks:all'),
  rescheduleTask: (rel, line, newDate, time) => ipcRenderer.invoke('task:reschedule', rel, line, newDate, time),
  dailyAppend: (dateStr, lineText) => ipcRenderer.invoke('daily:append', dateStr, lineText),

  // 日历事件（ICS 订阅）
  calEvents: (rangeStart, rangeEnd) => ipcRenderer.invoke('cal:events', rangeStart, rangeEnd),

  // 系统
  openPath: (rel) => ipcRenderer.invoke('shell:openPath', rel),
  showInFolder: () => ipcRenderer.invoke('shell:showInFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  defaultVaultPath: () => ipcRenderer.invoke('vault:defaultPath'),
  flushSaveNow: (rel, content) => ipcRenderer.sendSync('note:write-sync', rel, content),
  quit: () => ipcRenderer.invoke('app:quit'),
  confirmClose: () => ipcRenderer.invoke('app:confirm-close'),

  // 事件
  onVaultChanged: (cb) => on('vault:changed', cb),
  onCloseRequest: (cb) => on('app:close-request', cb),
  onThemeChanged: (cb) => on('theme:changed', cb),
  onMenu: (name, cb) => on('menu:' + name, cb),
});

'use strict';
/* ==========================================================================
   Tauri 桥：用 window.__TAURI__.core.invoke 实现 window.api（与 Electron
   preload 完全同形）。仅当运行在 Tauri 环境时启用；Electron 下由 preload.js
   负责。
   同时切换 vault 图片基址为 http://vault.localhost/（由 Rust 侧自定义协议提供文件）。
   ========================================================================== */

(function () {
  if (window.api) return; // Electron preload 已注入
  const T = window.__TAURI__;
  if (!T || !T.core || typeof T.core.invoke !== 'function') return;

  window.__VAULT_BASE = 'http://vault.localhost/';

  const { invoke } = T.core;

  /* preload 方法名 → [Tauri 命令名, Rust 参数名列表]。
     前端按位置传参；这里映射为 invoke 的命名参数对象。 */
  const METHODS = {
    getSettings: ['get_settings', []],
    setSettings: ['set_settings', ['patch']],
    chooseVault: ['choose_vault', []],
    openVault: ['open_vault', ['dir', 'createSample']],
    getVaultPath: ['get_vault_path', []],
    listNotes: ['list_notes', []],
    readNote: ['read_note', ['rel']],
    writeNote: ['write_note', ['rel', 'content']],
    createNote: ['create_note', ['folder', 'title', 'content']],
    openDaily: ['open_daily', ['dateStr']],
    renameNote: ['rename_note', ['rel', 'newName']],
    trashNote: ['trash_note', ['rel']],
    trashList: ['trash_list', []],
    trashRestore: ['trash_restore', ['id']],
    trashPurge: ['trash_purge', ['id']],
    trashEmpty: ['trash_empty', []],
    moveNote: ['move_note', ['rel', 'destFolder']],
    createFolder: ['create_folder', ['parent', 'name']],
    trashFolder: ['trash_folder', ['rel']],
    search: ['search', ['q']],
    backlinks: ['backlinks', ['title']],
    scheduledTasks: ['scheduled_tasks', ['dateStr']],
    listTags: ['list_tags', []],
    tasksAll: ['tasks_all', []],
    rescheduleTask: ['reschedule_task', ['rel', 'line', 'newDate', 'time']],
    dailyAppend: ['daily_append', ['dateStr', 'lineText']],
    calEvents: ['cal_events', ['rangeStart', 'rangeEnd']],
    openPath: ['open_path', ['rel']],
    showInFolder: ['show_in_folder', []],
    openExternal: ['open_external', ['url']],
    defaultVaultPath: ['default_vault_path', []],
    quit: ['quit', []],
  };

  const api = {};
  for (const m of Object.keys(METHODS)) {
    const [cmd, names] = METHODS[m];
    api[m] = (...args) => {
      const named = {};
      for (let i = 0; i < names.length; i++) {
        if (args[i] !== undefined) named[names[i]] = args[i];
      }
      return invoke(cmd, named);
    };
  }

  // 退出前同步保存：Electron 用 sendSync；Tauri 下退化为尽力而为的 fire-and-forget
  api.flushSaveNow = (rel, content) => invoke('write_note', { rel, content });

  const listen = (name, cb) => T.event.listen(name, cb);
  api.onVaultChanged = (cb) => listen('vault:changed', () => cb());
  api.onCloseRequest = (cb) => listen('app:close-request', () => cb());
  api.confirmClose = () => T.core.invoke('close_window');
  api.onThemeChanged = (cb) => listen('theme:changed', (e) => cb(!!e.payload));
  api.onMenu = (name, cb) => listen('menu:' + name, () => cb());

  window.api = api;
})();

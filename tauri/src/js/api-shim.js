'use strict';
/* ==========================================================================
   WebView2 宿主桥：用 postMessage 实现 window.api（与 Electron preload 完全
   同形）。仅当运行在 WebView2 中时启用；Electron 下由 preload.js 负责。
   同时切换 vault 图片基址为 https://vault.local/（由 C# 侧拦截并提供文件）。
   ========================================================================== */

(function () {
  if (!window.chrome || !window.chrome.webview || !window.chrome.webview.postMessage) return;
  if (window.api) return; // Electron preload 已注入

  window.__VAULT_BASE = 'https://vault.local/';

  let seq = 0;
  const pending = new Map();
  const listeners = new Map();

  window.chrome.webview.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p(msg.ok ? msg.result : { ok: false, error: msg.error || 'unknown error' });
      return;
    }
    if (msg.event) {
      const set = listeners.get(msg.event);
      if (set) for (const fn of [...set]) fn(msg.data);
    }
  });

  function invoke(method, args) {
    return new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      window.chrome.webview.postMessage({ id, method, args: args || [] });
    });
  }

  const api = {};
  const METHODS = [
    'getSettings', 'setSettings', 'chooseVault', 'openVault', 'getVaultPath',
    'listNotes', 'readNote', 'writeNote', 'createNote', 'openDaily',
    'renameNote', 'trashNote', 'moveNote', 'createFolder', 'trashFolder',
    'search', 'backlinks', 'scheduledTasks', 'listTags',
    'tasksAll', 'rescheduleTask', 'dailyAppend', 'calEvents', 'trashList', 'trashRestore', 'trashPurge', 'trashEmpty',
    'openPath', 'showInFolder', 'openExternal', 'defaultVaultPath', 'quit',
  ];
  for (const m of METHODS) api[m] = (...args) => invoke(m, args);

  // 退出前同步保存：WebView2 下退化为尽力而为的 fire-and-forget
  api.flushSaveNow = (rel, content) => {
    window.chrome.webview.postMessage({ fireForget: true, method: 'note:write', args: [rel, content] });
  };

  function on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => listeners.get(event).delete(cb);
  }
  api.onVaultChanged = (cb) => on('vault:changed', () => cb());
  api.onThemeChanged = (cb) => on('theme:changed', (dark) => cb(!!dark));
  api.onMenu = (name, cb) => on('menu:' + name, () => cb());

  window.api = api;
})();

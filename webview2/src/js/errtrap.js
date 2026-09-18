'use strict';
/* 把渲染端未捕获的错误显示到窗口标题，便于无控制台环境下排障 */
window.addEventListener('error', (e) => {
  document.title = 'ERR: ' + e.message + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno;
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  document.title = 'REJ: ' + ((r && r.message) || String(r)).slice(0, 160);
});

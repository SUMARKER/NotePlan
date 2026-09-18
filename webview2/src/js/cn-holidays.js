'use strict';
/* ==========================================================================
 * 中国大陆法定节假日数据
 * 依据国务院办公厅历年《关于部分节假日安排的通知》整理，与
 * https://github.com/NateScarlet/holiday-cn 开源数据核对一致。
 *
 * 内置数据：每年 11 月前后官方公布次年安排后，在 DATA 中追加一年即可，条目格式：
 *   ['MM-DD', '节日名']        法定放假日（休）
 *   ['MM-DD', '节日名', 0]     调休上班日（班）
 *
 * 自动更新：浏览到没有内置数据的年份时，自动从 holiday-cn（jsDelivr CDN 优先，
 * GitHub 原始地址兜底）拉取该年数据，缓存到 localStorage；每天至多尝试一次，
 * 失败不影响内置数据。可在 设置 → 自动更新节假日数据 关闭。
 * ========================================================================== */

(() => {
  const DATA = {
    2024: [
      ['01-01', '元旦'],
      ['02-04', '春节', 0],
      ['02-10', '春节'], ['02-11', '春节'], ['02-12', '春节'], ['02-13', '春节'],
      ['02-14', '春节'], ['02-15', '春节'], ['02-16', '春节'], ['02-17', '春节'],
      ['02-18', '春节', 0],
      ['04-04', '清明节'], ['04-05', '清明节'], ['04-06', '清明节'],
      ['04-07', '清明节', 0],
      ['04-28', '劳动节', 0],
      ['05-01', '劳动节'], ['05-02', '劳动节'], ['05-03', '劳动节'],
      ['05-04', '劳动节'], ['05-05', '劳动节'],
      ['05-11', '劳动节', 0],
      ['06-10', '端午节'],
      ['09-14', '中秋节', 0],
      ['09-15', '中秋节'], ['09-16', '中秋节'], ['09-17', '中秋节'],
      ['09-29', '国庆节', 0],
      ['10-01', '国庆节'], ['10-02', '国庆节'], ['10-03', '国庆节'],
      ['10-04', '国庆节'], ['10-05', '国庆节'], ['10-06', '国庆节'], ['10-07', '国庆节'],
      ['10-12', '国庆节', 0],
    ],
    2025: [
      ['01-01', '元旦'],
      ['01-26', '春节', 0],
      ['01-28', '春节'], ['01-29', '春节'], ['01-30', '春节'], ['01-31', '春节'],
      ['02-01', '春节'], ['02-02', '春节'], ['02-03', '春节'], ['02-04', '春节'],
      ['02-08', '春节', 0],
      ['04-04', '清明节'], ['04-05', '清明节'], ['04-06', '清明节'],
      ['04-27', '劳动节', 0],
      ['05-01', '劳动节'], ['05-02', '劳动节'], ['05-03', '劳动节'],
      ['05-04', '劳动节'], ['05-05', '劳动节'],
      ['05-31', '端午节'], ['06-01', '端午节'], ['06-02', '端午节'],
      ['09-28', '国庆节、中秋节', 0],
      ['10-01', '国庆节、中秋节'], ['10-02', '国庆节、中秋节'], ['10-03', '国庆节、中秋节'],
      ['10-04', '国庆节、中秋节'], ['10-05', '国庆节、中秋节'], ['10-06', '国庆节、中秋节'],
      ['10-07', '国庆节、中秋节'], ['10-08', '国庆节、中秋节'],
      ['10-11', '国庆节、中秋节', 0],
    ],
    2026: [
      ['01-01', '元旦'], ['01-02', '元旦'], ['01-03', '元旦'],
      ['01-04', '元旦', 0],
      ['02-14', '春节', 0],
      ['02-15', '春节'], ['02-16', '春节'], ['02-17', '春节'], ['02-18', '春节'],
      ['02-19', '春节'], ['02-20', '春节'], ['02-21', '春节'], ['02-22', '春节'],
      ['02-23', '春节'],
      ['02-28', '春节', 0],
      ['04-04', '清明节'], ['04-05', '清明节'], ['04-06', '清明节'],
      ['05-01', '劳动节'], ['05-02', '劳动节'], ['05-03', '劳动节'],
      ['05-04', '劳动节'], ['05-05', '劳动节'],
      ['05-09', '劳动节', 0],
      ['06-19', '端午节'], ['06-20', '端午节'], ['06-21', '端午节'],
      ['09-20', '中秋节', 0],
      ['09-25', '中秋节'], ['09-26', '中秋节'], ['09-27', '中秋节'],
      ['10-01', '国庆节'], ['10-02', '国庆节'], ['10-03', '国庆节'],
      ['10-04', '国庆节'], ['10-05', '国庆节'], ['10-06', '国庆节'], ['10-07', '国庆节'],
      ['10-10', '国庆节', 0],
    ],
  };

  const LS_CACHE = 'cnHolidays.cache.v1';
  const LS_AUTO = 'cnHolidays.autoUpdate';
  const RETRY_AFTER_MS = 24 * 60 * 60 * 1000; // 失败/未公布后一天内不重复请求
  const SOURCES = (year) => [
    `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
    `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
  ];

  const dateCache = new Map(); // 'YYYY-MM-DD' -> {name, off} | null
  let remote = {};             // year -> [[MM-DD, name, off]...]（自动更新拉取的数据）
  let attempts = {};           // year -> 上次尝试时间戳 ms
  let storeOk = true;

  function loadStore() {
    try {
      const raw = localStorage.getItem(LS_CACHE);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        remote = (obj.remote && typeof obj.remote === 'object') ? obj.remote : {};
        attempts = (obj.attempts && typeof obj.attempts === 'object') ? obj.attempts : {};
      }
    } catch (_) { storeOk = false; }
  }
  function saveStore() {
    if (!storeOk) return;
    try { localStorage.setItem(LS_CACHE, JSON.stringify({ remote, attempts })); } catch (_) { storeOk = false; }
  }
  loadStore();

  function daysFor(year) {
    return DATA[year] || (remote[year] || null);
  }

  // 查询某天的节假日信息：{name:'春节', off:true} / {name:'春节', off:false}(调休上班) / null
  function info(dateStr) {
    if (typeof dateStr !== 'string' || dateStr.length !== 10) return null;
    if (dateCache.has(dateStr)) return dateCache.get(dateStr);
    let r = null;
    const year = daysFor(Number(dateStr.slice(0, 4)));
    if (year) {
      const md = dateStr.slice(5);
      for (const [d, n, off] of year) {
        if (d === md) { r = { name: n, off: off !== 0 }; break; }
      }
    }
    dateCache.set(dateStr, r);
    return r;
  }

  /* -------------------- 自动更新 -------------------- */

  function autoEnabled() {
    try { return localStorage.getItem(LS_AUTO) !== '0'; } catch (_) { return true; }
  }
  function setAutoEnabled(v) {
    try { localStorage.setItem(LS_AUTO, v ? '1' : '0'); } catch (_) { /* 忽略 */ }
  }
  function hasYear(year) { return !!daysFor(year); }

  // 校验并转换为内置格式；不合法返回 null
  function parseRemote(json, year) {
    if (!json || typeof json !== 'object' || json.year !== year || !Array.isArray(json.days)) return null;
    const days = [];
    for (const d of json.days) {
      if (!d || typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return null;
      if (typeof d.isOffDay !== 'boolean') return null;
      if (Number(d.date.slice(0, 4)) !== year) return null;
      days.push([d.date.slice(5), String(d.name || ''), d.isOffDay ? 1 : 0]);
    }
    return days.length ? days : null;
  }

  function fetchText(url) {
    return fetch(url, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))));
  }

  /**
   * 确保某一年有节假日数据；缺数据时自动拉取。
   * 返回 'ok'（已拉取并合并）/ 'skip'（已有数据/已关闭/当日已尝试）/ 'fail'。
   * opts.force：忽略"已有数据"与节流（设置开关仍然生效）。
   */
  async function ensureYear(year, opts) {
    year = Number(year);
    if (!(year >= 2007 && year <= 2100)) return 'skip';
    opts = opts || {};
    if (!hasYear(year) || opts.force) {
      if (!autoEnabled() && !opts.force) return 'skip';
      const last = attempts[year] || 0;
      if (!opts.force && Date.now() - last < RETRY_AFTER_MS) return 'skip';
      attempts[year] = Date.now();
      for (const url of SOURCES(year)) {
        try {
          const days = parseRemote(JSON.parse(await fetchText(url)), year);
          if (days) {
            remote[year] = days;
            saveStore();
            dateCache.clear();
            return 'ok';
          }
        } catch (_) { /* 换下一个源 */ }
      }
      saveStore();
      return 'fail';
    }
    return 'skip';
  }

  /* -------------------- 查询辅助 -------------------- */

  // '休'（法定放假日）/ '班'（调休上班日）/ ''
  function badge(dateStr) {
    const i = info(dateStr);
    return i ? (i.off ? '休' : '班') : '';
  }

  // 悬浮提示后缀：' · 春节' / ' · 调休上班' / ''
  function titleSuffix(dateStr) {
    const i = info(dateStr);
    if (!i) return '';
    return ` · ${i.name}${i.off ? '' : '（调休上班）'}`;
  }

  window.CNHolidays = { info, badge, titleSuffix, ensureYear, hasYear, autoEnabled, setAutoEnabled };
})();

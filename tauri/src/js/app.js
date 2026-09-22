'use strict';
/* ==========================================================================
   NotePlan for Windows — 渲染端主控制器
   ========================================================================== */

(() => {
  const $ = (sel) => document.querySelector(sel);

  const editor = $('#editor');        // textarea 兜底（CodeMirror 未构建时使用）
  const editorWrap = $('#editor-wrap');

  let Ed = null; // 编辑器适配器（CodeMirror 或 textarea）

  const state = {
    settings: { theme: 'auto', lastNote: null, sidebarView: 'calendar' },
    systemDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    vaultPath: '',
    notes: [],
    byRel: new Map(),
    current: null,          // {rel,isDaily,dateStr,mtimeMs,dirty}
    saveTimer: null,
    previewTimer: null,
    outline: [],
    calMonth: null,         // Date（当月任意一天）
    sidebarTab: 'calendar',
    collapsed: new Set(),
    externalDirty: false,    // 当前笔记被外部改动且本地有未保存修改（离开时确认）
    paletteSeq: 0,
    renderGen: 0,
    taskIndex: [],          // 全库任务索引
    weekStart: null,        // 周条起始日（周一）
    rightTab: 'agenda',
    raSel: null,            // 右栏日程选中的日期
    raGen: 0,               // 日程异步渲染代数
    tagsCache: [],
    mentionsCache: [],
    suppressDocEvent: false,
    mainView: 'notes',        // 'notes' | 'week' | 'month' | 'year'
    calvMode: 'month',        // 'month' | 'year'
    calvMonth: null,          // 月视图当前月
    calvYear: null,           // 年视图当前年
    calvSel: null,            // 月视图选中日期
    calEventsCache: { key: '', list: [] },
    wpWeekStart: null,        // 周计划当前周（周日）
    wpGoalKey: '',            // 周目标当前加载的周计划文件
    wpGoalLines: [],          // 周目标段各行（原样保存，任务行可勾选/排期）
    wpGoalKind: 'todo',       // 周目标输入类型：'todo' | 'text'
  };

  /* ======================================================================
   * 小工具
   * ==================================================================== */

  const pad2 = (n) => String(n).padStart(2, '0');
  const todayStr = (d) => {
    d = d || new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekdayCN = (dateStr) => WEEKDAYS[new Date(dateStr + 'T12:00:00').getDay()];
  const monthCN = (dateStr) => {
    const [, m, d] = dateStr.split('-').map(Number);
    return `${m}月${d}日`;
  };
  // 中国大陆法定节假日（js/cn-holidays.js）：{name, off} | null
  const holOf = (dateStr) => (window.CNHolidays ? window.CNHolidays.info(dateStr) : null);
  const holTitle = (dateStr) => (window.CNHolidays ? window.CNHolidays.titleSuffix(dateStr) : '');
  // 农历 / 节气（js/lunar.js）
  const lunarLabel = (y, m, d) => (window.NPLunar ? window.NPLunar.label(y, m, d) : null);
  const lunarFull = (y, m, d) => (window.NPLunar ? window.NPLunar.fullText(y, m, d) : '');
  const lunarFullOf = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return lunarFull(y, m, d);
  };
  // 缺数据的年份后台自动拉取（jsDelivr / GitHub 上的 holiday-cn），成功后刷新日历视图
  function ensureHolYears(years) {
    if (!window.CNHolidays || !window.CNHolidays.ensureYear) return;
    for (const y of new Set(years.filter(Boolean))) {
      window.CNHolidays.ensureYear(y).then((r) => {
        if (r !== 'ok') return;
        renderSidebar();
        renderWeekBar();
        if (state.mainView === 'week') renderWeekPlan();
        else if (state.mainView !== 'notes') renderCalView();
      }).catch(() => {});
    }
  }

  function debounce(fn, ms) {
    let t = null;
    const wrapped = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => { t = null; fn(...args); }, ms);
    };
    wrapped.flushNow = (...args) => { clearTimeout(t); t = null; fn(...args); };
    wrapped.pending = () => t !== null;
    return wrapped;
  }

  const baseName = (rel) => {
    const f = rel.split('/').pop();
    return f.replace(/\.(md|markdown|txt)$/i, '');
  };
  const relDir = (rel) => {
    const i = rel.lastIndexOf('/');
    return i === -1 ? '' : rel.slice(0, i);
  };
  const isDailyRel = (rel) => /^Calendar\/\d{4}-\d{2}-\d{2}\.md$/i.test(rel);
  const noteTitle = (n) => (n && n.title) || baseName(n ? n.rel : '');
  // 该日期的每日笔记存在且写过内容；只是点开过的空文件（仅 # 日期标题）不算"有笔记"
  const dayHasContent = (ds) => {
    const n = state.byRel.get(`Calendar/${ds}.md`);
    return !!n && n.empty !== true;
  };

  let toastTimer = null;
  function toast(msg, action) {
    const el = $('#toast');
    el.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.onclick = () => { hideToast(); action.run(); };
      el.appendChild(btn);
    }
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6000 : 2600);
  }
  function hideToast() {
    const el = $('#toast');
    el.classList.remove('show');
    toastTimer = setTimeout(() => { el.hidden = true; }, 200);
  }

  /* ======================================================================
   * 主题
   * ==================================================================== */

  function applyTheme() {
    const t = state.settings.theme || 'auto';
    const dark = t === 'dark' || (t === 'auto' && state.systemDark);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  function toggleTheme() {
    const cur = document.documentElement.dataset.theme;
    state.settings.theme = cur === 'dark' ? 'light' : 'dark';
    applyTheme();
    window.api.setSettings({ theme: state.settings.theme });
  }

  /* ======================================================================
   * 启动
   * ==================================================================== */

  async function boot() {
    state.settings = Object.assign(state.settings, await window.api.getSettings());
    state.calMonth = new Date();
    state.raSel = todayStr();
    // 本周周日（与月历 / 周计划一致的周日起始）
    state.weekStart = startOfWeek(new Date());
    applyTheme();
    initEditor();
    bindStaticEvents();
    bindMenuEvents();
    window.api.onThemeChanged((dark) => {
      state.systemDark = dark;
      if ((state.settings.theme || 'auto') === 'auto') applyTheme();
    });
    window.api.onVaultChanged(() => { onVaultChanged(); scheduleTaskIndexRefresh(); });
    startReminderLoop();

    if (state.settings.vaultExists && state.settings.vaultPath) {
      await enterVault();
    } else {
      $('#onboarding').hidden = false;
    }
  }

  async function enterVault() {
    $('#onboarding').hidden = true;
    await refreshNotes();
    loadTaskIndex();
    const last = state.settings.lastNote;
    if (last && state.byRel.has(last)) {
      await openNote(last);
    } else {
      await openToday();
    }
  }

  async function refreshNotes() {
    const res = await window.api.listNotes();
    state.vaultPath = res.vaultPath || state.vaultPath;
    state.notes = res.notes;
    state.byRel = new Map(res.notes.map((n) => [n.rel, n]));
    const name = state.vaultPath ? state.vaultPath.split(/[\\/]/).filter(Boolean).pop() : '笔记库';
    $('#vault-name').textContent = name;
    const tagsRes = await window.api.listTags();
    state.tagsCache = tagsRes.tags;
    state.mentionsCache = tagsRes.mentions;
    renderSidebar();
    renderTags(state.tagsCache);
  }

  /* ======================================================================
   * 侧边栏
   * ==================================================================== */

  function renderSidebar() {
    renderCalendar();
    renderDailyList();
    renderTree();
  }

  /* ---- 日历（右侧面板：月历 + 当日安排） ---- */

  function renderCalendar() {
    const y = state.calMonth.getFullYear();
    const m = state.calMonth.getMonth();
    ensureHolYears([y, y + 1]); // 当年 + 次年（次年安排每年 11 月公布）
    $('#rb-cal-title').textContent = `${y}年${m + 1}月`;
    $('#cal-title').textContent = `${y}年${m + 1}月`;

    const grid = $('#rb-cal-grid');
    grid.innerHTML = '';

    // CW 周数列（橙色）+ 星期表头（周日开头）
    const cwHead = document.createElement('div');
    cwHead.className = 'cal-cw cal-cw-head';
    cwHead.textContent = 'CW';
    grid.appendChild(cwHead);
    for (const [wi, w] of ['日', '一', '二', '三', '四', '五', '六'].entries()) {
      const wd = document.createElement('div');
      wd.className = 'cal-weekday' + ((wi === 0 || wi === 6) ? ' wk-end' : '');
      wd.textContent = w;
      grid.appendChild(wd);
    }

    const first = new Date(y, m, 1);
    const offset = first.getDay(); // 周日开头
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const today = todayStr();
    const selected = state.raSel;
    const curNote = state.current && state.current.dateStr;

    let cellInWeek = 0;
    // 第一行：先插 CW，再补月初空位（保持 8 列网格对齐）
    if (offset > 0) grid.appendChild(cwCell(y, m, 1));
    for (let i = 0; i < offset; i++) {
      const e = document.createElement('div');
      e.className = 'cal-day empty';
      grid.appendChild(e);
      cellInWeek++;
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${y}-${pad2(m + 1)}-${pad2(d)}`;
      const hol = holOf(ds);
      const e = document.createElement('div');
      e.className = 'cal-day';
      e.textContent = d;
      if (hol) {
        const dot = document.createElement('span');
        dot.className = 'hol-dot ' + (hol.off ? 'off' : 'work');
        e.appendChild(dot);
      }
      e.title = ds + weekdayCN(ds) + holTitle(ds) + (lunarFull(y, m + 1, d) ? ' · ' + lunarFull(y, m + 1, d) : '') +
        '（点击打开当天笔记并查看安排）';
      if (ds === today) e.classList.add('today');
      if (selected === ds) e.classList.add('selected');
      if (curNote === ds) e.classList.add('cur-note');
      if (dayHasContent(ds)) {
        const dot = document.createElement('div');
        dot.className = 'dot';
        e.appendChild(dot);
      }
      // 单击：打开当天笔记（日程/周条/月历随之联动）
      e.onclick = () => openDaily(ds);
      grid.appendChild(e);
      cellInWeek++;
      // 每行第 3 天之后是行尾：插入下一行的 CW
      if (cellInWeek % 7 === 0 && d < daysInMonth) grid.appendChild(cwCell(y, m, d + 4));
    }
    // 补齐最后一行空位（保持网格对齐）
    const rest = cellInWeek % 7;
    if (rest) for (let i = rest; i < 7; i++) grid.appendChild(Object.assign(document.createElement('div'), { className: 'cal-day empty' }));
  }

  /** CW 周数单元格：ds 为该周内任一日期字符串 */
  function cwCell(y, m, day) {
    const ds = `${y}-${pad2(m + 1)}-${pad2(day)}`;
    const info = isoWeekInfo(new Date(ds + 'T12:00:00'));
    const c = document.createElement('div');
    c.className = 'cal-cw';
    c.textContent = info.week;
    c.title = `第 ${info.week} 周 · 点击打开周计划`;
    c.onclick = () => {
      const d = new Date(ds + 'T12:00:00');
      state.wpWeekStart = startOfWeek(d);
      setMainView('week');
    };
    return c;
  }

  /* ---- 当日安排（右栏：all-day + 时间轴） ---- */

  const RA_HOUR_H = 44; // 时间轴每小时像素高

  async function renderAgenda() {
    const tl = $('#ra-timeline');
    if (!tl) return;
    const ds = state.raSel || todayStr();
    const gen = ++state.raGen;
    const [, m, d] = ds.split('-').map(Number);
    const hol = holOf(ds);

    $('#ra-date').textContent = `${m}月${d}日 ${weekdayCN(ds)}`;
    const holEl = $('#ra-hol');
    if (hol) {
      holEl.hidden = false;
      holEl.className = 'ra-hol ' + (hol.off ? 'off' : 'work');
      holEl.textContent = hol.off ? `${hol.name}·休` : `调休·班`;
    } else {
      holEl.hidden = true;
    }

    // 任务（含周期展开 / 连续区间）；每日笔记里的任务隐式属于当天
    const dailyRel = `Calendar/${ds}.md`;
    const tasks = state.taskIndex.filter((t) => taskOccursOn(t, ds) || t.rel === dailyRel);
    const events = await loadCalEvents(ds, ds);
    if (gen !== state.raGen) return; // 异步期间已切换日期

    const dayTasks = tasks.map((t) => ({ t, tm: parseTaskTime(t.text) }));
    const timedTasks = dayTasks.filter(({ tm }) => tm && tm.start)
      .map(({ t, tm }) => ({
        rel: t.rel, line: t.line, text: t.text, done: t.done,
        title: t.title || t.name, start: tm.start, end: tm.end || addHourHM(tm.start),
      }));
    const alldayTasks = dayTasks.filter(({ tm }) => !tm || !tm.start);
    const alldayEv = events.filter((e) => e.allDay);
    const timedEv = events.filter((e) => !e.allDay && e.startHM)
      .map((e) => ({ ev: e, start: e.startHM, end: e.endHM || addHourHM(e.startHM) }));

    // all-day 区
    const al = $('#ra-allday-list');
    al.innerHTML = '';
    for (const e of alldayEv) {
      const row = document.createElement('div');
      row.className = 'ra-row ev';
      row.innerHTML = `<span class="ra-dot ev-c${e.cal % EV_COLORS.length}"></span><span class="ra-text">${escapeHtml(e.title)}</span>`;
      al.appendChild(row);
    }
    for (const { t } of alldayTasks) {
      const row = document.createElement('div');
      row.className = 'ra-row task' + (t.done ? ' done' : '');
      row.innerHTML = `<input type="checkbox" class="task-box"${t.done ? ' checked' : ''}>` +
        `<span class="ra-text">${escapeHtml(cleanTaskText(t.text))}</span>` +
        (t.rel === dailyRel ? '' : `<span class="ra-src">${escapeHtml(t.title || t.name)}</span>`);
      row.title = `${t.rel} 第 ${t.line} 行`;
      row.querySelector('.task-box').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleTaskInFile(t.rel, t.line);
      });
      row.addEventListener('click', () => openNote(t.rel, { line: t.line }));
      al.appendChild(row);
    }
    if (!alldayEv.length && !alldayTasks.length) al.innerHTML = '<div class="ra-none">没有全天安排</div>';

    // 时间轴范围：默认 08:00–20:00，按内容自动扩展（不跨天）
    let lo = 8 * 60, hi = 20 * 60;
    for (const b of timedTasks) { lo = Math.min(lo, hmToMin(b.start)); hi = Math.max(hi, hmToMin(b.end)); }
    for (const b of timedEv) { lo = Math.min(lo, hmToMin(b.start)); hi = Math.max(hi, hmToMin(b.end)); }
    lo = Math.max(0, Math.floor(lo / 60) * 60);
    hi = Math.min(24 * 60, Math.ceil(hi / 60) * 60);
    const totalMin = hi - lo;

    tl.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'ra-tl-grid';
    grid.style.height = (totalMin / 60) * RA_HOUR_H + 'px';
    for (let mins = lo; mins <= hi; mins += 60) {
      const hour = document.createElement('div');
      hour.className = 'ra-hour';
      hour.style.top = ((mins - lo) / 60) * RA_HOUR_H + 'px';
      hour.innerHTML = `<span class="ra-hour-label">${pad2(mins / 60)}:00</span>`;
      grid.appendChild(hour);
    }

    const blocks = [];
    for (const b of timedEv) blocks.push({ kind: 'ev', ...b });
    for (const b of timedTasks) blocks.push({ kind: 'task', ...b });
    blocks.sort((a, b) => hmToMin(a.start) - hmToMin(b.start) || hmToMin(a.end) - hmToMin(b.end));
    layoutLanes(blocks);

    for (const b of blocks) {
      const top = ((hmToMin(b.start) - lo) / 60) * RA_HOUR_H;
      const bottom = ((hmToMin(b.end) - lo) / 60) * RA_HOUR_H;
      const el = document.createElement('div');
      el.className = b.kind === 'ev'
        ? 'ra-block ev ev-c' + (b.ev.cal % EV_COLORS.length)
        : 'ra-block task' + (b.done ? ' done' : '');
      el.style.top = top + 'px';
      el.style.height = Math.max(20, bottom - top - 2) + 'px';
      el.style.left = `calc(${(b.lane / b.lanes) * 100}% + 4px)`;
      el.style.width = `calc(${100 / b.lanes}% - 8px)`;
      if (b.kind === 'ev') {
        el.innerHTML = `<span class="ra-b-time">${b.start}</span><span class="ra-b-title">${escapeHtml(b.ev.title)}</span>`;
        el.title = `${b.start}-${b.end} ${b.ev.title}`;
      } else {
        el.innerHTML = `<span class="ra-b-time">${b.start}</span><input type="checkbox" class="task-box"${b.done ? ' checked' : ''}>` +
          `<span class="ra-b-title">${escapeHtml(cleanTaskText(b.text))}</span>`;
        el.title = `${b.start}-${b.end} ${cleanTaskText(b.text)}（来源：${b.title}）`;
        el.querySelector('.task-box').addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleTaskInFile(b.rel, b.line);
        });
        el.addEventListener('click', () => openNote(b.rel, { line: b.line }));
      }
      grid.appendChild(el);
    }
    tl.appendChild(grid);
    if (!blocks.length) {
      const empty = document.createElement('div');
      empty.className = 'ra-none';
      empty.textContent = '这一天没有时间块 · 任务写「14:00-15:30 内容」自动上图';
      tl.appendChild(empty);
    }
  }

  /** 重叠时间块的泳道分列：同一 cluster 内并排显示 */
  function layoutLanes(blocks) {
    let cluster = [];
    let clusterEnd = -1;
    const flush = () => {
      const lanes = cluster.reduce((mx, b) => Math.max(mx, b.lane + 1), 1);
      for (const b of cluster) b.lanes = lanes;
      cluster = [];
      clusterEnd = -1;
    };
    for (const b of blocks) {
      const s = hmToMin(b.start), e = hmToMin(b.end);
      if (cluster.length && s >= clusterEnd) flush();
      const used = new Set(cluster.filter((x) => hmToMin(x.end) > s).map((x) => x.lane));
      let lane = 0;
      while (used.has(lane)) lane++;
      b.lane = lane;
      cluster.push(b);
      clusterEnd = Math.max(clusterEnd, e);
    }
    flush();
  }

  /* ---- 周数行（每日笔记正文最上方） ---- */

  function updateWeekRow() {
    const row = $('#weekrow');
    if (!row) return;
    const show = state.mainView === 'notes' && state.current && state.current.isDaily;
    row.hidden = !show;
    if (!show) return;
    const d = new Date(state.current.dateStr + 'T12:00:00');
    const info = isoWeekInfo(d);
    $('#wr-label').textContent = 'WEEK ' + info.week;
    const s = startOfWeek(d);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    $('#wr-range').textContent = `${s.getMonth() + 1}/${s.getDate()} – ${e.getMonth() + 1}/${e.getDate()}`;
  }

  function renderDailyList() {
    const y = state.calMonth.getFullYear();
    const m = state.calMonth.getMonth();
    const list = $('#daily-list');
    list.innerHTML = '';
    const items = state.notes
      .filter((n) => {
        if (!isDailyRel(n.rel) || n.empty === true) return false;
        const ds = baseName(n.rel);
        return ds.startsWith(`${y}-${pad2(m + 1)}`);
      })
      .sort((a, b) => b.rel.localeCompare(a.rel));
    const today = todayStr();
    for (const n of items) {
      const ds = baseName(n.rel);
      const hol = holOf(ds);
      const e = document.createElement('div');
      e.className = 'daily-item' + (state.current && state.current.rel === n.rel ? ' active' : '') + (ds === today ? ' today' : '');
      e.innerHTML = `<span class="d-date">${monthCN(ds)}</span><span class="d-week">${weekdayCN(ds)}</span>` +
        (hol ? `<span class="d-hol${hol.off ? '' : ' work'}">${hol.off ? hol.name : '班'}</span>` : '');
      e.onclick = () => openNote(n.rel);
      list.appendChild(e);
    }
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'tree-empty';
      e.textContent = '本月还没有每日笔记';
      list.appendChild(e);
    }
  }

  /* ---- 笔记树 ---- */

  function buildTree() {
    const root = { name: '', rel: '', children: new Map(), notes: [] };
    for (const n of state.notes) {
      const isDir = n.dir === true;
      // Calendar（每日笔记）不在笔记树展示；其余空目录条目仅用于生成文件夹节点
      if (n.rel === 'Calendar' || n.rel.startsWith('Calendar/')) continue;
      if (!isDir && !n.md) continue;
      const parts = n.rel.split('/');
      if (!isDir) parts.pop();
      let node = root, acc = '';
      for (const p of parts) {
        acc = acc ? acc + '/' + p : p;
        if (!node.children.has(p)) {
          node.children.set(p, { name: p, rel: acc, children: new Map(), notes: [] });
        }
        node = node.children.get(p);
      }
      if (!isDir) node.notes.push(n);
    }
    return root;
  }

  const FOLDER_SVG = '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 14.5 4H8.2L6.6 2.4A1.5 1.5 0 0 0 5.5 2z"/></svg>';
  const NOTE_SVG = '<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M3 1.5A1.5 1.5 0 0 1 4.5 0h7A1.5 1.5 0 0 1 13 1.5v13a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14.5zM4.5 1a.5.5 0 0 0-.5.5v13a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-13a.5.5 0 0 0-.5-.5zM6 4h4a.5.5 0 0 1 0 1H6a.5.5 0 0 1 0-1m0 3h4a.5.5 0 0 1 0 1H6a.5.5 0 0 1 0-1"/></svg>';

  function renderTree() {
    const tree = buildTree();
    const box = $('#note-tree');
    box.innerHTML = '';
    renderFolderNode(box, tree, true);
  }

  function renderFolderNode(container, node, isRoot) {
    const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    const notes = node.notes.slice().sort((a, b) => noteTitle(a).localeCompare(noteTitle(b), 'zh-Hans-CN'));

    if (isRoot && !folders.length && !notes.length) {
      const e = document.createElement('div');
      e.className = 'tree-empty';
      e.textContent = '还没有笔记，点击上方"新建笔记"';
      container.appendChild(e);
    }

    for (const folder of folders) {
      const wrap = document.createElement('div');
      const open = !state.collapsed.has(folder.rel);

      const row = document.createElement('div');
      row.className = 'tree-folder' + (open ? ' open' : '');
      row.innerHTML = `<span class="twist">▶</span><span class="f-icon">${FOLDER_SVG}</span>` +
        `<span class="f-name">${escapeHtml(folder.name)}</span>` +
        `<span class="f-count">${countNotes(folder)}</span>`;
      row.onclick = () => {
        if (state.collapsed.has(folder.rel)) state.collapsed.delete(folder.rel);
        else state.collapsed.add(folder.rel);
        renderTree();
      };
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        folderContext(ev, folder);
      };
      wrap.appendChild(row);

      const children = document.createElement('div');
      children.className = 'tree-children';
      if (!open) children.hidden = true;
      renderFolderNode(children, folder, false);
      wrap.appendChild(children);
      container.appendChild(wrap);
    }

    for (const n of notes) {
      const e = document.createElement('div');
      const active = state.current && state.current.rel === n.rel;
      e.className = 'tree-note' + (active ? ' active' : '');
      const dt = new Date(n.mtimeMs);
      const dstr = `${dt.getMonth() + 1}/${dt.getDate()}`;
      e.innerHTML = `<span class="n-icon">${NOTE_SVG}</span>` +
        `<span class="n-title">${escapeHtml(noteTitle(n))}</span>` +
        `<span class="n-date">${dstr}</span>`;
      e.title = n.rel;
      e.onclick = () => openNote(n.rel);
      e.oncontextmenu = (ev) => {
        ev.preventDefault();
        noteContext(ev, n);
      };
      container.appendChild(e);
    }
  }

  function countNotes(node) {
    let c = node.notes.length;
    for (const ch of node.children.values()) c += countNotes(ch);
    return c;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderTags(tags) {
    const box = $('#tag-cloud');
    box.innerHTML = '';
    if (!tags || !tags.length) {
      box.innerHTML = '<span class="tree-empty" style="padding:0">暂无标签<br/>右键标签可重命名 / 删除</span>';
      return;
    }
    for (const t of tags.slice(0, 24)) {
      const chip = document.createElement('button');
      chip.className = 'tag-chip';
      chip.innerHTML = `#${escapeHtml(t.tag)}<span class="t-count">${t.count}</span>`;
      chip.title = '点击搜索该标签 · 右键管理（重命名 / 删除）';
      chip.onclick = () => openPalette('#' + t.tag);
      chip.oncontextmenu = (ev) => {
        ev.preventDefault();
        tagContext(ev, t.tag);
      };
      box.appendChild(chip);
    }
  }

  /* ---- 标签管理：右键重命名 / 删除（跨全库改写笔记内容） ---- */

  function tagContext(ev, tag) {
    showCtx(ev.clientX, ev.clientY, [
      { label: '重命名标签…', onClick: () => renameTagFlow(tag) },
      { label: '删除标签', danger: true, onClick: () =>
        confirmModal('删除标签', `将从所有笔记中移除 #${tag}（直接改写文件，不可撤销）。`, '删除', () => rewriteTagEveryVault(tag, '')) },
    ]);
  }

  function renameTagFlow(tag) {
    inputModal('重命名标签', `将 #${tag} 重命名为（不含 # 号）：`, tag, (v) => {
      const next = v.replace(/^#/, '').trim();
      if (!next || next === tag) return;
      rewriteTagEveryVault(tag, next);
    });
  }

  /* 标签结束边界：后一个字符不能仍是标签字符（与书写语法一致） */
  const TAG_END = "(?![^\\s#.,!?;:，。！？；：()（）\\[\\]{}'\"<>…·、“”])";

  async function rewriteTagEveryVault(oldTag, newTag) {
    const esc = oldTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('#' + esc + TAG_END, 'g');
    const replacement = newTag ? `#${newTag}` : '';
    let files = 0, hits = 0;
    for (const n of state.notes.filter((x) => x.md)) {
      let res;
      try { res = await window.api.readNote(n.rel); } catch (_) { continue; }
      if (!res.ok) continue;
      const count = (res.content.match(re) || []).length;
      if (!count) continue;
      const w = await window.api.writeNote(n.rel, res.content.replace(re, () => replacement));
      if (!w.ok) continue;
      files++;
      hits += count;
    }
    await refreshNotes();
    scheduleTaskIndexRefresh();
    toast(hits
      ? `已${newTag ? '重命名' : '删除'}标签 #${oldTag}${newTag ? ' → #' + newTag : ''}：${hits} 处 / ${files} 个笔记`
      : '没有找到匹配的标签');
  }

  /* ======================================================================
   * 打开 / 保存笔记
   * ==================================================================== */

  async function openNote(rel, opts) {
    opts = opts || {};
    // 任务面板 / 周计划 / 时间轴等入口：从其它主视图切回笔记，保证编辑器可见
    if (state.mainView !== 'notes') setMainView('notes');
    const same = state.current && state.current.rel === rel;
    if (same && opts.line != null) { jumpToLine(opts.line); return; }  // 已打开：只跳到目标行
    if (same && !opts.force) return;

    // 离开当前笔记：若有外部修改冲突，先确认是否保存
    if (state.current && !same && state.current.dirty && state.externalDirty) {
      leaveConfirmModal(
        async () => { if (await saveNow(true)) openNote(rel, opts); },
        () => { state.current.dirty = false; state.externalDirty = false; openNote(rel, opts); }
      );
      return;
    }

    if (saveTimerPending()) saveNow();
    const res = await window.api.readNote(rel);
    if (!res.ok) { toast('无法打开笔记：' + res.error); return; }

    const daily = isDailyRel(rel);
    state.current = { rel, isDaily: daily, dateStr: daily ? baseName(rel) : null, mtimeMs: res.mtimeMs, dirty: false };
    state.suppressDocEvent = true;  // setDoc 属于加载而非编辑，不触发脏标记
    Ed.set(res.content);
    state.suppressDocEvent = false;
    if (Ed.setNoteDir) Ed.setNoteDir(relDir(rel));
    state.externalDirty = false;

    setCrumb(rel);
    if (daily) {
      state.raSel = state.current.dateStr;
      // 日期跨视图一致：右栏月历 / 月历视图跟随当前打开的日期
      const d = new Date(state.current.dateStr + 'T12:00:00');
      state.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      state.calvMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      state.calvSel = state.current.dateStr;
      renderCalendar();
      renderAgenda();
    }
    updateWeekRow();
    refreshPreview();
    refreshOutline();
    refreshBacklinks();
    updateStatus();
    renderSidebar();
    renderWeekBar(); // 立即同步周条选中日（否则蓝色高亮延迟或不更新）
    window.api.setSettings({ lastNote: rel });

    if (opts.line) setTimeout(() => jumpToLine(opts.line), 30);
  }

  async function openDaily(dateStr) {
    const r = await window.api.openDaily(dateStr);
    if (r.ok) {
      await refreshNotes();
      await openNote(r.rel, { force: true });
    } else {
      toast('无法创建每日笔记：' + r.error);
    }
  }

  async function openToday() { await openDaily(todayStr()); }

  async function openWiki(title) {
    const t = String(title || '').trim();
    if (!t) return;
    const low = t.toLowerCase();
    const hit = state.notes.find((n) =>
      n.md && ((n.title || '').toLowerCase() === low || baseName(n.rel).toLowerCase() === low));
    if (hit) return openNote(hit.rel);
    const r = await window.api.createNote('Notes', t, `# ${t}\n\n`);
    if (r.ok) {
      await refreshNotes();
      await openNote(r.rel, { force: true });
      toast(`已创建笔记「${t}」`);
    } else {
      toast('创建笔记失败：' + r.error);
    }
  }

  function displayRel(rel) {
    return String(rel || '').replace(/^Calendar[/]/, '日历/');
  }
  function setCrumb(rel) {
    const parts = rel.split('/');
    // Calendar 为目录名（保持数据结构），展示层统一映射为中文
    if (parts[0] === 'Calendar') parts[0] = '日历';
    const file = parts.pop();
    const here = escapeHtml(baseName(file));
    const pathHtml = parts.map((p) => `<span>${escapeHtml(p)}</span>`).join('<span class="c-sep">/</span>');
    $('#crumb').innerHTML = pathHtml + (parts.length ? '<span class="c-sep">/</span>' : '') + `<span class="c-here">${here}</span>`;
  }

  /* ---- 保存 ---- */

  const debouncedSave = debounce(() => saveNow(), 800);
  const debouncedPreview = debounce(() => refreshPreview(), 220);

  // 保存每日笔记后延迟刷新笔记列表：空文件 ↔ 有内容 会改变日历"有笔记"标记
  let notesRefreshTimer = null;
  function scheduleNotesRefresh() {
    clearTimeout(notesRefreshTimer);
    notesRefreshTimer = setTimeout(refreshNotes, 800);
  }

  function markDirty() {
    if (!state.current) return;
    state.current.dirty = true;
    setSaveState('editing');
    debouncedSave();
    updateStatus();
  }

  function saveTimerPending() { return debouncedSave.pending(); }

  async function saveNow(force) {
    if (!state.current) return false;
    if (!state.current.dirty) return true;
    const c = state.current;
    if (state.externalDirty && !force) {
      // 外部有改动：暂停自动覆盖保存，离开（切换/关闭）时确认
      setSaveState('ext');
      return false;
    }
    c.dirty = false;
    setSaveState('saving');
    const res = await window.api.writeNote(c.rel, Ed.get());
    if (res.ok) {
      c.mtimeMs = res.mtimeMs;
      state.externalDirty = false;
      setSaveState('saved');
      scheduleTaskIndexRefresh();
      if (isDailyRel(c.rel)) scheduleNotesRefresh();
      return true;
    }
    c.dirty = true;
    toast('保存失败：' + res.error);
    setSaveState('unsaved');
    return false;
  }

  function setSaveState(s) {
    const el = $('#save-state');
    el.classList.remove('saving');
    if (s === 'editing') { el.textContent = '编辑中…'; el.classList.add('saving'); }
    else if (s === 'saving') { el.textContent = '保存中…'; el.classList.add('saving'); }
    else if (s === 'saved') {
      const d = new Date();
      el.textContent = `已保存 ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    } else if (s === 'unsaved') el.textContent = '有未保存的修改';
    else if (s === 'ext') el.textContent = '外部已修改 · 离开时确认';
    else el.textContent = '就绪';
  }

  function updateStatus() {
    const text = Ed.get();
    const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    const words = (text.match(/[A-Za-z0-9][A-Za-z0-9'_-]*/g) || []).length;
    $('#word-count').textContent = `${cjk + words} 词 · ${text.length} 字符`;
  }

  /* ---- 外部修改 ---- */

  let vaultChangedTimer = null;
  function onVaultChanged() {
    clearTimeout(vaultChangedTimer);
    vaultChangedTimer = setTimeout(async () => {
      const curRel = state.current && state.current.rel;
      await refreshNotes();
      if (!curRel || !state.byRel.has(curRel)) {
        if (curRel && !state.byRel.has(curRel)) {
          state.current = null;
          editor.value = '';
          await openToday();
        }
        return;
      }
      const res = await window.api.readNote(curRel);
      if (!res.ok) return;
      if (res.mtimeMs === state.current.mtimeMs) return; // 自己刚写入的，不算外部修改
      if (res.content !== editor.value) {
        if (state.current.dirty) {
          // 有未保存修改：不打断编辑，仅弱提示；离开（切换/关闭）时再确认
          state.externalDirty = true;
          setSaveState('ext');
        } else {
          state.suppressDocEvent = true;
          Ed.set(res.content);
          state.suppressDocEvent = false;
          state.current.mtimeMs = res.mtimeMs;
          refreshPreview();
          refreshOutline();
          refreshBacklinks();
          updateStatus();
        }
      }
    }, 260);
  }

  /* ======================================================================
   * 派生刷新：大纲（Live Preview 即视图，无需独立预览层）
   * ==================================================================== */

  function refreshPreview() {
    if (!state.current) return;
    const gen = ++state.renderGen;
    const { outline } = window.NPMarkdown.render(Ed.get(), {
      noteDir: relDir(state.current.rel),
    });
    state.outline = outline;
    if (gen === state.renderGen) refreshOutline();
  }

  function jumpToLine(line) {
    Ed.revealLine(line);
  }

  function refreshOutline() {
    const box = $('#rb-outline');
    box.innerHTML = '';
    if (!state.outline.length) {
      box.innerHTML = '<div class="rb-empty">没有标题<br/>输入 # 开头的行生成大纲</div>';
      return;
    }
    for (const h of state.outline) {
      const b = document.createElement('button');
      b.className = `outline-item lv${Math.min(h.level, 6)}`;
      b.textContent = h.text;
      b.onclick = () => jumpToLine(h.line);
      box.appendChild(b);
    }
  }

  async function refreshBacklinks() {
    const box = $('#rb-backlinks');
    if (!state.current) { box.innerHTML = ''; return; }
    const title = noteTitle(state.byRel.get(state.current.rel));
    const links = await window.api.backlinks(title);
    box.innerHTML = '';
    if (!links.length) {
      box.innerHTML = '<div class="rb-empty">暂无反向链接<br/>用 [[笔记标题]] 引用本篇</div>';
      return;
    }
    for (const l of links) {
      const n = state.byRel.get(l.rel);
      const b = document.createElement('button');
      b.className = 'backlink-item';
      b.innerHTML = `<div class="bl-title">${escapeHtml(noteTitle(n))}</div>` +
        `<div class="bl-text">${escapeHtml(l.text)}</div>`;
      b.onclick = () => openNote(l.rel, { line: l.line });
      box.appendChild(b);
    }
  }

  /* ======================================================================
   * 编辑器适配器：优先 CodeMirror 6（cm-bundle.js），否则回退 textarea
   * ==================================================================== */

  function initEditor() {
    const textarea = editor;

    if (!window.NPCM) {
      // ---- textarea 兜底 ----
      Ed = {
        kind: 'textarea',
        get: () => textarea.value,
        set: (t) => { textarea.value = t; },
        getLine: (n) => {
          const L = textarea.value.split('\n');
          return n >= 1 && n <= L.length ? L[n - 1] : null;
        },
        replaceLine: (n, text) => {
          const L = textarea.value.split('\n');
          if (n < 1 || n > L.length) return;
          L[n - 1] = text;
          textarea.value = L.join('\n');
        },
        cursorLines: () => {
          const v = textarea.value;
          const s = textarea.selectionStart, e = textarea.selectionEnd;
          const first = v.slice(0, Math.min(s, e)).split('\n').length;
          const last = v.slice(0, Math.max(s, e)).split('\n').length;
          const out = [];
          for (let i = first; i <= last; i++) out.push(i);
          return out;
        },
        hasSelection: () => textarea.selectionStart !== textarea.selectionEnd,
        selectedText: () => textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
        revealLine: (n) => {
          const v = textarea.value;
          let off = 0;
          const lines = v.split('\n');
          for (let i = 0; i < n - 1 && i < lines.length; i++) off += lines[i].length + 1;
          textarea.focus();
          textarea.setSelectionRange(off, off);
          const tmp = textarea.scrollTop;
          textarea.blur();
          textarea.focus();
          textarea.scrollTop = tmp;
        },
        focus: () => textarea.focus(),
      };
      textarea.addEventListener('input', () => { markDirty(); debouncedPreview(); });
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
          if (window.NPEditor.handleEnter(textarea)) e.preventDefault();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          window.NPEditor.handleTab(textarea, e.shiftKey);
          markDirty();
          debouncedPreview();
        }
      });
      return;
    }

    // ---- CodeMirror 6 ----
    textarea.style.display = 'none';
    $('#cm-host').hidden = false;
    const prov = {
      titles: () => state.notes.filter((n) => n.md).map((n) => ({ title: noteTitle(n), exists: true })),
      tags: () => state.tagsCache.map((t) => t.tag),
      mentions: () => state.mentionsCache.map((m) => m.name),
    };
    const api = window.NPCM.createEditor($('#cm-host'), {
      doc: '',
      placeholder: '开始书写……支持 Markdown：- [ ] 任务、[-] 废弃、>日期、14:00-15:30 时间段、[[双链]]、#标签、==高亮==',
      onDocChanged: () => {
        if (state.suppressDocEvent) return;
        markDirty();
        debouncedPreview();
      },
      onTaskToggle: (lineNo, checked) => applyTaskToggle(lineNo, checked),
      completions: prov,
    });
    window.__edApi = api;
    Ed = {
      kind: 'cm',
      get: () => api.getDoc(),
      set: (t) => api.setDoc(t),
      getLine: (n) => api.getLine(n),
      replaceLine: (n, t) => api.replaceLine(n, t),
      cursorLines: () => api.cursorLines(),
      hasSelection: () => api.hasSelection(),
      selectedText: () => api.selectedText(),
      revealLine: (n) => api.revealLine(n),
      focus: () => api.focus(),
      setNoteDir: (d) => api.setNoteDir(d),
    };
  }

  /* ======================================================================
   * 任务勾选统一路径：复选框点击 / Ctrl+L / 编辑器内点击都走这里
   * 处理 @done(日期) 追加与移除、循环任务的下一次排期
   * ==================================================================== */

  const RE_REC = /\b(?:every\s+(?:(\d+)\s+)?(day|week|month|year)s?)\b|\b每(?:天|日|周|星期|月|年)\b|\b每\s*(\d+)\s*(?:天|周|星期|月|年)\b/i;

  function parseRecurrence(text) {
    const m = text.match(RE_REC);
    if (!m) return null;
    const s = m[0].toLowerCase();
    if (s.startsWith('every')) return { n: m[1] ? parseInt(m[1], 10) : 1, unit: m[2] };
    const cn = s.replace(/^每\s*/u, '');
    if (/^\d/.test(cn)) {
      const n = parseInt(cn.match(/\d+/)[0], 10);
      const u = cn.match(/[天日周星期月年]/u);
      const unit = u ? u[0] : '天';
      return { n, unit: '天日'.includes(unit) ? 'day' : ('周星期'.includes(unit) ? 'week' : (unit === '月' ? 'month' : 'year')) };
    }
    if (cn.includes('每天') || cn.includes('每日')) return { n: 1, unit: 'day' };
    if (cn.includes('周') || cn.includes('星期')) return { n: 1, unit: 'week' };
    if (cn.includes('月')) return { n: 1, unit: 'month' };
    if (cn.includes('年')) return { n: 1, unit: 'year' };
    return { n: 1, unit: 'day' };
  }

  function computeNextDate(baseStr, rec) {
    const [y, mo, d] = baseStr.split('-').map(Number);
    const dt = new Date(y, mo - 1, d);
    if (rec.unit === 'day') dt.setDate(dt.getDate() + rec.n);
    else if (rec.unit === 'week') dt.setDate(dt.getDate() + 7 * rec.n);
    else if (rec.unit === 'month') dt.setMonth(dt.getMonth() + rec.n);
    else dt.setFullYear(dt.getFullYear() + rec.n);
    return todayStr(dt);
  }

  /** 任务是否落在某天：一次性=当天；连续(>起 ~ 止)=区间内；周期(未完成)=按周期展开 */
  function taskOccursOn(t, ds) {
    if (!t.scheduled) return false;
    if (t.endDate) return ds >= t.scheduled && ds <= t.endDate;
    if (ds === t.scheduled) return true;
    if (t.recurring && !t.done && ds > t.scheduled) {
      const rec = parseRecurrence(t.text);
      if (!rec) return false;
      let cur = t.scheduled;
      for (let k = 0; k < 400 && cur < ds; k++) cur = computeNextDate(cur, rec);
      return cur === ds;
    }
    return false;
  }

  /** 切换一行任务文本的完成状态；返回 {line, done, rest}，非任务行返回 null。
   *  勾选标记：' ' 待办 / 'x' 完成 / '-' 废弃（废弃不进任务统计） */
  function composeToggledLine(lineText, target) {
    const m = lineText.match(/^(\s*)([-*+]\s+)(\[([ xX-])\]\s*)?(.*)$/);
    if (!m) return null;
    const indent = m[1], marker = m[2], box = m[4], rest = m[5] || '';
    const curCancelled = box === '-';
    const curDone = (box !== undefined && box !== ' ' && box !== '-') || /@done/i.test(rest);
    // target=null：待办→完成；完成/废弃→待办
    const done = target === null ? (!curDone && !curCancelled) : !!target;
    let text = rest.replace(/\s*@done(?:\([^)]*\))?/gi, '').replace(/\s+$/, '');
    if (done) text += ` @done(${todayStr()})`;
    return { line: `${indent}${marker}${done ? '[x] ' : '[ ] '}${text}`, done, rest };
  }

  /** 标记 / 取消废弃任务（[-]）。废弃任务仅作记录，不计入待办统计 */
  function applyTaskCancel(lineNo, cancel) {
    const lineText = Ed.getLine(lineNo);
    if (lineText == null) return;
    const m = lineText.match(/^(\s*)([-*+]\s+)(\[([ xX-])\]\s*)?(.*)$/);
    if (!m) return;
    const text = (m[5] || '').replace(/\s*@done(?:\([^)]*\))?/gi, '').replace(/\s+$/, '');
    const line = cancel
      ? `${m[1]}${m[2]}[-] ${text}`
      : `${m[1]}${m[2]}[ ] ${text}`;
    Ed.replaceLine(lineNo, line);
    markDirty();
    refreshPreview();
    saveNow(true);
    scheduleTaskIndexRefresh();
  }

  /** 循环任务：完成时在下一个周期日期的每日笔记里重建 */
  function rebuildRecurring(lineText) {
    const rec = parseRecurrence(lineText);
    if (!rec) return;
    const sched = (lineText.match(/>\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
    const base = (sched && sched >= todayStr()) ? sched : todayStr();
    const next = computeNextDate(base, rec);
    const bodyNext = (lineText.replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, ''))
      .replace(/\s*@done(?:\([^)]*\))?/gi, '')
      .replace(/>\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const marker = lineText.match(/^\s*([-*+])\s+/);
    window.api.dailyAppend(next, `${marker ? marker[1] : '-'} [ ] ${bodyNext} >${next}`)
      .then((r) => {
        if (r.ok) {
          toast(`🔁 循环任务已排到 ${next}`, { label: '打开', run: () => openDaily(next) });
          scheduleTaskIndexRefresh();
        }
      });
  }

  /** 切换任意笔记中第 line 行任务的完成状态（周计划等非当前笔记场景用） */
  async function toggleTaskInFile(rel, line) {
    const res = await window.api.readNote(rel);
    if (!res.ok) { toast('读取失败：' + res.error); return; }
    const lines = res.content.split('\n');
    const idx = line - 1;
    if (idx < 0 || idx >= lines.length) return;
    const composed = composeToggledLine(lines[idx], null);
    if (!composed) return;
    lines[idx] = composed.line;
    const w = await window.api.writeNote(rel, lines.join('\n'));
    if (!w.ok) { toast('保存失败：' + w.error); return; }
    if (composed.done) rebuildRecurring(composed.line);
    scheduleTaskIndexRefresh();
  }

  function applyTaskToggle(lineNo, target = null) {
    const lineText = Ed.getLine(lineNo);
    if (lineText == null) return;
    const composed = composeToggledLine(lineText, target);
    if (!composed) return;

    // 循环任务：完成时在下一个周期日期的每日笔记里重建
    if (composed.done) rebuildRecurring(lineText);

    Ed.replaceLine(lineNo, composed.line);
    markDirty();
    refreshPreview();
    saveNow(true);
    scheduleTaskIndexRefresh();
  }

  function toggleTasksAtCursor() {
    for (const ln of Ed.cursorLines()) applyTaskToggle(ln);
  }

  /* ---- 选中内容快速生成待办 ---- */

  /** 选中各行转为待办任务：普通行/列表行加 `- [ ] `，已是任务行保持不变 */
  function convertSelectionToTasks() {
    for (const ln of Ed.cursorLines()) {
      const text = Ed.getLine(ln);
      if (text == null || !text.trim()) continue;
      if (/^\s*[-*+]\s+\[[ xX]\]/.test(text)) continue;
      const m = text.match(/^(\s*)([-*+]\s+)(.*)$/);
      Ed.replaceLine(ln, m ? `${m[1]}${m[2]}[ ] ${m[3]}` : `- [ ] ${text.trim()}`);
    }
    markDirty();
    refreshPreview();
    saveNow(true);
    scheduleTaskIndexRefresh();
    toast('已转为待办任务');
  }

  /** 选中文本追加到今日每日笔记：每行一条 `- [ ] `（会剥掉原有的列表/勾选标记） */
  async function addSelectionToToday(rawText) {
    const rows = String(rawText || '').split('\n')
      .map((s) => s.replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?/, '').replace(/^#{1,6}\s+/, '').trim())
      .filter(Boolean);
    if (!rows.length) return;
    for (const r of rows) {
      const res = await window.api.dailyAppend(todayStr(), `- [ ] ${r}`);
      if (!res.ok) { toast('添加失败：' + res.error); return; }
    }
    toast(rows.length > 1 ? `已添加 ${rows.length} 条到今日待办` : '已添加到今日待办', {
      label: '打开',
      run: () => openDaily(todayStr()),
    });
    scheduleTaskIndexRefresh();
  }

  /** 编辑器里选中内容右键 → 快速生成待办；光标停在任务行上 → 任务操作菜单 */
  function selectionContext(ev) {
    if (overlayOpen() || !Ed) return;
    const t = ev.target;
    let text = '';
    let inEditor = false;
    if (t.closest && t.closest('#cm-host')) {
      text = Ed.selectedText ? Ed.selectedText() : '';
      inEditor = true;
    } else if (t === editor) {
      text = editor.value.slice(editor.selectionStart, editor.selectionEnd);
      inEditor = true;
    }
    if (!inEditor) return; // 非编辑区（如月历）使用浏览器默认菜单
    ev.preventDefault();
    if (!text.trim()) {
      // 无选区：光标所在行是任务 → 任务操作菜单（完成 / 废弃）
      const lines = Ed.cursorLines();
      if (lines.length !== 1) return;
      const lineText = Ed.getLine(lines[0]) || '';
      if (/^\s*[-*+]\s+\[([ xX-])\]/.test(lineText)) {
        const cancelled = /^\s*[-*+]\s+\[-\]/.test(lineText);
        showCtx(ev.clientX, ev.clientY, [
          { label: '切换完成 / 未完成', key: 'Ctrl+L', onClick: () => applyTaskToggle(lines[0]) },
          cancelled
            ? { label: '取消废弃（恢复为待办）', onClick: () => applyTaskCancel(lines[0], false) }
            : { label: '标记为废弃任务', onClick: () => applyTaskCancel(lines[0], true) },
        ]);
      }
      return;
    }
    const items = [];
    if (inEditor) items.push({ label: '转为待办任务', key: 'Ctrl+L', onClick: () => convertSelectionToTasks() });
    items.push({ label: '添加为今日待办', onClick: () => addSelectionToToday(text) });
    showCtx(ev.clientX, ev.clientY, items);
  }

  /* ======================================================================
   * 任务总览 + 周视图（拖拽排期）
   * ==================================================================== */

  let taskIndexTimer = null;
  async function loadTaskIndex() {
    try {
      state.taskIndex = await window.api.tasksAll();
    } catch (_) { return; }
    renderWeekBar();
    if (state.rightTab === 'tasks') renderTasksPanel();
    if (state.rightTab === 'agenda') renderAgenda();
    if (state.mainView === 'week') renderWeekPlan();
    checkReminders();
  }
  function scheduleTaskIndexRefresh() {
    clearTimeout(taskIndexTimer);
    taskIndexTimer = setTimeout(loadTaskIndex, 700);
  }

  /* ======================================================================
   * 任务提醒
   *  - 每日提醒：当天到期（排期今天 / 每日笔记隐式今天 / 循环命中）+ 未排期 +
   *    过期未完成的任务，在配置的每日提醒时间（默认 17:00）汇总提醒一条；
   *  - 提前提醒：带开始时间的任务在「开始时间 − 提前分钟数」（默认 15 分钟）提醒；
   *  - 已完成 / 废弃任务不提醒；触发按天去重；配置存 localStorage（设备级）。
   * ==================================================================== */

  const REMINDER_CFG_KEY = 'np.reminders';
  const REMINDER_FIRED_KEY = 'np.reminders.fired';

  function reminderConfig() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(REMINDER_CFG_KEY) || '{}') || {}; } catch (_) { c = {}; }
    return {
      dailyEnabled: c.dailyEnabled !== false,
      dailyTime: /^\d{1,2}:\d{2}$/.test(c.dailyTime || '') ? c.dailyTime : '17:00',
      leadEnabled: c.leadEnabled !== false,
      leadMinutes: Number.isFinite(c.leadMinutes) ? Math.max(0, Math.min(240, c.leadMinutes)) : 15,
    };
  }
  function saveReminderConfig(patch) {
    const merged = Object.assign(reminderConfig(), patch);
    try { localStorage.setItem(REMINDER_CFG_KEY, JSON.stringify(merged)); } catch (_) { /* 忽略 */ }
  }
  function reminderFiredToday(key) {
    let map = {};
    try { map = JSON.parse(localStorage.getItem(REMINDER_FIRED_KEY) || '{}') || {}; } catch (_) { map = {}; }
    return map[key] === todayStr();
  }
  function markReminderFired(key) {
    let map = {};
    try { map = JSON.parse(localStorage.getItem(REMINDER_FIRED_KEY) || '{}') || {}; } catch (_) { map = {}; }
    map[key] = todayStr();
    // 只保留近 7 天的记录
    const cutoff = todayStr(new Date(Date.now() - 7 * 86400000));
    for (const k of Object.keys(map)) {
      if (!(map[k] >= cutoff)) delete map[k];
    }
    try { localStorage.setItem(REMINDER_FIRED_KEY, JSON.stringify(map)); } catch (_) { /* 忽略 */ }
  }

  /** 任务在「今天」的生效日期：显式排期 > 每日笔记隐式日期 > null（未排期） */
  function reminderEffectiveDate(t) {
    if (t.scheduled) return t.scheduled;
    const m = (t.rel || '').match(/^Calendar\/(\d{4}-\d{2}-\d{2})\.md$/);
    return m ? m[1] : null;
  }

  function showReminder(title, body, onOpen) {
    let native = false;
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const n = new Notification(title, { body, silent: false });
        n.onclick = () => {
          try { window.focus(); } catch (_) { /* 忽略 */ }
          onOpen();
          n.close();
        };
        native = true;
      }
    } catch (_) { /* 忽略，走应用内 toast */ }
    toast(`🔔 ${title}${body ? ' — ' + body : ''}`, { label: '查看', run: onOpen });
    return native;
  }

  function checkReminders() {
    if (!state.taskIndex.length) return;
    const cfg = reminderConfig();
    const now = new Date();
    const today = todayStr(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();

    // 每日提醒：一条汇总（当天到期 + 未排期 + 过期未完成）
    if (cfg.dailyEnabled && nowMin >= hmToMin(cfg.dailyTime) && !reminderFiredToday('daily#' + today)) {
      const due = [];
      for (const t of state.taskIndex) {
        if (t.done) continue;
        const eff = reminderEffectiveDate(t);
        const occursToday = taskOccursOn(t, today) || t.rel === `Calendar/${today}.md`;
        const undated = !eff && !occursToday;
        const overdue = !!eff && eff < today && !occursToday;
        if (occursToday || undated || overdue) due.push(t);
      }
      if (due.length) {
        markReminderFired('daily#' + today);
        const head = due.slice(0, 5).map((t) => cleanTaskText(t.text)).join('；');
        const more = due.length > 5 ? ` 等 ${due.length} 项` : '';
        showReminder('今日任务提醒', `${head}${more}`, () => openToday());
      }
    }

    // 提前提醒：带开始时间且今天发生的任务，开始前 N 分钟提醒（每个任务每天最多一次）
    if (cfg.leadEnabled) {
      for (const t of state.taskIndex) {
        if (t.done) continue;
        const occursToday = taskOccursOn(t, today) || t.rel === `Calendar/${today}.md`;
        if (!occursToday) continue;
        const tm = parseTaskTime(t.text);
        if (!tm || !tm.start) continue;
        const startMin = hmToMin(tm.start);
        const fireMin = startMin - cfg.leadMinutes;
        if (nowMin < fireMin || nowMin > startMin) continue; // 未到 / 已错过开始
        const key = `lead#${t.rel}#${t.line}#${today}`;
        if (reminderFiredToday(key)) continue;
        markReminderFired(key);
        showReminder(`${tm.start} ${cleanTaskText(t.text)}`, `${cfg.leadMinutes} 分钟后开始`, () => openNote(t.rel, { line: t.line }));
      }
    }
  }

  let reminderTimer = null;
  function startReminderLoop() {
    if (reminderTimer) clearInterval(reminderTimer);
    checkReminders();
    reminderTimer = setInterval(checkReminders, 30000);
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    } catch (_) { /* 忽略 */ }
  }

  function renderWeekBar() {
    const days = $('#wb-days');
    if (!days) return;
    days.innerHTML = '';
    // 每天计数：一次性=当天；连续区间内；周期任务按周期展开
    const dayDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(state.weekStart);
      d.setDate(d.getDate() + i);
      dayDates.push(todayStr(d));
    }
    const counts = {};
    for (const ds of dayDates) {
      counts[ds] = state.taskIndex.filter((t) => !t.done && taskOccursOn(t, ds)).length;
    }
    const cur = state.current && state.current.dateStr;
    const today = todayStr();
    for (let i = 0; i < 7; i++) {
      const d = new Date(state.weekStart);
      d.setDate(d.getDate() + i);
      const ds = todayStr(d);
      const hol = holOf(ds);
      const cell = document.createElement('div');
      cell.className = 'wb-day' + (ds === today ? ' today' : '') + (cur === ds ? ' selected' : '');
      cell.innerHTML = `<span class="wb-week">${WEEKDAYS[d.getDay()]}</span>` +
        `<span class="wb-num">${d.getMonth() + 1}/${d.getDate()}${hol ? `<span class="hol-dot ${hol.off ? 'off' : 'work'}"></span>` : ''}</span>` +
        (hol && hol.off ? `<span class="wb-hol">${hol.name}</span>` : '') +
        (counts[ds] ? `<span class="wb-badge" title="当日待办">${counts[ds]}</span>` : '');
      cell.title = ds + weekdayCN(ds) + holTitle(ds) + '（点击打开每日笔记，可拖入任务改期）';
      cell.onclick = () => openDaily(ds);
      cell.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        cell.classList.add('drop');
      });
      cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
      cell.addEventListener('drop', (ev) => onWeekDrop(ev, cell, ds));
      days.appendChild(cell);
    }
  }

  async function onWeekDrop(ev, cell, ds) {
    ev.preventDefault();
    cell.classList.remove('drop');
    const raw = ev.dataTransfer.getData('text/np-task');
    if (!raw) return;
    let task;
    try { task = JSON.parse(raw); } catch (_) { return; }
    const r = await window.api.rescheduleTask(task.rel, task.line, ds);
    if (!r.ok) { toast('改期失败：' + r.error); return; }
    toast(`已改期到 ${ds}`);
    scheduleTaskIndexRefresh();
    if (state.current && state.current.rel === task.rel && !state.current.dirty) {
      const res = await window.api.readNote(task.rel);
      if (res.ok) {
        state.suppressDocEvent = true;
        Ed.set(res.content);
        state.suppressDocEvent = false;
        refreshPreview();
      }
    }
  }

  /* ---- 任务分组折叠（已完成的任务默认折叠，状态存 localStorage）---- */

  const TASK_GROUP_KEY = 'np.taskGroups.collapsed';
  let taskGroupsCollapsed = null;

  function taskGroupCollapsed(label) {
    if (taskGroupsCollapsed === null) {
      try { taskGroupsCollapsed = JSON.parse(localStorage.getItem(TASK_GROUP_KEY) || '{}'); }
      catch (_) { taskGroupsCollapsed = {}; }
      if (!taskGroupsCollapsed || typeof taskGroupsCollapsed !== 'object') taskGroupsCollapsed = {};
    }
    if (label in taskGroupsCollapsed) return !!taskGroupsCollapsed[label];
    return label === '已完成'; // 默认：已完成折叠，其余展开
  }
  function toggleTaskGroup(label) {
    if (taskGroupsCollapsed === null) taskGroupCollapsed(label);
    taskGroupsCollapsed[label] = !taskGroupCollapsed(label); // 以含默认值的判定为准
    try { localStorage.setItem(TASK_GROUP_KEY, JSON.stringify(taskGroupsCollapsed)); } catch (_) { /* 忽略 */ }
  }

  function renderTasksPanel() {
    const box = $('#rb-tasks');
    box.innerHTML = '';
    const today = todayStr();
    const open = state.taskIndex.filter((t) => !t.done);
    const done = state.taskIndex.filter((t) => t.done);
    const groups = [
      { label: '今天', items: open.filter((t) => t.scheduled === today) },
      { label: '已过期', items: open.filter((t) => t.scheduled && t.scheduled < today).sort((a, b) => a.scheduled.localeCompare(b.scheduled)) },
      { label: '已排期', items: open.filter((t) => t.scheduled && t.scheduled > today).sort((a, b) => a.scheduled.localeCompare(b.scheduled)) },
      { label: '未排期', items: open.filter((t) => !t.scheduled).slice(0, 60) },
      { label: '已完成', items: done.sort((a, b) => (b.doneDate || '').localeCompare(a.doneDate || '')).slice(0, 30) },
    ];
    const clean = (t) => t.replace(/^[-*+]\s+\[[ xX]\]\s*/, '')
      .replace(/\s*@\w+(?:\([^)]*\))?/gi, '')
      .replace(/>\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/\s{2,}/g, ' ').trim();
    let any = false;
    for (const g of groups) {
      if (!g.items.length) continue;
      any = true;
      const collapsed = taskGroupCollapsed(g.label);
      const h = document.createElement('div');
      h.className = 'rt-group' + (collapsed ? ' collapsed' : '');
      h.innerHTML = `<span class="rt-arrow">${collapsed ? '▸' : '▾'}</span>${g.label} · ${g.items.length}`;
      h.title = collapsed ? '点击展开' : '点击折叠';
      h.onclick = () => { toggleTaskGroup(g.label); renderTasksPanel(); };
      box.appendChild(h);
      if (collapsed) continue;
      for (const t of g.items) {
        const el = document.createElement('div');
        el.className = 'task-item' + (t.done ? ' done' : '');
        el.draggable = !t.done;
        el.innerHTML = `<div class="ti-text">${t.recurring ? '🔁 ' : ''}${escapeHtml(clean(t.text))}</div>` +
          `<div class="ti-meta">${t.scheduled ? `<span>📅 ${t.scheduled}</span>` : ''}` +
          `${t.doneDate ? `<span>✓ ${t.doneDate}</span>` : ''}` +
          `<span class="ti-src">${escapeHtml(t.title || t.name)}</span></div>`;
        el.title = `${t.rel} 第 ${t.line} 行${t.done ? '' : '（拖到上方周条可改期）'}`;
        el.onclick = () => openNote(t.rel, { line: t.line });
        if (el.draggable) {
          el.addEventListener('dragstart', (ev) => {
            ev.dataTransfer.setData('text/np-task', JSON.stringify({ rel: t.rel, line: t.line }));
            ev.dataTransfer.effectAllowed = 'copy';
          });
        }
        box.appendChild(el);
      }
    }
    if (!any) box.innerHTML = '<div class="rb-empty">没有任务<br/>用 - [ ] 创建任务</div>';
  }

  /* ======================================================================
   * 主界面月历 / 年视图 + 时间轴（时间块规划）
   * ==================================================================== */

  function setMainView(mode) {
    state.mainView = mode === 'year' ? 'month' : mode;
    state.calvMode = mode === 'year' ? 'year' : 'month';
    document.querySelectorAll('#main-seg button').forEach((b) => b.classList.toggle('active', b.dataset.main === mode));
    const notes = mode === 'notes';
    const week = mode === 'week';
    $('#editor-wrap').hidden = !notes;
    $('#weekrow').hidden = !(notes && state.current && state.current.isDaily);
    $('#weekbar').hidden = !notes;
    $('#calview').hidden = notes || week;
    $('#weekplan').hidden = !week;
    // 右栏（月历+日程）只在「笔记」视图展示，其余视图铺满整个区域
    $('#rightbar').hidden = !notes;
    if (week) {
      if (!state.wpWeekStart) state.wpWeekStart = startOfWeek(new Date());
      loadTaskIndex().then(() => renderWeekPlan());
    } else if (!notes) {
      if (!state.calvMonth) state.calvMonth = new Date();
      if (!state.calvYear) state.calvYear = state.calvMonth.getFullYear();
      renderCalView();
    }
  }

  async function loadCalEvents(rangeStart, rangeEnd) {
    const key = rangeStart + '..' + rangeEnd;
    if (state.calEventsCache.key === key) return state.calEventsCache.list;
    try {
      state.calEventsCache = { key, list: await window.api.calEvents(rangeStart, rangeEnd) || [] };
    } catch (_) {
      state.calEventsCache = { key, list: [] };
    }
    return state.calEventsCache.list;
  }

  /* ======================================================================
   * 周计划：七日网格 + 周目标（Notes/周计划/YYYY-Wnn.md）
   * ==================================================================== */

  function startOfWeek(d) {
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    s.setDate(s.getDate() - s.getDay()); // 回到周日
    return s;
  }

  /** 周计划的周标签：取本周三（周中）所属 ISO 周，与「周日 ~ 周六」的显示区间对应 */
  function wpWeekInfo() {
    const mid = new Date(state.wpWeekStart);
    mid.setDate(mid.getDate() + 3);
    return isoWeekInfo(mid);
  }

  /** ISO 周号与 ISO 年份（以本周周四所在年为准） */
  function isoWeekInfo(d) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() + 3 - (t.getDay() + 6) % 7); // 本周的周四
    const week1Thu = new Date(t.getFullYear(), 0, 4);
    week1Thu.setDate(week1Thu.getDate() + 3 - (week1Thu.getDay() + 6) % 7);
    const week = 1 + Math.round((t - week1Thu) / (7 * 86400000));
    return { year: t.getFullYear(), week };
  }

  const weekPlanRel = (year, week) => `Notes/周计划/${year}-W${pad2(week)}.md`;

  function wpClean(text) {
    return (text || '').replace(/^[-*+]\s+\[[ xX]\]\s*/, '')
      .replace(/^\d{1,2}:\d{2}(?:\s*(?:-|–|—|~|至|到)\s*\d{1,2}:\d{2})?\s*/, '')
      .replace(/\s*@\w+(?:\([^)]*\))?/gi, '')
      .replace(/>\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/\s{2,}/g, ' ').trim();
  }

  async function renderWeekPlan() {
    if (state.mainView !== 'week' || !state.wpWeekStart) return;
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(state.wpWeekStart);
      d.setDate(d.getDate() + i);
      days.push(d);
    }
    const info = wpWeekInfo();
    const first = todayStr(days[0]);
    const last = todayStr(days[6]);
    ensureHolYears([days[0].getFullYear(), days[6].getFullYear()]); // 跨年周（ISO 周）两侧年份都要
    $('#wp-title').textContent = `${info.year}年第${info.week}周 · ${days[0].getMonth() + 1}/${days[0].getDate()} – ${days[6].getMonth() + 1}/${days[6].getDate()}`;
    loadWeekGoal(info.year, info.week);

    const events = await loadCalEvents(first, last);
    if (state.mainView !== 'week') return; // 异步期间切走
    if (state.calEventsCache.key !== first + '..' + last) return;

    const grid = $('#wp-grid');
    grid.innerHTML = '';
    const today = todayStr();
    // 每天的任务：一次性/连续区间/周期展开
    const dayLists = days.map((d) => {
      const ds = todayStr(d);
      return { ds, list: state.taskIndex.filter((t) => taskOccursOn(t, ds)) };
    });
    const seen = new Set();
    const weekTasks = [];
    for (const { list } of dayLists) {
      for (const t of list) {
        const key = `${t.rel}#${t.line}`;
        if (!seen.has(key)) { seen.add(key); weekTasks.push(t); }
      }
    }

    days.forEach((d, di) => {
      const ds = todayStr(d);
      const cell = document.createElement('div');
      cell.className = 'wp-day' + (ds === today ? ' today' : '') + (state.current && state.current.dateStr === ds ? ' selected' : '');
      cell.dataset.date = ds;

      const head = document.createElement('div');
      head.className = 'wp-day-head';
      const list = dayLists[di].list;
      const hol = holOf(ds);
      head.innerHTML = `<span class="wp-day-week">${WEEKDAYS[d.getDay()]}</span>` +
        `<span class="wp-day-date">${d.getMonth() + 1}/${d.getDate()}${hol ? `<span class="hol-dot ${hol.off ? 'off' : 'work'}"></span>` : ''}</span>`;
      head.title = ds + holTitle(ds) + '（点击打开每日笔记）';
      head.onclick = () => openDaily(ds);
      cell.appendChild(head);

      const body = document.createElement('div');
      body.className = 'wp-day-body';

      const evs = events.filter((e) => e.date === ds);
      for (const ev of evs) {
        const chip = document.createElement('div');
        chip.className = 'wp-ev';
        chip.innerHTML = (ev.startHM ? `<span class="wp-ev-time">${ev.startHM}</span>` : '') + escapeHtml(ev.title);
        chip.title = (ev.startHM ? `${ev.startHM}${ev.endHM ? '-' + ev.endHM : ''} ` : '') + ev.title;
        body.appendChild(chip);
      }

      if (!list.length && !evs.length) {
        const empty = document.createElement('div');
        empty.className = 'wp-empty';
        empty.textContent = '没有安排';
        body.appendChild(empty);
      }
      for (const t of list) {
        const tm = parseTaskTime(t.text);
        const row = document.createElement('div');
        row.className = 'wp-task' + (t.done ? ' done' : '');
        row.innerHTML = `<div class="wp-task-text">${tm && tm.start ? `<span class="wp-task-time">${tm.start}-${tm.end || addHourHM(tm.start)}</span>` : ''}${t.recurring ? '🔁 ' : ''}${escapeHtml(wpClean(t.text))}` +
          `<span class="wp-task-src">${escapeHtml(t.title || t.name)}</span></div>`;
        row.title = `${t.rel} 第 ${t.line} 行${t.done ? '' : '（可拖到其它天改期）'}`;
        row.addEventListener('click', () => openNote(t.rel, { line: t.line }));
        if (!t.done) {
          row.draggable = true;
          row.addEventListener('dragstart', (ev) => {
            ev.dataTransfer.setData('text/np-task', JSON.stringify({ rel: t.rel, line: t.line }));
            ev.dataTransfer.effectAllowed = 'move';
          });
        }
        body.appendChild(row);
      }
      cell.appendChild(body);

      // 节假日名放日列底部（样式同月历），不挤头部
      if (hol && hol.off) {
        const foot = document.createElement('div');
        foot.className = 'wp-day-foot';
        foot.textContent = hol.name;
        foot.title = `${hol.name}（休）`;
        cell.appendChild(foot);
      }

      cell.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        cell.classList.add('drop');
      });
      cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
      cell.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        cell.classList.remove('drop');
        const raw = ev.dataTransfer.getData('text/np-task');
        if (!raw) return;
        let task;
        try { task = JSON.parse(raw); } catch (_) { return; }
        const r = await window.api.rescheduleTask(task.rel, task.line, ds);
        if (!r.ok) { toast('改期失败：' + r.error); return; }
        toast(`已改期到 ${ds}`);
        scheduleTaskIndexRefresh();
        if (state.current && state.current.rel === task.rel && !state.current.dirty) {
          const res = await window.api.readNote(task.rel);
          if (res.ok) {
            state.suppressDocEvent = true;
            Ed.set(res.content);
            state.suppressDocEvent = false;
            refreshPreview();
          }
        }
      });
      grid.appendChild(cell);
    });

    const total = weekTasks.length;
    const done = weekTasks.filter((t) => t.done).length;
    const pct = total ? Math.round(done / total * 100) : 0;
    $('#wp-stats').innerHTML = total
      ? `本周任务 <b>${total}</b> · 完成 <b>${done}</b> · 完成率 <b>${pct}%</b>`
      : '本周还没有排期任务，从右侧任务面板拖入，或在上方目标卡片添加';
  }

  /* ---- 周目标：读写 Notes/周计划/YYYY-Wnn.md 的「本周目标」段 ---- */

  function wpSplitGoal(text) {
    // 返回 {before, goal, after}：goal 为「## 本周目标」段内容（到下一个 ## 之前）
    const m = text.match(/^##\s*本周目标\s*$/m);
    if (!m) return null;
    const start = m.index + m[0].length;
    const next = text.slice(start).search(/^##\s/m);
    const end = next === -1 ? text.length : start + next;
    return { before: text.slice(0, start), goal: text.slice(start, end), after: text.slice(end) };
  }

  async function loadWeekGoal(year, week) {
    const rel = weekPlanRel(year, week);
    state.wpGoalKey = rel;
    try {
      const r = await window.api.readNote(rel);
      if (state.wpGoalKey !== rel) return; // 异步期间已切到其它周
      if (!r.ok) {
        state.wpGoalLines = [];
      } else {
        const parts = wpSplitGoal(r.content);
        const lines = parts ? parts.goal.split('\n') : [];
        while (lines.length && lines[0].trim() === '') lines.shift();
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        state.wpGoalLines = lines;
      }
    } catch (_) {
      state.wpGoalLines = [];
    }
    renderWeekGoalList();
  }

  function wpSerializeGoal() {
    return '\n' + state.wpGoalLines.join('\n') + '\n';
  }

  async function saveWeekGoal() {
    if (!state.wpWeekStart) return false;
    const info = wpWeekInfo();
    const rel = weekPlanRel(info.year, info.week);
    let content;
    const r = await window.api.readNote(rel);
    if (r.ok) {
      content = r.content;
    } else {
      content = `# ${info.year} 年第 ${info.week} 周计划\n\n## 本周目标\n\n\n## 回顾\n\n`;
    }
    const parts = wpSplitGoal(content);
    if (parts) {
      content = parts.before + wpSerializeGoal() + parts.after;
    } else {
      content = content.replace(/\s*$/, '') + '\n\n## 本周目标\n' + wpSerializeGoal();
    }
    const w = await window.api.writeNote(rel, content);
    if (w.ok) {
      if (!state.byRel.has(rel)) refreshNotes();
      scheduleTaskIndexRefresh(); // 带 >日期 的目标会汇入下方日列
    }
    return w.ok;
  }

  /* ---- 周目标列表：目标行（- [ ] 文本）是待办，可勾选/排期/删除 ---- */

  function renderWeekGoalList() {
    const box = $('#wp-goal-list');
    if (!box) return;
    box.innerHTML = '';
    if (!state.wpGoalLines.length) {
      const e = document.createElement('div');
      e.className = 'wp-goal-empty';
      e.textContent = '还没有目标，点击下方 ＋ 添加';
      box.appendChild(e);
    }
    state.wpGoalLines.forEach((raw, i) => {
      const m = raw.match(/^(\s*[-*+]\s+)\[([ xX])\]\s*(.*)$/);
      const row = document.createElement('div');
      row.className = 'wp-goal-row';
      if (m) {
        // 待办行：可勾选 / 排期 / 编辑 / 删除
        const done = m[2] !== ' ';
        const body = m[3];
        const sched = (body.match(/>\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
        const donePart = (body.match(/@done(?:\([^)]*\))?/i) || [])[0] || null;
        const core = body
          .replace(/\s*@done(?:\([^)]*\))?/gi, '')
          .replace(/\s*>\s*\d{4}-\d{2}-\d{2}/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        row.classList.toggle('done', done);

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = done;
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
          const c = composeToggledLine(raw, null);
          if (!c) return;
          state.wpGoalLines[i] = c.line;
          saveWeekGoal().then(renderWeekGoalList);
        });

        const txt = document.createElement('div');
        txt.className = 'wp-goal-text';
        txt.textContent = core;
        if (sched) {
          const chip = document.createElement('span');
          chip.className = 'wp-goal-date';
          chip.textContent = `📅 ${sched.slice(5)}`;
          chip.title = '已排期；点击定位到该日期列';
          chip.addEventListener('click', (e) => {
            e.stopPropagation();
            const col = document.querySelector(`.wp-day[data-date="${sched}"]`);
            if (!col) { toast(`「${sched}」不在本周，用上方“下一周”切换后可见`); return; }
            col.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
            col.classList.remove('flash');
            void col.offsetWidth; // 重新触发动画
            col.classList.add('flash');
            setTimeout(() => col.classList.remove('flash'), 1300);
          });
          txt.appendChild(chip);
        }
        txt.title = '双击编辑';
        txt.ondblclick = () => startGoalEdit(i, row, core, m ? `${m[1]}[${m[2]}] ` : null);

        const actions = buildGoalActions(i, sched, true, raw);
        row.append(cb, txt, actions);
      } else {
        // 普通内容行：原样展示 / 编辑 / 删除
        const txt = document.createElement('div');
        txt.className = 'wp-goal-text wp-goal-plain';
        txt.textContent = raw;
        txt.title = '双击编辑（输入 - [ ] 前缀可转为待办）';
        txt.ondblclick = () => startGoalEdit(i, row, raw, null);

        const actions = buildGoalActions(i, null, false, raw);
        row.append(txt, actions);
      }
      box.appendChild(row);
    });
    appendGoalAddRow(box);
  }

  /** 目标卡片行内快速添加：点击「＋」行原地变成输入框，不弹独立输入框 */
  function appendGoalAddRow(box) {
    const row = document.createElement('div');
    row.className = 'wp-goal-row wp-goal-addrow';
    row.innerHTML = '<span class="wp-goal-addhint">＋ 添加目标，回车</span>';
    row.title = '点击在框内输入；☑/≡ 切换待办或普通内容；Esc 结束';
    row.onclick = () => startGoalAdd(row);
    box.appendChild(row);
  }

  function startGoalAdd(row) {
    if (row.querySelector('input')) return;
    row.classList.add('adding');
    const kindBtn = document.createElement('button');
    kindBtn.type = 'button';
    kindBtn.className = 'wp-kind-toggle';
    kindBtn.addEventListener('mousedown', (e) => e.preventDefault()); // 防止点按.Kind 时输入框失焦
    kindBtn.onclick = (e) => {
      e.stopPropagation();
      state.wpGoalKind = state.wpGoalKind === 'todo' ? 'text' : 'todo';
      syncKind();
      input.focus();
    };
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'wp-goal-edit';
    const syncKind = () => {
      kindBtn.textContent = state.wpGoalKind === 'todo' ? '☑' : '≡';
      kindBtn.title = state.wpGoalKind === 'todo' ? '当前：待办（点击切换为普通内容）' : '当前：普通内容（点击切换为待办）';
      input.placeholder = state.wpGoalKind === 'todo' ? '添加目标待办，回车' : '添加普通内容，回车';
    };
    syncKind();
    row.replaceChildren(kindBtn, input);
    input.focus();
    let finished = false;
    const commit = async () => {
      if (finished) return;
      finished = true;
      const text = input.value.trim();
      if (text) {
        state.wpGoalLines.push(state.wpGoalKind === 'todo' ? `- [ ] ${text}` : text);
        const ok = await saveWeekGoal();
        renderWeekGoalList();
        if (ok) { // 连续录入：新添加行直接进入输入状态
          const next = document.querySelector('#wp-goal-list .wp-goal-addrow');
          if (next) startGoalAdd(next);
        }
      } else {
        renderWeekGoalList();
      }
    };
    const cancel = () => {
      if (finished) return;
      finished = true;
      renderWeekGoalList();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') cancel();
    });
    input.addEventListener('blur', () => {
      if (finished) return;
      if (input.value.trim()) commit(); else cancel();
    });
  }

  function buildGoalActions(i, sched, isTodo, raw) {
    const actions = document.createElement('span');
    actions.className = 'wp-goal-actions';
    if (isTodo) {
      const cal = document.createElement('button');
      cal.textContent = '📅';
      cal.title = '排期到某天';
      if (sched) cal.classList.add('g-active');
      cal.addEventListener('click', (e) => {
        e.stopPropagation();
        scheduleGoalFlow(i, sched, e.clientX, e.clientY);
      });
      actions.appendChild(cal);
    }
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = '删除该行';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      state.wpGoalLines.splice(i, 1);
      saveWeekGoal().then(renderWeekGoalList);
    });
    actions.appendChild(del);
    return actions;
  }

  /** 就地编辑第 i 行目标；Enter/失焦提交，Esc 取消；清空文字 = 删除该行。
   *  todoPrefix：待办行的复选框前缀（如 '- [ ] '），普通内容行传 null */
  function startGoalEdit(i, row, core, todoPrefix) {
    const line = row.querySelector('.wp-goal-text');
    if (!line || row.querySelector('.wp-goal-edit')) return;
    const isTodo = !!todoPrefix;
    let donePart = null;
    let sched = null;
    if (isTodo) {
      const body = state.wpGoalLines[i].replace(todoPrefix, '');
      sched = (body.match(/>\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
      donePart = (body.match(/@done(?:\([^)]*\))?/i) || [])[0] || null;
    }
    const input = document.createElement('input');
    input.className = 'wp-goal-edit';
    input.value = core;
    line.replaceChildren(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let finished = false;
    const commit = () => {
      if (finished) return;
      finished = true;
      commitGoalEdit(i, input.value.trim(), core, isTodo, donePart, sched, todoPrefix);
    };
    const cancel = () => {
      if (finished) return;
      finished = true;
      renderWeekGoalList();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') cancel();
    });
    input.addEventListener('blur', commit);
  }

  function commitGoalEdit(i, text, prevCore, isTodo, donePart, sched, todoPrefix) {
    if (text === prevCore) {
      renderWeekGoalList();
      return;
    }
    if (!text) {
      state.wpGoalLines.splice(i, 1); // 清空 = 删除
    } else if (isTodo) {
      state.wpGoalLines[i] = `${todoPrefix}${text}${donePart ? ' ' + donePart : ''}${sched ? ' >' + sched : ''}`;
    } else {
      state.wpGoalLines[i] = text;
    }
    saveWeekGoal().then(renderWeekGoalList);
  }

  /** 把第 i 个目标排期/取消排期；弹出本周 7 天菜单 */
  function scheduleGoalFlow(i, current, x, y) {
    const days = [];
    for (let k = 0; k < 7; k++) {
      const d = new Date(state.wpWeekStart);
      d.setDate(d.getDate() + k);
      days.push(todayStr(d));
    }
    const items = days.map((ds) => ({
      label: `${monthCN(ds)} ${weekdayCN(ds)}` + (ds === current ? ' ✓' : ''),
      onClick: () => setGoalSchedule(i, ds),
    }));
    items.push('-');
    items.push({ label: current ? '移除排期' : '不排期（仅本周待办）', onClick: () => setGoalSchedule(i, null) });
    showCtx(x, y, items);
  }

  function setGoalSchedule(i, date) {
    const raw = state.wpGoalLines[i];
    const m = raw.match(/^(\s*[-*+]\s+\[[ xX]\]\s*)(.*)$/);
    if (!m) return;
    let text = m[2].replace(/\s*>\s*\d{4}-\d{2}-\d{2}/g, '').replace(/\s+$/, '');
    if (date) text += ` >${date}`;
    state.wpGoalLines[i] = `${m[1]}${text}`;
    saveWeekGoal().then(renderWeekGoalList);
  }

  async function renderCalView() {
    if (state.mainView === 'notes') return;
    if (state.calvMode === 'year') { renderYearView(); return; }
    const y = state.calvMonth.getFullYear();
    const m = state.calvMonth.getMonth();
    ensureHolYears([y]);
    $('#calv-title').textContent = `${y}年${m + 1}月`;
    const lastDay = new Date(y, m + 1, 0).getDate();
    const rs = `${y}-${pad2(m + 1)}-01`;
    const re = `${y}-${pad2(m + 1)}-${pad2(lastDay)}`;
    const events = await loadCalEvents(rs, re);
    if (state.mainView !== 'month') return; // 异步期间切走
    renderMonthGrid(y, m, events);
  }

  const EV_COLORS = ['ev-c0', 'ev-c1', 'ev-c2', 'ev-c3'];

  function renderMonthGrid(y, m, events) {
    const main = $('#calv-main');
    main.innerHTML = '';

    const grid = document.createElement('div');
    grid.className = 'mv-grid';

    for (const [wi, w] of ['周日', '周一', '周二', '周三', '周四', '周五', '周六'].entries()) {
      const wd = document.createElement('div');
      wd.className = 'mv-weekday' + ((wi === 0 || wi === 6) ? ' wk-end' : '');
      wd.textContent = w;
      grid.appendChild(wd);
    }

    const first = new Date(y, m, 1);
    const lead = first.getDay(); // 周日开头
    const start = new Date(y, m, 1 - lead);
    const today = todayStr();
    const sel = state.calvSel;

    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const ds = todayStr(d);
      const inMonth = d.getMonth() === m;
      const hol = holOf(ds);

      const cell = document.createElement('div');
      cell.className = 'mv-cell' + (inMonth ? '' : ' out') + (ds === today ? ' today' : '') +
        (sel === ds ? ' selected' : '') + (hol && hol.off ? ' holiday' : '');
      cell.dataset.date = ds;

      const head = document.createElement('div');
      head.className = 'mv-head';
      head.innerHTML = `<span class="mv-date">${d.getMonth() + 1}/${d.getDate()}${hol ? `<span class="hol-dot ${hol.off ? 'off' : 'work'}"></span>` : ''}</span>` +
        (dayHasContent(ds) ? '<span class="mv-note">📝</span>' : '');
      cell.appendChild(head);
      // 日期说明行：法定节假日名 > 农历节日 > 节气 > 农历日
      const lunar = lunarLabel(d.getFullYear(), d.getMonth() + 1, d.getDate());
      if (hol && hol.off) {
        const name = document.createElement('div');
        name.className = 'mv-hol';
        name.textContent = hol.name;
        name.title = hol.name;
        cell.appendChild(name);
      } else if (lunar) {
        const sub = document.createElement('div');
        sub.className = 'mv-sub ' + lunar.kind;
        sub.textContent = lunar.text;
        sub.title = lunarFull(d.getFullYear(), d.getMonth() + 1, d.getDate());
        cell.appendChild(sub);
      }
      cell.title = ds + weekdayCN(ds) + holTitle(ds) +
        (lunarFull(d.getFullYear(), d.getMonth() + 1, d.getDate()) ? ' · ' + lunarFull(d.getFullYear(), d.getMonth() + 1, d.getDate()) : '');

      const items = document.createElement('div');
      items.className = 'mv-items';

      const evs = events.filter((e) => e.date === ds);
      const dayTasks = state.taskIndex.filter((t) => taskOccursOn(t, ds));
      const tks = dayTasks.filter((t) => !t.done);
      let shown = 0;

      for (const e of evs) {
        if (shown >= 4) break;
        const c = document.createElement('div');
        c.className = 'mv-chip ev ' + EV_COLORS[e.cal % EV_COLORS.length];
        c.textContent = (e.allDay ? '📌 ' : `${e.startHM} `) + e.title;
        c.title = e.title + (e.loc ? ` @${e.loc}` : '');
        items.appendChild(c);
        shown++;
      }
      for (const t of tks) {
        if (shown >= 4) break;
        const tm = parseTaskTime(t.text);
        const c = document.createElement('div');
        c.className = 'mv-chip tk' + ((tm && tm.start) ? ' timed' : '');
        c.draggable = true;
        c.innerHTML = `${tm && tm.start ? `<b>${tm.start}</b> ` : ''}${escapeHtml(cleanTaskText(t.text)).slice(0, 30)}`;
        c.title = `${tm && tm.start ? tm.start + '-' + (tm.end || addHourHM(tm.start)) + ' ' : ''}${cleanTaskText(t.text)}（来源：${t.title}）`;
        attachTaskDrag(c, t);
        items.appendChild(c);
        shown++;
      }
      const rest = evs.length + tks.length - shown;
      if (rest > 0) {
        const more = document.createElement('div');
        more.className = 'mv-more';
        more.textContent = `还有 ${rest} 项…`;
        items.appendChild(more);
      }

      cell.appendChild(items);
      cell.onclick = () => {
        state.calvSel = ds;
        state.raSel = ds; // 与右栏日程联动
        renderCalendar();
        renderAgenda();
        renderMonthGrid(y, m, events);
      };
      cell.ondblclick = () => openDaily(ds);
      cell.addEventListener('dragover', (ev) => { ev.preventDefault(); cell.classList.add('drop'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
      cell.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        cell.classList.remove('drop');
        const raw = ev.dataTransfer.getData('text/np-task');
        if (!raw) return;
        let task;
        try { task = JSON.parse(raw); } catch (_) { return; }
        const r = await window.api.rescheduleTask(task.rel, task.line, ds);
        if (!r.ok) { toast('改期失败：' + r.error); return; }
        toast(`已改期到 ${ds}`);
        scheduleTaskIndexRefresh();
        renderCalView();
      });

      grid.appendChild(cell);
    }
    main.appendChild(grid);
  }

  function cleanTaskText(t) {
    return t.replace(/^[-*+]\s+\[[ xX-]\]\s*/, '')
      .replace(/\s*@\w+(?:\([^)]*\))?/gi, '')
      .replace(/>\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/(?:^|\s)\d{1,2}:\d{2}(?:\s*(?:-|–|—|~|至|到)\s*\d{1,2}:\d{2})?/, '')
      .replace(/\s{2,}/g, ' ').trim();
  }

  /** 任务行内的时间/时间段（渲染端解析，后端只认区间）：
   *  '14:00' → {start:'14:00', end:null}；'14:00-15:30' → 两端都有。跨天不支持。 */
  function parseTaskTime(text) {
    const s = String(text || '')
      .replace(/\s*@\w+(?:\([^)]*\))?/gi, '')   // @done(2026-09-21 09:12) 里的时间不算
      .replace(/>\s*\d{4}-\d{2}-\d{2}/g, '');
    const m = s.match(/(?:^|\s)(\d{1,2}:\d{2})(?:\s*(?:-|–|—|~|至|到)\s*(\d{1,2}:\d{2}))?/);
    if (!m) return null;
    return { start: normHM(m[1]), end: m[2] ? normHM(m[2]) : null };
  }
  function normHM(s) {
    const [h, mi] = s.split(':').map((x) => pad2(parseInt(x, 10) || 0));
    return `${h}:${mi}`;
  }
  function addHourHM(hm) {
    const [h, mi] = hm.split(':').map(Number);
    return `${pad2(Math.min(23, h + 1))}:${pad2(mi)}`;
  }
  const hmToMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

  function attachTaskDrag(el, task) {
    el.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/np-task', JSON.stringify({ rel: task.rel, line: task.line, start: task.start, end: task.end }));
      ev.dataTransfer.effectAllowed = 'copyMove';
    });
  }

  function renderYearView() {
    const y = state.calvYear;
    const gen = (state.yrGen = (state.yrGen || 0) + 1); // 快速切换时丢弃过期渲染
    ensureHolYears([y]);
    $('#calv-title').textContent = `${y}年`;
    const main = $('#calv-main');
    main.innerHTML = '';
    main.classList.add('year-mode');

    const wrap = document.createElement('div');
    wrap.className = 'yr-grid';

    (async () => {
      const events = await loadCalEvents(`${y}-01-01`, `${y}-12-31`);
      if (state.calvMode !== 'year' || state.calvYear !== y || gen !== state.yrGen) return;

      for (let m = 0; m < 12; m++) {
        const card = document.createElement('div');
        card.className = 'yr-month';
        const head = document.createElement('div');
        head.className = 'yr-mtitle';
        head.textContent = `${m + 1}月`;
        head.onclick = () => {
          state.calvMonth = new Date(y, m, 1);
          state.calvMode = 'month';
          document.querySelectorAll('#calv-seg button').forEach((b) => b.classList.toggle('active', b.dataset.cal === 'month'));
          renderCalView();
        };
        card.appendChild(head);

        const g = document.createElement('div');
        g.className = 'yr-grid7';
        for (const [wi, w] of ['日', '一', '二', '三', '四', '五', '六'].entries()) {
          const wd = document.createElement('span');
          wd.className = 'yr-wd' + ((wi === 0 || wi === 6) ? ' wk-end' : '');
          wd.textContent = w;
          g.appendChild(wd);
        }
        const first = new Date(y, m, 1);
        const lead = first.getDay();
        for (let i = 0; i < lead; i++) g.appendChild(document.createElement('span'));
        const days = new Date(y, m + 1, 0).getDate();
        const today = todayStr();
        for (let d = 1; d <= days; d++) {
          const ds = `${y}-${pad2(m + 1)}-${pad2(d)}`;
          const has = dayHasContent(ds);
          const evc = events.filter((e) => e.date === ds).length;
          const tkc = state.taskIndex.filter((t) => taskOccursOn(t, ds) && !t.done).length;
          const hol = holOf(ds);
          const s = document.createElement('span');
          s.className = 'yr-day' + (ds === today ? ' today' : '') + (has ? ' has-note' : '') +
            (evc ? ' has-ev' : '') + (tkc ? ' has-task' : '') + (hol && hol.off ? ' holiday' : '');
          s.textContent = d;
          s.title = ds + holTitle(ds) +
            (lunarFull(y, m + 1, d) ? ' · ' + lunarFull(y, m + 1, d) : '') +
            (tkc ? ` · ${tkc} 个任务` : '') +
            (has ? ' · 有笔记' : '') + (evc ? ` · ${evc} 个事件` : '');
          s.onclick = () => {
            state.calvMonth = new Date(y, m, 1);
            state.calvSel = ds;
            state.raSel = ds; // 与右栏日程联动
            state.calvMode = 'month';
            document.querySelectorAll('#calv-seg button').forEach((b) => b.classList.toggle('active', b.dataset.cal === 'month'));
            renderCalView();
          };
          g.appendChild(s);
        }
        card.appendChild(g);
        wrap.appendChild(card);
      }
      main.appendChild(wrap);
    })();
  }

  /* ======================================================================
   * 视图切换 / 面板
   * ==================================================================== */

  /* Live Preview 即唯一视图：编辑与渲染合一，不再有独立的编辑/预览切换 */

  /* ======================================================================
   * 命令面板
   * ==================================================================== */

  const paletteOverlay = $('#palette-overlay');
  const paletteInput = $('#palette-input');
  const paletteResults = $('#palette-results');
  const paletteState = { items: [], sel: 0 };

  function openPalette(prefill) {
    paletteOverlay.hidden = false;
    paletteInput.value = prefill || '';
    runPalette();
    paletteInput.focus();
    paletteInput.select();
  }
  function closePalette() { paletteOverlay.hidden = true; }
  function paletteOpen() { return !paletteOverlay.hidden; }

  async function runPalette() {
    const q = paletteInput.value.trim();
    const seq = ++state.paletteSeq;
    const items = [];

    if (q.startsWith('#')) {
      // 标签搜索模式
      const tag = q.slice(1).trim();
      items.push({ type: 'cmd', label: `搜索包含 #${tag || '…'} 的内容`, icon: '🔍', run: async () => {
        if (!tag) return;
        const hits = await window.api.search('#' + tag);
        if (hits.length) openNote(hits[0].rel, { line: hits[0].line });
        else toast(`没有找到包含 #${tag} 的内容`);
      } });
      if (tag) {
        const hits = await window.api.search('#' + tag);
        for (const h of hits.slice(0, 30)) {
          const n = state.byRel.get(h.rel);
          items.push({
            type: 'content', rel: h.rel, line: h.line,
            title: noteTitle(n), sub: h.text, icon: '#',
          });
        }
      }
    } else {
      // 命令
      for (const c of COMMANDS) {
        if (!q || c.label.toLowerCase().includes(q.toLowerCase())) {
          items.push({ type: 'cmd', label: c.label, hint: c.hint, icon: c.icon, run: c.run });
        }
      }
      // 每日笔记匹配（输入日期片段）
      if (/^\d{2,}/.test(q) || q.startsWith('2')) {
        const dailies = state.notes.filter((n) => isDailyRel(n.rel) && baseName(n.rel).includes(q))
          .sort((a, b) => b.rel.localeCompare(a.rel)).slice(0, 5);
        for (const d of dailies) {
          const ds = baseName(d.rel);
          items.push({ type: 'daily', rel: d.rel, title: `${ds} ${weekdayCN(ds)}`, sub: '每日笔记', icon: '📅' });
        }
      }
      // 笔记标题匹配
      const titleHits = state.notes
        .filter((n) => {
          if (!n.md) return false;
          const t = noteTitle(n).toLowerCase();
          return q && (t.includes(q) || fuzzy(t, q));
        })
        .sort((a, b) => scoreNote(a, q) - scoreNote(b, q))
        .slice(0, 8);
      for (const n of titleHits) {
        items.push({ type: 'note', rel: n.rel, title: noteTitle(n), sub: displayRel(n.rel), icon: '📄' });
      }
      // 全文搜索
      if (q.length >= 2) {
        const hits = await window.api.search(q);
        if (seq !== state.paletteSeq) return; // 已过期
        const seen = new Set(titleHits.map((n) => n.rel));
        for (const h of hits) {
          if (seen.has(h.rel)) continue;
          seen.add(h.rel);
          const n = state.byRel.get(h.rel);
          items.push({ type: 'content', rel: h.rel, line: h.line, title: noteTitle(n), sub: h.text, icon: '🔍' });
          if (seen.size >= 16) break;
        }
      }
    }

    paletteState.items = items;
    paletteState.sel = 0;
    renderPalette(q);
  }

  function fuzzy(text, q) {
    let i = 0;
    for (const ch of text) if (ch === q[i]) i++;
    return i === q.length;
  }

  function scoreNote(n, q) {
    const t = noteTitle(n).toLowerCase();
    if (t === q) return 0;
    if (t.startsWith(q)) return 1;
    if (t.includes(q)) return 2;
    return 3;
  }

  function highlightMatch(text, q) {
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1 || !q) return escapeHtml(text);
    return escapeHtml(text.slice(0, i)) + '<mark>' + escapeHtml(text.slice(i, i + q.length)) + '</mark>' + escapeHtml(text.slice(i + q.length));
  }

  function renderPalette(q) {
    paletteResults.innerHTML = '';
    if (!paletteState.items.length) {
      paletteResults.innerHTML = '<div class="palette-empty">没有匹配结果</div>';
      return;
    }
    const kw = q.startsWith('#') ? q.slice(1).trim() : q;
    paletteState.items.forEach((item, i) => {
      if (i > 0 && paletteState.items[i - 1].type !== item.type) {
        const g = document.createElement('div');
        g.className = 'palette-group';
        g.textContent = { cmd: '命令', note: '笔记', daily: '每日笔记', content: '内容匹配' }[item.type] || '';
        paletteResults.appendChild(g);
      }
      const e = document.createElement('div');
      e.className = 'palette-item' + (i === paletteState.sel ? ' selected' : '');
      e.innerHTML = `<span class="p-icon">${item.icon || '•'}</span>` +
        `<div class="p-label"><div class="p-title">${highlightMatch(item.title || item.label, kw)}</div>` +
        (item.sub ? `<div class="p-sub">${escapeHtml(item.sub)}</div>` : '') + '</div>' +
        (item.hint ? `<span class="p-hint">${item.hint}</span>` : '');
      e.onmouseenter = () => { paletteState.sel = i; paintSel(); };
      e.onclick = () => execPaletteItem(item);
      paletteResults.appendChild(e);
    });
  }

  function paintSel() {
    paletteResults.querySelectorAll('.palette-item').forEach((el, i) => {
      el.classList.toggle('selected', i === paletteState.sel);
    });
    const sel = paletteResults.querySelector('.palette-item.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function execPaletteItem(item) {
    closePalette();
    if (item.type === 'cmd') item.run();
    else if (item.type === 'daily') openNote(item.rel);
    else if (item.type === 'note') openNote(item.rel);
    else if (item.type === 'content') openNote(item.rel, { line: item.line });
  }

  paletteInput.addEventListener('input', () => runPalette());

  paletteInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteState.sel = Math.min(paletteState.sel + 1, paletteState.items.length - 1);
      paintSel();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteState.sel = Math.max(paletteState.sel - 1, 0);
      paintSel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = paletteState.items[paletteState.sel];
      if (item) execPaletteItem(item);
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });

  paletteOverlay.addEventListener('mousedown', (e) => {
    if (e.target === paletteOverlay) closePalette();
  });

  /* ======================================================================
   * 命令
   * ==================================================================== */

  const COMMANDS = [
    { label: '新建笔记', hint: 'Ctrl+N', icon: '✚', run: () => newNoteFlow() },
    { label: '打开今日笔记', hint: 'Ctrl+J', icon: '📅', run: () => openToday() },
    { label: '打开周计划', icon: '🗓', run: () => setMainView('week') },
    { label: '任务总览', hint: '右侧面板', icon: '☑', run: () => {
      const tab = document.querySelector('.rb-tab[data-tab="tasks"]');
      if (tab) tab.click();
    } },
    { label: '切换深色 / 浅色主题', hint: 'Ctrl+Shift+L', icon: '🌓', run: () => toggleTheme() },
    { label: '设置…', hint: 'Ctrl+,', icon: '⚙', run: () => settingsModal() },
    { label: '在资源管理器中打开笔记库', icon: '📂', run: () => window.api.showInFolder() },
    { label: '更换笔记库…', icon: '🗂', run: () => chooseVaultFlow() },
    { label: '语法与快捷键帮助', icon: '❓', run: () => helpModal() },
  ];

  async function newNoteFlow(folder) {
    const r = await window.api.createNote(folder || 'Notes', '无标题笔记');
    if (!r.ok) { toast('创建失败：' + r.error); return; }
    await refreshNotes();
    await openNote(r.rel, { force: true });
    renameNoteFlow(r.rel, true);
  }

  /* ======================================================================
   * 弹窗
   * ==================================================================== */

  const modalOverlay = $('#modal-overlay');

  function showModal(title, bodyEl, buttons) {
    $('#modal-title').textContent = title;
    const body = $('#modal-body');
    body.innerHTML = '';
    body.appendChild(bodyEl);
    const btns = $('#modal-btns');
    btns.innerHTML = '';
    for (const b of buttons || []) {
      const el = document.createElement('button');
      el.className = 'big-btn' + (b.kind ? ' ' + b.kind : '');
      el.textContent = b.label;
      el.onclick = () => { if (b.onClick) b.onClick(); else closeModal(); };
      btns.appendChild(el);
    }
    modalOverlay.hidden = false;
  }
  function closeModal() { modalOverlay.hidden = true; }

  modalOverlay.addEventListener('mousedown', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  function inputModal(title, label, value, onSubmit) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div style="color:var(--text-dim);font-size:12.5px">${label}</div>`;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    wrap.appendChild(input);
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      closeModal();
      onSubmit(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') closeModal();
    });
    showModal(title, wrap, [
      { label: '取消' },
      { label: '确定', kind: 'primary', onClick: submit },
    ]);
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }

  function confirmModal(title, message, confirmLabel, onSubmit) {
    const wrap = document.createElement('div');
    wrap.textContent = message;
    showModal(title, wrap, [
      { label: '取消' },
      { label: confirmLabel || '确定', kind: 'danger', onClick: () => { closeModal(); onSubmit(); } },
    ]);
  }

  /** 外部修改冲突的离开确认：保存并覆盖 / 不保存 / 取消（留在原地） */
  function leaveConfirmModal(onSave, onDiscard) {
    const wrap = document.createElement('div');
    wrap.textContent = '当前笔记已被外部程序修改，且本地有未保存的修改。直接保存会覆盖外部版本。';
    showModal('有未保存的修改', wrap, [
      { label: '不保存', onClick: () => { closeModal(); onDiscard(); } },
      { label: '保存并覆盖', kind: 'primary', onClick: () => { closeModal(); onSave(); } },
      { label: '取消' },
    ]);
  }

  /* ---- 设置 ---- */

  function settingsModal() {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="vault-path">${escapeHtml(state.vaultPath || '未设置')}</div>
      <div style="color:var(--text-dim);font-size:12.5px;margin-bottom:4px">主题</div>
      <div class="radio-row" id="theme-row">
        <label data-v="auto">跟随系统</label>
        <label data-v="light">浅色</label>
        <label data-v="dark">深色</label>
      </div>
      <div style="color:var(--text-dim);font-size:12.5px;margin:12px 0 4px">日历订阅（ICS，用于月历视图显示事件）</div>
      <div id="cal-list" class="cal-list"></div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input type="text" id="cal-add" placeholder="https://…ics 订阅链接 或 本地 .ics 文件路径" style="flex:1;margin-top:0" />
        <button class="mini-btn" id="cal-add-btn">添加</button>
      </div>
      <div style="color:var(--text-dim);font-size:12.5px;margin:12px 0 4px">法定节假日</div>
      <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer;color:var(--text)">
        <input type="checkbox" id="set-hol-auto">
        自动更新节假日数据（浏览到新年份时从 holiday-cn 拉取并缓存；内置 2024–2026）
      </label>
      <div style="color:var(--text-dim);font-size:12.5px;margin:12px 0 4px">任务提醒</div>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:12.5px;color:var(--text)">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="rem-daily-on">
          每日提醒：当天到期 / 未排期 / 过期未完成的任务在每天
          <input type="time" id="rem-daily-time" style="width:96px;padding:2px 6px;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg-input);color:var(--text);font-family:inherit">
          汇总提醒（默认 17:00）
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="rem-lead-on">
          到期前提醒：带开始时间的任务在开始前
          <input type="number" id="rem-lead-min" min="0" max="240" style="width:56px;padding:2px 6px;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg-input);color:var(--text);font-family:inherit">
          分钟提醒（默认 15 分钟）
        </label>
        <div style="color:var(--text-faint);font-size:11.5px">提醒配置保存在本机（不同步到笔记库）。</div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="mini-btn" id="set-change-vault">更换笔记库…</button>
        <button class="mini-btn" id="set-open-vault">打开笔记库文件夹</button>
      </div>`;
    const row = wrap.querySelector('#theme-row');
    const paint = () => row.querySelectorAll('label').forEach((l) => {
      l.classList.toggle('on', l.dataset.v === (state.settings.theme || 'auto'));
    });
    paint();
    row.addEventListener('click', (e) => {
      const l = e.target.closest('label');
      if (!l) return;
      state.settings.theme = l.dataset.v;
      applyTheme();
      window.api.setSettings({ theme: l.dataset.v });
      paint();
    });

    // 日历订阅源管理
    const calList = wrap.querySelector('#cal-list');
    const renderCals = () => {
      calList.innerHTML = '';
      const cals = Array.isArray(state.settings.calendars) ? state.settings.calendars : [];
      if (!cals.length) {
        calList.innerHTML = '<div class="cal-empty">尚未添加。支持 iCloud / Google Calendar 的「公开日历」ICS 链接，或本地 .ics 文件。</div>';
        return;
      }
      cals.forEach((c, i) => {
        const src = typeof c === 'string' ? c : c.src;
        const rowEl = document.createElement('div');
        rowEl.className = 'cal-row';
        rowEl.innerHTML = `<span class="cal-dot ev-c${i % 4}"></span><span class="cal-src">${escapeHtml(src)}</span>`;
        const del = document.createElement('button');
        del.className = 'mini-btn';
        del.textContent = '删除';
        del.onclick = () => {
          state.settings.calendars = cals.filter((_x, j) => j !== i);
          window.api.setSettings({ calendars: state.settings.calendars });
          state.calEventsCache = { key: '', list: [] };
          renderCals();
        };
        rowEl.appendChild(del);
        calList.appendChild(rowEl);
      });
    };
    renderCals();
    wrap.querySelector('#cal-add-btn').onclick = () => {
      const input = wrap.querySelector('#cal-add');
      const src = input.value.trim();
      if (!src) return;
      if (!Array.isArray(state.settings.calendars)) state.settings.calendars = [];
      state.settings.calendars.push({ src });
      window.api.setSettings({ calendars: state.settings.calendars });
      state.calEventsCache = { key: '', list: [] };
      input.value = '';
      renderCals();
    };

    // 法定节假日自动更新开关（localStorage，cn-holidays.js 读取）
    const holAuto = wrap.querySelector('#set-hol-auto');
    holAuto.checked = window.CNHolidays ? window.CNHolidays.autoEnabled() : false;
    holAuto.addEventListener('change', () => {
      if (!window.CNHolidays) return;
      window.CNHolidays.setAutoEnabled(holAuto.checked);
      if (holAuto.checked) {
        const y = new Date().getFullYear();
        ensureHolYears([y, y + 1]);
      }
    });

    // 任务提醒配置（localStorage，设备级）
    const rc = reminderConfig();
    const remDailyOn = wrap.querySelector('#rem-daily-on');
    const remDailyTime = wrap.querySelector('#rem-daily-time');
    const remLeadOn = wrap.querySelector('#rem-lead-on');
    const remLeadMin = wrap.querySelector('#rem-lead-min');
    remDailyOn.checked = rc.dailyEnabled;
    remDailyTime.value = rc.dailyTime;
    remLeadOn.checked = rc.leadEnabled;
    remLeadMin.value = rc.leadMinutes;
    const saveReminderUi = () => {
      const t = (remDailyTime.value || '').trim();
      saveReminderConfig({
        dailyEnabled: remDailyOn.checked,
        dailyTime: /^\d{1,2}:\d{2}$/.test(t) ? t : '17:00',
        leadEnabled: remLeadOn.checked,
        leadMinutes: Math.max(0, Math.min(240, parseInt(remLeadMin.value, 10) || 0)),
      });
      checkReminders();
    };
    remDailyOn.addEventListener('change', saveReminderUi);
    remDailyTime.addEventListener('change', saveReminderUi);
    remLeadOn.addEventListener('change', saveReminderUi);
    remLeadMin.addEventListener('change', saveReminderUi);

    wrap.querySelector('#set-change-vault').onclick = () => { closeModal(); chooseVaultFlow(); };
    wrap.querySelector('#set-open-vault').onclick = () => { closeModal(); window.api.showInFolder(); };

    showModal('设置', wrap, [{ label: '关闭', kind: 'primary' }]);
  }

  function helpModal() {
    const wrap = document.createElement('div');
    const sec = (title, body, open) =>
      `<details class="help-details"${open ? ' open' : ''}><summary>${title}</summary><div class="help-body">${body}</div></details>`;
    wrap.innerHTML =
      sec('界面布局', `
        <div style="color:var(--text-dim);font-size:12.5px;line-height:1.7">
          顶部在 笔记 / 周计划 / 月历 / 年 之间切换主视图；<br/>
          右栏「月历 + 当日日程」仅在 笔记 视图展示，其余视图自动隐藏铺满；<br/>
          每日笔记正文顶部显示所属周（WEEK nn），点击打开本周周计划；<br/>
          右栏日程：点击月历日期切换当天安排，双击打开当日笔记；<br/>
          all-day 列出当天无时间任务（可直接勾选），时间段任务定位到下方时间轴。
        </div>`, true) +
      sec('任务与时间', `
        <table class="help-table">
          <tr><td><code>- [ ] 任务</code></td><td>创建待办；视图即编辑器，可直接点复选框勾选</td></tr>
          <tr><td><code>- [x] 已完成</code> / <code>- [-] 已废弃</code></td><td>完成 / 废弃任务（右键任务行也可标记废弃）</td></tr>
          <tr><td><code>&gt;2026-09-01</code></td><td>安排到某天；输入 &gt; 可补全日期</td></tr>
          <tr><td><code>14:00-15:30 内容</code></td><td>时间段任务：进入右栏当日时间轴（支持单个 14:00，不跨天）</td></tr>
          <tr><td><code>@done(日期)</code></td><td>勾选任务时自动添加，取消勾选自动移除</td></tr>
          <tr><td><code>every day / 每天 / 每2周</code></td><td>循环任务：完成时自动排到下一周期</td></tr>
          <tr><td><code>提醒</code></td><td>带时间的任务在开始前提醒（默认 15 分钟）；当天 / 未排期 / 过期任务在每日提醒时间（默认 17:00）汇总提醒；设置 → 任务提醒 可配置</td></tr>
          <tr><td><code>选中文字</code></td><td>右键 → 转为待办任务 / 添加为今日待办</td></tr>
        </table>`) +
      sec('书写语法', `
        <table class="help-table">
          <tr><td><code>[[笔记标题]]</code></td><td>双向链接（输入 [[ 自动补全笔记名）</td></tr>
          <tr><td><code>#标签</code></td><td>标签（输入 # 自动补全）</td></tr>
          <tr><td><code>@提及</code></td><td>提及（输入 @ 自动补全）</td></tr>
          <tr><td><code>&gt; 引用行</code></td><td>引用块；缩进的引用可作为任务备注</td></tr>
          <tr><td><code>==高亮==</code> <code>%%注释%%</code></td><td>高亮 / 注释</td></tr>
          <tr><td><code>**粗体**</code> <code>*斜体*</code> <code>\`代码\`</code></td><td>基础格式</td></tr>
        </table>`) +
      sec('快捷键', `
        <table class="help-table">
          <tr><td><kbd>Ctrl</kbd>+<kbd>K</kbd></td><td>命令面板 / 快速打开 / 搜索</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>N</kbd></td><td>新建笔记</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>J</kbd></td><td>打开今日笔记</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>L</kbd></td><td>切换当前行任务（自动 @done / 循环重建）</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>F</kbd></td><td>笔记内搜索</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>Z</kbd></td><td>撤销（编辑器内）</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd></td><td>切换主题</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>立即保存（默认自动保存）</td></tr>
          <tr><td><kbd>F2</kbd></td><td>重命名当前笔记</td></tr>
          <tr><td><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd></td><td>缩进 / 反缩进</td></tr>
        </table>`) +
      sec('日历与节假日', `
        <div style="color:var(--text-dim);font-size:12.5px;line-height:1.7">
          日历日期旁：<span style="color:var(--danger);font-weight:600">红点</span> = 中国大陆法定节假日（休），<br/>
          <span style="color:var(--accent);font-weight:600">蓝点</span> = 调休上班日；月历格与日程头部显示假期名；<br/>
          月历 CW 列为 ISO 周数（橙色，点击打开周计划）；内置 2024–2026 年官方数据，<br/>
          浏览其它年份时自动从 holiday-cn 拉取并本地缓存（可在设置中关闭）。
        </div>`) +
      sec('任务总览与拖拽排期', `
        <div style="color:var(--text-dim);font-size:12.5px;line-height:1.7">
          右栏「任务」面板按 今天 / 已过期 / 已排期 / 未排期 / 已完成 分组展示全库任务；<br/>
          把任务拖到周条或月历某天上即可改期，点周条日期打开当天笔记。
        </div>`) +
      sec('免责声明', `
        <div>
          本项目为个人学习性质的非商业开源实现，与 NotePlan.app 及其开发方无任何隶属关系；<br/>
          软件按「现状」提供，不附带任何明示或默示的担保，作者不对使用本软件造成的任何<br/>
          数据丢失、文件损坏或其他损失承担责任——请定期自行备份笔记库文件夹；<br/>
          安装包请仅从本仓库的 GitHub Releases 页面获取，谨防第三方仿冒分发；<br/>
          应用未做商业代码签名，首次运行可能触发 SmartScreen 提示，详见 README「代码签名与 SmartScreen」。
        </div>`, false);
    wrap.lastElementChild.classList.add('disclaimer');
    showModal('帮助', wrap, [{ label: '关闭', kind: 'primary' }]);
  }

  function aboutModal() {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<p style="margin:0 0 8px">NotePlan for Windows v0.5.8</p>
      <p style="margin:0;color:var(--text-dim);font-size:12.5px">受 <a href="#" id="about-link" style="color:var(--accent)">NotePlan</a> 启发的开源桌面笔记应用。<br/>
      每日笔记 · Markdown · 任务 · 双向链接 · 命令面板<br/>
      数据就是磁盘上的纯文本文件。</p>
      <p style="margin:8px 0 0;color:var(--text-faint);font-size:11.5px">仅供个人学习使用，与 NotePlan.app 无隶属关系；数据请自行备份。</p>`;
    showModal('关于', wrap, [{ label: '关闭', kind: 'primary' }]);
    wrap.querySelector('#about-link').onclick = (e) => {
      e.preventDefault();
      window.api.openExternal('https://noteplan.co');
    };
  }

  /* ======================================================================
   * 回收站
   * ==================================================================== */

  async function trashModal() {
    const items = await window.api.trashList();
    const wrap = document.createElement('div');
    const list = document.createElement('div');
    list.className = 'trash-list';

    const render = (listItems) => {
      list.innerHTML = '';
      if (!listItems.length) {
        list.innerHTML = '<div class="rb-empty">回收站是空的</div>';
        return;
      }
      for (const it of listItems) {
        const row = document.createElement('div');
        row.className = 'trash-row';
        const info = document.createElement('div');
        info.className = 'trash-info';
        info.innerHTML = `<div class="trash-name">${escapeHtml(it.name)}</div>` +
          `<div class="trash-meta">${escapeHtml(it.origRel)} · ${escapeHtml(String(it.deletedAt).replace('T', ' ').slice(0, 16))}</div>`;
        const restore = document.createElement('button');
        restore.className = 'mini-btn';
        restore.textContent = '恢复';
        restore.onclick = async () => {
          const r = await window.api.trashRestore(it.id);
          if (!r.ok) { toast('恢复失败：' + r.error); return; }
          await refreshNotes();
          toast('已恢复到 ' + r.rel);
          trashModal();
        };
        const purge = document.createElement('button');
        purge.className = 'mini-btn danger';
        purge.textContent = '永久删除';
        purge.onclick = () => confirmModal('永久删除', `「${it.name}」将被彻底删除，不可恢复。`, '永久删除', async () => {
          const r = await window.api.trashPurge(it.id);
          if (!r.ok) { toast('删除失败：' + r.error); return; }
          trashModal();
        });
        const btns = document.createElement('div');
        btns.className = 'trash-btns';
        btns.append(restore, purge);
        row.append(info, btns);
        list.appendChild(row);
      }
    };
    render(items);
    wrap.appendChild(list);

    const clearRow = document.createElement('div');
    clearRow.className = 'trash-clear-row';
    if (items.length) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'mini-btn danger';
      clearBtn.textContent = '清空回收站';
      clearBtn.onclick = () => confirmModal('清空回收站', '回收站中的所有内容将被彻底删除，不可恢复。', '清空', async () => {
        await window.api.trashEmpty();
        await refreshNotes();
        trashModal();
      });
      clearRow.appendChild(clearBtn);
    }
    wrap.appendChild(clearRow);

    showModal('回收站', wrap, [{ label: '关闭', kind: 'primary' }]);
  }

  /* ======================================================================
   * 笔记 / 文件夹操作
   * ==================================================================== */

  async function renameNoteFlow(rel, autoFocus) {
    const old = baseName(rel);
    inputModal('重命名笔记', '新的名称（不含 .md 后缀）', old, async (v) => {
      if (v === old) return;
      const r = await window.api.renameNote(rel, v);
      if (!r.ok) { toast('重命名失败：' + r.error); return; }
      await refreshNotes();
      if (state.current && state.current.rel === rel) await openNote(r.rel, { force: true });
    });
    void autoFocus;
  }

  function deleteNoteFlow(rel) {
    confirmModal('删除笔记', `「${baseName(rel)}」将被移入回收站，可在侧栏底部恢复。`, '删除', async () => {
      const r = await window.api.trashNote(rel);
      if (!r.ok) { toast('删除失败：' + r.error); return; }
      await refreshNotes();
      if (state.current && state.current.rel === rel) {
        state.current = null;
        await openToday();
      }
      toast('已移入回收站', { label: '撤销', run: async () => {
        const rr = await window.api.trashRestore(r.trashId);
        if (rr.ok) await refreshNotes();
      } });
    });
  }

  async function moveNoteFlow(rel) {
    const folders = new Set(['Notes']);
    for (const n of state.notes) {
      if (!n.md || n.rel.startsWith('Calendar/')) continue;
      const d = relDir(n.rel);
      if (d) folders.add(d);
    }
    const list = [...folders].sort();
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div style="color:var(--text-dim);font-size:12.5px">选择目标文件夹</div>` +
      `<select id="move-sel" style="width:100%;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13.5px;margin-top:4px">` +
      list.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('') +
      `</select>`;
    showModal('移动笔记', wrap, [
      { label: '取消' },
      { label: '移动', kind: 'primary', onClick: async () => {
        const dest = wrap.querySelector('#move-sel').value;
        const r = await window.api.moveNote(rel, dest);
        if (!r.ok) { toast('移动失败：' + r.error); return; }
        await refreshNotes();
        if (state.current && state.current.rel === rel) await openNote(r.rel, { force: true });
        closeModal();
      } },
    ]);
  }

  function newFolderFlow(parent) {
    inputModal('新建文件夹', '文件夹名称（位于 ' + (parent || 'Notes') + ' 下）', '', async (v) => {
      const r = await window.api.createFolder(parent || 'Notes', v);
      if (!r.ok) { toast('创建失败：' + r.error); return; }
      state.collapsed.delete(r.rel);
      await refreshNotes();
    });
  }

  function deleteFolderFlow(rel) {
    confirmModal('删除文件夹', `文件夹「${baseName(rel)}」及其全部内容将被移入回收站。`, '删除', async () => {
      const r = await window.api.trashFolder(rel);
      if (!r.ok) { toast('删除失败：' + r.error); return; }
      await refreshNotes();
      toast('已移到回收站');
    });
  }

  async function chooseVaultFlow() {
    const dir = await window.api.chooseVault();
    if (!dir) return;
    const r = await window.api.openVault(dir, false);
    if (r.ok) {
      state.collapsed.clear();
      await refreshNotes();
      await enterVault();
      toast('已切换笔记库');
    } else {
      toast('打开失败：' + r.error);
    }
  }

  /* ======================================================================
   * 右键菜单
   * ==================================================================== */

  const ctxMenu = $('#ctx-menu');

  function showCtx(x, y, items) {
    ctxMenu.innerHTML = '';
    for (const it of items) {
      if (it === '-') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        ctxMenu.appendChild(sep);
        continue;
      }
      const b = document.createElement('button');
      b.className = 'ctx-item' + (it.danger ? ' danger' : '');
      b.innerHTML = `<span>${it.label}</span>` + (it.key ? `<span class="k">${it.key}</span>` : '');
      b.onclick = () => { hideCtx(); it.onClick(); };
      ctxMenu.appendChild(b);
    }
    ctxMenu.hidden = false;
    const rect = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  }
  function hideCtx() { ctxMenu.hidden = true; }

  function noteContext(ev, n) {
    showCtx(ev.clientX, ev.clientY, [
      { label: '打开', key: 'Enter', onClick: () => openNote(n.rel) },
      { label: '重命名', key: 'F2', onClick: () => renameNoteFlow(n.rel) },
      { label: '移动到文件夹…', onClick: () => moveNoteFlow(n.rel) },
      '-',
      { label: '在资源管理器中显示', onClick: () => window.api.openPath(n.rel) },
      { label: '删除', danger: true, key: 'Del', onClick: () => deleteNoteFlow(n.rel) },
    ]);
  }

  function folderContext(ev, folder) {
    showCtx(ev.clientX, ev.clientY, [
      { label: '在此文件夹新建笔记', onClick: () => newNoteFlow(folder.rel) },
      { label: '新建子文件夹', onClick: () => newFolderFlow(folder.rel) },
      '-',
      { label: '删除文件夹', danger: true, onClick: () => deleteFolderFlow(folder.rel) },
    ]);
  }

  window.addEventListener('mousedown', (e) => {
    if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) hideCtx();
  });
  window.addEventListener('blur', hideCtx);

  /* ======================================================================
   * 静态事件绑定
   * ==================================================================== */

  function bindStaticEvents() {
    // 侧边栏 Tab
    document.querySelectorAll('.sb-tab').forEach((tab) => {
      tab.onclick = () => {
        state.sidebarTab = tab.dataset.tab;
        document.querySelectorAll('.sb-tab').forEach((t) => t.classList.toggle('active', t === tab));
        $('#sb-calendar').hidden = state.sidebarTab !== 'calendar';
        $('#sb-notes').hidden = state.sidebarTab !== 'notes';
        window.api.setSettings({ sidebarView: state.sidebarTab });
      };
    });
    // 恢复上次的侧栏视图
    if (state.settings.sidebarView === 'notes') {
      document.querySelector('.sb-tab[data-tab="notes"]').click();
    }

    // 日历导航
    $('#cal-prev').onclick = () => {
      state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
      renderCalendar(); renderDailyList();
    };
    $('#cal-next').onclick = () => {
      state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
      renderCalendar(); renderDailyList();
    };
    $('#cal-today').onclick = () => {
      state.calMonth = new Date();
      renderCalendar(); renderDailyList();
    };

    // 新建
    $('#btn-new-note').onclick = () => newNoteFlow();
    $('#btn-new-folder').onclick = () => newFolderFlow('Notes');

    // 命令面板按钮
    $('#btn-palette').onclick = () => openPalette();

    // 编辑器：选中内容右键 → 快速生成待办（无选区且在任务行上 → 任务菜单）
    editorWrap.addEventListener('contextmenu', selectionContext);

    // 主题按钮
    $('#btn-theme').onclick = () => toggleTheme();

    // 回收站
    $('#btn-trash').onclick = () => trashModal();

    // 笔记库按钮
    $('#btn-vault-folder').onclick = () => window.api.showInFolder();

    // 右侧面板 Tab（日程 / 大纲 / 链接 / 任务）
    document.querySelectorAll('.rb-tab').forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll('.rb-tab').forEach((t) => t.classList.toggle('active', t === tab));
        state.rightTab = tab.dataset.tab;
        $('#rb-agenda').hidden = state.rightTab !== 'agenda';
        $('#rb-outline').hidden = state.rightTab !== 'outline';
        $('#rb-backlinks').hidden = state.rightTab !== 'backlinks';
        $('#rb-tasks').hidden = state.rightTab !== 'tasks';
        if (state.rightTab === 'agenda') renderAgenda();
        if (state.rightTab === 'tasks') renderTasksPanel();
      };
    });

    // 右栏月历导航
    $('#rb-cal-prev').onclick = () => {
      state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
      renderCalendar(); renderDailyList();
    };
    $('#rb-cal-next').onclick = () => {
      state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
      renderCalendar(); renderDailyList();
    };
    $('#rb-cal-today').onclick = () => {
      state.calMonth = new Date();
      state.raSel = todayStr();
      renderCalendar(); renderDailyList(); renderAgenda();
    };

    // 周数行 → 打开周计划
    $('#weekrow').onclick = () => {
      if (state.current && state.current.isDaily) {
        state.wpWeekStart = startOfWeek(new Date(state.current.dateStr + 'T12:00:00'));
      }
      setMainView('week');
    };

    // 周条
    $('#wb-prev').onclick = () => {
      state.weekStart.setDate(state.weekStart.getDate() - 7);
      renderWeekBar();
    };
    $('#wb-next').onclick = () => {
      state.weekStart.setDate(state.weekStart.getDate() + 7);
      renderWeekBar();
    };
    $('#wb-today').onclick = () => {
      state.weekStart = startOfWeek(new Date());
      renderWeekBar();
    };
    renderWeekBar();

    // 主视图切换：笔记 / 月历 / 年
    document.querySelectorAll('#main-seg button').forEach((b) => {
      b.onclick = () => setMainView(b.dataset.main);
    });

    // 月历视图导航
    $('#calv-prev').onclick = () => {
      if (state.calvMode === 'year') { state.calvYear -= 1; renderCalView(); return; }
      state.calvMonth = new Date(state.calvMonth.getFullYear(), state.calvMonth.getMonth() - 1, 1);
      renderCalView();
    };
    $('#calv-next').onclick = () => {
      if (state.calvMode === 'year') { state.calvYear += 1; renderCalView(); return; }
      state.calvMonth = new Date(state.calvMonth.getFullYear(), state.calvMonth.getMonth() + 1, 1);
      renderCalView();
    };
    $('#calv-today').onclick = () => {
      state.calvMonth = new Date();
      state.calvYear = state.calvMonth.getFullYear();
      state.calvSel = todayStr();
      renderCalView();
    };
    document.querySelectorAll('#calv-seg button').forEach((b) => {
      b.onclick = () => {
        state.calvMode = b.dataset.cal;
        document.querySelectorAll('#calv-seg button').forEach((x) => x.classList.toggle('active', x === b));
        renderCalView();
      };
    });

    // 周计划视图导航
    $('#wp-prev').onclick = () => {
      state.wpWeekStart.setDate(state.wpWeekStart.getDate() - 7);
      renderWeekPlan();
    };
    $('#wp-next').onclick = () => {
      state.wpWeekStart.setDate(state.wpWeekStart.getDate() + 7);
      renderWeekPlan();
    };
    $('#wp-today').onclick = () => {
      state.wpWeekStart = startOfWeek(new Date());
      renderWeekPlan();
    };
    // 周目标快速添加：在目标列表行内进行（见 appendGoalAddRow / startGoalAdd）

    // 首次使用引导
    $('#onb-create').onclick = async () => {
      const dir = await window.api.defaultVaultPath();
      const r = await window.api.openVault(dir, true);
      if (r.ok) {
        await refreshNotes();
        await enterVault();
      } else {
        toast('创建失败：' + r.error);
      }
    };
    $('#onb-choose').onclick = async () => {
      const dir = await window.api.chooseVault();
      if (!dir) return;
      const r = await window.api.openVault(dir, false);
      if (r.ok) {
        state.collapsed.clear();
        await refreshNotes();
        await enterVault();
      } else {
        toast('打开失败：' + r.error);
      }
    };

    // 全局键盘（应用内快捷键统一在这里处理，菜单只负责点击）
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const shift = e.shiftKey;

      if (e.key === 'Escape') {
        hideCtx();
        if (paletteOpen()) closePalette();
        else closeModal();
        return;
      }
      if (mod && shift && k === 'l') { e.preventDefault(); toggleTheme(); }
      else if (mod && shift && k === 'f') { e.preventDefault(); openPalette(); }
      else if (mod && k === 'k') { e.preventDefault(); paletteOpen() ? closePalette() : openPalette(); }
      else if (mod && k === 'n') { e.preventDefault(); if (!overlayOpen()) newNoteFlow(); }
      else if (mod && k === 'j') { e.preventDefault(); if (!overlayOpen()) openToday(); }
      else if (mod && k === 'l') { e.preventDefault(); if (!overlayOpen()) toggleTasksAtCursor(); }
      else if (mod && k === 's') { e.preventDefault(); saveNow(true); }
      else if (mod && k === ',') { e.preventDefault(); if (!overlayOpen()) settingsModal(); }
      else if (e.key === 'F2' && state.current && !state.current.isDaily && !overlayOpen()) { renameNoteFlow(state.current.rel); }
    });

    // 离开窗口时立即保存
    window.addEventListener('blur', () => { if (saveTimerPending()) saveNow(); });
    window.addEventListener('beforeunload', () => {
      if (state.current && state.current.dirty && !state.externalDirty) {
        window.api.flushSaveNow(state.current.rel, Ed.get());
      }
    });
    // 关闭/退出窗口：由渲染进程确认未保存的修改后再真正关闭
    if (window.api.onCloseRequest) {
      window.api.onCloseRequest(async () => {
        const c = state.current;
        if (!c) { window.api.confirmClose(); return; }
        if (c.dirty && state.externalDirty) {
          leaveConfirmModal(
            async () => { if (await saveNow(true)) window.api.confirmClose(); },
            () => window.api.confirmClose()
          );
          return;
        }
        if (c.dirty) await saveNow(true);
        window.api.confirmClose();
      });
    }
  }

  function overlayOpen() {
    return paletteOpen() || !$('#modal-overlay').hidden || !$('#onboarding').hidden;
  }

  function bindMenuEvents() {
    window.api.onMenu('new-note', () => newNoteFlow());
    window.api.onMenu('open-today', () => openToday());
    window.api.onMenu('week-plan', () => setMainView('week'));
    window.api.onMenu('palette', () => openPalette());
    window.api.onMenu('search', () => openPalette());
    window.api.onMenu('choose-vault', () => chooseVaultFlow());
    window.api.onMenu('settings', () => settingsModal());
    window.api.onMenu('toggle-task', () => toggleTasksAtCursor());
    window.api.onMenu('toggle-theme', () => toggleTheme());
    window.api.onMenu('help', () => helpModal());
    window.api.onMenu('about', () => aboutModal());
  }

  // 调试/自动化测试钩子（通过 CDP 使用）
  window.__np = { state, openNote, openToday, openWiki, openPalette, saveNow, refreshNotes, applyTaskToggle };
  window.__edGet = () => Ed.get();

  boot();
})();

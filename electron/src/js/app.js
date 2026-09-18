'use strict';
/* ==========================================================================
   NotePlan for Windows — 渲染端主控制器
   ========================================================================== */

(() => {
  const $ = (sel) => document.querySelector(sel);

  const editor = $('#editor');        // textarea 兜底（CodeMirror 未构建时使用）
  const preview = $('#preview');
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
    viewMode: 'split',
    collapsed: new Set(),
    externalDirty: false,
    paletteSeq: 0,
    renderGen: 0,
    taskIndex: [],          // 全库任务索引
    weekStart: null,        // 周条起始日（周一）
    rightTab: 'outline',
    tagsCache: [],
    mentionsCache: [],
    suppressDocEvent: false,
    mainView: 'notes',        // 'notes' | 'week' | 'month' | 'year'
    calvMode: 'month',        // 'month' | 'year'
    calvMonth: null,          // 月视图当前月
    calvYear: null,           // 年视图当前年
    calvSel: null,            // 月视图选中日期
    calEventsCache: { key: '', list: [] },
    wpWeekStart: null,        // 周计划当前周（周一）
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
    // 本周周一
    const now = new Date();
    const dow = (now.getDay() + 6) % 7;
    state.weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
    applyTheme();
    initEditor();
    bindStaticEvents();
    bindMenuEvents();
    window.api.onThemeChanged((dark) => {
      state.systemDark = dark;
      if ((state.settings.theme || 'auto') === 'auto') applyTheme();
    });
    window.api.onVaultChanged(() => { onVaultChanged(); scheduleTaskIndexRefresh(); });

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

  /* ---- 日历 ---- */

  function renderCalendar() {
    const y = state.calMonth.getFullYear();
    const m = state.calMonth.getMonth();
    ensureHolYears([y, y + 1]); // 当年 + 次年（次年安排每年 11 月公布）
    $('#cal-title').textContent = `${y}年${m + 1}月`;

    const grid = $('#cal-grid');
    grid.innerHTML = '';

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
    const selected = state.current && state.current.dateStr;

    for (let i = 0; i < offset; i++) {
      const e = document.createElement('div');
      e.className = 'cal-day empty';
      grid.appendChild(e);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${y}-${pad2(m + 1)}-${pad2(d)}`;
      const hol = holOf(ds);
      const e = document.createElement('div');
      e.className = 'cal-day';
      e.textContent = d;
      if (hol) {
        e.classList.add(hol.off ? 'holiday' : 'workday');
        const tag = document.createElement('span');
        tag.className = 'hol-tag';
        tag.textContent = hol.off ? '休' : '班';
        e.appendChild(tag);
      }
      e.title = ds + weekdayCN(ds) + holTitle(ds) + (lunarFull(y, m + 1, d) ? ' · ' + lunarFull(y, m + 1, d) : '');
      if (ds === today) e.classList.add('today');
      if (selected === ds) e.classList.add('selected');
      if (dayHasContent(ds)) {
        const dot = document.createElement('div');
        dot.className = 'dot';
        e.appendChild(dot);
      }
      e.onclick = () => openDaily(ds);
      grid.appendChild(e);
    }
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
      if (!n.md || n.rel.startsWith('Calendar/')) continue;
      const parts = n.rel.split('/');
      parts.pop();
      let node = root, acc = '';
      for (const p of parts) {
        acc = acc ? acc + '/' + p : p;
        if (!node.children.has(p)) {
          node.children.set(p, { name: p, rel: acc, children: new Map(), notes: [] });
        }
        node = node.children.get(p);
      }
      node.notes.push(n);
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
      box.innerHTML = '<span class="tree-empty" style="padding:0">暂无标签</span>';
      return;
    }
    for (const t of tags.slice(0, 24)) {
      const chip = document.createElement('button');
      chip.className = 'tag-chip';
      chip.innerHTML = `#${escapeHtml(t.tag)}<span class="t-count">${t.count}</span>`;
      chip.onclick = () => openPalette('#' + t.tag);
      box.appendChild(chip);
    }
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
    $('#ext-banner').hidden = true;

    setCrumb(rel);
    setView(state.viewMode, { skipFocus: true });
    refreshPreview();
    refreshOutline();
    refreshBacklinks();
    updateStatus();
    renderSidebar();
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

  function setCrumb(rel) {
    const parts = rel.split('/');
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

  async function saveNow() {
    if (!state.current) return;
    if (!state.current.dirty) return;
    const c = state.current;
    c.dirty = false;
    setSaveState('saving');
    const res = await window.api.writeNote(c.rel, Ed.get());
    if (res.ok) {
      c.mtimeMs = res.mtimeMs;
      setSaveState('saved');
      scheduleTaskIndexRefresh();
      if (isDailyRel(c.rel)) scheduleNotesRefresh();
    } else {
      c.dirty = true;
      toast('保存失败：' + res.error);
      setSaveState('unsaved');
    }
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
      if (res.content !== editor.value) {
        if (state.current.dirty) {
          state.externalDirty = true;
          $('#ext-banner').hidden = false;
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
   * 预览 / 大纲 / 反向链接
   * ==================================================================== */

  function refreshPreview() {
    if (!state.current) return;
    const gen = ++state.renderGen;
    const { html, outline } = window.NPMarkdown.render(Ed.get(), {
      noteDir: relDir(state.current.rel),
    });
    state.outline = outline;
    if (state.viewMode !== 'edit') preview.innerHTML = html;
    appendAgenda(gen);
  }

  /* 每日笔记：聚合显示其它笔记里安排到这一天的任务（>日期） */
  async function appendAgenda(gen) {
    const cur = state.current;
    if (!cur || !cur.isDaily) return;
    const tasks = await window.api.scheduledTasks(cur.dateStr);
    // 异步期间用户可能已切走或已触发新一轮渲染
    if (gen !== state.renderGen || state.current !== cur) return;
    if (!tasks.length) return;
    if (state.viewMode === 'edit') return;

    const items = tasks.map((t) => {
      const n = state.byRel.get(t.rel);
      const plain = t.text.replace(/^[-*+]\s*\[[ xX]\]\s*/, '');
      const body = window.NPMarkdown.inline(plain, { codes: [], noteDir: relDir(t.rel) });
      return `<li class="task${t.done ? ' done' : ''}" data-rel="${escapeHtml(t.rel)}">` +
        `<input type="checkbox" class="task-box" disabled${t.done ? ' checked' : ''}>` +
        `<span class="task-body">${body}</span>` +
        `<a class="agenda-src">↩ ${escapeHtml(noteTitle(n))}</a></li>`;
    });
    const box = `<div class="agenda-box"><div class="agenda-title">📌 来自其它笔记 · 安排到这一天</div>` +
      `<ul class="agenda">${items.join('')}</ul></div>`;
    preview.insertAdjacentHTML('beforeend', box);
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

  function jumpToLine(line) {
    if (state.viewMode === 'preview') {
      const h = preview.querySelector(`#h-${line}`);
      if (h) h.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    Ed.revealLine(line);
  }

  /* ---- 预览交互 ---- */

  preview.addEventListener('click', (e) => {
    const t = e.target;

    if (t.classList && t.classList.contains('task-box')) {
      const line = +t.dataset.line;
      applyTaskToggle(line, t.checked);
      return;
    }
    const wiki = t.closest && t.closest('a.wikilink');
    if (wiki) { e.preventDefault(); openWiki(wiki.dataset.wiki); return; }
    // 聚合任务：点击跳到来源笔记
    const agendaItem = t.closest && t.closest('li.task[data-rel]');
    if (agendaItem) { openNote(agendaItem.dataset.rel); return; }
    const tag = t.closest && t.closest('a.tag');
    if (tag) { e.preventDefault(); openPalette('#' + tag.dataset.tag); return; }
    const sched = t.closest && t.closest('span.schedule');
    if (sched) { e.preventDefault(); openDaily(sched.dataset.date); return; }
    const ext = t.closest && t.closest('a.ext-link');
    if (ext) { e.preventDefault(); window.api.openExternal(ext.href); return; }
  });

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
      placeholder: '开始书写……支持 Markdown：- [ ] 任务、[[双链]]、#标签、>日期、==高亮==',
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

  /** 切换一行任务文本的完成状态；返回 {line, done, rest}，非任务行返回 null */
  function composeToggledLine(lineText, target) {
    const m = lineText.match(/^(\s*)([-*+]\s+)(\[([ xX])\]\s*)?(.*)$/);
    if (!m) return null;
    const indent = m[1], marker = m[2], box = m[4], rest = m[5] || '';
    const curDone = (box !== undefined && box !== ' ') || /@done/i.test(rest);
    const done = target === null ? !curDone : target;
    let text = rest.replace(/\s*@done(?:\([^)]*\))?/gi, '').replace(/\s+$/, '');
    if (done) text += ` @done(${todayStr()})`;
    return { line: `${indent}${marker}${done ? '[x] ' : '[ ] '}${text}`, done, rest };
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
    saveNow();
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
    saveNow();
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

  /** 编辑器/预览里选中内容右键 → 快速生成待办；无选区时用浏览器默认菜单 */
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
    } else if (t.closest && t.closest('#preview')) {
      text = String(window.getSelection() || '');
    }
    if (!text.trim()) return;
    ev.preventDefault();
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
    if (state.mainView === 'week') renderWeekPlan();
  }
  function scheduleTaskIndexRefresh() {
    clearTimeout(taskIndexTimer);
    taskIndexTimer = setTimeout(loadTaskIndex, 700);
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
        `<span class="wb-num">${d.getMonth() + 1}/${d.getDate()}</span>` +
        (hol ? `<span class="wb-hol${hol.off ? '' : ' work'}">${hol.off ? hol.name : '班'}</span>` : '') +
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
    $('#weekbar').hidden = !notes;
    $('#calview').hidden = notes || week;
    $('#weekplan').hidden = !week;
    $('#view-seg').style.display = notes ? '' : 'none';
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
    s.setDate(s.getDate() - (s.getDay() + 6) % 7); // 回到周一
    return s;
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
    const info = isoWeekInfo(state.wpWeekStart);
    const first = todayStr(days[0]);
    const last = todayStr(days[6]);
    ensureHolYears([days[0].getFullYear(), days[6].getFullYear()]); // 跨年周（ISO 周）两侧年份都要
    $('#wp-title').textContent = `${info.year}年第${info.week}周 · ${first.slice(5).replace('-', '/')} ~ ${last.slice(5).replace('-', '/')}`;
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
      cell.className = 'wp-day' + (ds === today ? ' today' : '');
      cell.dataset.date = ds;

      const head = document.createElement('div');
      head.className = 'wp-day-head';
      const list = dayLists[di].list;
      const openCount = list.filter((t) => !t.done).length;
      const hol = holOf(ds);
      head.innerHTML = `<span class="wp-day-week">${WEEKDAYS[d.getDay()]}</span>` +
        `<span class="wp-day-date">${d.getMonth() + 1}/${d.getDate()}</span>` +
        (hol ? `<span class="wp-day-hol${hol.off ? '' : ' work'}">${hol.off ? hol.name : '班'}</span>` : '') +
        (openCount ? `<span class="wp-day-count">${openCount} 待办</span>` : '');
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
        const row = document.createElement('div');
        row.className = 'wp-task' + (t.done ? ' done' : '');
        row.innerHTML = `<input type="checkbox" ${t.done ? 'checked' : ''}>` +
          `<div class="wp-task-text">${t.start ? `<span class="wp-task-time">${t.start}-${t.end || ''}</span>` : ''}${t.recurring ? '🔁 ' : ''}${escapeHtml(wpClean(t.text))}` +
          `<span class="wp-task-src">${escapeHtml(t.title || t.name)}</span></div>`;
        row.title = `${t.rel} 第 ${t.line} 行${t.done ? '' : '（可拖到其它天改期）'}`;
        row.querySelector('input').addEventListener('click', (e) => e.stopPropagation());
        row.querySelector('input').addEventListener('change', () => {
          row.classList.toggle('done');
          toggleTaskInFile(t.rel, t.line);
        });
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

      const add = document.createElement('div');
      add.className = 'wp-add';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = '＋ 添加任务，回车';
      input.title = '默认一次性任务。语法：>2026-09-16 指定日期；>起 ~ 止 连续多天；every 3 days / 每周 周期任务；14:00-15:30 时间块';
      input.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const text = input.value.trim();
        if (!text) return;
        const r = await window.api.dailyAppend(ds, `- [ ] ${text} >${ds}`);
        if (!r.ok) { toast('添加失败：' + r.error); return; }
        input.value = '';
        scheduleTaskIndexRefresh();
      });
      add.appendChild(input);
      cell.appendChild(add);

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
      : '本周还没有排期任务，从右侧任务面板拖入，或在某天下方快速添加';
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
    const info = isoWeekInfo(state.wpWeekStart);
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
      e.textContent = '还没有目标，在下方输入并回车添加';
      box.appendChild(e);
      return;
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
      head.innerHTML = `<span class="mv-date">${d.getMonth() + 1}/${d.getDate()}</span>` +
        (hol && !hol.off ? '<span class="mv-hol work" title="调休上班">班</span>' : '') +
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
        const c = document.createElement('div');
        c.className = 'mv-chip tk' + (t.start ? ' timed' : '');
        c.draggable = true;
        c.innerHTML = `${t.start ? `<b>${t.start}</b> ` : ''}${escapeHtml(cleanTaskText(t.text)).slice(0, 30)}`;
        c.title = `${t.start ? t.start + '-' + t.end + ' ' : ''}${cleanTaskText(t.text)}（来源：${t.title}）`;
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
    return t.replace(/^[-*+]\s+\[[ xX]\]\s*/, '')
      .replace(/\s*@\w+(?:\([^)]*\))?/gi, '')
      .replace(/>\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/\d{1,2}:\d{2}\s*(?:-|–|—|~|至|到)\s*\d{1,2}:\d{2}/, '')
      .replace(/\s{2,}/g, ' ').trim();
  }

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

  function setView(mode, opts) {
    opts = opts || {};
    state.viewMode = mode;
    editorWrap.classList.remove('view-edit', 'view-split', 'view-preview');
    editorWrap.classList.add('view-' + mode);
    preview.hidden = mode === 'edit';
    document.querySelectorAll('#view-seg button').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === mode);
    });
    if (mode !== 'edit') refreshPreview();
    if (!opts.skipFocus && mode !== 'preview') editor.focus();
  }

  function cycleView() {
    const order = ['edit', 'split', 'preview'];
    setView(order[(order.indexOf(state.viewMode) + 1) % order.length]);
  }

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
        items.push({ type: 'note', rel: n.rel, title: noteTitle(n), sub: n.rel, icon: '📄' });
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
    { label: '切换 编辑 / 分栏 / 预览', hint: 'Ctrl+E', icon: '▤', run: () => cycleView() },
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
    setView('edit');
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

    wrap.querySelector('#set-change-vault').onclick = () => { closeModal(); chooseVaultFlow(); };
    wrap.querySelector('#set-open-vault').onclick = () => { closeModal(); window.api.showInFolder(); };

    showModal('设置', wrap, [{ label: '关闭', kind: 'primary' }]);
  }

  function helpModal() {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <h4>常用语法</h4>
      <table class="help-table">
        <tr><td><code>- [ ] 任务</code></td><td>创建任务，编辑器/预览中可直接点复选框</td></tr>
        <tr><td><code>[[笔记标题]]</code></td><td>双向链接（输入 [[ 自动补全笔记名）</td></tr>
        <tr><td><code>#标签</code></td><td>标签（输入 # 自动补全）</td></tr>
        <tr><td><code>&gt;2026-09-01</code></td><td>安排到某天；输入 &gt; 可补全日期</td></tr>
        <tr><td><code>@done(日期)</code></td><td>勾选任务时自动添加，取消勾选自动移除</td></tr>
        <tr><td><code>every day / 每天 / 每2周</code></td><td>循环任务：完成时自动排到下一周期</td></tr>
        <tr><td><code>==高亮==</code> <code>%%注释%%</code></td><td>高亮 / 注释</td></tr>
        <tr><td><code>**粗体**</code> <code>*斜体*</code> <code>\`代码\`</code></td><td>基础格式</td></tr>
        <tr><td><code>选中文字</code></td><td>右键 → 转为待办任务 / 添加为今日待办</td></tr>
      </table>
      <h4>快捷键</h4>
      <table class="help-table">
        <tr><td><kbd>Ctrl</kbd>+<kbd>K</kbd></td><td>命令面板 / 快速打开 / 搜索</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>N</kbd></td><td>新建笔记</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>J</kbd></td><td>打开今日笔记</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>E</kbd></td><td>切换 编辑 / 分栏 / 预览</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>L</kbd></td><td>切换当前行任务（自动 @done / 循环重建）</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>F</kbd></td><td>笔记内搜索</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>Z</kbd></td><td>撤销（编辑器内）</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd></td><td>切换主题</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>立即保存（默认自动保存）</td></tr>
        <tr><td><kbd>F2</kbd></td><td>重命名当前笔记</td></tr>
        <tr><td><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd></td><td>缩进 / 反缩进</td></tr>
      </table>
      <h4>日历与节假日</h4>
      <div style="color:var(--text-dim);font-size:12.5px;line-height:1.7">
        日历中的红色日期为中国大陆法定节假日（红色「休」），蓝色「班」角标为调休上班日；<br/>
        内置 2024–2026 年官方数据；浏览到其它年份时自动从 holiday-cn 拉取并本地缓存<br/>
       （每天至多尝试一次，离线时用内置/已缓存数据，可在设置中关闭）。
      </div>
      <h4>任务总览与周条</h4>
      <div style="color:var(--text-dim);font-size:12.5px;line-height:1.7">
        右侧「任务」面板按 今天 / 已过期 / 已排期 / 未排期 / 已完成 分组展示全库任务；<br/>
        把任务拖到编辑器上方的周条日期上即可改期，点周条日期打开当天笔记。
      </div>`;
    showModal('帮助', wrap, [{ label: '关闭', kind: 'primary' }]);
  }

  function aboutModal() {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<p style="margin:0 0 8px">NotePlan for Windows v0.2.0</p>
      <p style="margin:0;color:var(--text-dim);font-size:12.5px">受 <a href="#" id="about-link" style="color:var(--accent)">NotePlan</a> 启发的开源桌面笔记应用。<br/>
      每日笔记 · Markdown · 任务 · 双向链接 · 命令面板<br/>
      数据就是磁盘上的纯文本文件。</p>`;
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

    // 视图切换
    document.querySelectorAll('#view-seg button').forEach((b) => {
      b.onclick = () => setView(b.dataset.view);
    });

    // 编辑器 / 预览：选中内容右键 → 快速生成待办（无选区时为浏览器默认菜单）
    editorWrap.addEventListener('contextmenu', selectionContext);

    // 主题按钮
    $('#btn-theme').onclick = () => toggleTheme();

    // 回收站
    $('#btn-trash').onclick = () => trashModal();

    // 笔记库按钮
    $('#btn-vault-folder').onclick = () => window.api.showInFolder();

    // 外部修改横幅
    $('#btn-ext-reload').onclick = async () => {
      $('#ext-banner').hidden = true;
      state.externalDirty = false;
      state.current.dirty = false;
      await openNote(state.current.rel, { force: true });
    };
    $('#btn-ext-keep').onclick = () => {
      $('#ext-banner').hidden = true;
      state.externalDirty = false;
      state.current.dirty = true; // 下次保存覆盖外部版本
      setSaveState('unsaved');
    };

    // 右侧面板 Tab
    document.querySelectorAll('.rb-tab').forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll('.rb-tab').forEach((t) => t.classList.toggle('active', t === tab));
        state.rightTab = tab.dataset.tab;
        $('#rb-outline').hidden = state.rightTab !== 'outline';
        $('#rb-backlinks').hidden = state.rightTab !== 'backlinks';
        $('#rb-tasks').hidden = state.rightTab !== 'tasks';
        if (state.rightTab === 'tasks') renderTasksPanel();
      };
    });

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
      const now = new Date();
      const dow = (now.getDay() + 6) % 7;
      state.weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
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
    // 周计划目标输入：☑/≡ 切换添加类型（待办 / 普通内容）
    const kindBtn = $('#wp-goal-kind');
    const kindInput = $('#wp-goal-input');
    const syncKindUi = () => {
      kindBtn.textContent = state.wpGoalKind === 'todo' ? '☑' : '≡';
      kindBtn.title = state.wpGoalKind === 'todo' ? '当前：待办（点击切换为普通内容）' : '当前：普通内容（点击切换为待办）';
      kindInput.placeholder = state.wpGoalKind === 'todo' ? '＋ 添加目标待办，回车' : '＋ 添加普通内容，回车';
    };
    kindBtn.onclick = () => {
      state.wpGoalKind = state.wpGoalKind === 'todo' ? 'text' : 'todo';
      syncKindUi();
      kindInput.focus();
    };
    kindInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const text = e.target.value.trim();
      if (!text) return;
      state.wpGoalLines.push(state.wpGoalKind === 'todo' ? `- [ ] ${text}` : text);
      e.target.value = '';
      saveWeekGoal().then(renderWeekGoalList);
    });

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
      else if (mod && k === 'e') { e.preventDefault(); if (!overlayOpen()) cycleView(); }
      else if (mod && k === 'l') { e.preventDefault(); if (!overlayOpen()) toggleTasksAtCursor(); }
      else if (mod && k === 's') { e.preventDefault(); saveNow(); }
      else if (mod && k === ',') { e.preventDefault(); if (!overlayOpen()) settingsModal(); }
      else if (e.key === 'F2' && state.current && !state.current.isDaily && !overlayOpen()) { renameNoteFlow(state.current.rel); }
    });

    // 离开窗口时立即保存
    window.addEventListener('blur', () => { if (saveTimerPending()) saveNow(); });
    window.addEventListener('beforeunload', () => {
      if (state.current && state.current.dirty) {
        window.api.flushSaveNow(state.current.rel, Ed.get());
      }
    });
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
    window.api.onMenu('cycle-view', () => cycleView());
    window.api.onMenu('toggle-theme', () => toggleTheme());
    window.api.onMenu('help', () => helpModal());
    window.api.onMenu('about', () => aboutModal());
  }

  // 调试/自动化测试钩子（通过 CDP 使用）
  window.__np = { state, openNote, openToday, openWiki, openPalette, saveNow, refreshNotes, applyTaskToggle };
  window.__edGet = () => Ed.get();

  boot();
})();

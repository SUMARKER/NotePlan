'use strict';
/* 端到端功能冒烟测试：通过 CDP 驱动渲染进程。
 * 前置：应用以 --remote-debugging-port=9222 启动。 */

const { execFileSync } = require('child_process');
const path = require('path');

function evalInPage(expr) {
  const out = execFileSync('node', [path.join(__dirname, 'cdp-eval.js'), expr], {
    encoding: 'utf8',
    env: process.env,
  });
  return JSON.parse(out);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`);
}

(async () => {
  await new Promise((r) => setTimeout(r, 500));

  // 1. 打开欢迎笔记（默认视图为纯编辑，预览相关断言先切到预览视图）
  evalInPage(`window.__np.openNote('Notes/欢迎使用 NotePlan for Windows.md').then(() => 'ok')`);
  await new Promise((r) => setTimeout(r, 400));
  evalInPage(`document.querySelector('#view-seg button[data-view=preview]').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const s1 = evalInPage(`({
    scheds: [...document.querySelectorAll('#preview .schedule')].map(e => e.textContent),
    tags: [...document.querySelectorAll('#preview .tag')].length,
    wikis: [...document.querySelectorAll('#preview .wikilink')].length,
    outline: document.querySelectorAll('#rb-outline .outline-item').length,
  })`);
  check('日程徽章渲染', s1.scheds.length >= 1, s1.scheds);
  check('标签渲染', s1.tags >= 1);
  check('双链渲染', s1.wikis >= 1);
  check('大纲生成', s1.outline >= 3);

  // 2. 点击第一个任务复选框 → 源文件应被改写
  const findTask = `(() => {
    const lines = window.__edGet().split('\\n');
    const i = lines.findIndex(l => l.includes('这是一个未完成任务'));
    return i === -1 ? 'NOT_FOUND' : i + '|' + lines[i];
  })()`;
  const before = evalInPage(findTask);
  evalInPage(`(() => { const b = document.querySelector('#preview input.task-box'); b.click(); return b.checked; })()`);
  await new Promise((r) => setTimeout(r, 1200)); // 等自动保存
  const after = evalInPage(findTask);
  check('复选框切换写回源文本', /\|- \[x\]/.test(String(after)), { before, after });

  // 再点回去，恢复原状
  evalInPage(`(() => { const b = document.querySelector('#preview input.task-box'); b.click(); return b.checked; })()`);
  await new Promise((r) => setTimeout(r, 1200));
  // 切回编辑视图（后续 CodeMirror 相关断言需要编辑器可见）
  evalInPage(`document.querySelector('#view-seg button[data-view=edit]').click()`);
  await new Promise((r) => setTimeout(r, 400));

  // 3. 命令面板搜索
  evalInPage(`window.__np.openPalette('技巧')`);
  await new Promise((r) => setTimeout(r, 700));
  const s3 = evalInPage(`({
    visible: !document.getElementById('palette-overlay').hidden,
    items: [...document.querySelectorAll('.palette-item .p-title')].map(e => e.textContent).slice(0, 6),
  })`);
  check('命令面板出现', s3.visible);
  check('搜索到"使用技巧"', s3.items.some((t) => t.includes('使用技巧')), s3.items);
  evalInPage(`document.getElementById('palette-input').value=''; window.__np ? document.getElementById('palette-overlay').hidden = true : 0`);

  // 4. wiki 双链跳转（点击预览中的 [[使用技巧]]）
  evalInPage(`[...document.querySelectorAll('#preview a.wikilink')].find(a => a.dataset.wiki.includes('使用技巧')).click()`);
  await new Promise((r) => setTimeout(r, 600));
  const s4 = evalInPage(`window.__np.state.current.rel`);
  check('双链跳转', /使用技巧/.test(s4), s4);

  // 5. 反向链接：在"使用技巧"里应能看到谁引用了它
  const s5 = evalInPage(`window.__np ? [...document.querySelectorAll('#rb-backlinks .backlink-item .bl-title')].map(e=>e.textContent) : []`);
  await new Promise((r) => setTimeout(r, 300));

  // 6. 主题切换
  const theme1 = evalInPage(`document.documentElement.dataset.theme`);
  evalInPage(`document.getElementById('btn-theme').click()`);
  const theme2 = evalInPage(`document.documentElement.dataset.theme`);
  check('主题切换', theme1 !== theme2, { theme1, theme2 });
  evalInPage(`document.getElementById('btn-theme').click()`); // 切回

  // 7. 今日笔记
  evalInPage(`window.__np.openToday().then(() => 'ok')`);
  await new Promise((r) => setTimeout(r, 600));
  const s7 = evalInPage(`window.__np.state.current.rel`);
  check('打开今日笔记', /^Calendar\/\d{4}-\d{2}-\d{2}\.md$/.test(s7), s7);

  // 8. CodeMirror 编辑器与装饰
  const s8 = evalInPage(`({
    cm: !!document.querySelector('.cm-editor'),
    boxes: document.querySelectorAll('#cm-host .cm-task-box').length,
    taHidden: document.getElementById('editor').style.display === 'none',
  })`);
  check('CodeMirror 编辑器生效', s8.cm && s8.taHidden);

  // 9. 任务面板
  evalInPage(`document.querySelector('.rb-tab[data-tab="tasks"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const s10 = evalInPage(`({
    groups: [...document.querySelectorAll('#rb-tasks .rt-group')].map(e => e.textContent),
    items: document.querySelectorAll('#rb-tasks .task-item').length,
  })`);
  check('任务总览分组渲染', s10.groups.length >= 2, s10.groups);

  // 10. 周条渲染 + 任务角标
  // 角标显示"当周有未完成任务"的日子；样例笔记里的排期是固定日期（>2026-09-01 等），
  // 换一周运行就会为空。这里动态写入一条排期为今天的任务，保证任何日期运行都成立。
  const fs10 = require('fs');
  const vaultDir = JSON.parse(evalInPage(`window.api.getVaultPath().then(p => JSON.stringify(p))`));
  const pad10 = (n) => String(n).padStart(2, '0');
  const today10 = (() => { const d = new Date(); return `${d.getFullYear()}-${pad10(d.getMonth() + 1)}-${pad10(d.getDate())}`; })();
  fs10.writeFileSync(path.join(vaultDir, 'Notes', '__test_weekbar.md'),
    `# w\n\n- [ ] 周条角标动态任务 >${today10}\n`, 'utf8');
  await new Promise((r) => setTimeout(r, 1800)); // watcher 防抖 350ms + 任务索引刷新 700ms + 渲染
  const s11 = evalInPage(`({
    days: document.querySelectorAll('.wb-day').length,
    badges: [...document.querySelectorAll('.wb-badge')].map(e => e.textContent),
  })`);
  check('周条渲染 7 天', s11.days === 7);
  check('周条待办角标', s11.badges.length >= 1, s11.badges);
  evalInPage(`window.api.trashNote('Notes/__test_weekbar.md')`);
  await new Promise((r) => setTimeout(r, 400));

  // 11. 改期 IPC（动态定位"清点书架"所在行）
  const schedLine = evalInPage(`window.api.readNote('Notes/项目/示例项目：整理书房.md').then(r => {
    const i = r.content.split('\\n').findIndex(l => l.includes('清点书架'));
    return i + 1;
  })`);
  const s12 = evalInPage(`window.api.rescheduleTask('Notes/项目/示例项目：整理书房.md', ${schedLine}, '2026-12-25').then(r => JSON.stringify(r))`);
  check('任务改期 IPC', s12 === '{"ok":true}', s12);
  const s12b = evalInPage(`window.api.readNote('Notes/项目/示例项目：整理书房.md').then(r => {
    const line = r.content.split('\\n')[${schedLine} - 1];
    return line.includes('>2026-12-25') ? 'ok' : line;
  })`);
  check('改期写入源文件', s12b === 'ok', s12b);
  evalInPage(`window.api.rescheduleTask('Notes/项目/示例项目：整理书房.md', ${schedLine}, '2026-09-05')`);
  await new Promise((r) => setTimeout(r, 400));

  // 12. 勾选任务 → 自动追加 @done(今天)；再取消 → 移除
  evalInPage(`window.__np.openNote('Notes/项目/示例项目：整理书房.md', {force:true}).then(() => 'ok')`);
  await new Promise((r) => setTimeout(r, 500));
  const tgl = (kw) => evalInPage(`(() => {
    const doc = window.__edGet();
    const lines = doc.split('\\n');
    const i = lines.findIndex(l => l.includes('${kw}'));
    if (i === -1) return 'NOT_FOUND';
    window.__np.applyTaskToggle(i + 1);
    return window.__edGet().split('\\n')[i];
  })()`);
  const before9 = evalInPage(`window.__edGet().split('\\n').findIndex(l => l.includes('清点书架'))`);
  const after9 = tgl('清点书架');
  check('勾选追加 @done', /- \[x\].*@done\(\d{4}-\d{2}-\d{2}\)/.test(String(after9)), after9);
  const after9b = tgl('清点书架');
  check('取消移除 @done', /- \[ \]/.test(String(after9b)) && !/@done/.test(String(after9b)), after9b);

  // 13. 循环任务：完成时在下一周期日期重建（过期任务从今天起算，日期动态计算）
  const pad = (n) => String(n).padStart(2, '0');
  const today2 = new Date();
  const fmtD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const schedWas = '2026-09-01';
  const recurBase = schedWas >= fmtD(today2) ? schedWas : fmtD(today2);
  const nextWeek = fmtD(new Date(new Date(recurBase + 'T12:00:00').getTime() + 7 * 86400000));
  await evalInPage(`window.api.createNote('Notes', '__test_recur', '# t\\n\\n- [ ] 测试循环任务 every week >2026-09-01\\n').then(r => JSON.stringify(r))`);
  await evalInPage(`window.__np.openNote('Notes/__test_recur.md', {force:true}).then(() => 'ok')`);
  await new Promise((r) => setTimeout(r, 500));
  tgl('测试循环任务');
  await new Promise((r) => setTimeout(r, 900));
  const s13 = evalInPage(`window.api.readNote('Calendar/${nextWeek}.md').then(r => {
    return r.content.includes('测试循环任务') && r.content.includes('>${nextWeek}') && r.content.includes('[ ]') ? 'ok' : r.content;
  })`);
  check('循环任务重建到下一周期', s13 === 'ok', s13);
  // 清理
  evalInPage(`window.api.trashNote('Notes/__test_recur.md')`);
  evalInPage(`window.api.trashNote('Calendar/${nextWeek}.md')`);
  await new Promise((r) => setTimeout(r, 400));

  // 14. 时间块：reschedule 携带时间
  const projRel = 'Notes/项目/示例项目：整理书房.md';
  const tbLine = evalInPage(`window.api.readNote('${projRel}').then(r => {
    return r.content.split('\\n').findIndex(l => l.includes('清点书架')) + 1;
  })`);
  evalInPage(`window.api.rescheduleTask('${projRel}', ${tbLine}, '2026-09-10', {start:'14:00', end:'15:30'})`);
  await new Promise((r) => setTimeout(r, 300));
  const s14 = evalInPage(`window.api.readNote('${projRel}').then(r => {
    const l = r.content.split('\\n')[${tbLine} - 1];
    return (l.includes('>2026-09-10') && l.includes('14:00-15:30')) ? 'ok' : l;
  })`);
  check('时间块写入源文件', s14 === 'ok', s14);
  const s14b = evalInPage(`window.api.tasksAll().then(list => {
    const t = list.find(t => t.rel.includes('示例项目') && t.start);
    return t ? t.start + '-' + t.end : 'none';
  })`);
  check('任务索引含时间块', s14b === '14:00-15:30', s14b);
  // 清除时间并还原日期
  evalInPage(`window.api.rescheduleTask('${projRel}', ${tbLine}, '2026-09-05', {clear:true})`);
  await new Promise((r) => setTimeout(r, 300));

  // 15. ICS 日历事件
  const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260915', 'SUMMARY:全天事件测试', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20260916T060000Z', 'DTEND:20260916T073000Z', 'SUMMARY:带时间事件测试', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20260907T020000Z', 'DTEND:20260907T030000Z', 'RRULE:FREQ=WEEKLY;COUNT=5', 'SUMMARY:每周例会测试', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  await evalInPage(`window.api.writeNote('test-cal.ics', ${JSON.stringify(ICS)}).then(r => JSON.stringify(r))`);
  evalInPage(`window.api.setSettings({calendars:[{src:'test-cal.ics'}]})`);
  await new Promise((r) => setTimeout(r, 400));
  const s15 = evalInPage(`window.api.calEvents('2026-09-01', '2026-09-30').then(list => {
    const allday = list.find(e => e.title.includes('全天事件测试') && e.date === '2026-09-15' && e.allDay);
    const timed = list.find(e => e.title.includes('带时间事件测试') && e.date === '2026-09-16' && e.startHM === '14:00' && e.endHM === '15:30');
    const weekly = list.filter(e => e.title.includes('每周例会测试')).map(e => e.date);
    if (!allday) return '缺少全天事件';
    if (!timed) return '缺少带时间事件（UTC 转换）: ' + JSON.stringify(list.filter(e => e.title.includes('带时间')));
    if (weekly.length !== 4) return '周循环次数错误: ' + JSON.stringify(weekly);
    return 'ok';
  })`);
  check('ICS 事件解析（全天/UTC时间/周循环）', s15 === 'ok', s15);

  // 16. 月视图渲染 + 时间轴
  evalInPage(`document.querySelector('#main-seg button[data-main=month]').click()`);
  await new Promise((r) => setTimeout(r, 800));
  const s16 = evalInPage(`({
    cells: document.querySelectorAll('.mv-cell').length,
    evChips: [...document.querySelectorAll('.mv-chip.ev')].map(e => e.textContent),
    calviewVisible: !document.getElementById('calview').hidden,
  })`);
  check('月视图渲染 42 格', s16.cells === 42 && s16.calviewVisible, s16.cells);
  check('月视图显示日历事件', s16.evChips.length >= 1, s16.evChips.slice(0, 3));
  // 选中 9/16，检查月历不再包含分时视图（时间轴已按需求移除）
  evalInPage(`(() => { const c = document.querySelector('.mv-cell[data-date="2026-09-16"]'); if (c) c.click(); })()`);
  await new Promise((r) => setTimeout(r, 400));
  const s16b = evalInPage(`({
    calvSideGone: !document.getElementById('calv-side') && !document.getElementById('tl-grid'),
  })`);
  check('月历不再包含分时视图', s16b.calvSideGone, s16b);
  evalInPage(`document.querySelector('#main-seg button[data-main=notes]').click()`);
  evalInPage(`window.api.setSettings({calendars:[]})`);
  evalInPage(`window.api.trashNote('test-cal.ics')`);
  await new Promise((r) => setTimeout(r, 400));

  // 17. Live Preview：非光标行的语法标记隐藏
  evalInPage(`window.__np.openNote('Notes/欢迎使用 NotePlan for Windows.md', {force:true}).then(() => 'ok')`);
  await new Promise((r) => setTimeout(r, 600));
  // 光标移到第一行（标题行，无 ** 或 [[）
  evalInPage(`(() => { const v = window.__edApi.getView(); v.dispatch({ selection: { anchor: 0 } }); return 'ok'; })()`);
  await new Promise((r) => setTimeout(r, 300));
  const s17 = evalInPage(`(() => {
    const lines = [...document.querySelectorAll('#cm-host .cm-line')];
    // "打开左侧 [[使用技巧]]" 是普通正文行，括号应被隐藏；行内代码里的 [[ 应保留
    const prose = lines.find((l) => l.textContent.includes('打开左侧'));
    const code = lines.find((l) => l.textContent.includes('待办事项'));
    return {
      proseHasWiki: prose ? prose.textContent.includes('[[') : null,
      codeKeepsRaw: code ? code.textContent.includes('- [ ]') : null,
      hasBold: [...document.querySelectorAll('#cm-host .cm-content')].some((c) => c.textContent.includes('**')),
    };
  })()`);
  check('语法标记完全隐藏', s17.proseHasWiki === false && s17.hasBold === false && s17.codeKeepsRaw === true, s17);

  // 18. 回收站：删除→列表→恢复→永久删除
  await evalInPage(`window.api.createNote('Notes', '__test_bin', '# x').then(r => JSON.stringify(r))`);
  evalInPage(`window.api.trashNote('Notes/__test_bin.md').then(r => JSON.stringify(r))`);
  await new Promise((r) => setTimeout(r, 300));
  const tid = evalInPage(`window.api.trashList().then(l => { const it = l.find(i => i.name.includes('__test_bin')); return it ? it.id : 'NONE'; })`);
  check('删除进入回收站', tid !== 'NONE' && String(tid).length > 5, tid);
  const s18b = evalInPage(`window.api.trashRestore('${tid}').then(r => JSON.stringify(r))`);
  check('回收站恢复', s18b.includes('"ok":true'), s18b);
  const s18c = evalInPage(`window.api.readNote('Notes/__test_bin.md').then(r => r.ok ? 'ok' : 'missing')`);
  check('恢复后文件存在', s18c === 'ok', s18c);
  evalInPage(`window.api.trashNote('Notes/__test_bin.md').then(r => 'ok')`);
  await new Promise((r) => setTimeout(r, 300));
  const tid2 = evalInPage(`window.api.trashList().then(l => { const it = l.find(i => i.name.includes('__test_bin')); return it ? it.id : 'NONE'; })`);
  evalInPage(`window.api.trashPurge('${tid2}').then(r => 'purged')`);
  await new Promise((r) => setTimeout(r, 300));
  const s18d = evalInPage(`window.api.trashList().then(l => l.find(i => i.name.includes('__test_bin')) ? 'still' : 'gone')`);
  check('永久删除', s18d === 'gone', s18d);
  const s18e = evalInPage(`window.api.readNote('Notes/__test_bin.md').then(r => JSON.stringify(r))`);
  check('永久删除后文件不存在', s18e.includes('"ok":false'), s18e);

  const fails = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - fails.length}/${results.length} 通过 ====`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FATAL:', e.message); process.exit(2); });

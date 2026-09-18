'use strict';
/* 自动补全验证：重置文档后分别触发 [[ # > @ ，检查补全弹层。 */

const { execFileSync } = require('child_process');
const path = require('path');

function evalInPage(expr) {
  const out = execFileSync('node', [path.join(__dirname, 'cdp-eval.js'), expr], { encoding: 'utf8' });
  return JSON.parse(out);
}

(async () => {
  await new Promise((r) => setTimeout(r, 300));

  const reset = async () => {
    evalInPage(`window.__np.openNote('Notes/欢迎使用 NotePlan for Windows.md', {force:true}).then(()=>'ok')`);
    await new Promise((r) => setTimeout(r, 450));
  };

  const insertAtEnd = (text) => evalInPage(`(() => {
    const view = window.__edApi.getView();
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: ${JSON.stringify(text)} }, selection: { anchor: end }, userEvent: 'input.type' });
    return 'ok';
  })()`);

  const tooltip = () => evalInPage(`(() => {
    const tip = document.querySelector('.cm-tooltip.cm-tooltip-autocomplete');
    if (!tip) return { open: false };
    const opts = [...tip.querySelectorAll('li')].map((li) => li.textContent.trim()).slice(0, 4);
    return { open: true, opts };
  })()`);

  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  -> ' + JSON.stringify(detail) : ''));
  };

  // 双链补全
  await reset();
  insertAtEnd('\n[[使用');
  await new Promise((r) => setTimeout(r, 1500));
  let t = tooltip();
  check('[[双链自动补全', t.open && t.opts.some((o) => o.includes('使用')), t.opts);

  // 标签补全
  await reset();
  insertAtEnd('\n#示');
  await new Promise((r) => setTimeout(r, 1500));
  t = tooltip();
  check('#标签自动补全', t.open && t.opts.length >= 1, t.opts);

  // 日期补全
  await reset();
  insertAtEnd('\n>2026');
  await new Promise((r) => setTimeout(r, 1500));
  t = tooltip();
  check('>日期自动补全', t.open && t.opts.length >= 1, t.opts);

  // 提及补全
  await reset();
  insertAtEnd('\n@我');
  await new Promise((r) => setTimeout(r, 1500));
  t = tooltip();
  check('@提及自动补全', t.open && t.opts.length >= 1, t.opts);

  console.log(`\n==== ${results.filter(Boolean).length}/${results.length} 通过 ====`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });

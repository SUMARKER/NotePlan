'use strict';
/* ==========================================================================
   编辑器行为：列表/任务自动续写、Tab 缩进、Ctrl+L 切换任务
   ========================================================================== */

(function () {

  const RE_LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s*)?(.*)$/;
  const RE_QUOTE_LINE = /^(\s*>\s?)(.*)$/;

  /** 把文本插入到选区（尽量保留原生撤销栈） */
  function insertText(textarea, text) {
    textarea.focus();
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (_) { /* ignore */ }
    if (!ok) {
      const { selectionStart: s, selectionEnd: e } = textarea;
      textarea.setRangeText(text, s, e, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function lineBounds(value, pos) {
    const start = value.lastIndexOf('\n', pos - 1) + 1;
    let end = value.indexOf('\n', pos);
    if (end === -1) end = value.length;
    return { start, end };
  }

  /**
   * 回车：自动续写列表 / 任务 / 引用
   * 返回 true 表示已处理（阻止默认换行）
   */
  function handleEnter(textarea) {
    const value = textarea.value;
    const pos = textarea.selectionStart;
    if (pos !== textarea.selectionEnd) return false;
    const { start, end } = lineBounds(value, pos);
    const line = value.slice(start, end);

    const lm = line.match(RE_LIST_LINE);
    if (lm) {
      const indent = lm[1];
      const marker = lm[2];
      const task = lm[3] || '';
      const content = lm[4];
      if (!content.trim() && !task.trim()) {
        // 空列表项 → 退出列表（删掉前缀）
        textarea.setSelectionRange(start, start + lm[0].length);
        insertText(textarea, indent);
        return true;
      }
      let nextMarker = marker;
      const num = marker.match(/^(\d+)([.)])$/);
      if (num) nextMarker = (parseInt(num[1], 10) + 1) + num[2];
      insertText(textarea, '\n' + indent + nextMarker + ' ' + (task ? '[ ] ' : ''));
      return true;
    }

    const qm = line.match(RE_QUOTE_LINE);
    if (qm && qm[2].trim()) {
      insertText(textarea, '\n' + qm[1]);
      return true;
    }
    return false;
  }

  /** 对选区涉及的每一行应用函数 */
  function eachSelectedLine(textarea, fn) {
    const value = textarea.value;
    const s = textarea.selectionStart;
    const e = textarea.selectionEnd;
    const ls = value.lastIndexOf('\n', s - 1) + 1;
    let le = value.indexOf('\n', e);
    if (le === -1) le = value.length;
    const block = value.slice(ls, le);
    const replaced = block.split('\n').map(fn).join('\n');
    if (replaced !== block) {
      textarea.setSelectionRange(ls, le);
      insertText(textarea, replaced);
    }
  }

  function handleTab(textarea, shift) {
    if (shift) {
      eachSelectedLine(textarea, (l) => l.replace(/^( {1,2}|\t)/, ''));
    } else {
      const multi = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).includes('\n');
      if (multi) {
        eachSelectedLine(textarea, (l) => '  ' + l);
      } else {
        insertText(textarea, '  ');
      }
    }
  }

  /**
   * 切换当前行（或选区内每一行）的任务状态：
   * - 任务 → 在 [ ] 与 [x] 之间切换
   * - 列表 → 追加复选框
   * - 普通行 → 转换为 "- [ ] 任务"
   */
  function toggleTask(textarea) {
    eachSelectedLine(textarea, (line) => {
      const m = line.match(/^(\s*)([-*+]\s+)(\[([ xX])\]\s*)?(.*)$/);
      if (!m) return '- [ ] ' + line.trim();
      const indent = m[1], marker = m[2], box = m[3], rest = m[5];
      if (box) {
        const checked = m[4] === 'x' || m[4] === 'X';
        return indent + marker + (checked ? '[ ] ' : '[x] ') + rest;
      }
      return indent + marker + '[ ] ' + rest;
    });
  }

  /** 预览中点击复选框：改写源文件对应行 */
  function setTaskState(textarea, lineNo, checked) {
    const value = textarea.value;
    const lines = value.split('\n');
    const idx = lineNo - 1;
    if (idx < 0 || idx >= lines.length) return false;
    const m = lines[idx].match(/^(\s*[-*+]\s+\[)([ xX])(\].*)$/);
    if (!m) return false;
    const before = lines.slice(0, idx).join('\n').length + (idx > 0 ? 1 : 0);
    const start = before + m[1].length;
    textarea.setRangeText(checked ? 'x' : ' ', start, start + 1, 'preserve');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  window.NPEditor = { handleEnter, handleTab, toggleTask, setTaskState, lineBounds };
})();

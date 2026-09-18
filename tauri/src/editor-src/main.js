/* ==========================================================================
   CodeMirror 6 编辑器扩展 —— esbuild 打包为 src/js/cm-bundle.js（IIFE，
   挂载 window.NPCM.createEditor）。
   Live Preview：语法标记在光标所在行完全隐藏、行内图片预览、表格渲染为
   组件、标题可折叠（Obsidian 式）。
   ========================================================================== */

import { EditorState, RangeSetBuilder, StateField } from '@codemirror/state';
import {
  EditorView, Decoration, WidgetType, ViewPlugin, keymap,
  drawSelection, placeholder, dropCursor,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, insertTab, indentLess,
} from '@codemirror/commands';
import {
  autocompletion, closeBrackets, closeBracketsKeymap, CompletionContext,
} from '@codemirror/autocomplete';
import { search, searchKeymap } from '@codemirror/search';
import { markdown, markdownLanguage, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { foldGutter, foldKeymap, codeFolding, foldService } from '@codemirror/language';

/* ---------------- 任务行解析（与 main.js / markdown.js 保持一致） ---------------- */

const RE_TASK_LINE = /^(\s*[-*+]\s+)\[([ xX])\]\s*(.*)$/;
const RE_RECURRENCE = /\b(?:every\s+(?:(\d+)\s+)?(day|week|month|year)s?)\b|\b每(?:天|日|周|星期|月|年)\b|\b每\s*(\d+)\s*(?:天|周|星期|月|年)\b/i;

function isRecurring(text) { return RE_RECURRENCE.test(text); }
function isDoneContent(text) { return /@done/i.test(text); }

/* ---------------- 图片地址解析 ---------------- */

function resolveImg(src, noteDir) {
  if (/^(https?:|data:|vault:)/i.test(src)) return src;
  let rel = src.replace(/\\/g, '/');
  if (rel.startsWith('/')) rel = rel.slice(1);
  else if (noteDir) rel = noteDir + '/' + rel;
  // Electron 下为 vault:/// 协议；WebView2 下由 api-shim 切换为 https://vault.local/
  const base = window.__VAULT_BASE || 'vault:///';
  return base + encodeURI(rel).replace(/%2F/gi, '/');
}

/* ---------------- Widgets ---------------- */

class TaskWidget extends WidgetType {
  constructor(checked, recurring, lineNo) {
    super();
    this.checked = checked;
    this.recurring = recurring;
    this.lineNo = lineNo;
  }
  eq(other) {
    return other.checked === this.checked && other.recurring === this.recurring && other.lineNo === this.lineNo;
  }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-task';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-task-box';
    box.checked = this.checked;
    box.contentEditable = 'false';
    box.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.host.onTaskToggle(this.lineNo, !this.checked);
    });
    wrap.appendChild(box);
    if (this.recurring) {
      const icon = document.createElement('span');
      icon.className = 'cm-rec-icon';
      icon.textContent = '🔁';
      icon.title = '循环任务';
      wrap.appendChild(icon);
    }
    return wrap;
  }
  ignoreEvent() { return false; }
}

class ImageWidget extends WidgetType {
  constructor(url, alt) {
    super();
    this.url = url;
    this.alt = alt;
  }
  eq(other) { return other.url === this.url && other.alt === this.alt; }
  toDOM() {
    const img = document.createElement('img');
    img.className = 'cm-inline-img';
    img.src = this.url;
    img.alt = this.alt;
    img.loading = 'lazy';
    img.title = this.alt;
    return img;
  }
  ignoreEvent() { return true; }
}

/** 表格 Block Widget：光标不在表格内时整块渲染为 HTML 表格 */
class TableWidget extends WidgetType {
  constructor(header, rows, blockFrom) {
    super();
    this.header = header;
    this.rows = rows;
    this.blockFrom = blockFrom;
  }
  eq(other) {
    return other.blockFrom === this.blockFrom &&
      JSON.stringify(other.header) === JSON.stringify(this.header) &&
      JSON.stringify(other.rows) === JSON.stringify(this.rows);
  }
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-table';
    const cell = (s, tag) => `<${tag}>${miniInline(s)}</${tag}>`;
    const ths = this.header.map((h) => cell(h, 'th')).join('');
    const trs = this.rows.map((r) => '<tr>' + this.header.map((_h, i) => cell(r[i] || '', 'td')).join('') + '</tr>').join('');
    wrap.innerHTML = `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.blockFrom } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() { return false; }
}

/** 表格单元格的迷你行内渲染 */
function miniInline(s) {
  let h = String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  h = h.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, a) => `<span class="cm-md-wiki">${a || t}</span>`);
  h = h.replace(/`([^`]+)`/g, '<code class="cm-md-code">$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  return h;
}

/* ---------------- 表格识别 ---------------- */

function isTableLine(t) { return /^\s*\|/.test(t) && t.includes('|'); }
function isTableSep(t) { return /^\s*\|?[\s:|\-]*-[\s:|\-]*$/.test(t) && t.includes('|') && /-/.test(t); }
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/* ---------------- 标题折叠 ---------------- */

const headingFoldService = foldService.of((state, from) => {
  const line = state.doc.lineAt(from);
  const m = line.text.match(/^(#{1,6})\s+(.+)$/);
  if (!m) return null;
  const level = m[1].length;
  let end = line.to;
  let pos = line.to + 1;
  while (pos <= state.doc.length) {
    const l = state.doc.lineAt(pos);
    const hm = l.text.match(/^(#{1,6})\s/);
    if (hm && hm[1].length <= level) break;
    if (l.text.trim()) end = l.to;
    pos = l.to + 1;
  }
  if (end <= line.to) return null;
  return { from: line.to, to: end };
});

/* ---------------- 装饰构建（Live Preview 核心） ---------------- */

function buildDecorations(state, host) {
  const view = { state }; // 内部只用 view.state；全文档扫描，不再依赖视图
  const ranges = [];
  const selLines = new Set();
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(Math.min(r.anchor, r.head)).number;
    const b = view.state.doc.lineAt(Math.max(r.anchor, r.head)).number;
    for (let i = a; i <= b; i++) selLines.add(i);
  }

  const push = (from, to, deco) => { if (to > from) ranges.push({ from, to, deco }); };
  const decoMark = (cls) => Decoration.mark({ class: cls });
  const decoLine = (cls) => Decoration.line({ class: cls });
  // 光标所在行：标记显示（半透明）；否则完全隐藏
  const hideSeg = (ln, from, to) => {
    if (selLines.has(ln)) push(from, to, decoMark('cm-md-mark-on'));
    else push(from, to, Decoration.replace({}));
  };
  const showSeg = (ln, from, to, cls) => {
    if (selLines.has(ln)) push(from, to, decoMark(cls + ' cm-md-mark-on'));
    else push(from, to, decoMark(cls));
  };

  let inFence = false;
  let fenceFrom = -1;
  let fenceTo = -1;
  let fenceBuf = [];
  let fenceLang = '';
  let fenceLines = [];

  // 全文档扫描（笔记体量小；隐藏必须覆盖视口之外，否则滚动会露出源码）
  for (let pos = 0; pos < view.state.doc.length;) {
    const line = view.state.doc.lineAt(pos);
    const text = line.text;
    const ln = line.number;
    const base = line.from;

      // 围栏代码块
      if (/^\s*```/.test(text)) {
        if (inFence) {
          fenceTo = line.to;
          fenceLines.push(ln);
          if (!selLines.has(ln) && !selLines.has(fenceLines[0])) {
            push(fenceFrom, fenceTo, Decoration.replace({ block: true, widget: new CodeBlockWidget(fenceBuf.join('\n'), fenceLang) }));
          }
          inFence = false;
        } else {
          inFence = true;
          fenceFrom = base;
          fenceTo = line.to;
          fenceLang = text.replace(/^\s*```/, '').trim();
          fenceBuf = [];
          fenceLines = [ln];
          ranges.push({ from: base, to: base, deco: decoLine('cm-md-codeblock') });
        }
        pos = line.to + 1;
        continue;
      }
      if (inFence) {
        fenceBuf.push(text);
        fenceLines.push(ln);
        pos = line.to + 1;
        continue;
      }

      // 表格块：光标不在其中时整块渲染为表格
      if (isTableLine(text) && ln + 1 <= view.state.doc.lines) {
        const next = view.state.doc.line(ln + 1);
        if (isTableSep(next.text)) {
          // 收集整个表格
          const header = splitRow(text);
          const rows = [];
          let last = next;
          let p = ln + 2;
          while (p <= view.state.doc.lines) {
            const l2 = view.state.doc.line(p);
            if (!isTableLine(l2.text)) break;
            rows.push(splitRow(l2.text));
            last = l2;
            p++;
          }
          const tableLines = new Set();
          for (let i2 = ln; i2 <= last.number; i2++) tableLines.add(i2);
          const active = [...tableLines].some((i2) => selLines.has(i2));
          if (!active) {
            push(base, last.to, Decoration.replace({ block: true, widget: new TableWidget(header, rows, base) }));
            pos = last.to + 1;
            continue;
          }
        }
      }

      // 标题：# 标记隐藏（光标行显示），整行放大
      const h = text.match(/^(#{1,6})(\s+)(.*)$/);
      if (h && h[3].trim()) {
        ranges.push({ from: base, to: base, deco: decoLine('cm-md-h' + h[1].length) });
        hideSeg(ln, base, base + h[1].length + h[2].length);
        pos = line.to + 1;
        continue;
      }

      // 引用（排除纯日程行）— 行样式保留，"> " 标记隐藏
      if (/^>\s?/.test(text) && !/^>\s*\d{4}-\d{2}-\d{2}\b/.test(text)) {
        ranges.push({ from: base, to: base, deco: decoLine('cm-md-quote') });
        const qm = text.match(/^(>\s?)/);
        if (qm) hideSeg(ln, base, base + qm[1].length);
      }

      // 水平线
      if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(text)) {
        ranges.push({ from: base, to: base, deco: decoLine('cm-md-hr') });
        pos = line.to + 1;
        continue;
      }

      // 任务行
      const tm = text.match(RE_TASK_LINE);
      if (tm) {
        const checked = tm[2] !== ' ';
        const rest = tm[3];
        const doneByTag = isDoneContent(rest);
        const boxFrom = base + tm[1].length;
        if (selLines.has(ln)) {
          // 光标行显示原始语法
          push(boxFrom, boxFrom + 3, decoMark('cm-md-mark-on'));
        } else {
          ranges.push({
            from: boxFrom, to: boxFrom + 3,
            deco: Decoration.replace({
              widget: new TaskWidget(checked || doneByTag, isRecurring(rest), ln),
            }),
          });
        }
        push(base, base + tm[1].length - 1, decoMark('cm-md-mark'));
        if (checked || doneByTag) {
          ranges.push({ from: base, to: base, deco: decoLine('cm-md-taskdone') });
        }
        // 任务行内的行内语法继续走下面的通用扫描
      } else {
        // 普通列表符
        const bm = text.match(/^(\s*)([-*+])(\s)/);
        if (bm) push(base + bm[1].length, base + bm[1].length + 1, decoMark('cm-md-mark'));
        const om = text.match(/^(\s*)(\d+([.)]))(\s)/);
        if (om) push(base + om[1].length, base + om[1].length + om[2].length, decoMark('cm-md-mark'));
      }

      /* ---- 行内语法 ---- */
      const occ = new Array(text.length).fill(false);
      const free = (a, b) => { for (let i = a; i < b; i++) if (occ[i]) return false; return true; };
      const take = (a, b) => { for (let i = a; i < b; i++) occ[i] = true; };
      const scan = (re, handler) => {
        for (const m of text.matchAll(re)) {
          const i = m.index, j = i + m[0].length;
          if (!free(i, j)) continue;
          handler(m, i, j);
        }
      };

      // 图片（优先于其它规则）
      scan(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, i, j) => {
        take(i, j);
        if (selLines.has(ln)) {
          push(base + i, base + i + 2, decoMark('cm-md-mark-on'));
          push(base + j - 1, base + j, decoMark('cm-md-mark-on'));
          return;
        }
        push(base + i, base + j, Decoration.replace({
          widget: new ImageWidget(resolveImg(m[2], host.noteDir), m[1]),
        }));
      });

      // 行内代码
      scan(/`[^`\n]+`/g, (m, i, j) => {
        take(i, j);
        hideSeg(ln, base + i, base + i + 1);
        hideSeg(ln, base + j - 1, base + j);
        push(base + i + 1, base + j - 1, decoMark('cm-md-code'));
      });

      // 双链
      scan(/\[\[[^\]\n]+\]\]/g, (m, i, j) => {
        take(i, j);
        hideSeg(ln, base + i, base + i + 2);
        hideSeg(ln, base + j - 2, base + j);
        push(base + i + 2, base + j - 2, decoMark('cm-md-wiki'));
      });

      // 日程日期
      scan(/(^|[\s(（：，、；！？])>\d{4}-\d{2}-\d{2}\b/g, (m, i, j) => {
        const start = i + m[1].length;
        take(start, j);
        push(base + start, base + j, decoMark('cm-md-schedule'));
      });

      // 标签
      scan(/(^|[\s(（])#[^\s#。，！？.,!?：:]+/g, (m, i, j) => {
        const start = i + m[1].length;
        take(start, j);
        push(base + start, base + j, decoMark('cm-md-tag'));
      });

      // @done 标记
      scan(/@done(?:\([^)\n]*\))?/gi, (m, i, j) => {
        take(i, j);
        push(base + i, base + j, decoMark('cm-md-donetag'));
      });

      // 提及
      scan(/(^|[\s(（])@[^\s@，。！？，。]+/g, (m, i, j) => {
        const start = i + m[1].length;
        if (!free(start, j)) return;
        take(start, j);
        push(base + start, base + j, decoMark('cm-md-mention'));
      });

      // 粗体
      scan(/\*\*[^*\n]+\*\*/g, (m, i, j) => {
        take(i, j);
        hideSeg(ln, base + i, base + i + 2);
        hideSeg(ln, base + j - 2, base + j);
        push(base + i + 2, base + j - 2, decoMark('cm-md-strong'));
      });

      // 斜体
      scan(/\*[^*\n]+\*/g, (m, i, j) => {
        take(i, j);
        hideSeg(ln, base + i, base + i + 1);
        hideSeg(ln, base + j - 1, base + j);
        push(base + i + 1, base + j - 1, decoMark('cm-md-em'));
      });

      // 高亮
      scan(/==[^=\n]+==/g, (m, i, j) => {
        take(i, j);
        hideSeg(ln, base + i, base + i + 2);
        hideSeg(ln, base + j - 2, base + j);
        push(base + i + 2, base + j - 2, decoMark('cm-md-hl'));
      });

      // 删除线
      scan(/~~[^~\n]+~~/g, (m, i, j) => {
        take(i, j);
        hideSeg(ln, base + i, base + i + 2);
        hideSeg(ln, base + j - 2, base + j);
        push(base + i + 2, base + j - 2, decoMark('cm-md-strike'));
      });

      // 注释
      scan(/%%[^%\n]+%%/g, (m, i, j) => {
        take(i, j);
        hideSeg(ln, base + i, base + i + 2);
        hideSeg(ln, base + j - 2, base + j);
        push(base + i + 2, base + j - 2, decoMark('cm-md-comment'));
      });

      pos = line.to + 1;
    }

  // Decoration.set(..., true) 会按 (from, startSide) 正确排序，避免手写排序的 side 违规
  return Decoration.set(ranges.map((r) => r.deco.range(r.from, r.to)), true);
}

class CodeBlockWidget extends WidgetType {
  constructor(code, lang) {
    super();
    this.code = code;
    this.lang = lang;
  }
  eq(other) { return other.code === this.code && other.lang === this.lang; }
  toDOM() {
    const wrap = document.createElement('pre');
    wrap.className = 'cm-codeblock-widget';
    const code = document.createElement('code');
    code.textContent = this.code;
    wrap.appendChild(code);
    return wrap;
  }
  ignoreEvent() { return true; }
}

function decorationsExtension(host) {
  window.__decoPlugged = true;
  const safeBuild = (st) => {
    try {
      const set = buildDecorations(st, host);
      window.__decoCount = set.size;
      return set;
    } catch (err) {
      window.__decoError = String((err && err.message) || err);
      return Decoration.none;
    }
  };
  // block 装饰必须经由 StateField 提供（ViewPlugin 不支持 block replace）
  return StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
      if (!tr.docChanged && !tr.selection && deco.size) return deco;
      return safeBuild(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/* ---------------- 自动补全：双链 / 标签 / 日期 / 提及 ---------------- */

function buildCompletions(prov) {
  const wikiSource = (ctx) => {
    const before = ctx.matchBefore(/\[\[[^\]\n]*/);
    if (!before) return null;
    const typed = ctx.state.sliceDoc(before.from + 2, ctx.pos);
    const items = prov.titles();
    if (!items.length) return null;
    return {
      from: before.from + 2,
      validFor: /^[^\]\n]*$/,
      options: items.slice(0, 50).map((t) => ({
        label: t.title,
        detail: t.exists ? '' : '新建',
        type: 'class',
        boost: t.exists ? 0 : -5,
        apply: `[[${t.title}]]`,
      })),
    };
  };

  const tagSource = (ctx) => {
    const before = ctx.matchBefore(/#[^\s#。，！？.,!?：:]*/);
    if (!before) return null;
    if (before.from > 0) {
      const prev = ctx.state.sliceDoc(before.from - 1, before.from);
      if (prev.trim() && prev !== '(' && prev !== '（') return null;
    }
    const from = before.from + 1;
    const items = prov.tags();
    if (!items.length) return null;
    return {
      from,
      validFor: /^[^\s#。，！？.,!?：:]*$/,
      options: items.slice(0, 40).map((t) => ({ label: t, type: 'type', apply: `#${t}` })),
    };
  };

  const mentionSource = (ctx) => {
    const before = ctx.matchBefore(/@[^\s@，。！？]*/);
    if (!before) return null;
    if (before.from > 0) {
      const prev = ctx.state.sliceDoc(before.from - 1, before.from);
      if (prev.trim() && prev !== '(' && prev !== '（') return null;
    }
    const from = before.from + 1;
    const items = prov.mentions();
    if (!items.length) return null;
    return {
      from,
      validFor: /^[^\s@，。！？]*$/,
      options: items.slice(0, 30).map((n) => ({ label: n, type: 'variable', apply: `@${n}` })),
    };
  };

  const pad2 = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const dateSource = (ctx) => {
    const before = ctx.matchBefore(/>[^\s\n]*/);
    if (!before) return null;
    const from = before.from + 1;
    const typed = ctx.state.sliceDoc(from, ctx.pos).toLowerCase();
    const today = new Date();
    const options = [];
    const kwMatch = (kw, ds) => !typed || kw.startsWith(typed) || ds.startsWith(typed);
    const addDate = (d, label) => {
      const ds = fmt(d);
      if (label) {
        if (!kwMatch(label, ds)) return;
        options.push({
          label: `${label}  ${ds} ${WEEK[d.getDay()]}`,
          type: 'keyword',
          apply: `>${ds} `,
          boost: 10,
        });
        return;
      }
      if (typed && !ds.startsWith(typed)) return;
      options.push({ label: `${ds} ${WEEK[d.getDay()]}`, type: 'keyword', apply: `>${ds} ` });
    };
    const day = 86400000;
    addDate(new Date(today), '今天');
    addDate(new Date(today.getTime() + day), '明天');
    addDate(new Date(today.getTime() + 2 * day), '后天');
    for (let i = 3; i <= 90; i++) {
      addDate(new Date(today.getTime() + i * day), null);
      if (options.length > 40) break;
    }
    return { from, validFor: /^[^\s\n]*$/, options };
  };

  return autocompletion({
    override: [wikiSource, tagSource, mentionSource, dateSource],
    activateOnTyping: true,
    icons: false,
    closeOnBlur: true,
    maxRenderedOptions: 30,
  });
}

/* ---------------- 创建编辑器 ---------------- */

export function createEditor(parent, opts) {
  const host = {
    onTaskToggle: opts.onTaskToggle || (() => {}),
    noteDir: '',
  };

  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged && opts.onDocChanged && !host.suppress) opts.onDocChanged();
  });

  const state = EditorState.create({
    doc: opts.doc || '',
    extensions: [
      EditorView.lineWrapping,
      drawSelection(),
      dropCursor(),
      history(),
      placeholder(opts.placeholder || ''),
      closeBrackets(),
      search({ top: true }),
      markdown({ base: markdownLanguage }),
      buildCompletions(opts.completions || { titles: () => [], tags: () => [], mentions: () => [] }),
      decorationsExtension(host),
      headingFoldService,
      codeFolding(),
      foldGutter({
        markerDOM: (open) => {
          const sp = document.createElement('span');
          sp.className = 'cm-fold-marker' + (open ? ' open' : '');
          sp.textContent = '▸';
          return sp;
        },
      }),
      keymap.of([
        { key: 'Enter', run: insertNewlineContinueMarkup },
        { key: 'Tab', run: insertTab },
        { key: 'S-Tab', run: indentLess },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
      ]),
      updateListener,
      EditorView.contentAttributes.of({ spellcheck: 'false' }),
      EditorView.theme({ '&': { height: '100%' } }),
    ],
  });

  const view = new EditorView({ state, parent });
  host.view = view;

  return {
    getDoc: () => view.state.doc.toString(),
    setDoc: (text) => {
      if (view.state.doc.toString() === text) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    getLine: (n) => {
      if (n < 1 || n > view.state.doc.lines) return null;
      return view.state.doc.line(n).text;
    },
    replaceLine: (n, text) => {
      if (n < 1 || n > view.state.doc.lines) return;
      const l = view.state.doc.line(n);
      view.dispatch({ changes: { from: l.from, to: l.to, insert: text } });
    },
    cursorLines: () => {
      // 选区覆盖到的每一行（多行选区 / 多光标展开；无选区时即光标所在行）
      const set = new Set();
      for (const r of view.state.selection.ranges) {
        const from = view.state.doc.lineAt(r.from).number;
        const to = view.state.doc.lineAt(r.to).number;
        for (let i = from; i <= to; i++) set.add(i);
      }
      return [...set];
    },
    hasSelection: () => view.state.selection.ranges.some((r) => r.from !== r.to),
    selectedText: () => {
      const s = view.state.selection.main;
      return s.from === s.to ? '' : view.state.sliceDoc(s.from, s.to);
    },
    revealLine: (n) => {
      const total = view.state.doc.lines;
      const l = view.state.doc.line(Math.max(1, Math.min(n, total)));
      view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
      view.focus();
    },
    focus: () => view.focus(),
    getView: () => view,
    setNoteDir: (dir) => { host.noteDir = dir; },
  };
}

window.NPCM = { createEditor };

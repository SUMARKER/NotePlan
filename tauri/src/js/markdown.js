'use strict';
/* ==========================================================================
   NotePlan 风格 Markdown 渲染器
   支持：标题 / 任务复选框 / 嵌套列表 / [[双链]] / #标签 / @提及 /
        >2026-09-01 日程 / ==高亮== / %%注释%% / 代码块 / 表格 / 引用 / 图片
   ========================================================================== */

(function () {

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ---------------- 行内语法 ---------------- */

  /**
   * @param {string} text    原始文本（未转义）
   * @param {object} ctx     { codes: string[], noteDir: string }
   */
  function inline(text, ctx) {
    let s = esc(text);
    const codes = ctx.codes;

    // 行内代码（最先处理，保护内容不被其它规则改写）
    s = s.replace(/`([^`\n]+)`/g, (_m, c) => stash(`<code class="inline-code">${c}</code>`, codes));

    // 图片 ![alt](src)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
      const url = resolveImg(src, ctx);
      return stash(`<img src="${url}" alt="${alt}" loading="lazy">`, codes);
    });

    // 链接 [label](href)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
      if (/^(https?:|mailto:)/i.test(href)) {
        return stash(`<a href="${href}" class="ext-link">${inline(label, ctx)}</a>`, codes);
      }
      // 库内链接：当作 wiki 链接处理
      const t = decodeURIComponent(href).replace(/\.md$/i, '');
      return stash(`<a class="wikilink" data-wiki="${t}">${inline(label, ctx)}</a>`, codes);
    });

    // 裸 URL 自动链接
    s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<>()，。！？；：]+[^\s<>()，。！？；：.!?;:，。！？；：])/g,
      (_m, pre, url) => stash(`${pre}<a href="${url}" class="ext-link">${url}</a>`, codes));

    // [[双链]] / [[目标|别名]]
    s = s.replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_m, target, alias) => {
      const t = target.trim();
      const label = (alias || t).trim();
      return stash(`<a class="wikilink" data-wiki="${t}">${label}</a>`, codes);
    });

    // >2026-09-01 日程安排（注意：此时 > 已被转义为 &gt;；前面允许全角标点）
    s = s.replace(/(^|[\s(（：，、；！？])(?:>|&gt;)(\d{4}-\d{2}-\d{2})\b/g, (_m, pre, date) =>
      stash(`${pre}<span class="schedule" data-date="${date}" title="跳转到这一天的每日笔记">📅 ${date}</span>`, codes));

    // #标签
    s = s.replace(/(^|[\s(（])#([^\s#.,!?;:，。！？；：()（）\[\]{}'"<>…·、“”]+)/g, (_m, pre, tag) => {
      const t = tag.replace(/[.,!?;:，。！？；：]+$/, '');
      const rest = tag.slice(t.length);
      return stash(`${pre}<a class="tag" data-tag="${t}">#${t}</a>${rest}`, codes);
    });

    // @done 完成标记（先于 @提及 处理）
    s = s.replace(/@done(?:\(([^)\n]*)\))?/gi, (_m, d) =>
      stash(`<span class="done-chip">✓${d ? ' ' + d : ''}</span>`, codes));

    // 循环任务标记
    s = s.replace(/\b(?:every\s+(?:(\d+)\s+)?(day|week|month|year)s?)\b|\b每(?:天|日|周|星期|月|年)\b|\b每\s*(\d+)\s*(?:天|周|星期|月|年)\b/gi,
      (m) => stash(`<span class="rec-chip" title="循环任务">🔁 ${m}</span>`, codes));

    // @提及
    s = s.replace(/(^|[\s(（])@([^\s@，。！？；：()（）]+)/g, (_m, pre, name) =>
      stash(`${pre}<span class="mention">@${name}</span>`, codes));

    // ==高亮==
    s = s.replace(/==([^=\n]+)==/g, (_m, c) => `<mark>${c}</mark>`);

    // %%注释%%
    s = s.replace(/%%([^%\n]+)%%/g, (_m, c) => `<span class="md-comment">${c}</span>`);

    // **粗体** / __粗体__
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');

    // *斜体* / _斜体_
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/(^|[\s(（])_([^_\n]+)_(?=$|[\s.,!?;:，。！？；：)（）'"”])/g, '$1<em>$2</em>');

    // ~~删除线~~
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    // 还原占位符
    s = s.replace(/\x00(\d+)\x00/g, (_m, i) => codes[+i]);
    return s;
  }

  function stash(html, codes) {
    codes.push(html);
    return `\x00${codes.length - 1}\x00`;
  }

  function resolveImg(src, ctx) {
    if (/^(https?:|data:|vault:)/i.test(src)) return src;
    let rel = src.replace(/\\/g, '/');
    if (rel.startsWith('/')) rel = rel.slice(1);
    else if (ctx.noteDir) rel = ctx.noteDir + '/' + rel;
    // Electron 下为 vault:/// 协议；Tauri 下由 api-shim-tauri 设为 vault 基址
    const base = (typeof window !== 'undefined' && window.__VAULT_BASE) || 'vault:///';
    return base + encodeURI(rel).replace(/%2F/gi, '/');
  }

  /* ---------------- 块级语法 ---------------- */

  const RE_HEADING = /^(#{1,6})\s+(.*)$/;
  const RE_LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const RE_TASK = /^\[([ xX])\]\s*(.*)$/;
  const RE_HR = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
  const RE_FENCE = /^\s*```\s*(\S*)\s*$/;
  const RE_QUOTE = /^>\s?(.*)$/;
  const RE_SCHEDULE_LINE = /^>\s*\d{4}-\d{2}-\d{2}\b/;
  const RE_TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*$/;

  function isTableLine(line) {
    return /^\s*\|/.test(line) && line.includes('|');
  }

  function isBlockStart(line) {
    return !line.trim() || RE_HEADING.test(line) || RE_FENCE.test(line) ||
      RE_LIST_ITEM.test(line) || RE_HR.test(line) ||
      (/^>\s?/.test(line) && !RE_SCHEDULE_LINE.test(line)) ||
      isTableLine(line);
  }

  function stripInlineForOutline(text) {
    return text
      .replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_m, t, a) => a || t)
      .replace(/[*_~`#=]|%%/g, '')
      .trim();
  }

  function renderBlocks(lines, ctx, outline) {
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 空行
      if (!line.trim()) { i++; continue; }

      // 围栏代码块
      const fence = line.match(RE_FENCE);
      if (fence) {
        const lang = fence[1];
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过结束 ```
        const cls = lang ? ` class="language-${esc(lang)}"` : '';
        out.push(`<pre><code${cls}>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }

      // 标题
      const h = line.match(RE_HEADING);
      if (h) {
        const level = h[1].length;
        const text = h[2].trim();
        const lineNo = i + 1;
        const id = 'h-' + lineNo;
        outline.push({ level, text: stripInlineForOutline(text), line: lineNo });
        out.push(`<h${level} id="${id}">${inline(text, ctx)}</h${level}>`);
        i++;
        continue;
      }

      // 水平线
      if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }

      // 引用块
      if (/^>\s?/.test(line) && !RE_SCHEDULE_LINE.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i]) && !RE_SCHEDULE_LINE.test(lines[i])) {
          buf.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        const inner = buf.map((l) => l.trim() ? inline(l, ctx) : '<br>').join('<br>');
        out.push(`<blockquote><p>${inner}</p></blockquote>`);
        continue;
      }

      // 表格
      if (isTableLine(line) && i + 1 < lines.length &&
          RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('|')) {
        const result = parseTable(lines, i, ctx);
        out.push(result.html);
        i = result.next;
        continue;
      }

      // 列表（含任务）。有序/无序混写时拆成多段列表
      if (RE_LIST_ITEM.test(line)) {
        const items = [];
        while (i < lines.length && RE_LIST_ITEM.test(lines[i])) {
          const m = lines[i].match(RE_LIST_ITEM);
          items.push({
            indent: m[1].replace(/\t/g, '    ').length,
            ordered: /\d/.test(m[2][0]),
            content: m[3],
            line: i + 1,
          });
          i++;
          // 吞掉列表项之间的空行（宽松处理）
          while (i < lines.length && !lines[i].trim() &&
                 i + 1 < lines.length && RE_LIST_ITEM.test(lines[i + 1])) i++;
        }
        let rest = items;
        while (rest.length) {
          const built = buildList(rest, 0, rest[0].indent, ctx);
          out.push(built.html);
          if (built.next >= rest.length) break;
          rest = rest.slice(built.next);
        }
        continue;
      }

      // 段落（单换行视为 <br>，更符合笔记习惯）
      const buf = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (buf.length) {
        out.push(`<p>${buf.map((l) => inline(l, ctx)).join('<br>')}</p>`);
      } else {
        i++; // 兜底，避免死循环
      }
    }

    return out.join('\n');
  }

  /* 递归构建嵌套列表 */
  function buildList(items, start, indent, ctx) {
    const ordered = items[start].ordered;
    const parts = [];
    let k = start;

    while (k < items.length && items[k].indent >= indent) {
      // 同级出现另一种列表类型 → 结束当前列表，由外层另起一段
      if (items[k].indent === indent && items[k].ordered !== ordered) break;
      const it = items[k];
      const tm = it.content.match(RE_TASK);
      if (tm) {
        // 已完成：复选框勾选，或带 @done 标记
        const done = tm[1] !== ' ' || /@done/i.test(tm[2]);
        parts.push(
          `<li class="task${done ? ' done' : ''}" data-line="${it.line}">` +
          `<input type="checkbox" class="task-box" data-line="${it.line}"${done ? ' checked' : ''}>` +
          `<span class="task-body">${inline(tm[2], ctx)}</span>`
        );
      } else {
        parts.push(`<li><span class="task-body">${inline(it.content, ctx)}</span>`);
      }
      k++;

      // 子列表
      if (k < items.length && items[k].indent > indent) {
        const sub = buildList(items, k, items[k].indent, ctx);
        parts[parts.length - 1] += sub.html;
        k = sub.next;
      }
      parts[parts.length - 1] += '</li>';
    }

    const tag = ordered ? 'ol' : 'ul';
    return { html: `<${tag}>${parts.join('')}</${tag}>`, next: k };
  }

  /* 解析表格 */
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  }

  function parseTable(lines, i, ctx) {
    const head = splitRow(lines[i]);
    i += 2; // 跳过分隔行
    const aligns = splitRow(lines[i - 1]).map((c) => {
      const l = c.startsWith(':'), r = c.endsWith(':');
      if (l && r) return ' style="text-align:center"';
      if (r) return ' style="text-align:right"';
      return '';
    });
    const body = [];
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
      const cells = splitRow(lines[i]);
      const tds = head.map((_h, ci) =>
        `<td${aligns[ci] || ''}>${inline(cells[ci] || '', ctx)}</td>`).join('');
      body.push(`<tr>${tds}</tr>`);
      i++;
    }
    const ths = head.map((_h, ci) => `<th${aligns[ci] || ''}>${inline(_h, ctx)}</th>`).join('');
    return { html: `<table><thead><tr>${ths}</tr></thead><tbody>${body.join('')}</tbody></table>`, next: i };
  }

  /* ---------------- 对外接口 ---------------- */

  /**
   * 渲染 Markdown 为 HTML
   * @returns {{ html: string, outline: {level:number,text:string,line:number}[] }}
   */
  function render(src, opts) {
    opts = opts || {};
    const ctx = { codes: [], noteDir: opts.noteDir || '' };
    const outline = [];
    const lines = String(src || '').split(/\r?\n/);
    const html = renderBlocks(lines, ctx, outline);
    return { html, outline };
  }

  window.NPMarkdown = { render, esc, inline };
})();

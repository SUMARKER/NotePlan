'use strict';
global.window = {};
require('../tauri/src/js/markdown.js');
const md = window.NPMarkdown;

const src = [
  '# 标题一',
  '',
  '段落 **加粗** *斜体* ==高亮== `code` ~~删~~ %%注释%%',
  '链接 [[使用技巧|点我]] 和 [[不存在的笔记]] 还有 #标签 和 @某人 与 >2026-09-05 安排',
  '',
  '- [ ] 未完成任务 >2026-09-02',
  '- [x] 已完成',
  '  - 嵌套项',
  '- 普通项',
  '',
  '1. 第一',
  '2. 第二',
  '',
  '> 引用行',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
].join('\n');

const r = md.render(src, { noteDir: 'Notes' });
console.log(r.html);
console.log('--- outline:', JSON.stringify(r.outline));

'use strict';
/* 把 src/editor-src/main.js（CodeMirror 6 扩展）打包为浏览器 IIFE。
 * 产物提交进仓库，运行 `npm start` 无需先构建；改动编辑器源码后执行 `npm run build`。 */

const { build } = require('esbuild');

build({
  entryPoints: ['src/editor-src/main.js'],
  outfile: 'src/js/cm-bundle.js',
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  minify: true,
  logLevel: 'info',
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

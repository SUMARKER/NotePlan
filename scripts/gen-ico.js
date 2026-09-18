'use strict';
/* 把 assets/icon.png 包装成 assets/icon.ico（PNG 压缩的 ICO 条目，Vista+ 支持）。 */

const fs = require('fs');
const path = require('path');

const png = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png'));

// ICO 头：保留字 0 + 类型 1(图标) + 数量 1
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

// 目录项：256x256 用 0 表示
const entry = Buffer.alloc(16);
entry[0] = 0;   // width  (0 = 256)
entry[1] = 0;   // height (0 = 256)
entry[2] = 0;   // 调色板数
entry[3] = 0;   // 保留
entry.writeUInt16LE(1, 4);        // 颜色平面
entry.writeUInt16LE(32, 6);       // 位深
entry.writeUInt32LE(png.length, 8);           // 数据长度
entry.writeUInt32LE(6 + 16, 12);              // 数据偏移

const out = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.writeFileSync(out, Buffer.concat([header, entry, png]));
console.log('written:', out, 6 + 16 + png.length, 'bytes');

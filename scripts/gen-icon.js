'use strict';
/* 生成 assets/icon.png（256x256）：渐变圆角方块 + 白色 "N"。
 * 仅依赖 Node 内置 zlib，直接手工编码 PNG。 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const RADIUS = 56;

/* ---------- 像素绘制 ---------- */

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// 到线段的距离
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  const x = ax + t * dx, y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function roundRectAlpha(x, y) {
  const cx = clamp(x, RADIUS, SIZE - RADIUS);
  const cy = clamp(y, RADIUS, SIZE - RADIUS);
  const d = Math.hypot(x - cx, y - cy);
  return clamp(RADIUS - d + 0.5, 0, 1); // 1px 抗锯齿
}

function lerp(a, b, t) { return a + (b - a) * t; }

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    // 对角渐变 #3478f6 -> #6a5cff
    const t = clamp((x + y) / (2 * SIZE), 0, 1);
    let r = Math.round(lerp(0x34, 0x6a, t));
    let g = Math.round(lerp(0x78, 0x5c, t));
    let b = Math.round(lerp(0xf6, 0xff, t));
    let a = Math.round(roundRectAlpha(x + 0.5, y + 0.5) * 255);

    // 白色 "N"（三段粗线，圆头）
    const nd = Math.min(
      distToSegment(x + 0.5, y + 0.5, 84, 182, 84, 74),   // 左竖
      distToSegment(x + 0.5, y + 0.5, 172, 182, 172, 74), // 右竖
      distToSegment(x + 0.5, y + 0.5, 84, 74, 172, 182),  // 对角
    );
    const THICK = 15;
    if (nd < THICK) {
      const cover = clamp(THICK - nd + 0.5, 0, 1);
      r = Math.round(lerp(r, 255, cover));
      g = Math.round(lerp(g, 255, cover));
      b = Math.round(lerp(b, 255, cover));
    }
    raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
  }
}

/* ---------- PNG 编码 ---------- */

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('written:', out, png.length, 'bytes');

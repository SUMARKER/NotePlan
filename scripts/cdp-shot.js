'use strict';
/* 通过 CDP Page.captureScreenshot 抓取页面并保存 PNG。 */

const http = require('http');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = process.env.CDP_PORT || 9222;
const OUT = process.argv[2] || path.join(__dirname, '..', 'shot.png');

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
}

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const u = new URL(url);
    const sock = net.connect(+u.port, u.hostname, () => {
      sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let stage = 0;
    let buf = Buffer.alloc(0);
    const handlers = [];
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        stage = 1;
        buf = buf.slice(idx + 4);
        resolve({
          send: (o) => sock.write(encodeFrame(JSON.stringify(o))),
          onMessage: (fn) => handlers.push(fn),
        });
      }
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (op === 8) { sock.end(); return; }
        if (op === 1) handlers.forEach((f) => f(payload.toString()));
      }
    });
    sock.on('error', reject);
  });
}

function encodeFrame(str) {
  const mask = crypto.randomBytes(4);
  const data = Buffer.from(str);
  let head;
  if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
  else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2); }
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

(async () => {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) { console.error('no page'); process.exit(1); }
  const ws = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onMessage((raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const rpc = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send({ id: mid, method, params });
  });

  await rpc('Page.enable', {});
  await new Promise((r) => setTimeout(r, 300));
  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('saved:', OUT);
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });

'use strict';
/* �?CDP 连接：清除提醒触发记�?�?�?500ms 轮询 toast 是否点亮 �?点亮瞬间截图�?*/
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');

const OUT = process.argv[2] || 'toast.png';
const PORT = 9222;

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
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
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const u = new URL(url);
    const sock = net.connect(+u.port, u.hostname, () => {
      sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let stage = 0, buf = Buffer.alloc(0);
    const handlers = [];
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        stage = 1; buf = buf.slice(idx + 4);
        resolve({ send: (o) => sock.write(encodeFrame(JSON.stringify(o))), onMessage: (fn) => handlers.push(fn) });
      }
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
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
  const evaljs = async (expr) => {
    const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };

  await rpc('Page.enable', {});
  await evaljs(`localStorage.removeItem('np.reminders.fired'); localStorage.setItem('np.reminders', JSON.stringify({dailyTime:'00:01', leadMinutes:1})); 'cleared'`);
  await rpc('Page.bringToFront', {});
  const deadline = Date.now() + 70000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const shown = await evaljs(`document.getElementById('toast').classList.contains('show')`);
    if (shown === true) {
      const text = await evaljs(`document.getElementById('toast').textContent`);
      const shot = await rpc('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
      console.log('captured:', OUT);
      console.log('toast:', String(text).slice(0, 140));
      process.exit(0);
    }
  }
  console.log('toast not shown within 70s');
  process.exit(1);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });


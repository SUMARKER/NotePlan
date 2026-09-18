'use strict';
/* 通过 CDP Input 域发送真实键盘事件（逐字符），验证真实打字场景的自动补全。 */

const http = require('http');
const crypto = require('crypto');
const net = require('net');

const PORT = 9222;
const TEXT = process.argv[2] || '使用';

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(JSON.parse(buf)));
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
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        stage = 1;
        buf = buf.slice(idx + 4);
        resolve({
          send: (obj) => sock.write(encodeFrame(JSON.stringify(obj))),
          onData: (fn) => { handlers.push(fn); },
        });
      }
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0], b1 = buf[1];
        const opcode = b0 & 0x0f;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (opcode === 8) { sock.end(); return; }
        if (opcode === 1) handlers.forEach((f) => f(payload.toString()));
      }
    });
    const handlers = [];
    sock.on('error', reject);
  });
}

function encodeFrame(str, opcode = 0x1) {
  const mask = crypto.randomBytes(4);
  const data = Buffer.from(str);
  let head;
  if (data.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | data.length]);
  else { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2); }
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

(async () => {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  const ws = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onData((raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const rpc = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send({ id: mid, method, params });
  });

  // 光标移到文档末尾
  await rpc('Runtime.evaluate', { expression: `(() => { const v = window.__edApi.getView(); v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); return 'ok'; })()`, returnByValue: true });

  for (const ch of TEXT) {
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await new Promise((r) => setTimeout(r, 90));
  }
  await new Promise((r) => setTimeout(r, 900));

  const res = await rpc('Runtime.evaluate', {
    expression: `(() => {
      const tip = document.querySelector('.cm-tooltip.cm-tooltip-autocomplete');
      if (!tip) return { open: false };
      const opts = [...tip.querySelectorAll('li')].map(li => li.textContent.trim()).slice(0, 4);
      return { open: true, opts };
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(res.result.result.value));
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });

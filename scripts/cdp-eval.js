'use strict';
/* 极简 CDP 客户端：连接本机 Electron/Chrome 调试端口，执行一段 JS 并打印结果。
 * 用法: node cdp-eval.js "表达式"
 * 仅依赖 Node 内置模块（手工实现 WebSocket 客户端）。 */

const http = require('http');
const crypto = require('crypto');
const net = require('net');

const expr = process.argv[2] || 'document.title';
const PORT = process.env.CDP_PORT || 9222;

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/* ---------- 最小 WebSocket 实现 ---------- */

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const u = new URL(url);
    const sock = net.connect(+u.port, u.hostname, () => {
      sock.write(
        `GET ${u.pathname} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`);
    });
    let stage = 0;
    let buf = Buffer.alloc(0);
    const listeners = { message: [], close: [] };

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        if (!/Upgrade: websocket/i.test(head)) return reject(new Error('handshake failed: ' + head.split('\r\n')[0]));
        stage = 1;
        buf = buf.slice(idx + 4);
        resolve({
          send: (obj) => sock.write(encodeFrame(JSON.stringify(obj))),
          onMessage: (fn) => listeners.message.push(fn),
          close: () => sock.end(),
        });
      }
      // 解析数据帧（服务端帧不掩码）
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
        if (opcode === 8) { listeners.close.forEach((f) => f()); sock.end(); return; }
        if (opcode === 9) { sock.write(encodeFrame(payload.toString(), 0x0a)); continue; } // ping→pong
        if (opcode === 1) listeners.message.forEach((f) => f(payload.toString()));
      }
    });
    sock.on('error', reject);
  });
}

function encodeFrame(str, opcode = 0x1) {
  const mask = crypto.randomBytes(4);
  const data = Buffer.from(str);
  let head;
  if (data.length < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | data.length]);
  } else if (data.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

/* ---------- 主流程 ---------- */

(async () => {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || targets.find((t) => t.type === 'page');
  if (!page) { console.error('no page target'); process.exit(1); }

  const ws = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  ws.onMessage((raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  function rpc(method, params) {
    return new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send({ id: mid, method, params });
    });
  }

  const res = await rpc('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.result && res.result.exceptionDetails) {
    console.error('EXCEPTION:', JSON.stringify(res.result.exceptionDetails.exception || res.result.exceptionDetails, null, 2));
  } else {
    console.log(JSON.stringify(res.result && res.result.result && 'value' in res.result.result ? res.result.result.value : res.result, null, 2));
  }
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });

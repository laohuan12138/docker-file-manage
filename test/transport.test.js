'use strict';
/**
 * StdioTransport 回归测试：
 * 历史 bug —— 子进程在请求进行中退出时，_failCurrent 调用了不存在的 cur.reject，
 * 抛出的 TypeError 会变成 Electron 主进程的未捕获异常（弹「A JavaScript error occurred」）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { StdioTransport } = require('../lib/transport');

const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('子进程在请求进行中退出：promise 正常 reject，不抛同步异常', async () => {
  // 100ms 后自己退出，模拟 WSL/dockerd 抖动
  const t = new StdioTransport(NODE, ['-e', 'setTimeout(() => process.exit(7), 100)'], { label: 'test-exit' });
  try {
    await assert.rejects(
      t.request({ method: 'GET', path: '/_ping', timeout: 5000 }),
      (e) => e && e.code === 'ESTDIO',
    );
    // 再给事件循环一点时间，确认没有迟到的 uncaughtException
    await sleep(150);
  } finally {
    t.close();
    await sleep(50);
  }
});

test('close() 时有请求在途：reject 而不是崩溃', async () => {
  const t = new StdioTransport(NODE, ['-e', 'setInterval(() => {}, 1000)'], { label: 'test-close' });
  const p = t.request({ method: 'GET', path: '/_ping', timeout: 10000 });
  await sleep(120);
  t.close();
  await assert.rejects(p, (e) => e && (e.code === 'ECLOSED' || e.code === 'ESTDIO'));
  await sleep(100);
});

test('请求超时：ETIMEDOUT 并自动关闭子进程', async () => {
  const t = new StdioTransport(NODE, ['-e', 'setInterval(() => {}, 1000)'], { label: 'test-timeout' });
  try {
    await assert.rejects(
      t.request({ method: 'GET', path: '/_ping', timeout: 300 }),
      (e) => e && e.code === 'ETIMEDOUT',
    );
  } finally {
    t.close();
    await sleep(50);
  }
});

test('子进程退出后可以重建并继续处理请求（不会卡死队列）', async () => {
  // 第一次请求期间进程就退出；随后再发一次，应该再次 reject 而不是永远挂着
  const t = new StdioTransport(NODE, ['-e', 'setTimeout(() => process.exit(1), 80)'], { label: 'test-respawn' });
  try {
    await assert.rejects(t.request({ method: 'GET', path: '/a', timeout: 3000 }));
    await assert.rejects(t.request({ method: 'GET', path: '/b', timeout: 3000 }));
  } finally {
    t.close();
    await sleep(50);
  }
});

test('exec 帧解析（demux）不受 stdio 关闭影响', async () => {
  const { demux } = require('../lib/docker');
  const { PassThrough } = require('stream');
  const s = new PassThrough();
  const out = demux(s, 2000);
  const frame = (type, text) => {
    const payload = Buffer.from(text, 'utf8');
    const head = Buffer.alloc(8);
    head[0] = type;
    head.writeUInt32BE(payload.length, 4);
    s.write(Buffer.concat([head, payload]));
  };
  frame(1, 'hello');
  frame(2, 'oops');
  s.end();
  const r = await out;
  assert.equal(r.stdout, 'hello');
  assert.equal(r.stderr, 'oops');
});

/* ---------------- 101 upgrade（exec/attach 交互流） ---------------- */

const http = require('http');
const { HttpTransport, hijackStdio } = require('../lib/transport');

/** 从双向流里等到满足条件的输出 */
function readUntil(stream, predicate, ms = 4000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('等待失败，已收到：' + JSON.stringify(buf))); }, ms);
    const onData = (c) => {
      buf += c.toString('utf8');
      if (predicate(buf)) { cleanup(); resolve(buf); }
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
    };
    stream.on('data', onData);
  });
}

test('HttpTransport.hijack：101 之后的原始双向流可用', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end('{}'); });
  srv.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\n'
      + 'Connection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.write('\x1b[32mready\x1b[0m$ ');
    socket.on('data', (d) => socket.write('echo:' + d.toString()));
    socket.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const t = new HttpTransport({ host: '127.0.0.1', port, protocol: 'http:' }, { label: 'test-hijack' });
  let stream = null;
  try {
    const h = await t.hijack({ method: 'POST', path: '/v1.44/exec/abc/start', body: { Detach: false, Tty: true } });
    assert.equal(h.status, 101);
    stream = h.stream;
    assert.equal(h.headers['content-type'], 'application/vnd.docker.raw-stream');
    // 101 之后紧跟的字节（head）不能丢
    const first = await readUntil(stream, (b) => b.includes('ready'));
    assert.match(first, /ready/);
    stream.write('hi\n');
    const second = await readUntil(stream, (b) => b.includes('echo:hi'));
    assert.match(second, /echo:hi/);
  } finally {
    try { stream && stream.destroy(); } catch (_) {}
    try { t.close(); } catch (_) {}
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    srv.close();
    srv.unref();
  }
});

test('HttpTransport.hijack：引擎拒绝升级时回传 status 与 body', async () => {
  const srv = http.createServer((req, res) => {
    const body = JSON.stringify({ message: 'OCI runtime exec failed: exec: "/bin/sh": no such file or directory' });
    res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const t = new HttpTransport({ host: '127.0.0.1', port, protocol: 'http:' }, { label: 'test-hijack-500' });
  try {
    await assert.rejects(
      t.hijack({ method: 'POST', path: '/v1.44/exec/abc/start', body: { Detach: false, Tty: true } }),
      (e) => e && e.code === 'HIJACK' && e.status === 500 && /no such file/.test(e.body || ''),
    );
  } finally {
    try { t.close(); } catch (_) {}
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    srv.close();
    srv.unref();
  }
});

/** 用 node 子进程冒充 dial-stdio：说 HTTP/1.1，101 之后回显 */
const STDIO_HIJACK_OK = `
let buf = Buffer.alloc(0);
let open = false;
const send = (s) => process.stdout.write(s);
process.stdin.on('data', (c) => {
  if (open) { send('[' + c.toString() + ']'); return; }
  buf = Buffer.concat([buf, c]);
  const i = buf.indexOf('\\r\\n\\r\\n');
  if (i === -1) return;
  open = true;
  send('HTTP/1.1 101 UPGRADED\\r\\nContent-Type: application/vnd.docker.raw-stream\\r\\nConnection: Upgrade\\r\\nUpgrade: tcp\\r\\n\\r\\n');
  const rest = buf.subarray(i + 4);
  if (rest.length) send(rest.toString());
  send('$ ');
});
`;

const STDIO_HIJACK_FAIL = `
let buf = Buffer.alloc(0);
process.stdin.on('data', (c) => {
  if (buf.length) return;
  const body = JSON.stringify({ message: 'OCI runtime exec failed: no such file or directory' });
  process.stdout.write('HTTP/1.1 500 Internal Server Error\\r\\nContent-Type: application/json\\r\\nContent-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
});
`;

test('hijackStdio：dial-stdio 上的 101 双向流', async () => {
  const h = await hijackStdio(NODE, ['-e', STDIO_HIJACK_OK], {
    method: 'POST',
    path: '/v1.44/exec/xyz/start',
    headers: { 'Content-Type': 'application/json' },
    body: { Detach: false, Tty: true },
    timeout: 8000,
  });
  try {
    assert.equal(h.status, 101);
    await readUntil(h.stream, (b) => b.includes('$'));
    h.stream.write('abc');
    const out = await readUntil(h.stream, (b) => b.includes('[abc]'));
    assert.match(out, /\[abc\]/);
  } finally {
    h.stream.destroy();
  }
});

test('hijackStdio：非 101 时带 status/body 拒绝，并回收子进程', async () => {
  let h = null;
  await assert.rejects(
    (async () => { h = await hijackStdio(NODE, ['-e', STDIO_HIJACK_FAIL], {
      method: 'POST', path: '/v1.44/exec/xyz/start', body: { Detach: false, Tty: true }, timeout: 8000,
    }); })(),
    (e) => e && e.status === 500 && /no such file/.test(e.body || ''),
  );
  assert.equal(h, null);
  await sleep(100);
});

test('hijackStdio：子进程立刻退出不会抛未捕获异常', async () => {
  await assert.rejects(
    hijackStdio(NODE, ['-e', 'process.exit(3)'], { method: 'GET', path: '/', timeout: 5000 }),
    (e) => e && (e.code === 'ESTDIO' || e.code === 'ESPAWN'),
  );
  await sleep(120);
});

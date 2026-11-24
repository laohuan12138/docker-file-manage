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

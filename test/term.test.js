'use strict';
/**
 * 终端（容器 shell / 镜像 shell）集成测试，跑在 mock-engine 上。
 * mock-engine 用 HTTP 101 hijack 模拟 pty：输入回显 + 一小撮内置命令。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, startMockEngine } = require('./helpers');

const MOCK_PORT = Number(process.env.MOCK_TERM_PORT || 23870);
const API_PORT = Number(process.env.API_TERM_PORT || 7811);
const RO_PORT = API_PORT + 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mock;
let server;
let ro;
let base;

async function j(method, p, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: res.status, data };
}

async function input(sid, text) {
  const res = await fetch(`${base}/api/term/${sid}/input`, { method: 'POST', body: Buffer.from(text, 'utf8') });
  await res.text();
  return res.status;
}

async function openTerm(containerId, opts = {}) {
  const r = await j('POST', `/api/containers/${containerId}/term`, { cols: 100, rows: 30, ...opts });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

/** 打开输出流：累积缓冲 + "等到某段输出出现" */
async function openStream(sid) {
  const res = await fetch(`${base}/api/term/${sid}/stream`);
  assert.equal(res.status, 200, '输出流应可打开');
  const reader = res.body.getReader();
  let buf = '';
  const waitFor = async (predicate, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (predicate(buf)) return buf;
      const chunk = await Promise.race([
        reader.read(),
        sleep(80).then(() => ({ done: false, value: undefined })),
      ]);
      if (chunk.value) buf += Buffer.from(chunk.value).toString('utf8');
      if (chunk.done) break;
    }
    throw new Error('等待输出超时，已收到：' + JSON.stringify(buf.slice(-300)));
  };
  return {
    waitFor,
    text: () => buf,
    async close() { try { await reader.cancel(); } catch (_) {} },
  };
}

test('终端：容器 shell / 镜像 shell（mock engine）', async (t) => {
  mock = await startMockEngine({ port: MOCK_PORT });
  server = startServer({ port: API_PORT, env: { DOCKER_HOST: `tcp://127.0.0.1:${MOCK_PORT}` } });
  ro = startServer({ port: RO_PORT, args: ['--read-only'], env: { DOCKER_HOST: `tcp://127.0.0.1:${MOCK_PORT}` } });
  base = server.url;

  try {
    await server.ready();
    await ro.ready();
    await sleep(300);

    await t.test('没有会话时列表为空', async () => {
      const r = await j('GET', '/api/term');
      assert.equal(r.status, 200);
      assert.deepEqual(r.data.sessions, []);
    });

    await t.test('停止的容器开终端 → 409', async () => {
      const r = await j('POST', '/api/containers/db-postgres/term', { cols: 100, rows: 30 });
      assert.equal(r.status, 409);
      assert.equal(r.data.error.code, 'NEEDS_RUNNING');
      assert.match(r.data.error.hint, /启动/);
    });

    await t.test('运行中的容器开终端 → 201，shell 探测落到 /bin/sh', async () => {
      // mock 里只有 /bin/sh、/bin/ash：探测逻辑应命中第一个候选
      const sess = await openTerm('web-nginx', { cols: 120, rows: 32 });
      assert.equal(sess.kind, 'exec');
      assert.equal(sess.shell, '/bin/sh');
      assert.equal(sess.container.name, 'web-nginx');
      assert.equal(sess.ephemeral, false);
      assert.ok(sess.id);
      assert.match(sess.stream, /^\/api\/term\/.+\/stream$/);
      const list = await j('GET', '/api/term');
      assert.equal(list.data.sessions.length, 1);
      assert.equal(list.data.sessions[0].shell, '/bin/sh');
      await j('POST', `/api/term/${sess.id}/close`);
    });

    await t.test('输出流有提示符，输入回显，命令可执行', async () => {
      const sess = await openTerm('web-nginx');
      const s = await openStream(sess.id);
      try {
        await s.waitFor((b) => /#\s*$/.test(b.trim()));
        assert.match(s.text(), /root@web-nginx/);
        assert.equal(await input(sess.id, 'echo hello-dockfile\n'), 200);
        await s.waitFor((b) => b.includes('hello-dockfile'));
        assert.equal(await input(sess.id, 'pwd\n'), 200);
        await s.waitFor((b) => /\n\/\r?\n/.test(b));
        assert.equal(await input(sess.id, 'ls\n'), 200);
        await s.waitFor((b) => b.includes('etc'));
        assert.equal(await input(sess.id, 'cat /etc/hostname\n'), 200);
        await s.waitFor((b) => b.includes('a1b2c3d4e5f6'));
        assert.equal(await input(sess.id, 'cd /etc\n'), 200);
        await s.waitFor((b) => /:\/etc.*#/.test(b.replace(/\u001b\[[0-9;]*m/g, '')));
        assert.equal(await input(sess.id, 'pwd\n'), 200);
        await s.waitFor((b) => b.includes('\r\n/etc\r\n'));
        assert.equal(await input(sess.id, 'nosuchcmd --x\n'), 200);
        await s.waitFor((b) => b.includes('not found'));

        // resize 在会话还活着时必须成功
        const rs = await j('POST', `/api/term/${sess.id}/resize`, { cols: 88, rows: 22 });
        assert.equal(rs.status, 200);
        assert.equal(rs.data.ok, true);
      } finally {
        await s.close();
      }
    });

    await t.test('会话按浏览目录打开（workdir）', async () => {
      const sess = await openTerm('web-nginx', { workdir: '/etc' });
      const s = await openStream(sess.id);
      try {
        await s.waitFor((b) => b.length > 0);
        assert.equal(await input(sess.id, 'pwd\n'), 200);
        await s.waitFor((b) => b.includes('\r\n/etc\r\n'));
      } finally {
        await s.close();
      }
    });

    await t.test('同一会话不能被两个页面同时订阅', async () => {
      const sess = await openTerm('web-nginx');
      const s1 = await openStream(sess.id);
      try {
        await s1.waitFor((b) => b.length > 0);
        const res = await fetch(`${base}/api/term/${sess.id}/stream`);
        assert.equal(res.status, 409);
        await res.text();
      } finally {
        await s1.close();
      }
    });

    await t.test('浏览器断开 → 会话回收，输入返回 410', async () => {
      const sess = await openTerm('web-nginx');
      const s = await openStream(sess.id);
      await s.waitFor((b) => b.length > 0);
      await s.close();
      let gone = false;
      for (let i = 0; i < 30 && !gone; i++) {
        gone = (await j('GET', '/api/term')).data.sessions.every((x) => x.id !== sess.id);
        if (!gone) await sleep(50);
      }
      assert.ok(gone, '断开后会话应被回收');
      assert.equal(await input(sess.id, 'x'), 410);
      const res = await fetch(`${base}/api/term/${sess.id}/stream`);
      assert.equal(res.status, 404);
      await res.text();
    });

    await t.test('主动 close 后列表清空', async () => {
      const sess = await openTerm('web-nginx');
      const s = await openStream(sess.id);
      await s.waitFor((b) => b.length > 0);
      const closed = await j('POST', `/api/term/${sess.id}/close`);
      assert.equal(closed.status, 200);
      assert.equal(closed.data.ok, true);
      await s.close();
      assert.deepEqual((await j('GET', '/api/term')).data.sessions, []);
    });

    await t.test('只读模式下不能开终端', async () => {
      const res = await fetch(`${ro.url}/api/containers/web-nginx/term`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      });
      assert.equal(res.status, 403);
      await res.text();
    });

    await t.test('镜像列表', async () => {
      const r = await j('GET', '/api/images');
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.data.images));
      assert.ok(r.data.images.length >= 3);
      const alpine = r.data.images.find((i) => i.tags.includes('alpine:3.20'));
      assert.ok(alpine, 'mock 镜像列表里应有 alpine:3.20');
      assert.match(alpine.shortId, /^[0-9a-f]{12}$/);
      assert.ok(alpine.size > 0);
    });

    await t.test('镜像进 shell：起临时容器、可执行命令、关闭后容器被删除', async () => {
      const r = await j('POST', '/api/term', { image: 'alpine:3.20', cols: 100, rows: 30 });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.equal(r.data.kind, 'attach');
      assert.equal(r.data.ephemeral, true);
      assert.equal(r.data.shell, '/bin/sh');
      const cid = r.data.container.id;
      assert.match(r.data.container.name, /^dockfile-shell-/);

      const s = await openStream(r.data.id);
      await s.waitFor((b) => b.length > 0);
      assert.equal(await input(r.data.id, 'echo from-image\n'), 200);
      await s.waitFor((b) => b.includes('from-image'));

      const list = await j('GET', '/api/containers');
      const found = list.data.containers.find((c) => c.id === cid);
      assert.ok(found, '临时容器应出现在容器列表里');
      assert.equal(found.state, 'running');

      const closed = await j('POST', `/api/term/${r.data.id}/close`);
      assert.equal(closed.data.ok, true, JSON.stringify(closed.data));
      await s.close();
      let gone = false;
      for (let i = 0; i < 40 && !gone; i++) {
        const l = await j('GET', '/api/containers');
        gone = !l.data.containers.some((c) => c.id === cid);
        if (!gone) await sleep(100);
      }
      assert.ok(gone, '关闭终端后临时容器必须被删除');
    });

    await t.test('没有 shell 的镜像 → 409 NO_SHELL，且不残留容器', async () => {
      const before = (await j('GET', '/api/containers')).data.containers.length;
      const r = await j('POST', '/api/term', { image: 'gcr.io/distroless/static:nonroot', cols: 80, rows: 24 });
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.error.code, 'NO_SHELL');
      assert.match(r.data.error.message, /没有找到可用的 shell/);
      const after = (await j('GET', '/api/containers')).data.containers.length;
      assert.equal(after, before, '失败的临时容器不应残留');
    });

    await t.test('不存在的镜像 → 404', async () => {
      const r = await j('POST', '/api/term', { image: 'no-such-image:1.0', cols: 80, rows: 24 });
      assert.equal(r.status, 404, JSON.stringify(r.data));
    });

    await t.test('手动指定 shell 时不走探测', async () => {
      const r = await j('POST', '/api/containers/web-nginx/term', { shell: '/bin/ash', cols: 90, rows: 25 });
      assert.equal(r.status, 201);
      assert.equal(r.data.shell, '/bin/ash');
      await j('POST', `/api/term/${r.data.id}/close`);
    });

    await t.test('会话上限：超过 8 个自动关最早的', async () => {
      const ids = [];
      for (let i = 0; i < 10; i++) {
        const r = await j('POST', '/api/containers/web-nginx/term', { cols: 80, rows: 24 });
        if (r.status === 201) ids.push(r.data.id);
      }
      const list = await j('GET', '/api/term');
      assert.ok(list.data.sessions.length <= 8, `会话数 ${list.data.sessions.length} 超过上限`);
      assert.ok(!list.data.sessions.some((x) => x.id === ids[0]), '最早的会话应被回收');
      for (const x of list.data.sessions) await j('POST', `/api/term/${x.id}/close`);
    });
  } finally {
    try { await server.stop(); } catch (_) {}
    try { await ro.stop(); } catch (_) {}
    try { await mock.stop(); } catch (_) {}
  }
});

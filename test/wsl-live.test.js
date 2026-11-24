'use strict';
/**
 * 真实引擎只读验证（本机 Docker / WSL 内的 Docker 都适用）
 *   npm run test:live
 * 没有可用引擎时自动跳过。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const { startServer, ensureWslContainer, wslCommand } = require('./helpers');

const PORT = Number(process.env.LIVE_PORT || 7801);
const CONTAINER = process.env.UI_CONTAINER || 'dockfile-selftest';

function shell(cmd) {
  try {
    return execSync(wslCommand(cmd), { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return (e.stdout || '').toString();
  }
}

test('真实引擎只读验证', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('本测试针对 Windows + WSL 桥接');
    return;
  }
  ensureWslContainer(CONTAINER);
  const server = startServer({ port: PORT });
  try {
    let health;
    try {
      health = await server.ready({ timeout: 25000 });
    } catch (e) {
      t.skip('没有可用的 Docker 引擎：' + e.message.split('\n')[0]);
      return;
    }
    const base = server.url;
    const j = async (p) => {
      const r = await fetch(base + p);
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    console.log(`  · 引擎：${health.kind} / ${health.distro || ''} API ${health.apiVersion}`);
    assert.match(String(health.kind), /wsl|unix|tcp|npipe/);

    await t.test('容器列表与 docker ps -a 一致', async () => {
      const r = await j('/api/containers');
      assert.equal(r.status, 200);
      const apiNames = new Set(r.data.containers.flatMap((c) => c.names));
      const cli = shell('docker ps -a --format "{{.Names}}"').split('\n').map((s) => s.trim()).filter(Boolean);
      assert.ok(cli.length > 0, 'CLI 应有容器');
      const missing = cli.filter((n) => !apiNames.has(n));
      assert.deepEqual(missing, [], 'API 容器集合应覆盖 CLI：' + missing.join(','));
    });

    await t.test('根目录列举（大目录不阻塞）', async () => {
      const t0 = Date.now();
      const r = await j(`/api/containers/${CONTAINER}/ls?path=/`);
      assert.equal(r.status, 200);
      const ms = Date.now() - t0;
      assert.ok(r.data.entries.length > 5, '根目录应有条目');
      assert.ok(ms < 5000, `根目录列举应在 5s 内返回（实际 ${ms}ms）`);
    });

    await t.test('/etc 列举与容器内 ls 一致', async () => {
      const r = await j(`/api/containers/${CONTAINER}/ls?path=/etc`);
      assert.equal(r.status, 200);
      const viaApi = r.data.entries.map((e) => e.name).sort();
      const viaCli = shell(`docker exec ${CONTAINER} ls -A /etc`).split('\n').map((s) => s.trim()).filter(Boolean).sort();
      assert.deepEqual(viaApi.filter((n) => n !== '.' && n !== '..'), viaCli);
    });

    await t.test('文本内容与 docker exec cat 一致', async () => {
      const r = await j(`/api/containers/${CONTAINER}/text?path=/etc/passwd`);
      assert.equal(r.status, 200);
      const cli = shell(`docker exec ${CONTAINER} cat /etc/passwd`);
      assert.equal(r.data.content, cli);
    });

    await t.test('单文件下载字节一致', async () => {
      const r = await fetch(`${base}/api/containers/${CONTAINER}/file?path=/etc/passwd&name=passwd`);
      assert.equal(r.status, 200);
      const body = await r.text();
      assert.equal(body, shell(`docker exec ${CONTAINER} cat /etc/passwd`));
      assert.match(r.headers.get('content-disposition') || '', /passwd/);
    });

    await t.test('起不存在的路径返回 404', async () => {
      const r = await j(`/api/containers/${CONTAINER}/ls?path=/no/such/dir`);
      assert.equal(r.status, 404);
    });

    await t.test('引擎弹窗端点列表', async () => {
      const r = await j('/api/endpoints');
      assert.equal(r.status, 200);
      assert.ok(r.data.endpoints.length > 0);
      assert.ok(r.data.endpoints.some((e) => e.ok));
    });

    await t.test('终端：真实 pty 里执行命令', async () => {
      const res = await fetch(`${base}/api/containers/${CONTAINER}/term`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: 100, rows: 30, workdir: '/etc' }),
      });
      assert.equal(res.status, 201, '开终端失败');
      const sess = await res.json();
      assert.ok(sess.id);
      assert.match(sess.shell, /^\//, 'shell 探测应落到绝对路径');

      const st = await fetch(`${base}${sess.stream}`);
      assert.equal(st.status, 200);
      const reader = st.body.getReader();
      let buf = '';
      const strip = (s) => s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
      const waitFor = async (pred, ms = 20000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if (pred(buf)) return buf;
          const c = await Promise.race([
            reader.read(),
            new Promise((r2) => setTimeout(() => r2({ value: undefined }), 100)),
          ]);
          if (c.value) buf += Buffer.from(c.value).toString('utf8');
          if (c.done) break;
        }
        throw new Error('终端输出超时：' + JSON.stringify(buf.slice(-300)));
      };
      const type = async (text) => {
        const r2 = await fetch(`${base}/api/term/${sess.id}/input`, { method: 'POST', body: Buffer.from(text) });
        assert.equal(r2.status, 200);
        await r2.text();
      };

      try {
        await waitFor((b) => /#\s*$/.test(strip(b)));
        await type('echo LIVE-$(echo TERM)-OK\n');
        await waitFor((b) => b.includes('LIVE-TERM-OK'), 15000);
        await type('pwd\n');
        await waitFor((b) => strip(b).includes('\r\n/etc'), 15000);
        await type('tty\n');
        await waitFor((b) => /\/dev\/pts\/\d+/.test(b), 20000);

        const rs = await fetch(`${base}/api/term/${sess.id}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: 90, rows: 26 }),
        });
        assert.equal(rs.status, 200);
        await rs.text();
      } finally {
        await fetch(`${base}/api/term/${sess.id}/close`, { method: 'POST' }).catch(() => {});
        try { await reader.cancel(); } catch (_) {}
      }
      assert.deepEqual((await j('/api/term')).data.sessions, []);
    });
  } finally {
    await server.stop();
  }
});

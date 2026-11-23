'use strict';
/**
 * API 集成测试：对 mock-engine（工具链自带的最小 Docker Engine 实现）跑全量接口。
 * 不需要真实 Docker，`npm test` 直接可用。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { startServer, waitFor, ROOT } = require('./helpers');
const { listEntries } = require('../lib/tar');

const MOCK_PORT = Number(process.env.MOCK_TEST_PORT || 23850);
const API_PORT = Number(process.env.API_TEST_PORT || 7790);
const API_RO_PORT = API_PORT + 1;
const API_TOKEN_PORT = API_PORT + 2;

let mock;
let server;
let roServer;
let tokenServer;
let base;

function url(p) { return base + p; }

async function j(method, p, body, opts = {}) {
  const init = { method, ...opts };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url(p), init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: res.status, data, headers: res.headers };
}

test('dockfile API（mock engine）', async (t) => {
  mock = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-engine.js'), '--port', String(MOCK_PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  mock.stdout.on('data', () => {});
  mock.stderr.on('data', () => {});
  await waitFor(`http://127.0.0.1:${MOCK_PORT}/_ping`, { expect: (r) => r === null || typeof r !== 'object' || true, timeout: 15000 }).catch(() => {});

  server = startServer({ port: API_PORT, env: { DOCKER_HOST: `tcp://127.0.0.1:${MOCK_PORT}` } });
  base = server.url;
  roServer = startServer({ port: API_RO_PORT, args: ['--read-only'], env: { DOCKER_HOST: `tcp://127.0.0.1:${MOCK_PORT}` } });
  tokenServer = startServer({ port: API_TOKEN_PORT, args: ['--token', 's3cret'], env: { DOCKER_HOST: `tcp://127.0.0.1:${MOCK_PORT}` } });

  try {
    await server.ready();
    await roServer.ready();
    // token 服务器：返回 401 就说明已就绪（鉴权先于业务）
    let tokenReady = false;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(tokenServer.url + '/api/health');
        if (r.status === 401 || r.ok) { tokenReady = true; break; }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(tokenReady, 'token 服务器应已启动');

    await t.test('health 报告引擎与协议', async () => {
      const r = await j('GET', '/api/health');
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.kind, 'tcp');
      assert.ok(r.data.apiVersion);
      assert.match(String(r.data.serverVersion), /mock/, '必须连到 mock-engine 而不是真实引擎');
    });

    await t.test('容器列表', async () => {
      const r = await j('GET', '/api/containers');
      assert.equal(r.status, 200);
      const names = r.data.containers.map((c) => c.name).sort();
      assert.deepEqual(names, ['db-postgres', 'web-nginx']);
      const web = r.data.containers.find((c) => c.name === 'web-nginx');
      assert.equal(web.state, 'running');
      assert.equal(web.compose, 'demo-stack');
      assert.ok(web.shortId.length === 12);
    });

    await t.test('列目录（exec 路径）', async () => {
      const r = await j('GET', '/api/containers/web-nginx/ls?path=/etc/nginx');
      assert.equal(r.status, 200);
      assert.equal(r.data.via, 'exec');
      const names = r.data.entries.map((e) => e.name);
      assert.ok(names.includes('nginx.conf'), '应包含 nginx.conf');
      assert.ok(names.includes('conf.d'));
      const dir = r.data.entries.find((e) => e.name === 'conf.d');
      assert.equal(dir.type, 'dir');
      const file = r.data.entries.find((e) => e.name === 'nginx.conf');
      assert.equal(file.type, 'file');
      assert.ok(file.size > 100);
    });

    await t.test('列停止容器的目录（archive 路径）', async () => {
      const r = await j('GET', '/api/containers/db-postgres/ls?path=/etc/postgresql');
      assert.equal(r.status, 200);
      assert.equal(r.data.via, 'archive');
      assert.ok(r.data.entries.some((e) => e.name === 'postgresql.conf'));
    });

    await t.test('路径是文件时返回 kind=file', async () => {
      const r = await j('GET', '/api/containers/web-nginx/ls?path=/etc/nginx/nginx.conf');
      assert.equal(r.status, 200);
      assert.equal(r.data.kind, 'file');
      assert.equal(r.data.entries.length, 0);
    });

    await t.test('文本读取（中文文件名）', async () => {
      const p = encodeURIComponent('/var/www/html/说明文档.md');
      const r = await j('GET', `/api/containers/web-nginx/text?path=${p}`);
      assert.equal(r.status, 200);
      assert.equal(r.data.binary, false);
      assert.match(r.data.content, /中文文件名测试/);
    });

    await t.test('文本写入与读回', async () => {
      const target = encodeURIComponent('/app/data/note.txt');
      const w = await j('PUT', `/api/containers/web-nginx/text?path=${target}&mode=600`, undefined, { body: '第一行\nsecond\n' });
      assert.equal(w.status, 200);
      const r = await j('GET', `/api/containers/web-nginx/text?path=${target}`);
      assert.equal(r.data.content, '第一行\nsecond\n');
      assert.equal(r.data.mode, 0o600);
    });

    await t.test('上传 3.4MB 二进制并校验 sha256', async () => {
      const blob = crypto.randomBytes(3.4 * 1024 * 1024 | 0);
      const target = encodeURIComponent('/app/data/big.bin');
      const res = await fetch(url(`/api/containers/web-nginx/upload?path=/app/data&name=big.bin`), {
        method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' },
      });
      assert.equal(res.status, 200);
      const got = await fetch(url(`/api/containers/web-nginx/raw?path=${target}`));
      const buf = Buffer.from(await got.arrayBuffer());
      assert.equal(buf.length, blob.length, '长度一致');
      assert.equal(
        crypto.createHash('sha256').update(buf).digest('hex'),
        crypto.createHash('sha256').update(blob).digest('hex'),
        'sha256 一致',
      );
    });

    await t.test('上传保留相对路径（自动建子目录）', async () => {
      const res = await fetch(url('/api/containers/web-nginx/upload?path=/app/data&name=dir/sub/a.txt'), {
        method: 'POST', body: 'nested', headers: { 'Content-Type': 'text/plain' },
      });
      assert.equal(res.status, 200);
      const r = await j('GET', `/api/containers/web-nginx/ls?path=/app/data/dir/sub`);
      assert.equal(r.status, 200);
      assert.ok(r.data.entries.some((e) => e.name === 'a.txt'));
    });

    await t.test('新建目录', async () => {
      const r = await j('POST', `/api/containers/web-nginx/mkdir?path=/app/data/newdir`);
      assert.equal(r.status, 200);
      const ls = await j('GET', '/api/containers/web-nginx/ls?path=/app/data');
      const d = ls.data.entries.find((e) => e.name === 'newdir');
      assert.ok(d && d.type === 'dir');
    });

    await t.test('重命名与改权限', async () => {
      const mv = await j('POST', '/api/containers/web-nginx/rename', { from: '/app/data/newdir', to: '/app/data/renamed' });
      assert.equal(mv.status, 200);
      const ch = await j('POST', '/api/containers/web-nginx/chmod', { path: '/app/data/renamed', mode: '700' });
      assert.equal(ch.status, 200);
      const st = await j('GET', '/api/containers/web-nginx/stat?path=/app/data/renamed');
      assert.equal(st.data.type, 'dir');
      assert.equal(st.data.perms, 0o700);
    });

    await t.test('下载单文件（字节一致）', async () => {
      const r = await fetch(url(`/api/containers/web-nginx/file?path=/etc/nginx/nginx.conf&name=nginx.conf`));
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition') || '', /attachment/);
      const text = await r.text();
      assert.match(text, /worker_connections/);
    });

    await t.test('目录打包下载 tar.gz 可解包', async () => {
      const r = await fetch(url(`/api/containers/web-nginx/download?path=/etc/nginx&gzip=1`));
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') || '', /gzip/);
      const raw = zlib.gunzipSync(Buffer.from(await r.arrayBuffer()));
      const { entries } = await listEntries(Readable.from([raw]));
      const names = entries.map((e) => e.name);
      assert.ok(names.some((n) => n.endsWith('nginx.conf')), '包含 nginx.conf：' + names.slice(0, 6));
      assert.ok(names.some((n) => n.endsWith('conf.d/default.conf')));
    });

    await t.test('删除多条', async () => {
      const r = await j('POST', '/api/containers/web-nginx/delete', { paths: ['/app/data/big.bin', '/app/data/renamed'] });
      assert.equal(r.status, 200);
      const st1 = await j('GET', '/api/containers/web-nginx/stat?path=/app/data/big.bin');
      assert.equal(st1.status, 404);
      const st2 = await j('GET', '/api/containers/web-nginx/stat?path=/app/data/renamed');
      assert.equal(st2.status, 404);
    });

    await t.test('停止容器：写操作返回 409 并带提示', async () => {
      const r = await j('POST', '/api/containers/db-postgres/delete', { paths: ['/etc/passwd'] });
      assert.equal(r.status, 409);
      assert.equal(r.data.error.code, 'NEEDS_RUNNING');
      assert.match(r.data.error.hint, /启动容器/);
    });

    await t.test('启动容器后写操作可用', async () => {
      const s = await j('POST', '/api/containers/db-postgres/start');
      assert.equal(s.status, 200);
      const mk = await j('POST', '/api/containers/db-postgres/mkdir?path=/var/lib/postgresql/data/extra');
      assert.equal(mk.status, 200);
      const rm = await j('POST', '/api/containers/db-postgres/delete', { paths: ['/var/lib/postgresql/data/extra'] });
      assert.equal(rm.status, 200);
    });

    await t.test('非法路径被拒绝', async () => {
      const r = await j('GET', '/api/containers/web-nginx/ls?path=/../../etc/shadow');
      assert.equal(r.status, 400);
      assert.equal(r.data.error.code, 'BAD_PATH');
      const r2 = await j('GET', '/api/containers/web-nginx/stat?path=relative/path');
      assert.equal(r2.status, 400);
    });

    await t.test('不存在的容器/路径', async () => {
      const a = await j('GET', '/api/containers/nope/ls?path=/');
      assert.equal(a.status, 404);
      const b = await j('GET', '/api/containers/web-nginx/stat?path=/no/such/file');
      assert.equal(b.status, 404);
    });

    await t.test('只读模式拦截写请求', async () => {
      const res = await fetch(roServer.url + '/api/containers/web-nginx/mkdir?path=/app/data/nope', { method: 'POST' });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error.code, 'READ_ONLY');
      const ok = await fetch(roServer.url + '/api/containers/web-nginx/ls?path=/etc/nginx');
      assert.equal(ok.status, 200);
    });

    await t.test('--token 鉴权', async () => {
      const no = await fetch(tokenServer.url + '/api/containers');
      assert.equal(no.status, 401);
      const yes = await fetch(tokenServer.url + '/api/containers', { headers: { 'X-Auth': 's3cret' } });
      assert.equal(yes.status, 200);
      const q = await fetch(tokenServer.url + '/api/containers?token=s3cret');
      assert.equal(q.status, 200);
    });

    await t.test('未知接口 404', async () => {
      const r = await j('GET', '/api/nope');
      assert.equal(r.status, 404);
    });
  } finally {
    await server.stop();
    await roServer.stop();
    await tokenServer.stop();
    try { mock.kill(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
});


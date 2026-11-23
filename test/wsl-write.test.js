'use strict';
/**
 * 真实引擎写操作验证：在一次性 alpine 容器里跑完整写链路，结束后清理。
 *   npm run test:live
 * 注意：会在本机 Docker 里创建/删除名为 dockfile-selftest 的容器（测试用）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const zlib = require('zlib');
const { execSync } = require('child_process');
const { Readable } = require('stream');
const { startServer, ensureWslContainer, wslCommand } = require('./helpers');
const { listEntries } = require('../lib/tar');

const PORT = Number(process.env.LIVE_W_PORT || 7802);
const CONTAINER = process.env.UI_CONTAINER || 'dockfile-selftest';
const DIR = '/app/selftest';

function shell(cmd) {
  try {
    const r = execSync(wslCommand(cmd), { encoding: 'buffer', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.toString('utf8');
  } catch (e) {
    return ((e.stdout || Buffer.alloc(0)) + '').toString('utf8');
  }
}

test('真实引擎写操作链路', async (t) => {
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
    const j = async (method, p, body) => {
      const init = { method };
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const r = await fetch(base + p, init);
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    const enc = encodeURIComponent;
    console.log(`  · 引擎：${health.kind}，测试目录 ${DIR}`);

    await t.test('清理旧目录并新建', async () => {
      await j('POST', `/api/containers/${CONTAINER}/delete`, { paths: [DIR] }).catch(() => {});
      const r = await j('POST', `/api/containers/${CONTAINER}/mkdir?path=${enc(DIR)}`);
      assert.equal(r.status, 200);
      assert.match(shell(`docker exec ${CONTAINER} ls -d ${DIR}`), new RegExp(DIR.replace('/', '\\/')));
    });

    await t.test('写入文本（mkdir -p 自动建父目录）', async () => {
      const target = `${DIR}/nested/note.txt`;
      const w = await j('PUT', `/api/containers/${CONTAINER}/text?path=${enc(target)}&mode=640`);
      assert.equal(w.status, 200);
      const cli = shell(`docker exec ${CONTAINER} cat ${target}`);
      assert.equal(cli, '');
      const r = await j('GET', `/api/containers/${CONTAINER}/text?path=${enc(target)}`);
      assert.equal(r.status, 200);
      assert.ok(shell(`docker exec ${CONTAINER} stat -c %a ${target}`).trim().startsWith('64'));
    });

    await t.test('上传 3.4MB 并校验 sha256', async () => {
      const blob = crypto.randomBytes(3.4 * 1024 * 1024 | 0);
      const res = await fetch(`${base}/api/containers/${CONTAINER}/upload?path=${enc(DIR)}&name=big.bin`, {
        method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' },
      });
      assert.equal(res.status, 200);
      const got = await fetch(`${base}/api/containers/${CONTAINER}/raw?path=${enc(DIR + '/big.bin')}`);
      const buf = Buffer.from(await got.arrayBuffer());
      assert.equal(buf.length, blob.length);
      assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), crypto.createHash('sha256').update(blob).digest('hex'));
    });

    await t.test('文件夹相对路径上传 + 空目录', async () => {
      const up = await fetch(`${base}/api/containers/${CONTAINER}/upload?path=${enc(DIR)}&name=assets/css/app.css`, {
        method: 'POST', body: 'body{color:#fff}', headers: { 'Content-Type': 'text/plain' },
      });
      assert.equal(up.status, 200);
      await j('POST', `/api/containers/${CONTAINER}/upload?path=${enc(DIR)}&dir=1&name=empty-dir`);
      assert.match(shell(`docker exec ${CONTAINER} cat ${DIR}/assets/css/app.css`), /color:#fff/);
      assert.match(shell(`docker exec ${CONTAINER} ls -d ${DIR}/empty-dir`), /empty-dir/);
    });

    await t.test('重命名 + 改权限', async () => {
      const mv = await j('POST', `/api/containers/${CONTAINER}/rename`, { from: `${DIR}/nested`, to: `${DIR}/renamed` });
      assert.equal(mv.status, 200);
      const ch = await j('POST', `/api/containers/${CONTAINER}/chmod`, { path: `${DIR}/renamed`, mode: '700' });
      assert.equal(ch.status, 200);
      assert.equal(shell(`docker exec ${CONTAINER} stat -c %a ${DIR}/renamed`).trim(), '700');
    });

    await t.test('目录打包下载可解包', async () => {
      const r = await fetch(`${base}/api/containers/${CONTAINER}/download?path=${enc(DIR)}&gzip=1`);
      assert.equal(r.status, 200);
      const raw = zlib.gunzipSync(Buffer.from(await r.arrayBuffer()));
      const { entries } = await listEntries(Readable.from([raw]));
      const names = entries.map((e) => e.name);
      assert.ok(names.some((n) => n.endsWith('assets/css/app.css')), names.slice(0, 8).join(','));
    });

    await t.test('删除并确认消失', async () => {
      const r = await j('POST', `/api/containers/${CONTAINER}/delete`, { paths: [`${DIR}/assets`, `${DIR}/empty-dir`, `${DIR}/renamed`, `${DIR}/big.bin`] });
      assert.equal(r.status, 200);
      assert.equal(shell(`docker exec ${CONTAINER} ls -A ${DIR} | wc -l`).trim(), '0');
      const rm = await j('POST', `/api/containers/${CONTAINER}/delete`, { paths: [DIR] });
      assert.equal(rm.status, 200);
      assert.match(shell(`docker exec ${CONTAINER} sh -c 'test -d ${DIR} && echo yes || echo no'`), /no/);
    });
  } finally {
    await server.stop();
  }
});

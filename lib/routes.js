'use strict';
/** HTTP API 层 */

const { Readable } = require('stream');
const path = require('path');
const fsops = require('./fsops');
const { FsError } = require('./fsops');
const { DockerError } = require('./docker');
const { TermError, INPUT_LIMIT } = require('./term');
const { normalizeContainerPath, contentDisposition, guessMime, modeType, basename } = require('./util');

const MAX_JSON = 4 * 1024 * 1024;
const MAX_TEXT = 4 * 1024 * 1024;

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function errStatus(e) {
  if (e instanceof TermError) {
    switch (e.code) {
      case 'NEEDS_RUNNING': return 409;
      case 'NO_SHELL': return 409;
      case 'NOT_FOUND': return 404;
      case 'BAD_REQUEST': return 400;
      default: return 500;
    }
  }
  if (e instanceof FsError) {
    switch (e.code) {
      case 'BAD_PATH': return 400;
      case 'BAD_MODE': return 400;
      case 'BAD_REQUEST': return 400;
      case 'NOT_FOUND': return 404;
      case 'IS_DIR': return 400;
      case 'NOT_DIR': return 400;
      case 'LOOP': return 400;
      case 'NEEDS_RUNNING': return 409;
      case 'CONFLICT': return 409;
      case 'TOO_LARGE': return 413;
      case 'PERMISSION': return 403;
      default: return 500;
    }
  }
  // util.normalizeContainerPath 抛的是带 code 的普通 Error
  if (e && e.code === 'BAD_PATH') return 400;
  if (e instanceof DockerError) {
    if (e.status === 404) return 404;
    if (e.status === 409) return 409;
    if (e.status === 403) return 403;
    if (e.code === 'NEEDS_RUNNING') return 409;
    return 500;
  }
  if (e && e.code === 'NO_ENGINE') return 503;
  return 500;
}

function sendError(res, e, log) {
  const status = errStatus(e);
  const payload = {
    error: {
      code: (e && (e.code || e.name)) || 'ERROR',
      message: (e && e.message) || '未知错误',
      hint: (e && e.hint) || '',
    },
  };
  if (e && e.statuses) payload.error.endpoints = e.statuses;
  if (status >= 500) log(`[api] ${status} ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  try { sendJson(res, status, payload); } catch (_) { try { res.destroy(); } catch (_) {} }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new FsError('TOO_LARGE', `请求体超过 ${Math.round(limit / 1024)}KB 限制`, '请改用原文件上传接口'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 终端尺寸：夹在合理区间，避免前端传 0/NaN 把 pty 搞坏 */
function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sessionInfo(sess) {
  return {
    id: sess.id,
    kind: sess.kind,
    container: { id: sess.containerId, name: sess.containerName, image: sess.image },
    shell: sess.argv.join(' '),
    ephemeral: Boolean(sess.ephemeral),
    cols: sess.cols,
    rows: sess.rows,
    stream: `/api/term/${sess.id}/stream`,
  };
}

function createApi({ hub, config, log, term }) {
  const authRequired = Boolean(config.token);

  function authorized(req, url) {
    if (!authRequired) return true;
    const h = req.headers['x-auth'] || req.headers['authorization'] || '';
    const token = String(h).replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
    return token === config.token;
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false;

    if (!authorized(req, url)) {
      sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '需要访问令牌', hint: '在页面右上角输入 --token 指定的令牌' } });
      return true;
    }

    const ro = config.readOnly;
    if (ro && req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 403, { error: { code: 'READ_ONLY', message: '当前为只读模式（--read-only）', hint: '去掉 --read-only 重启即可写入' } });
      return true;
    }

    const m = url.pathname;
    const q = url.searchParams;

    try {
      // ---- 引擎 ----
      if (m === '/api/health' && req.method === 'GET') {
        // 首次探测可能还在进行：给最多 3 秒，让页面一打开就能看到真实状态
        if (!hub.status().ok) {
          await Promise.race([
            hub.ensure().catch(() => {}),
            new Promise((r) => setTimeout(r, 3000)),
          ]);
        }
        const st = hub.status();
        sendJson(res, 200, { ok: st.ok, ...st, readonly: ro, node: process.version, platform: process.platform });
        return true;
      }

      if (m === '/api/endpoints' && req.method === 'GET') {
        const refresh = q.get('refresh') === '1';
        const list = await hub.investigate({ refresh });
        sendJson(res, 200, { current: hub.status(), endpoints: list });
        return true;
      }

      if (m === '/api/endpoints/select' && req.method === 'POST') {
        const body = await readBody(req, MAX_JSON);
        const { key } = JSON.parse(body.toString('utf8') || '{}');
        if (!key) throw new FsError('BAD_REQUEST', '缺少 key');
        await hub.select(key);
        sendJson(res, 200, { ok: true, current: hub.status() });
        return true;
      }

      // ---- 镜像 ----
      if (m === '/api/images' && req.method === 'GET') {
        const images = await hub.withClient((c) => c.listImages());
        sendJson(res, 200, { images });
        return true;
      }

      // ---- 终端（会话管理）----
      if (m === '/api/term' && req.method === 'GET') {
        sendJson(res, 200, { sessions: term ? term.list() : [] });
        return true;
      }

      if (m === '/api/term' && req.method === 'POST') {
        if (!term) throw new FsError('BAD_REQUEST', '当前实例未启用终端');
        const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
        const sess = await term.openImage({
          image: body.image,
          shell: body.shell,
          cols: clampInt(body.cols, 20, 500, 100),
          rows: clampInt(body.rows, 5, 300, 30),
        });
        sendJson(res, 201, sessionInfo(sess));
        return true;
      }

      const tm = /^\/api\/term\/([^/]+)(\/[a-z]+)?$/.exec(m);
      if (tm) {
        const sid = decodeURIComponent(tm[1]);
        const sub = tm[2] || '';

        if (sub === '/stream' && req.method === 'GET') {
          if (!term) throw new FsError('BAD_REQUEST', '当前实例未启用终端');
          const r = term.bind(sid, req, res);
          if (r === 'missing') {
            sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '终端会话不存在或已结束', hint: '点「重启」重新开一个' } });
            return true;
          }
          if (r === 'busy') {
            sendJson(res, 409, { error: { code: 'BUSY', message: '该终端已被另一个页面接管' } });
            return true;
          }
          return true; // 输出流已接管 res
        }

        if (sub === '/input' && req.method === 'POST') {
          if (!term) throw new FsError('BAD_REQUEST', '当前实例未启用终端');
          const buf = await readBody(req, INPUT_LIMIT);
          if (!term.write(sid, buf)) {
            sendJson(res, 410, { error: { code: 'GONE', message: '终端会话已结束' } });
            return true;
          }
          sendJson(res, 200, { ok: true, bytes: buf.length });
          return true;
        }

        if (sub === '/resize' && req.method === 'POST') {
          if (!term) throw new FsError('BAD_REQUEST', '当前实例未启用终端');
          const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
          const ok = term.resize(sid, clampInt(body.cols, 2, 1000, 100), clampInt(body.rows, 1, 500, 30));
          sendJson(res, ok ? 200 : 410, ok ? { ok: true } : { error: { code: 'GONE', message: '终端会话已结束' } });
          return true;
        }

        if (sub === '/close' && req.method === 'POST') {
          const ok = term ? term.close(sid, '用户关闭') : false;
          sendJson(res, 200, { ok });
          return true;
        }
      }

      // ---- 容器 ----
      if (m === '/api/containers' && req.method === 'GET') {
        const list = await hub.withClient((c) => c.listContainers({ all: q.get('all') !== '0' }));
        sendJson(res, 200, { containers: list, engine: hub.status() });
        return true;
      }

      const cm = /^\/api\/containers\/([^/]+)(\/.*)?$/.exec(m);
      if (!cm) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `未知接口：${m}` } });
        return true;
      }
      const id = decodeURIComponent(cm[1]);
      const sub = cm[2] || '';

      if (sub === '/start' && req.method === 'POST') {
        await hub.withClient((c) => c.start(id));
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (sub === '/term' && req.method === 'POST') {
        if (!term) throw new FsError('BAD_REQUEST', '当前实例未启用终端');
        const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
        const sess = await term.openContainer({
          containerId: id,
          shell: body.shell,
          cols: clampInt(body.cols, 20, 500, 100),
          rows: clampInt(body.rows, 5, 300, 30),
          workdir: typeof body.workdir === 'string' && body.workdir.startsWith('/') ? body.workdir : '',
        });
        sendJson(res, 201, sessionInfo(sess));
        return true;
      }

      if (sub === '/inspect' && req.method === 'GET') {
        const info = await hub.withClient((c) => c.inspect(id));
        sendJson(res, 200, {
          id: info.Id, name: String(info.Name || '').replace(/^\//, ''), image: info.Config && info.Config.Image,
          state: info.State, mounts: info.Mounts || [], env: (info.Config && info.Config.Env) || [],
        });
        return true;
      }

      if (sub === '/ls' && req.method === 'GET') {
        const p = q.get('path') || '/';
        const out = await hub.withClient((c) => fsops.listDir(c, id, p));
        sendJson(res, 200, out);
        return true;
      }

      if (sub === '/stat' && req.method === 'GET') {
        const p = q.get('path') || '/';
        const out = await hub.withClient((c) => fsops.statPath(c, id, p));
        sendJson(res, 200, out);
        return true;
      }

      if (sub === '/text' && req.method === 'GET') {
        const p = q.get('path') || '';
        const out = await hub.withClient((c) => fsops.readText(c, id, p));
        sendJson(res, 200, out);
        return true;
      }

      if (sub === '/text' && req.method === 'PUT') {
        const p = q.get('path') || '';
        const mode = parseInt(String(q.get('mode') || '644').replace(/[^0-7]/g, ''), 8) || 0o644;
        const body = await readBody(req, MAX_TEXT);
        const out = await hub.withClient((c) => fsops.writeText(c, id, p, body, { mode }));
        sendJson(res, 200, { ok: true, ...out });
        return true;
      }

      if (sub === '/file' && req.method === 'GET') {
        const p = q.get('path') || '';
        res.setHeader('Content-Disposition', contentDisposition(q.get('name') || basename(p)));
        await hub.withClient((c) => fsops.downloadFile(c, id, p, res, { name: q.get('name') || '' }));
        return true;
      }

      if (sub === '/raw' && req.method === 'GET') {
        const p = q.get('path') || '';
        const { buffer, stat } = await hub.withClient((c) => fsops.readBytes(c, id, p, { maxBytes: 128 * 1024 * 1024 }));
        res.writeHead(200, {
          'Content-Type': guessMime(p),
          'Content-Length': buffer.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(buffer);
        return true;
      }

      if (sub === '/download' && req.method === 'GET') {
        const p = q.get('path') || '/';
        const gzip = q.get('gzip') === '1';
        await hub.withClient((c) => fsops.downloadDir(c, id, p, res, { gzip }));
        return true;
      }

      if (sub === '/upload' && req.method === 'POST') {
        const dir = q.get('path') || '/';
        const name = q.get('name') || '';
        const mode = parseInt(String(q.get('mode') || '644').replace(/[^0-7]/g, ''), 8) || 0o644;
        if (q.get('dir') === '1') {
          const out = await hub.withClient((c) => fsops.makeDir(c, id, path.posix.join(normalizeContainerPath(dir), name), { mode: 0o755 }));
          sendJson(res, 200, { ok: true, ...out });
          return true;
        }
        const len = Number(req.headers['content-length']);
        if (!Number.isFinite(len) || len < 0) {
          throw new FsError('BAD_REQUEST', '上传需要 Content-Length', '请从浏览器页面上传');
        }
        const out = await hub.withClient((c) => fsops.upload(c, id, dir, name, req, len, { mode }));
        sendJson(res, 200, { ok: true, ...out });
        return true;
      }

      if (sub === '/mkdir' && req.method === 'POST') {
        const p = q.get('path') || '';
        const mode = parseInt(String(q.get('mode') || '755').replace(/[^0-7]/g, ''), 8) || 0o755;
        const out = await hub.withClient((c) => fsops.makeDir(c, id, p, { mode }));
        sendJson(res, 200, { ok: true, ...out });
        return true;
      }

      if (sub === '/rename' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
        if (!body.from || !body.to) throw new FsError('BAD_REQUEST', '需要 from 与 to');
        const out = await hub.withClient((c) => fsops.rename(c, id, body.from, body.to));
        sendJson(res, 200, { ok: true, ...out });
        return true;
      }

      if (sub === '/chmod' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
        const out = await hub.withClient((c) => fsops.chmod(c, id, body.path, body.mode));
        sendJson(res, 200, { ok: true, ...out });
        return true;
      }

      if (sub === '/delete' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
        const paths = body.paths || (body.path ? [body.path] : []);
        if (!paths.length) throw new FsError('BAD_REQUEST', '需要 paths');
        const out = await hub.withClient((c) => fsops.remove(c, id, paths));
        sendJson(res, 200, { ok: true, ...out });
        return true;
      }

      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `未知接口：${m}` } });
      return true;
    } catch (e) {
      sendError(res, e, log);
      return true;
    }
  }

  return { handle, sendJson };
}

module.exports = { createApi, sendJson, sendError };

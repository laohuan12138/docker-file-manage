'use strict';
/**
 * dockfile 服务内核：命令行版（server.js）和 Electron 桌面版（electron/main.js）共用。
 * 只依赖 Node 内置模块 + 项目内 lib/，不依赖任何运行时 npm 包。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const { EngineHub } = require('./endpoint');
const { createApi, sendJson } = require('./routes');
const { TermManager } = require('./term');

const WEB_DIR = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 回退
      fs.readFile(path.join(WEB_DIR, 'index.html'), (e2, buf) => {
        if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

/**
 * @param {object} options
 * @param {number} [options.port=7788]       0 = 随机空闲端口
 * @param {string} [options.bind='127.0.0.1']
 * @param {string} [options.token]
 * @param {boolean} [options.readOnly]
 * @param {string} [options.dockerHost]
 * @param {string} [options.wslDistro]
 * @param {string} [options.transport='auto']
 * @param {boolean} [options.debug]
 * @param {(msg:string)=>void} [options.log]
 */
function createDockfileServer(options = {}) {
  const cfg = {
    port: 7788,
    bind: '127.0.0.1',
    token: '',
    readOnly: false,
    dockerHost: '',
    wslDistro: '',
    transport: 'auto',
    debug: false,
    ...options,
  };
  const log = cfg.log || (cfg.debug ? (...a) => console.error('[debug]', ...a) : () => {});

  const hub = new EngineHub({
    explicitHost: cfg.dockerHost || process.env.DOCKER_HOST || '',
    preferTransport: cfg.transport,
    preferDistro: cfg.wslDistro,
    log,
  });

  const term = new TermManager({ hub, log, maxSessions: cfg.maxSessions || 8 });
  const api = createApi({ hub, config: cfg, log, term });

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (_) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const t0 = Date.now();
      if (cfg.debug) log(`[api] ${req.method} ${url.pathname}${url.search}`);
      api.handle(req, res, url).then((handled) => {
        if (cfg.debug) log(`[api] ${req.method} ${url.pathname} → ${res.statusCode} ${Date.now() - t0}ms`);
        if (!handled) sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
      }).catch((e) => {
        log(`[api] unhandled: ${e && e.stack}`);
        if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: String(e && e.message) } });
        else try { res.destroy(); } catch (_) {}
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    serveStatic(req, res, url);
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 0; // 大文件上传/下载不限时

  let url = '';
  let sweepTimer = null;

  function start() {
    return new Promise((resolve, reject) => {
      const onError = (e) => { server.removeListener('listening', onListening); reject(e); };
      const onListening = () => {
        server.removeListener('error', onError);
        const port = server.address().port;
        const host = cfg.bind === '0.0.0.0' ? '127.0.0.1' : cfg.bind;
        url = `http://${host}:${port}`;
        resolve({ port, host, url });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(cfg.port, cfg.bind);
      // 上一次运行如果崩溃，可能残留临时 shell 容器：后台清一次（只读模式不动容器）
      if (!cfg.readOnly) {
        sweepTimer = setTimeout(() => { term.sweep().catch(() => {}); }, 4000);
        if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
      }
    });
  }

  async function close() {
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    try { term.closeAll('服务关闭'); } catch (_) {}
    try { hub.close(); } catch (_) {}
    if (typeof server.closeAllConnections === 'function') {
      try { server.closeAllConnections(); } catch (_) {}
    }
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      setTimeout(resolve, 1500).unref?.();
    });
  }

  return {
    server,
    hub,
    api,
    term,
    config: cfg,
    get url() { return url; },
    start,
    close,
    ensureEngine: (opts) => hub.ensure(opts),
    status: () => hub.status(),
  };
}

module.exports = { createDockfileServer, WEB_DIR };

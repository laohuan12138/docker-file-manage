#!/usr/bin/env node
'use strict';
/**
 * dockfile —— Docker 容器文件管理器
 *   node server.js [--port 7788] [--bind 127.0.0.1] [--token xxx] [--read-only]
 *                  [--docker-host unix:///var/run/docker.sock | npipe:////./pipe/docker_engine | tcp://1.2.3.4:2375]
 *                  [--wsl-distro Ubuntu-22.04] [--transport auto|relay|stdio|socket] [--open]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { EngineHub } = require('./lib/endpoint');
const { createApi, sendJson } = require('./lib/routes');

const pkg = require('./package.json');
const WEB_DIR = path.join(__dirname, 'web');

function parseArgs(argv) {
  const cfg = {
    port: 7788,
    bind: '127.0.0.1',
    token: process.env.DOCKFILE_TOKEN || '',
    readOnly: false,
    dockerHost: '',
    wslDistro: '',
    transport: 'auto',
    open: false,
    debug: Boolean(process.env.DOCKFILE_DEBUG),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--port': case '-p': cfg.port = Number(next()); break;
      case '--bind': cfg.bind = next(); break;
      case '--token': cfg.token = next(); break;
      case '--read-only': case '--ro': cfg.readOnly = true; break;
      case '--docker-host': case '--host': cfg.dockerHost = next(); break;
      case '--wsl-distro': case '--distro': cfg.wslDistro = next(); break;
      case '--transport': cfg.transport = next(); break;
      case '--open': cfg.open = true; break;
      case '--debug': cfg.debug = true; break;
      case '--help': case '-h': printHelp(); process.exit(0); break;
      case '--version': case '-v': console.log(pkg.version); process.exit(0); break;
      default:
        if (a.startsWith('--')) { console.error(`未知参数：${a}`); printHelp(); process.exit(2); }
    }
  }
  if (!['auto', 'relay', 'stdio', 'socket'].includes(cfg.transport)) {
    console.error(`--transport 只能是 auto|relay|stdio|socket，收到 ${cfg.transport}`);
    process.exit(2);
  }
  if (!Number.isFinite(cfg.port) || cfg.port <= 0) cfg.port = 7788;
  return cfg;
}

function printHelp() {
  console.log(`
dockfile ${pkg.version} — Docker 容器文件管理器

用法: node server.js [选项]

  --port <n>           监听端口（默认 7788）
  --bind <addr>        监听地址（默认 127.0.0.1；0.0.0.0 等于把容器 root 权限交出去）
  --token <str>        访问令牌（也可用环境变量 DOCKFILE_TOKEN）
  --read-only          只读模式，禁用所有写操作
  --docker-host <url>  指定 Docker 引擎：
                         unix:///var/run/docker.sock
                         npipe:////./pipe/docker_engine
                         tcp://127.0.0.1:2375
  --wsl-distro <name>  指定 WSL 发行版（默认自动探测）
  --transport <mode>   auto | relay | stdio | socket（默认 auto）
  --open               启动后自动打开浏览器
  --debug              打印调试日志

环境变量 DOCKER_HOST 同样生效。
`);
}

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
      const idx = path.join(WEB_DIR, 'index.html');
      fs.readFile(idx, (e2, buf) => {
        if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

function openBrowser(u) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', u], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [u], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [u], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) {}
}

function c(s, code) { return process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s; }

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const log = cfg.debug ? (...a) => console.error(c('[debug]', '90'), ...a) : () => {};

  const hub = new EngineHub({
    explicitHost: cfg.dockerHost || process.env.DOCKER_HOST || '',
    preferTransport: cfg.transport,
    preferDistro: cfg.wslDistro,
    log,
  });

  const api = createApi({ hub, config: cfg, log });

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch (_) {
      res.writeHead(400); res.end('bad request'); return;
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
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    serveStatic(req, res, url);
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 0; // 大文件上传/下载不限时

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(c(`\n端口 ${cfg.port} 已被占用。`, '31'));
      console.error(`  换个端口试试： node server.js --port ${cfg.port + 1}`);
      process.exit(1);
    }
    console.error('服务启动失败：', e.message);
    process.exit(1);
  });

  server.listen(cfg.port, cfg.bind, () => {
    const base = `http://${cfg.bind === '0.0.0.0' ? '127.0.0.1' : cfg.bind}:${cfg.port}`;
    console.log('');
    console.log(c('  dockfile ', '30;43') + c(` v${pkg.version}  ·  Docker 容器文件管理器`, '1'));
    console.log(`  本地地址   ${c(base, '36')}`);
    if (cfg.readOnly) console.log(`  模式       ${c('只读', '33')}（写操作全部禁用）`);
    if (cfg.token) console.log(`  访问令牌   已启用（页面首次访问需输入）`);
    if (cfg.bind === '0.0.0.0') console.log(c('  ⚠ 监听 0.0.0.0：等同于把容器 root 文件权限暴露给同网段', '31'));
    console.log('  正在探测 Docker 引擎…');
    hub.ensure({ refresh: true }).then((conn) => {
      console.log(`  引擎       ${c(conn.label, '32')}  ·  engine ${conn.serverVersion || '?'}  ·  API ${conn.apiVersion}  ·  ${conn.latencyMs}ms`);
      console.log('');
      console.log('  Ctrl+C 退出');
    }).catch((e) => {
      console.log(`  ${c('引擎', '31')}       ${c('未连接：' + e.message.split('\n')[0], '31')}`);
      console.log('');
      console.log('  排查建议：');
      console.log('    · WSL 里跑 Docker：先执行 wsl -d <发行版> -- docker ps 确认可用');
      console.log('    · Docker Desktop：启动后再点页面上的「重新探测」');
      console.log('    · 手动指定：node server.js --docker-host tcp://127.0.0.1:2375');
      console.log('    · 只想看界面：node tools/mock-engine.js 然后 --docker-host tcp://127.0.0.1:23750');
      console.log('');
    });
    if (cfg.open) setTimeout(() => openBrowser(base), 400);
  });

  const shutdown = () => {
    console.log('\n正在关闭…');
    try { hub.close(); } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('启动失败：', e && e.stack ? e.stack : e);
  process.exit(1);
});

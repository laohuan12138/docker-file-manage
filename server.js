#!/usr/bin/env node
'use strict';
/**
 * dockfile —— Docker 容器文件管理器（命令行 / 浏览器版）
 *   node server.js [--port 7788] [--bind 127.0.0.1] [--token xxx] [--read-only]
 *                  [--docker-host unix:///var/run/docker.sock | npipe:////./pipe/docker_engine | tcp://1.2.3.4:2375]
 *                  [--wsl-distro Ubuntu-22.04] [--transport auto|relay|stdio|socket] [--open]
 *
 * 桌面版见 electron/ 目录（npm run desktop / npm run dist）。
 */
const { spawn } = require('child_process');
const { createDockfileServer } = require('./lib/server-core');

const pkg = require('./package.json');

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
  if (!Number.isFinite(cfg.port) || cfg.port < 0) cfg.port = 7788;
  return cfg;
}

function printHelp() {
  console.log(`
dockfile ${pkg.version} — Docker 容器文件管理器

用法: node server.js [选项]

  --port <n>           监听端口（默认 7788，0 = 随机）
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
桌面版：npm run desktop（开发） / npm run dist（打包 exe）
`);
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
  const core = createDockfileServer({ ...cfg });

  let started;
  try {
    started = await core.start();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(c(`\n端口 ${cfg.port} 已被占用。`, '31'));
      console.error(`  换个端口试试： node server.js --port ${cfg.port + 1}`);
      process.exit(1);
    }
    console.error('服务启动失败：', e.message);
    process.exit(1);
  }

  console.log('');
  console.log(c('  dockfile ', '30;43') + c(` v${pkg.version}  ·  Docker 容器文件管理器`, '1'));
  console.log(`  本地地址   ${c(started.url, '36')}`);
  if (cfg.readOnly) console.log(`  模式       ${c('只读', '33')}（写操作全部禁用）`);
  if (cfg.token) console.log(`  访问令牌   已启用（页面首次访问需输入）`);
  if (cfg.bind === '0.0.0.0') console.log(c('  ⚠ 监听 0.0.0.0：等同于把容器 root 文件权限暴露给同网段', '31'));
  console.log('  正在探测 Docker 引擎…');

  core.ensureEngine({ refresh: true }).then((conn) => {
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

  if (cfg.open) setTimeout(() => openBrowser(started.url), 400);

  const shutdown = async () => {
    console.log('\n正在关闭…');
    await core.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('启动失败：', e && e.stack ? e.stack : e);
  process.exit(1);
});

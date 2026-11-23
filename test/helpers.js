'use strict';
/** 测试公共工具：playwright 定位、拉起 server / mock engine、WSL 辅助 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WSL_EXE = process.env.WSL_EXE || 'wsl.exe';

/** 默认使用默认发行版；需要指定时设置 WSL_DISTRO */
function wslCommand(script, distro) {
  const d = distro || process.env.WSL_DISTRO || '';
  const tail = `-- sh -c ${JSON.stringify(script)}`;
  return d ? `${WSL_EXE} -d ${d} ${tail}` : `${WSL_EXE} ${tail}`;
}

function loadPlaywright() {
  const cands = [process.env.PLAYWRIGHT_CORE];
  try { cands.push(path.join(execSync('npm root -g').toString().trim(), '@playwright/mcp/node_modules/playwright-core')); } catch (_) {}
  cands.push('playwright-core', 'playwright');
  for (const c of cands.filter(Boolean)) {
    try { return require(c); } catch (_) {}
  }
  throw new Error('找不到 playwright-core；可 npm i -D playwright-core 或设置 PLAYWRIGHT_CORE');
}

function chromeExe() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (!fs.existsSync(base)) return undefined;
  for (const d of fs.readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const sub of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) {
      const p = path.join(base, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

async function waitFor(url, { timeout = 30000, expect = (r) => r && r.ok } = {}) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeout) {
    try {
      const res = await fetch(url);
      const body = await res.json().catch(() => null);
      if (expect(body)) return body;
      lastErr = new Error(`健康检查未通过：${JSON.stringify(body).slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw lastErr || new Error('等待超时：' + url);
}

function startServer({ port = 7789, args = [], env = {} } = {}) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(port), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const log = [];
  proc.stdout.on('data', (c) => log.push(c.toString()));
  proc.stderr.on('data', (c) => log.push(c.toString()));
  const url = `http://127.0.0.1:${port}`;
  return {
    proc, url, log,
    async ready(opts) { return waitFor(url + '/api/health', opts); },
    async stop() {
      // 先礼后兵：给 server 一点时间优雅退出（它会顺手停掉 WSL relay）
      try { proc.kill(); } catch (_) {}
      const exited = await new Promise((resolve) => {
        if (proc.exitCode != null) return resolve(true);
        const timer = setTimeout(() => resolve(false), 5000);
        proc.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      if (!exited) {
        try { if (process.platform === 'win32') execSync(`taskkill /PID ${proc.pid} /T /F 2>nul`, { stdio: 'ignore' }); }
        catch (_) {}
      }
      await new Promise((r) => setTimeout(r, 200));
    },
  };
}

/** 拉起 mock engine（最小 Docker Engine 实现，进程内无依赖） */
async function startMockEngine({ port = 23850 } = {}) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-engine.js'), '--port', String(port)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const log = [];
  proc.stdout.on('data', (c) => log.push(c.toString()));
  proc.stderr.on('data', (c) => log.push(c.toString()));
  await waitFor(`http://127.0.0.1:${port}/_ping`, { expect: () => true, timeout: 15000 });
  return {
    proc, log, url: `http://127.0.0.1:${port}`,
    stop: async () => {
      try { proc.kill(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 200));
    },
  };
}

/**
 * 确保 WSL 里有一个用于写测试的临时容器（alpine，长时间运行）。
 * 只在 Windows + WSL 环境使用；已存在则启动它。
 */
function ensureWslContainer(name = 'dockfile-selftest') {
  const run = (script) => {
    try {
      return execSync(wslCommand(script), { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      return (e.stdout || '') + '';
    }
  };
  const running = run(`docker inspect -f '{{.State.Running}}' ${name} 2>/dev/null`).trim();
  if (running === 'true') return { name, created: false };
  if (running === 'false') {
    run(`docker start ${name}`);
    return { name, created: false, started: true };
  }
  run(`docker run -d --name ${name} alpine:latest sleep 86400`);
  run(`docker exec ${name} sh -c "mkdir -p /app/data /var/www/html && echo hello > /app/data/readme.txt"`);
  return { name, created: true };
}

module.exports = {
  ROOT, wslCommand, loadPlaywright, chromeExe, startServer, startMockEngine, waitFor, ensureWslContainer,
};

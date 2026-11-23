'use strict';
/**
 * WSL 桥接：Windows 侧没有 docker 时，把 WSL 里的 docker.sock 接出来。
 * 两条路径：
 *   relay  —— socat / python3 在 WSL 内监听 127.0.0.1:port（依赖 WSL2 localhost 转发，实测可用）
 *   stdio  —— wsl.exe docker system dial-stdio（无端口，最稳的兜底）
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');
const { decodeWsl, sleep } = require('./util');

const WSL_EXE = process.env.WSL_EXE || 'wsl.exe';
const RELAY_SCRIPT = path.join(__dirname, 'wsl-relay.py');
const RELAY_SH = path.join(__dirname, 'wsl-relay.sh');
const REMOTE_SH = '/tmp/dockfile-relay.sh';
const REMOTE_PY = '/tmp/dockfile-relay.py';
const DEFAULT_SOCK = '/var/run/docker.sock';

const isWindows = process.platform === 'win32';

function log(...a) {
  if (process.env.DOCKFILE_DEBUG) console.error('[wsl]', ...a);
}

function runWsl(args, { timeout = 25000, input } = {}) {
  const r = spawnSync(WSL_EXE, args, {
    timeout,
    input,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'buffer',
  });
  const stdout = decodeWsl(r.stdout || Buffer.alloc(0));
  const stderr = decodeWsl(r.stderr || Buffer.alloc(0));
  return { status: r.status, stdout, stderr, error: r.error };
}

/** wsl -l -q → 发行版列表（输出是 UTF-16LE） */
function listDistros() {
  if (!isWindows) return [];
  let r;
  try {
    r = runWsl(['-l', '-q'], { timeout: 15000 });
  } catch (_) {
    return [];
  }
  if (r.error && !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.replace(/\0/g, '').trim())
    .filter((s) => s && !/^docker-desktop(-data)?$/.test(s.replace(/[^\x20-\x7e]/g, '')));
}

function listDistrosAll() {
  if (!isWindows) return [];
  const r = runWsl(['-l', '-q'], { timeout: 15000 });
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** 单次进入发行版做全量探测 */
function probeDistro(distro) {
  const script = [
    'echo "IMPL:"; command -v docker || true;',
    'echo "VER:"; docker version --format "{{.Server.Version}}" 2>&1 | tail -1;',
    'echo "SOCK:"; ls -l ' + DEFAULT_SOCK + ' 2>&1;',
    'echo "SOCAT:"; command -v socat || true;',
    'echo "PY:"; command -v python3 || true;',
    'echo "USER:"; id -un 2>&1;',
    'echo "IP:"; hostname -I 2>/dev/null | cut -d" " -f1;',
  ].join(' ');
  const args = distro ? ['-d', distro, '--', 'sh', '-c', script] : ['--', 'sh', '-c', script];
  const r = runWsl(args, { timeout: 30000 });
  const pick = (key) => {
    const m = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(r.stdout || '');
    return m ? m[1].trim() : '';
  };
  const sockLine = pick('SOCK');
  const probe = {
    distro,
    docker: pick('IMPL'),
    serverVersion: pick('VER'),
    hasSocket: /^srw/.test(sockLine) || /docker\.sock/.test(sockLine),
    sockPath: DEFAULT_SOCK,
    socat: pick('SOCAT'),
    python3: pick('PY'),
    user: pick('USER'),
    ip: pick('IP'),
    stderr: r.stderr,
    ok: false,
  };
  probe.ok = Boolean(probe.docker && probe.hasSocket && /^\d+\.\d+/.test(probe.serverVersion));
  // docker 可执行但权限不足
  if (probe.docker && probe.hasSocket && /permission denied/i.test(probe.serverVersion)) {
    probe.permissionDenied = true;
    probe.ok = false;
  }
  if (probe.ok) probe.permissionDenied = false;
  return probe;
}

// ---------- 端口与探活 ----------

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start = 23760, count = 40) {
  for (let i = 0; i < count; i++) {
    const port = start + i;
    if (await portFree(port)) return port;
  }
  throw new Error('WSL relay 找不到空闲端口');
}

/** 直接打一次 /_ping，判断这个 tcp 端点是不是 docker */
function pingHttp(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/_ping', method: 'GET', timeout }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, apiVersion: res.headers['api-version'] || '', body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

// ---------- relay ----------

function writeRemoteFile(distro, remotePath, content) {
  const args = distro
    ? ['-d', distro, '--', 'sh', '-c', `cat > '${remotePath}'`]
    : ['--', 'sh', '-c', `cat > '${remotePath}'`];
  const r = runWsl(args, { timeout: 20000, input: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8') });
  return r.status === 0;
}

/** 把 relay 控制脚本（sh + py）推进 WSL，幂等 */
function ensureRelayScripts(distro) {
  if (!writeRemoteFile(distro, REMOTE_SH, fs.readFileSync(RELAY_SH, 'utf8'))) return false;
  if (!writeRemoteFile(distro, REMOTE_PY, fs.readFileSync(RELAY_SCRIPT, 'utf8'))) return false;
  runWsl([...(distro ? ['-d', distro] : []), '--', 'sh', '-c', `chmod +x ${REMOTE_SH}`], { timeout: 10000 });
  return true;
}

function relayCtl(distro, action, port) {
  const args = [
    ...(distro ? ['-d', distro] : []),
    '--', 'sh', REMOTE_SH, action,
    ...(port != null ? [String(port)] : []),
  ];
  return runWsl(args, { timeout: 20000 });
}

/**
 * 启动 relay，返回 {port, mode, host}。mode: socat | python3
 * 端口冲突 / 起不来时会换端口重试（最多 3 次）
 */
async function startRelay(probe, { port: wantPort } = {}) {
  const distro = probe.distro;
  if (!probe.socat && !probe.python3) throw new Error('WSL 内既没有 socat 也没有 python3，无法建立 relay');
  if (!ensureRelayScripts(distro)) throw new Error('无法把 relay 脚本写入 WSL（/tmp 不可写？）');

  const tried = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = wantPort || (await findFreePort(23760 + Math.floor(Math.random() * 30)));
    if (tried.includes(port)) continue;
    tried.push(port);
    const r = relayCtl(distro, 'start', port);
    if (r.status !== 0 || !/^ok /m.test(r.stdout)) {
      log(`relay start failed on ${port}: ${(r.stderr || r.stdout || '').trim()}`);
      continue;
    }
    const mode = /^ok (socat|python3)/m.exec(r.stdout)[1];
    // 探活（进程已确认活着，端口通常立刻可用）
    for (let i = 0; i < 15; i++) {
      const p = await pingHttp('127.0.0.1', port, 1200);
      if (p.ok) return { host: '127.0.0.1', port, mode, distro, apiVersion: p.apiVersion };
      await sleep(200);
    }
    // 回退：用 WSL 的 IP 直连（localhost 转发被关时）
    if (probe.ip) {
      for (let i = 0; i < 6; i++) {
        const p = await pingHttp(probe.ip, port, 1200);
        if (p.ok) return { host: probe.ip, port, mode, distro, apiVersion: p.apiVersion, note: 'via-wsl-ip' };
        await sleep(200);
      }
    }
    relayCtl(distro, 'stop', port);
    log(`relay on ${port} started but not reachable, retrying`);
  }
  throw new Error('WSL relay 建立失败：端口不通（WSL2 localhost 转发可能被关闭）');
}

/** 复用上次运行遗留的 relay（避免每次启动都新起一个，端口越堆越多） */
async function adoptRelay(distro, probe) {
  const r = relayCtl(distro, 'list');
  const ports = String(r.stdout || '')
    .split('\n')
    .map((l) => parseInt(l.trim().split(/\s+/)[0], 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  for (const port of ports) {
    const p = await pingHttp('127.0.0.1', port, 800);
    if (p.ok) {
      relayCtl(distro, 'sweep');
      return { host: '127.0.0.1', port, mode: 'adopted', distro, apiVersion: p.apiVersion, adopted: true };
    }
  }
  relayCtl(distro, 'sweep');
  return null;
}

function stopRelay(relay) {
  if (!relay) return;
  try { relayCtl(relay.distro, 'stop', relay.port); } catch (_) {}
}

function stopAllRelays(distro) {
  try { relayCtl(distro, 'stop-all'); } catch (_) {}
}

/** stdio 兜底命令 */
function stdioCommand(distro) {
  const args = distro
    ? ['-d', distro, '--', 'docker', 'system', 'dial-stdio']
    : ['--', 'docker', 'system', 'dial-stdio'];
  return { cmd: WSL_EXE, args };
}

module.exports = {
  isWindows, listDistros, listDistrosAll, probeDistro,
  startRelay, adoptRelay, stopRelay, stopAllRelays, stdioCommand, pingHttp, findFreePort, portFree, runWsl,
};

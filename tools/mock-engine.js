#!/usr/bin/env node
'use strict';
/**
 * mock-engine —— 最小 Docker Engine API 实现，用真实目录冒充容器 rootfs。
 * 用途：没有 Docker 引擎时演示界面 / 跑自动化测试（npm run mock）。
 *
 *   node tools/mock-engine.js [--port 23750]
 *   然后：node server.js --docker-host tcp://127.0.0.1:23750
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { TarWriter, TarParser } = require('../lib/tar');

const ROOT = path.join(__dirname, 'fixtures');
const PORT = Number(process.env.MOCK_PORT || (process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 23750));
const API = '1.44';

/* ---------------- 夹具 ---------------- */

const FIXTURES = {
  'web-nginx': { name: 'web-nginx', image: 'nginx:1.27-alpine', running: true, command: 'nginx -g "daemon off;"', project: 'demo-stack', service: 'web' },
  'db-postgres': { name: 'db-postgres', image: 'postgres:16-alpine', running: false, command: 'postgres', project: 'demo-stack', service: 'db' },
};

function ensureFixtures() {
  const web = path.join(ROOT, 'web-nginx');
  const db = path.join(ROOT, 'db-postgres');
  const w = (p, content, mode) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    if (mode) fs.chmodSync(p, mode);
  };
  // 两个容器都有的「像真容器」的骨架目录，截图更好看
  const skeleton = (root) => {
    for (const d of ['bin', 'dev', 'home', 'lib', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr/bin', 'usr/lib', 'usr/share', 'var/log', 'var/tmp']) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
    }
    w(path.join(root, 'etc/passwd'), 'root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/nonexistent:/sbin/nologin\n');
    w(path.join(root, 'etc/group'), 'root:x:0:\nnogroup:x:65533:\nnobody:x:65534:\n');
    w(path.join(root, 'etc/hostname'), path.basename(root).replace(/[^a-z0-9]/gi, '').padEnd(12, '0').slice(0, 12) + '\n');
    w(path.join(root, 'etc/hosts'), '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n');
    w(path.join(root, 'etc/resolv.conf'), 'nameserver 127.0.0.11\noptions ndots:0\n');
    w(path.join(root, 'etc/os-release'), 'PRETTY_NAME="Alpine Linux v3.20"\nNAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.3\n');
    w(path.join(root, 'etc/profile'), 'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nexport PAGER=less\nexport PS1="\\h:\\w\\$ "\n');
    w(path.join(root, 'usr/local/bin/docker-entrypoint.sh'), '#!/bin/sh\nset -e\nif [ "${1#-}" != "$1" ]; then\n  set -- nginx "$@"\nfi\nexec "$@"\n', 0o755);
    w(path.join(root, 'root/.profile'), 'export PS1="\\h:\\w\\# "\n', 0o600);
  };
  skeleton(web);
  skeleton(db);

  w(path.join(web, 'etc/nginx/nginx.conf'), `user  nginx;
worker_processes  auto;
error_log  /var/log/nginx/error.log notice;
pid        /var/run/nginx.pid;

events {
    worker_connections  1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    sendfile        on;
    keepalive_timeout  65;

    server {
        listen       80;
        server_name  localhost;
        root   /var/www/html;
        index  index.html;

        location /api/ {
            proxy_pass http://backend:8080/;
        }
    }
}
`);
  w(path.join(web, 'etc/nginx/conf.d/default.conf'), `server {\n    listen 80;\n    root /var/www/html;\n}\n`);
  w(path.join(web, 'etc/hosts'), '127.0.0.1\tlocalhost\n172.18.0.2\tweb-nginx\n');
  w(path.join(web, 'etc/hostname'), 'a1b2c3d4e5f6\n');
  w(path.join(web, 'var/www/html/index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>mock nginx</title></head>
<body><h1>dockfile mock container</h1><p>这个页面来自 mock-engine 的夹具目录。</p></body></html>
`);
  w(path.join(web, 'var/www/html/assets/style.css'), 'body{font-family:system-ui;background:#0b0f14;color:#e6edf3}\n');
  w(path.join(web, 'var/www/html/assets/logo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAWklEQVR42u3OMQEAAAgDoC251a3gLzQgenIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4A2J4AAHZK7YhAAAAAElFTkSuQmCC', 'base64'));
  w(path.join(web, 'var/www/html/说明文档.md'), '# 中文文件名测试\n\n这个文件用来验证中文名、长文件名与下载头。\n');
  w(path.join(web, 'var/log/nginx/access.log'), Array.from({ length: 400 }, (_, i) => `10.0.0.${i % 250} - - [23/Nov/2026:15:0${i % 10}:00 +0800] "GET /page/${i} HTTP/1.1" 200 ${100 + i} "-" "curl/8.5.0"`).join('\n') + '\n');
  w(path.join(web, 'usr/local/bin/entrypoint.sh'), '#!/bin/sh\nexec nginx -g "daemon off;"\n', 0o755);
  const big = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
  w(path.join(web, 'var/www/html/assets/video-mock.bin'), big);
  fs.mkdirSync(path.join(web, 'var/www/html/empty-dir'), { recursive: true });
  fs.mkdirSync(path.join(web, 'app'), { recursive: true });
  try { fs.symlinkSync('/var/www/html', path.join(web, 'app/current'), 'dir'); } catch (_) {}
  try { fs.symlinkSync('/etc/nginx/nginx.conf', path.join(web, 'etc/nginx.conf'), 'file'); } catch (_) {}

  w(path.join(db, 'etc/postgresql/postgresql.conf'), "listen_addresses = '*'\nport = 5432\nmax_connections = 100\nshared_buffers = 128MB\n");
  w(path.join(db, 'etc/passwd'), 'root:x:0:0:root:/root:/bin/sh\npostgres:x:70:70::/var/lib/postgresql:/bin/sh\n');
  w(path.join(db, 'var/lib/postgresql/data/PG_VERSION'), '16\n');
  w(path.join(db, 'var/lib/postgresql/data/postgresql.auto.conf'), '# Do not edit this file manually\nlisten_addresses = \'*\'\n');
  w(path.join(db, 'var/lib/postgresql/data/postmaster.pid'), '1\n/var/lib/postgresql/data\n1726000000\n5432\n/var/run/postgresql\nlocalhost\nready\n');
  w(path.join(db, 'var/log/postgresql/postgresql.log'), Array.from({ length: 60 }, (_, i) => `2026-11-23 15:${String(i % 60).padStart(2, '0')}:00.000 CST [${100 + i}] LOG:  database system is ready to accept connections`).join('\n') + '\n');
  fs.mkdirSync(path.join(db, 'var/lib/postgresql/data/base'), { recursive: true });
}

function containerRoot(name) { return path.join(ROOT, name); }

/* ---------------- 容器元数据 ---------------- */

const state = new Map();
function initState() {
  for (const [key, meta] of Object.entries(FIXTURES)) {
    state.set(key, {
      ...meta,
      id: crypto.createHash('sha256').update('mock-' + key).digest('hex'),
      running: meta.running,
      created: Math.floor(Date.now() / 1000) - 3600 * (key === 'web-nginx' ? 2 : 5),
    });
  }
}
function findContainer(idOrName) {
  for (const c of state.values()) {
    if (c.id === idOrName || c.id.startsWith(idOrName) || c.name === idOrName) return c;
  }
  return null;
}

/* ---------------- 路径与 stat ---------------- */

function rootOf(c) {
  const r = containerRoot(c.name);
  fs.mkdirSync(r, { recursive: true });
  return r;
}

function hostPath(c, containerPath) {
  const p = String(containerPath || '/');
  const root = rootOf(c);
  const clean = path.posix.normalize('/' + p.replace(/^\/+/, '')).replace(/^(\.\.\/)+/, '/');
  return { host: path.join(root, clean), rel: clean };
}

const GO_MODE_DIR = 0x80000000;
const GO_MODE_SYMLINK = 0x08000000;

/* Windows 上 chmod 无效，用一个旁挂的 JSON 记录 POSIX 权限，让 mock 更接近真实引擎 */
const MODE_FILE = path.join(ROOT, '.mock-modes.json');
let modeMap = {};
function loadModes() {
  try { modeMap = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')); } catch (_) { modeMap = {}; }
}
function saveModes() {
  try { fs.writeFileSync(MODE_FILE, JSON.stringify(modeMap)); } catch (_) {}
}
const modeKey = (name, rel) => `${name}:${rel}`;
function getMode(name, rel) {
  const k = modeKey(name, rel);
  return Object.prototype.hasOwnProperty.call(modeMap, k) ? modeMap[k] : null;
}
function setMode(name, rel, mode) {
  modeMap[modeKey(name, rel)] = mode & 0o7777;
  saveModes();
}
function dropModeTree(name, rel) {
  const prefix = modeKey(name, rel);
  for (const k of Object.keys(modeMap)) if (k === prefix || k.startsWith(prefix + '/')) delete modeMap[k];
  saveModes();
}
function moveModeTree(name, fromRel, toRel) {
  const fromPrefix = modeKey(name, fromRel);
  for (const k of Object.keys(modeMap)) {
    if (k === fromPrefix || k.startsWith(fromPrefix + '/')) {
      modeMap[modeKey(name, toRel) + k.slice(fromPrefix.length)] = modeMap[k];
      delete modeMap[k];
    }
  }
  saveModes();
}

/** Windows 上 st.mode 不可靠：给一个 POSIX 风格的默认权限，让列表看起来像真容器 */
function effectiveMode(host, st, recorded) {
  if (recorded != null) return recorded;
  if (st.isDirectory()) return 0o755;
  if (st.isSymbolicLink()) return 0o777;
  if (/\.sh$/i.test(path.basename(host))) return 0o755;
  return 0o644;
}

function statInfo(c, host, containerPath) {
  let st;
  try { st = fs.lstatSync(host); } catch (_) { return null; }
  const isDir = st.isDirectory();
  const isLink = st.isSymbolicLink();
  const recorded = getMode(c.name, containerPath.replace(/^\/+/, '') || '/');
  let mode = effectiveMode(host, st, recorded);
  if (isDir) mode |= GO_MODE_DIR;
  if (isLink) mode |= GO_MODE_SYMLINK;
  let linkTarget = '';
  if (isLink) { try { linkTarget = fs.readlinkSync(host); } catch (_) {} }
  return {
    name: path.posix.basename(containerPath) || '/',
    size: isDir ? 4096 : st.size,
    mode,
    mtime: Math.floor(st.mtimeMs / 1000),
    linkTarget,
  };
}

/* ---------------- tar 打包 ---------------- */

function walk(baseHost, baseRel, out, cname) {
  const entries = fs.readdirSync(baseHost, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    const host = path.join(baseHost, ent.name);
    const rel = (baseRel ? baseRel + '/' : '') + ent.name;
    const st = fs.lstatSync(host);
    if (st.isDirectory()) {
      out.push({ name: rel + '/', dir: true, mode: effectiveMode(host, st, getMode(cname, rel)) });
      walk(host, rel, out, cname);
    } else if (st.isSymbolicLink()) {
      out.push({ name: rel, type: '2', linkname: fs.readlinkSync(host), mode: 0o777 });
    } else {
      out.push({ name: rel, file: host, size: st.size, mode: effectiveMode(host, st, getMode(cname, rel)), mtime: Math.floor(st.mtimeMs / 1000) });
    }
  }
  return out;
}

async function sendTar(res, host, relPath, cname) {
  let st;
  try { st = fs.lstatSync(host); } catch (_) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'no such file or directory' })); return; }
  const isRoot = relPath === '/' || relPath === '' || relPath === '.';
  const base = isRoot ? '' : (path.posix.basename(relPath) || 'root');
  const items = [];
  if (st.isDirectory()) {
    // 与真实引擎一致：根目录打包时条目是绝对路径风格，不带顶层目录名
    if (!isRoot) items.push({ name: base + '/', dir: true, mode: effectiveMode(host, st, getMode(cname, base)) });
    walk(host, base, items, cname);
  } else if (st.isSymbolicLink()) {
    items.push({ name: base, type: '2', linkname: fs.readlinkSync(host), mode: 0o777 });
  } else {
    items.push({ name: base, file: host, size: st.size, mode: effectiveMode(host, st, getMode(cname, base)), mtime: Math.floor(st.mtimeMs / 1000) });
  }
  res.writeHead(200, { 'Content-Type': 'application/x-tar' });
  const w = new TarWriter(res);
  for (const it of items) {
    if (it.dir) await w.addBuffer(it.name, Buffer.alloc(0), { mode: it.mode, type: '5' });
    else if (it.type === '2') await w.addBuffer(it.name, Buffer.alloc(0), { mode: it.mode, type: '2', linkname: it.linkname });
    else await w.addStream(it.name, fs.createReadStream(it.file), it.size, { mode: it.mode, mtime: it.mtime });
  }
  await w.end();
  res.end();
}

/* ---------------- tar 解包 ---------------- */

function applyTar(buf, hostDest, cname, destRel) {
  const destPrefix = String(destRel || "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return new Promise((resolve, reject) => {
    const items = [];
    let current = null;
    const parser = new TarParser({
      onEntry: (h) => {
        current = { header: h, chunks: [] };
        items.push(current);
      },
      onData: (chunk) => { if (current) current.chunks.push(Buffer.from(chunk)); },
    });
    parser.on('done', () => {
      try {
        for (const it of items) {
          const p = path.join(hostDest, it.header.name.replace(/\/+$/, ''));
          if (path.relative(hostDest, p).startsWith('..')) continue;
          const relName = it.header.name.replace(/\/+$/, '');
          const absRel = (destPrefix ? destPrefix + '/' : '') + relName;
          if (it.header.type === 'dir' || it.header.name.endsWith('/')) {
            fs.mkdirSync(p, { recursive: true });
            try { fs.chmodSync(p, it.header.mode & 0o7777 || 0o755); } catch (_) {}
            setMode(cname, absRel, it.header.mode & 0o7777 || 0o755);
            continue;
          }
          if (it.header.type === 'symlink') {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            try { fs.symlinkSync(it.header.linkname, p); } catch (_) {}
            continue;
          }
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, Buffer.concat(it.chunks));
          try { fs.chmodSync(p, it.header.mode & 0o7777 || 0o644); } catch (_) {}
          setMode(cname, absRel, it.header.mode & 0o7777 || 0o644);
        }
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    parser.on('error', reject);
    parser.write(buf);
    parser.end();
  });
}

/* ---------------- exec 模拟 ---------------- */

function execListing(root, dirPath) {
  const { host } = hostPath({ name: path.basename(root) }, dirPath);
  let st;
  try { st = fs.statSync(host); } catch (_) { return { code: 4, stdout: '', stderr: 'cd: no such file' }; }
  if (!st.isDirectory()) return { code: 4, stdout: '', stderr: 'not a directory' };
  const lines = [];
  const describe = (h) => {
    const s = fs.lstatSync(h);
    if (s.isDirectory()) return 'directory';
    if (s.isSymbolicLink()) return 'symbolic link';
    if (s.isFIFO()) return 'fifo';
    return 'regular file';
  };
  for (const name of fs.readdirSync(host)) {
    const h = path.join(host, name);
    const s = fs.lstatSync(h);
    let label = name;
    if (s.isSymbolicLink()) {
      try { label = `'${name}' -> '${fs.readlinkSync(h)}'`; } catch (_) { label = `'${name}'`; }
    } else label = `'${name}'`;
    const rec = getMode(path.basename(root), path.relative(host, h).split(path.sep).join('/'));
    lines.push(`${describe(h)}|${effectiveMode(h, s, rec).toString(8)}|${s.isDirectory() ? 4096 : s.size}|${Math.floor(s.mtimeMs / 1000)}|${label}`);
  }
  return { code: 0, stdout: lines.join('\n') + (lines.length ? '\n' : ''), stderr: '' };
}

function runExec(c, argv) {
  const root = rootOf(c);
  const asHost = (p) => hostPath({ name: c.name }, p).host;
  const cmd = argv[0];
  if (cmd === 'sh' || cmd === 'bash') {
    // 只支持我们自己用的两种脚本：cd "$1" + stat -c；其它返回 127
    const script = argv[2] || '';
    if (/stat -c/.test(script) && /cd "\$1"/.test(script)) return execListing(root, argv[4] || '/');
    return { code: 127, stdout: '', stderr: 'mock exec: unsupported script' };
  }
  if (cmd === 'rm') {
    const paths = argv.filter((a) => a.startsWith('/'));
    try {
      for (const p of paths) { fs.rmSync(asHost(p), { recursive: true, force: true }); dropModeTree(c.name, String(p).replace(/^\/+/, '')); }
      return { code: 0, stdout: '', stderr: '' };
    } catch (e) { return { code: 1, stdout: '', stderr: e.message }; }
  }
  if (cmd === 'mv') {
    const [from, to] = argv.filter((a) => a.startsWith('/'));
    try {
      fs.renameSync(asHost(from), asHost(to));
      moveModeTree(c.name, String(from).replace(/^\/+/, ''), String(to).replace(/^\/+/, ''));
      return { code: 0, stdout: '', stderr: '' };
    }
    catch (e) { return { code: 1, stdout: '', stderr: e.message }; }
  }
  if (cmd === 'chmod') {
    const mode = argv[1];
    const p = argv[2];
    try { fs.chmodSync(asHost(p), parseInt(mode, 8)); setMode(c.name, String(p).replace(/^\/+/, ''), parseInt(mode, 8)); return { code: 0, stdout: '', stderr: '' }; }
    catch (e) { return { code: 1, stdout: '', stderr: e.message }; }
  }
  return { code: 127, stdout: '', stderr: `mock exec: ${cmd}: command not found` };
}

/* ---------------- 镜像 ---------------- */

const IMAGE_LIST = [
  { Id: 'sha256:' + crypto.createHash('sha256').update('mock-nginx').digest('hex'), RepoTags: ['nginx:1.27-alpine'], Size: 53_200_000, Created: 1720000000, Containers: 1 },
  { Id: 'sha256:' + crypto.createHash('sha256').update('mock-pg').digest('hex'), RepoTags: ['postgres:16-alpine'], Size: 241_000_000, Created: 1720000000, Containers: 1 },
  { Id: 'sha256:' + crypto.createHash('sha256').update('mock-alpine').digest('hex'), RepoTags: ['alpine:3.20'], Size: 7_800_000, Created: 1720000000, Containers: 0 },
  { Id: 'sha256:' + crypto.createHash('sha256').update('mock-py').digest('hex'), RepoTags: ['python:3.12-slim'], Size: 128_000_000, Created: 1720000000, Containers: 0 },
  { Id: 'sha256:' + crypto.createHash('sha256').update('mock-distroless').digest('hex'), RepoTags: ['gcr.io/distroless/static:nonroot', 'gcr.io/distroless/static@sha256:e2f7'], Size: 2_100_000, Created: 1720000000, Containers: 0 },
];
/** 没有 shell 的镜像（用来演示/测试 NO_SHELL 分支） */
const NO_SHELL_IMAGES = new Set(['gcr.io/distroless/static:nonroot', 'gcr.io/distroless/static@sha256:e2f7']);
/** mock 里"存在"的 shell 二进制（alpine 只有 sh/ash，没有 bash） */
const SHELL_BINS = new Set(['/bin/sh', '/bin/ash', '/busybox/sh']);

function listImages() {
  return IMAGE_LIST.map((i) => ({ ...i, RepoTags: i.RepoTags.slice() }));
}

function imageHasShell(image) {
  if (NO_SHELL_IMAGES.has(image)) return false;
  return true;
}

/* ---------------- 终端模拟（pty） ---------------- */

function shellLine(c, line, cwd) {
  const root = rootOf(c);
  const argv = line.trim().split(/\s+/).filter(Boolean);
  const cmd = argv[0] || '';
  const args = argv.slice(1);
  const host = (p) => path.join(root, String(p || '/').replace(/^\/+/, ''));
  const resolve = (p) => {
    if (!p) return cwd;
    return p.startsWith('/') ? path.posix.normalize(p) : path.posix.normalize(path.posix.join(cwd, p));
  };
  const nl = '\r\n';
  switch (cmd) {
    case '': return { out: '', cwd };
    case 'help':
      return { out: `mock shell 支持：ls cd pwd cat echo whoami id uname env ps date clear exit${nl}`, cwd };
    case 'pwd': return { out: cwd + nl, cwd };
    case 'echo': return { out: args.join(' ') + nl, cwd };
    case 'whoami': return { out: 'root' + nl, cwd };
    case 'id': return { out: 'uid=0(root) gid=0(root) groups=0(root)' + nl, cwd };
    case 'uname': return { out: `Linux ${c.name} 6.8.0-mock #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux${nl}`, cwd };
    case 'date': return { out: new Date().toUTCString() + nl, cwd };
    case 'env':
      return { out: `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${nl}HOSTNAME=${c.name}${nl}TERM=xterm-256color${nl}`, cwd };
    case 'ps':
      return { out: `PID   USER     TIME  COMMAND${nl}    1 root      0:00 ${c.command || 'sh'}${nl}`, cwd };
    case 'clear': return { out: '\x1b[2J\x1b[H', cwd };
    case 'cd': {
      const target = resolve(args[0] || '/root');
      try {
        if (!fs.statSync(host(target)).isDirectory()) return { out: '', err: `cd: ${target}: Not a directory${nl}`, cwd };
      } catch (_) {
        return { out: '', err: `cd: ${target}: No such file or directory${nl}`, cwd };
      }
      return { out: '', cwd: target };
    }
    case 'ls': {
      const flags = args.filter((a) => a.startsWith('-'));
      const rest = args.filter((a) => !a.startsWith('-'));
      const target = resolve(rest[0] || '');
      let names;
      try { names = fs.readdirSync(host(target)); } catch (_) {
        return { out: '', err: `ls: ${rest[0] || target}: No such file or directory${nl}`, cwd };
      }
      if (!flags.includes('-a')) names = names.filter((n) => !n.startsWith('.'));
      names.sort();
      if (flags.includes('-l')) {
        const rows = names.map((n) => {
          const h = path.join(host(target), n);
          const st = fs.lstatSync(h);
          const dir = st.isDirectory();
          return `${dir ? 'd' : '-'}rw-r--r--    1 root     root  ${String(dir ? 4096 : st.size).padStart(10)}  ${path.posix.basename(target) === '/' ? '' : ''}${n}`;
        });
        return { out: rows.join(nl) + (rows.length ? nl : ''), cwd };
      }
      if (!names.length) return { out: '', cwd };
      const painted = names.map((n) => {
        const h = path.join(host(target), n);
        try { return fs.statSync(h).isDirectory() ? `\x1b[1;34m${n}\x1b[0m` : n; } catch (_) { return n; }
      });
      return { out: painted.join('  ') + nl, cwd };
    }
    case 'cat': {
      const target = resolve(args[0] || '');
      try {
        const st = fs.statSync(host(target));
        if (st.isDirectory()) return { out: '', err: `cat: ${target}: Is a directory${nl}`, cwd };
        if (st.size > 256 * 1024) return { out: '', err: `cat: ${target}: 文件太大（mock 只读 256KB）${nl}`, cwd };
        return { out: fs.readFileSync(host(target), 'utf8').replace(/\r?\n/g, nl), cwd };
      } catch (_) {
        return { out: '', err: `cat: ${target}: No such file or directory${nl}`, cwd };
      }
    }
    default:
      return { out: '', err: `sh: ${cmd}: not found${nl}`, cwd };
  }
}

/** 把一个已 hijack 的 socket 变成可交互的假 shell */
function attachPty(socket, c, { initial = '', cwd: startCwd = '/' } = {}) {
  let cwd = startCwd || '/';
  let line = '';
  let esc = 0;
  const write = (s) => { try { if (!socket.destroyed) socket.write(s); } catch (_) {} };
  const prompt = () => write(`\x1b[1;32mroot@${c.name}\x1b[0m:\x1b[1;34m${cwd}\x1b[0m# `);

  const feed = (str) => {
    for (const ch of str) {
      if (esc === 1) { if (ch === '[' || ch === 'O') { esc = 2; continue; } esc = 0; continue; }
      if (esc === 2) { if (/[A-Za-z~]/.test(ch)) esc = 0; continue; }
      if (ch === '\x1b') { esc = 1; continue; }
      if (ch === '\r' || ch === '\n') {
        const cmd = line;
        line = '';
        write('\r\n');
        if (/^\s*(exit|logout|quit)\s*$/.test(cmd)) { try { socket.end(); } catch (_) {} return; }
        const r = shellLine(c, cmd, cwd);
        cwd = r.cwd;
        if (r.out) write(r.out);
        if (r.err) write(r.err);
        prompt();
        continue;
      }
      if (ch === '\x03') { write('^C\r\n'); line = ''; prompt(); continue; }
      if (ch === '\x04') { try { socket.end(); } catch (_) {} return; }
      if (ch === '\x7f' || ch === '\b') { if (line.length) { line = line.slice(0, -1); write('\b \b'); } continue; }
      if (ch < ' ') continue;
      line += ch;
      write(ch);
    }
  };

  socket.on('error', () => {});
  socket.on('close', () => {});
  socket.setNoDelay?.(true);
  prompt();
  if (initial) feed(initial);
  socket.on('data', (chunk) => feed(chunk.toString('utf8')));
}

/* ---------------- HTTP ---------------- */

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}

const execs = new Map();

function listContainers() {
  return Array.from(state.values()).map((c) => ({
    Id: c.id,
    Names: ['/' + c.name],
    Image: c.image,
    ImageID: 'sha256:mock',
    Command: c.command,
    Created: c.created,
    State: c.running ? 'running' : 'exited',
    Status: c.running ? 'Up 2 hours' : 'Exited (0) 5 hours ago',
    Ports: c.running ? [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }] : [],
    Labels: { ...(c.labels || {}), 'com.docker.compose.project': c.project, 'com.docker.compose.service': c.service },
  }));
}

function inspect(c) {
  return {
    Id: c.id,
    Name: '/' + c.name,
    Image: 'sha256:mock',
    State: { Status: c.running ? 'running' : 'exited', Running: c.running, ExitCode: 0 },
    Config: { Image: c.image, Cmd: [c.command], Env: ['MOCK=1'] },
    Mounts: [],
  };
}

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (ch) => chunks.push(ch));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  const p = url.pathname.replace(new RegExp(`^/v[0-9.]+`), '');

  if (p === '/_ping') {
    res.writeHead(200, { 'API-Version': API, 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }
  if (p === '/version') {
    json(res, 200, { Version: 'mock-engine-1.0', ApiVersion: API, Os: process.platform, Arch: process.arch });
    return;
  }
  if (p === '/containers/json') { json(res, 200, listContainers()); return; }
  if (p === '/images/json') { json(res, 200, listImages()); return; }

  if (/^\/containers\/create$/.test(p) && req.method === 'POST') {
    const body = JSON.parse((await readAll(req)).toString('utf8') || '{}');
    if (!IMAGE_LIST.some((i) => i.RepoTags.includes(body.Image))) {
      return json(res, 404, { message: `No such image: ${body.Image}` });
    }
    const name = url.searchParams.get('name') || `mock-${crypto.randomBytes(3).toString('hex')}`;
    const argv = (body.Entrypoint && body.Entrypoint.length ? body.Entrypoint : null) || body.Cmd || ['/bin/sh'];
    const c = {
      name,
      image: body.Image,
      running: false,
      command: argv.join(' '),
      labels: body.Labels || {},
      created: Math.floor(Date.now() / 1000),
      id: crypto.createHash('sha256').update('mock-created-' + name + Date.now()).digest('hex'),
      shellless: !imageHasShell(body.Image) || !SHELL_BINS.has(argv[0]),
    };
    state.set(c.name, c);
    rootOf(c);
    json(res, 201, { Id: c.id, Warnings: [] });
    return;
  }

  let m = /^\/containers\/([^/]+)\/json$/.exec(p);
  if (m) {
    const c = findContainer(m[1]);
    if (!c) return json(res, 404, { message: 'no such container' });
    return json(res, 200, inspect(c));
  }

  m = /^\/containers\/([^/]+)\/start$/.exec(p);
  if (m && req.method === 'POST') {
    const c = findContainer(m[1]);
    if (!c) return json(res, 404, { message: 'no such container' });
    if (c.shellless) {
      return json(res, 500, { message: `OCI runtime create failed: exec: "/bin/sh": stat /bin/sh: no such file or directory: unknown` });
    }
    c.running = true;
    res.writeHead(204);
    res.end();
    return;
  }

  m = /^\/containers\/([^/]+)\/resize$/.exec(p);
  if (m && req.method === 'POST') {
    res.writeHead(204);
    res.end();
    return;
  }

  m = /^\/exec\/([^/]+)\/resize$/.exec(p);
  if (m && req.method === 'POST') {
    if (!execs.get(m[1])) return json(res, 404, { message: 'no such exec instance' });
    res.writeHead(204);
    res.end();
    return;
  }

  m = /^\/containers\/([^/]+)$/.exec(p);
  if (m && req.method === 'DELETE') {
    const c = findContainer(m[1]);
    if (!c) return json(res, 404, { message: 'no such container' });
    state.delete(c.name);
    try { fs.rmSync(containerRoot(c.name), { recursive: true, force: true }); } catch (_) {}
    res.writeHead(204);
    res.end();
    return;
  }

  m = /^\/containers\/([^/]+)\/archive$/.exec(p);
  if (m) {
    const c = findContainer(m[1]);
    if (!c) return json(res, 404, { message: 'no such container' });
    const cp = url.searchParams.get('path') || '/';
    const { host, rel } = hostPath(c, cp);

    if (req.method === 'PUT') {
      // 与真实引擎一致：父目录不存在会报错，但 tar 内条目可以建子目录
      const buf = await readAll(req);
      if (!fs.existsSync(host) || !fs.statSync(host).isDirectory()) {
        return json(res, 404, { message: 'no such file or directory' });
      }
      await applyTar(buf, host, c.name, rel);
      res.writeHead(200);
      res.end();
      return;
    }

    const info = statInfo(c, host, rel);
    if (!info) return json(res, 404, { message: 'no such file or directory' });

    if (req.method === 'HEAD') {
      res.writeHead(200, { 'X-Docker-Container-Path-Stat': Buffer.from(JSON.stringify(info)).toString('base64') });
      res.end();
      return;
    }
    if (req.method === 'GET') { await sendTar(res, host, rel, c.name); return; }
  }

  m = /^\/containers\/([^/]+)\/exec$/.exec(p);
  if (m && req.method === 'POST') {
    const c = findContainer(m[1]);
    if (!c) return json(res, 404, { message: 'no such container' });
    if (!c.running) return json(res, 409, { message: `Container ${c.id} is not running` });
    const body = JSON.parse((await readAll(req)).toString('utf8') || '{}');
    const id = crypto.randomUUID();
    execs.set(id, { container: c.id, argv: body.Cmd || [], workdir: body.WorkingDir || '', started: false });
    return json(res, 201, { Id: id });
  }

  m = /^\/exec\/([^/]+)\/start$/.exec(p);
  if (m && req.method === 'POST') {
    const ex = execs.get(m[1]);
    if (!ex) return json(res, 404, { message: 'no such exec instance' });
    ex.started = true;
    const r = runExec(findContainer(ex.container), ex.argv);
    ex.exitCode = r.code;
    res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
    const frame = (type, s) => {
      const buf = Buffer.from(s, 'utf8');
      const head = Buffer.alloc(8);
      head[0] = type;
      head.writeUInt32BE(buf.length, 4);
      return Buffer.concat([head, buf]);
    };
    if (r.stdout) res.write(frame(1, r.stdout));
    if (r.stderr) res.write(frame(2, r.stderr));
    res.end();
    return;
  }

  m = /^\/exec\/([^/]+)\/json$/.exec(p);
  if (m) {
    const ex = execs.get(m[1]);
    if (!ex) return json(res, 404, { message: 'no such exec instance' });
    return json(res, 200, { ID: m[1], Running: false, ExitCode: ex.exitCode == null ? -1 : ex.exitCode, ProcessConfig: { entrypoint: ex.argv[0], arguments: ex.argv.slice(1) } });
  }

  json(res, 404, { message: `mock-engine: 未实现 ${req.method} ${p}` });
});

/** 101 升级：exec -it / attach 的交互流 */
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {}); // 客户端随时可能取消，不能变成未捕获异常
  const url = new URL(req.url, 'http://mock');
  const p = url.pathname.replace(new RegExp(`^/v[0-9.]+`), '');
  const reject = (status, message) => {
    const body = Buffer.from(JSON.stringify({ message }));
    try {
      socket.write(`HTTP/1.1 ${status} ${status === 500 ? 'Internal Server Error' : status === 404 ? 'Not Found' : 'Bad Request'}\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
      socket.write(body);
    } catch (_) {}
    try { socket.end(); } catch (_) {}
  };
  const upgradeAndAttach = (c, tail, workdir) => {
    try {
      socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\n'
        + 'Connection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    } catch (_) { return; }
    attachPty(socket, c, { initial: tail.toString('utf8'), cwd: workdir });
  };

  const begin = (tail) => {
    let m = /^\/exec\/([^/]+)\/start$/.exec(p);
    if (m) {
      const ex = execs.get(m[1]);
      if (!ex) return reject(404, 'no such exec instance');
      const c = findContainer(ex.container);
      if (!c) return reject(404, 'no such container');
      if (!SHELL_BINS.has(ex.argv[0])) {
        return reject(500, `OCI runtime exec failed: exec failed: unable to start container process: `
          + `exec: "${ex.argv[0]}": stat ${ex.argv[0]}: no such file or directory: unknown`);
      }
      ex.started = true;
      ex.exitCode = 0;
      return upgradeAndAttach(c, tail, ex.workdir);
    }
    m = /^\/containers\/([^/]+)\/attach$/.exec(p);
    if (m) {
      const c = findContainer(m[1]);
      if (!c) return reject(404, 'no such container');
      return upgradeAndAttach(c, tail);
    }
    reject(400, `mock-engine: 未实现 upgrade ${p}`);
  };

  // 先把请求体读完再进交互模式，否则 {"Detach":false,"Tty":true} 会被当成键盘输入。
  // 注意：小请求体常常已经随响应头一起到了 head 里，必须一起算。
  const need = Number(req.headers['content-length'] || 0);
  let got = 0;
  let tailBuf = Buffer.alloc(0);
  const consume = (chunk) => {
    if (!chunk || !chunk.length) return;
    const take = Math.min(need - got, chunk.length);
    got += take;
    if (chunk.length > take) tailBuf = Buffer.concat([tailBuf, chunk.subarray(take)]);
  };
  consume(head);
  if (got >= need) return begin(tailBuf);
  const onData = (chunk) => {
    consume(chunk);
    if (got >= need) {
      socket.removeListener('data', onData);
      begin(tailBuf);
    }
  };
  socket.on('data', onData);
});

ensureFixtures();
loadModes();
initState();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-engine 就绪： http://127.0.0.1:${PORT}  （容器：${Array.from(state.values()).map((c) => c.name + (c.running ? '·running' : '·exited')).join(', ')}）`);
  console.log(`启动界面： node server.js --docker-host tcp://127.0.0.1:${PORT}`);
  console.log(`夹具目录： ${ROOT}`);
});



'use strict';
/** 通用工具：容器路径归一化、mime、权限、大小、二进制探测 */

const POSIX = require('path').posix;

/** 归一化容器内路径：必须绝对、拒绝 .. 段、合并多余斜杠 */
function normalizeContainerPath(input) {
  let p = String(input == null ? '' : input).trim();
  if (!p) p = '/';
  // 允许用户粘贴带引号的路径
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  if (!p.startsWith('/')) {
    const err = new Error('容器内路径必须是绝对路径（以 / 开头）');
    err.code = 'BAD_PATH';
    throw err;
  }
  const parts = p.split('/').filter((s) => s.length && s !== '.');
  for (const s of parts) {
    if (s === '..') {
      const err = new Error('路径中不允许包含 .. 段');
      err.code = 'BAD_PATH';
      throw err;
    }
  }
  return '/' + parts.join('/');
}

const dirname = (p) => {
  const n = normalizeContainerPath(p);
  if (n === '/') return '/';
  const d = POSIX.dirname(n);
  return d === '.' ? '/' : d;
};
const basename = (p) => {
  const n = normalizeContainerPath(p);
  return n === '/' ? '' : POSIX.basename(n);
};
const joinPath = (a, b) => normalizeContainerPath(POSIX.join(normalizeContainerPath(a), String(b || '')));

const MIME = {
  txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  conf: 'text/plain; charset=utf-8', cfg: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8', env: 'text/plain; charset=utf-8',
  sh: 'text/plain; charset=utf-8', bash: 'text/plain; charset=utf-8', py: 'text/plain; charset=utf-8',
  js: 'text/plain; charset=utf-8', mjs: 'text/plain; charset=utf-8', cjs: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8', xml: 'text/plain; charset=utf-8',
  toml: 'text/plain; charset=utf-8', sql: 'text/plain; charset=utf-8', go: 'text/plain; charset=utf-8',
  rs: 'text/plain; charset=utf-8', java: 'text/plain; charset=utf-8', css: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
  xz: 'application/x-xz', bz2: 'application/x-bzip2', zst: 'application/zstd', '7z': 'application/x-7z-compressed',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  pem: 'text/plain; charset=utf-8', crt: 'text/plain; charset=utf-8', key: 'text/plain; charset=utf-8',
  service: 'text/plain; charset=utf-8', properties: 'text/plain; charset=utf-8',
};

function extOf(name) {
  const b = String(name || '');
  const i = b.lastIndexOf('.');
  if (i <= 0 || i === b.length - 1) return '';
  return b.slice(i + 1).toLowerCase();
}

function guessMime(name) {
  const t = extOf(name);
  if (MIME[t]) return MIME[t];
  if (/^(dockerfile|makefile|readme|license|changelog)$/i.test(String(name || ''))) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function isTextMime(name) {
  return guessMime(name).startsWith('text/') || /json|xml|javascript|svg/.test(guessMime(name));
}

/** Docker 返回的 Go FileMode（uint32）：高位是类型位 */
const MODE_DIR = 0x80000000;      // 1 << 31
const MODE_SYMLINK = 0x08000000;  // 1 << 27
const MODE_CHAR = 0x04000000;     // 1 << 26
const MODE_BLOCK = 0x02000000;    // 1 << 25
const MODE_FIFO = 0x01000000;     // 1 << 24
const MODE_REG = 0;

function modeType(mode) {
  const m = Number(mode) || 0;
  if (m & MODE_DIR) return 'dir';
  if (m & MODE_SYMLINK) return 'symlink';
  if (m & MODE_CHAR) return 'char';
  if (m & MODE_BLOCK) return 'block';
  if (m & MODE_FIFO) return 'fifo';
  return 'file';
}

/** 0o755 → drwxr-xr-x */
function modeToRwx(mode, type) {
  const m = Number(mode) & 0o7777;
  const t = type || modeType(mode);
  const head = t === 'dir' ? 'd' : t === 'symlink' ? 'l' : t === 'char' ? 'c' : t === 'block' ? 'b' : t === 'fifo' ? 'p' : '-';
  const bits = ['r', 'w', 'x'];
  let out = head;
  for (let i = 2; i >= 0; i--) {
    const shift = i * 3;
    out += (m >> (shift + 2)) & 1 ? 'r' : '-';
    out += (m >> (shift + 1)) & 1 ? 'w' : '-';
    out += (m >> shift) & 1 ? 'x' : '-';
  }
  return out;
}

function humanSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) + ' ' + units[i];
}

/** 前 8KB 出现 NUL 视为二进制 */
function looksBinary(buf) {
  const end = Math.min(buf.length, 8192);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

/** RFC 5987 附件头：中文文件名安全 */
function contentDisposition(filename, inline) {
  const name = String(filename || 'download');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const enc = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${enc}`;
}

/** wsl.exe 的输出可能是 UTF-16LE（带 BOM） */
function decodeWsl(buf) {
  if (typeof buf === 'string') return buf.replace(/\0/g, '');
  if (!buf || !buf.length) return '';
  let utf16 = 0;
  const n = Math.min(buf.length, 512);
  for (let i = 1; i < n; i += 2) if (buf[i] === 0) utf16++;
  const text = utf16 > n / 8 ? buf.toString('utf16le') : buf.toString('utf8');
  return text.replace(/^\uFEFF/, '').replace(/\0/g, '');
}

function formatTime(sec) {
  const n = Number(sec) || 0;
  if (!n) return '—';
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  normalizeContainerPath, dirname, basename, joinPath,
  guessMime, isTextMime, extOf,
  modeType, modeToRwx, humanSize, looksBinary, contentDisposition,
  decodeWsl, formatTime, sleep,
  MODE_DIR, MODE_SYMLINK,
};

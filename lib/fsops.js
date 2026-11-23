'use strict';
/** 语义层：把 Docker archive/exec 组合成文件管理器需要的操作 */

const { PassThrough } = require('stream');
const {
  normalizeContainerPath, dirname, basename, joinPath, modeType, looksBinary,
} = require('./util');
const { listEntries, readFirstEntry, extractEntry, TarWriter, buildTarBuffer, paxRecord, padOf } = require('./tar');
const { DockerError } = require('./docker');

const MAX_LIST_ENTRIES = 5000;
const MAX_LIST_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

class FsError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'FsError';
    this.code = code;
    this.hint = hint || '';
  }
}

function notFound(p) {
  return new FsError('NOT_FOUND', `容器内不存在：${p}`, '检查路径拼写，或刷新后重试');
}

function entryTypeFromTar(h) {
  switch (h.typeflag) {
    case '5': return 'dir';
    case '2': return 'symlink';
    case '1': return 'link';
    default: return 'file';
  }
}

/** 逐级解析符号链接（最多 5 跳） */
async function resolveRealPath(client, id, p, hops = 0) {
  const st = await client.archiveHead(id, p);
  if (!st) throw notFound(p);
  if (modeType(st.mode) !== 'symlink') return { path: p, stat: st };
  if (hops >= 5) return { path: p, stat: st, loop: true };
  let target = String(st.linkTarget || '');
  if (!target) return { path: p, stat: st };
  const next = target.startsWith('/') ? normalizeContainerPath(target) : normalizeContainerPath(joinPath(dirname(p), target));
  return resolveRealPath(client, id, next, hops + 1);
}

async function statPath(client, id, rawPath) {
  const p = normalizeContainerPath(rawPath);
  const st = await client.archiveHead(id, p);
  if (!st) throw notFound(p);
  const type = modeType(st.mode);
  return {
    path: p,
    name: st.name || basename(p) || '/',
    size: Number(st.size) || 0,
    mode: Number(st.mode) || 0,
    perms: Number(st.mode) & 0o7777,
    mtime: Number(st.mtime) || 0,
    linkTarget: st.linkTarget || '',
    type,
  };
}

function stripPrefix(entries, base) {
  const out = [];
  for (const h of entries) {
    let rel = h.name;
    // 归一：去掉 "./"、"../" 与开头的 "/"（根目录打包时条目是 /bin/ 这种绝对名）
    rel = rel.replace(/^\.\//, '').replace(/^\/+/, '');
    if (!rel || rel === '.' || rel === '/') continue;
    if (base) {
      if (rel === base || rel === base + '/') continue;
      if (rel.startsWith(base + '/')) rel = rel.slice(base.length + 1);
      else continue; // 不属于这个目录
    }
    rel = rel.replace(/\/+$/, '');
    if (!rel) continue;
    if (rel.includes('/')) continue; // 只要直接子项
    const type = entryTypeFromTar(h);
    out.push({
      name: rel,
      type,
      size: type === 'dir' ? 0 : Number(h.size) || 0,
      mode: Number(h.mode) & 0o7777,
      mtime: Number(h.mtime) || 0,
      linkTarget: h.linkname || '',
    });
  }
  return out;
}

function sortEntries(list) {
  return list.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (b.type === 'dir' && a.type !== 'dir') return 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  });
}

/** 容器内 exec 列举出的条目类型（%F 的描述词可能是英文或本地化） */
function mapStatType(desc) {
  const d = String(desc || '').toLowerCase();
  if (d.includes('dir')) return 'dir';
  if (d.includes('link')) return 'symlink';
  if (d.includes('fifo') || d.includes('pipe')) return 'fifo';
  if (d.includes('socket')) return 'socket';
  if (d.includes('character') || d.includes('char ')) return 'char';
  if (d.includes('block')) return 'block';
  return 'file';
}

/** 解析 `stat -c '%F|%a|%s|%Y|%N'` 的输出 */
function parseStatLines(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const [ftype, perm, size, mtime] = parts;
    let rest = parts.slice(4).join('|').trim();
    let linkTarget = '';
    const arrow = rest.indexOf(' -> ');
    if (arrow !== -1) {
      linkTarget = rest.slice(arrow + 4).trim();
      rest = rest.slice(0, arrow).trim();
    }
    const unq = (s) => {
      const t = String(s).trim();
      if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
      return t;
    };
    const name = unq(rest);
    if (!name || name === '.' || name === '..') continue;
    const type = mapStatType(ftype);
    out.push({
      name,
      type,
      size: type === 'dir' ? 0 : Number(size) || 0,
      mode: parseInt(String(perm).replace(/[^0-7]/g, ''), 8) || 0,
      mtime: Number(mtime) || 0,
      linkTarget: unq(linkTarget),
    });
  }
  return out;
}

const NO_EXEC_TTL = 120 * 1000;
const noExecCache = new Map(); // containerId -> timestamp

function markNoExec(id) { noExecCache.set(id, Date.now()); }
function canTryExec(id) {
  const at = noExecCache.get(id);
  return !at || Date.now() - at > NO_EXEC_TTL;
}

/** exec 快速列举：运行中的容器走这条（archive 会把整棵子树打包，root 目录能有几百 MB） */
async function listViaExec(client, id, p) {
  const script = `cd "$1" 2>/dev/null || exit 4
exec stat -c '%F|%a|%s|%Y|%N' -- * .[!.]* ..?* 2>/dev/null`;
  const r = await client.exec(id, ['sh', '-c', script, 'sh', p], { timeout: 25000 });
  if (r.code === 4) {
    // 不是目录 / 不存在 / 没权限
    const st = await client.archiveHead(id, p).catch(() => null);
    if (!st) throw notFound(p);
    if (modeType(st.mode) !== 'dir') {
      const type = modeType(st.mode);
      return {
        path: p, parent: dirname(p), kind: 'file',
        stat: { path: p, name: st.name || basename(p), size: Number(st.size) || 0, mode: Number(st.mode) || 0, perms: Number(st.mode) & 0o7777, mtime: Number(st.mtime) || 0, linkTarget: st.linkTarget || '', type },
        entries: [], truncated: false,
      };
    }
    throw new FsError('NOT_DIR', `无法列出目录：${p}`, (r.stderr || '').trim());
  }
  if (r.code === 127 || /not found/i.test(r.stderr || '')) {
    throw new FsError('NO_EXEC_TOOLS', '容器内没有 sh / stat');
  }
  const entries = sortEntries(parseStatLines(r.stdout));
  return { path: p, parent: dirname(p), kind: 'dir', stat: null, entries, truncated: false, via: 'exec' };
}

async function listDir(client, id, rawPath) {
  const p = normalizeContainerPath(rawPath);
  // 1) 运行中的容器：优先 exec（快、流量小）
  if (canTryExec(id)) {
    try {
      return await listViaExec(client, id, p);
    } catch (e) {
      const f = e instanceof FsError ? e.code : '';
      if (f === 'NOT_DIR' || f === 'NOT_FOUND') throw e;
      if (f === 'NO_EXEC_TOOLS' || (e && (e.code === 'NEEDS_RUNNING' || e.code === 'CONFLICT' || e.status === 409))) {
        markNoExec(id);
      }
      // 其它错误（无 sh、无 stat、引擎拒绝）→ 回退 archive
    }
  }
  // 2) archive 回退（已停止容器、distroless 镜像）
  const stat = await statPath(client, id, p);
  if (stat.type === 'file' || stat.type === 'link') {
    return { path: p, parent: dirname(p), kind: 'file', stat, entries: [], truncated: false };
  }
  let usePath = p;
  if (stat.type === 'symlink') {
    const real = await resolveRealPath(client, id, p);
    if (real.loop) throw new FsError('LOOP', `符号链接循环：${p}`);
    usePath = real.path;
  }
  const stream = await client.archiveGet(id, usePath);
  // 已停止容器没有 exec 可用：archive 会把整棵子树打包，加时间上限避免卡死
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { stream.destroy(); } catch (_) {} }, 12000);
  let parsed;
  try {
    parsed = await listEntries(stream, { maxEntries: MAX_LIST_ENTRIES, maxBytes: MAX_LIST_BYTES });
  } finally {
    clearTimeout(timer);
  }
  const { entries } = parsed;
  const truncated = parsed.truncated || timedOut;
  const base = usePath === '/' ? '' : basename(usePath);
  const list = sortEntries(stripPrefix(entries, base));
  return {
    path: p, parent: dirname(p), kind: 'dir', stat, entries: list, truncated, via: 'archive',
    hint: timedOut ? '容器未运行，只能通过归档接口列举；启动容器后可以秒开' : '',
  };
}

async function readText(client, id, rawPath, { maxBytes = MAX_TEXT_BYTES } = {}) {
  const p = normalizeContainerPath(rawPath);
  let stat = await statPath(client, id, p);
  let readPath = p;
  if (stat.type === 'symlink') {
    const real = await resolveRealPath(client, id, p);
    if (real.loop) throw new FsError('LOOP', `符号链接循环：${p}`);
    readPath = real.path;
    stat = await statPath(client, id, readPath);
  }
  if (stat.type === 'dir') throw new FsError('IS_DIR', `${p} 是目录，不能按文本打开`);
  if (stat.size > maxBytes) {
    return { path: p, size: stat.size, truncated: true, binary: false, content: '', mode: stat.perms, mtime: stat.mtime };
  }
  const stream = await client.archiveGet(id, readPath);
  const { buffer, header } = await readFirstEntry(stream, { maxBytes: maxBytes + 64 * 1024 });
  const binary = looksBinary(buffer);
  return {
    path: p,
    size: stat.size || (header ? header.size : buffer.length),
    truncated: false,
    binary,
    content: binary ? '' : buffer.toString('utf8'),
    mode: stat.perms,
    mtime: stat.mtime,
  };
}

async function readBytes(client, id, rawPath, { maxBytes = 128 * 1024 * 1024 } = {}) {
  const p = normalizeContainerPath(rawPath);
  let stat = await statPath(client, id, p);
  let readPath = p;
  if (stat.type === 'symlink') {
    const real = await resolveRealPath(client, id, p);
    readPath = real.path;
    stat = await statPath(client, id, readPath);
  }
  if (stat.type === 'dir') throw new FsError('IS_DIR', `${p} 是目录`);
  if (stat.size > maxBytes) throw new FsError('TOO_LARGE', `文件过大（${stat.size} 字节），请用下载`, '使用下载按钮获取原文件');
  const stream = await client.archiveGet(id, readPath);
  const { buffer } = await readFirstEntry(stream, { maxBytes: maxBytes + 64 * 1024 });
  return { buffer, stat };
}

/** 单文件流式下载：把 tar 里的条目数据直接 pipe 到 res */
async function downloadFile(client, id, rawPath, res, { name } = {}) {
  const p = normalizeContainerPath(rawPath);
  let stat = await statPath(client, id, p);
  let readPath = p;
  if (stat.type === 'symlink') {
    const real = await resolveRealPath(client, id, p);
    if (!real.loop) { readPath = real.path; stat = await statPath(client, id, readPath); }
  }
  if (stat.type === 'dir') throw new FsError('IS_DIR', `${p} 是目录，请用目录打包下载`);
  const stream = await client.archiveGet(id, readPath);
  // 客户端中断（浏览器取消下载）时必须销毁引擎侧流，否则 socket 会一直挂着
  const onClose = () => { try { stream.destroy(); } catch (_) {} };
  res.on('close', onClose);
  const targetName = basename(readPath);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  if (name) res.setHeader('X-Dockfile-Filename', encodeURIComponent(name));
  try {
    await pipeEntry(stream, targetName, res);
    // 必须显式 end：否则 keep-alive 连接上这条响应永远不算完成，
    // 浏览器复用该连接的下一个请求会一直挂住（表现为页面卡死）
    if (!res.writableEnded) res.end();
  } catch (e) {
    try { if (!res.writableEnded) res.destroy(); } catch (_) {}
    throw e;
  } finally {
    res.off('close', onClose);
  }
  return stat;
}

function pipeEntry(stream, entryName, res) {
  return new Promise((resolve, reject) => {
    extractEntry(stream, entryName, res, { maxBytes: 0 })
      .then(resolve)
      .catch((e) => {
        try { res.destroy(); } catch (_) {}
        reject(e);
      });
  });
}

/** 目录打包下载（tar 或 tar.gz） */
async function downloadDir(client, id, rawPath, res, { gzip = false, name } = {}) {
  const zlib = require('zlib');
  const p = normalizeContainerPath(rawPath);
  const stat = await statPath(client, id, p);
  if (stat.type !== 'dir') throw new FsError('NOT_DIR', `${p} 不是目录`);
  const stream = await client.archiveGet(id, p);
  const onClose = () => { try { stream.destroy(); } catch (_) {} };
  res.on('close', onClose);
  const fname = `${name || basename(p) || 'root'}.tar${gzip ? '.gz' : ''}`;
  res.setHeader('Content-Type', gzip ? 'application/gzip' : 'application/x-tar');
  res.setHeader('Content-Disposition', require('./util').contentDisposition(fname));
  try {
    if (gzip) {
      const gz = zlib.createGzip({ level: 6 });
      stream.pipe(gz).pipe(res);
      await new Promise((resolve) => { res.on('finish', resolve); res.on('close', resolve); });
    } else {
      stream.pipe(res);
      await new Promise((resolve) => { res.on('finish', resolve); res.on('close', resolve); });
    }
  } finally {
    res.off('close', onClose);
  }
  return stat;
}

// ---------- 写 ----------

function needsPax(name) {
  return Buffer.byteLength(name, 'utf8') > 100 || /[^\x00-\x7f]/.test(name);
}

function tarLengthFor(name, size) {
  let len = 512 + size + padOf(size) + 1024;
  if (needsPax(name)) {
    const rec = paxRecord('path', name).length;
    len += 512 + rec + padOf(rec);
  }
  return len;
}

async function writeEntries(client, id, dirPath, items) {
  const buf = await buildTarBuffer(items);
  await client.archivePut(id, normalizeContainerPath(dirPath), buf, { length: buf.length });
  return items.length;
}

/** mkdir -p：父目录不存在时逐级创建（archive PUT 对已停止容器同样有效） */
async function ensureDir(client, id, dirPath) {
  let p;
  try { p = normalizeContainerPath(dirPath); } catch (_) { return; }
  if (p === '/') return;
  const st = await client.archiveHead(id, p).catch(() => null);
  if (st) return;
  await ensureDir(client, id, dirname(p));
  await writeEntries(client, id, dirname(p), [{ dir: true, name: basename(p) + '/', mode: 0o755 }]);
}

async function writeText(client, id, rawPath, content, { mode = 0o644, mtime } = {}) {
  const p = normalizeContainerPath(rawPath);
  const name = basename(p);
  if (!name) throw new FsError('BAD_PATH', '不能写入根目录');
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  await ensureDir(client, id, dirname(p));
  await writeEntries(client, id, dirname(p), [{ name, data, mode, mtime }]);
  return { path: p, size: data.length };
}

async function makeDir(client, id, rawPath, { mode = 0o755 } = {}) {
  const p = normalizeContainerPath(rawPath);
  const name = basename(p);
  if (!name) throw new FsError('BAD_PATH', '不能创建根目录');
  await ensureDir(client, id, dirname(p));
  await writeEntries(client, id, dirname(p), [{ dir: true, name: name + '/', mode }]);
  return { path: p };
}

async function upload(client, id, dirPath, name, stream, size, { mode = 0o644, mtime } = {}) {
  const dir = normalizeContainerPath(dirPath);
  const safeName = String(name || '').replace(/^\/+/, '');
  if (!safeName) throw new FsError('BAD_PATH', '上传缺少文件名');
  if (safeName.split('/').some((s) => s === '..')) throw new FsError('BAD_PATH', '文件名中不允许 ..');
  await ensureDir(client, id, dir);
  const total = tarLengthFor(safeName, size);
  const pass = new PassThrough({ highWaterMark: 1 << 20 });
  const writer = new TarWriter(pass);
  const done = (async () => {
    try {
      await writer.addStream(safeName, stream, size, { mode, mtime });
      await writer.end();
      pass.end();
    } catch (e) {
      pass.destroy(e);
    }
  })();
  try {
    await client.archivePut(id, dir, pass, { length: total, timeout: 30 * 60 * 1000 });
  } finally {
    try { pass.destroy(); } catch (_) {}
    await done.catch(() => {});
  }
  return { path: joinPath(dir, safeName), size };
}

async function ensureRunning(client, id) {
  const info = await client.inspect(id);
  const running = info && info.State && info.State.Running;
  if (!running) {
    throw new FsError(
      'NEEDS_RUNNING',
      '容器未运行，这个操作需要在运行中的容器内执行命令',
      '点击顶栏「启动容器」后再试（读取和上传不需要启动）',
    );
  }
  return info;
}

async function shellExec(client, id, argv, { timeout = 60000 } = {}) {
  await ensureRunning(client, id);
  const r = await client.exec(id, argv, { timeout });
  return r;
}

async function remove(client, id, paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).map((p) => normalizeContainerPath(p)).filter((p) => p !== '/');
  if (!list.length) throw new FsError('BAD_PATH', '不能删除根目录');
  const r = await shellExec(client, id, ['rm', '-rf', '--', ...list], { timeout: 120000 });
  if (r.code !== 0) {
    throw new FsError('EXEC_FAILED', `删除失败（exit ${r.code}）`, (r.stderr || r.stdout || '该镜像可能不包含 rm 命令').trim());
  }
  return { deleted: list };
}

async function rename(client, id, from, to) {
  const a = normalizeContainerPath(from);
  const b = normalizeContainerPath(to);
  const r = await shellExec(client, id, ['mv', '--', a, b], { timeout: 60000 });
  if (r.code !== 0) {
    throw new FsError('EXEC_FAILED', `重命名失败（exit ${r.code}）`, (r.stderr || r.stdout || '该镜像可能不包含 mv 命令').trim());
  }
  return { from: a, to: b };
}

async function chmod(client, id, p, mode) {
  const target = normalizeContainerPath(p);
  const octal = String(mode).replace(/[^0-7]/g, '');
  if (!octal) throw new FsError('BAD_MODE', '权限必须是八进制数字，例如 644');
  const r = await shellExec(client, id, ['chmod', octal, target], { timeout: 30000 });
  if (r.code !== 0) {
    throw new FsError('EXEC_FAILED', `修改权限失败（exit ${r.code}）`, (r.stderr || r.stdout || '该镜像可能不包含 chmod 命令').trim());
  }
  return { path: target, mode: parseInt(octal, 8) };
}

module.exports = {
  FsError, statPath, listDir, readText, readBytes, downloadFile, downloadDir,
  writeText, makeDir, upload, remove, rename, chmod, ensureRunning, resolveRealPath,
  MAX_TEXT_BYTES, MAX_LIST_ENTRIES,
};

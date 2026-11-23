'use strict';
/**
 * 零依赖 tar（ustar / GNU longname / PAX）读写。
 * 只实现 Docker archive API 需要的能力：列目录、提取单条目、流式打包。
 */
const { Writable } = require('stream');

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);

const TYPE_MAP = {
  0: 'file', // '\0'
  48: 'file', // '0'
  55: 'file', // '7'
  49: 'link', // '1'
  50: 'symlink', // '2'
  51: 'char', // '3'
  52: 'block', // '4'
  53: 'dir', // '5'
  54: 'fifo', // '6'
  83: 'file', // 'S'
};

function str(buf, off, len) {
  const end = buf.indexOf(0, off);
  const stop = end === -1 || end > off + len ? off + len : end;
  return buf.toString('utf8', off, stop);
}

function octalOrBase256(buf, off, len) {
  if (buf[off] & 0x80) {
    let val = 0;
    for (let i = off + 1; i < off + len; i++) val = val * 256 + buf[i];
    return val;
  }
  const s = buf.toString('ascii', off, off + len).replace(/\0/g, '').trim();
  if (!s) return 0;
  const v = parseInt(s, 8);
  return Number.isFinite(v) ? v : 0;
}

function parsePax(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    const sp = buf.indexOf(0x20, pos);
    if (sp === -1) break;
    const len = parseInt(buf.toString('ascii', pos, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const recEnd = Math.min(pos + len, buf.length);
    const rec = buf.toString('utf8', sp + 1, recEnd).replace(/\n$/, '');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    pos = recEnd;
  }
  return out;
}

function parseHeader(buf) {
  if (buf.length < BLOCK) return null;
  const name = str(buf, 0, 100);
  const prefix = str(buf, 345, 155);
  if (!name && !prefix) return null; // 结束块
  const fullName = prefix ? `${prefix}/${name}` : name;
  const typeflag = buf[156] || 0;
  const mode = octalOrBase256(buf, 100, 8);
  const size = octalOrBase256(buf, 124, 12);
  const mtime = octalOrBase256(buf, 136, 12);
  const uid = octalOrBase256(buf, 108, 8);
  const gid = octalOrBase256(buf, 116, 8);
  const linkname = str(buf, 157, 100);
  return {
    name: fullName,
    typeflag: String.fromCharCode(typeflag),
    type: TYPE_MAP[typeflag] || 'file',
    mode, size, mtime, uid, gid, linkname,
  };
}

const padOf = (size) => (BLOCK - (size % BLOCK)) % BLOCK;

/**
 * 流式 tar 解析器。
 * 事件：onEntry(header) / onData(Buffer) / 'done'({truncated})
 * opts.onlyEntry：只回吐该条目的数据（其余丢弃）。
 */
class TarParser extends Writable {
  constructor(opts = {}) {
    super();
    this.onEntry = opts.onEntry || null;
    this.onData = opts.onData || null;
    this.maxBytes = opts.maxBytes || 0;
    this.onlyEntry = opts.onlyEntry || null;

    this.state = 'header';
    this.hdr = Buffer.alloc(0);
    this.remaining = 0;
    this.padRemaining = 0;
    this.entrySize = 0;
    this.emitData = false;

    this.metaKind = null;
    this.metaBuf = Buffer.alloc(0);
    this.pendingLongName = null;
    this.pendingPax = null;

    this.bytes = 0;
    this.truncated = false;
    this.stopped = false;
    this.doneEmitted = false;
  }

  _finish(truncated) {
    if (this.doneEmitted) return;
    this.doneEmitted = true;
    if (truncated) this.truncated = true;
    this.emit('done', { truncated: this.truncated });
  }

  stop(truncated) {
    this.stopped = true;
    this._finish(truncated);
  }

  _write(chunk, _enc, cb) {
    if (this.stopped) return cb();
    this.bytes += chunk.length;
    if (this.maxBytes && this.bytes > this.maxBytes) {
      this.stop(true);
      return cb();
    }
    try {
      this._process(chunk);
    } catch (e) {
      return cb(e);
    }
    return cb();
  }

  _process(chunk) {
    let off = 0;
    while (off < chunk.length && !this.stopped) {
      if (this.state === 'header') {
        const need = BLOCK - this.hdr.length;
        const take = Math.min(need, chunk.length - off);
        this.hdr = Buffer.concat([this.hdr, chunk.subarray(off, off + take)]);
        off += take;
        if (this.hdr.length === BLOCK) {
          const raw = this.hdr;
          this.hdr = Buffer.alloc(0);
          this._header(raw);
        }
      } else if (this.state === 'data') {
        const take = Math.min(this.remaining, chunk.length - off);
        const piece = chunk.subarray(off, off + take);
        off += take;
        this.remaining -= take;
        if (this.emitData && this.onData) this.onData(piece);
        if (this.remaining === 0) {
          this.padRemaining = padOf(this.entrySize);
          this.state = this.padRemaining ? 'pad' : 'header';
        }
      } else if (this.state === 'meta') {
        const take = Math.min(this.remaining, chunk.length - off);
        this.metaBuf = Buffer.concat([this.metaBuf, chunk.subarray(off, off + take)]);
        off += take;
        this.remaining -= take;
        if (this.remaining === 0) {
          this._finishMeta();
          this.padRemaining = padOf(this.entrySize);
          this.state = this.padRemaining ? 'pad' : 'header';
        }
      } else { // pad
        const take = Math.min(this.padRemaining, chunk.length - off);
        off += take;
        this.padRemaining -= take;
        if (this.padRemaining === 0) this.state = 'header';
      }
    }
  }

  _header(raw) {
    const h = parseHeader(raw);
    if (!h) {
      this.stop(false);
      return;
    }
    if (h.typeflag === 'L' || h.typeflag === 'K' || h.typeflag === 'x' || h.typeflag === 'g') {
      this.metaKind = h.typeflag === 'L' ? 'longname' : h.typeflag === 'K' ? 'longlink' : 'pax';
      this.entrySize = h.size;
      this.remaining = h.size;
      this.metaBuf = Buffer.alloc(0);
      if (h.size === 0) {
        this._finishMeta();
        this.state = 'header';
      } else {
        this.state = 'meta';
      }
      return;
    }
    if (this.pendingLongName) { h.name = this.pendingLongName; this.pendingLongName = null; }
    if (this.pendingPax) {
      if (this.pendingPax.path) h.name = this.pendingPax.path;
      if (this.pendingPax.linkpath) h.linkname = this.pendingPax.linkpath;
      if (this.pendingPax.size) h.size = Number(this.pendingPax.size) || h.size;
      this.pendingPax = null;
    }
    h.name = h.name.replace(/^\.\//, '');

    this.entrySize = h.size;
    const wanted = !this.onlyEntry || h.name === this.onlyEntry;
    if (wanted && this.onEntry) this.onEntry(h);

    if (h.type === 'file' && h.size > 0) {
      this.emitData = wanted;
      this.remaining = h.size;
      this.state = 'data';
    } else {
      this.emitData = false;
      if (!this.onlyEntry && h.size > 0) {
        // 非常规条目（极少见）：数据仍需跳过
        this.emitData = false;
        this.remaining = h.size;
        this.state = 'data';
        return;
      }
      this.padRemaining = padOf(h.size);
      this.state = this.padRemaining ? 'pad' : 'header';
      if (this.onlyEntry && wanted && h.type !== 'file') this.stop(false);
    }
  }

  _finishMeta() {
    if (this.metaKind === 'longname') this.pendingLongName = this.metaBuf.toString('utf8').replace(/\0+$/, '');
    else if (this.metaKind === 'longlink') this.pendingLongLink = this.metaBuf.toString('utf8');
    else if (this.metaKind === 'pax') this.pendingPax = { ...(this.pendingPax || {}), ...parsePax(this.metaBuf) };
    this.metaBuf = Buffer.alloc(0);
    this.metaKind = null;
  }
}

/** 列目录：只收头，跳过数据 */
function listEntries(stream, { maxBytes = 64 * 1024 * 1024, maxEntries = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const entries = [];
    let truncated = false;
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      try { stream.unpipe(parser); } catch (_) {}
      try { if (!parser.destroyed) parser.destroy(); } catch (_) {}
      if (err) reject(err);
      else resolve({ entries, truncated });
    };
    const parser = new TarParser({
      maxBytes,
      onEntry: (h) => {
        if (entries.length >= maxEntries) { truncated = true; parser.stop(true); return; }
        entries.push(h);
      },
    });
    parser.on('done', (info) => { if (info && info.truncated) truncated = true; settle(null); });
    parser.on('error', settle);
    stream.on('error', settle);
    stream.on('close', () => settle(null));
    stream.pipe(parser);
  });
}

/** 提取指定条目：数据写给 sink（Writable 或 (buf)=>boolean） */
function extractEntry(stream, targetName, sink, { maxBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let header = null;
    let written = 0;
    const done = (err) => {
      if (settled) return;
      settled = true;
      try { stream.unpipe(parser); } catch (_) {}
      try { if (!parser.destroyed) parser.destroy(); } catch (_) {}
      if (err) reject(err);
      else resolve({ header, bytes: written });
    };
    const parser = new TarParser({
      onlyEntry: targetName,
      maxBytes,
      onEntry: (h) => { header = h; },
      onData: (buf) => {
        if (!header || header.name !== targetName) return;
        if (written >= header.size) return;
        written += buf.length;
        const ok = typeof sink === 'function' ? sink(buf) : sink.write(buf);
        if (ok === false && typeof stream.pause === 'function') {
          stream.pause();
          const resume = () => stream.resume();
          if (typeof sink.once === 'function') sink.once('drain', resume);
          else setTimeout(resume, 10);
        }
      },
    });
    parser.__realOnData = parser.onData;
    parser.on('done', () => done(null));
    parser.on('finish', () => done(null));
    parser.on('error', done);
    stream.on('error', done);
    stream.pipe(parser);
  });
}

/** 读取第一个条目（普通文件）为 Buffer，用于文本/预览 */
function readFirstEntry(stream, { maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let header = null;
    let got = 0;
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      try { stream.unpipe(parser); } catch (_) {}
      try { if (!parser.destroyed) parser.destroy(); } catch (_) {}
      try { stream.destroy(); } catch (_) {}
      if (err) return reject(err);
      resolve({ header, buffer: Buffer.concat(chunks) });
    };
    const parser = new TarParser({
      maxBytes,
      onEntry: (h) => { if (!header && (h.type === 'file' || h.size > 0)) header = h; },
      onData: (buf) => {
        if (!header || got >= header.size) return;
        const take = buf.subarray(0, header.size - got);
        chunks.push(Buffer.from(take));
        got += take.length;
      },
    });
    parser.on('done', () => done(null));
    parser.on('finish', () => done(null));
    parser.on('error', done);
    stream.on('error', done);
    stream.pipe(parser);
  });
}

// ---------------- 写 ----------------

function octalField(val, width) {
  const v = Math.max(0, Math.floor(Number(val) || 0));
  const s = v.toString(8);
  if (s.length > width - 1) {
    const b = Buffer.alloc(width);
    let x = v;
    for (let i = width - 1; i >= 1; i--) { b[i] = x & 0xff; x = Math.floor(x / 256); }
    b[0] = 0x80;
    return b;
  }
  return Buffer.from(s.padStart(width - 1, '0') + '\0', 'ascii');
}

function buildHeader({ name, size = 0, mode = 0o644, mtime = Math.floor(Date.now() / 1000), type = '0', linkname = '', uid = 0, gid = 0 }) {
  const b = Buffer.alloc(BLOCK, 0);
  Buffer.from(name, 'utf8').subarray(0, 100).copy(b, 0);
  octalField(mode & 0o7777, 8).copy(b, 100);
  octalField(uid, 8).copy(b, 108);
  octalField(gid, 8).copy(b, 116);
  octalField(size, 12).copy(b, 124);
  octalField(mtime, 12).copy(b, 136);
  b.fill(0x20, 148, 156);
  b.write(type, 156, 'ascii');
  Buffer.from(linkname, 'utf8').subarray(0, 100).copy(b, 157);
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  b[154] = 0;
  b[155] = 0x20;
  return b;
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  for (;;) {
    const candidate = String(len) + body;
    const l = Buffer.byteLength(candidate);
    if (l === len) return Buffer.from(candidate, 'utf8');
    len = l;
  }
}

class TarWriter {
  constructor(out) { this.out = out; this.entries = 0; this.ended = false; }

  _write(chunk) {
    if (!chunk || !chunk.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ok = this.out.write(chunk, (err) => (err ? reject(err) : null));
      if (ok) resolve();
      else this.out.once('drain', resolve);
    });
  }

  async _header(name, size, opts) {
    const needsPax = Buffer.byteLength(name, 'utf8') > 100 || /[^\x00-\x7f]/.test(name);
    if (needsPax) {
      const rec = paxRecord('path', name);
      await this._write(buildHeader({ name: '././@PaxHeader', size: rec.length, mode: 0o644, type: 'x' }));
      await this._write(rec);
      const pad = padOf(rec.length);
      if (pad) await this._write(Buffer.alloc(pad));
    }
    const shortName = needsPax ? Buffer.from(name, 'utf8').subarray(0, 100).toString('utf8') : name;
    await this._write(buildHeader({ ...opts, name: shortName, size }));
  }

  async addBuffer(name, buffer, { mode = 0o644, mtime, type = '0', linkname = '' } = {}) {
    const size = buffer ? buffer.length : 0;
    await this._header(name, size, { mode, mtime, type, linkname });
    if (size) await this._write(buffer);
    const pad = padOf(size);
    if (pad) await this._write(Buffer.alloc(pad));
    this.entries++;
  }

  async addStream(name, stream, size, { mode = 0o644, mtime, type = '0' } = {}) {
    await this._header(name, size, { mode, mtime, type });
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.length;
      await this._write(chunk);
    }
    if (total < size) await this._write(Buffer.alloc(size - total));
    const pad = padOf(size);
    if (pad) await this._write(Buffer.alloc(pad));
    this.entries++;
    return total;
  }

  async end() {
    if (this.ended) return;
    this.ended = true;
    await this._write(Buffer.alloc(BLOCK * 2));
  }
}

async function buildTarBuffer(items) {
  const { PassThrough } = require('stream');
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  const w = new TarWriter(out);
  for (const it of items) {
    if (it.dir) await w.addBuffer(it.name.replace(/\/?$/, '/'), Buffer.alloc(0), { mode: it.mode || 0o755, type: '5' });
    else await w.addBuffer(it.name, it.data || Buffer.alloc(0), { mode: it.mode || 0o644, type: it.type || '0', linkname: it.linkname || '' });
  }
  await w.end();
  await new Promise((r) => out.end(r));
  return Buffer.concat(chunks);
}

module.exports = {
  BLOCK, ZERO_BLOCK, TarParser, TarWriter, buildTarBuffer, buildHeader,
  listEntries, extractEntry, readFirstEntry, paxRecord, padOf, parseHeader,
};

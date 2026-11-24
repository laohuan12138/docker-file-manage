'use strict';
/**
 * 传输层：把「对 Docker Engine 发 HTTP 请求」抽象成统一接口。
 *   HttpTransport  —— unix socket / Windows npipe / TCP(TLS)
 *   StdioTransport —— wsl.exe "docker system dial-stdio"，自带最小 HTTP/1.1 客户端
 */
const http = require('http');
const https = require('https');
const { PassThrough, Readable } = require('stream');
const { spawn } = require('child_process');

class TransportError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'TransportError';
    this.code = code || 'TRANSPORT';
    if (cause) this.cause = cause;
  }
}

/** HTTP over socket/npipe/tcp */
class HttpTransport {
  constructor(target, opts = {}) {
    this.target = target; // {socketPath} | {host, port, protocol}
    this.kind = target.socketPath ? (opts.kind || 'socket') : 'tcp';
    this.agent = (target.protocol === 'https:' ? https : http).Agent({
      keepAlive: true,
      maxSockets: 16,
    });
    this.timeout = opts.timeout || 120000;
    this.label = opts.label || (target.socketPath || `${target.host}:${target.port}`);
  }

  request({ method = 'GET', path = '/', headers = {}, body = null, timeout = this.timeout } = {}) {
    return new Promise((resolve, reject) => {
      const lib = this.target.protocol === 'https:' ? https : http;
      const opts = {
        method,
        path,
        headers,
        agent: this.agent,
        timeout,
      };
      if (this.target.socketPath) opts.socketPath = this.target.socketPath;
      else { opts.host = this.target.host; opts.port = this.target.port; }

      const req = lib.request(opts, (res) => {
        resolve({ status: res.statusCode, headers: res.headers, stream: res });
      });
      req.on('timeout', () => req.destroy(new TransportError('请求 Docker 引擎超时', 'ETIMEDOUT')));
      req.on('error', (e) => {
        const code = e.code === 'ENOENT' ? 'ENOENT' : e.code === 'ECONNREFUSED' ? 'ECONNREFUSED' : (e.code || 'TRANSPORT');
        reject(new TransportError(`无法连接 Docker 引擎（${this.label}）：${e.message}`, code, e));
      });
      if (body == null) {
        req.end();
      } else if (typeof body === 'string' || Buffer.isBuffer(body)) {
        req.setHeader('Content-Length', Buffer.byteLength(body));
        req.end(body);
      } else if (typeof body.pipe === 'function') {
        body.on('error', (e) => req.destroy(e));
        body.pipe(req);
      } else {
        const buf = Buffer.from(JSON.stringify(body));
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('Content-Length', buf.length);
        req.end(buf);
      }
    });
  }

  close() {
    try { this.agent.destroy(); } catch (_) {}
  }
}

/** 极简 chunked 解码器（供 stdio 传输使用） */
class ChunkedDecoder {
  constructor(onData, onEnd, onError) {
    this.onData = onData;
    this.onEnd = onEnd;
    this.onError = onError;
    this.buf = Buffer.alloc(0);
    this.state = 'size';
    this.remaining = 0;
    this.finished = false;
  }

  push(chunk) {
    if (this.finished) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let progressed = true;
    while (progressed && !this.finished) {
      progressed = false;
      if (this.state === 'size') {
        const nl = this.buf.indexOf('\r\n');
        if (nl === -1) return;
        const line = this.buf.subarray(0, nl).toString('ascii').split(';')[0].trim();
        this.buf = this.buf.subarray(nl + 2);
        const size = parseInt(line, 16);
        if (!Number.isFinite(size)) return this.onError(new Error('chunked 编码非法'));
        if (size === 0) { this.state = 'trailer'; progressed = true; continue; }
        this.remaining = size;
        this.state = 'data';
        progressed = true;
      } else if (this.state === 'data') {
        if (!this.buf.length) return;
        const take = Math.min(this.remaining, this.buf.length);
        this.onData(this.buf.subarray(0, take));
        this.buf = this.buf.subarray(take);
        this.remaining -= take;
        if (this.remaining === 0) this.state = 'crlf';
        progressed = true;
      } else if (this.state === 'crlf') {
        if (this.buf.length < 2) return;
        this.buf = this.buf.subarray(2);
        this.state = 'size';
        progressed = true;
      } else { // trailer
        const nl = this.buf.indexOf('\r\n\r\n');
        if (nl === -1) {
          // 也可能是紧接一个 \r\n 结束
          if (this.buf.length >= 2 && this.buf[0] === 13 && this.buf[1] === 10) {
            this.buf = this.buf.subarray(2);
          } else return;
        } else {
          this.buf = this.buf.subarray(nl + 4);
        }
        this.finished = true;
        this.onEnd();
      }
    }
  }
}

/**
 * docker system dial-stdio 传输（WSL 无端口回退）
 * - 单连接串行：一次只允许一个请求在途，保证响应不串包
 * - 支持 chunked / content-length / 连接关闭三种 body 定界
 */
class StdioTransport {
  constructor(cmd, args, opts = {}) {
    this.cmd = cmd;
    this.args = args;
    this.label = opts.label || `${cmd} ${args.join(' ')}`;
    this.timeout = opts.timeout || 120000;
    this.child = null;
    this.queue = [];
    this.current = null;
    this.dead = false;
    this.stderrBuf = '';
    this.log = opts.log || (() => {});
  }

  _spawn() {
    if (this.child) return;
    const child = spawn(this.cmd, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.dead = false;
    this.stderrBuf = '';
    child.stdout.on('data', (c) => this._onData(c));
    child.stdin.on('error', (e) => this.log(`[stdio] stdin error: ${e.message}`));
    child.stderr.on('data', (c) => {
      this.stderrBuf = (this.stderrBuf + c.toString('utf8')).slice(-4000);
    });
    child.on('exit', (code) => {
      // 注意：这里可能发生在请求进行中（例如 WSL 重启、进程被系统杀掉），
      // 必须保证任何异常都不会漏到宿主进程（Electron 会弹 JS error 对话框）
      try {
        const wasCurrent = this.current;
        this.child = null;
        if (wasCurrent) {
          this._failCurrent(new TransportError(
            `dial-stdio 退出（code=${code}）${this.stderrBuf ? '：' + this.stderrBuf.trim().slice(-300) : ''}`,
            'ESTDIO',
          ));
        }
      } catch (e) {
        this.log(`[stdio] exit handler error: ${e && e.message}`);
      }
      // 排队的请求下一次 pump 时会重建进程
      setImmediate(() => {
        try { this._pump(); } catch (e) { this.log(`[stdio] pump error: ${e && e.message}`); }
      });
    });
    child.on('error', (e) => {
      try {
        this.child = null;
        this._failCurrent(new TransportError(`无法启动 ${this.cmd}：${e.message}`, 'ESPAWN', e));
      } catch (err) {
        this.log(`[stdio] error handler failed: ${err && err.message}`);
      }
    });
  }

  _failCurrent(err) {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    try { clearTimeout(cur.timer); } catch (_) {}
    try { cur.res.end(); } catch (_) {}
    // reject 可能在 job 上（旧字段）或 cur 上，两处都兜一下，绝不抛
    const reject = typeof cur.reject === 'function' ? cur.reject
      : (cur.job && typeof cur.job.reject === 'function' ? cur.job.reject : null);
    if (reject) {
      try { reject(err); } catch (e) { this.log(`[stdio] reject failed: ${e && e.message}`); }
    }
    setImmediate(() => {
      try { this._pump(); } catch (e) { this.log(`[stdio] pump error: ${e && e.message}`); }
    });
  }

  request({ method = 'GET', path = '/', headers = {}, body = null, timeout = this.timeout } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ method, path, headers, body, timeout, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    if (this.current || !this.queue.length) return;
    this._spawn();
    if (!this.child) return;
    const job = this.queue.shift();
    const res = new PassThrough({ highWaterMark: 1 << 20 });
    const cur = {
      job, res,
      resolve: job.resolve,
      reject: job.reject,
      state: 'head',
      buf: Buffer.alloc(0),
      remaining: 0,
      chunked: null,
      timer: null,
      settledHeaders: false,
    };
    this.current = cur;
    cur.timer = setTimeout(() => {
      this._failCurrent(new TransportError(`dial-stdio 请求超时：${method2str(job)}`, 'ETIMEDOUT'));
      this.close();
    }, job.timeout);

    res.on('drain', () => {
      if (this.child && this.child.stdout.isPaused()) this.child.stdout.resume();
    });

    // 归一化请求体：null | Buffer | Readable(自带长度由调用方给出)
    let bodyBuf = null;
    let bodyStream = null;
    const raw = job.body;
    if (raw == null) {
      // 无体
    } else if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
      bodyBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    } else if (typeof raw.pipe === 'function') {
      bodyStream = raw;
    } else {
      bodyBuf = Buffer.from(JSON.stringify(raw));
      if (!job.headers['Content-Type'] && !job.headers['content-type']) job.headers['Content-Type'] = 'application/json';
    }

    const hdrs = { Host: 'docker', Connection: 'keep-alive', ...lowerKeys(job.headers) };
    if (bodyBuf) hdrs['content-length'] = String(bodyBuf.length);
    let head = `${job.method} ${job.path} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(hdrs)) head += `${k}: ${v}\r\n`;
    head += '\r\n';

    try {
      this.child.stdin.write(head);
      if (bodyBuf) this.child.stdin.write(bodyBuf);
    } catch (e) {
      return this._failCurrent(new TransportError(`写入 dial-stdio 失败：${e.message}`, 'ESTDIO', e));
    }

    if (bodyStream) {
      bodyStream.on('error', (e) => this._failCurrent(new TransportError(`请求体读取失败：${e.message}`, 'EBODY', e)));
      bodyStream.pipe(this.child.stdin, { end: false });
    }
  }

  _onData(chunk) {
    const cur = this.current;
    if (!cur) return;
    cur.buf = cur.buf.length ? Buffer.concat([cur.buf, chunk]) : chunk;
    if (cur.state === 'head') {
      const idx = cur.buf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (cur.buf.length > 64 * 1024) this._failCurrent(new TransportError('dial-stdio 响应头过大', 'ESTDIO'));
        return;
      }
      const headText = cur.buf.subarray(0, idx).toString('latin1');
      cur.buf = cur.buf.subarray(idx + 4);
      const lines = headText.split('\r\n');
      const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(lines[0] || '');
      if (!m) return this._failCurrent(new TransportError(`dial-stdio 响应非法：${lines[0]}`, 'ESTDIO'));
      const status = Number(m[1]);
      const headers = {};
      for (const line of lines.slice(1)) {
        const c = line.indexOf(':');
        if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      }
      cur.job.resolve({ status, headers, stream: cur.res });

      const te = (headers['transfer-encoding'] || '').toLowerCase();
      const cl = headers['content-length'];
      if (cur.job.method === 'HEAD' || status === 204 || status === 304) {
        cur.res.end();
        this._finish();
        return;
      }
      if (te.includes('chunked')) {
        cur.state = 'chunked';
        cur.chunked = new ChunkedDecoder(
          (buf) => this._pushBody(cur, buf),
          () => this._finish(),
          (e) => this._failCurrent(e),
        );
      } else if (cl != null) {
        cur.state = 'length';
        cur.remaining = Number(cl) || 0;
        if (cur.remaining === 0) { cur.res.end(); this._finish(); return; }
        const take = Math.min(cur.remaining, cur.buf.length);
        if (take) { this._pushBody(cur, cur.buf.subarray(0, take)); cur.buf = cur.buf.subarray(take); cur.remaining -= take; }
        if (cur.remaining === 0) this._finish();
        return;
      } else {
        cur.state = 'close';
      }
      if (cur.state === 'chunked' && cur.buf.length) {
        const b = cur.buf; cur.buf = Buffer.alloc(0); cur.chunked.push(b);
      }
      return;
    }

    if (cur.state === 'chunked') {
      const b = cur.buf; cur.buf = Buffer.alloc(0); cur.chunked.push(b);
      return;
    }
    if (cur.state === 'length') {
      const take = Math.min(cur.remaining, cur.buf.length);
      if (take) { this._pushBody(cur, cur.buf.subarray(0, take)); cur.buf = cur.buf.subarray(take); cur.remaining -= take; }
      if (cur.remaining === 0) this._finish();
      return;
    }
    if (cur.state === 'close') {
      this._pushBody(cur, cur.buf);
      cur.buf = Buffer.alloc(0);
    }
  }

  _pushBody(cur, buf) {
    if (!cur || !buf || !buf.length) return;
    try {
      if (cur.res.writableEnded || cur.res.destroyed) return;
      const ok = cur.res.write(buf);
      if (!ok && this.child) this.child.stdout.pause();
    } catch (e) {
      this.log(`[stdio] write failed: ${e && e.message}`);
      this._failCurrent(new TransportError(`dial-stdio 响应写入失败：${e.message}`, 'ESTDIO', e));
    }
  }

  _finish() {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    clearTimeout(cur.timer);
    try { cur.res.end(); } catch (_) {}
    setImmediate(() => this._pump());
  }

  close() {
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.stdin.end(); } catch (_) {}
      try { child.kill(); } catch (_) {}
    }
    const cur = this.current;
    if (cur) this._failCurrent(new TransportError('dial-stdio 已关闭', 'ECLOSED'));
  }
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k.toLowerCase()] = v;
  return out;
}

function method2str(job) { return `${job.method} ${job.path}`; }

/** 读完整响应体（小数据） */
function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

module.exports = { HttpTransport, StdioTransport, TransportError, readAll, ChunkedDecoder };

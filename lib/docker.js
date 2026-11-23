'use strict';
/** Docker Engine API 客户端（只用稳定端点，>= API 1.24） */

const { readAll } = require('./transport');

class DockerError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
    this.body = body;
    this.code = mapCode(status, message);
  }
}

function mapCode(status, message) {
  const m = String(message || '');
  if (/is not running/i.test(m)) return 'NEEDS_RUNNING';
  if (/no such (container|file|directory)/i.test(m)) return status === 404 ? 'NOT_FOUND' : 'ENGINE';
  if (/permission denied/i.test(m)) return 'PERMISSION';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 403) return 'FORBIDDEN';
  return 'ENGINE';
}

class DockerClient {
  constructor(transport, opts = {}) {
    this.transport = transport;
    this.apiVersion = opts.apiVersion || null;
    this.timeout = opts.timeout || 120000;
  }

  prefix(p) {
    return this.apiVersion ? `/v${this.apiVersion}${p}` : p;
  }

  async raw(method, p, { body = null, headers = {}, timeout, versioned = true, signal } = {}) {
    const path = versioned ? this.prefix(p) : p;
    if (signal && signal.aborted) throw new DockerError(499, '请求已取消');
    return this.transport.request({
      method, path, body, headers, timeout: timeout || this.timeout, signal,
    });
  }

  async json(method, p, body, opts = {}) {
    const res = await this.raw(method, p, { body, ...opts });
    const buf = await readAll(res.stream);
    const text = buf.toString('utf8');
    if (res.status >= 400) {
      let msg = text;
      try { msg = JSON.parse(text).message || text; } catch (_) {}
      throw new DockerError(res.status, String(msg || `HTTP ${res.status}`).trim(), text);
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return text; }
  }

  async ping() {
    const t0 = Date.now();
    const res = await this.raw('GET', '/_ping', { versioned: false, timeout: 8000 });
    await readAll(res.stream);
    if (res.status !== 200) throw new DockerError(res.status, 'docker 引擎 /_ping 失败');
    return { apiVersion: res.headers['api-version'] || '', ms: Date.now() - t0 };
  }

  async version() {
    return this.json('GET', '/version', null, { versioned: false, timeout: 15000 });
  }

  /** 连接并协商 API 版本 */
  static async connect(transport, opts = {}) {
    const client = new DockerClient(transport, opts);
    const ping = await client.ping();
    let v = null;
    try {
      const ver = await client.version();
      v = ver && ver.ApiVersion ? String(ver.ApiVersion) : null;
      client.serverVersion = ver && ver.Version;
      client.os = ver && ver.Os;
      client.arch = ver && ver.Arch;
    } catch (_) {
      v = ping.apiVersion || null;
    }
    // 版本区间保护：太新/太旧都用保守值
    if (v) {
      const [maj, min] = v.split('.').map(Number);
      if (!Number.isFinite(maj) || maj < 1 || (maj === 1 && min < 24)) v = '1.24';
      if (maj === 1 && min > 47) v = '1.47';
      if (maj > 1) v = '1.47';
    }
    client.apiVersion = v || '1.41';
    return client;
  }

  close() {
    try { this.transport.close(); } catch (_) {}
  }

  // ---------- 容器 ----------

  async listContainers({ all = true } = {}) {
    const list = await this.json('GET', `/containers/json?all=${all ? 1 : 0}`);
    return (list || []).map(normalizeContainer);
  }

  async inspect(id) {
    return this.json('GET', `/containers/${encodeURIComponent(id)}/json`);
  }

  async start(id) {
    await this.json('POST', `/containers/${encodeURIComponent(id)}/start`, {});
    return true;
  }

  // ---------- archive（docker cp 的底层） ----------

  async archiveHead(id, p) {
    const res = await this.raw('HEAD', `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(p)}`);
    await readAll(res.stream).catch(() => {});
    if (res.status >= 400) {
      throw new DockerError(res.status, res.status === 404 ? `容器内不存在该路径：${p}` : `无法读取 ${p}（HTTP ${res.status}）`);
    }
    const b64 = res.headers['x-docker-container-path-stat'];
    if (!b64) return null;
    try {
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } catch (_) {
      return null;
    }
  }

  async archiveGet(id, p, { timeout } = {}) {
    const res = await this.raw('GET', `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(p)}`, { timeout });
    if (res.status >= 400) {
      const buf = await readAll(res.stream);
      let msg = buf.toString('utf8');
      try { msg = JSON.parse(msg).message || msg; } catch (_) {}
      throw new DockerError(res.status, msg.trim() || `archive GET 失败（HTTP ${res.status}）`);
    }
    return res.stream;
  }

  /** body: Buffer | Readable，必须带 length（Content-Length） */
  async archivePut(id, dirPath, body, { length, noOverwrite = true, timeout } = {}) {
    const headers = { 'Content-Type': 'application/x-tar' };
    if (length != null) headers['Content-Length'] = String(length);
    const qs = new URLSearchParams({ path: dirPath, noOverwriteDirNonDir: noOverwrite ? 'true' : 'false', copyUIDGID: 'false' });
    const res = await this.raw('PUT', `/containers/${encodeURIComponent(id)}/archive?${qs}`, {
      body, headers, timeout: timeout || 300000,
    });
    if (res.status >= 400) {
      const buf = await readAll(res.stream);
      let msg = buf.toString('utf8');
      try { msg = JSON.parse(msg).message || msg; } catch (_) {}
      throw new DockerError(res.status, msg.trim() || `archive PUT 失败（HTTP ${res.status}）`);
    }
    await readAll(res.stream);
    return true;
  }

  // ---------- exec ----------

  async execCreate(id, argv, { env } = {}) {
    const body = { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: argv };
    if (env) body.Env = env;
    const r = await this.json('POST', `/containers/${encodeURIComponent(id)}/exec`, body);
    return r && r.Id;
  }

  async execStart(execId, { timeout = 60000 } = {}) {
    const res = await this.raw('POST', `/exec/${encodeURIComponent(execId)}/start`, {
      body: { Detach: false, Tty: false },
      headers: { 'Content-Type': 'application/json' },
      timeout,
    });
    if (res.status >= 400) {
      const buf = await readAll(res.stream);
      let msg = buf.toString('utf8');
      try { msg = JSON.parse(msg).message || msg; } catch (_) {}
      throw new DockerError(res.status, msg.trim());
    }
    const out = await demux(res.stream, timeout);
    return out;
  }

  async execInspect(execId) {
    return this.json('GET', `/exec/${encodeURIComponent(execId)}/json`);
  }

  /** 在容器内执行命令，返回 {code, stdout, stderr} */
  async exec(id, argv, opts = {}) {
    const execId = await this.execCreate(id, argv, opts);
    if (!execId) throw new DockerError(500, '创建 exec 失败');
    const { stdout, stderr } = await this.execStart(execId, opts);
    let info = null;
    for (let i = 0; i < 20; i++) {
      info = await this.execInspect(execId);
      if (info && !info.Running) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return { code: info && typeof info.ExitCode === 'number' ? info.ExitCode : -1, stdout, stderr };
  }
}

/** 解析 8 字节帧：type(1) + pad(3) + size(4 BE) + payload */
function demux(stream, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const out = [];
    const err = [];
    let buf = Buffer.alloc(0);
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      try { stream.destroy(); } catch (_) {}
      reject(new DockerError(504, 'exec 执行超时'));
    }, timeout);
    const done = (e) => {
      if (failed) return;
      clearTimeout(timer);
      if (e) reject(e);
      else resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    stream.on('data', (c) => {
      buf = buf.length ? Buffer.concat([buf, c]) : c;
      for (;;) {
        if (buf.length < 8) return;
        const type = buf[0];
        const size = buf.readUInt32BE(4);
        if (buf.length < 8 + size) return;
        const payload = buf.subarray(8, 8 + size);
        if (type === 1) out.push(payload);
        else if (type === 2) err.push(payload);
        else out.push(payload);
        buf = buf.subarray(8 + size);
      }
    });
    stream.on('end', () => done(null));
    stream.on('close', () => done(null));
    stream.on('error', done);
  });
}

function normalizeContainer(c) {
  const names = (c.Names || []).map((n) => String(n).replace(/^\//, ''));
  return {
    id: c.Id,
    shortId: String(c.Id || '').slice(0, 12),
    name: names[0] || String(c.Id || '').slice(0, 12),
    names,
    image: c.Image,
    imageId: c.ImageID,
    state: c.State,
    status: c.Status,
    created: c.Created,
    command: c.Command,
    ports: (c.Ports || []).map((p) => ({
      ip: p.IP, private: p.PrivatePort, public: p.PublicPort, type: p.Type,
    })),
    compose: (c.Labels && (c.Labels['com.docker.compose.project'] || '')) || '',
    service: (c.Labels && (c.Labels['com.docker.compose.service'] || '')) || '',
  };
}

module.exports = { DockerClient, DockerError, normalizeContainer, demux };

'use strict';
/**
 * 容器 / 镜像终端。
 *
 *   exec 会话   —— docker exec -it：在已有容器里开一个 shell（Tty + hijack）
 *   attach 会话 —— docker run -it：按镜像起一个临时容器，shell 退出即自动删除
 *
 * 为什么单独处理传输层：exec/attach 的交互流是 HTTP 101 upgrade 之后的原始双向字节流，
 * 不能用普通 request/response。HttpTransport 走 socket hijack；dial-stdio 走独立子进程
 * （共享的 StdioTransport 是串行队列，交互流会把它占死）。
 */
const crypto = require('crypto');
const wsl = require('./wsl');
const { hijackStdio } = require('./transport');

/** 依次尝试的 shell（多数镜像都有 /bin/sh） */
const SHELL_CANDIDATES = [
  ['/bin/sh'],
  ['/bin/bash'],
  ['/bin/ash'],
  ['/bin/ksh'],
  ['/bin/zsh'],
  ['/usr/bin/bash'],
  ['/usr/bin/sh'],
  ['/busybox/sh'],
];
/** 镜像起临时容器时尝试的 shell（每个候选都要 create/start，成本略高，取前三个） */
const IMAGE_SHELLS = [['/bin/sh'], ['/bin/bash'], ['/bin/ash']];
const ENV = ['TERM=xterm-256color', 'COLORTERM=truecolor'];
const PENDING_LIMIT = 256 * 1024;
const INPUT_LIMIT = 64 * 1024;
const SHELL_LABEL = 'dockfile.shell';

class TermError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'TermError';
    this.code = code;
    this.hint = hint || '';
  }
}

/** "/bin/bash -l" → ['/bin/bash','-l'] */
function parseShell(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/\s/.test(s)) return s.split(/\s+/).filter(Boolean);
  return [s];
}

function sessionId() {
  return 't' + crypto.randomBytes(6).toString('hex');
}

class TermManager {
  /**
   * @param {object} opts
   * @param {import('./endpoint').EngineHub} opts.hub
   * @param {(msg:string)=>void} [opts.log]
   * @param {number} [opts.maxSessions]
   */
  constructor({ hub, log = () => {}, maxSessions = 8 } = {}) {
    this.hub = hub;
    this.log = log;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
    this.shellCache = new Map(); // containerId -> argv（找到过就不再逐个试）
    this.seq = 0;
  }

  /* ---------------- 会话开立 ---------------- */

  /** 在已有容器里开终端 */
  async openContainer({ containerId, shell, cols = 100, rows = 30, workdir = '' }) {
    if (!containerId) throw new TermError('BAD_REQUEST', '缺少容器 id');
    const conn = await this.hub.ensure();
    const client = conn.client;
    const info = await client.inspect(containerId);
    const state = (info && info.State) || {};
    const name = String((info && info.Name) || '').replace(/^\//, '') || containerId.slice(0, 12);
    if (!state.Running) {
      throw new TermError('NEEDS_RUNNING', `容器 ${name} 未运行`, '先启动容器，再打开终端');
    }

    this._limit();
    const forced = parseShell(shell);
    const candidates = forced ? [forced] : this._candidates(containerId);
    const opened = await this._openExec(conn, containerId, candidates, workdir);

    const execId = opened.execId;
    this._resizeExec(execId, cols, rows);
    return this._register({
      kind: 'exec',
      containerId,
      containerName: name,
      image: (info.Config && info.Config.Image) || '',
      argv: opened.argv,
      execId,
      cols,
      rows,
      stream: opened.stream,
      ephemeral: false,
    });
  }

  /** 按镜像起临时容器并进 shell（关闭即删除） */
  async openImage({ image, shell, cols = 100, rows = 30 }) {
    const img = String(image || '').trim();
    if (!img) throw new TermError('BAD_REQUEST', '缺少镜像名');
    const conn = await this.hub.ensure();
    const client = conn.client;
    this._limit();

    const forced = parseShell(shell);
    const candidates = forced ? [forced] : IMAGE_SHELLS;
    const errors = [];
    let lastMsg = '';

    for (const argv of candidates) {
      const name = `dockfile-shell-${crypto.randomBytes(3).toString('hex')}`;
      let id = null;
      try {
        id = await client.createContainer({
          Image: img,
          // 用 Entrypoint 覆盖镜像自带的 entrypoint（nginx 之类否则会跑成镜像默认命令）
          Entrypoint: argv,
          Tty: true,
          OpenStdin: true,
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Env: ENV,
          Labels: { [SHELL_LABEL]: '1' },
          HostConfig: { AutoRemove: true },
        }, { name });
        if (!id) throw new TermError('ENGINE', '创建临时容器失败');
        await client.start(id);
        const hj = await this._hijack(conn, `/containers/${encodeURIComponent(id)}/attach?stream=1&stdin=1&stdout=1&stderr=1`, '');
        this._resizeContainer(id, cols, rows);
        return this._register({
          kind: 'attach',
          containerId: id,
          containerName: name,
          image: img,
          argv,
          cols,
          rows,
          stream: hj.stream,
          ephemeral: true,
        });
      } catch (e) {
        if (id) {
          try { await client.removeContainer(id); } catch (_) {}
        }
        lastMsg = String((e && e.body) || (e && e.message) || '');
        // 该镜像里没有这个 shell：换下一个候选；其它错误（镜像不存在等）直接抛
        const missingShell = e && (e.code === 'HIJACK' || e.status === 500)
          && /no such file|not found|executable|exec failed|OCI runtime/i.test(lastMsg);
        if (missingShell) { errors.push(argv.join(' ')); continue; }
        throw e;
      }
    }

    throw new TermError(
      'NO_SHELL',
      `镜像 ${img} 里没有找到可用的 shell（试过 ${errors.join('、')}）`,
      lastMsg.slice(0, 300) || 'distroless/scratch 类镜像可以先在「容器」里手动指定 shell',
    );
  }

  _candidates(containerId) {
    const cached = this.shellCache.get(containerId);
    const list = cached ? [cached, ...SHELL_CANDIDATES] : SHELL_CANDIDATES.slice();
    const seen = new Set();
    const out = [];
    for (const argv of list) {
      const k = argv.join(' ');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(argv);
    }
    return out;
  }

  /** 逐个候选 shell 试 exec start：失败（二进制不存在）就换下一个 */
  async _openExec(conn, containerId, candidates, workdir) {
    const client = conn.client;
    // 只有第一个候选带工作目录：目录不存在时后面的候选会自动退回根目录
    const queue = candidates.map((argv, i) => ({ argv, wd: i === 0 ? workdir : '' }));
    const tried = [];
    let lastMsg = '';

    for (const { argv, wd } of queue) {
      const execId = await client.execCreateTty(containerId, argv, { env: ENV, workdir: wd });
      if (!execId) throw new TermError('ENGINE', '创建 exec 失败');
      try {
        const hj = await this._hijack(conn, `/exec/${encodeURIComponent(execId)}/start`, { Detach: false, Tty: true });
        if (this.shellCache.size > 64) this.shellCache.clear();
        this.shellCache.set(containerId, argv);
        return { argv, execId, stream: hj.stream };
      } catch (e) {
        lastMsg = String((e && e.body) || (e && e.message) || '');
        // 500/400 = 这个 shell 起不来（no such file / chdir 失败），换下一个
        if (e && e.code === 'HIJACK' && (e.status === 500 || e.status === 400)) {
          tried.push(argv.join(' '));
          continue;
        }
        throw e;
      }
    }

    const hint = /chdir|working ?dir|no such file or directory: unknown/i.test(lastMsg) && workdir
      ? `工作目录可能不存在：${workdir}`
      : '镜像可能是 distroless/scratch 构建；可在终端工具条里手动指定 shell 路径';
    throw new TermError('NO_SHELL', `容器内没有可用的 shell（试过 ${tried.join('、')}）`, hint);
  }

  /** 打开 101 upgrade 连接：socket hijack 或 dial-stdio 独立子进程 */
  _hijack(conn, path, body) {
    const full = conn.client.prefix(path);
    const opts = {
      method: 'POST',
      path: full,
      headers: { 'Content-Type': 'application/json' },
      body,
      timeout: 30000,
    };
    if (conn.transport && typeof conn.transport.hijack === 'function') {
      return conn.transport.hijack(opts);
    }
    const { cmd, args } = wsl.stdioCommand(conn.distro);
    return hijackStdio(cmd, args, { ...opts, log: this.log });
  }

  _resizeExec(execId, cols, rows) {
    this.hub.withClient((c) => c.execResize(execId, cols, rows)).catch((e) => {
      this.log(`[term] resize exec failed: ${e && e.message}`);
    });
  }

  _resizeContainer(id, cols, rows) {
    this.hub.withClient((c) => c.resizeContainer(id, cols, rows)).catch((e) => {
      this.log(`[term] resize container failed: ${e && e.message}`);
    });
  }

  /* ---------------- 会话生命周期 ---------------- */

  _limit() {
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.values().next().value;
      if (!oldest) break;
      this.log(`[term] 会话数达到上限 ${this.maxSessions}，关闭最早的 ${oldest.id}`);
      this.close(oldest.id, '会话数超限');
    }
  }

  _register(s) {
    const id = sessionId();
    const sess = {
      id,
      createdAt: Date.now(),
      res: null,
      pending: [],
      pendingBytes: 0,
      closed: false,
      cols: 100,
      rows: 30,
      ...s,
    };
    this.sessions.set(id, sess);
    sess.stream.on('data', (c) => this._onData(sess, c));
    sess.stream.on('end', () => this._teardown(sess, 'shell 已退出'));
    sess.stream.on('close', () => this._teardown(sess, 'shell 已退出'));
    sess.stream.on('error', (e) => this._teardown(sess, `连接出错：${e && e.message}`));
    this.log(`[term] open ${id} ${sess.kind} ${sess.containerName} (${sess.argv.join(' ')})`);
    return sess;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  /** 把会话输出接到 HTTP 响应（浏览器侧 EventSource 式的单向流） */
  bind(id, req, res) {
    const sess = this.sessions.get(id);
    if (!sess) return 'missing';
    if (sess.res) return 'busy';
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'keep-alive',
    });
    sess.res = res;
    const pending = sess.pending;
    sess.pending = [];
    sess.pendingBytes = 0;
    for (const buf of pending) {
      try { res.write(buf); } catch (_) {}
    }
    res.on('error', () => {});
    res.on('close', () => {
      if (sess.closed) return;
      sess.res = null;
      this._teardown(sess, '浏览器断开连接');
    });
    return 'ok';
  }

  write(id, buf) {
    const sess = this.sessions.get(id);
    if (!sess || sess.closed) return false;
    if (!buf || !buf.length) return true;
    if (buf.length > INPUT_LIMIT) return false;
    try {
      sess.stream.write(buf);
      return true;
    } catch (e) {
      this.log(`[term] write failed: ${e && e.message}`);
      return false;
    }
  }

  resize(id, cols, rows) {
    const sess = this.sessions.get(id);
    if (!sess || sess.closed) return false;
    sess.cols = cols;
    sess.rows = rows;
    if (sess.kind === 'exec' && sess.execId) this._resizeExec(sess.execId, cols, rows);
    else this._resizeContainer(sess.containerId, cols, rows);
    return true;
  }

  close(id, reason = '用户关闭') {
    const sess = this.sessions.get(id);
    if (!sess) return false;
    this._teardown(sess, reason);
    return true;
  }

  closeAll(reason = '服务退出') {
    for (const sess of Array.from(this.sessions.values())) this._teardown(sess, reason);
  }

  _teardown(sess, reason) {
    if (sess.closed) return;
    sess.closed = true;
    this.sessions.delete(sess.id);
    try { sess.stream.destroy(); } catch (_) {}
    if (sess.res) {
      const res = sess.res;
      sess.res = null;
      try { res.end(); } catch (_) {}
    }
    this.log(`[term] close ${sess.id} (${sess.containerName}): ${reason}`);
    if (sess.ephemeral) {
      this.hub.withClient((c) => c.removeContainer(sess.containerId))
        .then(() => this.log(`[term] 已删除临时容器 ${sess.containerName}`))
        .catch((e) => this.log(`[term] 删除临时容器失败：${e && e.message}`));
    }
  }

  _onData(sess, buf) {
    if (sess.closed || !buf || !buf.length) return;
    const res = sess.res;
    if (!res) {
      sess.pending.push(buf);
      sess.pendingBytes += buf.length;
      while (sess.pendingBytes > PENDING_LIMIT && sess.pending.length > 1) {
        const dropped = sess.pending.shift();
        sess.pendingBytes -= dropped.length;
      }
      return;
    }
    try {
      if (!res.write(buf) && typeof sess.stream.pause === 'function') {
        sess.stream.pause();
        res.once('drain', () => {
          try { sess.stream.resume(); } catch (_) {}
        });
      }
    } catch (e) {
      this.log(`[term] 输出写入失败：${e && e.message}`);
      this._teardown(sess, '输出通道已断开');
    }
  }

  list() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      kind: s.kind,
      containerId: s.containerId,
      containerName: s.containerName,
      image: s.image,
      shell: s.argv.join(' '),
      ephemeral: s.ephemeral,
      cols: s.cols,
      rows: s.rows,
      attached: Boolean(s.res),
      ageMs: Date.now() - s.createdAt,
    }));
  }

  _tracks(containerId) {
    for (const s of this.sessions.values()) if (s.containerId === containerId) return true;
    return false;
  }

  /** 清理上一次运行遗留的临时 shell 容器（崩溃/断电后残留） */
  async sweep() {
    try {
      const conn = await this.hub.ensure();
      const list = await conn.client.json('GET', '/containers/json?all=1');
      const stale = (list || []).filter((c) => c.Labels && c.Labels[SHELL_LABEL] === '1' && !this._tracks(c.Id));
      for (const c of stale) {
        try {
          await conn.client.removeContainer(c.Id);
          this.log(`[term] 清理残留临时容器 ${String((c.Names && c.Names[0]) || c.Id).replace(/^\//, '')}`);
        } catch (e) {
          this.log(`[term] 清理失败：${e && e.message}`);
        }
      }
    } catch (e) {
      this.log(`[term] 残留清理跳过：${e && e.message}`);
    }
  }
}

module.exports = { TermManager, TermError, parseShell, INPUT_LIMIT, SHELL_LABEL };

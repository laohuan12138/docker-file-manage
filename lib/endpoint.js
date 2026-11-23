'use strict';
/**
 * 端点发现与引擎生命周期：
 *   --docker-host / DOCKER_HOST  >  Windows npipe  >  tcp:2375  >  WSL(relay→stdio)  >  unix socket
 * 断线自愈：relay 被 WSL 重启清掉、dial-stdio 进程退出，都会自动重建并重试一次。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HttpTransport, StdioTransport, TransportError } = require('./transport');
const { DockerClient, DockerError } = require('./docker');
const wsl = require('./wsl');
const { sleep } = require('./util');

const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ESTDIO', 'ECLOSED', 'EPIPE', 'ESPAWN', 'ENOENT']);

function parseDockerHost(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.startsWith('unix://')) {
    const p = s.slice('unix://'.length).replace(/^\/+/, '/');
    return { kind: 'unix', socketPath: p || '/var/run/docker.sock' };
  }
  if (s.startsWith('npipe://')) {
    let p = s.slice('npipe://'.length);
    p = p.replace(/^\/+/, '');
    if (p.startsWith('./pipe/')) p = p.slice('./pipe/'.length);
    if (p.startsWith('pipe/')) p = p.slice('pipe/'.length);
    return { kind: 'npipe', socketPath: '\\\\.\\pipe\\' + p.replace(/\//g, '\\') };
  }
  const m = /^(tcp|http|https):\/\/([^/:]+)(?::(\d+))?/.exec(s);
  if (m) {
    const proto = m[1] === 'https' ? 'https:' : 'http:';
    const port = Number(m[3] || (m[1] === 'https' ? 2376 : 2375));
    return { kind: 'tcp', host: m[2], port, protocol: proto, remote: proto === 'https:' };
  }
  if (s.startsWith('/')) return { kind: 'unix', socketPath: s };
  if (/^[A-Za-z]:\\/.test(s) || s.startsWith('\\\\.\\pipe')) return { kind: 'npipe', socketPath: s };
  return null;
}

class EngineHub {
  constructor(opts = {}) {
    this.explicitHost = opts.explicitHost || process.env.DOCKER_HOST || '';
    this.preferTransport = opts.preferTransport || 'auto';
    this.preferDistro = opts.preferDistro || '';
    this.log = opts.log || (() => {});
    this.current = null; // {key, kind, label, detail, client, transport, relay, distro}
    this.candidates = [];
    this.probeCache = new Map(); // distro -> {probe, at}
    this.relays = new Map();     // distro -> {host, port, mode, distro}
    this.lastError = null;
  }

  // ---------- 候选枚举 ----------

  _push(list, c) { list.push(c); }

  buildCandidates({ wslProbes = [] } = {}) {
    const list = [];
    const explicit = parseDockerHost(this.explicitHost);
    if (explicit) {
      this._push(list, {
        key: `${explicit.kind}:${explicit.socketPath || explicit.host + ':' + explicit.port}`,
        kind: explicit.kind,
        label: explicit.kind === 'unix' ? `unix ${explicit.socketPath}` : explicit.kind === 'npipe' ? `npipe ${explicit.socketPath}` : `tcp ${explicit.host}:${explicit.port}`,
        detail: '来自 DOCKER_HOST / --docker-host',
        explicit: true,
        target: explicit,
      });
      return list; // 显式指定就只试它
    }

    if (this.preferTransport !== 'socket' && wsl.isWindows) {
      for (const p of wslProbes) {
        if (!p.ok) continue;
        if (this.preferDistro && p.distro !== this.preferDistro) continue;
        if (p.permissionDenied) continue;
        if (this.preferTransport !== 'stdio') {
          this._push(list, {
            key: `wsl:relay:${p.distro}`,
            kind: 'wsl-relay',
            label: `WSL · ${p.distro}`,
            detail: `relay → ${p.sockPath}（engine ${p.serverVersion}）`,
            distro: p.distro,
            probe: p,
          });
        }
        this._push(list, {
          key: `wsl:stdio:${p.distro}`,
          kind: 'wsl-stdio',
          label: `WSL · ${p.distro} · stdio`,
          detail: 'docker system dial-stdio（无端口回退）',
          distro: p.distro,
          probe: p,
        });
      }
    }

    if (wsl.isWindows) {
      this._push(list, { key: 'npipe:docker_engine', kind: 'npipe', label: 'Docker Desktop', detail: '\\\\.\\pipe\\docker_engine', target: { socketPath: '\\\\.\\pipe\\docker_engine' } });
      this._push(list, { key: 'npipe:docker_engine_linux', kind: 'npipe', label: 'Docker Desktop (WSL)', detail: '\\\\.\\pipe\\docker_engine_linux', target: { socketPath: '\\\\.\\pipe\\docker_engine_linux' } });
    }

    this._push(list, { key: 'tcp:127.0.0.1:2375', kind: 'tcp', label: 'tcp 127.0.0.1:2375', detail: '引擎直接暴露 TCP', target: { host: '127.0.0.1', port: 2375, protocol: 'http:' } });

    if (!wsl.isWindows) {
      const homes = [os.homedir()];
      const socks = [
        '/var/run/docker.sock',
        process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'docker.sock') : '',
        '/run/docker.sock',
        '/run/podman/podman.sock',
        ...homes.map((h) => path.join(h, '.docker', 'run', 'docker.sock')),
      ].filter(Boolean);
      for (const s of socks) {
        if (!fs.existsSync(s)) continue;
        this._push(list, { key: `unix:${s}`, kind: 'unix', label: `unix ${s}`, detail: '本地 socket', target: { socketPath: s } });
      }
      this._push(list, { key: 'tcp:127.0.0.1:2375', kind: 'tcp', label: 'tcp 127.0.0.1:2375', detail: '引擎暴露 TCP', target: { host: '127.0.0.1', port: 2375, protocol: 'http:' } });
    }

    return list;
  }

  /** 探测 WSL 发行版（带 60s 缓存，避免每次刷新都进 WSL） */
  async probeWsl({ refresh = false } = {}) {
    if (!wsl.isWindows || this.preferTransport === 'socket') return [];
    const distros = wsl.listDistros();
    const out = [];
    for (const d of distros) {
      const cached = this.probeCache.get(d);
      if (!refresh && cached && Date.now() - cached.at < 60000) { out.push(cached.probe); continue; }
      const probe = wsl.probeDistro(d);
      this.probeCache.set(d, { probe, at: Date.now() });
      this.log(`[wsl] probe ${d}: ok=${probe.ok} engine=${probe.serverVersion} socat=${!!probe.socat} py=${!!probe.python3}`);
      out.push(probe);
    }
    return out;
  }

  // ---------- 连接 ----------

  _transportFor(cand) {
    if (cand.kind === 'wsl-stdio') {
      const { cmd, args } = wsl.stdioCommand(cand.distro);
      return new StdioTransport(cmd, args, { label: `wsl-stdio ${cand.distro}`, log: this.log });
    }
    if (cand.kind === 'wsl-relay') {
      const relay = this.relays.get(cand.distro);
      if (!relay) throw new TransportError(`relay 尚未建立（${cand.distro}）`, 'ENORELAY');
      return new HttpTransport({ host: relay.host, port: relay.port, protocol: 'http:' }, { kind: 'wsl-relay', label: `wsl relay ${relay.host}:${relay.port}` });
    }
    return new HttpTransport(cand.target, { kind: cand.kind, label: cand.label });
  }

  async _ensureRelay(cand, { force = false } = {}) {
    const existing = this.relays.get(cand.distro);
    if (existing && !force) {
      const ping = await wsl.pingHttp(existing.host, existing.port, 2000);
      if (ping.ok) return existing;
      this.relays.delete(cand.distro);
    }
    if (!force) {
      // 优先复用上次运行遗留的 relay
      try {
        const adopted = await wsl.adoptRelay(cand.distro, cand.probe);
        if (adopted) {
          this.relays.set(cand.distro, adopted);
          this.log(`[wsl] adopted existing relay 127.0.0.1:${adopted.port}`);
          return adopted;
        }
      } catch (e) {
        this.log(`[wsl] adopt failed: ${e.message}`);
      }
    }
    this.log(`[wsl] starting relay for ${cand.distro}...`);
    const relay = await wsl.startRelay(cand.probe);
    this.relays.set(cand.distro, relay);
    this.log(`[wsl] relay ready ${relay.host}:${relay.port} (${relay.mode})`);
    return relay;
  }

  async _connect(cand) {
    const t0 = Date.now();
    if (cand.kind === 'wsl-relay') await this._ensureRelay(cand);
    const transport = this._transportFor(cand);
    const client = await DockerClient.connect(transport, { timeout: 60000 });
    return {
      key: cand.key,
      kind: cand.kind,
      label: cand.label,
      detail: cand.detail,
      distro: cand.distro || '',
      probe: cand.probe || null,
      client,
      transport,
      latencyMs: Date.now() - t0,
      apiVersion: client.apiVersion,
      serverVersion: client.serverVersion,
    };
  }

  /** 探测所有候选（并行，带超时），返回状态列表。relay 候选只做轻量判断，不在这里真的起 relay */
  async investigate({ refresh = false } = {}) {
    let probes = [];
    try { probes = await this.probeWsl({ refresh }); } catch (e) { this.log(`[wsl] probe failed: ${e.message}`); }
    const cands = this.buildCandidates({ wslProbes: probes });
    this.candidates = cands;
    const results = await Promise.all(cands.map(async (c) => {
      const base = { key: c.key, kind: c.kind, label: c.label, detail: c.detail, distro: c.distro || '' };
      if (c.kind === 'wsl-relay') {
        const relay = this.relays.get(c.distro);
        if (relay) {
          const p = await wsl.pingHttp(relay.host, relay.port, 1500);
          return {
            ...base, ok: p.ok, apiVersion: relay.apiVersion || '',
            serverVersion: c.probe ? c.probe.serverVersion : '', latencyMs: null,
            detail: `${c.detail} · 127.0.0.1:${relay.port}`, error: p.ok ? '' : 'relay 已断开',
          };
        }
        return { ...base, ok: Boolean(c.probe && c.probe.ok), serverVersion: c.probe ? c.probe.serverVersion : '', detail: `${c.detail} · 按需建立` };
      }
      try {
        const conn = await Promise.race([
          this._connect(c),
          sleep(c.kind === 'tcp' ? 2500 : 12000).then(() => { throw new Error('探测超时'); }),
        ]);
        conn.client.close();
        return { ...base, ok: true, apiVersion: conn.apiVersion, serverVersion: conn.serverVersion, latencyMs: conn.latencyMs };
      } catch (e) {
        return { ...base, ok: false, error: e.message };
      }
    }));
    return results;
  }

  /** 确保有可用引擎；按候选顺序逐个尝试 */
  async ensure({ refresh = false } = {}) {
    if (this.current && !refresh) return this.current;
    const statuses = await this.investigate({ refresh });
    const errors = [];
    for (const s of statuses.filter((x) => x.ok)) {
      const cand = this.candidates.find((c) => c.key === s.key);
      if (!cand) continue;
      try {
        const conn = await this._connect(cand);
        this.current = conn;
        this.lastError = '';
        this.log(`[engine] connected: ${conn.label} (api ${conn.apiVersion}, ${conn.latencyMs}ms)`);
        return conn;
      } catch (e) {
        errors.push(`${s.label}：${e.message}`);
        this.log(`[engine] ${s.key} failed: ${e.message}`);
      }
    }
    if (this.current) { try { this.current.client.close(); } catch (_) {} this.current = null; }
    const all = statuses.map((s) => `${s.label}（${s.ok ? '连接失败' : s.error || '不可用'}）`);
    this.lastError = statuses.length
      ? '未找到可用的 Docker 引擎。已尝试：' + (errors.length ? errors.join('；') : all.join('；'))
      : '未检测到 Docker 引擎：Windows 上没有 docker 管道，也没有可用的 WSL 发行版。';
    const err = new Error(this.lastError);
    err.code = 'NO_ENGINE';
    err.statuses = statuses;
    throw err;
  }

  async select(key, { refresh = true } = {}) {
    if (refresh) await this.investigate({ refresh: false });
    const cand = this.candidates.find((c) => c.key === key);
    if (!cand) {
      const err = new Error(`未找到端点：${key}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (this.current) { try { this.current.client.close(); } catch (_) {} }
    this.current = await this._connect(cand);
    return this.current;
  }

  /** 带自愈的调用：传输层断链 → 重建 → 重试一次 */
  async withClient(fn) {
    const conn = await this.ensure();
    try {
      return await fn(conn.client, conn);
    } catch (e) {
      const retryable = e instanceof TransportError ? RETRYABLE.has(e.code) : false;
      if (!retryable) throw e;
      this.log(`[engine] transport error ${e.code}, reconnecting...`);
      if (conn.kind === 'wsl-relay' && conn.probe) {
        try { await this._ensureRelay({ distro: conn.distro, probe: conn.probe }, { force: true }); } catch (_) {}
      }
      try { conn.client.close(); } catch (_) {}
      this.current = null;
      const fresh = await this.ensure({ refresh: true });
      return fn(fresh.client, fresh);
    }
  }

  status() {
    const c = this.current;
    return {
      ok: Boolean(c),
      key: c ? c.key : '',
      kind: c ? c.kind : '',
      label: c ? c.label : '',
      distro: c ? c.distro : '',
      endpoint: c ? (c.kind === 'wsl-relay' ? `WSL relay → 127.0.0.1:${(this.relays.get(c.distro) || {}).port || '?'}` : c.kind === 'wsl-stdio' ? 'dial-stdio' : c.detail) : '',
      apiVersion: c ? c.apiVersion : '',
      serverVersion: c ? c.serverVersion : '',
      latencyMs: c ? c.latencyMs : 0,
      error: this.lastError || '',
    };
  }

  close() {
    if (this.current) { try { this.current.client.close(); } catch (_) {} }
    for (const relay of this.relays.values()) {
      try { wsl.stopRelay(relay); } catch (_) {}
    }
    this.relays.clear();
  }
}

module.exports = { EngineHub, parseDockerHost };

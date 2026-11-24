/* dockfile 终端面板：容器 shell / 镜像 shell（xterm.js 已随项目内置） */

const H_KEY = 'dockfile-term-h';
const SHELL_KEY = 'dockfile-shell';
const MIN_H = 120;

const $ = (s) => document.querySelector(s);

/**
 * @param {object} deps
 * @param {(p:string, o?:object)=>Promise<any>} deps.api
 * @param {()=>object} deps.authHeaders
 * @param {(p:string)=>string} deps.tokenQuery
 * @param {(msg:string, o?:object)=>void} deps.toast
 * @param {(t:string,d:string,o?:object)=>Promise<string|null>} deps.ask
 * @param {()=>void} [deps.onContainersChanged]
 */
export function createTermUI(deps) {
  const { api, authHeaders, tokenQuery, toast, ask } = deps;

  const st = {
    term: null,
    fit: null,
    open: false,
    sid: null,
    target: null,
    shell: safeGet(SHELL_KEY) || '',
    cols: 100,
    rows: 30,
    abort: null,
    queue: [],
    flushTimer: null,
    resizeTimer: null,
    busy: false,
    height: Number(safeGet(H_KEY)) || 300,
  };

  /* ---------------- 基础设施 ---------------- */

  function safeGet(k) {
    try { return localStorage.getItem(k); } catch (_) { return ''; }
  }
  function safeSet(k, v) {
    try { localStorage.setItem(k, String(v)); } catch (_) {}
  }

  function ensure() {
    if (st.term) return st.term;
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", "SFMono-Regular", Consolas, ui-monospace, monospace',
      fontSize: 12.5,
      lineHeight: 1.18,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      convertEol: false,
      theme: {
        background: '#0a0e13',
        foreground: '#dbe4ee',
        cursor: '#ffb020',
        cursorAccent: '#0a0e13',
        selectionBackground: 'rgba(76,201,240,.26)',
        black: '#1b2430',
        red: '#ff6b6b',
        green: '#35d07f',
        yellow: '#ffb020',
        blue: '#4cc9f0',
        magenta: '#a78bfa',
        cyan: '#5ee0d0',
        white: '#dbe4ee',
        brightBlack: '#5b6b7d',
        brightRed: '#ff8b8b',
        brightGreen: '#63e6a3',
        brightYellow: '#ffc95c',
        brightBlue: '#7ddcf7',
        brightMagenta: '#c4b5fd',
        brightCyan: '#8df0e4',
        brightWhite: '#ffffff',
      },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($('#termBody'));
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
      const k = String(e.key || '').toLowerCase();
      if (k === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (k === 'v') {
        navigator.clipboard.readText().then((t) => t && send(t)).catch(() => {});
        return false;
      }
      return true;
    });
    term.onData((d) => send(d));
    term.onResize(({ cols, rows }) => {
      st.cols = cols;
      st.rows = rows;
      scheduleResize();
    });
    st.term = term;
    st.fit = fit;
    return term;
  }

  function layout() {
    if (!st.open) return;
    try { st.fit.fit(); } catch (_) {}
  }

  function applyHeight(h) {
    st.height = Math.max(MIN_H, Math.min(window.innerHeight - 220, Math.round(h)));
    const dock = $('#termDock');
    if (dock) dock.style.height = st.height + 'px';
    safeSet(H_KEY, st.height);
    layout();
  }

  function show() {
    const dock = $('#termDock');
    dock.hidden = false;
    st.open = true;
    document.body.classList.add('term-open');
    applyHeight(st.height);
    setTimeout(() => { layout(); ensure().focus(); }, 30);
  }

  function hide() {
    const dock = $('#termDock');
    st.open = false;
    dock.hidden = true;
    document.body.classList.remove('term-open');
  }

  /* ---------------- 头部 ---------------- */

  function shellLabel() {
    return st.shell || '自动探测';
  }

  function renderHead() {
    const t = st.target;
    $('#termTitle').textContent = t ? (t.type === 'image' ? t.image : t.name) : '终端';
    $('#termTag').hidden = !(t && t.type === 'image');
    const bits = [];
    if (t && t.type === 'container' && t.image) bits.push(t.image);
    if (t && t.type === 'container' && t.workdir && t.workdir !== '/') bits.push(t.workdir);
    if (st.sid) bits.push(st.shell || '自动探测');
    if (st.note) bits.push(st.note);
    const meta = $('#termMeta');
    meta.textContent = bits.join(' · ');
    meta.className = 'term-meta ' + (st.noteKind || '');
    $('#termDot').className = 'term-dot' + (st.sid ? ' ok' : st.ended ? ' bad' : '');
  }

  function status(text, kind = '') {
    st.note = text || '';
    st.noteKind = kind;
    renderHead();
  }

  function syncShellSel() {
    const sel = $('#termShellSel');
    const known = Array.from(sel.options).some((o) => o.value === st.shell);
    if (!known && st.shell) addCustomOption(st.shell);
    sel.value = st.shell || '';
  }

  function addCustomOption(v) {
    const sel = $('#termShellSel');
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    sel.insertBefore(opt, sel.querySelector('option[value="__custom"]'));
  }

  /* ---------------- 会话 ---------------- */

  function resetView() {
    const term = ensure();
    st.note = '';
    st.noteKind = '';
    term.reset();
    term.write('\x1b[90m连接中…\x1b[0m\r\n');
  }

  async function openContainer(container, { workdir = '' } = {}) {
    if (!container) return null;
    if (!container.state || container.state !== 'running') {
      toast('容器未运行', { type: 'err', hint: '先启动容器，再打开终端' });
      return null;
    }
    if (st.target && st.target.type === 'container' && st.target.id === container.id && st.sid) {
      show();
      ensure().focus();
      return null;
    }
    await shutdown('切换容器');
    st.target = { type: 'container', id: container.id, name: container.name, image: container.image, workdir };
    show();
    resetView();
    renderHead();
    return create('容器', () => api(`/api/containers/${encodeURIComponent(container.id)}/term`, {
      method: 'POST',
      body: { shell: st.shell || '', cols: st.cols, rows: st.rows, workdir },
    }));
  }

  async function openImage(image) {
    await shutdown('切换镜像');
    st.target = { type: 'image', id: '', name: image, image, workdir: '' };
    show();
    resetView();
    renderHead();
    return create('镜像', () => api('/api/term', {
      method: 'POST',
      body: { image, shell: st.shell || '', cols: st.cols, rows: st.rows },
    }));
  }

  async function create(what, opener) {
    st.busy = true;
    st.ended = false;
    try {
      const sess = await opener();
      st.sid = sess.id;
      st.target.id = sess.container.id;
      st.target.name = sess.container.name;
      st.cols = sess.cols || st.cols;
      st.rows = sess.rows || st.rows;
      if (sess.ephemeral) st.target.type = 'image';
      ensure().reset();
      renderHead();
      if (deps.onContainersChanged) { try { deps.onContainersChanged(); } catch (_) {} }
      pump(sess.id);
      setTimeout(() => { layout(); ensure().focus(); }, 20);
      return sess;
    } catch (e) {
      st.ended = true;
      const msg = (e && e.message) || String(e);
      ensure().write(`\x1b[31m${msg}\x1b[0m\r\n${(e && e.hint) ? '\x1b[90m' + e.hint + '\x1b[0m\r\n' : ''}`);
      status('打开失败', 'bad');
      toast(`${what}终端打开失败：${msg}`, { type: 'err', hint: e && e.hint });
      return null;
    } finally {
      st.busy = false;
    }
  }

  async function pump(sid) {
    const ac = new AbortController();
    st.abort = ac;
    try {
      const res = await fetch(`/api/term/${sid}/stream${tokenQuery()}`, {
        headers: authHeaders(),
        signal: ac.signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = JSON.parse(await res.text()).error.message || msg; } catch (_) {}
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) st.term.write(value);
      }
      ended('会话已结束');
    } catch (e) {
      if (ac.signal.aborted) return;
      ended((e && e.message) || '输出流中断');
    }
  }

  function ended(reason) {
    if (st.sid === null && st.ended) return;
    st.sid = null;
    st.ended = true;
    if (st.abort) {
      try { st.abort.abort(); } catch (_) {}
      st.abort = null;
    }
    try { st.term.write(`\r\n\x1b[90m── ${reason}（点「重启」重开）──\x1b[0m\r\n`); } catch (_) {}
    status(reason, 'bad');
    if (deps.onContainersChanged) { try { deps.onContainersChanged(); } catch (_) {} }
  }

  function send(text) {
    if (!st.sid || !text) return;
    st.queue.push(text);
    if (st.flushTimer) return;
    st.flushTimer = setTimeout(flush, 8);
  }

  async function flush() {
    st.flushTimer = null;
    const text = st.queue.join('');
    st.queue = [];
    const sid = st.sid;
    if (!text || !sid) return;
    try {
      await fetch(`/api/term/${sid}/input${tokenQuery()}`, {
        method: 'POST',
        headers: authHeaders(),
        body: new TextEncoder().encode(text),
      });
    } catch (_) {
      // 断线由输出流感知，这里不打扰用户
    }
  }

  function scheduleResize() {
    if (st.resizeTimer) clearTimeout(st.resizeTimer);
    st.resizeTimer = setTimeout(() => {
      st.resizeTimer = null;
      const sid = st.sid;
      if (!sid) return;
      fetch(`/api/term/${sid}/resize${tokenQuery()}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: st.cols, rows: st.rows }),
      }).catch(() => {});
    }, 160);
  }

  async function restart() {
    const t = st.target;
    if (!t) return;
    const keep = { ...t };
    await shutdown('重启');
    st.target = keep;
    if (keep.type === 'image') {
      show();
      resetView();
      return create('镜像', () => api('/api/term', {
        method: 'POST',
        body: { image: keep.image, shell: st.shell || '', cols: st.cols, rows: st.rows },
      }));
    }
    show();
    resetView();
    return create('容器', () => api(`/api/containers/${encodeURIComponent(keep.id)}/term`, {
      method: 'POST',
      body: { shell: st.shell || '', cols: st.cols, rows: st.rows, workdir: keep.workdir || '' },
    }));
  }

  async function shutdown(reason = '关闭') {
    const sid = st.sid;
    st.sid = null;
    if (st.abort) {
      try { st.abort.abort(); } catch (_) {}
      st.abort = null;
    }
    if (st.flushTimer) { clearTimeout(st.flushTimer); st.flushTimer = null; }
    st.queue = [];
    if (!sid) return;
    try {
      await fetch(`/api/term/${sid}/close${tokenQuery()}`, { method: 'POST', headers: authHeaders() });
    } catch (_) {
      // 服务端可能已经回收
    }
    void reason;
  }

  async function close() {
    await shutdown('用户关闭');
    st.target = null;
    st.ended = false;
    hide();
    if (deps.onContainersChanged) { try { deps.onContainersChanged(); } catch (_) {} }
  }

  /* ---------------- 交互绑定 ---------------- */

  function bind() {
    $('#termClose').onclick = () => close();
    $('#termClear').onclick = () => { ensure().clear(); ensure().focus(); };
    $('#termRestart').onclick = () => restart();
    $('#termShellSel').onchange = onShellChange;
    syncShellSel();

    const grip = $('#termGrip');
    let dragging = false;
    let startY = 0;
    let startH = 0;
    grip.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startH = st.height;
      document.body.classList.add('term-resizing');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      applyHeight(startH + (startY - e.clientY));
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('term-resizing');
      layout();
    });
    window.addEventListener('resize', () => { if (st.open) layout(); });

    // Ctrl+` 全局开关（终端聚焦时也要能用，所以走捕获阶段）
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === '`') {
        e.preventDefault();
        e.stopPropagation();
        if (st.open) close();
        else if (deps.getCurrent && deps.getCurrent()) openContainer(deps.getCurrent(), { workdir: deps.getPath ? deps.getPath() : '' });
        return;
      }
    }, true);
  }

  async function onShellChange() {
    const sel = $('#termShellSel');
    let v = sel.value;
    if (v === '__custom') {
      const custom = await ask('自定义 shell', '可以是 /bin/bash，也可以带参数，例如 /bin/busybox sh', {
        value: st.shell || '/bin/bash',
        placeholder: 'shell 命令',
        okText: '使用',
      });
      if (!custom) { syncShellSel(); return; }
      v = custom;
      addCustomOption(v);
    }
    st.shell = v;
    safeSet(SHELL_KEY, v);
    syncShellSel();
    if (st.target) restart();
  }

  /* ---------------- 对外 ---------------- */

  return {
    bind,
    show,
    hide,
    close,
    restart,
    openContainer,
    openImage,
    isOpen: () => st.open,
    hasSession: () => Boolean(st.sid),
    currentContainerId: () => (st.target && st.target.id ? st.target.id : ''),
    focus: () => { if (st.open) ensure().focus(); },
    onContainerChanged() {
      if (st.open && st.target && st.target.type === 'container' && !st.sid) renderHead();
    },
  };
}

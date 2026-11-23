/* dockfile 前端：零依赖 SPA */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const S = {
  engine: null,
  containers: [],
  containerFilter: '',
  current: null,
  path: '/',
  kind: 'dir',
  entries: [],
  truncated: false,
  history: [],
  hIndex: -1,
  selection: new Set(),
  cursor: -1,
  filter: '',
  showHidden: false,
  sort: 'name',
  drawer: null,
  token: localStorage.getItem('dockfile-token') || '',
  busy: false,
  uploads: [],
  endpointList: null,
};

const MAX_RENDER = 1200;
const TEXT_LIMIT = 2 * 1024 * 1024;

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let x = n / 1024, i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) + ' ' + u[i];
}
function fmtTime(sec) {
  const n = Number(sec) || 0;
  if (!n) return '—';
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function modeStr(perms, type) {
  const head = type === 'dir' ? 'd' : type === 'symlink' ? 'l' : type === 'char' ? 'c' : type === 'block' ? 'b' : type === 'fifo' ? 'p' : '-';
  const m = Number(perms) & 0o7777;
  let out = head;
  for (let i = 2; i >= 0; i--) {
    out += (m >> (i * 3 + 2)) & 1 ? 'r' : '-';
    out += (m >> (i * 3 + 1)) & 1 ? 'w' : '-';
    out += (m >> (i * 3)) & 1 ? 'x' : '-';
  }
  return out;
}
const isHidden = (name) => String(name).startsWith('.');
function joinPath(dir, name) {
  return (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + String(name).replace(/^\/+/, '');
}
function dirName(p) {
  if (p === '/') return '/';
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
function withToken(url) {
  if (!S.token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(S.token);
}
function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}
const TEXT_EXT = new Set('txt log md conf cfg ini yml yaml env sh bash zsh py js mjs cjs ts tsx jsx json xml toml sql go rs java kt c h cpp hpp cs rb php pl lua css scss html htm vue svg pem crt key service properties dockerfile makefile nginx gitignore'.split(' '));
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
const VID_EXT = new Set(['mp4', 'webm', 'mov']);
const AUD_EXT = new Set(['mp3', 'wav', 'ogg', 'flac']);

/* ---------------- 通知 ---------------- */

function toast(msg, { type = '', hint = '', ms = 4200 } = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<div>${esc(msg)}</div>${hint ? `<span class="t-hint">${esc(hint)}</span>` : ''}`;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ---------------- API ---------------- */

class ApiError extends Error {
  constructor(status, payload) {
    super((payload && payload.error && payload.error.message) || `HTTP ${status}`);
    this.status = status;
    this.code = (payload && payload.error && payload.error.code) || 'ERROR';
    this.hint = (payload && payload.error && payload.error.hint) || '';
    this.payload = payload;
  }
}

async function api(path, { method = 'GET', body, retry = true } = {}) {
  const headers = {};
  if (S.token) headers['X-Auth'] = S.token;
  let payload;
  if (body !== undefined && !(body instanceof Blob)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else {
    payload = body;
  }
  const res = await fetch(path, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (res.status === 401 && retry) {
    const token = await ask('需要访问令牌', '这个 dockfile 启用了 --token，请输入访问令牌。', { type: 'text', placeholder: '令牌' });
    if (token) {
      S.token = token;
      localStorage.setItem('dockfile-token', token);
      return api(path, { method, body, retry: false });
    }
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/* ---------------- 弹窗 ---------------- */

function ask(title, desc, { type = 'text', value = '', placeholder = '', okText = '确定', extraHTML = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalDesc').textContent = desc || '';
    $('#modalDesc').hidden = !desc;
    const body = $('#modalBody');
    body.innerHTML = extraHTML + (type === 'text' ? `<label class="fld"><span>${esc(placeholder || '值')}</span><input id="modalInput" value="${esc(value)}" autocomplete="off"></label>` : '');
    $('#modalOk').textContent = okText;
    const input = body.querySelector('#modalInput');
    const close = (v) => { dlg.close(); dlg.onclose = null; resolve(v); };
    dlg.onclose = () => resolve(null);
    dlg.querySelector('#modalOk').onclick = (e) => { e.preventDefault(); close(input ? input.value.trim() : true); };
    dlg.querySelector('#modalCancel').onclick = (e) => { e.preventDefault(); close(null); };
    dlg.showModal();
    if (input) setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

function confirmBox(title, desc, { danger = false, okText = '确定' } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalDesc').textContent = desc || '';
    $('#modalDesc').hidden = !desc;
    $('#modalBody').innerHTML = '';
    const ok = $('#modalOk');
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'danger' : 'accent');
    const close = (v) => { dlg.close(); dlg.onclose = null; resolve(v); };
    dlg.onclose = () => resolve(null);
    ok.onclick = (e) => { e.preventDefault(); close(true); };
    $('#modalCancel').onclick = (e) => { e.preventDefault(); close(false); };
    dlg.showModal();
  });
}

/* ---------------- 引擎 ---------------- */

async function loadHealth() {
  try {
    const h = await api('/api/health');
    S.engine = h;
    const chip = $('#engineChip');
    chip.className = 'engine-chip ' + (h.ok ? 'ok' : 'bad');
    const kindText = { 'wsl-relay': 'relay', 'wsl-stdio': 'stdio', npipe: 'pipe', unix: 'unix', tcp: 'tcp' }[h.kind] || h.kind || '—';
    const main = h.distro || (h.kind === 'tcp' ? (h.label || '').replace(/^tcp\s*/, '') : h.label) || '未连接';
    chip.innerHTML = `<span class="dot"></span><span class="kind">${esc(kindText)}</span><span>${esc(main)}</span>`
      + (h.readonly ? '<span class="tag">只读</span>' : '');
    chip.title = h.ok
      ? `${h.label} · engine ${h.serverVersion || '?'} · API ${h.apiVersion}${h.readonly ? ' · 只读模式' : ''}`
      : (h.error || '未连接 Docker 引擎');
    $('#stEngine').textContent = h.ok ? `${kindText} · API ${h.apiVersion}` : '引擎未连接';
    document.body.classList.toggle('readonly', Boolean(h.readonly));
    if (!h.ok) {
      setTimeout(() => toast('未连接 Docker 引擎', { type: 'err', hint: h.error || '点击右上角「引擎」查看探测结果', ms: 8000 }), 400);
    }
  } catch (e) {
    $('#engineChip').className = 'engine-chip bad';
  }
}

async function loadContainers() {
  try {
    const r = await api('/api/containers');
    S.containers = r.containers || [];
    const prev = S.current && S.current.id;
    renderContainers();
    if (prev) {
      const again = S.containers.find((c) => c.id === prev);
      if (again) S.current = again;
      renderContainerTitle();
    }
  } catch (e) {
    renderContainers();
    toast('容器列表加载失败：' + e.message, { type: 'err', hint: e.hint || '' });
  }
}

function containerMatches(c, q) {
  if (!q) return true;
  q = q.toLowerCase();
  return c.name.toLowerCase().includes(q) || String(c.image || '').toLowerCase().includes(q) || c.compose.toLowerCase().includes(q);
}

function renderContainers() {
  const q = S.containerFilter.trim();
  const list = S.containers.filter((c) => containerMatches(c, q));
  $('#containerCount').textContent = String(S.containers.length);
  const ul = $('#containerList');
  ul.innerHTML = list.map((c) => {
    const active = S.current && S.current.id === c.id ? 'active' : '';
    const dead = c.state !== 'running' ? 'dead' : '';
    return `<li data-id="${esc(c.id)}" class="${active} ${dead}" title="${esc(c.name)} · ${esc(c.image)}">
      <span class="cs-dot ${esc(c.state)}"></span>
      <div class="c-body">
        <div class="c-name">${esc(c.name)}</div>
        <div class="c-meta">
          ${c.compose ? `<span class="proj">${esc(c.compose)}</span>` : ''}
          <span class="img">${esc(c.image || '')}</span>
        </div>
        <div class="c-meta"><span>${esc(c.status || c.state)}</span></div>
      </div>
    </li>`;
  }).join('') || `<li style="cursor:default;color:var(--muted-2);font-size:11px;padding:14px 10px;display:block">没有匹配的容器</li>`;

  const running = S.containers.filter((c) => c.state === 'running').length;
  $('#railFootText').textContent = `${running} running / ${S.containers.length} total`;
}

function renderContainerTitle() {
  const c = S.current;
  $('#ctName').textContent = c ? c.name : '未选择容器';
  $('#ctImage').textContent = c ? c.image : '';
  $('#ctState').className = 'state-dot ' + (c ? c.state : '');
  const actions = $('.actions');
  const old = $('#btnStartContainer');
  if (old) old.remove();
  if (c && c.state !== 'running') {
    const b = document.createElement('button');
    b.id = 'btnStartContainer';
    b.className = 'btn accent';
    b.textContent = '启动容器';
    b.title = '删除 / 重命名 / 改权限需要容器运行';
    b.onclick = async () => {
      try {
        await api(`/api/containers/${encodeURIComponent(c.id)}/start`, { method: 'POST' });
        toast('容器已启动', { type: 'ok' });
        await loadContainers();
        await loadDir(S.path, { push: false });
      } catch (e) { toast('启动失败：' + e.message, { type: 'err', hint: e.hint }); }
    };
    actions.insertBefore(b, actions.firstChild);
  }
}

/* ---------------- 目录浏览 ---------------- */

function crumbs(path) {
  const parts = path === '/' ? [] : path.slice(1).split('/');
  const out = [`<span class="cb ${parts.length ? '' : 'cur'}" data-path="/">/</span>`];
  let acc = '';
  parts.forEach((p, i) => {
    acc += '/' + p;
    out.push(`<span class="sepc">›</span>`);
    out.push(`<span class="cb ${i === parts.length - 1 ? 'cur' : ''}" data-path="${esc(acc)}">${esc(p)}</span>`);
  });
  return out.join('');
}

function filteredEntries() {
  let list = S.entries.slice();
  if (!S.showHidden) list = list.filter((e) => !isHidden(e.name));
  if (S.filter.trim()) {
    const q = S.filter.trim().toLowerCase();
    list = list.filter((e) => e.name.toLowerCase().includes(q));
  }
  const dirFirst = (a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1);
  if (S.sort === 'size') list.sort((a, b) => (a.size || 0) - (b.size || 0) || a.name.localeCompare(b.name));
  else if (S.sort === 'mtime') list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  else if (S.sort === 'type') list.sort((a, b) => extOf(a.name).localeCompare(extOf(b.name)) || a.name.localeCompare(b.name));
  else list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
  return list;
}

function iconFor(e) {
  if (e.type === 'dir') return ['dir', '#i-dir', 'icon-fill'];
  if (e.type === 'symlink' || e.type === 'link') return ['symlink', '#i-link', ''];
  if ((e.mode & 0o111) !== 0) return ['exec', '#i-file', ''];
  if (e.type === 'char' || e.type === 'block' || e.type === 'fifo' || e.type === 'socket') return ['special', '#i-file', ''];
  return ['file', '#i-file', ''];
}

function renderRows() {
  const list = filteredEntries();
  const body = $('#fileRows');
  const shown = list.slice(0, MAX_RENDER);
  const empty = $('#emptyState');

  if (!S.current) {
    body.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = `<span class="big">▦</span><b>左侧选择一个容器</b><br>支持运行中与已停止的容器`;
    return;
  }
  if (!list.length) {
    body.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = S.filter
      ? `<span class="big">∅</span><b>没有匹配「${esc(S.filter)}」的条目</b>`
      : `<span class="big">⌷</span><b>这个目录是空的</b><br>拖拽文件到这里就可以上传`;
    return;
  }
  empty.hidden = true;
  body.innerHTML = shown.map((e, i) => {
    const [cls, href, fill] = iconFor(e);
    const sel = S.selection.has(e.name) ? 'selected' : '';
    const cur = i === S.cursor ? 'cursor' : '';
    const link = e.type === 'symlink' && e.linkTarget ? `<span class="f-link">→ ${esc(e.linkTarget)}</span>` : '';
    return `<tr data-name="${esc(e.name)}" data-type="${esc(e.type)}" class="${sel} ${cur}" style="animation-delay:${Math.min(i, 24) * 12}ms">
      <td class="c-name"><div class="namecell"><svg class="icon ${fill} f-icon ${cls}"><use href="${href}"/></svg><span class="f-name ${e.type === 'dir' ? 'dir' : ''}">${esc(e.name)}</span>${link}</div></td>
      <td class="c-size">${e.type === 'dir' ? '—' : fmtSize(e.size)}</td>
      <td class="c-mode">${modeStr(e.mode, e.type)}</td>
      <td class="c-time">${fmtTime(e.mtime)}</td>
      <td class="c-act"><button class="btn icon sm ghost" data-act="menu" title="更多">⋯</button></td>
    </tr>`;
  }).join('');

  if (list.length > MAX_RENDER) {
    toast(`目录共有 ${list.length} 项，仅渲染前 ${MAX_RENDER} 项`, { hint: '用「过滤当前目录」缩小范围', ms: 6000 });
  }
  if (S.truncated) {
    toast('目录条目过多，结果已被截断', { type: 'err', hint: S.hint || '建议启动容器后重试，或进入更具体的子目录', ms: 6000 });
  }
}

function applySelection() {
  $$('#fileRows tr').forEach((tr) => {
    const name = tr.getAttribute('data-name');
    tr.classList.toggle('selected', S.selection.has(name));
    tr.classList.remove('cursor');
  });
  const rows = $$('#fileRows tr');
  if (S.cursor >= 0 && rows[S.cursor]) rows[S.cursor].classList.add('cursor');
  const n = S.selection.size;
  $('#selInfo').textContent = n ? `已选 ${n} 项` : '';
  $('#stHint').textContent = n ? 'Del 删除 · F2 重命名 · Ctrl+C 复制路径' : '拖拽文件到此处即可上传 · ? 查看快捷键';
}

function renderStatus() {
  $('#stPath').textContent = S.path || '—';
  $('#stCount').textContent = `${S.entries.length} 项${S.filter ? `（过滤后 ${filteredEntries().length}）` : ''}`;
  $('#pathInput').value = S.path;
  $('#crumbs').hidden = S.path === '/';
  $('#crumbs').innerHTML = crumbs(S.path);
  $('#btnUp').disabled = S.path === '/';
  $('#btnBack').disabled = S.hIndex <= 0;
  $('#btnFwd').disabled = S.hIndex >= S.history.length - 1;
}

async function loadDir(path, { push = true, keepCursor = false } = {}) {
  if (!S.current) return;
  const id = S.current.id;
  const busy = $('#busy');
  if (busy) busy.hidden = false;
  let res;
  try {
    res = await api(`/api/containers/${encodeURIComponent(id)}/ls?path=${encodeURIComponent(path)}`);
  } finally {
    if (busy) busy.hidden = true;
  }
  if (res.kind === 'file') {
    // 路径是文件：跳到父目录并打开预览
    await loadDir(res.parent, { push: false });
    const entry = S.entries.find((e) => e.name === res.stat.name);
    if (entry) openDrawer(entry);
    return;
  }
  S.path = res.path;
  S.kind = res.kind;
  S.entries = res.entries || [];
  S.truncated = Boolean(res.truncated);
  S.hint = res.hint || '';
  if (!keepCursor) { S.selection.clear(); S.cursor = -1; }
  if (push) {
    S.history = S.history.slice(0, S.hIndex + 1);
    S.history.push(S.path);
    S.hIndex = S.history.length - 1;
  }
  localStorage.setItem('dockfile-path:' + id, S.path);
  // 切换目录时收起抽屉（有未保存修改则保留，避免丢失编辑）
  if (S.drawer && !S.drawer.dirty) {
    S.drawer = null;
    $('#drawer').hidden = true;
    document.body.classList.remove('drawer-open');
  }
  renderRows();
  renderStatus();
  applySelection();
}

async function selectContainer(c) {
  if (S.current && S.current.id === c.id) return;
  S.current = c;
  S.history = []; S.hIndex = -1;
  S.entries = []; S.selection.clear(); S.cursor = -1;
  S.filter = ''; $('#filter').value = '';
  renderContainers();
  renderContainerTitle();
  const remembered = localStorage.getItem('dockfile-path:' + c.id) || '/';
  try {
    await loadDir(remembered, { push: true });
  } catch (e) {
    if (remembered !== '/') { try { await loadDir('/', { push: true }); return; } catch (_) {} }
    toast('打开目录失败：' + e.message, { type: 'err', hint: e.hint });
  }
}

/* ---------------- 文件动作 ---------------- */

function entryByName(name) { return S.entries.find((e) => e.name === name); }

function selectedEntries() {
  return Array.from(S.selection).map(entryByName).filter(Boolean);
}

function downloadUrl(entry) {
  const id = S.current.id;
  return withToken(`/api/containers/${encodeURIComponent(id)}/file?path=${encodeURIComponent(joinPath(S.path, entry.name))}&name=${encodeURIComponent(entry.name)}`);
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  // 带 download 属性：同源请求变成下载，不会把页面导航走（避免中断后连接被占住）
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 500);
}

async function downloadEntry(entry) {
  if (!S.current) return;
  if (entry.type === 'dir') {
    triggerDownload(withToken(`/api/containers/${encodeURIComponent(S.current.id)}/download?path=${encodeURIComponent(joinPath(S.path, entry.name))}&gzip=1`), `${entry.name}.tar.gz`);
    toast(`正在打包下载 ${entry.name}`, { hint: '目录以 .tar.gz 形式下载' });
    return;
  }
  triggerDownload(downloadUrl(entry), entry.name);
}

async function deleteSelected() {
  const list = selectedEntries();
  if (!list.length) { toast('先选择要删除的文件'); return; }
  const names = list.map((e) => joinPath(S.path, e.name));
  const ok = await confirmBox('删除确认', `将从容器内永久删除 ${names.length} 个条目：\n${names.slice(0, 6).join('\n')}${names.length > 6 ? '\n…' : ''}`, { danger: true, okText: '删除' });
  if (!ok) return;
  try {
    await api(`/api/containers/${encodeURIComponent(S.current.id)}/delete`, { method: 'POST', body: { paths: names } });
    toast(`已删除 ${names.length} 项`, { type: 'ok' });
    S.selection.clear();
    await loadDir(S.path, { push: false });
    if (S.drawer && S.drawer.entry && S.selection.size === 0 && names.includes(joinPath(S.path, S.drawer.entry.name))) closeDrawer();
  } catch (e) {
    toast('删除失败：' + e.message, { type: 'err', hint: e.hint });
  }
}

async function renameEntry(entry) {
  const from = joinPath(S.path, entry.name);
  const to = await ask('重命名', from, { placeholder: '新路径', value: from, okText: '重命名' });
  if (!to || to === from) return;
  try {
    await api(`/api/containers/${encodeURIComponent(S.current.id)}/rename`, { method: 'POST', body: { from, to } });
    toast('已重命名', { type: 'ok' });
    await loadDir(S.path, { push: false });
  } catch (e) { toast('重命名失败：' + e.message, { type: 'err', hint: e.hint }); }
}

async function chmodEntry(entry) {
  const mode = await ask('修改权限', joinPath(S.path, entry.name), { placeholder: '八进制权限', value: (entry.mode & 0o777).toString(8).padStart(3, '0'), okText: '应用' });
  if (!mode) return;
  try {
    await api(`/api/containers/${encodeURIComponent(S.current.id)}/chmod`, { method: 'POST', body: { path: joinPath(S.path, entry.name), mode } });
    toast('权限已修改', { type: 'ok' });
    await loadDir(S.path, { push: false });
  } catch (e) { toast('修改权限失败：' + e.message, { type: 'err', hint: e.hint }); }
}

async function newFile() {
  const name = await ask('新建文件', `目录：${S.path}`, { placeholder: '文件名（可含子目录）', okText: '创建' });
  if (!name) return;
  try {
    await api(`/api/containers/${encodeURIComponent(S.current.id)}/text?path=${encodeURIComponent(joinPath(S.path, name))}&mode=644`, { method: 'PUT', body: '' });
    await loadDir(S.path, { push: false });
    const entry = entryByName(name.split('/').pop());
    if (entry) openDrawer(entry, { edit: true });
  } catch (e) { toast('创建失败：' + e.message, { type: 'err', hint: e.hint }); }
}

async function newDir() {
  const name = await ask('新建文件夹', `目录：${S.path}`, { placeholder: '文件夹名（可含子目录）', okText: '创建' });
  if (!name) return;
  try {
    await api(`/api/containers/${encodeURIComponent(S.current.id)}/mkdir?path=${encodeURIComponent(joinPath(S.path, name))}`, { method: 'POST' });
    await loadDir(S.path, { push: false });
  } catch (e) { toast('创建失败：' + e.message, { type: 'err', hint: e.hint }); }
}

/* ---------------- 行内菜单 ---------------- */

let rowMenuEl = null;
function closeRowMenu() { if (rowMenuEl) { rowMenuEl.remove(); rowMenuEl = null; } }
function showRowMenu(entry, x, y) {
  closeRowMenu();
  const el = document.createElement('div');
  el.className = 'rowmenu';
  const items = entry.type === 'dir'
    ? [['打开', () => loadDir(joinPath(S.path, entry.name))], ['打包下载', () => downloadEntry(entry)], ['重命名', () => renameEntry(entry)], ['权限', () => chmodEntry(entry)], ['删除', () => { S.selection = new Set([entry.name]); deleteSelected(); }, true]]
    : [['预览', () => openDrawer(entry)], ['下载', () => downloadEntry(entry)], ['重命名', () => renameEntry(entry)], ['权限', () => chmodEntry(entry)], ['删除', () => { S.selection = new Set([entry.name]); deleteSelected(); }, true]];
  el.innerHTML = items.map(([label, , danger], i) => `<button class="rm-item ${danger ? 'danger' : ''}" data-i="${i}">${label}</button>`).join('');
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('.rm-item');
    if (!b) return;
    const fn = items[Number(b.dataset.i)][1];
    closeRowMenu();
    fn();
  });
  rowMenuEl = el;
  setTimeout(() => document.addEventListener('click', closeRowMenu, { once: true }), 0);
}

/* ---------------- 抽屉：预览 / 编辑 ---------------- */

function closeDrawer() {
  if (S.drawer && S.drawer.dirty) {
    if (!confirm('有未保存的修改，确定关闭？')) return;
  }
  S.drawer = null;
  $('#drawer').hidden = true;
  document.body.classList.remove('drawer-open');
}

async function openDrawer(entry, { edit = false } = {}) {
  if (entry.type === 'dir') { await loadDir(joinPath(S.path, entry.name)); return; }
  const id = S.current.id;
  const full = joinPath(S.path, entry.name);
  const drawer = $('#drawer');
  S.drawer = { entry, path: full, dirty: false, original: '', content: '', mode: entry.mode };
  drawer.hidden = false;
  document.body.classList.add('drawer-open');
  $('#dwName').textContent = entry.name;
  $('#dwPath').textContent = full;
  $('#dwMeta').innerHTML = `<span>类型 <b>${esc(entry.type)}</b></span><span>大小 <b>${fmtSize(entry.size)}</b></span><span>权限 <b>${modeStr(entry.mode, entry.type)}</b></span><span>时间 <b>${fmtTime(entry.mtime)}</b></span>`;
  $('#dwFoot').innerHTML = `<span>读取中…</span>`;
  const bodyEl = $('#dwBody');
  bodyEl.innerHTML = `<div class="binary-note">读取中…</div>`;

  const ext = extOf(entry.name);
  const raw = withToken(`/api/containers/${encodeURIComponent(id)}/raw?path=${encodeURIComponent(full)}`);

  try {
    if (entry.size > TEXT_LIMIT) {
      renderBinary(bodyEl, entry, '文件超过 2 MB，不在页面内预览。');
      return;
    }
    if (IMG_EXT.has(ext)) {
      bodyEl.innerHTML = `<div class="preview"><img src="${raw}" alt="${esc(entry.name)}"></div>`;
      $('#dwFoot').innerHTML = `<button class="btn" id="dwDownload2">下载原文件</button>`;
      $('#dwDownload2').onclick = () => downloadEntry(entry);
      return;
    }
    if (VID_EXT.has(ext)) {
      bodyEl.innerHTML = `<div class="preview"><video src="${raw}" controls></video></div>`;
      return;
    }
    if (AUD_EXT.has(ext)) {
      bodyEl.innerHTML = `<div class="preview"><audio src="${raw}" controls style="width:100%"></audio></div>`;
      return;
    }
    if (ext === 'pdf') {
      bodyEl.innerHTML = `<div class="preview"><iframe src="${raw}" title="pdf"></iframe></div>`;
      return;
    }
    const text = await api(`/api/containers/${encodeURIComponent(id)}/text?path=${encodeURIComponent(full)}`);
    if (text.binary) { renderBinary(bodyEl, entry, '检测到二进制内容（包含 NUL 字节）。'); return; }
    if (text.truncated) { renderBinary(bodyEl, entry, `文件 ${fmtSize(text.size)} 超过 2 MB，不支持内联编辑。`); return; }
    S.drawer.original = text.content;
    S.drawer.content = text.content;
    S.drawer.mode = text.mode || entry.mode;
    renderEditor(bodyEl, entry, text.content, edit);
  } catch (e) {
    bodyEl.innerHTML = `<div class="binary-note">读取失败：<span class="k">${esc(e.message)}</span><br>${esc(e.hint || '')}</div>`;
  }
}

function renderBinary(el, entry, why) {
  el.innerHTML = `<div class="binary-note">${esc(why)}<br><br>
    <span class="k">${esc(entry.name)}</span> · ${fmtSize(entry.size)} · ${esc(entry.type)}<br><br>
    <button class="btn accent" id="dwDl3">下载文件</button></div>`;
  $('#dwDl3').onclick = () => downloadEntry(entry);
  $('#dwFoot').innerHTML = `<span>二进制 / 大文件不内联显示</span>`;
}

function renderEditor(el, entry, content, edit) {
  const lines = content.split('\n').length;
  el.innerHTML = `<div class="editor-wrap">
      <div class="gutter" id="gutter">${Array.from({ length: lines }, (_, i) => i + 1).join('<br>')}</div>
      <textarea class="editor" id="editor" spellcheck="false" wrap="off"></textarea>
    </div>`;
  const ta = $('#editor');
  ta.value = content;
  ta.scrollTop = 0;
  const sync = () => {
    const g = $('#gutter');
    if (!g) return;
    const n = ta.value.split('\n').length;
    if (g.dataset.n !== String(n)) {
      g.dataset.n = String(n);
      g.innerHTML = Array.from({ length: n }, (_, i) => i + 1).join('<br>');
    }
    g.scrollTop = ta.scrollTop;
  };
  ta.oninput = () => {
    if (!S.drawer) return;
    S.drawer.content = ta.value;
    S.drawer.dirty = ta.value !== S.drawer.original;
    ta.classList.toggle('dirty', S.drawer.dirty);
    sync();
    renderDrawerFoot();
  };
  ta.onscroll = sync;
  ta.onkeydown = (ev) => {
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const s = ta.selectionStart, e2 = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(e2);
      ta.selectionStart = ta.selectionEnd = s + 2;
      ta.oninput();
    }
  };
  sync();
  renderDrawerFoot();
  if (edit) setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }, 60);
}

function renderDrawerFoot() {
  const d = S.drawer;
  if (!d) return;
  const canEdit = !document.body.classList.contains('readonly');
  $('#dwFoot').innerHTML = `
    <span>${esc(modeStr(d.mode, 'file'))}</span>
    <span>${d.dirty ? '<b style="color:var(--amber)">未保存</b>' : '已同步'}</span>
    <div class="spacer"></div>
    <button class="btn" id="dwSave" ${canEdit ? '' : 'disabled'}>保存 (Ctrl+S)</button>
    <button class="btn accent" id="dwDownload3">下载</button>`;
  $('#dwSave').onclick = saveDrawer;
  $('#dwDownload3').onclick = () => d.entry && downloadEntry(d.entry);
}

async function saveDrawer() {
  const d = S.drawer;
  if (!d || !S.current) return;
  const mode = (d.mode & 0o777).toString(8).padStart(3, '0');
  try {
    await api(`/api/containers/${encodeURIComponent(S.current.id)}/text?path=${encodeURIComponent(d.path)}&mode=${mode}`, { method: 'PUT', body: d.content });
    d.dirty = false;
    d.original = d.content;
    toast('已保存', { type: 'ok' });
    renderDrawerFoot();
    await loadDir(S.path, { push: false });
  } catch (e) {
    toast('保存失败：' + e.message, { type: 'err', hint: e.hint });
  }
}

/* ---------------- 上传 ---------------- */

function trayShow() { $('#uploadTray').hidden = false; }
function trayRender() {
  const tray = $('#uploadTray');
  if (!S.uploads.length) { tray.hidden = true; return; }
  const done = S.uploads.filter((u) => u.state === 'done').length;
  const fail = S.uploads.filter((u) => u.state === 'error').length;
  tray.hidden = false;
  tray.innerHTML = `<div class="ut-head">UPLOAD <span>${done}/${S.uploads.length}</span>${fail ? `<span style="color:var(--red)">${fail} 失败</span>` : ''}<div class="spacer"></div><button class="btn icon sm ghost" id="utClose">×</button></div>` +
    S.uploads.map((u) => `<div class="ut-item">
      <div class="ut-name" title="${esc(u.path)}">${esc(u.path)}</div>
      <div class="ut-state ${u.state}">${u.state === 'done' ? '完成' : u.state === 'error' ? '失败' : u.pct != null ? u.pct + '%' : '等待'}</div>
      <div class="ut-bar ${u.state === 'error' ? 'err' : u.state === 'done' ? 'ok' : ''}"><i style="width:${u.pct || (u.state === 'done' ? 100 : 0)}%"></i></div>
    </div>`).join('');
  const close = $('#utClose');
  if (close) close.onclick = () => { S.uploads = []; trayRender(); };
}

function uploadOne(item) {
  return new Promise((resolve) => {
    const qs = new URLSearchParams({ path: S.path, name: item.path });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/containers/${encodeURIComponent(S.current.id)}/upload?${qs}`);
    if (S.token) xhr.setRequestHeader('X-Auth', S.token);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        item.pct = Math.max(1, Math.floor((e.loaded / e.total) * 100));
        item.state = 'uploading';
        trayRender();
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { item.state = 'done'; item.pct = 100; }
      else {
        item.state = 'error';
        let msg = `HTTP ${xhr.status}`;
        try { msg = JSON.parse(xhr.responseText).error.message; } catch (_) {}
        item.error = msg;
      }
      trayRender();
      resolve();
    };
    xhr.onerror = () => { item.state = 'error'; item.error = '网络错误'; trayRender(); resolve(); };
    item.state = 'uploading';
    trayRender();
    xhr.send(item.file);
  });
}

async function runUploadQueue(items) {
  if (!items.length || !S.current) return;
  // 同名冲突确认（只查顶层）
  const names = new Set(S.entries.map((e) => e.name));
  const clash = items.filter((it) => names.has(it.path.split('/')[0]));
  if (clash.length) {
    const ok = await confirmBox('覆盖确认', `当前目录已存在：${Array.from(new Set(clash.map((c) => c.path.split('/')[0]))).slice(0, 6).join('、')}\n继续上传会覆盖同名文件。`, { okText: '覆盖上传' });
    if (!ok) return;
  }
  S.uploads = items.map((it) => ({ ...it, state: 'pending', pct: 0 }));
  trayShow(); trayRender();

  let i = 0;
  const CONC = 3;
  const workers = Array.from({ length: Math.min(CONC, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await uploadOne(S.uploads[idx]);
    }
  });
  await Promise.all(workers);

  const failed = S.uploads.filter((u) => u.state === 'error');
  const ok = S.uploads.filter((u) => u.state === 'done');
  if (ok.length) toast(`上传完成 ${ok.length} 个文件`, { type: 'ok' });
  if (failed.length) toast(`${failed.length} 个文件上传失败`, { type: 'err', hint: failed[0].error || '' });
  await loadDir(S.path, { push: false });
}

/* ---- 目录拖拽：递归读取（一次最多 100 个条目） ---- */
function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const read = () => {
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        read();
      }, reject);
    };
    read();
  });
}

async function collectFromDataTransfer(dt) {
  const items = [];
  const roots = [];
  if (dt.items && dt.items.length) {
    for (const it of Array.from(dt.items)) {
      if (it.kind !== 'file') continue;
      const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
      if (entry) roots.push(entry);
      else if (it.getAsFile) { const f = it.getAsFile(); if (f) items.push({ file: f, path: f.name }); }
    }
  } else if (dt.files) {
    for (const f of Array.from(dt.files)) items.push({ file: f, path: f.name });
  }
  if (!roots.length) return items;

  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      items.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await readAllEntries(reader);
      if (!children.length) items.push({ emptyDir: prefix + entry.name });
      for (const child of children) await walk(child, prefix + entry.name + '/');
    }
  }
  for (const r of roots) await walk(r, '');
  return items;
}

async function uploadItems(rawItems) {
  if (!S.current) { toast('先选择容器'); return; }
  const items = [];
  const dirs = [];
  for (const it of rawItems) {
    if (it.emptyDir) dirs.push(it.emptyDir);
    else if (it.file) items.push({ file: it.file, path: it.path });
  }
  for (const d of dirs) {
    try { await api(`/api/containers/${encodeURIComponent(S.current.id)}/upload?path=${encodeURIComponent(S.path)}&dir=1&name=${encodeURIComponent(d)}`, { method: 'POST' }); }
    catch (e) { toast(`创建目录 ${d} 失败：${e.message}`, { type: 'err' }); }
  }
  await runUploadQueue(items);
}

async function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  dropDepth = 0;
  $('#dropOverlay').hidden = true;
  if (!S.current) { toast('先选择容器再拖拽上传'); return; }
  if (document.body.classList.contains('readonly')) { toast('只读模式：不能上传', { type: 'err' }); return; }
  try {
    const items = await collectFromDataTransfer(e.dataTransfer);
    if (!items.length) { toast('没有识别到文件'); return; }
    await uploadItems(items);
  } catch (err) {
    toast('上传失败：' + err.message, { type: 'err' });
  }
}

let dropDepth = 0;
function initDrop() {
  const zone = document.body;
  zone.addEventListener('dragenter', (e) => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    dropDepth++;
    if (S.current && !document.body.classList.contains('readonly')) {
      $('#dropPath').textContent = S.path;
      $('#dropOverlay').hidden = false;
    }
  });
  zone.addEventListener('dragover', (e) => { if (Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  zone.addEventListener('dragleave', (e) => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0) $('#dropOverlay').hidden = true;
  });
  zone.addEventListener('drop', handleDrop);
  ['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => { if (Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); }));
}

/* ---------------- 事件绑定 ---------------- */

function initEvents() {
  $('#containerList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const c = S.containers.find((x) => x.id === li.dataset.id);
    if (c) selectContainer(c);
  });

  $('#containerFilter').addEventListener('input', (e) => { S.containerFilter = e.target.value; renderContainers(); });
  $('#btnRefreshContainers').onclick = () => loadContainers().then(() => toast('容器列表已刷新', { type: 'ok', ms: 1500 }));

  $('#filter').addEventListener('input', (e) => { S.filter = e.target.value; S.cursor = -1; renderRows(); applySelection(); renderStatus(); });
  $('#showHidden').addEventListener('change', (e) => { S.showHidden = e.target.checked; renderRows(); applySelection(); });
  $('#sortBy').addEventListener('change', (e) => { S.sort = e.target.value; renderRows(); applySelection(); });

  $('#pathForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = $('#pathInput').value.trim() || '/';
    loadDir(p).catch((err) => toast('跳转失败：' + err.message, { type: 'err', hint: err.hint }));
  });

  $('#btnGoPath').onclick = () => $('#pathForm').dispatchEvent(new Event('submit'));
  $('#btnUp').onclick = () => { if (S.path !== '/') loadDir(dirName(S.path)); };
  $('#btnBack').onclick = () => { if (S.hIndex > 0) { S.hIndex--; loadDir(S.history[S.hIndex], { push: false }); } };
  $('#btnFwd').onclick = () => { if (S.hIndex < S.history.length - 1) { S.hIndex++; loadDir(S.history[S.hIndex], { push: false }); } };
  $('#btnRefresh').onclick = () => loadDir(S.path, { push: false });
  $('#btnDownloadDir').onclick = () => {
    if (!S.current) return;
    const base = S.path === '/' ? 'root' : S.path.split('/').filter(Boolean).pop();
    triggerDownload(withToken(`/api/containers/${encodeURIComponent(S.current.id)}/download?path=${encodeURIComponent(S.path)}&gzip=1`), `${base}.tar.gz`);
    toast('正在打包当前目录…', { hint: `${S.path} → tar.gz` });
  };
  $('#btnUpload').onclick = () => $('#filePicker').click();
  $('#btnNewFile').onclick = newFile;
  $('#btnNewDir').onclick = newDir;

  $('#filePicker').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) await uploadItems(files.map((f) => ({ file: f, path: f.name })));
  });

  $('#crumbs').addEventListener('click', (e) => {
    const cb = e.target.closest('.cb');
    if (cb) loadDir(cb.dataset.path).catch((err) => toast(err.message, { type: 'err' }));
  });

  const tbody = $('#fileRows');
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-name]');
    if (!tr) return;
    const name = tr.dataset.name;
    const idx = $$('#fileRows tr').indexOf(tr);
    S.cursor = idx;
    if (e.target.closest('[data-act="menu"]')) { showRowMenu(entryByName(name), e.clientX, e.clientY); applySelection(); return; }
    if (e.ctrlKey || e.metaKey) {
      if (S.selection.has(name)) S.selection.delete(name); else S.selection.add(name);
    } else if (e.shiftKey && S.cursor >= 0 && S.lastCursor != null) {
      const rows = $$('#fileRows tr');
      const [a, b] = [Math.min(S.lastCursor, S.cursor), Math.max(S.lastCursor, S.cursor)];
      for (let i = a; i <= b; i++) S.selection.add(rows[i].dataset.name);
    } else {
      S.selection = new Set([name]);
      S.lastCursor = idx;
    }
    applySelection();
  });
  tbody.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr[data-name]');
    if (!tr) return;
    const entry = entryByName(tr.dataset.name);
    if (!entry) return;
    if (entry.type === 'dir') loadDir(joinPath(S.path, entry.name)).catch((err) => toast(err.message, { type: 'err', hint: err.hint }));
    else openDrawer(entry);
  });
  tbody.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr[data-name]');
    if (!tr) return;
    e.preventDefault();
    const entry = entryByName(tr.dataset.name);
    if (entry) { S.selection = new Set([entry.name]); applySelection(); showRowMenu(entry, e.clientX, e.clientY); }
  });

  $('#dwClose').onclick = closeDrawer;
  $('#dwDownload').onclick = () => S.drawer && downloadEntry(S.drawer.entry);
  $('#dwDelete').onclick = () => { if (S.drawer) { S.selection = new Set([S.drawer.entry.name]); deleteSelected(); } };

  $('#btnEndpoints').onclick = openEngineModal;
  $('#engineClose').onclick = () => $('#engineModal').close();
  $('#engineRefresh').onclick = () => refreshEndpoints(true);
  $('#btnHelp').onclick = () => $('#helpModal').showModal();
  $('#helpClose').onclick = () => $('#helpModal').close();

  document.addEventListener('click', (e) => { if (!e.target.closest('.rowmenu')) closeRowMenu(); });

  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', (e) => {
    if (S.drawer && S.drawer.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

function onKey(e) {
  const tag = (e.target && e.target.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    if (S.drawer) { e.preventDefault(); saveDrawer(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); $('#pathInput').focus(); $('#pathInput').select(); return; }
  if (e.key === 'Escape') {
    if (rowMenuEl) { closeRowMenu(); return; }
    const dlg = document.querySelector('dialog[open]');
    if (dlg) { dlg.close(); return; }
    closeDrawer();
    return;
  }
  if (typing) return;
  if (!S.current) return;
  const rows = $$('#fileRows tr[data-name]');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!rows.length) return;
    S.cursor = Math.max(0, Math.min(rows.length - 1, (S.cursor < 0 ? -1 : S.cursor) + (e.key === 'ArrowDown' ? 1 : -1)));
    S.selection = new Set([rows[S.cursor].dataset.name]);
    S.lastCursor = S.cursor;
    applySelection();
    rows[S.cursor].scrollIntoView({ block: 'nearest' });
    return;
  }
  if (e.key === 'Enter') {
    if (S.cursor < 0 || !rows[S.cursor]) return;
    const entry = entryByName(rows[S.cursor].dataset.name);
    if (!entry) return;
    if (entry.type === 'dir') loadDir(joinPath(S.path, entry.name)).catch((err) => toast(err.message, { type: 'err' }));
    else openDrawer(entry);
    return;
  }
  if (e.key === 'Backspace') { e.preventDefault(); if (S.path !== '/') loadDir(dirName(S.path)); return; }
  if (e.key === 'Delete') { deleteSelected(); return; }
  if (e.key === 'F2') { const s = selectedEntries()[0]; if (s) renameEntry(s); return; }
  if (e.key === 'F5') { e.preventDefault(); loadDir(S.path, { push: false }); return; }
  if (e.key === '?') { $('#helpModal').showModal(); return; }
}

/* ---------------- 引擎弹窗 ---------------- */

async function refreshEndpoints(refresh) {
  const list = $('#engineList');
  list.innerHTML = `<div class="binary-note">探测中…（WSL 首次访问可能需要 1-3 秒）</div>`;
  try {
    const r = await api('/api/endpoints' + (refresh ? '?refresh=1' : ''));
    S.endpointList = r;
    list.innerHTML = (r.endpoints || []).map((ep) => `
      <div class="engine-row ${r.current && r.current.key === ep.key ? 'current' : ''}" data-key="${esc(ep.key)}">
        <span class="dot ${ep.ok ? 'ok' : 'bad'}"></span>
        <div>
          <div class="e-label">${esc(ep.label)} ${r.current && r.current.key === ep.key ? '<span style="color:var(--amber)">· 当前</span>' : ''}</div>
          <div class="e-detail">${esc(ep.detail || '')}${ep.ok ? ` · API ${esc(ep.apiVersion || '?')} · engine ${esc(ep.serverVersion || '?')}` : ' · ' + esc(ep.error || '不可用')}</div>
        </div>
        <span class="e-lat">${ep.ok ? (ep.latencyMs > 0 ? ep.latencyMs + 'ms' : '就绪') : '—'}</span>
      </div>`).join('') || `<div class="binary-note">没有探测到任何端点</div>`;

    list.querySelectorAll('.engine-row').forEach((row) => {
      row.onclick = async () => {
        try {
          await api('/api/endpoints/select', { method: 'POST', body: { key: row.dataset.key } });
          toast('已切换引擎', { type: 'ok' });
          $('#engineModal').close();
          S.current = null; S.entries = [];
          await loadHealth();
          await loadContainers();
        } catch (e) { toast('切换失败：' + e.message, { type: 'err', hint: e.hint }); }
      };
    });
  } catch (e) {
    list.innerHTML = `<div class="binary-note">探测失败：${esc(e.message)}<br>${esc(e.hint || '')}</div>`;
  }
}

function openEngineModal() {
  $('#engineModal').showModal();
  refreshEndpoints(true);
}

/* ---------------- 启动 ---------------- */

async function boot() {
  initDrop();
  initEvents();
  await loadHealth();
  await loadContainers();
  if (S.containers.length) {
    const first = S.containers.find((c) => c.state === 'running') || S.containers[0];
    await selectContainer(first);
  } else {
    renderRows();
    $('#emptyState').hidden = false;
    $('#emptyState').innerHTML = `<span class="big">▦</span><b>没有找到容器</b><br>启动一个容器后点左上角刷新`;
  }
  renderStatus();
}

boot().catch((e) => {
  console.error(e);
  toast('初始化失败：' + e.message, { type: 'err' });
});

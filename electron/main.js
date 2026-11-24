'use strict';
/**
 * dockfile 桌面版（Electron 主进程）
 *
 * 复用 lib/server-core.js：在本机回环地址上起一个只有本进程知道的随机端口，
 * 用 BrowserWindow 加载它 —— 前后端代码与浏览器版完全一致，无需改动。
 */
const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, Menu, Tray, shell, dialog, session, Notification, nativeImage,
} = require('electron');

const { createDockfileServer } = require('../lib/server-core');
const pkg = require('../package.json');

const ICON = path.join(__dirname, 'icon.png');
const TRAY_ICON = path.join(__dirname, 'tray.png');

// 调试用：DOCKFILE_DEBUG_PORT=9222 npm run desktop —— 之后可用 CDP 连接窗口做自动化验证
if (process.env.DOCKFILE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.DOCKFILE_DEBUG_PORT);
}
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

let win = null;
let tray = null;
let core = null;
let appUrl = '';
let quitting = false;

/* ---------------- 窗口状态 ---------------- */

function statePath() { return path.join(app.getPath('userData'), 'window-state.json'); }

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch (_) {}
  return { width: 1440, height: 900, maximized: false };
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(statePath(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch (_) {}
}

/* ---------------- 下载 ---------------- */

function uniquePath(target) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 1000; i++) {
    const p = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function setupDownloads() {
  const ses = session.defaultSession;
  ses.on('will-download', (event, item) => {
    const name = item.getFilename() || 'download';
    const target = uniquePath(path.join(app.getPath('downloads'), name));
    item.setSavePath(target);
    item.once('done', (_e, state) => {
      if (state !== 'completed') return;
      try {
        const n = new Notification({
          title: '下载完成',
          body: `${name}\n${path.dirname(target)}`,
          icon: ICON,
          silent: true,
        });
        n.on('click', () => shell.showItemInFolder(target));
        n.show();
      } catch (_) {}
      // 让页面里的状态提示也刷新一次
      try { win && win.webContents.send('dockfile:downloaded', target); } catch (_) {}
    });
  });
}

/* ---------------- 菜单 / 托盘 ---------------- */

function buildMenu() {
  const template = [
    {
      label: 'dockfile',
      submenu: [
        { label: '在浏览器中打开', click: () => appUrl && shell.openExternal(appUrl) },
        { label: '打开下载目录', click: () => shell.openPath(app.getPath('downloads')) },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', click: () => win && win.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { label: '开发者工具', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '快捷键', click: () => win && win.webContents.executeJavaScript('document.getElementById("btnHelp").click()') },
        { label: '项目主页', click: () => shell.openExternal('https://github.com/laohuan12138/dockfile') },
        {
          label: `关于 dockfile ${pkg.version}`,
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: '关于 dockfile',
            message: `dockfile ${pkg.version}`,
            detail: 'Docker 容器文件管理器（桌面版）\n\n直连 Docker Engine API，Windows 上自动桥接 WSL 里的 Docker。\nMIT License © laohuan12138',
            buttons: ['好'],
            icon: ICON,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupTray() {
  try {
    let img = nativeImage.createFromPath(TRAY_ICON);
    if (img.isEmpty()) img = nativeImage.createFromPath(ICON);
    tray = new Tray(img.resize({ width: 16, height: 16 }));
    tray.setToolTip('dockfile · Docker 容器文件管理器');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 dockfile', click: showWindow },
      { label: '在浏览器中打开', click: () => appUrl && shell.openExternal(appUrl) },
      { label: '打开下载目录', click: () => shell.openPath(app.getPath('downloads')) },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('double-click', showWindow);
    tray.on('click', showWindow);
  } catch (e) {
    // 托盘失败不影响主窗口
    console.error('tray init failed:', e.message);
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------------- 主窗口 ---------------- */

function createWindow(state) {
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0f14',
    title: 'dockfile',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
    },
  });

  win.once('ready-to-show', () => {
    if (state.maximized) win.maximize();
    win.show();
    if (process.env.DOCKFILE_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('close', () => { saveWindowState(); });
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(appUrl)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (appUrl && url.startsWith(appUrl)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.webContents.on('before-input-event', (event, input) => {
    // F5 刷新（浏览器习惯）
    if (input.type === 'keyDown' && input.key === 'F5' && !input.control) {
      win.webContents.reload();
      event.preventDefault();
    }
  });

  win.loadURL(appUrl);
}

/* ---------------- 启动 / 退出 ---------------- */

async function boot() {
  core = createDockfileServer({
    port: 0, // 随机空闲端口，只给本窗口用
    bind: '127.0.0.1',
    readOnly: process.argv.includes('--read-only'),
    dockerHost: process.env.DOCKER_HOST || '',
    wslDistro: process.env.DOCKFILE_WSL_DISTRO || '',
    transport: process.env.DOCKFILE_TRANSPORT || 'auto',
    debug: Boolean(process.env.DOCKFILE_DEBUG),
  });
  try {
    const started = await core.start();
    appUrl = started.url;
  } catch (e) {
    dialog.showErrorBox('dockfile 启动失败', `无法在本机启动内部服务：\n${e.message}`);
    app.exit(1);
    return;
  }
  setupDownloads();
  buildMenu();
  createWindow(loadWindowState());
  setupTray();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(boot);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && appUrl) createWindow(loadWindowState());
    else showWindow();
  });

  app.on('window-all-closed', () => {
    quitting = true;
    app.quit();
  });

  app.on('before-quit', async (e) => {
    if (core && !quitting) { quitting = true; }
    if (!core) return;
    const c = core;
    core = null;
    e.preventDefault?.();
    try { await c.close(); } catch (_) {}
    app.exit(0);
  });
}

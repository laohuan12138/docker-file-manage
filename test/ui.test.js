'use strict';
/**
 * UI 冒烟 + 截图
 *
 *   node test/ui.test.js            # 默认用 mock engine（无需 Docker，产出可公开的截图）
 *   UI_LIVE=1 node test/ui.test.js  # 用真实引擎（本机 Docker / WSL 里的 Docker）
 *
 * 产出：docs/*.png
 */
const fs = require('fs');
const path = require('path');
const { loadPlaywright, chromeExe, startServer, startMockEngine, ensureWslContainer } = require('./helpers');

const SHOTS = path.join(__dirname, '..', 'docs');
const PORT = Number(process.env.UI_PORT || 7791);
const LIVE = process.env.UI_LIVE === '1';
const CONTAINER = process.env.UI_CONTAINER || (LIVE ? 'dockfile-selftest' : 'web-nginx');
const UPLOAD_DIR = '/app/data';
// mock 模式优先占用标准端口 2375，这样不依赖 DOCKER_HOST 也能被自动发现（截图里的引擎列表更真实）
const MOCK_PORT = Number(process.env.UI_MOCK_PORT || 2375);

function log(ok, msg) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${msg}`);
  if (!ok) process.exitCode = 1;
}

/** 页面内取当前选中容器 id */
const ACTIVE_ID = `document.querySelector('.containers li.active').dataset.id`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  let mock = null;
  let serverArgs = [];
  let engineEnv = {};
  if (LIVE) {
    try {
      const st = ensureWslContainer(CONTAINER);
      console.log(`  · 真实引擎模式，测试容器 ${CONTAINER} ${st.created ? '已创建' : st.started ? '已启动' : '运行中'}`);
    } catch (e) {
      console.log('  · 无法准备测试容器（继续尝试）：' + e.message);
    }
  } else {
    let mockPort = MOCK_PORT;
    try {
      mock = await startMockEngine({ port: mockPort });
    } catch (e) {
      mockPort = MOCK_PORT + 1;
      mock = await startMockEngine({ port: mockPort });
    }
    if (mockPort === 2375) {
      serverArgs = ['--transport', 'socket']; // 只用本机端点探测，不碰 WSL
    } else {
      engineEnv = { DOCKER_HOST: mock.url };
    }
    console.log(`  · mock engine: ${mock.url}（容器 web-nginx / db-postgres）`);
  }

  const server = startServer({ port: PORT, args: serverArgs, env: engineEnv });
  const roServer = startServer({ port: PORT + 1, args: [...serverArgs, '--read-only'], env: engineEnv });
  const { chromium } = loadPlaywright();
  let browser;
  try {
    await server.ready({ timeout: LIVE ? 30000 : 15000 });
    await roServer.ready({ timeout: LIVE ? 30000 : 15000 });
    browser = await chromium.launch({ executablePath: chromeExe(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

    await page.goto(server.url + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('#containerList li');

    // 1) 引擎与容器列表
    const chip = (await page.locator('#engineChip').innerText()).replace(/\s+/g, ' ');
    log(/relay|stdio|unix|pipe|tcp/i.test(chip), `引擎徽标：${chip}`);
    const n = await page.locator('#containerList li').count();
    log(n > 0, `容器列表 ${n} 个`);

    // 2) 选中容器
    await page.locator(`#containerList li:has-text("${CONTAINER}")`).first().click();
    await page.waitForTimeout(700);
    const rows = await page.locator('#fileRows tr').count();
    log(rows > 0, `根目录渲染 ${rows} 行`);
    await page.screenshot({ path: path.join(SHOTS, '01-root.png') });

    // 清掉历史遗留的测试文件，保证截图干净
    await page.evaluate(async ({ id, dir }) => {
      const ls = await (await fetch(`/api/containers/${encodeURIComponent(id)}/ls?path=${encodeURIComponent(dir)}`)).json();
      const stale = (ls.entries || []).filter((e) => e.name.startsWith('drag-test-')).map((e) => `${dir}/${e.name}`);
      if (stale.length) {
        await fetch(`/api/containers/${encodeURIComponent(id)}/delete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: stale }),
        });
      }
    }, { id: await page.evaluate(ACTIVE_ID), dir: UPLOAD_DIR }).catch(() => {});

    // 3) 进入 /etc（双击）
    const etcRow = page.locator('#fileRows tr[data-name="etc"]').first();
    if (await etcRow.count()) {
      await etcRow.dblclick();
      await page.waitForTimeout(700);
      const p = await page.locator('#pathInput').inputValue();
      log(p === '/etc', `双击进入目录 → ${p}`);
      await page.screenshot({ path: path.join(SHOTS, '02-etc.png') });
    } else {
      log(false, '找不到 etc 目录');
    }

    // 4) 文本预览
    const fileRow = page.locator('#fileRows tr[data-name="hostname"], #fileRows tr[data-name="os-release"]').first();
    if (await fileRow.count()) {
      await fileRow.dblclick();
      await page.waitForSelector('#editor', { timeout: 20000 });
      const val = await page.locator('#editor').inputValue();
      log(val.length > 0, `预览文本 ${val.slice(0, 24).replace(/\n/g, '⏎')}…`);
      await page.waitForTimeout(400); // 等抽屉滑入动画结束
      await page.screenshot({ path: path.join(SHOTS, '03-preview.png') });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } else {
      log(false, '找不到文本文件');
    }

    // 5) 进到上传目录
    await page.locator('#pathInput').fill(UPLOAD_DIR);
    await page.locator('#pathForm').dispatchEvent('submit');
    await page.waitForTimeout(800);

    // 6) 新建文件 → 编辑 → Ctrl+S（写链路 e2e）
    const noteName = 'ui-note-' + Date.now() + '.txt';
    await page.locator('#btnNewFile').click();
    await page.waitForSelector('#modalInput', { timeout: 5000 });
    await page.locator('#modalInput').fill(noteName);
    await page.locator('#modalOk').click();
    await page.waitForSelector('#editor', { timeout: 20000 });
    await page.locator('#editor').fill('written by playwright 中文也行\nsecond line');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, '03b-editor.png') });
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(900);
    const saved = await page.evaluate(async ({ id, name, dir }) => {
      const r = await fetch(`/api/containers/${encodeURIComponent(id)}/text?path=${encodeURIComponent(dir + '/' + name)}`);
      const j = await r.json();
      return j.content || '';
    }, { id: await page.evaluate(ACTIVE_ID), name: noteName, dir: UPLOAD_DIR });
    log(/written by playwright/.test(saved), `Ctrl+S 保存生效（${saved.length} 字节）`);
    await page.keyboard.press('Escape');
    await page.evaluate(async ({ id, name, dir }) => {
      await fetch(`/api/containers/${encodeURIComponent(id)}/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [`${dir}/${name}`] }),
      });
    }, { id: await page.evaluate(ACTIVE_ID), name: noteName, dir: UPLOAD_DIR });
    await page.waitForTimeout(400);

    // 7) 拖拽上传
    const fname = 'drag-test-' + Date.now() + '.txt';
    const content = 'dockfile drag and drop ok\n中文内容\n';
    await page.evaluate(async ({ fname, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], fname, { type: 'text/plain' }));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    }, { fname, content });
    await page.waitForTimeout(500);
    const overlayVisible = await page.locator('#dropOverlay').isVisible().catch(() => false);
    log(!overlayVisible, '释放后遮罩已收起');
    await page.waitForFunction(
      (name) => Array.from(document.querySelectorAll('#fileRows .f-name')).some((el) => el.textContent === name),
      fname, { timeout: 20000 },
    ).then(() => log(true, `拖拽上传后列表出现 ${fname}`)).catch(() => log(false, '拖拽上传后列表未出现文件'));
    await page.screenshot({ path: path.join(SHOTS, '04-upload.png') });

    // 8) 容器内读回校验
    const readBack = await page.evaluate(async ({ id, name, dir }) => {
      const r = await fetch(`/api/containers/${encodeURIComponent(id)}/text?path=${encodeURIComponent(dir + '/' + name)}`);
      const j = await r.json();
      return { status: r.status, content: j.content };
    }, { id: await page.evaluate(ACTIVE_ID), name: fname, dir: UPLOAD_DIR });
    log(readBack.status === 200 && /drag and drop ok/.test(readBack.content || ''), `容器内读回内容一致（${String(readBack.content).length} 字节）`);

    // 9) 下载
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.evaluate(async ({ id, name, dir }) => {
        const a = document.createElement('a');
        a.href = `/api/containers/${encodeURIComponent(id)}/file?path=${encodeURIComponent(dir + '/' + name)}&name=${encodeURIComponent(name)}`;
        a.download = name;
        document.body.appendChild(a); a.click();
      }, { id: await page.evaluate(ACTIVE_ID), name: fname, dir: UPLOAD_DIR }),
    ]);
    log(download.suggestedFilename() === fname, `下载文件名 ${download.suggestedFilename()}`);
    const savedTo = path.join(__dirname, 'download-check.txt');
    await download.saveAs(savedTo);
    log(fs.readFileSync(savedTo, 'utf8').includes('drag and drop ok'), '下载内容校验通过');
    fs.unlinkSync(savedTo);

    // 10) 引擎弹窗
    await page.locator('#btnEndpoints').click();
    await page.waitForSelector('.engine-row', { timeout: 30000 });
    log((await page.locator('.engine-row').count()) > 0, `引擎弹窗列出 ${await page.locator('.engine-row').count()} 个候选端点`);
    await page.screenshot({ path: path.join(SHOTS, '05-endpoints.png') });
    await page.keyboard.press('Escape');

    // 11) 已停止容器
    const stoppedName = await page.evaluate(async () => {
      const r = await (await fetch('/api/containers')).json();
      const c = r.containers.find((x) => x.state !== 'running');
      return c ? c.name : '';
    });
    if (stoppedName) {
      await page.locator(`#containerList li:has-text("${stoppedName}")`).first().click();
      await page.waitForTimeout(2500);
      const stopped = await page.evaluate(() => ({
        rows: document.querySelectorAll('#fileRows tr').length,
        startBtn: Boolean(document.querySelector('#btnStartContainer')),
      }));
      log(stopped.rows > 0 && stopped.startBtn, `已停止容器 ${stoppedName}：${stopped.rows} 行 + 启动按钮`);
      await page.screenshot({ path: path.join(SHOTS, '06-stopped.png') });
    } else {
      log(false, '没有已停止的容器可展示');
    }

    // 12) 只读模式
    const roPage = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 2 });
    await roPage.goto(roServer.url + '/', { waitUntil: 'networkidle' });
    await roPage.waitForSelector('#containerList li');
    await roPage.waitForTimeout(1200);
    const ro = await roPage.evaluate(() => ({
      chip: document.querySelector('#engineChip').innerText.replace(/\s+/g, ' '),
      uploadHidden: !document.querySelector('#btnUpload')?.offsetParent,
      newFileHidden: !document.querySelector('#btnNewFile')?.offsetParent,
      termHidden: !document.querySelector('#btnTerm')?.offsetParent,
      rows: document.querySelectorAll('#fileRows tr').length,
    }));
    log(/只读/.test(ro.chip) && ro.uploadHidden && ro.newFileHidden && ro.termHidden, `只读模式：写入口与终端都已隐藏（${ro.rows} 行可浏览）`);
    await roPage.screenshot({ path: path.join(SHOTS, '07-readonly.png') });
    await roPage.close();

    // 13) 容器终端
    await page.locator(`#containerList li:has-text("${CONTAINER}")`).first().click();
    await page.waitForTimeout(400);
    // 切到 /etc 再开终端：既能验证 workdir，截图也干净
    await page.locator('#pathInput').fill('/etc');
    await page.locator('#pathForm').dispatchEvent('submit');
    await page.waitForTimeout(700);
    await page.evaluate(() => { const t = document.querySelector('#uploadTray'); if (t) t.hidden = true; });
    const termDisabled = await page.locator('#btnTerm').isDisabled();
    log(!termDisabled, '运行中容器「终端」按钮可用');
    await page.locator('#btnTerm').click();
    await page.waitForFunction(
      () => /#\s*$/.test((document.querySelector('.xterm-rows') || {}).textContent || ''),
      null, { timeout: 25000 },
    ).then(() => log(true, '终端拿到 shell 提示符')).catch(() => log(false, '终端未拿到提示符'));
    await page.locator('.term-body').click();
    await page.keyboard.type('uname -a\n');
    await page.waitForFunction(
      () => /Linux/.test((document.querySelector('.xterm-rows') || {}).textContent || ''),
      null, { timeout: 10000 },
    ).then(() => log(true, '终端内执行命令有输出')).catch(() => log(false, '终端命令无输出'));
    await page.keyboard.type('cat passwd\n');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, '08-terminal.png') });

    // 镜像弹窗 + 镜像进 shell（只在 mock 模式跑，真机不碰用户的镜像）
    if (!LIVE) {
      await page.locator('#btnImages').click();
      await page.waitForSelector('.image-row', { timeout: 15000 });
      const imgCount = await page.locator('.image-row').count();
      log(imgCount > 0, `镜像弹窗列出 ${imgCount} 个镜像`);
      await page.screenshot({ path: path.join(SHOTS, '09-images.png') });
      await page.locator('.image-row').first().locator('[data-act="shell"]').click();
      await page.waitForFunction(
        () => /root@dockfile-shell/.test((document.querySelector('.xterm-rows') || {}).textContent || ''),
        null, { timeout: 25000 },
      ).then(() => log(true, '镜像进了临时容器 shell')).catch(() => log(false, '镜像 shell 未就绪'));
      const tag = await page.locator('#termTag').isVisible();
      log(tag, '终端头部标出「临时容器」');
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, '10-image-shell.png') });
      await page.locator('#termClose').click();
      await page.waitForTimeout(1500);
      const leftover = await page.evaluate(async () => {
        const r = await (await fetch('/api/containers')).json();
        return r.containers.filter((c) => c.ephemeral).length;
      });
      log(leftover === 0, `关闭终端后临时容器已删除（残留 ${leftover}）`);
    } else {
      await page.locator('#termClose').click();
      await page.waitForTimeout(600);
    }

    // 14) 清理
    await page.evaluate(async ({ id, name, dir }) => {
      await fetch(`/api/containers/${encodeURIComponent(id)}/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [`${dir}/${name}`] }),
      });
    }, { id: CONTAINER, name: fname, dir: UPLOAD_DIR }).catch(() => {});

    log(errors.length === 0, `控制台错误：${errors.length ? errors.join(' | ') : '无'}`);
    console.log(`\n截图目录：docs/  （${LIVE ? '真实引擎' : 'mock engine'}）`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.stop();
    await roServer.stop();
    if (mock) await mock.stop();
  }
})().catch((e) => {
  console.error('UI 测试失败：', e);
  process.exit(1);
});

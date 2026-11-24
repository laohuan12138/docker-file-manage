#!/usr/bin/env node
'use strict';
/**
 * 一键打 Windows 桌面版：npm run dist
 *
 * 为什么要拆成三步（而不是直接 electron-builder --win）：
 * electron-builder 为了给 exe 写图标/版本信息会下载 winCodeSign 包，这个包里有
 * macOS 的符号链接，普通 Windows 账户解压时会失败（"Cannot create symbolic link"）。
 * 所以这里先 --dir 出免签名的 unpacked 目录，再用 rcedit 自己写图标和版本信息，
 * 最后用 --prepackaged 复用这份目录产出 portable / nsis 两个安装包。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release');
const UNPACKED = path.join(OUT, 'win-unpacked');
const pkg = require(path.join(ROOT, 'package.json'));

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false', // 不签名
};

function run(args, label) {
  process.stdout.write(`\n▸ ${label}\n`);
  // 直接跑 electron-builder 的 JS 入口，避免 Windows 上 spawn .cmd 需要 shell 的坑
  const cli = require.resolve('electron-builder/out/cli/cli.js');
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, env, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✗ ${label} 失败（exit ${r.status}${r.error ? ' ' + r.error.message : ''}）`);
    process.exit(r.status || 1);
  }
}

function runNode(script, label) {
  process.stdout.write(`\n▸ ${label}\n`);
  const r = spawnSync(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✗ ${label} 失败（exit ${r.status}）`);
    process.exit(r.status || 1);
  }
}

function findRcedit() {
  const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cacheRoot)) return null;
  for (const dir of fs.readdirSync(cacheRoot)) {
    const p = path.join(cacheRoot, dir, 'rcedit-x64.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function stampExe() {
  const exe = path.join(UNPACKED, 'dockfile.exe');
  if (!fs.existsSync(exe)) {
    console.warn('  ! 找不到 dockfile.exe，跳过图标/版本信息写入');
    return;
  }
  const rcedit = findRcedit();
  if (!rcedit) {
    console.warn('  ! 本地没有 rcedit（electron-builder 缓存未生成），保留默认 exe 图标');
    console.warn('    可以先跑一次 npx electron-builder --win --x64 --dir 让它下载缓存');
    return;
  }
  const icon = path.join(ROOT, 'build', 'icon.ico');
  const args = [
    exe,
    '--set-icon', icon,
    '--set-file-version', `${pkg.version}.0`,
    '--set-product-version', pkg.version,
    '--set-version-string', 'ProductName', 'dockfile',
    '--set-version-string', 'FileDescription', 'dockfile — Docker 容器文件管理器',
    '--set-version-string', 'CompanyName', 'laohuan12138',
    '--set-version-string', 'LegalCopyright', 'MIT (c) laohuan12138',
    '--set-version-string', 'OriginalFilename', 'dockfile.exe',
  ];
  const r = spawnSync(rcedit, args, { stdio: 'inherit' });
  if (r.status !== 0) console.warn('  ! rcedit 执行失败，exe 图标可能仍是默认的');
  else process.stdout.write('  图标与版本信息已写入 dockfile.exe\n');
}

function main() {
  if (process.platform !== 'win32') {
    console.error('这个脚本只用于打 Windows 包；其他平台请直接用 npx electron-builder。');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(ROOT, 'build', 'icon.ico'))) {
    runNode('tools/make-icon.js', '生成图标');
  }
  run(['--win', '--x64', '--dir'], '① 打包 app 目录');
  process.stdout.write('\n▸ ② 写入图标与版本信息\n');
  stampExe();
  run(['--win', 'portable', 'nsis', '--x64', '--prepackaged', UNPACKED], '③ 生成 portable / 安装包');

  console.log('\n产物：');
  for (const f of fs.readdirSync(OUT)) {
    if (!/\.exe$/.test(f)) continue;
    const size = (fs.statSync(path.join(OUT, f)).size / 1024 / 1024).toFixed(1);
    console.log(`  release/${f}  (${size} MB)`);
  }
  console.log('');
}

main();


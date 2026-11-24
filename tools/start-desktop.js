#!/usr/bin/env node
'use strict';
/**
 * 开发模式启动桌面版：npm run desktop
 *
 * 直接用 electron 二进制（require('electron') 在普通 Node 下返回可执行文件路径）。
 * 顺手清掉 ELECTRON_RUN_AS_NODE —— 某些工具链会把它塞进环境变量，
 * 那会让 Electron 退化成纯 Node 进程，表现是 "app is undefined"。
 */
const { spawn } = require('child_process');
const path = require('path');

const electronBin = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [path.join(__dirname, '..'), ...process.argv.slice(2)];
const child = spawn(electronBin, args, { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code == null ? 0 : code));
child.on('error', (e) => {
  console.error('启动 Electron 失败：', e.message);
  console.error('试试：npm i -D electron（或设置 ELECTRON_MIRROR 后重装）');
  process.exit(1);
});

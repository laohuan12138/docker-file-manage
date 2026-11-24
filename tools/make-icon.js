#!/usr/bin/env node
'use strict';
/**
 * 生成桌面应用图标（无第三方依赖）：
 *   electron/icon.png  —— 窗口 / 托盘图标（256×256）
 *   build/icon.ico     —— Windows 打包图标（16/32/48/64/128/256 多尺寸，PNG 内嵌）
 *
 * 图案沿用界面 favicon 的「货柜」造型：深墨底 + 琥珀色箱体与竖向棱线。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SS = 4; // 超采样倍数

function parseColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function makeCanvas(size) {
  const w = size * SS;
  const buf = Buffer.alloc(w * w * 4);
  const px = (x, y, [r, g, b], a = 1) => {
    if (x < 0 || y < 0 || x >= w || y >= w) return;
    const i = (y * w + x) * 4;
    if (a >= 1) {
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
      return;
    }
    // 简单 alpha 混合（背景已不透明）
    const oa = buf[i + 3] / 255;
    const na = a + oa * (1 - a);
    buf[i] = Math.round((r * a + buf[i] * oa * (1 - a)) / na);
    buf[i + 1] = Math.round((g * a + buf[i + 1] * oa * (1 - a)) / na);
    buf[i + 2] = Math.round((b * a + buf[i + 2] * oa * (1 - a)) / na);
    buf[i + 3] = Math.round(na * 255);
  };
  return { w, buf, px };
}

function fillRounded(c, x0, y0, x1, y1, r, color) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r) c.px(x, y, color);
    }
  }
}

function line(c, x0, y0, x1, y1, width, color) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    for (let dy = -width / 2; dy <= width / 2; dy += 0.5) {
      for (let dx = -width / 2; dx <= width / 2; dx += 0.5) {
        if (Math.hypot(dx, dy) <= width / 2) c.px(Math.round(x + dx), Math.round(y + dy), color);
      }
    }
  }
}

function render(size) {
  const c = makeCanvas(size);
  const S = c.w;
  const bg = parseColor('#0b0f14');
  const panel = parseColor('#11161d');
  const amber = parseColor('#ffb020');
  const cyan = parseColor('#4cc9f0');

  fillRounded(c, 0, 0, S, S, S * 0.19, bg);
  // 内层「面板」
  fillRounded(c, S * 0.055, S * 0.055, S * 0.945, S * 0.945, S * 0.155, panel);

  // 箱体
  const lw = S * 0.052;
  const x0 = S * 0.185, x1 = S * 0.815, y0 = S * 0.315, y1 = S * 0.735;
  line(c, x0, y0, x1, y0, lw, amber);
  line(c, x1, y0, x1, y1, lw, amber);
  line(c, x1, y1, x0, y1, lw, amber);
  line(c, x0, y1, x0, y0, lw, amber);
  // 箱体横梁 + 竖棱
  line(c, x0, y0 + (y1 - y0) * 0.34, x1, y0 + (y1 - y0) * 0.34, lw * 0.85, amber);
  for (const t of [0.33, 0.5, 0.67]) {
    line(c, x0 + (x1 - x0) * t, y0, x0 + (x1 - x0) * t, y0 + (y1 - y0) * 0.34, lw * 0.85, amber);
  }
  // 箱体下方的一条青色「状态条」：与界面强调色呼应
  fillRounded(c, x0, y1 + S * 0.075, x1, y1 + S * 0.075 + S * 0.052, S * 0.026, cyan);

  // 降采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * c.w + (x * SS + dx)) * 4;
          r += c.buf[i]; g += c.buf[i + 1]; b += c.buf[i + 2]; a += c.buf[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---- PNG ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function toPng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO（PNG 内嵌，Vista+ 支持） ----
function toIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = [];
  for (const e of entries) {
    const b = Buffer.alloc(16);
    b[0] = e.size >= 256 ? 0 : e.size;
    b[1] = e.size >= 256 ? 0 : e.size;
    b[2] = 0; b[3] = 0;
    b.writeUInt16LE(1, 4);
    b.writeUInt16LE(32, 6);
    b.writeUInt32LE(e.png.length, 8);
    b.writeUInt32LE(offset, 12);
    offset += e.png.length;
    dir.push(b);
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => ({ size: s, png: toPng(render(s), s) }));

const electronDir = path.join(ROOT, 'electron');
const buildDir = path.join(ROOT, 'build');
fs.mkdirSync(electronDir, { recursive: true });
fs.mkdirSync(buildDir, { recursive: true });

const icon256 = pngs.find((p) => p.size === 256).png;
fs.writeFileSync(path.join(electronDir, 'icon.png'), icon256);
const small = pngs.find((p) => p.size === 32).png;
fs.writeFileSync(path.join(electronDir, 'tray.png'), small);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), toIco(pngs));

console.log(`  图标已生成：electron/icon.png (${icon256.length}B) · electron/tray.png · build/icon.ico (${sizes.join('/')})`);

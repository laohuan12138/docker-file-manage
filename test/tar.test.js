'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const {
  buildTarBuffer, TarWriter, listEntries, extractEntry, readFirstEntry, TarParser, parseHeader, paxRecord, padOf,
} = require('../lib/tar');

const big = Buffer.alloc(5000, 0x41);
const longName = 'd1/' + 'x'.repeat(120) + '.txt';

async function collect(tarBuf) {
  return listEntries(Readable.from([tarBuf]));
}

test('writer → reader 往返：目录/普通文件/中文名/长名/空文件', async () => {
  const buf = await buildTarBuffer([
    { dir: true, name: 'd1', mode: 0o755 },
    { name: 'd1/a.txt', data: Buffer.from('hello 世界\n'), mode: 0o600 },
    { name: 'd1/big.bin', data: big },
    { name: longName, data: Buffer.from('long') },
    { name: 'd1/empty.txt', data: Buffer.alloc(0) },
  ]);
  assert.equal(buf.length % 512, 0, 'tar 必须是 512 的整数倍');
  const { entries, truncated } = await collect(buf);
  assert.equal(truncated, false);
  assert.deepEqual(entries.map((e) => e.name), ['d1/', 'd1/a.txt', 'd1/big.bin', longName, 'd1/empty.txt']);
  assert.equal(entries[0].type, 'dir');
  assert.equal(entries[1].size, Buffer.byteLength('hello 世界\n'));
  assert.equal(entries[1].mode, 0o600);
  assert.equal(entries[2].size, 5000);
});

test('readFirstEntry 取第一个文件内容', async () => {
  const buf = await buildTarBuffer([
    { dir: true, name: 'a' },
    { name: 'a/one.txt', data: Buffer.from('第一') },
    { name: 'a/two.txt', data: Buffer.from('second') },
  ]);
  const { buffer, header } = await readFirstEntry(Readable.from([buf]));
  assert.equal(header.name, 'a/one.txt');
  assert.equal(buffer.toString('utf8'), '第一');
});

test('extractEntry 只吐目标条目（含跨块大数据）', async () => {
  const payload = Buffer.alloc(200000, 0x42);
  const buf = await buildTarBuffer([
    { name: 'x/a.bin', data: payload },
    { name: 'x/b.bin', data: Buffer.from('bbb') },
  ]);
  const chunks = [];
  const r = await extractEntry(Readable.from([buf]), 'x/a.bin', (c) => { chunks.push(c); return true; });
  assert.equal(r.header.name, 'x/a.bin');
  assert.equal(Buffer.concat(chunks).length, payload.length);
  assert.equal(Buffer.concat(chunks)[199999], 0x42);
});

test('符号链接条目往返', async () => {
  const buf = await buildTarBuffer([
    { name: 'link1', data: Buffer.alloc(0), mode: 0o777, linkname: '/etc/passwd', type: '2' },
  ]);
  const { entries } = await collect(buf);
  assert.equal(entries[0].name, 'link1');
  assert.equal(entries[0].type, 'symlink');
  assert.equal(entries[0].linkname, '/etc/passwd');
});

test('PAX 扩展头文件名解析', async () => {
  const name = 'dir/' + '长'.repeat(60) + '.md';
  const buf = await buildTarBuffer([{ name, data: Buffer.from('pax') }]);
  const { entries } = await collect(buf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, name);
});

test('流式写入 + 解析一致（TarWriter.addStream）', async () => {
  const { PassThrough } = require('stream');
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  const w = new TarWriter(out);
  await w.addStream('s/file.bin', Readable.from([Buffer.alloc(1500, 1), Buffer.alloc(1000, 2)]), 2500);
  await w.end();
  out.end();
  await new Promise((r) => out.on('end', r));
  const { entries } = await collect(Buffer.concat(chunks));
  assert.equal(entries[0].name, 's/file.bin');
  assert.equal(entries[0].size, 2500);
});

test('maxBytes 截断会标记 truncated', async () => {
  const buf = await buildTarBuffer([
    { name: 'a.bin', data: Buffer.alloc(100000, 1) },
    { name: 'b.bin', data: Buffer.alloc(100000, 2) },
  ]);
  const r = await listEntries(Readable.from([buf]), { maxBytes: 4096 });
  assert.equal(r.truncated, true);
});

test('maxEntries 限制条目数', async () => {
  const buf = await buildTarBuffer(Array.from({ length: 50 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') })));
  const r = await listEntries(Readable.from([buf]), { maxEntries: 10 });
  assert.equal(r.entries.length, 10);
  assert.equal(r.truncated, true);
});

test('paxRecord 长度自洽', () => {
  const rec = paxRecord('path', 'a/b/c');
  const len = parseInt(rec.toString().split(' ')[0], 10);
  assert.equal(len, rec.length);
  assert.equal(padOf(513), 511);
});

test('截断的 tar 流不会挂死', async () => {
  const buf = await buildTarBuffer([{ name: 'a.bin', data: Buffer.alloc(2048, 7) }]);
  const partial = buf.subarray(0, 700);
  const { entries } = await listEntries(Readable.from([partial]));
  assert.equal(entries[0].name, 'a.bin');
  assert.equal(entries[0].size, 2048);
});

test('parseHeader 处理 base-256 大小字段', () => {
  const { buildHeader } = require('../lib/tar');
  const h = buildHeader({ name: 'x.bin', size: 0 });
  // 手工构造 base-256 的 size（0x80 前缀）
  h.fill(0, 124, 136);
  h[124] = 0x80;
  h[135] = 10;
  // 重算校验和
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  h[154] = 0;
  h[155] = 0x20;
  const parsed = parseHeader(h);
  assert.equal(parsed.size, 10);
});

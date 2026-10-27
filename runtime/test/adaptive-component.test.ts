import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadComponentFile, verifyComponentFile } from '../src/memory/adaptive-component.ts';

const text = Buffer.from('公开合成组件字节 abcdefghijklmnop');
const spec = { path: 'fixture.bin', size: text.length, sha256: createHash('sha256').update(text).digest('hex') };
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quetzal-component-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return path.join(root, 'fixture.bin');
}
const signal = () => new AbortController().signal;
const mock = (run: (init: RequestInit) => Response | Promise<Response>) => (async (_url: unknown, init: RequestInit) => run(init)) as typeof fetch;

test('有部分文件时严格核对 Range，完成后校验摘要并原子安装', async (t) => {
  const file = await fixture(t); await fs.writeFile(file + '.part', text.subarray(0, 8));
  let requested = false;
  await downloadComponentFile(file, spec, 'https://example.invalid/fixture', signal(), () => {}, mock((init) => {
    assert.equal(new Headers(init.headers).get('range'), 'bytes=8-'); requested = true;
    return new Response(text.subarray(8), { status: 206, headers: { 'content-range': `bytes 8-${text.length - 1}/${text.length}` } });
  }));
  assert(requested); assert(await verifyComponentFile(file, spec)); await assert.rejects(fs.stat(file + '.part'), { code: 'ENOENT' });
  await downloadComponentFile(file, spec, 'https://example.invalid/fixture', signal(), () => {}, mock(() => { throw new Error('不应重复下载'); }));
});

test('服务器忽略 Range 返回200时从零写入，错误范围和摘要绝不成为完整组件', async (t) => {
  const file = await fixture(t); await fs.writeFile(file + '.part', text.subarray(0, 8));
  await assert.rejects(downloadComponentFile(file, spec, 'https://example.invalid/fixture', signal(), () => {}, mock(() =>
    new Response(text.subarray(8), { status: 206, headers: { 'content-range': `bytes 7-${text.length - 1}/${text.length}` } }))), /range_invalid/);
  assert.deepEqual(await fs.readFile(file + '.part'), text.subarray(0, 8));
  await downloadComponentFile(file, spec, 'https://example.invalid/fixture', signal(), () => {}, mock(() => new Response(text)));
  assert(await verifyComponentFile(file, spec));
  await fs.rm(file); await assert.rejects(downloadComponentFile(file, spec, 'https://example.invalid/fixture', signal(), () => {}, mock(() => new Response(Buffer.alloc(text.length)))), /digest_invalid/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' }); await assert.rejects(fs.stat(file + '.part'), { code: 'ENOENT' });
});

test('传输中断保留已写入的部分，取消不发请求，超量响应不安装', async (t) => {
  const file = await fixture(t); let first = true;
  await assert.rejects(downloadComponentFile(file, spec, 'https://example.invalid/fixture', signal(), () => {}, mock(() => new Response(new ReadableStream({
    async pull(controller) {
      if (first) { first = false; controller.enqueue(text.subarray(0, 8)); }
      else { await new Promise((r) => setTimeout(r, 20)); controller.error(new Error('合成断线')); }
    },
  })))), /合成断线/);
  assert.equal((await fs.stat(file + '.part')).size, 8);
  await assert.rejects(downloadComponentFile(file, spec, 'https://example.invalid/fixture', AbortSignal.abort(), () => {}, mock(() => { throw new Error('不应发送'); })), /abort/i);
  await assert.rejects(downloadComponentFile(file, spec, 'https://example.invalid/fixture', signal(), () => {}, mock(() => new Response(Buffer.alloc(text.length + 1)))), /size_invalid/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('Git blob 摘要和 SHA256 同样拒绝等长篡改', async (t) => {
  const file = await fixture(t); await fs.writeFile(file, text);
  const git = createHash('sha1').update(`blob ${text.length}\0`).update(text).digest('hex');
  assert(await verifyComponentFile(file, { path: 'fixture.bin', size: text.length, git }));
  await fs.writeFile(file, Buffer.alloc(text.length));
  assert.equal(await verifyComponentFile(file, spec), false);
  assert.equal(await verifyComponentFile(file, { path: 'fixture.bin', size: text.length, git }), false);
});

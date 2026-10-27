// 分页边界与生命周期用可控传输；落库使用真实 SQLite，真实网状链路由 adaptive-mesh 另验。
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Mesh } from '../src/mesh/mesh.ts';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-mode-catchup-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../src/config.ts'); cfg.loadConfig();
const store = await import('../src/store.ts'); store.openStore();
const { installReplica } = await import('../src/mesh/replica.ts');
afterEach(() => store.db.exec('DELETE FROM message_modes; DELETE FROM messages; DELETE FROM sessions'));
after(() => { store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!f()) { if (Date.now() > deadline) throw new Error('分页测试超时'); await wait(10); }
}
class Transport extends EventEmitter {
  calls: number[] = [];
  read: (after: number) => Promise<unknown> = async () => [];
  pull: (params: any) => unknown = () => [];
  handle() {}
  broadcast() {}
  async request(_peer: string, method: string, params: { after: number }) {
    if (method === 'replica.pull') return this.pull(params);
    if (method !== 'replica.modes') return [];
    this.calls.push(params.after); return this.read(params.after);
  }
  connect() { this.emit('peer', { body: 'peer', link: 'open' }); }
  disconnect() { this.emit('peer', { body: 'peer', link: 'closed' }); }
}
const row = (id: number, revision = 1) => ({ id, mode: 'ignored', revision, writer: 'peer' });

test('AM-20：200501 条真实状态超过原上限后仍自动续扫，事件循环可继续运行', { timeout: 30_000 }, async (t) => {
  const mesh = new Transport(), total = 200_501;
  mesh.read = async (after) => Array.from({ length: Math.min(500, total - after) }, (_, i) => row(after + i + 1));
  const uninstall = installReplica(mesh as unknown as Mesh);
  let ticks = 0; const timer = setInterval(() => ticks++, 10);
  const start = performance.now();
  try {
    mesh.connect();
    await until(() => mesh.calls.at(-1) === total);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM message_modes').get()?.n, total);
    assert.equal(store.messageMode(total)?.mode, 'ignored');
    assert.ok(mesh.calls.includes(200_000), '没有停在旧的 400 页上限');
    assert.ok(ticks > 1, '分页之间允许其他事件运行');
    t.diagnostic(`${total} 条状态完整落库 ${(performance.now() - start).toFixed(0)}ms，事件循环 tick=${ticks}`);
    // 重连从头核对较小 ID 的新修订，而不是仅沿着旧最大 ID 继续。
    mesh.disconnect(); mesh.read = async (after) => after ? [] : [row(1, 2)]; mesh.connect();
    await until(() => store.messageMode(1)?.revision === 2);
  } finally { uninstall(); clearInterval(timer); }
});

test('断线或卸载后返回的旧页不能写入；重连新一代仍能正常补齐', async () => {
  const mesh = new Transport(); let finish!: (v: unknown) => void;
  mesh.read = () => new Promise((r) => { finish = r; });
  const uninstall = installReplica(mesh as unknown as Mesh);
  try {
    mesh.connect(); await until(() => !!finish);
    mesh.disconnect(); mesh.read = async (after) => after ? [] : [row(1, 2)]; mesh.connect();
    await until(() => store.messageMode(1)?.revision === 2);
    finish([row(1, 99)]); await wait(30);
    assert.equal(store.messageMode(1)?.revision, 2, '旧连接响应不覆盖新快照');
    mesh.disconnect(); let pending!: (v: unknown) => void;
    mesh.read = () => new Promise((r) => { pending = r; }); mesh.connect(); await until(() => !!pending);
    uninstall(); pending([row(1, 100)]); await wait(30);
    assert.equal(store.messageMode(1)?.revision, 2);
  } finally { uninstall(); }
});

test('临时请求失败从未完成的页重试，成功页不重复拉取', async () => {
  const mesh = new Transport(); let failed = false;
  mesh.read = async (after) => {
    if (!after) return [row(1)];
    if (!failed) { failed = true; throw new Error('合成连接超时'); }
    return after === 1 ? [row(2)] : [];
  };
  const uninstall = installReplica(mesh as unknown as Mesh);
  try {
    mesh.connect(); await until(() => mesh.calls.at(-1) === 2);
    assert.deepEqual(mesh.calls, [0, 1, 1, 2]); assert.equal(store.messageMode(2)?.revision, 1);
  } finally { uninstall(); }
});

test('未知旧方法与非递增分页都停止，不能形成无限循环或应用坏页', async () => {
  for (const read of [async () => { throw new Error('没有这个方法'); }, async () => [row(2), row(1)]]) {
    const mesh = new Transport(); mesh.read = read;
    const uninstall = installReplica(mesh as unknown as Mesh);
    try {
      mesh.connect(); await until(() => mesh.calls.length === 1); await wait(50);
      assert.equal(mesh.calls.length, 1); assert.equal(store.messageMode(1), undefined); assert.equal(store.messageMode(2), undefined);
    } finally { uninstall(); }
  }
});


test('高编号先到不能掩盖同一来源身体的低编号缺口', async () => {
  const mesh = new Transport(), prefix = store.idPrefixOf('peer'), base = prefix * store.ID_RANGE;
  const messages = [1, 2].map((n) => ({ id: base + n, ts: Date.now(), role: 'user', channel: '合成', text: `线索 ${n}`, session: 'gap', body: 'peer' }));
  store.applyRemote('messages', [messages[1]], { from: 'peer', catchUp: true });
  mesh.pull = (p) => p.table === 'messages' ? messages.filter((m) => m.id > (p.vector[String(prefix)] ?? 0)) : [];
  const uninstall = installReplica(mesh as unknown as Mesh);
  try {
    mesh.connect(); await until(() => mesh.calls.length > 0);
    assert.ok(store.db.prepare('SELECT 1 FROM messages WHERE id=?').get(base + 1), '不能只依靠已经见过的最大编号');
  } finally { uninstall(); }
});

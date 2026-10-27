// M2 语义传输：真实独立进程、网关令牌和签名 WebRTC；认识由合成测试直接安装。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { fakeSync } from './fixtures/fake-sync.ts';
import { loadNodeKey } from '../src/mesh/identity.ts';
import type { SemanticMemoryReading } from '../src/memory/adaptive.ts';

const until = async (f: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!await f()) { if (Date.now() > end) throw new Error('等待合成身体状态超时'); await new Promise((r) => setTimeout(r, 100)); }
};

test('双身体语义查询：实际认证传输、主模型接线、本机较新认识和来源冲突', { timeout: 100_000 }, async (t) => {
  // 此门禁不能靠跳过可选原生依赖通过。
  await import('node-datachannel');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-adaptive-mesh-'));
  const keys: Record<string, string> = {};
  for (const b of ['center', 'satellite', 'bridge']) {
    fs.mkdirSync(path.join(tmp, b, 'soul'), { recursive: true });
    fs.writeFileSync(path.join(tmp, b, 'soul', 'agent.json'), JSON.stringify({ id: 'x', name: 'synthetic', displayName: '合成身份' }));
    keys[b] = loadNodeKey(path.join(tmp, b, 'secrets', 'mesh_ed25519')).nodeKey;
  }
  const sync = await fakeSync(keys, { bridge: 'bridge' });
  const processes: ChildProcess[] = [], sockets: WebSocket[] = [];
  const uuids = new Map<string, string>();
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await Promise.all(processes.map(async (p) => {
      if (p.exitCode === null && p.signalCode === null) { const done = once(p, 'exit'); p.kill('SIGKILL'); await done; }
    }));
    sync.close(); fs.rmSync(tmp, { recursive: true, force: true });
  });
  async function spawn(name: string) {
    const p = fork(path.join(import.meta.dirname, 'fixtures', 'adaptive-body.ts'), [], {
      execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
      env: { ...process.env, QUETZAL_HOME: path.join(tmp, name), BODY: name, READER: String(name === 'bridge'), SYNC: sync.url, KEYS: JSON.stringify(keys) },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    processes.push(p);
    let seq = 0;
    const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('身体启动超时')), 20_000);
      p.once('exit', () => { clearTimeout(timer); reject(new Error('身体在就绪前退出')); for (const h of pending.values()) h.reject(new Error('身体退出')); });
      p.on('message', (m: any) => {
        if (m.ready) { clearTimeout(timer); resolve(m.port); }
        else { const h = pending.get(m.id); pending.delete(m.id); if (h) m.error ? h.reject(new Error(m.error)) : h.resolve(m.result); }
      });
    });
    const call = <T = any>(cmd: string, args?: unknown) => new Promise<T>((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject }); p.send({ id, cmd, args });
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`); sockets.push(ws);
    const responses = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
    const greeting = new Promise<void>((resolve) => ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.event === 'hello') resolve();
      const h = responses.get(m.id); responses.delete(m.id);
      if (h) m.error ? h.reject(new Error(m.error.message)) : h.resolve(m.result);
    }));
    await once(ws, 'open');
    ws.send(JSON.stringify({ auth: fs.readFileSync(path.join(tmp, name, 'secrets', 'gateway.token'), 'utf8').trim() }));
    await greeting;
    const rpc = <T = any>(method: string, params?: unknown) => new Promise<T>((resolve, reject) => {
      const id = ++seq; responses.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
    });
    const uuid = JSON.parse(fs.readFileSync(path.join(tmp, name, 'state', 'body-uuid'), 'utf8')).uuid;
    assert.match(uuid, /^[a-f0-9-]{36}$/);
    if (uuids.has(name)) assert.equal(uuid, uuids.get(name), '重启保持身体 UUID');
    else { assert.ok(![...uuids.values()].includes(uuid), '隔离身体 UUID 不相同'); uuids.set(name, uuid); }
    return { p, call, rpc, port };
  }
  let center = await spawn('center');
  const satellite = await spawn('satellite');
  const bridge = await spawn('bridge');
  assert.notEqual(center.port, satellite.port); assert.notEqual(keys.center, keys.satellite);
  await until(async () => (await satellite.call<string[]>('connected')).includes('center'));
  await until(async () => (await bridge.call<string[]>('connected')).includes('center'));

  await center.call('semanticHold'); await satellite.call('semanticHold');
  await center.rpc('memory.adaptive.configure', { enabled: true, hostBody: 'center', semantic: true });
  await until(async () => (await satellite.rpc('memory.adaptive.status')).semantic.enabled);
  await satellite.rpc('chat.send', { conv: 'semantic-origin', text: '港口采风线索来自编辑。' });
  await satellite.call('semanticHold');
  const source = (await satellite.call<any[]>('messages', { session: 'semantic-origin' })).find((m) => m.role === 'user'); assert.ok(source);
  await until(async () => (await center.call<any[]>('messages', { session: 'semantic-origin' })).some((m) => m.id === source.id));
  const claim = await center.call('semanticSeed', { source: source.id, text: '港口采风线索来自编辑' });
  const query = () => satellite.rpc<SemanticMemoryReading>('memory.adaptive.semantic.query', { query: '港口采风' });
  await until(async () => (await query()).items.some((i) => i.id === claim.id));
  const result = await query(); assert.equal(result.status, 'ready'); assert.equal(result.items[0].revision, 1);
  await t.test('真实网关与 mesh 查询保留身份边界，错误 agent 请求被拒绝', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${satellite.port}/rpc`); sockets.push(bad); await once(bad, 'open'); const closed = once(bad, 'close');
    bad.send(JSON.stringify({ id: 1, method: 'memory.adaptive.semantic.query', params: { query: '港口采风' } })); assert.equal((await closed)[0], 4401);
    await assert.rejects(satellite.call('semanticRequest', { body: 'center', params: { agent: 'other', query: '港口采风' } }), /范围/);
    await assert.rejects(bridge.call('semanticRequest', { body: 'center', params: { agent: 'x', query: '港口采风' } }), /只读成员不能调用/);
  });
  await t.test('另一身体主模型收到远端认识的具体版本', async () => {
    await satellite.rpc('chat.send', { conv: 'semantic-consumer', text: '回顾港口采风' }); await satellite.call('semanticHold');
    const requests = await satellite.call<string[]>('seen'); assert.ok(requests.some((r) => r.includes(claim.id) && r.includes('认识资料')));
    const plan = await satellite.call('contextPlan', { conv: 'semantic-consumer' });
    assert.ok(plan.selectedIds.includes(`memory:adaptive-semantic:${claim.id}:1`));
  });
  await t.test('原文尚未传播的编辑或忽略阻止旧主机结果复活', async () => {
    await satellite.call('localText', { id: source.id, text: '尚未传播的新文本' });
    assert.equal((await query()).status, 'unavailable');
    await satellite.call('localText', { id: source.id, text: source.text });
    await satellite.call('localMode', { id: source.id, mode: 'ignored' });
    assert.equal((await query()).status, 'unavailable');
    await satellite.call('localMode', { id: source.id, mode: null });
    assert.equal((await query()).status, 'ready');
  });
  await t.test('本机认识较新时拒绝旧主机，补齐相同权威结果后恢复', async () => {
    // 故障注入用原发布器安装完整权威文件，不冒充自动 Git 同步验收。
    await satellite.call('semanticImport', { rows: await center.call('semanticExport') });
    await satellite.rpc('chat.send', { conv: 'semantic-origin', text: '更正，港口采风线索来自弟弟。' }); await satellite.call('semanticHold');
    const corrected = (await satellite.call<any[]>('messages', { session: 'semantic-origin' })).filter((m) => m.role === 'user').at(-1)!;
    await until(async () => (await center.call<any[]>('messages', { session: 'semantic-origin' })).some((m) => m.id === corrected.id));
    await satellite.call('semanticSeed', { id: claim.id, source: corrected.id, text: '港口采风线索来自弟弟' });
    assert.equal((await query()).status, 'unavailable');
    await center.call('semanticImport', { rows: await satellite.call('semanticExport') });
    const current = await query(); assert.equal(current.status, 'ready'); assert.equal(current.items[0].revision, 2);
    assert.ok(JSON.stringify(current.items).includes('弟弟')); assert.ok(!JSON.stringify(current.items).includes('编辑'));
  });
  await t.test('本机原文被删除时不能当作尚未复制而接受旧主机结果', async () => {
    const currentSource = (await satellite.call<any[]>('messages', { session: 'semantic-origin' })).filter((m) => m.role === 'user').at(-1)!;
    await satellite.call('localDelete', { id: currentSource.id });
    const result = await query(); assert.equal(result.status, 'unavailable'); assert.deepEqual(result.items, []);
  });
  await t.test('主机进程退出后有界降级，不复用上次 ready', async () => {
    const exited = once(center.p, 'exit'); center.p.kill('SIGKILL'); await exited;
    const begin = performance.now(); assert.equal((await query()).status, 'unavailable'); assert.ok(performance.now() - begin < 1500);
  });
});

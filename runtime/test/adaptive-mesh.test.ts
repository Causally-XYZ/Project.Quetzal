// M1 集成门禁：真实独立进程、网关令牌、签名 WebRTC；回答模型和信令目录为本机替身。
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
import type { MemoryPacket } from '../src/memory/adaptive.ts';

const until = async (f: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!await f()) { if (Date.now() > end) throw new Error('等待合成身体状态超时'); await new Promise((r) => setTimeout(r, 100)); }
};

test('AM-11/12/15/20/21：真实双身体聊天、认证查询、集中处理、断线降级和进程重启补做', { timeout: 100_000 }, async (t) => {
  // 此门禁不能靠跳过可选原生依赖通过。
  await import('node-datachannel');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-adaptive-mesh-'));
  const keys: Record<string, string> = {};
  for (const b of ['center', 'satellite']) {
    fs.mkdirSync(path.join(tmp, b, 'soul'), { recursive: true });
    fs.writeFileSync(path.join(tmp, b, 'soul', 'agent.json'), JSON.stringify({ id: 'x', name: 'synthetic', displayName: '合成身份' }));
    keys[b] = loadNodeKey(path.join(tmp, b, 'secrets', 'mesh_ed25519')).nodeKey;
  }
  const sync = await fakeSync(keys);
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
      env: { ...process.env, QUETZAL_HOME: path.join(tmp, name), BODY: name, SYNC: sync.url, KEYS: JSON.stringify(keys) },
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
  assert.notEqual(center.port, satellite.port); assert.notEqual(keys.center, keys.satellite);
  await until(async () => (await satellite.call<string[]>('connected')).includes('center'));
  await center.rpc('memory.adaptive.configure', { enabled: true, hostBody: 'center' });
  await until(async () => (await satellite.rpc('memory.adaptive.status')).enabled);
  assert.equal((await satellite.rpc('memory.adaptive.status')).queue, null, '卫星不运行来源处理队列');

  await t.test('未认证网关与跨 agent 查询被拒绝', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${satellite.port}/rpc`); sockets.push(bad);
    await once(bad, 'open'); const closed = once(bad, 'close');
    bad.send(JSON.stringify({ id: 1, method: 'memory.adaptive.query', params: { query: '港口' } }));
    assert.equal((await closed)[0], 4401);
    await assert.rejects(satellite.call('request', { body: 'center', params: { agent: 'other', query: '港口' } }), /范围/);
  });

  let sourceId = 0;
  await t.test('真实 chat.send 落库、复制、处理，另一会话的主模型收到带来源材料', async () => {
    await satellite.rpc('chat.send', { conv: 'january', text: '港口采风：蓝色船屋有人修旧钟。' });
    const replies = await satellite.call<any[]>('messages', { session: 'january' });
    assert.ok(replies.some((m) => m.role === 'agent' && m.text === '合成模型已回答'), JSON.stringify(replies));
    const source = (await satellite.call<any[]>('messages', { session: 'january' })).find((m) => m.role === 'user');
    sourceId = source.id;
    await until(async () => (await satellite.rpc<MemoryPacket>('memory.adaptive.query', { query: '港口' })).observations.some((s) => s.id === sourceId));
    await satellite.rpc('chat.send', { conv: 'july', text: '港口采风有哪些旧材料？' });
    const seen = (await satellite.call<string[]>('seen')).map((s) => JSON.parse(s).messages).flat();
    assert.ok(seen.some((m) => JSON.stringify(m).includes('历史发言资料') && JSON.stringify(m).includes('蓝色船屋')),
      JSON.stringify(seen.map((m) => ({ role: m.role, length: JSON.stringify(m).length, excerpt: JSON.stringify(m).slice(-1500) }))));
    const before = await center.rpc('memory.adaptive.jobs');
    await satellite.call('duplicate', { id: sourceId });
    await new Promise((r) => setTimeout(r, 600));
    const jobs = await center.rpc<any[]>('memory.adaptive.jobs');
    assert.equal(jobs.filter((j) => j.source === sourceId).length, 1);
    assert.equal(jobs.find((j) => j.source === sourceId).id, before.find((j: any) => j.source === sourceId).id);
  });

  await t.test('中心 SIGKILL 后对话继续，重启同一数据目录自动补做', async () => {
    const dead = once(center.p, 'exit'); center.p.kill('SIGKILL'); await dead;
    await until(async () => !(await satellite.call<string[]>('connected')).includes('center'));
    const start = performance.now();
    assert.equal((await satellite.rpc<MemoryPacket>('memory.adaptive.query', { query: '港口' })).status, 'unavailable');
    assert.ok(performance.now() - start < 1000);
    await satellite.rpc('chat.send', { conv: 'offline', text: '离线补充：港口有紫色灯塔。' });
    assert.ok((await satellite.call<any[]>('messages', { session: 'offline' })).some((m) => m.role === 'agent' && m.text === '合成模型已回答'));
    center = await spawn('center');
    await until(async () => (await satellite.call<string[]>('connected')).includes('center'));
    await until(async () => (await satellite.rpc<MemoryPacket>('memory.adaptive.query', { query: '紫色灯塔' })).observations.some((s) => s.text.includes('紫色灯塔')));
    assert.equal((await center.rpc<any[]>('memory.adaptive.jobs')).filter((j) => j.source === sourceId).length, 1);
  });

  await t.test('AM-20：中心离线期间旧来源改为 ignored，重连后不可再查询', async () => {
    const dead = once(center.p, 'exit'); center.p.kill('SIGKILL'); await dead;
    await until(async () => !(await satellite.call<string[]>('connected')).includes('center'));
    await satellite.call('mode', { id: sourceId, mode: 'ignored' });
    center = await spawn('center');
    await until(async () => (await satellite.call<string[]>('connected')).includes('center'));
    // 必须检查中心数据库实际修订，不能只靠卫星的读取过滤让测试变绿。
    await until(async () => (await center.call<any[]>('messages', { session: 'january' })).find((m) => m.id === sourceId)?.mode === 'ignored');
    assert.ok(!(await center.rpc<MemoryPacket>('memory.adaptive.query', { query: '蓝色船屋' })).observations.some((s) => s.id === sourceId));
    assert.ok(!(await satellite.rpc<MemoryPacket>('memory.adaptive.query', { query: '蓝色船屋' })).observations.some((s) => s.id === sourceId));
    // 清空标记也是持久修订；再次离线、重启后恢复，不被旧 ignored 重放覆盖。
    const deadAgain = once(center.p, 'exit'); center.p.kill('SIGKILL'); await deadAgain;
    await until(async () => !(await satellite.call<string[]>('connected')).includes('center'));
    await satellite.call('mode', { id: sourceId, mode: null });
    center = await spawn('center');
    await until(async () => (await satellite.call<string[]>('connected')).includes('center'));
    await until(async () => (await center.rpc<MemoryPacket>('memory.adaptive.query', { query: '蓝色船屋' })).observations.some((s) => s.id === sourceId));
  });

  await t.test('实际网状读取延迟与在线来源失效', async () => {
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now(); const p = await satellite.rpc<MemoryPacket>('memory.adaptive.query', { query: '港口' });
      assert.equal(p.status, 'ready'); times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b); const p95 = times[Math.ceil(times.length * 0.95) - 1];
    t.diagnostic(`小型合成数据集，30 次网关→卫星→中心读取：P95 ${p95.toFixed(1)}ms`);
    assert.ok(p95 <= 300, `读取 P95 ${p95}ms`);
    await satellite.call('mode', { id: sourceId, mode: 'ignored' });
    await until(async () => !(await satellite.rpc<MemoryPacket>('memory.adaptive.query', { query: '蓝色船屋' })).observations.some((s) => s.id === sourceId));
  });

  await t.test('领取来源任务后真实强杀，重启自动回收租约且只产生一个完成回执', async () => {
    await center.call('seedGap'); await satellite.call('seedGap');
    const leased = await center.call<any>('lease');
    const dead = once(center.p, 'exit'); center.p.kill('SIGKILL'); await dead;
    center = await spawn('center');
    await until(async () => (await center.rpc<any[]>('memory.adaptive.jobs')).some((j) => j.id === leased.id && j.state === 'done'));
    const jobs = (await center.rpc<any[]>('memory.adaptive.jobs')).filter((j) => j.id === leased.id);
    await until(async () => (await center.call<any[]>('messages', { session: 'gap' })).length === 2);
    assert.equal(jobs.length, 1); assert.equal(jobs[0].attempts, 2); assert.equal(jobs[0].token, null);
    assert.ok((await center.rpc<MemoryPacket>('memory.adaptive.query', { query: '租约恢复测试来源' })).observations.some((o) => o.id === leased.source));
    await until(async () => (await satellite.call<string[]>('connected')).includes('center'));
  });

  await t.test('管理网关的开关与全网急停实际传播；解除后自动补做', async () => {
    await satellite.rpc('memory.adaptive.configure', { enabled: false, hostBody: 'center' });
    await until(async () => !(await center.rpc('memory.adaptive.status')).enabled);
    assert.equal((await center.rpc<MemoryPacket>('memory.adaptive.query', { query: '港口' })).status, 'disabled');
    await satellite.rpc('memory.adaptive.configure', { enabled: true, hostBody: 'center' });
    await until(async () => (await center.rpc('memory.adaptive.status')).enabled);
    await satellite.rpc('stop', { scope: 'all', reason: '合成多身体急停' });
    await until(async () => (await center.rpc('memory.adaptive.status')).stopped);
    assert.equal((await center.rpc<MemoryPacket>('memory.adaptive.query', { query: '港口' })).status, 'stopped');
    await satellite.rpc('unstop');
    await until(async () => !(await center.rpc('memory.adaptive.status')).stopped);
    assert.equal((await satellite.rpc<MemoryPacket>('memory.adaptive.query', { query: '港口' })).status, 'ready');
  });

  await t.test('一万条历史的冷查询与有无后台增量对照，各 100 次真实跨身体查询', async () => {
    assert.equal((await center.call('seedHistory')).count, 10_000);
    // 冷查询来自真实重启后的中心，而不是只换一个未见过的查询词。
    const exited = once(center.p, 'exit'); center.p.kill('SIGKILL'); await exited;
    await until(async () => !(await satellite.call<string[]>('connected')).includes('center'));
    center = await spawn('center');
    await until(async () => (await satellite.call<string[]>('connected')).includes('center'));
    const stats = (values: number[]) => {
      const sorted = values.toSorted((a, b) => a - b);
      return { n: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
    };
    async function measure(spacing = 0) {
      const times: number[] = []; let unavailable = 0;
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        const p = await satellite.rpc<MemoryPacket>('memory.adaptive.query', { query: '基准线索' });
        times.push(performance.now() - start);
        if (p.status !== 'ready') unavailable++;
        else assert.ok(p.observations.length, '不能用空检索伪装正常低延迟');
        if (spacing) await new Promise((r) => setTimeout(r, spacing));
      }
      return { ...stats(times), first: times[0], unavailable };
    }
    const idle = await measure();
    await center.call('startLoad');
    const busy = await measure(30);
    await until(async () => { const s = await center.call('loadState'); return s.count === 300 && s.latencies.length === 300; });
    const increments = stats((await center.call('loadState')).latencies);
    t.diagnostic(JSON.stringify({ corpus: 10_000, queryConcurrency: 1, incrementalInputPerSecond: 100, model: 'stub', idle, busy, increments }));
    assert.equal(idle.unavailable, 0); assert.equal(busy.unavailable, 0);
    assert.ok(idle.p95 <= 300 && busy.p95 <= 300, '跨身体读取 P95 超过门槛');
    assert.ok(increments.p95 <= 60_000, '持续输入导致增量饥饿');
  });

});

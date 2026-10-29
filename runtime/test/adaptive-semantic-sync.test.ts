// 认识由合成提案接受；之后只观察生产发布、Git 推拉和真实身体查询，不注入同步文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fakeSync } from './fixtures/fake-sync.ts';
import { loadNodeKey } from '../src/mesh/identity.ts';
import type { SemanticMemoryReading } from '../src/memory/adaptive.ts';

const until = async (f: () => Promise<boolean>, label: string, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!await f()) { if (Date.now() > end) throw new Error(`等待${label}超时`); await new Promise((r) => setTimeout(r, 100)); }
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString();
const stop = async (p: ChildProcess) => {
  if (p.exitCode === null && p.signalCode === null) { const done = once(p, 'exit'); p.kill('SIGKILL'); await done; }
};

test('认识自动传播：真实发件箱、Git 推拉、纠正和离线身体恢复', { timeout: 90_000 }, async (t) => {
  await import('node-datachannel'); // 必须有实际传输，不能以 skip 放行。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-semantic-sync-'));
  const processes: ChildProcess[] = [];
  const keys: Record<string, string> = {};
  for (const name of ['center', 'satellite']) keys[name] = loadNodeKey(path.join(tmp, name, 'secrets', 'mesh_ed25519')).nodeKey;
  const sync = await fakeSync(keys);
  t.after(async () => {
    try {
      for (const p of processes) if (p.exitCode === null && p.signalCode === null && p.connected) {
        await new Promise<void>((resolve, reject) => {
          const done = (m: any) => { if (m.id === -1) { clearTimeout(timer); p.off('message', done); m.error ? reject(new Error(m.error)) : resolve(); } };
          const timer = setTimeout(() => { p.off('message', done); reject(new Error('测试身体未排空后台与Git子进程')); }, 10_000);
          p.on('message', done); p.send({ id: -1, cmd: 'quiesce' });
        });
      }
    } finally { await Promise.all(processes.map(stop)); sync.close(); }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const remote = path.join(tmp, 'soul.git'), seed = path.join(tmp, 'seed');
  git(tmp, 'init', '--bare', '-b', 'main', remote);
  fs.mkdirSync(seed); git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', '合成身份'); git(seed, 'config', 'user.email', 'synthetic@example.invalid');
  fs.writeFileSync(path.join(seed, 'agent.json'), JSON.stringify({ id: 'x', name: 'synthetic', displayName: '合成身份' }));
  git(seed, 'add', 'agent.json'); git(seed, 'commit', '-m', '合成灵魂初始身份'); git(seed, 'push', remote, 'main');

  async function spawn(name: string) {
    const p = fork(path.join(import.meta.dirname, 'fixtures', 'adaptive-body.ts'), [], {
      execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
      env: { ...process.env, QUETZAL_HOME: path.join(tmp, name), BODY: name, SYNC: sync.url, KEYS: JSON.stringify(keys),
        SOUL_ALLOW_LOCAL_REMOTE: '1', TEST_SOUL_REMOTE: remote },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    processes.push(p);
    let seq = 0;
    const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('合成身体启动超时')), 20_000);
      p.once('exit', () => { clearTimeout(timer); reject(new Error('合成身体退出')); for (const h of pending.values()) h.reject(new Error('合成身体退出')); });
      p.on('message', (m: any) => {
        if (m.ready) { clearTimeout(timer); resolve(); }
        else { const h = pending.get(m.id); pending.delete(m.id); if (h) m.error ? h.reject(new Error(m.error)) : h.resolve(m.result); }
      });
    });
    return { p, call: <T = any>(cmd: string, args?: unknown) => new Promise<T>((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject }); p.send({ id, cmd, args });
    }) };
  }
  const center = await spawn('center'); let satellite = await spawn('satellite');
  await until(async () => (await satellite.call<string[]>('connected')).includes('center'), '正式身体连接');
  const source = await satellite.call<number>('semanticSource', { conv: 'origin', text: '港口采风线索来自编辑。' });
  await until(async () => (await center.call<any[]>('messages', { session: 'origin' })).some((m) => m.id === source), '原文复制');
  const claim = await center.call<{ id: string }>('semanticSeed', { source, text: '港口采风线索来自编辑' });
  const localRevision = async () => (await satellite.call<any[]>('semanticCurrent')).find((r) => r.id === claim.id)?.revision;
  const query = () => satellite.call<SemanticMemoryReading>('semanticQuery', { query: '港口采风' });
  await t.test('接受后自动提交和推送，在线身体收到提示后自动拉取完整文件', async () => {
    await until(async () => await localRevision() === 1, '第一版认识自动抵达');
    const rows = await center.call<any[]>('semanticExport'); assert.ok(rows.length > 0);
    for (const row of rows) {
      const file = `notes/QuetzalMemory/Adaptive/${row.id}.md`;
      const remoteText = git(remote, 'show', `main:${file}`);
      assert.equal(git(path.join(tmp, 'center', 'soul'), 'show', `HEAD:${file}`), remoteText);
      assert.equal(git(path.join(tmp, 'satellite', 'soul'), 'show', `HEAD:${file}`), remoteText);
    }
    const reading = await query(); assert.equal(reading.status, 'ready'); assert.equal(reading.items[0].revision, 1);
  });
  await t.test('在线纠正自动抵达，另一身体的实际模型上下文选入新版本', async () => {
    const correction = await satellite.call<number>('semanticSource', { conv: 'origin', text: '更正，港口采风线索来自弟弟。' });
    await until(async () => (await center.call<any[]>('messages', { session: 'origin' })).some((m) => m.id === correction), '纠正原文复制');
    await center.call('semanticSeed', { id: claim.id, source: correction, text: '港口采风线索来自弟弟' });
    await until(async () => await localRevision() === 2, '纠正认识自动抵达');
    const reading = await query(); assert.equal(reading.status, 'ready'); assert.equal(reading.items[0].revision, 2);
    assert.ok(JSON.stringify(reading.items).includes('弟弟')); assert.ok(!JSON.stringify(reading.items).includes('编辑'));
    await satellite.call('semanticChat', { conv: 'consumer', text: '回顾港口采风' });
    const plan = await satellite.call('contextPlan', { conv: 'consumer' });
    assert.ok(plan.selectedIds.includes(`memory:adaptive-semantic:${claim.id}:2`));
    assert.ok(!plan.selectedIds.includes(`memory:adaptive-semantic:${claim.id}:1`));
  });
  await t.test('离线错过推送提示，重启后的正常对话拉取并恢复最新认识', async () => {
    await stop(satellite.p);
    const correction = await center.call<number>('semanticSource', { conv: 'origin', text: '再核对，港口采风线索来自朋友。' });
    await center.call('semanticSeed', { id: claim.id, source: correction, text: '港口采风线索来自朋友' });
    await until(async () => {
      const rows = await center.call<any[]>('semanticExport');
      return rows.every((row) => { try { git(remote, 'cat-file', '-e', `main:notes/QuetzalMemory/Adaptive/${row.id}.md`); return true; } catch { return false; } });
    }, '离线期间发布');
    satellite = await spawn('satellite');
    await until(async () => (await satellite.call<string[]>('connected')).includes('center'), '重启连接');
    await until(async () => (await satellite.call<any[]>('messages', { session: 'origin' })).some((m) => m.id === correction), '重启补齐原文');
    assert.equal(await localRevision(), 2, '离线期间没有接到推送提示，尚未发起正常对话');
    // 没有手工 pull 或文件安装：converse 自己负责对话前拉取。
    await satellite.call('semanticChat', { conv: 'recovered', text: '回顾港口采风' });
    assert.equal(await localRevision(), 3);
    const reading = await query(); assert.equal(reading.status, 'ready'); assert.equal(reading.items[0].revision, 3);
    assert.ok(JSON.stringify(reading.items).includes('朋友'));
    const plan = await satellite.call('contextPlan', { conv: 'recovered' });
    assert.ok(plan.selectedIds.includes(`memory:adaptive-semantic:${claim.id}:3`));
  });
});

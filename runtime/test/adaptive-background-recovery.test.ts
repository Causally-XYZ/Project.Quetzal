// 与语义运行器首次失败即停止的规则分离；只验证生产后台自动退避和发布，不评分模型质量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeSync } from './fixtures/fake-sync.ts';
import { loadNodeKey } from '../src/mesh/identity.ts';
import { startBody, type BodyClient } from '../tool/adaptive-eval/process-client.ts';

const until = async <T>(check: () => Promise<T | undefined>, label: string): Promise<T> => {
  const deadline = Date.now() + 25000;
  while (true) {
    const value = await check(); if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待${label}超时`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
test('真实双身体后台首次生成失败后自行退避重试，成功发布一次并可从对端读取', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-background-recovery-'));
  const clients: BodyClient[] = [], keys: Record<string, string> = {};
  let sync: Awaited<ReturnType<typeof fakeSync>> | undefined;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  try {
    await import('node-datachannel');
    for (const body of ['center', 'satellite']) keys[body] = loadNodeKey(path.join(root, body, 'secrets/mesh_ed25519')).nodeKey;
    sync = await fakeSync(keys);
    const remote = path.join(root, 'soul.git'), seed = path.join(root, 'seed');
    git(root, 'init', '--bare', '-b', 'main', remote); fs.mkdirSync(seed); git(seed, 'init', '-b', 'main');
    git(seed, 'config', 'user.name', '合成评测'); git(seed, 'config', 'user.email', 'synthetic@example.invalid');
    fs.writeFileSync(path.join(seed, 'agent.json'), JSON.stringify({ id: 'x', name: 'synthetic', displayName: '合成评测' }));
    git(seed, 'add', 'agent.json'); git(seed, 'commit', '-m', '合成恢复验证初始灵魂'); git(seed, 'push', remote, 'main');
    for (const body of ['center', 'satellite']) clients.push(await startBody(path.join(root, body), {
      body, remote, sync: sync.url, keys, kind: 'stub', model: 'gemini-3.8-flash', maxCalls: 4, stubFailAt: 1,
    }));
    const [center, satellite] = clients;
    await until(async () => (await satellite.call<string[]>('connected')).includes('center') ? true : undefined, '连接');
    const source = await satellite.call<number>('source', { session: 'recovery', role: 'user', scope: 'accessible',
      text: '公开恢复样例：蓝色船屋有人修旧钟。', at: '2026-05-10T12:00:00Z' });
    const failed = await until<any>(async () => {
      const s = await center.call<any>('snapshot'); return s.calls[0]?.state === 'failed' ? s : undefined;
    }, '真实后台失败');
    assert.equal(failed.calls.length, 1); assert.equal(failed.calls[0].failure.category, 'stub-failure');
    const job = failed.jobs.find((j: any) => j.source === source && j.processor === 'semantic-v1');
    assert.equal(job.state, 'queued'); assert.equal(job.attempts, 1); assert.equal(job.error, 'processor_failed');
    assert.ok(job.available > failed.calls[0].start); assert.equal(failed.records.length, 0);
    assert.equal(failed.receipts.some((r: any) => r.source === source && r.processor === 'semantic-v1'), false);
    const absent = await satellite.rpc<any>('memory.adaptive.semantic.query', { query: '蓝色船屋' });
    assert.equal(absent.items.length, 0, '失败提案不能提前成为认识');
    const recovered = await until<any>(async () => {
      const s = await center.call<any>('snapshot'), r = await satellite.call<any>('snapshot');
      const current = s.jobs.find((j: any) => j.id === job.id);
      return current?.state === 'done' && s.publications.length === 1 && s.publications[0].state === 'published'
        && !s.sync.unpushed && JSON.stringify(s.records) === JSON.stringify(r.records) ? { center: s, satellite: r } : undefined;
    }, '自动重试与发布');
    const completed = recovered.center.jobs.find((j: any) => j.id === job.id);
    assert.equal(completed.attempts, 2); assert.equal(recovered.center.calls.length, 2);
    assert.equal(recovered.center.calls[0].state, 'failed'); assert.equal(recovered.center.calls[1].state, 'returned');
    assert.ok(recovered.center.calls[1].start >= job.available, '实际等待生产退避，不改队列时钟或手工重排任务');
    assert.equal(recovered.center.records.length, 1); assert.equal(recovered.satellite.calls.length, 0);
    assert.equal(recovered.center.receipts.filter((r: any) => r.source === source && r.processor === 'semantic-v1').length, 1);
    const reading = await satellite.rpc<any>('memory.adaptive.semantic.query', { query: '蓝色船屋' });
    assert.equal(reading.status, 'ready'); assert.equal(reading.items.length, 1);
    assert.equal(reading.items[0].id, recovered.center.records[0].id);
    assert.ok(fs.existsSync(path.join(root, 'center/eval-calls/1-end.json')), '失败证据没有被成功调用覆盖');
  } finally {
    const stops = await Promise.all(clients.map((c) => c.stop())); sync?.close();
    fs.rmSync(root, { recursive: true, force: true });
    for (const stopped of stops) { assert.equal(stopped.forced, false); assert.equal(stopped.exitCode, 0); assert.throws(() => process.kill(stopped.pid!, 0)); }
  }
});

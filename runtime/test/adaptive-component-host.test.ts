import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-component-host-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../src/config.ts'); cfg.loadConfig();
cfg.saveConfig({ body: 'center', adaptiveMemory: { enabled: true, hostBody: 'center', semantic: false } });
const store = await import('../src/store.ts'); store.openStore();
await (await import('../src/memory/soul-sync.ts')).ensureSoul();
const host = await import('../src/memory/adaptive.ts');
after(async () => { await host.stopAdaptiveMemory(); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('只有开启认识处理的集中主机准备组件；停止与关闭中止准备，前台仍可读取', async () => {
  let calls = 0, cancelled = 0;
  const detach = host.setAdaptiveComponentPreparer(async (_root, signal) => {
    calls++;
    return new Promise<boolean>((resolve) => signal.addEventListener('abort', () => { cancelled++; resolve(false); }, { once: true }));
  });
  try {
    host.startAdaptiveMemory(); await tick(); assert.equal(calls, 0);
    host.configureAdaptiveMemory({ enabled: true, hostBody: 'elsewhere', semantic: true }); host.processAdaptiveBatch(); await tick(); assert.equal(calls, 0);
    host.configureAdaptiveMemory({ enabled: true, hostBody: 'center', semantic: true }); host.processAdaptiveBatch(); await tick();
    assert.equal(calls, 1); assert.equal(host.adaptiveStatus().retrieval.state, 'preparing');
    const start = performance.now(), result = await host.queryAdaptiveSemantic('公开合成查询');
    assert.equal(result.status, 'ready'); assert(performance.now() - start < 500);
    host.configureAdaptiveMemory({ enabled: true, hostBody: 'center', semantic: false }); host.processAdaptiveBatch(); await tick();
    assert.equal(cancelled, 1); await host.stopAdaptiveMemory();
    host.configureAdaptiveMemory({ enabled: true, hostBody: 'center', semantic: true }); host.startAdaptiveMemory(); await tick();
    assert.equal(calls, 2); await host.stopAdaptiveMemory(); assert.equal(cancelled, 2);
  } finally { await host.stopAdaptiveMemory(); detach(); }
});

test('准备失败保留固定错误码并自动退避重试，不在每个500ms tick重新安装', async (t) => {
  let calls = 0;
  const detach = host.setAdaptiveComponentPreparer(async () => { if (++calls === 1) throw new Error('component_download_failed'); return false; });
  try {
    host.startAdaptiveMemory(); await tick();
    const status = host.adaptiveStatus().retrieval; assert('retryAt' in status); assert.equal(status.error, 'component_download_failed');
    for (let i = 0; i < 10; i++) host.processAdaptiveBatch(); await tick(); assert.equal(calls, 1);
    assert(status.retryAt > Date.now());
    const clock = t.mock.method(Date, 'now', () => status.retryAt + 1);
    host.processAdaptiveBatch(); await tick(); assert.equal(calls, 2); clock.mock.restore();
  } finally { await host.stopAdaptiveMemory(); detach(); }
});

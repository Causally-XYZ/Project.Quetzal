// 实际宿主的500毫秒读取路径；合成1000条独立认识，未配置模型，不调用 LLM。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedReadWorkload } from '../tool/adaptive-read-workload.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-query-scale-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../src/config.ts'); cfg.loadConfig();
cfg.saveConfig({ body: 'reader', adaptiveMemory: { enabled: true, hostBody: 'reader', semantic: true } });
const store = await import('../src/store.ts'); store.openStore();
await (await import('../src/memory/soul-sync.ts')).ensureSoul();
const { identity } = await import('../src/memory/identity.ts');
const { AdaptiveStore } = await import('../src/memory/adaptive-store.ts');
const host = await import('../src/memory/adaptive.ts');
host.setAdaptiveComponentPreparer(async () => false); // 此夹具不测试组件部署，不启动网络安装。

test('1000条认识的实际宿主读取：100次查询、来源失效与坏文件降级', { timeout: 90_000 }, async (t) => {
  t.after(async () => { await host.stopAdaptiveMemory(); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const queue = new AdaptiveStore(store.db, identity().id), { firstFile } = seedReadWorkload(queue, cfg.paths.soul, 1000);
  host.startAdaptiveMemory();
  const durations: number[] = [];
  for (let i = 0; i < 100; i++) {
    const begin = performance.now(), reading = await host.queryAdaptiveSemantic('港口采风');
    durations.push(performance.now() - begin);
    assert.equal(reading.status, 'ready'); assert.equal(reading.matched, 1000); assert.equal(reading.items.length, 6);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const sorted = [...durations].sort((a, b) => a - b);
  assert.ok(sorted[94] < 500, '完整宿主路径的 P95 必须在现有截止内');
  t.diagnostic(JSON.stringify({ count: durations.length, p50Ms: sorted[49], p95Ms: sorted[94], maxMs: sorted.at(-1), node: process.version }));
  store.db.exec("UPDATE messages SET mode='ignored' WHERE id=1");
  let reading = await host.queryAdaptiveSemantic('港口采风'); assert.equal(reading.status, 'ready'); assert.equal(reading.matched, 999);
  assert.ok(reading.items.every((i) => i.roots.every((s) => s.id !== 1)));
  const original = fs.readFileSync(firstFile); fs.writeFileSync(firstFile, '损坏的权威记录');
  reading = await host.queryAdaptiveSemantic('港口采风'); assert.equal(reading.status, 'unavailable'); assert.deepEqual(reading.items, []);
  fs.writeFileSync(firstFile, original);
  reading = await host.queryAdaptiveSemantic('港口采风'); assert.equal(reading.status, 'ready'); assert.equal(reading.matched, 999);
  // 推进时钟验证正式周期入口，不直接调用archive.audit，不真实等待一分钟。
  const before = host.adaptiveStatus().integrity.checkedAt!;
  const advanced = Date.now() + 60_001;
  const clock = t.mock.method(Date, 'now', () => advanced);
  try {
    host.processAdaptiveBatch();
    const end = performance.now() + 5000;
    while ((host.adaptiveStatus().integrity.checkedAt ?? 0) <= before) {
      assert.ok(performance.now() < end, '正式宿主应自动完成巡检');
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(host.adaptiveStatus().integrity.state, 'ready');
  } finally { clock.mock.restore(); }
});

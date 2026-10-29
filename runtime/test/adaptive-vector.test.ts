// 真实本机E5工程检查。固定组件位于仓库外；未显式提供时跳过，不下载、不伪造模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { AdaptiveVectorRetriever, VECTOR_SPACE } from '../src/memory/adaptive-vector.ts';
import { semanticDigest, type SemanticCandidate } from '../src/memory/adaptive-query.ts';

const root = process.env.QUETZAL_TEST_VECTOR_COMPONENT;
const options = { skip: !root, timeout: 30_000 };
const agent = 'synthetic-vector-test';
function candidate(id: number, text = `合成记录${id}`): SemanticCandidate {
  // 此层只消费内容摘要 / title / text；语义依据门禁另由实际archive与query测试覆盖。
  return { key: semanticDigest({ id, text }), title: '合成测试', text } as SemanticCandidate;
}
async function fixture(t: any, seed: SemanticCandidate[] = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-vector-test-')), cache = path.join(home, 'vectors.sqlite');
  const db = new DatabaseSync(cache);
  db.exec('CREATE TABLE vectors(agent TEXT,space TEXT,key TEXT,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(agent,space,key))');
  const value = JSON.stringify([Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0)]);
  for (const c of seed) db.prepare('INSERT INTO vectors VALUES(?,?,?,?,?)').run(agent, VECTOR_SPACE, c.key, value, crypto.createHash('sha256').update(value).digest('hex'));
  db.close();
  const backend = new AdaptiveVectorRetriever({ root: root!, cache, agent });
  t.after(async () => { await backend.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const until = async (check: () => boolean) => {
    const end = performance.now() + 10_000;
    while (!check()) {
      assert.notEqual(backend.status().state, 'failed', JSON.stringify(backend.status()));
      assert.ok(performance.now() < end, `向量任务未完成: ${JSON.stringify(backend.status())}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { backend, cache, until };
}

test('真实worker：首份候选前保留缓存；相同输入不发消息，增量只传新增与撤回', options, async (t) => {
  const a = candidate(1), b = candidate(2), c = candidate(3);
  const f = await fixture(t, [a, b, candidate(99)]);
  await f.until(() => f.backend.status().state === 'ready');
  const check = new DatabaseSync(f.cache, { readOnly: true });
  assert.equal(check.prepare('SELECT count(*) n FROM vectors').get()!.n, 3); check.close();
  const sent: any[] = [], original = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype, 'postMessage', function(this: Worker, message: any) { if (message.type === 'update') sent.push(message); return original.call(this, message); });
  f.backend.replace([a, b]); await f.until(() => f.backend.status().current && f.backend.status().indexed === 2);
  f.backend.replace([a, b]); assert.equal(sent.length, 1);
  f.backend.replace([b, c]); await f.until(() => f.backend.status().current && f.backend.status().pending === 0);
  assert.deepEqual(sent[1].remove, [a.key]); assert.deepEqual(sent[1].upsert.map((v: any) => v.key), [c.key]);
  assert.equal(f.backend.status().reused, 2); assert.equal(f.backend.status().computed, 1);
  const db = new DatabaseSync(f.cache, { readOnly: true });
  assert.deepEqual(db.prepare('SELECT key FROM vectors ORDER BY key').all().map((r) => r.key), [b.key, c.key].sort()); db.close();
});

test('真实worker：未确认时合并快速更新，撤回再加入不丢任务，重启复用当前缓存', options, async (t) => {
  const f = await fixture(t), a = candidate(1), b = candidate(2), c = candidate(3);
  await f.until(() => f.backend.status().state === 'ready');
  const sent: any[] = [], original = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype, 'postMessage', function(this: Worker, message: any) { if (message.type === 'update') sent.push(message); return original.call(this, message); });
  f.backend.replace([a]); f.backend.replace([b]); f.backend.replace([a, c]);
  assert.equal(sent.length, 1, '在途批次未确认前不积压中间快照');
  await f.until(() => f.backend.status().current && f.backend.status().indexed === 2);
  assert.equal(sent.length, 2); assert.deepEqual(sent[1].upsert.map((v: any) => v.key), [c.key]);
  f.backend.replace([c]); await f.until(() => f.backend.status().current);
  f.backend.replace([a, c]); await f.until(() => f.backend.status().current && f.backend.status().indexed === 2);
  await f.backend.close();
  const restored = new AdaptiveVectorRetriever({ root: root!, cache: f.cache, agent });
  try {
    restored.replace([a, c]);
    await f.until(() => restored.status().current && restored.status().indexed === 2);
    assert.equal(restored.status().reused, 2); assert.equal(restored.status().computed, 0);
  } finally { await restored.close(); }
});

test('真实worker：连续无关更新不重置长材料进度；在途撤回不重新发布旧向量', options, async (t) => {
  const f = await fixture(t);
  const long = candidate(1, '学校的天文社观察木星卫星，今晚记录望远镜的调焦与云层变化。'.repeat(90));
  const removed = candidate(2, '祖母留下的菜谱需要重新核对火候和调味比例。'.repeat(90));
  f.backend.replace([long]); await f.until(() => f.backend.status().current);
  let i = 10;
  const timer = setInterval(() => f.backend.replace([long, candidate(i++)]), 10);
  const db = new DatabaseSync(f.cache, { readOnly: true });
  try { await f.until(() => !!db.prepare('SELECT key FROM vectors WHERE key=?').get(long.key)); }
  finally { clearInterval(timer); }
  assert.ok(i > 11, '应在实际持续变化期间完成多块任务');
  const stored = JSON.parse(String(db.prepare('SELECT value FROM vectors WHERE key=?').get(long.key)!.value));
  assert.ok(stored.length > 10, '实际分块嵌入，非单块替代');
  f.backend.replace([long, removed]); await f.until(() => f.backend.status().current);
  f.backend.replace([long]); await f.until(() => f.backend.status().current && f.backend.status().pending === 0);
  await f.backend.close();
  assert.equal(db.prepare('SELECT key FROM vectors WHERE key=?').get(removed.key), undefined);
  db.close();
});

test('真实worker：空快照清除当前缓存，重建条目后查询不返回撤回摘要', options, async (t) => {
  const c = candidate(1, '海边拍摄迁徙候鸟需要长焦镜头。'), f = await fixture(t, [c]);
  const corrupt = new DatabaseSync(f.cache); corrupt.prepare('UPDATE vectors SET value=? WHERE key=?').run('broken', c.key); corrupt.close();
  f.backend.replace([c]); await f.until(() => f.backend.status().current && f.backend.status().pending === 0);
  assert.ok((await f.backend.query('候鸟摄影'))?.keys.includes(c.key));
  f.backend.replace([]); await f.until(() => f.backend.status().current && f.backend.status().indexed === 0);
  assert.equal(await f.backend.query('候鸟摄影'), undefined);
  f.backend.replace([c]); await f.until(() => f.backend.status().current && f.backend.status().indexed === 1);
  assert.equal(f.backend.status().computed, 2);
  assert.throws(() => f.backend.replace([{ ...c, text: '同摘要不同正文' }]), /摘要不一致/);
});

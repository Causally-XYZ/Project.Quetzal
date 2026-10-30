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
async function fixture(t: any, seed: SemanticCandidate[] = [], prepare?: (db: DatabaseSync) => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-vector-test-')), cache = path.join(home, 'vectors.sqlite');
  const db = new DatabaseSync(cache);
  db.exec('CREATE TABLE vectors(agent TEXT,space TEXT,key TEXT,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(agent,space,key))');
  const value = JSON.stringify([Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0)]);
  for (const c of seed) db.prepare('INSERT INTO vectors VALUES(?,?,?,?,?)').run(agent, VECTOR_SPACE, c.key, value, crypto.createHash('sha256').update(value).digest('hex'));
  prepare?.(db); db.close();
  const backend = new AdaptiveVectorRetriever({ root: root!, cache, agent });
  let exitCode: number | undefined;
  (backend as unknown as { worker: Worker }).worker.once('exit', (code) => { exitCode = code; });
  t.after(async () => { await backend.close(); fs.rmSync(home, { recursive: true, force: true }); assert.equal(exitCode, 0, 'worker须正常dispose退出'); });
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
  t.mock.method(Worker.prototype, 'postMessage', function(this: Worker, message: any) { if (message.type === 'batch') sent.push(message.batch); return original.call(this, message); });
  f.backend.replace([a, b]); await f.until(() => f.backend.status().current && f.backend.status().indexed === 2);
  f.backend.replace([a, b]); assert.equal(sent.length, 1);
  f.backend.replace([b, c]); await f.until(() => f.backend.status().current && f.backend.status().pending === 0);
  assert.deepEqual(sent[1].remove, [{ id: a.key, key: a.key }]); assert.deepEqual(sent[1].upsert.map((v: any) => v.key), [c.key]);
  assert.equal(f.backend.status().reused, 2); assert.equal(f.backend.status().computed, 1);
  const db = new DatabaseSync(f.cache, { readOnly: true });
  assert.deepEqual(db.prepare('SELECT key FROM vectors ORDER BY key').all().map((r) => r.key), [b.key, c.key].sort()); db.close();
});

test('真实worker：未确认时合并快速更新，撤回再加入不丢任务，重启复用当前缓存', options, async (t) => {
  const f = await fixture(t), a = candidate(1), b = candidate(2), c = candidate(3);
  await f.until(() => f.backend.status().state === 'ready');
  const sent: any[] = [], original = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype, 'postMessage', function(this: Worker, message: any) { if (message.type === 'batch') sent.push(message.batch); return original.call(this, message); });
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
  f.backend.replace([long]); await f.until(() => f.backend.status().current && f.backend.status().pending > 0);
  assert.equal(f.backend.status().scanComplete, true, '清单已确认与嵌入未完成独立');
  let i = 10;
  const timer = setInterval(() => f.backend.replace([long, candidate(i++)]), 10);
  const db = new DatabaseSync(f.cache, { readOnly: true });
  try { await f.until(() => !!db.prepare('SELECT key FROM vectors WHERE key=?').get(long.key)); }
  finally { clearInterval(timer); }
  assert.ok(i > 11, '应在实际持续变化期间完成多块任务');
  const stored = JSON.parse(String(db.prepare('SELECT value FROM vectors WHERE key=?').get(long.key)!.value));
  assert.ok(stored.length > 10, '实际分块嵌入，非单块替代');
  const beforeRemoval = f.backend.status().seq;
  f.backend.replace([long, removed]); await f.until(() => f.backend.status().seq > beforeRemoval && f.backend.status().pending > 0);
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
  const damaged = new DatabaseSync(f.cache); damaged.prepare('UPDATE vectors SET value=? WHERE key=?').run('broken', c.key); damaged.close();
  assert.equal(await f.backend.query('候鸟摄影'), undefined, '已索引缓存损坏时不返回半份结果');
  await f.until(() => f.backend.status().current && f.backend.status().computed === 2);
  f.backend.replace([]); await f.until(() => f.backend.status().current && f.backend.status().indexed === 0);
  assert.equal(await f.backend.query('候鸟摄影'), undefined);
  f.backend.replace([c]); await f.until(() => f.backend.status().current && f.backend.status().indexed === 1);
  assert.equal(f.backend.status().computed, 3);
  assert.throws(() => f.backend.replace([{ ...c, text: '同摘要不同正文' }]), /摘要不一致/);
});


test('真实worker：1001候选分批入库、全扫后才清理；重启重放最后ACK与同epoch增量', options, async (t) => {
  const candidates = Array.from({ length: 1001 }, (_, i) => candidate(i));
  const f = await fixture(t, candidates);
  const entries = candidates.map((c, i) => ({ id: String(i).padStart(5, '0'), key: c.key, title: c.title, text: c.text }));
  const begin = { epoch: 'sweep-a', seq: 1, begin: true, upsert: entries.slice(0, 1000), remove: [] };
  const pending = f.backend.applyBatch(begin);
  await assert.rejects(f.backend.applyBatch({ ...begin, seq: 2 }), /尚未确认/);
  assert.deepEqual(await pending, { epoch: 'sweep-a', seq: 1, scanComplete: false });
  assert.equal(f.backend.status().current, false, 'ACK不是完整扫描完成');
  await f.backend.applyBatch({ epoch: 'sweep-a', seq: 2, complete: true, upsert: entries.slice(1000), remove: [] });
  await f.until(() => f.backend.status().current);
  assert.equal(f.backend.status().indexed, 1001);
  const db = new DatabaseSync(f.cache, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM vector_catalog').get()!.n, 1001);
    // 独立测试扫描/TopK算法；放宽的内部deadline不代表生产100ms查询保证。
    const worker = (f.backend as unknown as { worker: Worker }).worker;
    const answer = new Promise<any>((resolve) => {
      const listener = (message: any) => { if (message.type === 'answer' && message.id === 90001) { worker.off('message', listener); resolve(message); } };
      worker.on('message', listener);
    });
    const abort = new AbortController();
    const cancelled = f.backend.query('长查询取消边界。'.repeat(100), abort.signal); abort.abort();
    assert.equal(await cancelled, undefined);
    worker.postMessage({ type: 'query', id: 90001, query: '合成测试', deadline: Date.now() + 5000 });
    const result = await answer;
    assert.deepEqual(result.keys, entries.slice(0, 1000).map((e) => e.key), '完整扫描且同分稳定，只驻留TopK');
    await f.backend.applyBatch({ epoch: 'sweep-b', seq: 1, begin: true, upsert: [], remove: [] });
    assert.equal(db.prepare('SELECT count(*) n FROM vector_catalog').get()!.n, 1001, 'begin不能删未遇到的旧候选');
    const last = { epoch: 'sweep-b', seq: 2, upsert: entries.slice(0, 1), remove: [] };
    await f.backend.applyBatch(last); await f.backend.close();
    const restored = new AdaptiveVectorRetriever({ root: root!, cache: f.cache, agent });
    try {
      assert.deepEqual(await restored.applyBatch(last), { epoch: 'sweep-b', seq: 2, scanComplete: false });
      assert.equal(restored.status().indexed, 1001); assert.equal(restored.status().reused, 0, '重放ACK不重做已接受批次');
      await restored.applyBatch({ epoch: 'sweep-b', seq: 3, complete: true, upsert: [], remove: [] });
      assert.equal(db.prepare('SELECT count(*) n FROM vector_catalog').get()!.n, 1);
      assert.equal(db.prepare('SELECT count(*) n FROM vectors').get()!.n, 1);
      const changed = { ...entries[0], key: semanticDigest('new-version'), text: '更新后的合成记录' };
      await restored.applyBatch({ epoch: 'sweep-b', seq: 4, upsert: [changed], remove: [] });
      await restored.applyBatch({ epoch: 'sweep-b', seq: 5, upsert: [], remove: [{ id: changed.id, key: entries[0].key }] });
      assert.equal(restored.status().scanComplete, true, '完整扫描后的dirty批不重新开启扫描');
      assert.equal(db.prepare('SELECT key FROM vector_catalog WHERE id=?').get(changed.id)!.key, changed.key, '旧key撤回不能删新版本');
      await assert.rejects(restored.applyBatch({ ...last, seq: 5 }), /vector_worker/, '同序号不同payload拒绝');
    } finally { await restored.close(); }
  } finally { db.close(); }
});


test('真实worker：嵌入提交遇实际SQLite写锁，保留pending退避后恢复且不隔离缓存', options, async (t) => {
  const f = await fixture(t), c = candidate(1, '合成天文社记录与晚间云层变化。'.repeat(90));
  const lock = new DatabaseSync(f.cache);
  const worker = (f.backend as unknown as { worker: Worker }).worker;
  let locked = false;
  const hold = (message: any) => { if (message.type === 'ack') { lock.exec('BEGIN IMMEDIATE'); locked = true; worker.off('message', hold); } };
  worker.on('message', hold);
  try {
    await f.backend.applyBatch({ epoch: 'lock', seq: 1, begin: true, complete: true,
      upsert: [{ id: 'one', key: c.key, title: c.title, text: c.text }], remove: [] });
    assert.equal(locked, true);
    await f.until(() => f.backend.status().errors > 0);
    assert.equal(f.backend.status().state, 'ready'); assert.equal(f.backend.status().pending, 1);
    assert.equal(f.backend.status().cacheRecovered, false, '写锁不能当损坏隔离');
    lock.exec('ROLLBACK'); locked = false;
    await f.until(() => f.backend.status().pending === 0 && f.backend.status().computed === 1);
  } finally { worker.off('message', hold); if (locked) lock.exec('ROLLBACK'); lock.close(); }
});

test('真实worker：批次清单提交遇实际SQLite写锁，原地退避恢复或拒绝当前批次而不销毁worker', options, async (t) => {
  const a = candidate(1), b = candidate(2), f = await fixture(t, [a, b]);
  await f.until(() => f.backend.status().state === 'ready');
  const lock = new DatabaseSync(f.cache);
  let locked = false;
  try {
    lock.exec('BEGIN IMMEDIATE'); locked = true;
    const batch1 = { epoch: 'batch-lock', seq: 1, begin: true, complete: false,
      upsert: [{ id: 'a', key: a.key, title: a.title, text: a.text }], remove: [] };
    const pendingAck = f.backend.applyBatch(batch1);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(f.backend.status().state, 'ready', '写锁等待期间worker保持ready');
    assert.equal(f.backend.status().cacheRecovered, false);
    lock.exec('ROLLBACK'); locked = false;
    assert.deepEqual(await pendingAck, { epoch: 'batch-lock', seq: 1, scanComplete: false });
    assert.equal(f.backend.status().indexed, 1);
    // 持久写锁超出单批重试窗口时仅拒绝当前applyBatch，worker仍ready且后续重发同一批次可完成
    lock.exec('BEGIN IMMEDIATE'); locked = true;
    const batch2 = { epoch: 'batch-lock', seq: 2, complete: true,
      upsert: [{ id: 'b', key: b.key, title: b.title, text: b.text }], remove: [] };
    await assert.rejects(f.backend.applyBatch(batch2), /vector_busy/);
    assert.equal(f.backend.status().state, 'ready', '批次写锁超时不销毁worker');
    assert.equal(f.backend.status().failure, null);
    assert.equal(f.backend.status().cacheRecovered, false);
    lock.exec('ROLLBACK'); locked = false;
    assert.deepEqual(await f.backend.applyBatch(batch2), { epoch: 'batch-lock', seq: 2, scanComplete: true });
    assert.equal(f.backend.status().current, true);
    assert.equal(f.backend.status().indexed, 2);
  } finally { if (locked) lock.exec('ROLLBACK'); lock.close(); }
});

test('真实worker：损坏catalog或meta schema沿既有隔离路径自修并保留损坏文件', options, async (t) => {
  for (const table of ['vector_catalog', 'vector_catalog_meta', 'vector_catalog_counts']) {
    const c = candidate(1), f = await fixture(t, [c], (db) => db.exec(`CREATE TABLE ${table}(wrong TEXT)`));
    f.backend.replace([c]); await f.until(() => f.backend.status().current && f.backend.status().pending === 0);
    assert.equal(f.backend.status().cacheRecovered, true); assert.equal(f.backend.status().computed, 1);
    assert(fs.readdirSync(path.dirname(f.cache)).some((name) => name.startsWith('vectors.sqlite.damaged-')));
    await f.backend.close();
  }
});


test('真实worker：派生计数随候选insert/update/delete同事务变化，rollback不漂移', options, async (t) => {
  const c = candidate(1), f = await fixture(t, [c]);
  f.backend.replace([c]); await f.until(() => f.backend.status().current && f.backend.status().pending === 0);
  await f.backend.close();
  const db = new DatabaseSync(f.cache);
  const check = () => {
    const actual = db.prepare(`SELECT count(*) total,COALESCE(SUM(state='indexed'),0) indexed_count,
      COALESCE(SUM(state='pending' AND attempts>0),0) retrying,COALESCE(SUM(state='blocked'),0) blocked
      FROM vector_catalog WHERE agent=? AND space=?`).get(agent, VECTOR_SPACE);
    assert.deepEqual(db.prepare('SELECT total,indexed_count,retrying,blocked FROM vector_catalog_counts WHERE agent=? AND space=?').get(agent, VECTOR_SPACE), actual);
  };
  try {
    check();
    db.prepare("INSERT INTO vector_catalog VALUES(?,?,?,?,?,?,?,'pending',0,0)").run(agent, VECTOR_SPACE, 'extra', 'b'.repeat(64), '合成', '计数', 'count'); check();
    db.prepare("UPDATE vector_catalog SET attempts=1 WHERE id='extra'").run(); check();
    db.prepare("UPDATE vector_catalog SET state='blocked' WHERE id='extra'").run(); check();
    db.exec("BEGIN; UPDATE vector_catalog SET state='indexed' WHERE id='extra'"); check(); db.exec('ROLLBACK'); check();
    db.prepare("DELETE FROM vector_catalog WHERE id='extra'").run(); check();
  } finally { db.close(); }
});

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';
import { AdaptiveArchive } from '../src/memory/adaptive-archive.ts';
import { reviewNext, reviewPlans } from '../src/memory/adaptive-review.ts';
import type { ClaimRecord, SourceSpan } from '../src/memory/adaptive-evidence.ts';

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-review-')), soul = path.join(home, 'soul'); fs.mkdirSync(soul);
  const connections: DatabaseSync[] = [];
  const open = () => {
    const db = new DatabaseSync(path.join(home, 'data.db')); connections.push(db);
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)');
    const queue = new AdaptiveStore(db, 'synthetic-agent'), archive = new AdaptiveArchive(queue, soul);
    return { db, queue, archive };
  };
  const f = open();
  t.after(() => { connections.forEach((db) => db.close()); fs.rmSync(home, { recursive: true, force: true }); });
  f.db.exec("INSERT INTO messages VALUES(1,1000,'user','synthetic','饭友是编辑。','one','alpha',NULL,NULL,NULL),(2,2000,'user','synthetic','更正，饭友是弟弟。','two','beta',NULL,NULL,NULL)");
  const span = (id: number): SourceSpan => { const s = f.queue.source(id)!; return { kind: 'source', source: id, hash: s.hash, start: 0, end: s.text.length, quote: s.text }; };
  const claim = (text: string, id = 1): ClaimRecord => ({ id: crypto.randomUUID(), revision: 1, kind: 'claim', state: 'present',
    realm: { world: 'real', context: 'real' }, reasons: [span(id)], text, nature: 'reported', participants: [],
    occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
    supports: [{ id: 'direct', premises: [span(id)], assumptions: [] }], counters: [] });
  const a = claim('饭友是编辑'), b = claim('编辑与用户吃饭'), c = claim('吃饭是编辑劝说的原因');
  b.supports[0].premises = [{ kind: 'claim', id: a.id, revision: 1 }, span(1)];
  c.nature = 'hypothesis'; c.supports[0].premises = [{ kind: 'claim', id: b.id, revision: 1 }];
  c.supports[0].assumptions = ['有其他因果证据'];
  let seq = 0;
  const accept = (records: ClaimRecord[], source = 2) => {
    const processor = `setup-${++seq}`; f.queue.scheduleSource(processor, source);
    const job = f.queue.claim(processor)!;
    const inputs = [1, 2].map((id) => { const s = f.queue.source(id)!; return { id, revision: s.revision, hash: s.hash }; });
    assert.equal(f.archive.accept(job, inputs, { baseGeneration: f.archive.generation(), records }), true);
  };
  accept([a, b, c]); accept([{ ...a, revision: 2, text: '饭友是弟弟', reasons: [span(2)], supports: [{ id: 'corrected', premises: [span(2)], assumptions: [] }] }]);
  const options = { archive: f.archive, queue: f.queue, exclusive: async <T>(run: () => T) => run(), enabled: () => true };
  const empty = async () => ({ contexts: [], records: [] });
  const revision = (prompt: { user: string }) => {
    const d = JSON.parse(prompt.user), target = d.records.find((r: any) => r.key === d.review.target);
    const reason = { kind: 'source', source: d.current, text: d.sources.find((s: any) => s.key === d.current).text, occurrence: null };
    const r = { ...target, key: 'p1', replace: target.key, text: '弟弟与用户吃饭', reasons: [reason],
      supports: [{ id: 'reviewed', premises: [reason, { kind: 'record', key: d.review.dependencies[0].current }], assumptions: [] }] };
    return { contexts: [], records: [r] };
  };
  return { ...f, open, a, b, c, span, claim, accept, options, empty, revision };
}

test('纠正安装后未发事件也能重建重评工作；重开队列、改写与下一层依赖继续使用同一门禁', async (t) => {
  const f = fixture(t), restored = f.open();
  const before = reviewPlans(f.archive, f.queue).plans;
  assert.equal(before.length, 1); assert.equal(before[0].target, f.b.id);
  assert.equal(reviewPlans(restored.archive, restored.queue).plans[0].processor, before[0].processor);
  assert.equal(f.archive.assess().get(f.b.id)?.status, 'unsupported');
  const result = await reviewNext({ ...f.options, ...restored, generate: async (p) => f.revision(p) });
  assert.equal(result.status, 'revised');
  assert.equal(restored.archive.history(f.b.id).length, 2);
  assert.equal(restored.archive.assess().get(f.b.id)?.status, 'supported');
  assert.equal(restored.archive.assess().get(f.c.id)?.status, 'unsupported', '下游因果假设不能机械恢复');
  assert.equal(reviewPlans(restored.archive, restored.queue).plans[0].target, f.c.id);
  assert.equal(f.queue.status(before[0].processor).counts.done, 1);
});

test('证据不足可以完成本次检查但不改变认识；无关代次改变不重复检查', async (t) => {
  const f = fixture(t);
  assert.equal((await reviewNext({ ...f.options, generate: f.empty })).status, 'unchanged');
  f.accept([f.claim('独立认识')]);
  let calls = 0;
  assert.equal((await reviewNext({ ...f.options, generate: async () => { calls++; return f.empty(); } })).status, 'idle');
  assert.equal(calls, 0); assert.equal(f.archive.history(f.b.id).length, 1);
  assert.equal(f.archive.assess().get(f.b.id)?.status, 'unsupported');
});

test('迟到的改写和空提案都不能完成已过期快照', async (t) => {
  for (const change of [false, true]) {
    const f = fixture(t);
    const result = await reviewNext({ ...f.options, generate: async (p) => {
      f.accept([f.claim('模型调用期间新增记录')]); return change ? f.revision(p) : f.empty();
    } });
    assert.equal(result.status, 'stale');
    assert.equal(f.archive.history(f.b.id).length, 1);
    const p = reviewPlans(f.archive, f.queue).plans[0]; assert.equal(f.queue.status(p.processor).counts.queued, 1);
  }
});

test('用户取消不等待无响应供应商且不复活；超时保留有界队列重试', async (t) => {
  const f = fixture(t), controller = new AbortController();
  let observed: AbortSignal | undefined;
  const result = await reviewNext({ ...f.options, signal: controller.signal, generate: async (_, signal) => {
    observed = signal; controller.abort(); return new Promise(() => {});
  } });
  assert.equal(result.status, 'cancelled'); assert.equal(observed?.aborted, true);
  assert.equal((await reviewNext({ ...f.options, generate: f.empty })).status, 'idle');
  const g = fixture(t);
  assert.equal((await reviewNext({ ...g.options, timeoutMs: 5, generate: async () => new Promise(() => {}) })).status, 'failed');
  assert.equal(g.queue.status(reviewPlans(g.archive, g.queue).plans[0].processor).counts.queued, 1);
});

test('关闭 / 急停不开始调用或安装；越界修订被拒绝并保留原记录', async (t) => {
  const f = fixture(t); let enabled = false, calls = 0;
  const generate = async (p: { user: string }) => { calls++; enabled = false; return f.revision(p); };
  assert.equal((await reviewNext({ ...f.options, enabled: () => enabled, generate })).status, 'deferred');
  assert.equal(calls, 0); enabled = true;
  assert.equal((await reviewNext({ ...f.options, enabled: () => enabled, generate })).status, 'deferred');
  assert.equal(f.archive.history(f.b.id).length, 1);
  const g = fixture(t);
  assert.equal((await reviewNext({ ...g.options, generate: async (p) => {
    const proposal = g.revision(p), data = JSON.parse(p.user);
    proposal.records[0].replace = data.review.dependencies[0].current; return proposal;
  } })).status, 'failed');
  assert.equal(g.archive.history(g.a.id).length, 2);
});

test('来源修改不把旧引用偷换为新 hash；工作配置异常明确拒绝', async (t) => {
  const f = fixture(t); f.db.exec("UPDATE messages SET text='不同的原文' WHERE id=1");
  const discovered = reviewPlans(f.archive, f.queue);
  assert.equal(discovered.plans.length, 0); assert.equal(discovered.deferred, 1);
  assert.equal((await reviewNext({ ...f.options, generate: f.empty })).status, 'deferred');
  await assert.rejects(reviewNext({ ...f.options, generate: f.empty, timeoutMs: 0 }), /超时参数/);
  assert.throws(() => f.queue.scheduleSource('bad/key', 1), /参数/);
});

test('空提案也核对非调度锚点的来源修订；等锁期间急停不调用模型', async (t) => {
  const f = fixture(t);
  assert.equal((await reviewNext({ ...f.options, generate: async () => {
    f.db.exec("UPDATE messages SET text='原输入已修改' WHERE id=1"); return f.empty();
  } })).status, 'stale');
  assert.equal(f.archive.history(f.b.id).length, 1);
  const g = fixture(t); let enabled = true, calls = 0;
  assert.equal((await reviewNext({ ...g.options, enabled: () => enabled,
    exclusive: async (run) => { enabled = false; return run(); },
    generate: async () => { calls++; return g.empty(); },
  })).status, 'deferred');
  assert.equal(calls, 0);
  assert.equal(g.db.prepare("SELECT COUNT(*) n FROM adaptive_jobs WHERE processor LIKE 'review-%'").get()!.n, 0);
});

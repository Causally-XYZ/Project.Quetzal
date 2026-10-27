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
    const inputs = f.db.prepare('SELECT id FROM messages ORDER BY id').all().flatMap((row) => {
      const s = f.queue.source(Number(row.id)); return s ? [{ id: s.id, revision: s.revision, hash: s.hash }] : []; });
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

test('替代分支移除后再重评，保留历史分支当前撤回与来源，不能只给原始规则', async (t) => {
  const f = fixture(t);
  for (const [id, text] of [[3, '初始规则：K 由 A 与 B 或 C 支持。A、B、C 存在。'], [4, '撤回 A，B 与 C 未变化。'], [5, '再撤回 C，没有新的依据。']] as const) {
    f.db.prepare("INSERT INTO messages VALUES(?,?,'user','synthetic',?,'rules','alpha',NULL,NULL,NULL)").run(id, id * 1000, text);
    f.queue.scheduleSource('setup-source', id);
  }
  const a = f.claim('依据 A', 3), b = f.claim('依据 B', 3), c = f.claim('依据 C', 3), k = f.claim('结论 K', 3);
  const ref = (r: ClaimRecord) => ({ kind: 'claim' as const, id: r.id, revision: r.revision });
  k.supports = [{ id: 'G1', premises: [ref(a), ref(b)], assumptions: [] }, { id: 'G2', premises: [ref(c)], assumptions: [] }];
  f.accept([a, b, c, k], 3);
  const withdrawnA: ClaimRecord = { ...a, revision: 2, state: 'withdrawn', reasons: [f.span(4)] };
  f.accept([withdrawnA], 4);
  f.accept([{ ...k, revision: 2, supports: [k.supports[1]] }], 4);
  f.accept([{ ...c, revision: 2, state: 'withdrawn', reasons: [f.span(5)] }], 5);
  assert.equal(f.archive.assess().get(k.id)?.status, 'unsupported');
  const plan = reviewPlans(f.archive, f.queue).plans.find((p) => p.target === k.id)!;
  assert.ok(plan.context.records.some((r) => r.id === a.id && r.revision === 2 && r.state === 'withdrawn'));
  assert.ok(plan.context.records.some((r) => r.id === b.id));
  assert.ok(plan.context.sources.some((s) => s.id === 4 && s.text === '撤回 A，B 与 C 未变化。'));
  const data = JSON.parse(plan.prompt.user);
  assert.ok(data.records.some((r: any) => r.text === '依据 A' && r.state === 'withdrawn'));
  assert.ok(data.sources.some((s: any) => s.text === '撤回 A，B 与 C 未变化。'));
  assert.equal((await reviewNext({ ...f.options, allowed: (id) => id === k.id, generate: f.empty })).status, 'unchanged');
  assert.equal(f.archive.assess().get(k.id)?.status, 'unsupported');
  assert.equal(f.archive.history(k.id).length, 2, '仅提供历史依赖的当前状态，不重新安装旧分支');
  f.accept([{ ...withdrawnA, revision: 3, reasons: [f.span(4)], text: '已撤回依据 A 的补充说明' }], 4);
  const revised = reviewPlans(f.archive, f.queue).plans.find((p) => p.target === k.id)!;
  assert.notEqual(revised.processor, plan.processor, '历史分支的当前修订进入任务键');
  f.db.exec("UPDATE messages SET mode='ignored' WHERE id=4");
  const hidden = reviewPlans(f.archive, f.queue);
  assert.ok(!hidden.plans.some((p) => p.target === k.id), '历史纠正不可读时延后，不能省略纠正只送旧规则');
  assert.ok(hidden.deferred > 0);
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

test('来源修改可重评但不把旧引用偷换为新 hash；忽略来源不送入模型', async (t) => {
  const f = fixture(t); f.db.exec("UPDATE messages SET text='不同的原文' WHERE id=1");
  const discovered = reviewPlans(f.archive, f.queue);
  assert.equal(discovered.plans.length, 2); assert.equal(discovered.deferred, 0);
  for (const plan of discovered.plans) {
    const data = JSON.parse(plan.prompt.user);
    assert.ok(data.sourceChanges.length > 0);
    assert.ok(plan.prompt.user.includes('unavailableSource'));
    assert.ok(!plan.prompt.user.includes(f.span(1).hash));
  }
  assert.equal((await reviewNext({ ...f.options, generate: f.empty })).status, 'unchanged');
  assert.equal(f.archive.history(f.b.id).length, 1);
  f.db.exec("UPDATE messages SET mode='ignored' WHERE id=1");
  let calls = 0;
  assert.equal((await reviewNext({ ...f.options, generate: async () => { calls++; return f.empty(); } })).status, 'deferred');
  assert.equal(calls, 0);
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

test('来源同时失效时按真实依赖排序，不按随机 ID；上游退避期间独立分支仍可处理', async (t) => {
  const f = fixture(t);
  const a = f.claim('上游', 1), b = f.claim('下游', 1), other = f.claim('独立分支', 1);
  a.id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; b.id = '00000000-0000-4000-8000-000000000001';
  b.supports[0].premises.push({ kind: 'claim', id: a.id, revision: 1 });
  f.accept([a, b, other]); f.db.exec("UPDATE messages SET text='原文已纠正' WHERE id=1");
  const plans = reviewPlans(f.archive, f.queue).plans;
  assert.ok(plans.findIndex((p) => p.target === a.id) < plans.findIndex((p) => p.target === b.id));
  const upstream = plans.find((p) => p.target === a.id)!;
  f.queue.scheduleSource(upstream.processor, upstream.context.current);
  f.queue.fail(f.queue.claim(upstream.processor)!, 'timeout', Date.now() + 60_000);
  const called: string[] = [];
  for (let i = 0; i < plans.length; i++) await reviewNext({ ...f.options, generate: async (_, __, target) => { called.push(target); return f.empty(); } });
  assert.ok(called.includes(other.id)); assert.ok(!called.includes(a.id)); assert.ok(!called.includes(b.id));
  assert.equal(f.archive.history(b.id).length, 1);
});

test('预算不准入时不领取或调用；已完成检查不因预算用完变成待办', async (t) => {
  const f = fixture(t); let calls = 0;
  const generate = async () => { calls++; return f.empty(); };
  assert.equal((await reviewNext({ ...f.options, allowed: () => false, generate })).status, 'deferred');
  assert.equal(calls, 0);
  assert.equal(f.queue.status(reviewPlans(f.archive, f.queue).plans[0].processor).counts.running, 0);
  assert.equal((await reviewNext({ ...f.options, generate })).status, 'unchanged');
  assert.equal((await reviewNext({ ...f.options, allowed: () => false, generate })).status, 'idle');
  assert.equal(calls, 1);
});

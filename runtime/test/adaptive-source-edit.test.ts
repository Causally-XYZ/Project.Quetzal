// 原文修订的真实 SQLite / 存档 / 持久任务闭环；语义生成是合成替身。
import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';
import { AdaptiveArchive } from '../src/memory/adaptive-archive.ts';
import { reviewNext, reviewPlans } from '../src/memory/adaptive-review.ts';
import type { ClaimRecord, ObjectRecord, SourceSpan } from '../src/memory/adaptive-evidence.ts';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-source-edit-runtime-'));
process.env.QUETZAL_HOME = isolatedHome;
const { processSemanticNext, SEMANTIC_PROCESSOR } = await import('../src/memory/adaptive-worker.ts');
after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));
const empty = async () => ({ contexts: [], records: [] });

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-source-edit-')), soul = path.join(home, 'soul'); fs.mkdirSync(soul);
  const connections: DatabaseSync[] = [];
  const open = () => {
    const db = new DatabaseSync(path.join(home, 'data.db')); connections.push(db);
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)');
    const queue = new AdaptiveStore(db, 'synthetic-agent'), archive = new AdaptiveArchive(queue, soul);
    return { db, queue, archive };
  };
  const f = open();
  t.after(() => { connections.forEach((db) => db.close()); fs.rmSync(home, { recursive: true, force: true }); });
  const insert = (id: number, text: string) => f.db.prepare('INSERT INTO messages VALUES(?,?,\'user\',\'synthetic\',?,\'session\',\'center\',NULL,NULL,NULL)').run(id, id * 1000, text);
  const edit = (id: number, text: string) => f.db.prepare('UPDATE messages SET text=? WHERE id=?').run(text, id);
  insert(1, '饭友是编辑。'); insert(2, '那天一起吃饭。我决定继续写作。');
  const span = (id: number): SourceSpan => { const s = f.queue.source(id)!; return { kind: 'source', source: id, hash: s.hash, start: 0, end: s.text.length, quote: s.text }; };
  const claim = (text: string, source: number): ClaimRecord => ({ kind: 'claim', id: crypto.randomUUID(), revision: 1, state: 'present', realm: { world: 'real', context: 'real' },
    text, nature: 'reported', reasons: [span(source)], participants: [], occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
    supports: [{ id: 'direct', premises: [span(source)], assumptions: [] }], counters: [] });
  const a = claim('饭友是编辑', 1), b = claim('用户与编辑吃饭', 2), c = claim('用户继续写作', 2);
  b.supports[0].premises.push({ kind: 'claim', id: a.id, revision: 1 });
  f.queue.scheduleSource('setup', 1); const setup = f.queue.claim('setup')!;
  assert.ok(f.archive.accept(setup, [1, 2].map((id) => { const s = f.queue.source(id)!; return { id, revision: s.revision, hash: s.hash }; }), { baseGeneration: 0, records: [a, b, c] }));
  f.queue.schedule(SEMANTIC_PROCESSOR);
  for (let job; (job = f.queue.claim(SEMANTIC_PROCESSOR));) assert.ok(f.queue.complete(job));
  const options = { queue: f.queue, archive: f.archive, exclusive: async <T>(run: () => T) => run(), enabled: () => true, signal: new AbortController().signal };
  return { ...f, options, a, b, c, span, insert, edit, open };
}

function change(prompt: { user: string }, oldText: string, text: string, includeDependency = false) {
  const data = JSON.parse(prompt.user), target = data.records.find((r: any) => r.text === oldText);
  assert.ok(target, '目标须仍可作为历史认识被审查');
  const source = data.sources.find((s: any) => s.key === data.current);
  const quote = { kind: 'source', source: source.key, text: source.text, occurrence: null };
  return { contexts: [], records: [{ ...target, key: 'p1', replace: target.key, text, reasons: [quote],
    supports: [{ id: 'reexamined', premises: [quote, ...(includeDependency ? [{ kind: 'record', key: data.review.dependencies[0].current }] : [])], assumptions: [] }], counters: [] }] };
}

test('原文编辑后自动重整合；新版本修复直接认识，下游另行重评，无关认识与旧审计保留', async (t) => {
  const f = fixture(t), before = f.a.reasons[0]; f.edit(1, '饭友是弟弟。');
  assert.equal(f.archive.assess().get(f.a.id)?.status, 'unsupported');
  const restored = f.open();
  const result = await processSemanticNext({ ...f.options, ...restored, generate: async (p) => {
    const d = JSON.parse(p.user), target = d.records.find((r: any) => r.text === f.a.text);
    assert.deepEqual(target.reasons, [{ unavailableSource: true }]);
    assert.deepEqual(d.sourceChanges.find((r: any) => r.record === target.key).currentSources, [d.current]);
    return change(p, f.a.text, '饭友是弟弟');
  } });
  assert.equal(result.status, 'revised');
  assert.equal(f.archive.assess().get(f.a.id)?.status, 'supported');
  assert.equal(f.archive.assess().get(f.b.id)?.status, 'unsupported');
  assert.equal(f.archive.assess().get(f.c.id)?.status, 'supported');
  assert.deepEqual(f.archive.history(f.a.id)[0].reasons[0], before);
  assert.equal(f.archive.history(f.a.id)[1].reasons[0].hash, f.queue.source(1)!.hash);
  assert.equal((await reviewNext({ ...f.options, generate: async (p) => change(p, f.b.text, '用户与弟弟吃饭', true) })).status, 'revised');
  assert.equal(f.archive.assess().get(f.b.id)?.status, 'supported'); assert.equal(f.archive.history(f.c.id).length, 1);
  assert.equal((await processSemanticNext({ ...f.options, generate: empty })).status, 'idle');
});

test('空提案不恢复旧认识；来源修订重评可持久去重，再次编辑才生成新检查', async (t) => {
  const f = fixture(t); f.edit(1, '这个称呼暂时不能确定指谁。');
  assert.equal((await processSemanticNext({ ...f.options, generate: empty })).status, 'unchanged');
  assert.equal(f.archive.assess().get(f.a.id)?.status, 'unsupported');
  const plan = reviewPlans(f.archive, f.queue).plans[0]; assert.equal(plan.target, f.a.id);
  assert.equal((await reviewNext({ ...f.options, generate: empty })).status, 'unchanged');
  const restored = f.open(); let calls = 0;
  assert.equal((await reviewNext({ ...f.options, ...restored, generate: async () => { calls++; return empty(); } })).status, 'idle');
  assert.equal(calls, 0); assert.equal(f.archive.history(f.a.id).length, 1);
  f.insert(3, '新的独立输入');
  assert.equal((await processSemanticNext({ ...f.options, generate: empty })).status, 'unchanged', '旧失效来源不得阻断无关新输入');
  f.edit(1, '饭友是弟弟。');
  assert.notEqual(reviewPlans(f.archive, f.queue).plans[0].processor, plan.processor);
});

test('忽略、删除与改成助手来源均不把派生文字送入模型，也不阻断独立新输入', async (t) => {
  for (const sql of ["UPDATE messages SET mode='ignored' WHERE id=1", 'DELETE FROM messages WHERE id=1', "UPDATE messages SET role='agent' WHERE id=1"]) {
    const f = fixture(t); f.db.exec(sql); f.insert(3, '独立的新话题'); let called = false;
    // 助手角色修订自身只完成来源回执，不运行语义生成。
    if (sql.includes("role='agent'")) assert.equal((await processSemanticNext({ ...f.options, generate: async () => { throw new Error('不应调用'); } })).status, 'unchanged');
    assert.equal((await processSemanticNext({ ...f.options, generate: async (p) => {
      called = true; assert.ok(!p.user.includes('编辑'));
      assert.deepEqual(JSON.parse(p.user).records.map((r: any) => r.text), [f.c.text]); return empty();
    } })).status, 'unchanged');
    assert.ok(called); assert.equal(f.archive.assess().get(f.a.id)?.status, 'unsupported');
    assert.equal(f.archive.assess().get(f.c.id)?.status, 'supported');
    assert.equal(f.archive.history(f.a.id).length, 1, '访问过滤不悄悄删除历史');
  }
});

test('另一条尚未处理的编辑不提前泄漏；旧引用显式不可用，当前编辑仍可独立整合', async (t) => {
  const f = fixture(t); f.edit(1, '饭友是弟弟。'); f.edit(2, '下个检查点才出现的改写。');
  const result = await processSemanticNext({ ...f.options, generate: async (p) => {
    const d = JSON.parse(p.user); assert.equal(d.sources.length, 1);
    assert.ok(!p.user.includes('下个检查点')); assert.ok(p.user.includes('unavailableSource'));
    return change(p, f.a.text, '饭友是弟弟');
  } });
  assert.equal(result.status, 'revised');
  assert.equal(f.archive.assess().get(f.c.id)?.status, 'unsupported');
});

test('等待模型期间来源再次修改或被忽略，改写和空提案均不得完成旧任务', async (t) => {
  for (const emptyResult of [false, true]) for (const changeOther of [false, true]) {
    const f = fixture(t); f.edit(1, '饭友是弟弟。'); const generation = f.archive.generation();
    const result = await processSemanticNext({ ...f.options, generate: async (p) => {
      const proposal = emptyResult ? await empty() : change(p, f.a.text, '饭友是弟弟');
      if (changeOther) f.db.exec("UPDATE messages SET mode='ignored' WHERE id=2"); else f.edit(1, '第二次编辑，尚未重新检查。');
      return proposal;
    } });
    assert.equal(result.status, 'stale'); assert.equal(f.archive.generation(), generation);
    assert.equal(f.archive.history(f.a.id).length, 1);
  }
});

test('不能抄旧引文或通过旧记录引用绕过来源校验', async (t) => {
  for (const reuseReference of [false, true]) {
    const f = fixture(t); f.edit(1, '饭友是弟弟。'); const generation = f.archive.generation();
    const result = await processSemanticNext({ ...f.options, generate: async (p) => {
      const proposal = change(p, f.a.text, '饭友是弟弟'), record = proposal.records[0];
      if (reuseReference) { record.replace = null; record.supports[0].premises.push({ kind: 'record', key: JSON.parse(p.user).records.find((r: any) => r.text === f.a.text).key }); }
      else record.reasons[0].text = '饭友是编辑。';
      return proposal;
    } });
    assert.equal(result.status, reuseReference ? 'stale' : 'failed');
    assert.equal(f.archive.generation(), generation); assert.equal(f.archive.assess().get(f.a.id)?.status, 'unsupported');
  }
});

test('重评看得到旧依赖闭包之外的同语境对象与定义，隐藏和其他世界的对象不作候选', (t) => {
  const f = fixture(t); f.insert(3, '不可见对象定义');
  const node = (name: string, source = 2): ObjectRecord => ({ kind: 'node', id: crypto.randomUUID(), revision: 1, state: 'present',
    realm: { world: 'real', context: 'real' }, reasons: [f.span(source)], name, labels: ['person'] });
  const editor = node('已有编辑'), fictional = node('故事人物'), hidden = node('被隐藏人物', 3);
  fictional.realm = { world: 'fiction', context: crypto.randomUUID() };
  f.queue.scheduleSource('candidate-setup', 2); const job = f.queue.claim('candidate-setup')!;
  assert.ok(f.archive.accept(job, [2, 3].map((id) => { const s = f.queue.source(id)!; return { id, revision: s.revision, hash: s.hash }; }),
    { baseGeneration: f.archive.generation(), records: [editor, fictional, hidden] }));
  f.db.exec("UPDATE messages SET mode='ignored' WHERE id=3"); f.edit(1, '新的饭友归属');
  const plan = reviewPlans(f.archive, f.queue).plans.find((p) => p.target === f.a.id)!;
  const input = JSON.parse(plan.prompt.user);
  assert.equal(input.review.candidates.length, 1);
  const candidate = input.records.find((r: any) => r.key === input.review.candidates[0]);
  assert.equal(candidate.name, editor.name); assert.ok(candidate.reasons[0].source);
  assert.ok(!plan.prompt.user.includes('不可见')); assert.ok(!plan.prompt.user.includes('被隐藏')); assert.ok(!plan.prompt.user.includes('故事人物'));
});

test('重评候选超限显式延后，不截掉已有对象后要求模型猜一个新身份', (t) => {
  const f = fixture(t);
  const nodes: ObjectRecord[] = Array.from({ length: 100 }, (_, n) => ({ kind: 'node', id: crypto.randomUUID(), revision: 1, state: 'present',
    realm: { world: 'real', context: 'real' }, reasons: [f.span(2)], name: `合成人物${n}`, labels: [] }));
  f.queue.scheduleSource('many-candidates', 2); const job = f.queue.claim('many-candidates')!, s = f.queue.source(2)!;
  assert.ok(f.archive.accept(job, [{ id: s.id, revision: s.revision, hash: s.hash }], { baseGeneration: f.archive.generation(), records: nodes }));
  f.edit(1, '新的饭友归属');
  const plans = reviewPlans(f.archive, f.queue);
  assert.equal(plans.plans.length, 0); assert.equal(plans.deferred, 1);
});

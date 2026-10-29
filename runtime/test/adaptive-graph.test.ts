import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';
import { AdaptiveGraph } from '../src/memory/adaptive-graph.ts';
import { validateBatch, evaluateEvidence, spanCurrent, dependentRecords, type SemanticRecord, type ObjectRecord, type MentionRecord,
  type ClaimRecord, type SourceSpan, type RecordRef, type EvidenceGroup } from '../src/memory/adaptive-evidence.ts';

const realm = { world: 'real' as const, context: '合成现实会话' };
const ref = (r: SemanticRecord): RecordRef => ({ kind: r.kind, id: r.id, revision: r.revision });
const base = (reasons: SourceSpan[]) => ({ id: crypto.randomUUID(), revision: 1, state: 'present' as const, realm, reasons });
const node = (name: string, reason: SourceSpan): ObjectRecord => ({ ...base([reason]), kind: 'node', name, labels: ['人物'] });
const mention = (anchor: SourceSpan, candidates: ObjectRecord[], resolved: ObjectRecord | null = null): MentionRecord => ({
  ...base([anchor]), kind: 'mention', anchor, candidates: candidates.map(ref), unknown: !resolved, resolved: resolved && ref(resolved),
});
const group = (id: string, ...premises: (SourceSpan | RecordRef)[]): EvidenceGroup => ({ id, premises, assumptions: [] });
const claim = (text: string, reason: SourceSpan, supports = [group('direct', reason)]): ClaimRecord => ({
  ...base([reason]), kind: 'claim', text, nature: 'reported', participants: [], supports, counters: [],
  occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
});

test('纠正影响沿精确版本、参与者、支持和反证传递，不撤回独立依据', (t) => {
  const f = fixture(t); f.add(1, '编辑'); f.add(2, '吃饭并说了一句话'); f.add(3, '独立证明');
  const person = node('编辑', f.span(1)), m = mention(f.span(2), [person], person);
  const dinner = claim('一起吃饭', f.span(2)); dinner.participants = [{ role: '饭友', mention: ref(m) }];
  const quotation = claim('饭友说了一句话', f.span(2), [group('speaker', ref(m))]);
  const derived = claim('待重新检查的推论', f.span(2), [group('quote', ref(quotation))]);
  const alternate = claim('另有独立依据', f.span(3), [group('original', ref(quotation)), group('independent', f.span(3))]);
  const countered = claim('被引语反驳', f.span(3)); countered.counters = [group('against', ref(quotation))];
  const writing = claim('独立写作决定', f.span(3));
  const records = [person, m, dinner, quotation, derived, alternate, countered, writing];
  const copy = structuredClone(records);
  assert.deepEqual(new Set(dependentRecords(records, [ref(m)]).map((r) => r.id)), new Set([dinner, quotation, derived, alternate, countered].map((r) => r.id)));
  assert.deepEqual(dependentRecords(records, [{ ...ref(m), revision: 99 }]), [], '不同版本不是同一个变更目标');
  assert.deepEqual(records, copy, '影响检查不改变认识');
  const after = records.map((r) => r.id === m.id ? { ...r, revision: 2 } : r);
  const states = evaluateEvidence(after, (id) => f.queue.source(id));
  assert.equal(states.get(dinner.id)?.status, 'unsupported');
  assert.equal(states.get(alternate.id)?.status, 'supported', '受影响不等于撤回');
  assert.equal(states.get(writing.id)?.status, 'supported');
});

test('纠正影响遍历有界、去重、与排列无关；撤回历史不再传播', (t) => {
  const f = fixture(t); f.add(1, '合成依据');
  const a = claim('A', f.span(1)), b = claim('B', f.span(1)), c = claim('C', f.span(1));
  a.supports = [group('cycle', ref(b))]; b.supports = [group('cycle', ref(a), ref(a))];
  c.supports = [group('history', ref(b))]; c.state = 'withdrawn';
  assert.deepEqual(dependentRecords([a, b, c], [ref(a), ref(a)]), [ref(b)]);
  assert.deepEqual(dependentRecords([c, b, a], [ref(a)]), [ref(b)]);
  assert.throws(() => dependentRecords([a, b], [ref(a)], 1), /工作上限/);
  assert.throws(() => dependentRecords([a, a], []), /重复 ID/);
  assert.throws(() => dependentRecords([], [], 0), /工作上限/);
});

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-semantic-'));
  const file = path.join(home, 'memory.db'), connections: DatabaseSync[] = [];
  const open = () => { const db = new DatabaseSync(file); connections.push(db); db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON'); return db; };
  const db = open();
  db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)');
  const queue = new AdaptiveStore(db, 'synthetic-agent'), graph = new AdaptiveGraph(queue);
  t.after(() => { for (const c of connections) { try { c.close(); } catch {} } fs.rmSync(home, { recursive: true, force: true }); });
  let processor = 0;
  const add = (id: number, text: string, role = 'user') => db.prepare('INSERT INTO messages VALUES(?,?,?,\'合成\',?,\'conversation\',\'alpha\',NULL,NULL,NULL)').run(id, id * 1000, role, text);
  const span = (id: number, quote?: string): SourceSpan => {
    const s = queue.source(id)!; quote ??= s.text;
    const start = s.text.indexOf(quote); assert.ok(start >= 0);
    return { kind: 'source', source: id, hash: s.hash, start, end: start + quote.length, quote };
  };
  const inputs = () => (db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: number }[])
    .flatMap(({ id }) => { const s = queue.source(id); return s ? [{ id, revision: s.revision, hash: s.hash }] : []; });
  const job = () => { const p = `semantic-test-${++processor}`; queue.schedule(p, 100); return queue.claim(p, 100, 10000)!; };
  const accept = (records: SemanticRecord[]) => graph.accept(job(), inputs(), { baseGeneration: graph.generation(), records }, 101);
  return { db, open, queue, graph, add, span, inputs, job, accept };
}

test('AM-01：同名保留两个对象，模糊指代不支持引语归属，独立写作决定仍可用', (t) => {
  const f = fixture(t);
  f.add(1, '编辑周宁在工作室叫阿舟。'); f.add(2, '弟弟周宇在家里也叫阿舟。'); f.add(3, '昨晚和阿舟吃饭，他说别急着下结论。我决定补写年轻时的事。');
  const editor = node('周宁', f.span(1)), brother = node('周宇', f.span(2));
  const m = mention(f.span(3, '阿舟'), [editor, brother]);
  const quote = claim('饭友劝我别急着下结论', f.span(3)); quote.participants = [{ role: '说话者', mention: ref(m) }];
  const writing = claim('用户决定补写年轻时的事', f.span(3, '我决定补写年轻时的事'));
  assert.equal(f.accept([editor, brother, m, quote, writing]), true);
  const states = f.graph.assess();
  assert.equal(states.get(m.id)?.status, 'ambiguous');
  assert.equal(states.get(quote.id)?.status, 'unsupported');
  assert.deepEqual(f.graph.supportedClaims().map((x) => x.record.id), [writing.id]);
  assert.equal(f.graph.current().filter((r) => r.kind === 'node').length, 2);
});

test('AM-01/06：局部重新绑定使旧依赖失效，不机械替换人物，不撤回独立决定', (t) => {
  const f = fixture(t);
  f.add(1, '编辑叫阿舟。'); f.add(2, '弟弟也叫阿舟。'); f.add(3, '阿舟劝我别急着下结论。我决定补写。');
  const editor = node('编辑', f.span(1)), brother = node('弟弟', f.span(2));
  // 工程注入已发生的错误绑定；不是宣称模型正确识别了这条歧义。
  const m = mention(f.span(3, '阿舟'), [editor, brother], editor);
  const quote = claim('编辑劝我', f.span(3), [group('speaker', ref(m), f.span(3))]);
  const cause = claim('劝说导致补写', f.span(3), [group('cause', ref(quote))]); cause.nature = 'inferred';
  const writing = claim('决定补写', f.span(3, '我决定补写'));
  assert.equal(f.accept([editor, brother, m, quote, cause, writing]), true);
  const late = f.job(), oldGeneration = f.graph.generation(), oldInputs = f.inputs();
  f.add(4, '四月那次是弟弟，不是编辑；别急着下结论是我说的。');
  const corrected: MentionRecord = { ...m, revision: 2, reasons: [f.span(4)], resolved: ref(brother) };
  const replacement: ClaimRecord = { ...quote, revision: 2, text: '用户说别急着下结论', reasons: [f.span(4)], supports: [group('correction', f.span(4))] };
  assert.equal(f.accept([corrected, replacement]), true);
  assert.equal(f.graph.assess().get(cause.id)?.status, 'unsupported');
  assert.equal(f.graph.assess().get(writing.id)?.status, 'supported');
  assert.equal(f.graph.history(m.id)[0].kind, 'mention');
  assert.deepEqual((f.graph.history(m.id)[0] as MentionRecord).resolved, ref(editor));
  assert.equal(f.graph.history(editor.id).length, 1, '工作室昵称定义不被全局重写');
  assert.equal(f.graph.accept(late, oldInputs, { baseGeneration: oldGeneration, records: [claim('迟到的旧推论', f.span(3))] }, 102), false);
  assert.equal(f.graph.generation(), 2);
  assert.equal(f.queue.status(late.processor).counts.running, 1, '拒绝安装不伪造已完成回执');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM adaptive_publications').get()!.n, 2);
});

test('AM-07：AND / OR 分组、独立结论和访问过滤，审计理由不是额外必要前提', (t) => {
  const f = fixture(t); f.add(1, 'A 私密依据'); f.add(2, 'B'); f.add(3, 'C 独立充分依据'); f.add(4, 'L 无关');
  const k = claim('K', f.span(1), [group('g1', f.span(1), f.span(2)), group('g2', f.span(3))]);
  const l = claim('L', f.span(4)); assert.equal(f.accept([k, l]), true);
  assert.deepEqual(f.graph.assess().get(k.id)?.groups, ['g1', 'g2']);
  const restricted = (id: number) => id === 1 ? undefined : f.queue.source(id);
  const visible = f.graph.supportedClaims(restricted);
  assert.deepEqual(visible.find((x) => x.record.id === k.id)?.evidence.groups, ['g2']);
  assert.ok(!JSON.stringify(visible).includes('私密'), '不可访问的审计来源和失效依据组不随有效结论泄漏');
  f.db.prepare("UPDATE messages SET mode='ignored' WHERE id=1").run();
  assert.deepEqual(f.graph.assess().get(k.id)?.groups, ['g2']);
  f.db.prepare("UPDATE messages SET mode='ignored' WHERE id=3").run();
  assert.equal(f.graph.assess().get(k.id)?.status, 'unsupported');
  assert.equal(f.graph.assess().get(l.id)?.status, 'supported');
});

test('AM-07/09：无根循环不增信，有独立根时传播但同一根只计一次', (t) => {
  const f = fixture(t); f.add(1, '仅有一份根来源');
  const a = claim('A', f.span(1)), b = claim('B', f.span(1));
  a.supports = [group('cycle', ref(b))]; b.supports = [group('cycle', ref(a))];
  assert.equal(f.accept([a, b]), true);
  assert.equal(f.graph.supportedClaims().length, 0);
  const a2 = { ...a, revision: 2, supports: [group('root', f.span(1)), group('cycle', { ...ref(b), revision: 2 })] };
  const b2 = { ...b, revision: 2, supports: [group('cycle', ref(a2))] };
  assert.equal(f.accept([a2, b2]), true);
  for (const r of [a2, b2]) assert.equal(f.graph.assess().get(r.id)?.roots.length, 1);
});

test('AM-09：助手重复、无来源的模型自述不产生独立根，反证阻断下游', (t) => {
  const f = fixture(t); f.add(1, '听说甲可能辞职'); f.add(2, '我已经核实甲辞职', 'agent'); f.add(3, '刚才只是未经证实的传闻');
  const echo = claim('已核实', f.span(2));
  const rumor = claim('甲辞职', f.span(1)); rumor.counters = [group('counter', f.span(3))];
  const derived = claim('甲已经离职所以岗位空缺', f.span(1), [group('derived', ref(rumor))]); derived.nature = 'inferred';
  assert.equal(f.accept([echo, rumor, derived]), true);
  assert.equal(f.graph.assess().get(echo.id)?.status, 'unsupported');
  assert.equal(f.graph.assess().get(rumor.id)?.status, 'contested');
  assert.equal(f.graph.assess().get(derived.id)?.status, 'unsupported');
});

test('AM-04/16：世界语境与 agent 隔离；模型字段不能指定 verified', (t) => {
  const f = fixture(t); f.add(1, '小说里有弟弟阿舟');
  const fictional = { ...node('阿舟', f.span(1)), realm: { world: 'fiction' as const, context: '小说' } };
  const realMention = mention(f.span(1, '阿舟'), [fictional], fictional);
  assert.equal(f.accept([fictional, realMention]), false);
  assert.equal(f.graph.generation(), 0);
  assert.throws(() => new AdaptiveStore(f.db, 'other-agent'), /agent/);
  assert.throws(() => validateBatch({ baseGeneration: 0, records: [{ ...fictional, verified: true }] }), /格式/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM adaptive_publications').get()!.n, 0);
});

test('AM-12/20：持久版本重开不丢失，来源 hash 改变和取消均拒绝安装', (t) => {
  const f = fixture(t); f.add(1, '原始');
  const r = claim('原始断言', f.span(1)); assert.equal(f.accept([r]), true);
  const restored = new AdaptiveGraph(new AdaptiveStore(f.open(), 'synthetic-agent'));
  assert.equal(restored.generation(), 1); assert.deepEqual(restored.history(r.id), [r]);
  const old = f.job(), inputs = f.inputs(), batch = { baseGeneration: 1, records: [claim('旧任务', f.span(1))] };
  f.db.prepare("UPDATE messages SET text='修改后' WHERE id=1").run();
  assert.equal(f.graph.accept(old, inputs, batch, 102), false);
  assert.equal(restored.supportedClaims().length, 0);
  const cancelled = f.job(); f.queue.cancel(cancelled.id, 102);
  assert.equal(f.graph.accept(cancelled, f.inputs(), { baseGeneration: 1, records: [claim('取消任务', f.span(1))] }, 103), false);
  assert.equal(restored.generation(), 1);
});

test('AM-12：安装器部分写入后拒绝或异常，发件箱、投影和任务一起回滚', (t) => {
  const f = fixture(t); f.add(1, '合成来源');
  const job = f.job();
  const install = () => { f.db.prepare('UPDATE adaptive_graph_meta SET generation=999').run(); return false; };
  assert.equal(f.queue.acceptResult(job, f.inputs(), { schema: 'test-v1', data: {} }, 101, install), false);
  assert.equal(f.graph.generation(), 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM adaptive_publications').get()!.n, 0);
  assert.throws(() => f.queue.acceptResult(job, f.inputs(), { schema: 'test-v1', data: {} }, 101, () => { install(); throw new Error('injected'); }), /injected/);
  assert.equal(f.graph.generation(), 0); assert.equal(f.queue.status(job.processor).counts.running, 1);
  assert.equal(f.queue.complete(job, 102), true);
});

test('AM-01/05：精确片段、Unicode 边界、原文时间和有效期不能被结构校验伪造', (t) => {
  const f = fixture(t); f.add(1, '📚上周在港口听到故事');
  const correct = f.span(1, '上周'); assert.equal(spanCurrent(correct, (id) => f.queue.source(id)), true);
  const half = { ...f.span(1), start: 0, end: 1, quote: '\uD83D' };
  assert.equal(spanCurrent(half, (id) => f.queue.source(id)), false);
  const bad = claim('错误片段', { ...correct, quote: '下周' }); assert.equal(f.accept([bad]), false);
  const dated = claim('带时间', correct); dated.occurred = { text: '上周', earliest: '2026-02-30T00:00:00Z', latest: null };
  assert.throws(() => validateBatch({ baseGeneration: 0, records: [dated] }), /格式/);
  dated.occurred = { text: '上周', earliest: null, latest: null }; assert.equal(f.accept([dated]), true);
  assert.equal(f.graph.history(dated.id)[0].kind, 'claim');
  assert.equal(f.queue.source(1)?.ts, 1000, '发生时间描述不改原文时间戳');
});

test('必要假设保留为 conditional，缺失依据不能仅靠假设标签冒充支持', (t) => {
  const f = fixture(t); f.add(1, '前提');
  const r = claim('条件性结论', f.span(1)); r.supports[0].assumptions = ['如果没有其他入口'];
  assert.equal(f.accept([r]), true); assert.equal(f.graph.assess().get(r.id)?.status, 'conditional');
  assert.equal(f.graph.supportedClaims().length, 0);
  assert.equal(evaluateEvidence([r], () => undefined).get(r.id)?.status, 'unsupported');
  assert.throws(() => evaluateEvidence([r], (id) => f.queue.source(id), 1), /工作上限/);
  assert.throws(() => evaluateEvidence([r, r], (id) => f.queue.source(id)), /重复 ID/);
});

test('AM-07：反证同样绑定版本，隐藏反证不能让已知受反驳结论复活', (t) => {
  const f = fixture(t); f.add(1, '支持 K 的材料'); f.add(2, '反驳 K 的材料'); f.add(3, '撤回那项反驳');
  const rebuttal = claim('反证 R', f.span(2));
  const k = claim('K', f.span(1)); k.counters = [group('rebuttal', ref(rebuttal))];
  assert.equal(f.accept([rebuttal, k]), true);
  assert.equal(f.graph.assess().get(k.id)?.status, 'contested');
  assert.equal(f.graph.supportedClaims((id) => id === 2 ? undefined : f.queue.source(id)).some((x) => x.record.id === k.id), false);
  assert.equal(f.accept([{ ...rebuttal, revision: 2, state: 'withdrawn', reasons: [f.span(3)] }]), true);
  assert.equal(f.graph.assess().get(k.id)?.status, 'supported', '旧反证版本不能持续阻断，也不会被自动替换成新版本');
  assert.equal(f.queue.source(2)?.text, '反驳 K 的材料', '原文依然保留但不能绕开反证修订');
});

test('AM-07：相互反驳与自我反驳保持 indeterminate，不依赖记录遍历顺序', (t) => {
  const f = fixture(t); f.add(1, 'A 的材料'); f.add(2, 'B 的材料');
  const a = claim('A', f.span(1)), b = claim('B', f.span(2));
  a.counters = [group('not-b', ref(b))]; b.counters = [group('not-a', ref(a))];
  const c = claim('C', f.span(1), [group('from-a', ref(a))]);
  const self = claim('自反', f.span(1)); self.counters = [group('self', ref(self))];
  assert.equal(f.accept([a, b, c, self]), true);
  for (const order of [[a, b, c, self], [self, c, b, a]]) {
    const result = evaluateEvidence(order, (id) => f.queue.source(id));
    for (const r of order) assert.equal(result.get(r.id)?.status, 'indeterminate');
  }
  assert.equal(f.graph.supportedClaims().length, 0);
});

test('AM-07：有确定根的反证链逐层传播，不把所有负边循环简单当作失败', (t) => {
  const f = fixture(t); f.add(1, '共同材料');
  const a = claim('A', f.span(1)), b = claim('B', f.span(1)), c = claim('C', f.span(1));
  a.counters = [group('against-a', ref(b))]; b.counters = [group('against-b', ref(c))];
  assert.equal(f.accept([a, b, c]), true);
  const result = f.graph.assess();
  assert.equal(result.get(a.id)?.status, 'supported');
  assert.equal(result.get(b.id)?.status, 'contested');
  assert.equal(result.get(c.id)?.status, 'supported');
});

test('AM-20：一轮读取使用 SQLite 快照，外部连接中途改源只影响下一轮', (t) => {
  const f = fixture(t); f.add(1, '旧来源'); const r = claim('旧断言', f.span(1)); assert.equal(f.accept([r]), true);
  const other = f.open(); let changed = false;
  const read = (id: number) => {
    const source = f.queue.source(id);
    if (!changed) { changed = true; other.prepare("UPDATE messages SET text='新来源' WHERE id=1").run(); }
    return source;
  };
  assert.equal(f.graph.supportedClaims(read).length, 1);
  assert.equal(f.graph.supportedClaims().length, 0);
});


test('AM-12：未知投影版本或缺失元数据拒绝打开，DDL 失败不留下半套表', (t) => {
  const f = fixture(t);
  f.db.exec('DROP TABLE adaptive_graph_records; DROP TABLE adaptive_graph_batches; UPDATE adaptive_graph_meta SET version=999');
  assert.throws(() => new AdaptiveGraph(f.queue), /版本或代次/);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='adaptive_graph_records'").get(), undefined);
  f.db.exec('DELETE FROM adaptive_graph_meta');
  assert.throws(() => new AdaptiveGraph(f.queue), /版本或代次/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM adaptive_graph_meta').get()!.n, 0);
  f.db.exec('DROP TABLE adaptive_graph_meta; CREATE TABLE adaptive_graph_records(broken TEXT)');
  assert.throws(() => new AdaptiveGraph(f.queue), /artifact/);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='adaptive_graph_meta'").get(), undefined);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='adaptive_graph_batches'").get(), undefined);
});

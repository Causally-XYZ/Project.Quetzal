import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';
import { AdaptiveArchive } from '../src/memory/adaptive-archive.ts';
import { AdaptiveGraph } from '../src/memory/adaptive-graph.ts';
import { normalizeProposal, proposalPrompt } from '../src/memory/adaptive-proposal.ts';
import { evaluateEvidence, dependentRecords, type ClaimRecord, type MentionRecord, type ObjectRecord, type SemanticRecord, type SourceSpan } from '../src/memory/adaptive-evidence.ts';
import { selectSemantic, semanticBasis, semanticDigest } from '../src/memory/adaptive-query.ts';
import { decodeSemanticPacket } from '../src/memory/adaptive-query-packet.ts';
import { sourceReading } from '../src/memory/adaptive-reading.ts';
import { reviewPlans } from '../src/memory/adaptive-review.ts';
import { ARTIFACT_FORMAT, LEGACY_ARTIFACT_FORMAT, parseArtifact } from '../src/memory/adaptive-artifact.ts';

const ref = (r: SemanticRecord) => ({ kind: r.kind, id: r.id, revision: r.revision });
function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-cross-realm-')), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)');
  const queue = new AdaptiveStore(db, 'synthetic'), archive = new AdaptiveArchive(queue, home);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const texts = ['现实中的弟弟叫周宇。', '小说《潮汐》里父亲叫陆远，叔叔叫陆明。小说父亲离家了。', '周宇评价小说里的父亲很固执。', '更正：周宇评价的是小说里的叔叔陆明，不是父亲陆远。'];
  texts.forEach((text, i) => db.prepare("INSERT INTO messages VALUES(?,?,'user','synthetic',?,'session','body',NULL,NULL,NULL)").run(i + 1, i + 1, text));
  queue.schedule('prepare');
  const sources = texts.map((_, i) => queue.source(i + 1)!);
  const quote = (id: number): SourceSpan => ({ kind: 'source', source: id, hash: sources[id - 1].hash, start: 0, end: texts[id - 1].length, quote: texts[id - 1] });
  const real = { world: 'real' as const, context: 'real' }, fiction = { world: 'fiction' as const, context: 'novel' };
  const base = (id: number, realm = real as SemanticRecord['realm']) => ({ id: crypto.randomUUID(), revision: 1, state: 'present' as const, realm, reasons: [quote(id)] });
  const brother: ObjectRecord = { ...base(1), kind: 'node', name: '周宇', labels: [] };
  const father: ObjectRecord = { ...base(2, fiction), kind: 'node', name: '陆远', labels: [] };
  const uncle: ObjectRecord = { ...base(2, fiction), kind: 'node', name: '陆明', labels: [] };
  const mention = (node: ObjectRecord, id: number): MentionRecord => ({ ...base(id, node.realm), kind: 'mention', anchor: quote(id), candidates: [ref(node)], resolved: ref(node), unknown: false });
  const actor = mention(brother, 3), referent = mention(father, 3);
  const claim = (text: string, id: number, realm = real as SemanticRecord['realm']): ClaimRecord => ({ ...base(id, realm), kind: 'claim', text, nature: 'reported', participants: [],
    occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null }, supports: [{ id: 'direct', premises: [quote(id)], assumptions: [] }], counters: [] });
  const relation = claim('弟弟评价小说角色', 3); relation.participants = [{ role: '评价者', mention: ref(actor) }]; relation.references = [{ role: '被评价角色', mention: ref(referent) }];
  const storyFact = claim('小说父亲离家', 2, fiction), independent = claim('弟弟叫周宇', 1);
  const records = [brother, father, uncle, actor, referent, relation, storyFact, independent];
  let seq = 0;
  const accept = (records: SemanticRecord[]) => { const processor = `test-${++seq}`; queue.scheduleSource(processor, 3); const job = queue.claim(processor)!;
    return archive.accept(job, sources.map((s) => ({ id: s.id, revision: s.revision, hash: s.hash })), { baseGeneration: archive.generation(), records }); };
  return { db, queue, archive, sources, quote, real, fiction, brother, father, uncle, actor, referent, relation, storyFact, independent, records, accept, claim };
}

test('有来源的跨语境谈论可存档与查询；指向保留语境，不继承故事事实', (t) => {
  const f = fixture(t); assert.equal(f.accept(f.records), true);
  assert.equal(f.archive.assess().get(f.relation.id)?.status, 'supported');
  const read = (id: number) => f.queue.source(id);
  const selection = selectSemantic(f.records, '陆远', 1, read, read), item = selection.items.find((r) => r.id === f.relation.id)!;
  assert.equal(item.kind, 'claim'); if (item.kind !== 'claim') return;
  assert.equal(item.realm.world, 'real'); assert.equal(item.references?.[0].realm.world, 'fiction'); assert.equal(item.references?.[0].object.id, f.father.id);
  assert.deepEqual(item.supports[0].premises, [f.quote(3)], '引用角色不等于用故事事实作证明');
  assert.equal(evaluateEvidence(f.records.map((r) => r.id === f.relation.id ? { ...f.relation, supports: [] } : r), read).get(f.relation.id)?.status, 'unsupported');
  const hidden = (id: number) => id === 2 ? undefined : read(id);
  assert.ok(!selectSemantic(f.records, '陆远', 1, hidden, read).items.some((r) => r.id === f.relation.id));
  const packet = { version: 2, queryHash: semanticDigest('陆远'), generatedAt: Date.now(), agent: 'synthetic', host: 'center', status: 'ready', freshness: 'local-snapshot', ...selection, basis: semanticBasis(f.records, read) };
  assert.deepEqual(decodeSemanticPacket(packet, 'synthetic', 'center', '陆远'), packet);
  assert.throws(() => decodeSemanticPacket({ ...packet, version: 1 }, 'synthetic', 'center', '陆远'), /信封/);
  const malformed = structuredClone(packet); (malformed.items.find((r) => r.kind === 'claim' && r.references) as any).references[0].mention.kind = 'claim';
  assert.throws(() => decodeSemanticPacket(malformed, 'synthetic', 'center', '陆远'), /信封/);
});

test('跨语境身份、参与者、支持及反证仍拒绝，references 不能豁免同一引用的证明限制', (t) => {
  const f = fixture(t); assert.equal(f.accept(f.records), true);
  const invalid = [
    { ...f.relation, revision: 2, participants: [{ role: '现实当事人', mention: ref(f.referent) }] },
    { ...f.relation, revision: 2, supports: [{ id: 'false', premises: [ref(f.storyFact)], assumptions: [] }] },
    { ...f.relation, revision: 2, supports: [{ id: 'false', premises: [ref(f.referent)], assumptions: [] }] },
    { ...f.relation, revision: 2, counters: [{ id: 'false', premises: [ref(f.storyFact)], assumptions: [] }] },
    { ...f.actor, revision: 2, candidates: [ref(f.father)], resolved: ref(f.father) },
    { ...f.father, revision: 2, realm: f.real },
  ];
  for (const record of invalid) assert.equal(f.accept([record]), false);
  assert.throws(() => f.accept([{ ...f.relation, revision: 2, references: [{ role: '错误类型', mention: ref(f.father) }] }]));
  assert.equal(f.archive.generation(), 1);
});

test('引用对象歧义、后续纠正与来源排除沿版本传播，不牵连独立认识', (t) => {
  const f = fixture(t); assert.equal(f.accept(f.records), true);
  const ambiguous: MentionRecord = { ...f.referent, revision: 2, candidates: [ref(f.father), ref(f.uncle)], resolved: null, unknown: false };
  assert.equal(f.accept([ambiguous]), true);
  assert.equal(f.archive.assess().get(f.relation.id)?.status, 'unsupported');
  assert.ok(dependentRecords(f.records, [ref(f.referent)]).some((r) => r.id === f.relation.id));
  const corrected = { ...ambiguous, revision: 3, reasons: [f.quote(4)], resolved: ref(f.uncle) };
  assert.equal(f.accept([corrected]), true);
  assert.equal(f.archive.assess().get(f.relation.id)?.status, 'unsupported', '不能自动把评价父亲改成评价叔叔');
  const next = { ...f.relation, revision: 2, reasons: [f.quote(4)], text: '弟弟评价小说叔叔陆明', references: [{ role: '被评价角色', mention: ref(corrected) }], supports: [{ id: 'correction', premises: [f.quote(4)], assumptions: [] }] };
  assert.equal(f.accept([next]), true);
  assert.equal(f.archive.assess().get(f.relation.id)?.status, 'supported');
  assert.deepEqual(f.archive.history(f.independent.id), [f.independent]);
  const history = f.records.flatMap((r) => f.archive.history(r.id));
  const view = sourceReading(history, [3], f.archive.generation(), (id) => f.queue.source(id));
  assert.deepEqual(view.sources[0].notices.find((n) => n.id === f.relation.id)?.current?.references, [{ role: '被评价角色', realm: f.fiction, name: '陆明' }]);
  f.db.exec("UPDATE messages SET mode='ignored' WHERE id=4");
  assert.equal(f.archive.assess().get(f.relation.id)?.status, 'unsupported');
  assert.equal(f.archive.assess().get(f.independent.id)?.status, 'supported');
});

test('提案规范化保留跨语境指向，提示使用句柄且不泄漏内部身份', (t) => {
  const f = fixture(t), context = { generation: 0, current: 3, sources: f.sources, records: f.records.slice(0, 5) };
  const q = { kind: 'source', source: 's3', text: f.sources[2].text, occurrence: 0 };
  const p = { key: 'p1', replace: null, kind: 'claim', state: 'present', realm: 'real', reasons: [q], text: '弟弟评价小说角色', nature: 'reported',
    participants: [{ role: '评价者', mention: 'r4' }], references: [{ role: '被评价角色', mention: 'r5' }],
    occurred: f.relation.occurred, valid: f.relation.valid, supports: [{ id: 'direct', premises: [q], assumptions: [] }], counters: [] };
  const batch = normalizeProposal({ contexts: [], records: [p] }, context)!;
  assert.deepEqual((batch.records[0] as ClaimRecord).references, f.relation.references);
  const prompt = proposalPrompt({ ...context, records: [...context.records, batch.records[0]] });
  assert.ok(!prompt.user.includes(f.father.id)); assert.equal(JSON.parse(prompt.user).records[5].references[0].mention, 'r5');
  assert.throws(() => normalizeProposal({ contexts: [], records: [{ ...p, references: [{ role: '错误类型', mention: 'r2' }] }] }, context));
});

test('跨语境引用失效后的重评包含引用语境候选及当前纠正，不恢复旧绑定', (t) => {
  const f = fixture(t); assert.equal(f.accept(f.records), true);
  const corrected = { ...f.referent, revision: 2, reasons: [f.quote(4)], candidates: [ref(f.uncle)], resolved: ref(f.uncle) };
  assert.equal(f.accept([corrected]), true);
  const plan = reviewPlans(f.archive, f.queue).plans.find((p) => p.target === f.relation.id)!;
  assert.ok(plan); assert.equal(plan.context.current, 4);
  assert.deepEqual(plan.context.records.find((r) => r.id === f.referent.id), corrected);
  const input = JSON.parse(plan.prompt.user);
  const candidateIds = input.review.candidates.map((key: string) => plan.context.records[Number(key.slice(1)) - 1].id);
  assert.ok(candidateIds.includes(f.brother.id)); assert.ok(candidateIds.includes(f.father.id)); assert.ok(candidateIds.includes(f.uncle.id));
  assert.ok(plan.context.sources.some((s) => s.id === 4));
  assert.equal(f.archive.assess().get(f.relation.id)?.status, 'unsupported');
});

test('结果信封显式升版并能读取旧版；旧语义批次不能冒带新 references 字段', (t) => {
  const f = fixture(t); assert.equal(f.accept([f.independent]), true);
  const raw = String(f.db.prepare('SELECT document FROM adaptive_publications').get()!.document);
  assert.equal(JSON.parse(raw).format, ARTIFACT_FORMAT);
  const legacy = { ...JSON.parse(raw), format: LEGACY_ARTIFACT_FORMAT, payload: { schema: 'quetzal-adaptive-semantic-v1', data: { baseGeneration: 0, records: [f.independent] } } };
  assert.deepEqual(parseArtifact(JSON.stringify(legacy), 'synthetic'), legacy);
  assert.throws(() => parseArtifact(JSON.stringify({ ...JSON.parse(raw), format: LEGACY_ARTIFACT_FORMAT }), 'synthetic'), /新版结果信封/);
  // 在真实存档回放前验证旧信封；无需改变原文件摘要或覆盖新存档。
  const other = new DatabaseSync(':memory:'); t.after(() => other.close());
  other.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)');
  const graph = new AdaptiveGraph(new AdaptiveStore(other, 'synthetic')); graph.rebuild([legacy]);
  assert.deepEqual(graph.current(), [f.independent]);
  const forged = structuredClone(legacy); forged.payload.data.records[0].references = [];
  assert.throws(() => graph.rebuild([forged])); assert.deepEqual(graph.current(), [f.independent]);
  const revised = { ...f.independent, revision: 2, references: [] };
  const next = { ...JSON.parse(raw), id: crypto.randomUUID(), payload: { schema: 'quetzal-adaptive-semantic-v2', data: { baseGeneration: 1, records: [revised] } } };
  graph.rebuild([next, legacy]);
  assert.equal(graph.generation(), 2); assert.deepEqual(graph.history(f.independent.id), [f.independent, revised]);
  graph.rebuild([legacy, next]); assert.deepEqual(graph.current(), [revised]);
});


test('v3 条件性跨语境讨论携带完整身份根；不能省略假设或借故事事实', (t) => {
  const f = fixture(t), read = (id: number) => f.queue.source(id);
  f.relation.nature = 'hypothesis'; f.relation.supports[0].assumptions = ['评价与本次写作意图有关'];
  const selection = selectSemantic(f.records, '陆远', 1, read, read);
  const item = selection.items.find((r) => r.id === f.relation.id)!;
  assert.equal(item.status, 'conditional'); assert.equal(item.kind, 'claim');
  if (item.kind !== 'claim') return;
  assert.equal(item.references?.[0].realm.world, 'fiction');
  assert.deepEqual(new Set(item.roots.map((r) => r.id)), new Set([1, 2, 3]));
  const packet = { version: 3, queryHash: semanticDigest('陆远'), generatedAt: Date.now(), agent: 'synthetic', host: 'center', status: 'ready', freshness: 'local-snapshot', ...selection, basis: semanticBasis(f.records, read) };
  assert.deepEqual(decodeSemanticPacket(packet, 'synthetic', 'center', '陆远'), packet);
  for (const version of [1, 2]) assert.throws(() => decodeSemanticPacket({ ...packet, version }, 'synthetic', 'center', '陆远'));
  f.relation.supports[0].premises = [ref(f.storyFact)];
  assert.ok(!selectSemantic(f.records, '陆远', 1, read, read).items.some((r) => r.id === f.relation.id));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { selectSemantic } from '../src/memory/adaptive-query.ts';
import type { SemanticRecord, ClaimRecord, ObjectRecord, MentionRecord, SourceSpan, RecordRef, EvidenceSource } from '../src/memory/adaptive-evidence.ts';

function fixture() {
  const sources = new Map<number, EvidenceSource>();
  const source = (text: string): SourceSpan => {
    const id = sources.size + 1, hash = crypto.createHash('sha256').update(text).digest('hex');
    sources.set(id, { text, hash, role: 'user' });
    return { kind: 'source', source: id, hash, start: 0, end: text.length, quote: text };
  };
  const base = (s: SourceSpan) => ({ id: crypto.randomUUID(), revision: 1, state: 'present' as const, realm: { world: 'real' as const, context: 'real' }, reasons: [s] });
  const node = (name: string, s: SourceSpan): ObjectRecord => ({ ...base(s), kind: 'node', name, labels: [] });
  const claim = (text: string, s: SourceSpan): ClaimRecord => ({ ...base(s), kind: 'claim', text, nature: 'reported', participants: [],
    occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
    supports: [{ id: 'direct', premises: [s], assumptions: [] }], counters: [] });
  const read = (id: number) => sources.get(id);
  return { sources, source, base, node, claim, read };
}
const ref = (r: SemanticRecord): RecordRef => ({ kind: r.kind, id: r.id, revision: r.revision });

test('已支持陈述保留推测性质、时间与根来源，人物名称可命中相关陈述', () => {
  const f = fixture(), s = f.source('编辑小林一起去采风'), person = f.node('编辑小林', s);
  const mention: MentionRecord = { ...f.base(s), kind: 'mention', anchor: s, candidates: [ref(person)], resolved: ref(person), unknown: false };
  const c = f.claim('这次走访可能为选题提供素材', s); c.nature = 'inferred'; c.participants = [{ role: '同行者', mention: ref(mention) }];
  c.occurred = { text: '六月', earliest: null, latest: null };
  const records = [person, mention, c], original = structuredClone(records);
  const result = selectSemantic(records, '编辑小林', 3, f.read, f.read);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].kind, 'claim');
  if (result.items[0].kind === 'claim') assert.deepEqual(result.items[0].participants, [{ role: '同行者', mention: ref(mention), object: { id: person.id, revision: 1, name: person.name } }]);
  assert.equal((result.items[0] as any).nature, 'inferred'); assert.deepEqual((result.items[0] as any).occurred, c.occurred);
  assert.deepEqual(result.items[0].roots, [{ id: s.source, hash: s.hash }]); assert.deepEqual(records, original);
  assert.equal(selectSemantic(records, '完全无关的火箭', 3, f.read, f.read).items.length, 0);
});

test('歧义保留候选与未知对象，隐藏候选名字不泄漏也不强制选择剩余对象', () => {
  const f = fixture(), s = f.source('阿林又来了'), a = f.source('同事林先生'), b = f.source('私密朋友林先生');
  const first = f.node('同事小林', a), second = f.node('私密小林', b);
  const m: MentionRecord = { ...f.base(s), kind: 'mention', anchor: s, candidates: [ref(first), ref(second)], unknown: false, resolved: null };
  const records = [first, second, m], visible = (id: number) => id === b.source ? undefined : f.read(id);
  const result = selectSemantic(records, '阿林', 1, visible, f.read);
  const item = result.items[0]; assert.equal(item.kind, 'mention');
  if (item.kind !== 'mention') throw new Error('expected mention');
  assert.equal(item.status, 'ambiguous'); assert.equal(item.unknown, true); assert.equal(item.candidates.length, 1);
  assert.ok(!JSON.stringify(result).includes('私密')); assert.deepEqual(item.roots, [{ id: s.source, hash: s.hash }]);
});

test('纠正使依赖旧版本的推论退出，独立支持仍可查询且不回传失效依据', () => {
  const f = fixture(), a = f.source('采风来源甲'), b = f.source('采风来源乙');
  const first = f.claim('采风的基础认识', a), derived = f.claim('采风推论', a);
  derived.supports = [{ id: 'derived', premises: [ref(first)], assumptions: [] }];
  const alternative = f.claim('采风有独立支持', b); alternative.supports.push({ id: 'old', premises: [ref(first)], assumptions: [] });
  const changed = { ...first, revision: 2, text: '纠正后的基础认识' };
  const result = selectSemantic([changed, derived, alternative], '采风', 2, f.read, f.read);
  assert.ok(!result.items.some((r) => r.id === derived.id));
  const item = result.items.find((r) => r.id === alternative.id)!;
  assert.equal(item.kind, 'claim'); if (item.kind === 'claim') assert.deepEqual(item.supports.map((g) => g.id), ['direct']);
});

test('隐藏反证不使认识复活，忽略、已撤回、条件与助手自证不当作可用结论', () => {
  const f = fixture(), s = f.source('采风依据'), hidden = f.source('私密反证');
  const c = f.claim('采风成立', s); c.counters = [{ id: 'against', premises: [hidden], assumptions: [] }];
  assert.equal(selectSemantic([c], '采风', 1, (id) => id === hidden.source ? undefined : f.read(id), f.read).items.length, 0);
  const conditional = f.claim('采风条件', s); conditional.supports[0].assumptions = ['尚未核实'];
  const withdrawn = { ...f.claim('采风旧结论', s), state: 'withdrawn' as const };
  assert.equal(selectSemantic([conditional, withdrawn], '采风', 1, f.read, f.read).items.length, 0);
  assert.equal(selectSemantic([f.claim('采风', s)], '采风', 1, () => undefined, f.read).items.length, 0);
  f.sources.set(s.source, { ...f.read(s.source)!, role: 'agent' });
  assert.equal(selectSemantic([f.claim('采风', s)], '采风', 1, f.read, f.read).items.length, 0);
});

test('数量与输出有界，取完整认识而非截断证据；空查询不挑任意结果', () => {
  const f = fixture(), s = f.source('共同采风'); const records = Array.from({ length: 9 }, (_, i) => f.claim(`共同采风${i}`, s));
  const result = selectSemantic(records, '采风', 1, f.read, f.read);
  assert.equal(result.items.length, 6); assert.equal(result.matched, 9);
  assert.equal(selectSemantic(records, '', 1, f.read, f.read).items.length, 0);
  assert.throws(() => selectSemantic(Array.from({ length: 1001 }, () => records[0]), '采风', 1, f.read, f.read), /工作上限/);
});

test('模型改写语言不同仍能以精确原文命中，不索引同消息的其他主题或改写返回正文', () => {
  const f = fixture(), full = f.source('我的编辑叫林岚。另一个话题是火山摄影。');
  const span = { ...full, end: 7, quote: full.quote.slice(0, 7) };
  const c = f.claim('The editor is Lin Lan.', span);
  const hit = selectSemantic([c], '编辑叫什么', 1, f.read, f.read).items[0];
  assert.equal(hit.id, c.id); assert.ok(hit.kind === 'claim'); assert.equal(hit.text, c.text);
  assert.equal(selectSemantic([c], '火山摄影', 1, f.read, f.read).matched, 0);
  assert.equal(selectSemantic([c], '编辑', 1, () => undefined, f.read).matched, 0);
  f.sources.set(full.source, { ...f.read(full.source)!, text: '已编辑原文', hash: 'f'.repeat(64) });
  assert.equal(selectSemantic([c], '编辑', 1, f.read, f.read).matched, 0);
});

test('共同有效的多步支持链和提及锚点参与匹配，原节点修订后不沿旧版本召回', () => {
  const f = fixture(), s = f.source('港口采风'), p = f.node('Harbor', s);
  const m: MentionRecord = { ...f.base(s), kind: 'mention', anchor: s, candidates: [ref(p)], resolved: ref(p), unknown: false };
  const a = f.claim('Fieldwork location', s); a.supports = [{ id: 'mention', premises: [ref(m)], assumptions: [] }];
  const b = f.claim('A working hypothesis', s); b.nature = 'hypothesis'; b.supports = [{ id: 'upstream', premises: [ref(a)], assumptions: [] }];
  assert.ok(selectSemantic([p, m, a, b], '采风', 1, f.read, f.read).items.some((r) => r.id === b.id));
  const changed = { ...a, revision: 2 };
  assert.ok(!selectSemantic([p, m, changed, b], '采风', 2, f.read, f.read).items.some((r) => r.id === b.id));
  // 带独立支持的正向环仍有界，重复引文不会重复加权。
  a.supports.push({ id: 'cycle', premises: [ref(b)], assumptions: [] });
  assert.ok(selectSemantic([p, m, a, b], '采风', 1, f.read, f.read).items.some((r) => r.id === b.id));
});

test('不以审计原因、条件组、隐藏或全局失效分支中的词制造匹配', () => {
  const f = fixture(), clean = f.source('ordinary evidence'), audit = f.source('审计秘密'), conditional = f.source('条件秘密');
  const branch = f.source('分支秘密'), counter = f.source('明确反证');
  const a = f.claim('A disputed premise', branch); a.counters = [{ id: 'counter', premises: [counter], assumptions: [] }];
  const b = f.claim('A supported result', clean); b.reasons = [audit];
  b.supports.push({ id: 'conditional', premises: [conditional], assumptions: ['待核实'] }, { id: 'branch', premises: [ref(a)], assumptions: [] });
  const local = (id: number) => id === counter.source ? undefined : f.read(id);
  for (const query of ['审计秘密', '条件秘密', '分支秘密']) assert.equal(selectSemantic([a, b], query, 1, local, f.read).matched, 0);
  const result = selectSemantic([a, b], 'supported result', 1, local, f.read).items[0];
  assert.equal(result.kind, 'claim'); if (result.kind === 'claim') assert.deepEqual(result.supports.map((g) => g.id), ['direct']);
  const hidden = (id: number) => id === clean.source ? undefined : local(id);
  assert.equal(selectSemantic([a, b], 'ordinary', 1, hidden, f.read).matched, 0);
});

test('可见与全局各自成立但没有共同证明时，不能返回当前认识或借它支持下游', () => {
  const f = fixture(), publicSource = f.source('public basis'), privateSource = f.source('private basis'), counter = f.source('hidden counter');
  const a = f.claim('local branch', publicSource); a.counters = [{ id: 'against', premises: [counter], assumptions: [] }];
  const b = f.claim('global branch', privateSource);
  const c = f.claim('target inconsistent support', publicSource); c.supports = [
    { id: 'local-only', premises: [ref(a)], assumptions: [] }, { id: 'global-only', premises: [ref(b)], assumptions: [] }];
  const d = f.claim('target dependent', publicSource); d.supports = [{ id: 'dependent', premises: [ref(c)], assumptions: [] }];
  const e = f.claim('target independent alternative', publicSource); e.supports.push({ id: 'bad', premises: [ref(d)], assumptions: [] });
  const local = (id: number) => [privateSource.source, counter.source].includes(id) ? undefined : f.read(id);
  const selected = selectSemantic([a, b, c, d, e], 'target', 1, local, f.read);
  assert.deepEqual(selected.items.map((r) => r.id), [e.id]);
  const item = selected.items[0]; assert.ok(item.kind === 'claim'); assert.deepEqual(item.supports.map((g) => g.id), ['direct']);
  assert.deepEqual(item.roots, [{ id: publicSource.source, hash: publicSource.hash }]);
});

test('纠正后旧措辞可定位当前认识，但无效旧支持不制造命中，索引预算超限不返回半份', () => {
  const f = fixture(), old = f.source('旧称紫鹭'), fresh = f.source('新的名称是白鸥');
  const c = f.claim('The current name is White Gull.', fresh); c.revision = 2; c.reasons = [old, fresh];
  assert.equal(selectSemantic([c], '紫鹭', 2, f.read, f.read).matched, 0);
  c.supports[0].premises.push(old);
  const result = selectSemantic([c], '紫鹭', 2, f.read, f.read).items[0];
  assert.equal(result.revision, 2); assert.ok(result.kind === 'claim'); assert.equal(result.text, c.text);
  const spans = Array.from({ length: 9 }, () => f.source('a'.repeat(8000)));
  const huge = f.claim('Large source set', spans[0]); huge.supports[0].premises = spans;
  assert.throws(() => selectSemantic([huge], 'source', 2, f.read, f.read), /检索依据超过工作上限/);
});

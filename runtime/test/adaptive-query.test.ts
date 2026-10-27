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

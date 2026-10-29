import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { selectSemantic, semanticCandidates, semanticDigest } from '../src/memory/adaptive-query.ts';
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
  const conditional = { ...c, id: crypto.randomUUID(), nature: 'hypothesis' as const, supports: c.supports.map((g) => ({ ...g, assumptions: ['待核实条件'] })) };
  const selected = selectSemantic([a, b, c, d, e, conditional], 'target', 1, local, f.read);
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


test('索引候选绑定完整当前内容与版本，不继承旧正文、隐藏来源或失效支持', () => {
  const f = fixture(), s = f.source('在海边采访守灯塔的人'), c = f.claim('为小说采集口述素材', s);
  const initial = semanticCandidates([c], f.read, f.read);
  assert.equal(initial.length, 1); assert.match(initial[0].key, /^[a-f0-9]{64}$/);
  assert.equal(initial[0].text, `${c.text}\n${s.quote}`);
  assert.deepEqual(semanticCandidates([structuredClone(c)], f.read, f.read), initial);
  const revised = { ...c, revision: 2, text: '这次是旅行记录，尚未决定是否用于小说' };
  const next = semanticCandidates([revised], f.read, f.read);
  assert.notEqual(next[0].key, initial[0].key);
  assert.equal(next[0].item.revision, 2);
  assert.ok(!next[0].text.includes(c.text));
  const retimed = { ...revised, occurred: { text: '去年六月', earliest: null, latest: null } };
  assert.notEqual(semanticCandidates([retimed], f.read, f.read)[0].key, next[0].key);
  assert.deepEqual(semanticCandidates([revised], () => undefined, f.read), []);
  f.sources.set(s.source, { ...f.read(s.source)!, hash: 'f'.repeat(64) });
  assert.deepEqual(semanticCandidates([revised], f.read, f.read), []);
});

test('索引候选的共同支持分支和可见对象变化都会改变摘要，不泄漏隐藏候选名', () => {
  const f = fixture(), a = f.source('采访来源甲'), b = f.source('采访来源乙');
  const c = f.claim('有两个独立采访依据', a);
  c.supports.push({ id: 'alternative', premises: [b], assumptions: [] });
  const all = semanticCandidates([c], f.read, f.read)[0];
  const onlyB = (id: number) => id === a.source ? undefined : f.read(id);
  const limited = semanticCandidates([c], onlyB, f.read)[0];
  assert.notEqual(all.key, limited.key); assert.ok(!limited.text.includes(a.quote));
  assert.deepEqual(limited.item.roots, [{ id: b.source, hash: b.hash }]);
  const anchor = f.source('阿舟来了'), first = f.node('同事阿舟', a), second = f.node('私密朋友阿舟', b);
  const mention: MentionRecord = { ...f.base(anchor), kind: 'mention', anchor, candidates: [ref(first), ref(second)], resolved: null, unknown: false };
  const records = [first, second, mention];
  const visible = (id: number) => id === b.source ? undefined : f.read(id);
  const full = semanticCandidates(records, f.read, f.read)[0], narrowed = semanticCandidates(records, visible, f.read)[0];
  assert.notEqual(full.key, narrowed.key); assert.ok(!JSON.stringify(narrowed).includes('私密'));
  assert.ok(narrowed.item.kind === 'mention' && narrowed.item.unknown);
});


test('额外近邻只能重新排序当前候选，旧查询、修订和不可访问来源不能借索引复活', () => {
  const f = fixture(), s = f.source('到海边采访守灯塔的人'), c = f.claim('为小说收集素材', s);
  const query = 'What first-hand research did I plan?';
  const key = semanticCandidates([c], f.read, f.read)[0].key;
  const neighbors = { queryHash: semanticDigest(query), keys: [key, key, 'f'.repeat(64)] };
  assert.equal(selectSemantic([c], query, 1, f.read, f.read).matched, 0);
  const hit = selectSemantic([c], query, 1, f.read, f.read, neighbors);
  assert.equal(hit.matched, 1); assert.equal(hit.items[0].id, c.id);
  assert.equal(selectSemantic([c], 'different query', 1, f.read, f.read, neighbors).matched, 0);
  assert.equal(selectSemantic([{ ...c, revision: 2 }], query, 2, f.read, f.read, neighbors).matched, 0);
  assert.equal(selectSemantic([c], query, 1, () => undefined, f.read, neighbors).matched, 0);
  assert.equal(selectSemantic([{ ...c, state: 'withdrawn' }], query, 2, f.read, f.read, neighbors).matched, 0);
  const counter = f.source('这次明确不用于创作'); c.counters = [{ id: 'against', premises: [counter], assumptions: [] }];
  assert.equal(selectSemantic([c], query, 2, (id) => id === counter.source ? undefined : f.read(id), f.read, neighbors).matched, 0);
});

test('无效或超量近邻降级同门禁词面检索，语义次序不改变认识、支持与来源', () => {
  const f = fixture(), s = f.source('采风'), a = f.claim('采风计划甲', s), b = f.claim('另一项安排', s);
  const records = [a, b], query = '采风', baseline = selectSemantic(records, query, 1, f.read, f.read);
  for (const keys of [['bad-key'], Array.from({ length: 1001 }, () => 'a'.repeat(64))]) {
    assert.deepEqual(selectSemantic(records, query, 1, f.read, f.read, { queryHash: semanticDigest(query), keys }), baseline);
  }
  const candidates = semanticCandidates(records, f.read, f.read);
  const result = selectSemantic(records, query, 1, f.read, f.read, { queryHash: semanticDigest(query), keys: candidates.map((x) => x.key).reverse() });
  assert.equal(result.matched, 2);
  for (const item of result.items) assert.deepEqual(item, baseline.items.find((x) => x.id === item.id));
});


test('有共同有效前提的条件性推测可供讨论，但不证明下游；纠正或反证立即移除', () => {
  const f = fixture(), a = f.source('周六活动'), b = f.source('线路维护');
  const base = f.claim('线路维护', b), h = f.claim('活动交通可能受影响', a); h.nature = 'hypothesis';
  h.supports = [{ id: 'conditional', premises: [a, ref(base)], assumptions: ['用户选择该线路'] }];
  const downstream = f.claim('活动已经取消', a); downstream.supports = [{ id: 'invalid', premises: [ref(h)], assumptions: [] }];
  let result = selectSemantic([base, h, downstream], '活动交通', 1, f.read, f.read);
  const item = result.items.find((i) => i.id === h.id)!;
  assert.equal(item.status, 'conditional'); assert.equal(item.kind, 'claim');
  if (item.kind === 'claim') assert.deepEqual(item.supports, h.supports);
  assert.deepEqual(new Set(item.roots.map((r) => r.id)), new Set([a.source, b.source]));
  assert.ok(!result.items.some((i) => i.id === downstream.id));
  const oldKey = semanticCandidates([base, h], f.read, f.read).find((i) => i.item.id === h.id)!.key;
  assert.ok(!selectSemantic([{ ...base, revision: 2 }, h], '活动交通', 2, f.read, f.read, { queryHash: semanticDigest('活动交通'), keys: [oldKey] }).items.some((i) => i.id === h.id));
  assert.ok(!selectSemantic([base, h], '活动交通', 1, (id) => id === b.source ? undefined : f.read(id), f.read).items.some((i) => i.id === h.id));
  const counter = f.source('线路正常运行'); h.counters = [{ id: 'against', premises: [counter], assumptions: [] }];
  assert.ok(!selectSemantic([base, h], '活动交通', 1, (id) => id === counter.source ? undefined : f.read(id), f.read).items.some((i) => i.id === h.id));
});

test('有根的未决争议成组返回，相关下游只作争议，独立充分支持仍可使用', () => {
  const f = fixture(), a = f.source('运费清单记为80元'), b = f.source('回忆运费是50元'), c = f.source('独立说明可报销');
  const first = f.claim('运费为80元', a), second = f.claim('运费为50元', b);
  first.counters = [{ id: 'other', premises: [ref(second)], assumptions: [] }];
  second.counters = [{ id: 'other', premises: [ref(first)], assumptions: [] }];
  const downstream = f.claim('报销金额为80元', a);
  downstream.supports = [{ id: 'derived', premises: [ref(first)], assumptions: [] }];
  const independent = f.claim('运费可以报销', c);
  independent.supports.push({ id: 'alternative', premises: [ref(first)], assumptions: [] });
  const records = [first, second, downstream, independent], before = structuredClone(records);
  const result = selectSemantic(records, '运费报销', 1, f.read, f.read);
  const dispute = result.items.find((r) => r.kind === 'conflict' && r.records.length === 2);
  assert.ok(dispute?.kind === 'conflict');
  assert.deepEqual(new Set(dispute.records.map((r) => r.id)), new Set([first.id, second.id]));
  assert.deepEqual(dispute.roots, [{ id: a.source, hash: a.hash }, { id: b.source, hash: b.hash }]);
  assert.equal(result.items.filter((r) => r.kind === 'conflict' && r.records.length === 2).length, 1, '双方共享的争议只呈现一次');
  assert.ok(result.items.some((r) => r.id === downstream.id && r.kind === 'conflict'));
  const safe = result.items.find((r) => r.id === independent.id);
  assert.ok(safe?.kind === 'claim'); assert.deepEqual(safe.supports.map((g) => g.id), ['direct']);
  assert.ok(!result.items.some((r) => r.kind === 'claim' && [first.id, second.id, downstream.id].includes(r.id)));
  assert.deepEqual(records, before);
});

test('争议缺少任一必要来源、当前版本或完整字节预算时不泄漏半份；澄清后解除', () => {
  const f = fixture(), a = f.source('工作室租金3000'), b = f.source('我记得工作室租金2800'), clarification = f.source('核实租金2800，另外200是物业费');
  const first = f.claim('工作室租金3000', a), second = f.claim('工作室租金2800', b);
  first.counters = [{ id: 'other', premises: [ref(second)], assumptions: [] }];
  second.counters = [{ id: 'other', premises: [ref(first)], assumptions: [] }];
  const records = [first, second];
  assert.equal(selectSemantic(records, '租金', 1, f.read, f.read).items[0]?.kind, 'conflict');
  const hidden = (id: number) => id === b.source ? undefined : f.read(id);
  assert.deepEqual(selectSemantic(records, '租金', 1, hidden, f.read).items, []);
  const changed = (id: number) => id === b.source ? { ...f.read(id)!, hash: 'f'.repeat(64) } : f.read(id);
  assert.ok(!selectSemantic(records, '租金', 1, changed, f.read).items.some((r) => r.kind === 'conflict'));
  assert.ok(!selectSemantic([first, { ...second, revision: 2 }], '租金', 2, f.read, f.read).items.some((r) => r.kind === 'conflict'));
  const large = structuredClone(records);
  for (let i = 0; i < 12; i++) large[0].reasons.push(f.source(`记录${i}${'租'.repeat(7000)}`));
  assert.deepEqual(selectSemantic(large, '租金', 1, f.read, f.read).items, []);
  const resolved = { ...second, revision: 2, counters: [], supports: [{ id: 'clarified', premises: [clarification], assumptions: [] }] };
  const result = selectSemantic([{ ...first, revision: 2, state: 'withdrawn' }, resolved], '租金', 2, f.read, f.read);
  assert.deepEqual(result.items.map((r) => [r.kind, r.id, r.revision]), [['claim', second.id, 2]]);
});

test('没有原始支持的循环和单向已生效反证不伪装成未决争议', () => {
  const f = fixture(), s = f.source('讨论活动是否延期');
  const a = f.claim('活动延期', s), b = f.claim('活动未延期', s);
  a.supports = [{ id: 'loop', premises: [ref(b)], assumptions: [] }];
  b.supports = [{ id: 'loop', premises: [ref(a)], assumptions: [] }];
  a.counters = [{ id: 'other', premises: [ref(b)], assumptions: [] }];
  b.counters = [{ id: 'other', premises: [ref(a)], assumptions: [] }];
  assert.deepEqual(selectSemantic([a, b], '活动', 1, f.read, f.read).items, []);
  a.supports = [{ id: 'direct', premises: [s], assumptions: [] }];
  b.supports = [{ id: 'direct', premises: [s], assumptions: [] }]; b.counters = [];
  const result = selectSemantic([a, b], '活动', 1, f.read, f.read);
  assert.deepEqual(result.items.map((r) => [r.id, r.kind]), [[b.id, 'claim']]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sourceReading, sourceReadingHeader, sourceRecordedAt } from '../src/memory/adaptive-reading.ts';
import { evaluateEvidence, type SemanticRecord, type ObjectRecord, type MentionRecord, type ClaimRecord, type SourceSpan, type SourceReader } from '../src/memory/adaptive-evidence.ts';
import { answerSource } from '../src/memory/answer-basis.ts';

test('消息时间缺失、非数值或超出日期范围时保持未知，不回填当前时间', () => {
  assert.equal(sourceRecordedAt(0), '1970-01-01T00:00:00.000Z');
  for (const value of [undefined, null, NaN, Infinity, 1e20, '2026-04-10']) assert.equal(sourceRecordedAt(value), null);
});

function fixture() {
  const sources = new Map([[1, '编辑叫阿舟'], [2, '弟弟也叫阿舟'], [3, '阿舟劝我，我决定补写'], [4, '更正，饭友是弟弟，引语是我说的']]);
  const read = (id: number) => { const text = sources.get(id); return text ? { text, hash: crypto.createHash('sha256').update(text).digest('hex'), role: 'user' } : undefined; };
  const span = (id: number): SourceSpan => ({ kind: 'source', source: id, hash: read(id)!.hash, start: 0, end: read(id)!.text.length, quote: read(id)!.text });
  const base = (id: number) => ({ id: crypto.randomUUID(), revision: 1, state: 'present' as const, realm: { world: 'real' as const, context: 'real' }, reasons: [span(id)] });
  const ref = (r: SemanticRecord) => ({ kind: r.kind, id: r.id, revision: r.revision });
  const editor: ObjectRecord = { ...base(1), kind: 'node', name: '编辑', labels: [] };
  const brother: ObjectRecord = { ...base(2), kind: 'node', name: '弟弟', labels: [] };
  const mention: MentionRecord = { ...base(3), kind: 'mention', anchor: span(3), candidates: [ref(editor), ref(brother)], unknown: false, resolved: ref(editor) };
  const claim = (text: string, id = 3): ClaimRecord => ({ ...base(id), kind: 'claim', text, nature: 'reported', participants: [],
    occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
    supports: [{ id: 'direct', premises: [span(id)], assumptions: [] }], counters: [] });
  const quote = claim('编辑劝我'); quote.supports[0].premises.push(ref(mention));
  const independent = claim('决定补写');
  const corrected: MentionRecord = { ...mention, revision: 2, reasons: [span(4)], resolved: ref(brother) };
  const history: SemanticRecord[] = [editor, brother, mention, quote, independent, corrected];
  return { sources, read, span, ref, claim, editor, brother, mention, quote, independent, corrected, history };
}

test('原文覆盖层指出局部重新绑定和下游失效，不删除原文或撤回同段独立认识', () => {
  const f = fixture(), view = sourceReading(f.history, [3], 2, f.read), notices = view.sources[0].notices;
  assert.equal(notices.find((n) => n.id === f.mention.id)?.current?.text, '弟弟');
  assert.ok(notices.find((n) => n.id === f.mention.id)?.current?.sources.some((s) => s.id === 4 && s.hash === f.span(4).hash));
  assert.equal(notices.find((n) => n.id === f.quote.id)?.status, 'unsupported');
  assert.equal(notices.find((n) => n.id === f.quote.id)?.current, null);
  assert.ok(!notices.some((n) => n.id === f.independent.id));
  assert.ok(notices.every((n) => n.spans.some((s) => s.hash === f.span(3).hash)));
  assert.equal(f.sources.get(3), '阿舟劝我，我决定补写');
  assert.match(sourceReadingHeader(view, 3), /不撤回整段/);
});

test('纠正改用新来源，旧消息仍携带替代内容；来源再编辑不偷换旧偏移的 hash', () => {
  const f = fixture(), revised = { ...f.quote, revision: 2, text: '用户说了引语', reasons: [f.span(4)], supports: [{ id: 'correct', premises: [f.span(4)], assumptions: [] }] };
  const history = [...f.history, revised];
  let view = sourceReading(history, [3], 3, f.read);
  assert.equal(view.sources[0].notices.find((n) => n.id === revised.id)?.current?.text, '用户说了引语');
  const oldHash = f.span(3).hash; f.sources.set(3, '编辑后的当前原文');
  view = sourceReading(history, [3], 3, f.read);
  assert.notEqual(view.sources[0].hash, oldHash);
  assert.ok(view.sources[0].notices.some((n) => n.spans.some((s) => s.hash === oldHash)));
});

test('仅时间字段修订而正文相同时，旧来源覆盖层仍给出发生和有效时间；隐藏纠正不泄漏', () => {
  const f = fixture(), original = f.claim('听到港口故事');
  original.occurred = { text: '上周', earliest: null, latest: null };
  const revised = { ...original, revision: 2, reasons: [f.span(4)],
    occurred: { text: '三月中旬', earliest: null, latest: null }, valid: { text: '自四月起', earliest: null, latest: null },
    supports: [{ id: 'corrected', premises: [f.span(4)], assumptions: [] }] };
  const history = [original, revised];
  const view = sourceReading(history, [3], 2, f.read), current = view.sources[0].notices[0].current!;
  assert.equal(current.text, original.text); assert.deepEqual(current.occurred, revised.occurred); assert.deepEqual(current.valid, revised.valid);
  assert.match(sourceReadingHeader(view, 3), /三月中旬/); assert.match(sourceReadingHeader(view, 3), /自四月起/);
  const hidden = sourceReading(history, [3], 2, (id) => id === 4 ? undefined : f.read(id), f.read);
  assert.equal(hidden.sources[0].notices[0].current, null); assert.ok(!JSON.stringify(hidden).includes('三月中旬'));
  assert.equal(original.occurred.text, '上周');
});

test('隐藏纠正 / 反证不泄漏正文，也不因隐藏反证而重新报告支持；不可访问原文无正文入口', () => {
  const f = fixture(), countered = { ...f.quote, revision: 2, supports: [{ id: 'direct', premises: [f.span(3)], assumptions: [] }],
    counters: [{ id: 'counter', premises: [f.span(4)], assumptions: [] }], text: '含不可见纠正内容的认识' };
  const visible = (id: number) => id === 4 ? undefined : f.read(id);
  const view = sourceReading([...f.history, countered], [3, 4], 3, visible, f.read);
  assert.equal(view.sources[0].notices.find((n) => n.id === countered.id)?.status, 'unavailable');
  assert.ok(!JSON.stringify(view).includes('含不可见'));
  assert.ok(!JSON.stringify(view).includes('更正，饭友'));
  assert.throws(() => sourceReadingHeader(view, 4), /不可访问/);
});

test('循环按确切历史版本去重，无依据时仅报告状态；超范围拒绝整个结果', () => {
  const f = fixture(), a = f.claim('A'), b = f.claim('B');
  a.supports[0].premises = [f.ref(b)]; b.supports[0].premises = [f.ref(a)];
  const view = sourceReading([a, b], [3], 1, f.read);
  assert.equal(view.sources[0].notices.length, 2);
  assert.ok(view.sources[0].notices.every((n) => n.current === null));
  assert.throws(() => sourceReading([a, a], [3], 1, f.read), /重复/);
  assert.throws(() => sourceReading([], Array.from({ length: 1001 }, (_, i) => i + 1), 1, f.read), /范围/);
});

function partialRoles() {
  const f = fixture();
  const unknown: MentionRecord = { ...f.mention, id: crypto.randomUUID(), candidates: [], unknown: true, resolved: null };
  const report = f.claim('阿舟劝我');
  report.participants = [{ role: 'speaker', mention: f.ref(f.mention) }, { role: 'recipient', mention: f.ref(unknown) }];
  const records: SemanticRecord[] = [f.editor, f.brother, f.mention, unknown, report];
  const read = (visible: SourceReader = f.read, global: SourceReader = f.read) => sourceReading(records, [3], 1, visible, global);
  const notice = (visible?: SourceReader, global?: SourceReader) => read(visible, global).sources[0].notices.find((n) => n.id === report.id)!;
  return { ...f, unknown, report, records, readView: read, notice };
}

test('收件人未解不抹去说话人绑定；读取解释不提升整条认识的证明状态', () => {
  const f = partialRoles(), view = f.readView(), n = f.notice();
  assert.equal(evaluateEvidence(f.records, f.read).get(f.report.id)?.status, 'unsupported');
  assert.equal(n.status, 'unsupported'); assert.equal(n.current, null);
  assert.deepEqual(n.identityGap?.bindings.map((b) => [b.role, b.binding?.name ?? null]), [['speaker', '编辑'], ['recipient', null]]);
  assert.deepEqual(n.identityGap?.sources, [f.span(3)]);
  const header = sourceReadingHeader(view, 3);
  assert.match(header, /身份关联未完整/); assert.match(header, /整条认识仍不能作为完整推理前提/);
  assert.equal(f.report.participants.length, 2);
  const before = answerSource(view.sources[0]);
  f.records.push(f.corrected);
  assert.equal(f.notice().identityGap, undefined); // 旧 mention 引用失效，不偷换为最新绑定。
  const revised = { ...f.report, revision: 2, participants: [{ role: 'speaker', mention: f.ref(f.corrected) }, f.report.participants[1]] };
  f.records.push(revised);
  assert.equal(f.notice().identityGap?.bindings[0].binding?.name, '弟弟');
  assert.notEqual(answerSource(f.readView().sources[0]).reading, before.reading);
});

test('缺失 / 编辑 / 隐藏 / 非用户来源与失效身份不会被解释为仅身份未解', () => {
  for (const mode of ['missing', 'edited', 'hidden-node', 'hidden-anchor', 'assistant', 'withdrawn-node', 'withdrawn-claim']) {
    const f = partialRoles();
    let visible = f.read, global = f.read;
    if (mode === 'missing') f.sources.delete(3);
    if (mode === 'edited') f.sources.set(3, '改过的原文');
    if (mode === 'hidden-node') visible = (id) => id === 1 ? undefined : f.read(id);
    if (mode === 'hidden-anchor') visible = (id) => id === 3 ? undefined : f.read(id);
    if (mode === 'assistant') visible = global = (id) => { const s = f.read(id); return s && { ...s, role: 'assistant' }; };
    if (mode === 'withdrawn-node') f.editor.state = 'withdrawn';
    if (mode === 'withdrawn-claim') f.report.state = 'withdrawn';
    const view = f.readView(visible, global);
    assert.ok(view.sources.every((s) => s.notices.every((n) => !n.identityGap)), mode);
  }
});

test('有反证、假设、间接证明或无直接支持的认识保留原状态，不猜唯一失败原因', () => {
  for (const mode of ['counter', 'hidden-counter', 'conditional', 'indirect', 'empty', 'inferred']) {
    const f = partialRoles();
    if (mode.includes('counter')) f.report.counters = [{ id: 'counter', premises: [f.span(4)], assumptions: [] }];
    if (mode === 'conditional') f.report.supports[0].assumptions = ['某条件'];
    if (mode === 'indirect') f.report.supports[0].premises = [f.ref(f.independent)];
    if (mode === 'empty') f.report.supports = [];
    if (mode === 'inferred') f.report.nature = 'inferred';
    const visible = mode === 'hidden-counter' ? (id: number) => id === 4 ? undefined : f.read(id) : f.read;
    assert.equal(f.notice(visible).identityGap, undefined, mode);
  }
});

test('跨语境被谈论对象显式标为 reference，不能伪装成同一现实事件的参与者', () => {
  const f = partialRoles();
  f.editor.realm = f.mention.realm = { world: 'fiction', context: 'story' };
  assert.equal(f.notice().identityGap, undefined);
  f.report.references = [f.report.participants.shift()!];
  const binding = f.notice().identityGap?.bindings.find((b) => b.usage === 'reference');
  assert.equal(binding?.binding?.name, '编辑'); assert.equal(binding?.realm.world, 'fiction');
  assert.match(sourceReadingHeader(f.readView(), 3), /不是跨语境事实依据/);
});

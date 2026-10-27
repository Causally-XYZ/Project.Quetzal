import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sourceReading, sourceReadingHeader } from '../src/memory/adaptive-reading.ts';
import type { SemanticRecord, ObjectRecord, MentionRecord, ClaimRecord, SourceSpan } from '../src/memory/adaptive-evidence.ts';

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

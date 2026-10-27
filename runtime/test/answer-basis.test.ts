import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerDigest, answerSource, mergeAnswerSources, answerBasisStatus, parseAnswerBasis, type AnswerBasis } from '../src/memory/answer-basis.ts';
import type { SourceReading } from '../src/memory/adaptive-reading.ts';
const view: SourceReading = { generation: 1, freshness: 'local-snapshot', sources: [{ id: 1, hash: 'a'.repeat(64), notices: [] }] };
const basis = (): AnswerBasis => ({ version: 1, agent: 'synthetic', answerHash: answerDigest('历史回答'), consistent: true, sources: view.sources.map(answerSource) });
test('跨身体核查使用来源与修订而非本机 generation；没有把来源未变当回答真值', () => {
  const b = basis(); assert.equal(answerBasisStatus(b, '历史回答', 'synthetic', { ...view, generation: 99 }), 'unchanged');
  assert.equal(answerBasisStatus(b, '历史回答', 'synthetic', { ...view, sources: [...view.sources, { id: 2, hash: 'b'.repeat(64), notices: [] }] }), 'unchanged');
  assert.equal(answerBasisStatus(b, '正文改了', 'synthetic', view), 'changed');
  assert.equal(answerBasisStatus(b, '历史回答', 'other', view), 'changed');
  assert.equal(answerBasisStatus(b, '历史回答', 'synthetic', { ...view, sources: [] }), 'changed');
  assert.equal(answerBasisStatus(b, '历史回答', 'synthetic', { ...view, sources: [{ ...view.sources[0], hash: null }] }), 'changed');
  assert.equal(answerBasisStatus({ ...b, consistent: false }, '历史回答', 'synthetic', view), 'changed');
});
test('同一轮混合来源版本或超限留下不可沿用状态，不能用最后版本覆盖掩盖', () => {
  const initial = mergeAnswerSources(undefined, basis().sources);
  assert.equal(mergeAnswerSources(initial, basis().sources).consistent, true);
  assert.equal(mergeAnswerSources(initial, [{ ...basis().sources[0], hash: 'b'.repeat(64) }]).consistent, false);
  const over = mergeAnswerSources(undefined, Array.from({ length: 1001 }, (_, i) => ({ ...basis().sources[0], id: i + 1 })));
  assert.equal(over.consistent, false); assert.equal(over.sources.length, 1000);
});
test('凭据拒绝未知版本、重复来源、未知字段及非法摘要', () => {
  assert.deepEqual(parseAnswerBasis(JSON.parse(JSON.stringify(basis()))), basis());
  for (const b of [{ ...basis(), version: 2 }, { ...basis(), sources: [...basis().sources, ...basis().sources] },
    { ...basis(), trusted: true }, { ...basis(), answerHash: 'bad' }, { ...basis(), sources: [{ ...basis().sources[0], body: 'unexpected' }] }])
    assert.throws(() => parseAnswerBasis(b));
});

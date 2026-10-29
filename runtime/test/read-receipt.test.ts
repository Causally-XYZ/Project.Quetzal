import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureMemoryRead, observeReadSources, observeReadDocument, observeRecallPresentation, parseReadReceipt, readDigest } from '../src/memory/read-receipt.ts';
const scope = { agent: 'synthetic-agent', body: 'reader', conv: 'conv', tool: 'recall' };
const observe = (id: number) => observeReadSources({ generation: 1, freshness: 'local-snapshot', sources: [{ id, hash: 'a'.repeat(64), notices: [] }] });

test('并行异步工具捕获隔离，凭据只含标识与摘要', async () => {
  const work = (id: number) => captureMemoryRead(scope, async () => {
    observe(id); await new Promise((r) => setImmediate(r));
    observeReadDocument('note', `note-${id}`, 'SYNTHETIC_DOCUMENT_SECRET');
    return { text: `result-${id}`, status: 'ok' };
  });
  const [a, b] = await Promise.all([work(1), work(2)]);
  assert.deepEqual(a.reading!.sources.map((s) => s.id), [1]); assert.deepEqual(b.reading!.sources.map((s) => s.id), [2]);
  assert.ok(!JSON.stringify(a.reading).includes('SYNTHETIC_DOCUMENT_SECRET'));
  assert.equal(parseReadReceipt(a.reading).resultHash, readDigest('result-1'));
});

test('一次捕获的矛盾版本或来源超限不签发可用凭据，错误也不签发', async () => {
  const different = await captureMemoryRead(scope, async () => {
    observe(1); observeReadSources({ generation: 2, freshness: 'local-snapshot', sources: [{ id: 1, hash: 'b'.repeat(64), notices: [] }] });
    return { text: 'mixed', status: 'ok' };
  });
  assert.equal(different.reading!.checked, false);
  const over = await captureMemoryRead(scope, async () => { for (let i = 1; i <= 1001; i++) observe(i); return { text: 'over', status: 'ok' }; });
  assert.equal(over.reading!.checked, false); assert.equal(over.reading!.sources.length, 1000);
  const failed = await captureMemoryRead(scope, async () => { observe(1); return { text: 'error', status: 'error' }; });
  assert.equal(failed.reading, undefined);
});

test('凭据解析拒绝未知版本、重复来源及超限文档', async () => {
  const out = await captureMemoryRead(scope, async () => { observe(1); return { text: 'result', status: 'ok' }; });
  const receipt = out.reading!;
  assert.throws(() => parseReadReceipt({ ...receipt, version: 2 }), /损坏/);
  assert.throws(() => parseReadReceipt({ ...receipt, sources: [...receipt.sources, ...receipt.sources] }), /损坏/);
  assert.throws(() => parseReadReceipt({ ...receipt, documents: Array.from({ length: 201 }, (_, i) => ({ kind: 'note', key: String(i), hash: 'a'.repeat(64) })) }), /损坏/);
  assert.throws(() => parseReadReceipt({ ...receipt, sources: receipt.sources.map((s) => ({ ...s, stateHash: 'invalid' })) }), /损坏/);
  assert.equal(parseReadReceipt({ ...receipt, sources: receipt.sources.map(({ stateHash, ...s }) => s) }).checked, true);
});

test('原文未改但同一次读取的修订状态变化，也拒绝沿用混合结果', async () => {
  const result = await captureMemoryRead(scope, async () => {
    observe(1);
    observeReadSources({ generation: 2, freshness: 'local-snapshot', sources: [{ id: 1, hash: 'a'.repeat(64), notices: [],
      answer: { status: 'changed', sources: [2] } }] });
    return { text: 'mixed-reading-state', status: 'ok' };
  });
  assert.equal(result.reading!.checked, false);
});

test('召回展示位置只绑定最终原样结果，脱敏或包装改变布局即保守回退', async () => {
  const original = '可信修订头\n原文';
  for (const text of [original, '可信修订头\n已脱敏', '包装前缀' + original, original + '审核附注']) {
    const out = await captureMemoryRead(scope, async () => {
      observe(1); observeRecallPresentation(original, '可信修订头\n'.length);
      return { text, status: 'ok' };
    });
    assert.equal(out.reading!.resultHash, readDigest(text));
    assert.equal(out.reading!.sources.length, 1); assert.equal(out.reading!.checked, true);
    assert.deepEqual(out.reading!.presentation, text === original ? { kind: 'chat-recall-v1', headerEnd: 6 } : undefined);
    assert.doesNotThrow(() => parseReadReceipt(out.reading));
    for (const presentation of [{ kind: 'unknown', headerEnd: 1 }, { kind: 'chat-recall-v1', headerEnd: -1 },
      { kind: 'chat-recall-v1', headerEnd: 1.2 }, { kind: 'chat-recall-v1', headerEnd: 1, extra: true }])
      assert.throws(() => parseReadReceipt({ ...out.reading, presentation }), /损坏/);
    assert.throws(() => parseReadReceipt({ ...out.reading, tool: 'note_read', presentation: { kind: 'chat-recall-v1', headerEnd: 1 } }), /损坏/);
  }
});

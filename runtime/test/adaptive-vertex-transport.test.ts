import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adcFetch, vertexPlaceholder, vertexModels, type VertexReceipt } from '../tool/adaptive-vertex-transport.ts';

const url = `${vertexPlaceholder}/models/${vertexModels[1]}:streamGenerateContent?alt=sse`;
const credentials = async () => ({ project: 'synthetic-project', token: 'synthetic-token' });
test('开发 ADC 认证只注入许可端点，流式响应和原始请求正文保持不变', async () => {
  const receipts: VertexReceipt[] = [], body = '{"contents":[]}', raw = `data: ${JSON.stringify({ modelVersion: vertexModels[1], candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 7 } })}\n\n`;
  const send = adcFetch(async (input, init) => {
    assert.equal(String(input), `https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models/${vertexModels[1]}:streamGenerateContent?alt=sse`);
    assert.equal(init?.body, body); assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer synthetic-token');
    assert.equal(headers.get('x-goog-api-key'), null); assert.equal(headers.get('unrelated-header'), null);
    return new Response(raw, { headers: { 'content-type': 'text/event-stream' } });
  }, credentials, (r) => receipts.push(r));
  const response = await send(url, { method: 'POST', body, headers: { 'x-goog-api-key': 'placeholder', 'unrelated-header': 'not-forwarded' } });
  assert.equal(await response.text(), raw);
  assert.deepEqual(receipts[0].versions, [vertexModels[1]]); assert.deepEqual(receipts[0].finish, ['STOP']);
  assert.deepEqual(receipts[0].usage, [{ promptTokenCount: null, candidatesTokenCount: null, thoughtsTokenCount: null, totalTokenCount: 7 }]);
  assert.ok(!JSON.stringify(receipts).includes('synthetic-token'));
});
test('非开发请求原样透传且不读 ADC；未知模型与路径不得使用 ADC', async () => {
  let fetched = 0, auth = 0;
  const send = adcFetch(async () => { fetched++; return new Response('pass'); }, async () => { auth++; return credentials(); }, () => {});
  assert.equal(await (await send('https://other.invalid')).text(), 'pass');
  await assert.rejects(send(`${vertexPlaceholder}/models/unknown:streamGenerateContent?alt=sse`, { method: 'POST' }));
  await assert.rejects(send(url, { method: 'GET' }));
  assert.equal(fetched, 1); assert.equal(auth, 0);
});
test('HTTP 与网络失败不回显账号、URL、令牌或供应商错误正文', async () => {
  const secret = 'provider-sensitive-sentinel';
  const http = adcFetch(async () => new Response(secret, { status: 403 }), credentials, () => {});
  const response = await http(url, { method: 'POST' });
  assert.equal(response.status, 403); assert.ok(!(await response.text()).includes(secret));
  const network = adcFetch(async () => { throw new Error(secret); }, credentials, () => {});
  await assert.rejects(network(url, { method: 'POST' }), (e: Error) => !e.message.includes(secret));
});
test('保留未知模型标记与缺失计量；流中断也不泄漏异常详情', async () => {
  const receipts: VertexReceipt[] = [];
  const send = adcFetch(async () => new Response('data: {"modelVersion":"unexpected-private-value"}\n\n'), credentials, (r) => receipts.push(r));
  await (await send(url, { method: 'POST' })).text();
  assert.deepEqual(receipts[0].versions, ['unexpected-model']); assert.deepEqual(receipts[0].usage, []);
  const broken = adcFetch(async () => new Response(new ReadableStream({ pull(c) { c.error(new Error('secret-sentinel')); } })), credentials, () => {});
  await assert.rejects((await broken(url, { method: 'POST' })).text(), (e: Error) => !e.message.includes('secret-sentinel'));
});

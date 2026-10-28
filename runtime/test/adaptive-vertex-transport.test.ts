import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { adcFetch, vertexPlaceholder, vertexModels, type VertexReceipt } from '../tool/adaptive-vertex-transport.ts';

const url = `${vertexPlaceholder}/models/${vertexModels[1]}:streamGenerateContent?alt=sse`;
const credentials = async () => ({ project: 'synthetic-project', token: 'synthetic-token' });
test('外部上下文取消时回执仍绑定原调用，不能丢失或归给另一请求', async () => {
  const context = new AsyncLocalStorage<string>(), seen: { call: string | undefined; receipt: VertexReceipt }[] = [];
  const controller = new AbortController();
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
  const send = adcFetch(async (_input, init) => {
    started(); return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  }, credentials, (receipt) => seen.push({ call: context.getStore(), receipt }));
  const request = context.run('original-call', () => send(url, { method: 'POST', signal: controller.signal }));
  await ready;
  context.run('unrelated-call', () => controller.abort());
  await assert.rejects(request);
  assert.equal(seen.length, 1); assert.equal(seen[0].call, 'original-call');
  assert.equal(seen[0].receipt.state, 'cancelled'); assert.equal(seen[0].receipt.phase, 'headers');
});
test('ADC 只观察已配置的思考等级，原始正文逐字透传', async () => {
  const receipts: VertexReceipt[] = [];
  const request = { contents: [{ role: 'user', parts: [{ text: '合成来源' }] }], generationConfig: {
    maxOutputTokens: 16384, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' }, thinkingConfig: { thinkingLevel: 'LOW' } } };
  const body = JSON.stringify(request, null, 2);
  const send = adcFetch(async (_input, init) => {
    assert.equal(init?.body, body);
    return new Response('data: {"modelVersion":"gemini-3.8-flash"}\n\n');
  }, credentials, (r) => receipts.push(r));
  await (await send(url, { method: 'POST', body })).text();
  assert.equal(receipts[0].thinkingLevel, 'LOW');
});
test('未配置思考等级不补默认值，未知字段值不原样进入安全回执', async () => {
  const receipts: VertexReceipt[] = [];
  const send = adcFetch(async () => new Response('data: {}\n\n'), credentials, (r) => receipts.push(r));
  await (await send(url, { method: 'POST', body: '{}' })).text();
  await (await send(url, { method: 'POST', body: JSON.stringify({ generationConfig: { thinkingConfig: { thinkingLevel: 'PRIVATE-SENTINEL' } } }) })).text();
  assert.equal(Object.hasOwn(receipts[0], 'thinkingLevel'), false); assert.equal(receipts[1].thinkingLevel, 'other');
  assert.ok(!JSON.stringify(receipts).includes('PRIVATE-SENTINEL'));
});
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

test('失败阶段与取消只记录一次，凭据等待失败和响应头前失败可区分', async () => {
  for (const phase of ['credentials', 'headers'] as const) {
    const receipts: VertexReceipt[] = [];
    const send = adcFetch(async () => { throw new Error('PRIVATE-ENDPOINT'); }, async () => {
      if (phase === 'credentials') throw new Error('PRIVATE-TOKEN'); return credentials();
    }, (r) => receipts.push(r));
    await assert.rejects(send(url, { method: 'POST' }));
    assert.equal(receipts.length, 1); assert.equal(receipts[0].phase, phase); assert.equal(receipts[0].state, 'failed');
    assert.equal(receipts[0].status, null); assert.equal(receipts[0].bytes, 0); assert.deepEqual(receipts[0].usage, []);
    assert.ok(!JSON.stringify(receipts).includes('PRIVATE'));
  }
  const receipts: VertexReceipt[] = [], controller = new AbortController();
  let started!: () => void; const waiting = new Promise<void>((resolve) => { started = resolve; });
  const send = adcFetch(async (_input, init) => {
    started(); return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('PRIVATE')), { once: true }));
  }, credentials, (r) => receipts.push(r));
  const request = send(url, { method: 'POST', signal: controller.signal });
  await waiting; controller.abort(); await assert.rejects(request);
  assert.equal(receipts.length, 1); assert.equal(receipts[0].state, 'cancelled'); assert.equal(receipts[0].phase, 'headers');
  assert.equal(typeof receipts[0].credentialsMs, 'number'); assert.equal(receipts[0].headersMs, undefined);
});

test('流中断保留已收到的计量与首字节时间，HTTP 不读取敏感错误正文', async () => {
  const receipts: VertexReceipt[] = [], raw = 'data: {"modelVersion":"gemini-3.8-flash","usageMetadata":{"promptTokenCount":12}}\n\n';
  let n = 0;
  const send = adcFetch(async () => new Response(new ReadableStream({ pull(c) {
    if (n++ === 0) c.enqueue(new TextEncoder().encode(raw)); else c.error(new Error('PRIVATE-BODY'));
  } }), { headers: { 'content-type': 'text/event-stream' } }), credentials, (r) => receipts.push(r));
  await assert.rejects((await send(url, { method: 'POST' })).text());
  assert.equal(receipts.length, 1); const r = receipts[0];
  assert.equal(r.phase, 'body'); assert.equal(r.state, 'failed'); assert.equal(r.status, 200);
  assert.equal(r.bytes, Buffer.byteLength(raw)); assert.equal(typeof r.firstByteMs, 'number');
  assert.deepEqual(r.versions, [vertexModels[1]]); assert.deepEqual(r.finish, []); assert.equal((r.usage[0] as any).promptTokenCount, 12);
  const http = adcFetch(async () => new Response('PRIVATE-BODY', { status: 429 }), credentials, (r) => receipts.push(r));
  await (await http(url, { method: 'POST' })).text();
  assert.equal(receipts[1].state, 'http'); assert.equal(receipts[1].status, 429); assert.equal(receipts[1].bytes, 0);
  assert.ok(!JSON.stringify(receipts).includes('PRIVATE'));
});

test('调用方取消响应流也生成终态；已取消请求不再取得凭据', async () => {
  const receipts: VertexReceipt[] = []; let auth = 0, cancelled = false;
  const send = adcFetch(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
    async () => { auth++; return credentials(); }, (r) => receipts.push(r));
  await (await send(url, { method: 'POST' })).body!.cancel();
  assert.equal(cancelled, true); assert.equal(receipts.length, 1); assert.equal(receipts[0].state, 'cancelled');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(send(url, { method: 'POST', signal: controller.signal }));
  assert.equal(auth, 1); assert.equal(receipts[1].phase, 'credentials'); assert.equal(receipts[1].state, 'cancelled');
});

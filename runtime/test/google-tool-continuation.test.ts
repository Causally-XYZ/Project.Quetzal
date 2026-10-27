import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapters, type Target } from '../src/providers/adapters.ts';
import { runTurn, type EnginePorts, type Msg, type TurnControl } from '../../engine/src/index.ts';

const target: Target = { protocol: 'google-generative-ai', baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic', model: 'synthetic-model', maxTokens: 1000 };
const first = { functionCall: { name: 'recall', args: { query: '人物' } }, thoughtSignature: 'synthetic-signature-1' };
const parallel = { functionCall: { name: 'recall', args: { query: '别名' } } };
const next = { functionCall: { name: 'recall', args: { query: '原文' } }, thoughtSignature: 'synthetic-signature-2' };
const response = (parts: unknown[]) => ({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });

for (const format of ['sse', 'json'] as const) test(`Gemini ${format} 的并行和连续工具调用经真实引擎保留各自签名`, async (t) => {
  const seen: any[] = [], replies = [response([first, parallel]), response([next]), response([{ text: '仍有两个候选，不能确定。' }])];
  t.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)); seen.push(request);
    const reply = replies.shift(); assert.ok(reply, '不得出现额外模型请求');
    return new Response(format === 'sse' ? `data: ${JSON.stringify(reply)}\n\n` : JSON.stringify(reply),
      { headers: { 'content-type': format === 'sse' ? 'text/event-stream' : 'application/json' } });
  });
  const controller = new AbortController();
  const turn: TurnControl = {
    id: 'synthetic', signal: controller.signal, stepText: '', check() {}, touch() {}, emit() {},
    beginLLM: () => controller.signal, endLLM() {}, delta() {}, flush() {}, hold: (work) => work(),
  };
  const executed: unknown[] = [], records: unknown[] = [];
  const ports: EnginePorts = {
    chat: (request) => adapters[target.protocol](target, request),
    async execute(call) { executed.push(call.args); return { text: '合成原文', status: 'ok' }; },
    async drain() {}, pending: () => false, incoming: () => false, check() {},
    interrupted: () => false, stopToolWait: () => false, moved: () => undefined,
    cleanText: (text) => text, redactArgs: (args) => args, summarize: () => '回查',
    recordTool: (record) => { records.push(record); }, warning() {},
  };
  const messages: Msg[] = [{ role: 'user', content: '是谁？' }];
  const result = await runTurn({ messages, turn, tools: [{ name: 'recall', description: '回查', parameters: { type: 'object' } }], maxOutputTokens: 1000 }, ports);
  assert.equal(result.text, '仍有两个候选，不能确定。'); assert.equal(seen.length, 3);
  assert.deepEqual(seen[1].contents[1].parts, [first, parallel]);
  assert.deepEqual(seen[2].contents[1].parts, [first, parallel]);
  assert.deepEqual(seen[2].contents[3].parts, [next]);
  assert.deepEqual(executed, [{ query: '人物' }, { query: '别名' }, { query: '原文' }]);
  assert.ok(!JSON.stringify(records).includes('signature'), '签名不进入工具审计参数');
});

test('签名只回传原 Google 模型，不混入其他模型或协议，也不修改原消息', async (t) => {
  const messages: Msg[] = [
    { role: 'user', content: '是谁？' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'recall', args: { query: '人物' },
      providerMetadata: { google: { model: target.model, thoughtSignature: first.thoughtSignature } } }] },
    { role: 'tool', name: 'recall', toolCallId: 'c1', content: '合成原文' },
  ];
  const before = structuredClone(messages), bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(response([{ text: '答' }])), { headers: { 'content-type': 'application/json' } });
  });
  await adapters[target.protocol]({ ...target, model: 'different-model' }, { messages });
  await adapters['openai-completions']({ ...target, protocol: 'openai-completions' }, { messages });
  assert.ok(bodies.every((body) => !JSON.stringify(body).includes('signature')));
  assert.deepEqual(messages, before);
});

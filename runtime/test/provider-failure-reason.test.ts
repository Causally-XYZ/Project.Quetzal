import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { adapters, LLM_IDLE_MS, LLM_CONTENT_IDLE_MS, type Target } from '../src/providers/adapters.ts';
import { ProviderError } from '../src/providers/types.ts';
const target: Target = { protocol: 'google-generative-ai', baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic', model: 'synthetic', maxTokens: 100 };
const request = { messages: [{ role: 'user' as const, content: '合成请求' }] };
const reason = (code: ProviderError['reason']) => (e: unknown) => e instanceof ProviderError && e.reason === code;

test('无数据超时和用户取消有稳定分类，保持现有时限与失败行为', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }));
  const timed = assert.rejects(adapters[target.protocol](target, request), reason('idle_timeout'));
  t.mock.timers.tick(LLM_IDLE_MS + 1); await timed;
  const controller = new AbortController();
  const cancelled = assert.rejects(adapters[target.protocol](target, { ...request, signal: controller.signal }), reason('cancelled'));
  controller.abort(); await cancelled;
});

test('只发保活仍在原内容时限失败，与连接超时分开', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let stream!: ReadableStreamDefaultController<Uint8Array>;
  t.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { stream = controller; init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true }); },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const failed = assert.rejects(adapters[target.protocol](target, request), reason('content_timeout'));
  await setImmediate();
  for (let elapsed = 60000; elapsed < LLM_CONTENT_IDLE_MS; elapsed += 60000) {
    t.mock.timers.tick(60000); stream.enqueue(new TextEncoder().encode(': keepalive\n\n')); await setImmediate();
  }
  t.mock.timers.tick(60001); await failed;
});

test('HTTP 与网络分类不需要解析供应商错误正文', async (t) => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => new Response('不可信错误内容', { status: 429 }));
  await assert.rejects(adapters[target.protocol](target, request), (e: unknown) => reason('http')(e) && (e as ProviderError).status === 429);
  mocked.mock.mockImplementation(async () => { throw new Error('合成网络错误'); });
  await assert.rejects(adapters[target.protocol](target, request), reason('network'));
});

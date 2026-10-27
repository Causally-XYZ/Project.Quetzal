// 开发运行器的模型旁路记录；生产提示和适配器请求不改写，凭据不进入证据。
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout } from 'node:timers/promises';
import { adcFetch, loadAdc, vertexPlaceholder, vertexModels, type VertexReceipt } from '../adaptive-vertex-transport.ts';
import type { ChatRequest, ChatResult } from '../../src/providers/types.ts';
import type { GoogleThinkingLevel } from '../../src/providers/types.ts';

export interface ObservedCall {
  thinkingLevel?: GoogleThinkingLevel;
  id: number; phase: string; purpose: 'proposal' | 'conversation' | 'memory-selection' | 'memory-learning'; model: string; start: number;
  request: { messages: ChatRequest['messages']; tools: ChatRequest['tools']; maxTokens: number | undefined; responseSchema?: ChatRequest['responseSchema'] };
  state: 'running' | 'returned' | 'failed'; elapsedMs?: number; firstTextMs?: number; firstChunkMs?: number;
  result?: ChatResult; failure?: { category: string; status: number | null; reason?: string; usage: null }; transport: VertexReceipt[];
}
export async function observeModel(options: { directory: string; model: string; kind: 'live' | 'stub'; maxCalls: number; stubFailAt?: number; stubReviewDelayMs?: number; thinkingLevel?: 'LOW' }) {
  if (options.thinkingLevel !== undefined && (options.thinkingLevel !== 'LOW' || options.kind !== 'live' || options.model !== 'gemini-3.8-flash'))
    throw new Error('开发思考设置不合法');
  if (!vertexModels.includes(options.model) || !Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 100)
    throw new Error('评测模型或调用预算不合法');
  if (options.stubFailAt && options.kind !== 'stub') throw new Error('故障注入只允许替身');
  if (options.stubReviewDelayMs !== undefined && (options.kind !== 'stub' || !Number.isSafeInteger(options.stubReviewDelayMs)
    || options.stubReviewDelayMs < 0 || options.stubReviewDelayMs > 10000)) throw new Error('重评延迟注入只允许有界替身');
  fs.mkdirSync(options.directory, { recursive: true });
  const registry = await import('../../src/providers/registry.ts');
  registry.saveProviders({ providers: [{ id: 'evaluation', catalogId: 'custom', name: '合成评测', baseUrl: vertexPlaceholder,
    protocol: 'google-generative-ai', enabled: true, keys: [{ id: 'placeholder', label: '占位', enabled: true, lastFour: '', secret: 'synthetic-noncredential' }],
    models: [{ id: options.model, name: options.model, enabled: true, context: 131072, maxTokens: 16384, sortOrder: 0,
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}) }] }] }, registry.configVersion());
  const { adapters } = await import('../../src/providers/adapters.ts');
  const { ProviderError } = await import('../../src/providers/types.ts');
  const adapter = adapters['google-generative-ai'], native = globalThis.fetch;
  const calls: ObservedCall[] = [], pending = new Set<Promise<ChatResult>>(), context = new AsyncLocalStorage<ObservedCall>();
  const controller = new AbortController(); let phase = 'startup';
  const save = (id: number, stage: string, value: unknown) => fs.writeFileSync(path.join(options.directory, `${id}-${stage}.json`), JSON.stringify(value, null, 2), { flag: 'wx' });
  if (options.kind === 'live') globalThis.fetch = adcFetch(native, loadAdc, (receipt) => {
    const call = context.getStore(); if (!call) throw new Error('模型传输缺少调用关联'); call.transport.push(receipt);
  });
  adapters['google-generative-ai'] = (target, request) => {
    const system = request.messages[0]?.content ?? '';
    const purpose = system.startsWith('你只做记忆选择') ? 'memory-selection'
      : /^(你为 agent 蒸馏结构化记忆|评审蒸馏经验|基于已验证经验提出一种演化)/u.test(system) ? 'memory-learning'
      : system.includes('Return exactly one JSON object conforming to this response schema.') ? 'proposal' : 'conversation';
    const call: ObservedCall = { id: calls.length + 1, phase, purpose,
      model: target.model, start: Date.now(), ...(target.thinkingLevel ? { thinkingLevel: target.thinkingLevel } : {}), request: { messages: structuredClone(request.messages), tools: structuredClone(request.tools), maxTokens: request.maxTokens,
        ...(request.responseSchema ? { responseSchema: structuredClone(request.responseSchema) } : {}) }, state: 'running', transport: [] };
    calls.push(call); save(call.id, 'start', call);
    const task = context.run(call, async () => {
      try {
        if (call.id > options.maxCalls) throw new Error('call-budget');
        const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal; signal.throwIfAborted();
        let result: ChatResult;
        if (options.kind === 'stub') {
          if (call.id === options.stubFailAt) throw new Error('injected-failure');
          // 只验证工程链路；有真实来源的简单提案，不模拟指代推理或纠正成功。
          let text = '这是工程替身回答，不能计为语义通过。';
          if (call.purpose === 'memory-selection') text = '{"keys":[]}';
          if (call.purpose === 'memory-learning') text = system.startsWith('评审') ? '{"accepted":false,"evidenceIds":[]}' : '{"items":[]}';
          if (call.purpose === 'proposal') {
            const input = JSON.parse(request.messages.at(-1)!.content), source = input.sources.find((s: any) => s.key === input.current);
            if (input.review && options.stubReviewDelayMs) await setTimeout(options.stubReviewDelayMs, undefined, { signal });
            const quote = { kind: 'source', source: source.key, text: source.text, occurrence: 0 };
            const time = { text: '', earliest: null, latest: null };
            text = JSON.stringify({ contexts: [], records: input.review ? [] : [{ key: 'p1', replace: null, kind: 'claim', state: 'present', realm: 'real', reasons: [quote],
              text: source.text, nature: 'reported', participants: [], occurred: time, valid: time, supports: [{ id: 'direct', premises: [quote], assumptions: [] }], counters: [] }] });
          }
          request.onChunk?.(); request.onText?.(text);
          result = { text, model: target.model, toolCalls: [], usage: { input: 1, output: 1 } };
        } else result = await adapter(target, { ...request, signal,
          onChunk: () => { call.firstChunkMs ??= Date.now() - call.start; request.onChunk?.(); },
          onText: (text) => { call.firstTextMs ??= Date.now() - call.start; request.onText?.(text); } });
        call.state = 'returned'; call.result = result; return result;
      } catch (error) {
        call.state = 'failed'; call.failure = { category: controller.signal.aborted || request.signal?.aborted ? 'cancelled'
          : call.id > options.maxCalls ? 'call-budget' : options.kind === 'stub' ? 'stub-failure' : 'provider-failed',
          status: error instanceof ProviderError ? error.status : null, usage: null,
          ...(error instanceof ProviderError && error.reason && ['idle_timeout', 'content_timeout', 'cancelled', 'network', 'http', 'protocol'].includes(error.reason) ? { reason: error.reason } : {}) };
        throw new ProviderError('评测模型调用失败，详情只记录安全分类', 0, true);
      } finally { call.elapsedMs = Date.now() - call.start; save(call.id, 'end', call); }
    });
    pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task)); return task;
  };
  return { calls, setPhase: (value: string) => { phase = value; }, abort: () => controller.abort(),
    close: async () => { controller.abort(); await Promise.allSettled([...pending]); adapters['google-generative-ai'] = adapter; globalThis.fetch = native; } };
}

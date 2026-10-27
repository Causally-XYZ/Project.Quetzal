// 自适应记忆通过现有控制台供应商路由生成提案；不执行工具、不自行读取或复制 ADC。
import { chat } from '../providers/router.ts';
import { redactSecrets } from '../mind/secrets.ts';
import { ContextOverflow, estimateTextTokens } from '../../../engine/src/context-manager.ts';
import type { ChatRequest, ChatResult } from '../providers/types.ts';
import type { proposalPrompt } from './adaptive-proposal.ts';

export type ProposalUsage = { model: string } & ChatResult['usage'];
export async function generateAdaptiveProposal(prompt: ReturnType<typeof proposalPrompt>, signal: AbortSignal,
  report?: (usage: ProposalUsage) => void): Promise<unknown> {
  signal.throwIfAborted();
  const messages: ChatRequest['messages'] = [
    { role: 'system', content: `${prompt.system}\nReturn exactly one JSON object conforming to this response schema. Do not call tools or add Markdown fences.\n${JSON.stringify(prompt.schema)}` },
    { role: 'user', content: redactSecrets(prompt.user) },
  ];
  const requiredInput = messages.reduce((n, m) => n + estimateTextTokens(m.content) + 32, 512);
  const request: ChatRequest = { messages, maxTokens: 16384, signal,
    prepareForModel: async ({ contextWindow, maxOutputTokens }) => {
      signal.throwIfAborted();
      if (requiredInput + maxOutputTokens > contextWindow)
        throw new ContextOverflow('认识提案的完整来源与格式超出模型窗口', contextWindow, requiredInput + maxOutputTokens);
      return { messages, maxTokens: maxOutputTokens, signal };
    } };
  // 全局主模型顺序及现有故障转移；不按 quick 配置挑选复杂身份抽取模型。
  const result = await chat(request);
  signal.throwIfAborted();
  report?.({ model: result.model, ...result.usage });
  if (result.truncated || result.toolCalls.length || Buffer.byteLength(result.text) > 256 * 1024) throw new Error('认识提案输出不完整或形状不合法');
  try { return JSON.parse(result.text); } catch { throw new Error('认识提案不是完整 JSON'); }
}

/** 调用方可用同一时间墙约束真实供应商或测试替身；迟到响应不回到安装阶段。 */
export function boundedProposal<T>(generate: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs = 150_000): Promise<T> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 150_000) throw new Error('认识生成时间墙不合法');
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const stop = () => { controller.abort(); reject(new Error('认识生成已中止')); };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    Promise.resolve().then(() => { controller.signal.throwIfAborted(); return generate(controller.signal); })
      .then((value) => { cleanup(); if (!controller.signal.aborted) resolve(value); }, (error) => { cleanup(); reject(error); });
    // 超时 / 外部取消也立即清理外部监听，不依赖供应商最终结束。
    controller.signal.addEventListener('abort', cleanup, { once: true });
    if (signal.aborted) stop();
  });
}

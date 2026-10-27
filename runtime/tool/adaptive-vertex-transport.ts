// 开发试验专用：给现有 Google 适配器换上内存中的 ADC 认证，不改生产供应商配置。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const vertexModels = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];
export const vertexPlaceholder = 'https://quetzal-adc.invalid';
export interface VertexReceipt { model: string; versions: string[]; finish: string[]; usage: unknown[]; elapsedMs: number }
type Credentials = { project: string; token: string };

export async function loadAdc(): Promise<Credentials> {
  // 重用已有探针的 ADC 边界；子进程 stdout 仅在内存解析，不能打印或保存。
  const script = 'import sys,json; sys.path.insert(0,sys.argv[1]); from importlib import import_module; p,t=import_module("adaptive-vertex-smoke").credentials(); print(json.dumps({"project":p,"token":t}))';
  try {
    const { stdout } = await promisify(execFile)('python3', ['-B', '-c', script, fileURLToPath(new URL('.', import.meta.url))],
      { timeout: 50_000, maxBuffer: 64 * 1024 });
    const value = JSON.parse(stdout);
    if (typeof value.project !== 'string' || !/^[a-z0-9-]+$/.test(value.project)
      || typeof value.token !== 'string' || !value.token || /[\r\n]/.test(value.token)) throw new Error();
    return value;
  } catch { throw new Error('开发试验 ADC 不可用'); }
}

/** 只截获保留域名的 Google 流式请求；错误正文、账号和认证值不交给路由或报告。 */
export function adcFetch(native: typeof fetch, credentials: () => Promise<Credentials>, report: (r: VertexReceipt) => void): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${vertexPlaceholder}/`)) return native(input, init);
    const match = /^https:\/\/quetzal-adc\.invalid\/models\/([^/:?]+):streamGenerateContent\?alt=sse$/.exec(url);
    if (!match || !vertexModels.includes(match[1]) || init?.method !== 'POST') throw new Error('开发试验请求不在许可范围');
    const start = Date.now(), { project, token } = await credentials();
    init.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await native(`https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${match[1]}:streamGenerateContent?alt=sse`,
        { ...init, redirect: 'error', headers: { 'content-type': 'application/json', accept: 'text/event-stream',
          authorization: `Bearer ${token}`, 'x-goog-user-project': project } });
    } catch { throw new Error('开发试验模型传输失败'); }
    if (!response.ok) {
      await response.body?.cancel();
      return new Response('{"error":"development-provider-http"}', { status: response.status, headers: { 'content-type': 'application/json' } });
    }
    // 流式透传，不先缓冲整段回复；仅旁路读取白名单计量字段。
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let buffer = '', bytes = 0;
    const versions = new Set<string>(), finish = new Set<string>(), usage: unknown[] = [];
    const consume = (line: string) => {
      if (!line.startsWith('data:')) return;
      try {
        const data = JSON.parse(line.slice(5));
        if (typeof data.modelVersion === 'string') versions.add(vertexModels.includes(data.modelVersion) ? data.modelVersion : 'unexpected-model');
        for (const candidate of data.candidates ?? []) if (typeof candidate.finishReason === 'string')
          finish.add(['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER'].includes(candidate.finishReason) ? candidate.finishReason : 'other-finish');
        if (data.usageMetadata) {
          const snapshot = Object.fromEntries(['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']
            .map((key) => [key, Number.isSafeInteger(data.usageMetadata[key]) && data.usageMetadata[key] >= 0 ? data.usageMetadata[key] : null]));
          if (Object.values(snapshot).some((v) => v !== null) && JSON.stringify(snapshot) !== JSON.stringify(usage.at(-1))) usage.push(snapshot);
        }
      } catch { /* 适配器仍按原有协议解析；计量缺失不补造。 */ }
    };
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            consume(buffer); report({ model: match[1], versions: [...versions], finish: [...finish], usage, elapsedMs: Date.now() - start });
            controller.close(); return;
          }
          bytes += part.value.length;
          if (bytes > 2 * 1024 * 1024) throw new Error();
          buffer += decoder.decode(part.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end).replace(/\r$/, '')); buffer = buffer.slice(end + 1); }
          controller.enqueue(part.value);
        } catch { await reader.cancel().catch(() => {}); controller.error(new Error('开发试验模型响应中断')); }
      },
      cancel: () => reader.cancel(),
    }), { status: response.status, headers: response.headers });
  };
}

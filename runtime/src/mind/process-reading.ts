// process 是展示副本，不是带来源凭据的工具记录。模型读取只保留执行索引。
export const PROCESS_READING_NOTICE = '【过程附注中的参数摘要、结果摘录和中途叙述没有独立来源凭据，不作为当前依据；这里只保留执行索引。完整本机工具结果另行核查，缺失时需重新读取资料。】';

export function processReading(items: unknown[] | null | undefined) {
  return (items ?? []).map((item) => {
    const x = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    if (x.type === 'tool') return { type: 'tool',
      call: typeof x.call === 'string' ? x.call : undefined,
      name: typeof x.name === 'string' ? x.name : undefined,
      status: ['ok', 'running', 'error', 'denied'].includes(String(x.status)) ? x.status : 'unknown',
      ms: typeof x.ms === 'number' && Number.isFinite(x.ms) && x.ms >= 0 ? x.ms : undefined };
    return { type: x.type === 'steer' ? 'steer' : 'text', omitted: '未绑定来源的过程文字' };
  });
}

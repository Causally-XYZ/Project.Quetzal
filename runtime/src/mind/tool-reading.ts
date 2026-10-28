// 已执行工具的读取投影：核查原来源，不重放工具、不改原执行记录。
import { config } from '../config.ts';
import { getToolCall, getSessionMessage, readContextSource, type ToolCallRow } from '../store.ts';
import { identity } from '../memory/identity.ts';
import { readNote } from '../memory/memory.ts';
import { documents } from '../memory/retrieval.ts';
import { readStructuredRecords, readLegacyRecords } from '../memory/structured.ts';
import { memoryKey } from '../../../engine/src/memory.ts';
import { MEMORY_READ_TOOLS, parseReadReceipt, readDigest, observeReadDocument, type ReadDocument } from '../memory/read-receipt.ts';
import { sourceReadingsHeader, type SourceReading } from '../memory/adaptive-reading.ts';

export interface ToolReading extends ToolCallRow { currentReading: string }
export const toolReadingKey = (row: Pick<ToolCallRow, 'call' | 'session'>) => JSON.stringify([row.session, row.call]);
export function prepareToolReadings(records: ToolCallRow[], conv: string) {
  const prepared = records.filter((r) => MEMORY_READ_TOOLS.has(r.tool) && r.status === 'ok').map((record) => {
    const receipt = record.reading === undefined ? undefined : parseReadReceipt(record.reading);
    if (receipt && (receipt.agent !== identity().id || receipt.body !== config.body || receipt.conv !== conv || receipt.tool !== record.tool || receipt.resultHash !== readDigest(record.result)))
      throw new Error('工具来源凭据与调用或当前会话不匹配');
    return { record, receipt };
  });
  return {
    sources: [...new Set(prepared.flatMap((p) => p.receipt?.sources.map((s) => s.id) ?? []))],
    render(view: SourceReading | null, reference?: (record: ToolCallRow) => string): Map<string, ToolReading> {
      if (!view) return new Map();
      const sources = new Map(view.sources.map((s) => [s.id, s]));
      let docs: Map<string, unknown> | undefined, memories: Map<string, unknown> | undefined;
      const currentDocument = (d: ReadDocument): unknown => {
        if (['message', 'tool', 'context'].includes(d.kind)) {
          let parts: unknown;
          try { parts = JSON.parse(d.key); } catch { throw new Error('工具来源标识不合法'); }
          if (!Array.isArray(parts) || parts.length !== 2 || typeof parts[0] !== 'string') throw new Error('工具来源标识不合法');
          if (d.kind === 'message') {
            if (!Number.isSafeInteger(parts[1]) || parts[1] <= 0) throw new Error('消息来源标识不合法');
            return getSessionMessage(parts[1], parts[0]);
          }
          if (typeof parts[1] !== 'string') throw new Error('工具来源标识不合法');
          return d.kind === 'tool' ? getToolCall(parts[1], parts[0]) : readContextSource(parts[1], parts[0]);
        }
        if (d.kind === 'note') return readNote(d.key);
        if (d.kind === 'record') {
          memories ??= new Map([...readLegacyRecords(), ...readStructuredRecords()].map((r) => [memoryKey(r), r]));
          return memories.get(d.key);
        }
        docs ??= new Map(documents(['journal', 'memory', 'user']).map((d) => [d.source, { title: d.title, text: d.text }]));
        return docs.get(d.key);
      };
      return new Map(prepared.map(({ record, receipt }) => {
        if (JSON.stringify(getToolCall(record.call, record.session)) !== JSON.stringify(record)) throw new Error('工具执行记录在读取期间已改变');
        let result: string, currentReading: string;
        if (!receipt?.checked) currentReading = result = '【历史记忆工具结果缺少完整来源凭据；不沿用旧正文，请重新读取原资料。调用成功只表示当时执行成功。】';
        else {
          let changed = receipt.sources.some((s) => !s.hash || sources.get(s.id)?.hash !== s.hash);
          for (const d of receipt.documents) {
            const value = currentDocument(d);
            if (readDigest(value) !== d.hash) changed = true;
            // context_read 再读取本结果时，继续绑定本次实际核对的文件状态。
            observeReadDocument(d.kind, d.key, value);
          }
          const headers = sourceReadingsHeader(view, receipt.sources.filter((s) => sources.get(s.id)?.hash).map((s) => s.id));
          const body = changed ? '【原消息或文档已改变 / 不可访问；此结果没有逐句依赖映射，不输出旧正文，请重新读取相关资料。】'
            : reference && record.result.length > 12000 ? `【完整工具结果超过首屏预算；没有截断修订后保留片段。请回查：${reference(record)}】` : record.result;
          currentReading = `【历史工具 ${record.tool} 的当前来源核查；未重新执行工具，当时结果不是现行事实确认。】\n${headers}${changed ? '【原来源已改变或不可访问，不沿用旧正文。】\n' : ''}`;
          result = currentReading + body;
        }
        if (Buffer.byteLength(result) > 512 * 1024) throw new Error('工具修订视图超过工作上限');
        return [toolReadingKey(record), { ...record, result, currentReading }];
      }));
    },
  };
}

// 原文不会因认识修订被改写；读取时附上针对具体认识 / 片段的当前状态。
import { directSpans, recordRefs, refKey, evaluateEvidence, type SemanticRecord, type SourceReader, type EvidenceState } from './adaptive-evidence.ts';

export interface SourceNotice {
  id: string; revision: number; kind: SemanticRecord['kind'];
  status: EvidenceState['status'] | 'unavailable';
  spans: { hash: string; start: number; end: number }[];
  current: { text: string; realm: SemanticRecord['realm']; nature?: string; sources: { id: number; hash: string }[] } | null;
}
export interface SourceReading {
  generation: number; freshness: 'local-snapshot';
  sources: { id: number; hash: string | null; notices: SourceNotice[] }[];
}

/** 输入为同一 SQLite 快照的全部版本；旧引用必须追踪对应历史版本，不能跳至最新。 */
export function sourceReading(history: SemanticRecord[], ids: number[], generation: number,
  visible: SourceReader, global: SourceReader = visible): SourceReading {
  if (history.length > 10000 || ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('原文修订读取超过范围');
  const versions = new Map(history.map((r) => [refKey(r), r])), latest = new Map<string, SemanticRecord>();
  if (versions.size !== history.length) throw new Error('认识历史包含重复版本');
  for (const r of history) if ((latest.get(r.id)?.revision ?? 0) < r.revision) latest.set(r.id, r);
  if (latest.size > 1000) throw new Error('原文修订读取超过范围');
  const records = [...latest.values()], states = evaluateEvidence(records, visible), allStates = evaluateEvidence(records, global);
  const sources = new Map([...new Set(ids)].map((id) => [id, { id, hash: visible(id)?.hash ?? null, notices: [] as SourceNotice[] }]));
  let work = 0;
  const step = () => { if (++work > 100000) throw new Error('原文修订读取超过工作上限'); };
  const byId = new Map<string, SemanticRecord[]>();
  for (const r of history) { const group = byId.get(r.id) ?? []; group.push(r); byId.set(r.id, group); }
  for (const record of records) {
    step();
    const local = states.get(record.id)!.status, globalStatus = allStates.get(record.id)!.status;
    const status = local === globalStatus ? local : 'unavailable';
    if (record.revision === 1 && status === 'supported') continue;
    // 范围针对这条认识及其原始依据，不把同一段话中的其他独立认识一起撤回。
    const seen = new Set<string>(), spans = new Map<number, Map<string, SourceNotice['spans'][number]>>();
    const pending = [...byId.get(record.id)!];
    for (let i = 0; i < pending.length; i++) {
      step(); const r = pending[i], key = refKey(r); if (seen.has(key)) continue; seen.add(key);
      for (const span of directSpans(r)) {
        step(); if (!sources.get(span.source)?.hash) continue;
        const group = spans.get(span.source) ?? new Map();
        group.set(`${span.hash}:${span.start}:${span.end}`, { hash: span.hash, start: span.start, end: span.end }); spans.set(span.source, group);
      }
      for (const ref of recordRefs(r)) { step(); const parent = versions.get(refKey(ref)); if (parent) pending.push(parent); }
    }
    let current: SourceNotice['current'] = null;
    if (status === 'supported') {
      const roots = states.get(record.id)!.roots.map((key) => { const [id, hash] = key.split(':'); return { id: Number(id), hash }; });
      if (record.kind === 'claim') current = { text: record.text, realm: record.realm, nature: record.nature, sources: roots };
      if (record.kind === 'node') current = { text: record.name, realm: record.realm, sources: roots };
      if (record.kind === 'mention' && record.resolved) {
        const node = latest.get(record.resolved.id);
        if (node?.kind === 'node' && node.revision === record.resolved.revision && states.get(node.id)?.status === 'supported' && allStates.get(node.id)?.status === 'supported')
          current = { text: node.name, realm: node.realm, sources: roots };
      }
    }
    for (const [id, offsets] of spans) sources.get(id)!.notices.push({ id: record.id, revision: record.revision,
      kind: record.kind, status, spans: [...offsets.values()], current });
  }
  const result: SourceReading = { generation, freshness: 'local-snapshot', sources: [...sources.values()] };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error('原文修订结果超过工作上限');
  return result;
}

export function sourceReadingHeader(view: SourceReading, source?: number): string {
  const entry = source === undefined ? undefined : view.sources.find((s) => s.id === source);
  if (source !== undefined && !entry?.hash) throw new Error('历史来源不可访问，不能返回缓存正文');
  return `【记忆修订核对：本机已收到的快照 generation=${view.generation}，不保证中心最新。以下原文保留历史措辞，不代表当前事实；修订信息也是带依据的认识，不是事实确认。` +
    (entry ? `片段位置按所列 hash 的原文 UTF-16 偏移计算，不能跨版本套用；状态只作用于指定认识，不撤回整段其他内容。${JSON.stringify(entry)}`
      : '此缓存没有可解析的消息来源，无法逐项核对修订；需要现行依据时请回查带来源的原文。') + '】\n';
}

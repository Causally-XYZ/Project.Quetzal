// 按外存索引定位、点读并组装局部工作集；不先物化全图。
import type { AdaptiveLookup } from './adaptive-lookup.ts';
import { directSpans, recordRefs, type SemanticRecord, type SourceReader } from './adaptive-evidence.ts';
import type { MemorySource } from './adaptive-store.ts';
import { proposalPrompt, type ProposalContext } from './adaptive-proposal.ts';

export type LocalLookup = Pick<AdaptiveLookup, 'get' | 'page' | 'search' | 'recent' | 'sourceOwners' | 'references' | 'dependents' | 'matches' | 'neighbors' | 'objects' | 'reviewTargets'>;
export class WorksetOverflow extends Error {}
export const SEMANTIC_PROMPT_LIMIT = 256 * 1024;
const PREFERRED_BYTES = 128 * 1024;

/** 当前源不再可见的派生文字，连同其依赖分支一起不进入模型；旧hash另由提案标为失效。 */
export class LocalClosure {
  private readonly cache = new Map<string, SemanticRecord | undefined>();
  private bytes = 0;
  readonly lookup: LocalLookup;
  readonly read: SourceReader;
  constructor(lookup: LocalLookup, read: SourceReader) { this.lookup = lookup; this.read = read; }

  get(id: string) {
    if (!this.cache.has(id)) {
      if (this.cache.size >= 1000) throw new WorksetOverflow('认识点读超过工作上限');
      const record = this.lookup.get(id);
      this.bytes += record ? Buffer.byteLength(JSON.stringify(record)) : 0;
      if (this.bytes > 4 * 1024 * 1024) throw new WorksetOverflow('认识点读超过字节上限');
      this.cache.set(id, record);
    }
    return this.cache.get(id);
  }

  collect(ids: string[], historical = true, filterSources = true): SemanticRecord[] | undefined {
    const selected = new Map<string, SemanticRecord>(), pending = [...ids]; let bytes = 0, edges = 0;
    for (let i = 0; i < pending.length; i++) {
      if (selected.has(pending[i])) continue;
      const record = this.get(pending[i]);
      if (!record || filterSources && directSpans(record).some((p) => { const source = this.read(p.source); return !source || source.role === 'agent'; })) return;
      selected.set(record.id, record); bytes += Buffer.byteLength(JSON.stringify(record));
      if (bytes > SEMANTIC_PROMPT_LIMIT) throw new WorksetOverflow('认识引用闭包超过字节上限');
      // 历史依赖只查其身份和当前版本，不把旧证明恢复成当前事实。
      const refs = historical ? this.lookup.references(record.id, 1001) : recordRefs(record).map((r) => r.id);
      edges += refs.length;
      if (refs.length > 1000 || edges > 10000) throw new WorksetOverflow('认识引用闭包超过工作上限');
      pending.push(...refs);
    }
    return [...selected.values()];
  }
}

export function integrationWorkset(options: {
  lookup: LocalLookup; current: MemorySource; generation: number;
  read: (id: number) => MemorySource | undefined; previous: number[];
}): { context: ProposalContext; prompt: ReturnType<typeof proposalPrompt> } {
  const { lookup, current, generation, read, previous } = options;
  const graph = new LocalClosure(lookup, read), processed = new Set(previous);
  const recent = previous.flatMap((id) => { const s = read(id); return s && s.role !== 'agent' ? [s] : []; });
  const anchors = [...new Set([recent.find((s) => s.session === current.session)?.id, recent[0]?.id].filter((id): id is number => id !== undefined))];
  const required = lookup.sourceOwners(current.id, 1001);
  if (required.length > 1000) throw new WorksetOverflow('来源修正目标超过工作上限');
  let selected = new Map<string, SemanticRecord>();
  for (const id of required) {
    const closure = graph.collect([id]);
    // 权限排除的分支不送模型；与预算不足不同，不阻断独立可读分支。
    if (closure) for (const r of closure) selected.set(r.id, r);
  }
  const make = (records: Map<string, SemanticRecord>, extra: number[]) => {
    const values = [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
    const spans = values.flatMap(directSpans), known = new Set(spans.map((s) => `${s.source}:${s.hash}`));
    const ids = [...new Set([current.id, ...spans.map((s) => s.source), ...extra])].sort((a, b) => a - b);
    if (ids.length > 100) throw new WorksetOverflow('认识工作集来源超过上限');
    const sources = ids.flatMap((id) => {
      const s = read(id);
      // 未处理的新修订不能借检索或旧引用提前送入模型。
      return s && s.role !== 'agent' && (id === current.id || processed.has(id) || known.has(`${id}:${s.hash}`)) ? [s] : [];
    });
    const context = { generation, current: current.id, sources, records: values };
    const prompt = proposalPrompt(context);
    prompt.system += '\nThis is a bounded candidate working set, not the complete memory graph. Missing candidates do not establish absence or identity. Preserve uncertainty; revise only justified supplied records. Omitted connections can be investigated later. Do not recreate withdrawn or superseded premises from their old sources.\n';
    const bytes = Buffer.byteLength(JSON.stringify(prompt));
    if (bytes > SEMANTIC_PROMPT_LIMIT) throw new WorksetOverflow('认识整合的必要上下文超过工作上限');
    return { context, prompt, bytes };
  };
  // 必要纠正闭包独立核对硬上限；不能因为可选材料而丢掉它。
  let result = make(selected, []), extras: number[] = [];
  for (const id of anchors) {
    try { const next = make(selected, [...extras, id]); if (next.bytes <= PREFERRED_BYTES) { extras.push(id); result = next; } }
    catch (error) { if (!(error instanceof WorksetOverflow)) throw error; }
  }
  const seeds = [...new Set([
    ...lookup.search(current.text, 64),
    ...anchors.flatMap((id) => lookup.sourceOwners(id, 64)),
    ...lookup.recent(32), ...lookup.page('', 32).map((r) => r.id),
  ])];
  for (const id of seeds) {
    if (selected.has(id)) continue;
    try {
      const closure = graph.collect([id]);
      if (!closure) continue;
      const next = new Map(selected); for (const r of closure) next.set(r.id, r);
      const candidate = make(next, extras);
      if (candidate.bytes <= Math.max(PREFERRED_BYTES, result.bytes)) { selected = next; result = candidate; }
    } catch (error) { if (!(error instanceof WorksetOverflow)) throw error; }
  }
  // 零散原文也有预算；同会话/近期锚点优先，助手文字永不作独立证据。
  for (const source of recent) {
    if (result.context.sources.some((s) => s.id === source.id)) continue;
    try {
      const next = make(selected, [...extras, source.id]);
      if (next.bytes <= Math.max(PREFERRED_BYTES, result.bytes)) { extras.push(source.id); result = next; }
    } catch (error) { if (!(error instanceof WorksetOverflow)) throw error; }
  }
  return { context: result.context, prompt: result.prompt };
}

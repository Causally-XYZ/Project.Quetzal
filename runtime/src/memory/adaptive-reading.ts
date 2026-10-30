// 原文不会因认识修订被改写；读取时附上针对具体认识 / 片段的当前状态。
import { directSpans, recordRefs, refKey, evaluateEvidence, spanCurrent, sameRealm, isEvidenceSource,
  type SemanticRecord, type SourceReader, type EvidenceState, type ClaimRecord, type SourceSpan } from './adaptive-evidence.ts';

export interface SourceNotice {
  id: string; revision: number; kind: SemanticRecord['kind'];
  status: EvidenceState['status'] | 'unavailable';
  spans: { hash: string; start: number; end: number }[];
  identityGap?: { sources: SourceSpan[]; bindings: {
    role: string; usage: 'participant' | 'reference'; realm: SemanticRecord['realm'];
    mention: ClaimRecord['participants'][number]['mention']; anchor: SourceSpan;
    binding: { name: string; id: string; revision: number } | null;
  }[] };
  current: { text: string; realm: SemanticRecord['realm']; nature?: string;
    occurred?: ClaimRecord['occurred']; valid?: ClaimRecord['valid'];
    references?: { role: string; realm: SemanticRecord['realm']; name: string }[]; sources: { id: number; hash: string }[] } | null;
}
export interface SourceReading {
  generation: number; freshness: 'local-snapshot';
  sources: { id: number; hash: string | null; notices: SourceNotice[];
    recordedAt?: string | null;
    answer?: { status: 'unchanged' | 'changed' | 'unbound'; sources: number[] } }[];
}

/** 只格式化持久消息的时间；未知 / 损坏值不以当前时间补全。 */
export function sourceRecordedAt(ts: unknown): string | null {
  return typeof ts === 'number' && Number.isFinite(ts) && Number.isFinite(new Date(ts).getTime()) ? new Date(ts).toISOString() : null;
}

/** 输入为同一 SQLite 快照的全部版本；旧引用必须追踪对应历史版本，不能跳至最新。 */
export function sourceReading(history: SemanticRecord[], ids: number[], generation: number,
  visible: SourceReader, global: SourceReader = visible): SourceReading {
  if (history.length > 10000 || ids.length > 1000 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('原文修订读取超过范围');
  const versions = new Map(history.map((r) => [refKey(r), r])), latest = new Map<string, SemanticRecord>();
  if (versions.size !== history.length) throw new Error('认识历史包含重复版本');
  for (const r of history) if ((latest.get(r.id)?.revision ?? 0) < r.revision) latest.set(r.id, r);
  if (latest.size > 1000) throw new Error('原文修订读取超过范围');
  const records = [...latest.values()], states = evaluateEvidence(records, visible), allStates = evaluateEvidence(records, global);
  const sources = new Map([...new Set(ids)].map((id) => [id, { id, hash: visible(id)?.hash ?? null, notices: [] as SourceNotice[] }]));
  let work = 0;
  const step = () => { if (++work > 100000) throw new Error('原文修订读取超过工作上限'); };
  // 只解释有直接原文支持的 reported 陈述。复杂推导 / 反证仍保留原状态，不另写一套证明引擎。
  const identityGap = (r: SemanticRecord): SourceNotice['identityGap'] => {
    if (r.kind !== 'claim' || r.nature !== 'reported' || r.state !== 'present' || r.counters.length ||
        states.get(r.id)?.status !== 'unsupported' || allStates.get(r.id)?.status !== 'unsupported') return;
    const grounded = (span: SourceSpan) => {
      step(); return [visible, global].every((read) => spanCurrent(span, read) && isEvidenceSource(read(span.source)));
    };
    if (!r.reasons.every(grounded)) return;
    const group = r.supports.find((g) => !g.assumptions.length && g.premises.length &&
      g.premises.every((p) => p.kind === 'source' && grounded(p)));
    if (!group) return;
    const bindings: NonNullable<SourceNotice['identityGap']>['bindings'] = [];
    for (const p of [...r.participants.map((p) => ({ ...p, usage: 'participant' as const })),
      ...(r.references ?? []).map((p) => ({ ...p, usage: 'reference' as const }))]) {
      step(); const m = latest.get(p.mention.id);
      if (m?.kind !== 'mention' || p.mention.kind !== 'mention' || m.revision !== p.mention.revision || m.state !== 'present' ||
          (p.usage === 'participant' && !sameRealm(r.realm, m.realm)) || !grounded(m.anchor) || !m.reasons.every(grounded)) return;
      const status = states.get(m.id)?.status;
      if (status !== allStates.get(m.id)?.status) return;
      let binding: typeof bindings[number]['binding'] = null;
      if (status === 'supported' && m.resolved) {
        const node = latest.get(m.resolved.id);
        if (node?.kind !== 'node' || node.revision !== m.resolved.revision || !sameRealm(m.realm, node.realm) ||
            states.get(node.id)?.status !== 'supported' || allStates.get(node.id)?.status !== 'supported') return;
        binding = { name: node.name, id: node.id, revision: node.revision };
      } else if (status !== 'ambiguous' || m.resolved) return;
      bindings.push({ role: p.role, usage: p.usage, realm: m.realm, mention: p.mention, anchor: m.anchor, binding });
    }
    return bindings.some((b) => !b.binding) ? { sources: group.premises as SourceSpan[], bindings } : undefined;
  };
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
      if (record.kind === 'claim') current = { text: record.text, realm: record.realm, nature: record.nature,
        occurred: record.occurred, valid: record.valid, sources: roots, ...(record.references ? { references: record.references.flatMap((p) => {
          const mention = latest.get(p.mention.id), node = mention?.kind === 'mention' && mention.resolved ? latest.get(mention.resolved.id) : undefined;
          return mention?.kind === 'mention' && node?.kind === 'node' ? [{ role: p.role, realm: mention.realm, name: node.name }] : [];
        }) } : {}) };
      if (record.kind === 'node') current = { text: record.name, realm: record.realm, sources: roots };
      if (record.kind === 'mention' && record.resolved) {
        const node = latest.get(record.resolved.id);
        if (node?.kind === 'node' && node.revision === record.resolved.revision && states.get(node.id)?.status === 'supported' && allStates.get(node.id)?.status === 'supported')
          current = { text: node.name, realm: node.realm, sources: roots };
      }
    }
    const gap = identityGap(record);
    for (const [id, offsets] of spans) sources.get(id)!.notices.push({ id: record.id, revision: record.revision,
      kind: record.kind, status, spans: [...offsets.values()], current, ...(gap ? { identityGap: gap } : {}) });
  }
  const result: SourceReading = { generation, freshness: 'local-snapshot', sources: [...sources.values()] };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error('原文修订结果超过工作上限');
  return result;
}

const describeNotice = (notice: SourceNotice) => notice.status === 'unsupported' && notice.identityGap ? {
  ...notice, status: '身份关联未完整',
  explanation: '这是有当前可访问原文支持的转述；binding 为 null 的指代尚未确定，不抹去其他角色已有的绑定，也不表示原发言被否定。仅说明原话中的身份关联，不确认事件为世界事实，整条认识仍不能作为完整推理前提；reference 是被谈论对象，不是跨语境事实依据。',
} : notice;

/** 工具批量读取共享修订表；完整保留每个来源的映射，不为每份旧答重复展开同一修订。 */
export function sourceReadingsHeader(view: SourceReading, ids: number[]): string {
  if (!ids.length) return sourceReadingHeader(view);
  const byId = new Map(view.sources.map((s) => [s.id, s])), selected = new Set(ids);
  for (const id of ids) if (!byId.get(id)?.hash) throw new Error('历史来源不可访问，不能返回缓存正文');
  for (const id of selected) {
    const answer = byId.get(id)?.answer;
    if (answer?.status === 'changed') for (const parent of answer.sources) if (byId.has(parent)) selected.add(parent);
  }
  const notices: ReturnType<typeof describeNotice>[] = [], indices = new Map<string, number>();
  const sources = [...selected].map((id) => {
    const source = byId.get(id)!;
    return { ...source, notices: source.notices.map((notice) => {
      const described = describeNotice(notice), key = JSON.stringify(described);
      let index = indices.get(key);
      if (index === undefined) { index = notices.length; indices.set(key, index); notices.push(described); }
      return index;
    }) };
  });
  return `【记忆修订核对：本机已收到的快照 generation=${view.generation}，不保证中心最新。原文保留历史措辞，不代表当前事实；修订也是带依据的认识，不是事实确认。recordedAt 是原消息记录时间（UTC），不是事件时间；缺失时未知。sources 中 notices 的整数下标指向共用 notices 修订表，必须结合该来源读取；片段位置按所列 hash 的原文 UTF-16 偏移计算，不能跨版本套用，状态不撤回整段其他内容。助手 answer.status=changed 表示旧回答不能沿用为现行依据，其 answer.sources 指向所依赖来源及这些来源的当前修订；unchanged 只表示已登记来源未变，不证明回答正确或覆盖其他材料，unbound 表示未经核查。${JSON.stringify({ sources, notices })}】\n`;
}

export function sourceReadingHeader(view: SourceReading, source?: number): string {
  const entry = source === undefined ? undefined : view.sources.find((s) => s.id === source);
  if (source !== undefined && !entry?.hash) throw new Error('历史来源不可访问，不能返回缓存正文');
  // 不把每条旧回答的整份依赖快照重复塞进上下文；只有失效时附当前局部修订。
  const answer = entry?.answer;
  const notices = answer?.status === 'changed' ? [...new Map(view.sources.filter((s) => answer.sources.includes(s.id))
    .flatMap((s) => s.notices).map((n) => [n.id, n])).values()] : [];
  const described = entry && { ...entry, notices: entry.notices.map(describeNotice),
    ...(answer ? { answer: { status: answer.status, sourceCount: answer.sources.length } } : {}) };
  return `【记忆修订核对：本机已收到的快照 generation=${view.generation}，不保证中心最新。recordedAt 是该原消息的记录时间（UTC），不是所述事件的发生时间或当前时间；缺失时未知。以下原文保留历史措辞，不代表当前事实；修订信息也是带依据的认识，不是事实确认。` +
    (entry ? `片段位置按所列 hash 的原文 UTF-16 偏移计算，不能跨版本套用；状态只作用于指定认识，不撤回整段其他内容。${JSON.stringify(described)}`
      : '此缓存没有可解析的消息来源，无法逐项核对修订；需要现行依据时请回查带来源的原文。') +
    (answer ? `助手回答的消息来源核查=${answer.status}；unchanged 只表示这些来源未变，不证明回答正确或覆盖文件、外部工具与其他派生资料。${notices.length ? JSON.stringify(notices.map(describeNotice)) : ''}` : '') + '】\n';
}

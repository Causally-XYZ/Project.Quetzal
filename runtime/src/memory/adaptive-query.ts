// 前台只读选择：复用证据计算与现有词面排序，不在查询中生成新认识。
import { rank } from '../../../engine/src/retrieval.ts';
import crypto from 'node:crypto';
import { reciprocalRankFusion } from './adaptive-ranking.ts';
import { directSpans, evaluateEvidence, spanCurrent, sameRealm, type SemanticRecord, type SourceReader, type Realm, type ClaimRecord, type SourceSpan } from './adaptive-evidence.ts';

interface BaseItem { id: string; revision: number; realm: Realm; roots: { id: number; hash: string }[] }
export type SemanticItem = BaseItem & ({ kind: 'claim'; status: 'supported' | 'conditional'; text: string;
  nature: ClaimRecord['nature']; occurred: ClaimRecord['occurred']; valid: ClaimRecord['valid']; supports: ClaimRecord['supports'];
  participants: { role: string; mention: ClaimRecord['participants'][number]['mention']; object: { id: string; revision: number; name: string } }[];
  references?: { role: string; mention: ClaimRecord['participants'][number]['mention']; realm: Realm; object: { id: string; revision: number; name: string } }[] }
  | { kind: 'mention'; status: 'ambiguous'; anchor: SourceSpan; unknown: boolean;
    candidates: { id: string; revision: number; name: string }[] });
/** matched是本次有界检索检查的有效候选数，不承诺全库穷举；basis只锁定实际输出及其依赖。 */
export interface SemanticSelection { generation: number; items: SemanticItem[]; matched: number }
export interface SemanticBasis { records: { id: string; revision: number; hash: string }[]; sources: { id: number; hash: string | null }[] }
export const semanticDigest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function semanticBasis(records: SemanticRecord[], read: SourceReader): SemanticBasis {
  if (records.length > 1000) throw new Error('认识版本核查超过工作上限');
  const ids = [...new Set(records.flatMap((r) => directSpans(r).map((s) => s.source)))].sort((a, b) => a - b);
  if (ids.length > 1000) throw new Error('认识来源核查超过工作上限');
  return { records: records.map((r) => ({ id: r.id, revision: r.revision, hash: semanticDigest(r) })).sort((a, b) => a.id.localeCompare(b.id)),
    sources: ids.map((id) => ({ id, hash: read(id)?.hash ?? null })) };
}

export function compatibleSemanticBasis(remote: SemanticBasis, local: SemanticBasis): boolean {
  const records = new Map(remote.records.map((r) => [r.id, r]));
  if (local.records.some((r) => { const known = records.get(r.id); return !known || known.revision < r.revision || known.revision === r.revision && known.hash !== r.hash; })) return false;
  const sources = new Map(local.sources.map((s) => [s.id, s.hash]));
  return remote.sources.every((s) => !sources.has(s.id) || sources.get(s.id) === s.hash);
}

/** 只输出当前共同有效的候选；派生索引只能保存此输入，不得直接索引全部历史记录。 */
export interface SemanticCandidate { key: string; item: SemanticItem; title: string; text: string }
export function semanticCandidates(records: SemanticRecord[], read: SourceReader, global: SourceReader): SemanticCandidate[] {
  if (records.length > 1000) throw new Error('认识查询超过工作上限');
  const localStates = evaluateEvidence(records, read), globalStates = evaluateEvidence(records, global);
  const byId = new Map(records.map((r) => [r.id, r]));
  // 两个视图可能分别依赖不同分支而成立；只保留共同有效的组后再计算闭包，不能拼成不存在的共同证明。
  const common = records.filter((r) => localStates.get(r.id)?.status === 'supported' && globalStates.get(r.id)?.status === 'supported')
    .map((r) => r.kind === 'claim' ? { ...r, supports: r.supports.filter((g) => localStates.get(r.id)!.groups.includes(g.id) && globalStates.get(r.id)!.groups.includes(g.id)) } : r);
  const commonStates = evaluateEvidence(common, read);
  const supported = (id: string) => commonStates.get(id)?.status === 'supported';
  // 条件性推测只作供讨论的候选，不加入 supported 闭包，也不能支撑下游结论。
  // 前提必须在两个视图的共同证明中成立；当前有反证分支的推测暂不主动呈现。
  const conditional = new Map<string, { groups: ClaimRecord['supports']; roots: string[] }>();
  for (const r of records) {
    if (r.kind !== 'claim' || r.nature === 'reported' || r.counters.length ||
        localStates.get(r.id)?.status !== 'conditional' || globalStates.get(r.id)?.status !== 'conditional') continue;
    const premiseRoots = (p: ClaimRecord['supports'][number]['premises'][number], crossRealm = false): string[] | undefined => {
      if (p.kind === 'source') return spanCurrent(p, read) && spanCurrent(p, global) &&
        [read(p.source), global(p.source)].every((s) => s && ['user', 'ambient'].includes(s.role)) ? [`${p.source}:${p.hash}`] : undefined;
      const target = byId.get(p.id);
      return target?.kind === p.kind && target.revision === p.revision && (crossRealm || sameRealm(r.realm, target.realm)) && supported(p.id)
        ? commonStates.get(p.id)!.roots : undefined;
    };
    const bindings = [...r.participants.map((p) => premiseRoots(p.mention)), ...(r.references ?? []).map((p) => premiseRoots(p.mention, true))];
    if (bindings.some((roots) => !roots)) continue;
    const groups = r.supports.filter((g) => g.assumptions.length && g.premises.every((p) => premiseRoots(p)));
    if (groups.length) conditional.set(r.id, { groups, roots: [...new Set([
      ...bindings.flatMap((roots) => roots!), ...groups.flatMap((g) => g.premises.flatMap((p) => premiseRoots(p)!)),
    ])].sort() });
  }
  const groups = (r: ClaimRecord) => conditional.get(r.id)?.groups ?? r.supports.filter((g) => commonStates.get(r.id)?.groups.includes(g.id));
  let evidenceWork = 0, evidenceBytes = 0;
  // 原文与模型改写可以语言不同。只索引共同成立的支持链中的精确引文，不扩展整条消息或审计 reasons。
  // 每个候选独立去重，避免带环支持链递归；不把历史错误正文替换回返回材料。
  const evidenceText = (claim: ClaimRecord) => {
    const todo: SemanticRecord[] = [claim], seen = new Set<string>(), quotes = new Map<string, string>();
    let bytes = 0;
    const step = () => { if (++evidenceWork > 100_000) throw new Error('认识检索依据超过工作上限'); };
    const add = (span: SourceSpan) => {
      step();
      if (!spanCurrent(span, read) || !spanCurrent(span, global)) return;
      const key = `${span.source}:${span.hash}:${span.start}:${span.end}`;
      if (quotes.has(key)) return;
      const size = Buffer.byteLength(span.quote); bytes += size; evidenceBytes += size;
      if (bytes > 64 * 1024 || evidenceBytes > 4 * 1024 * 1024) throw new Error('认识检索依据超过工作上限');
      quotes.set(key, span.quote);
    };
    while (todo.length) {
      step(); const record = todo.pop()!;
      if (seen.has(record.id) || (!supported(record.id) && !(record.id === claim.id && conditional.has(claim.id)))) continue;
      seen.add(record.id);
      if (record.kind === 'mention') { add(record.anchor); continue; }
      if (record.kind !== 'claim') continue;
      for (const group of groups(record)) for (const premise of group.premises) {
        step();
        if (premise.kind === 'source') add(premise);
        else {
          const target = byId.get(premise.id);
          if (target?.kind === premise.kind && target.revision === premise.revision) todo.push(target);
        }
      }
    }
    return [...quotes.values()].join('\n');
  };
  const candidates: { item: SemanticItem; title: string; text: string }[] = [];
  for (const r of records) {
    const state = commonStates.get(r.id) ?? localStates.get(r.id)!;
    const roots = (conditional.get(r.id)?.roots ?? state.roots).map((key) => { const [id, hash] = key.split(':'); return { id: Number(id), hash }; });
    if (roots.length > 100) throw new Error('认识查询来源超过工作上限');
    if (roots.some((s) => read(s.id)?.hash !== s.hash)) throw new Error('认识查询来源已变化');
    const base = { id: r.id, revision: r.revision, realm: r.realm, roots };
    if (r.kind === 'claim' && (supported(r.id) || conditional.has(r.id))) {
      const participants = r.participants.flatMap((p) => {
        const mention = byId.get(p.mention.id);
        if (mention?.kind !== 'mention' || !mention.resolved || !supported(mention.id)) return [];
        const node = byId.get(mention.resolved.id);
        return node?.kind === 'node' && node.revision === mention.resolved.revision && supported(node.id)
          ? [{ role: p.role, mention: p.mention, object: { id: node.id, revision: node.revision, name: node.name } }] : [];
      });
      const references = (r.references ?? []).flatMap((p) => {
        const mention = byId.get(p.mention.id);
        if (mention?.kind !== 'mention' || mention.revision !== p.mention.revision || !mention.resolved || !supported(mention.id)) return [];
        const node = byId.get(mention.resolved.id);
        return node?.kind === 'node' && node.revision === mention.resolved.revision && supported(node.id)
          ? [{ role: p.role, mention: p.mention, realm: mention.realm, object: { id: node.id, revision: node.revision, name: node.name } }] : [];
      });
      candidates.push({ item: { ...base, kind: 'claim', status: conditional.has(r.id) ? 'conditional' : 'supported', text: r.text, nature: r.nature, occurred: r.occurred, valid: r.valid,
        participants, ...(r.references ? { references } : {}), supports: groups(r) }, title: [...participants, ...references].map((p) => p.object.name).join(' '), text: `${r.text}\n${evidenceText(r)}` });
    } else if (r.kind === 'mention' && state.status === 'ambiguous' && globalStates.get(r.id)?.status === 'ambiguous' && spanCurrent(r.anchor, read)) {
      const names = r.candidates.flatMap((ref) => {
        const node = byId.get(ref.id);
        return node?.kind === 'node' && node.revision === ref.revision && supported(node.id)
          ? [{ id: node.id, revision: node.revision, name: node.name }] : [];
      });
      candidates.push({ item: { ...base, roots: [{ id: r.anchor.source, hash: r.anchor.hash }], kind: 'mention', status: 'ambiguous', anchor: r.anchor,
        unknown: r.unknown || names.length !== r.candidates.length, candidates: names }, title: names.map((n) => n.name).join(' '), text: r.anchor.quote });
    }
  }
  return candidates.map((candidate) => ({ ...candidate, key: semanticDigest(candidate) }));
}

/** 索引只建议候选摘要的次序；查询和当前候选不匹配时不能沿用旧排名。 */
export interface SemanticNeighbors { queryHash: string; keys: string[] }
export function selectSemantic(records: SemanticRecord[], query: string, generation: number, read: SourceReader, global: SourceReader, neighbors?: SemanticNeighbors, related?: SemanticNeighbors): SemanticSelection {
  if (records.length > 1000 || query.length > 8000) throw new Error('认识查询超过工作上限');
  if (!query.trim()) return { generation, items: [], matched: 0 };
  const candidates = semanticCandidates(records, read, global);
  const byKey = new Map(candidates.map((c) => [c.item.id, c.item]));
  const ranked = rank(query, candidates.map((c) => ({ kind: 'memory', source: c.item.id, title: c.title, text: c.text, mtime: 0 })), 0);
  let items = ranked.slice(0, 6).map((hit) => byKey.get(hit.source)!), matched = ranked.length;
  if (neighbors || related) {
    const current = new Map(candidates.map((c) => [c.key, c.item]));
    const keys = new Map(candidates.map((c) => [c.item.id, c.key]));
    // 先核对当前候选再截断；重复条目不能获得额外票数，旧版本 / 隐藏 / 其他范围的摘要无权加入结果。
    const valid = (hints?: SemanticNeighbors) => hints && hints.queryHash === semanticDigest(query) && Array.isArray(hints.keys) && hints.keys.length <= 1000 &&
      hints.keys.every((key) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))
      ? [...new Set(hints.keys)].filter((key) => current.has(key)).slice(0, 6) : [];
    const dense = valid(neighbors), associated = valid(related);
    if (dense.length || associated.length) {
      const lexical = ranked.map((hit) => keys.get(hit.source)!);
      items = reciprocalRankFusion([lexical.slice(0, 6), dense, associated]).slice(0, 6).map((hit) => current.get(hit.key)!);
      matched = new Set([...lexical, ...dense, ...associated]).size;
    }
  }
  const result = { generation, items, matched };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error('认识查询结果超过工作上限');
  return result;
}

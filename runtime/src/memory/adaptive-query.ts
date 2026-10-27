// 前台只读选择：复用证据计算与现有词面排序，不在查询中生成新认识。
import { rank } from '../../../engine/src/retrieval.ts';
import crypto from 'node:crypto';
import { directSpans, evaluateEvidence, spanCurrent, type SemanticRecord, type SourceReader, type Realm, type ClaimRecord, type SourceSpan } from './adaptive-evidence.ts';

interface BaseItem { id: string; revision: number; realm: Realm; roots: { id: number; hash: string }[] }
export type SemanticItem = BaseItem & ({ kind: 'claim'; status: 'supported'; text: string;
  nature: ClaimRecord['nature']; occurred: ClaimRecord['occurred']; valid: ClaimRecord['valid']; supports: ClaimRecord['supports'];
  participants: { role: string; mention: ClaimRecord['participants'][number]['mention']; object: { id: string; revision: number; name: string } }[];
  references?: { role: string; mention: ClaimRecord['participants'][number]['mention']; realm: Realm; object: { id: string; revision: number; name: string } }[] }
  | { kind: 'mention'; status: 'ambiguous'; anchor: SourceSpan; unknown: boolean;
    candidates: { id: string; revision: number; name: string }[] });
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

export function selectSemantic(records: SemanticRecord[], query: string, generation: number, read: SourceReader, global: SourceReader): SemanticSelection {
  if (records.length > 1000 || query.length > 8000) throw new Error('认识查询超过工作上限');
  if (!query.trim()) return { generation, items: [], matched: 0 };
  const localStates = evaluateEvidence(records, read), globalStates = evaluateEvidence(records, global);
  const byId = new Map(records.map((r) => [r.id, r]));
  // 两个视图可能分别依赖不同分支而成立；只保留共同有效的组后再计算闭包，不能拼成不存在的共同证明。
  const common = records.filter((r) => localStates.get(r.id)?.status === 'supported' && globalStates.get(r.id)?.status === 'supported')
    .map((r) => r.kind === 'claim' ? { ...r, supports: r.supports.filter((g) => localStates.get(r.id)!.groups.includes(g.id) && globalStates.get(r.id)!.groups.includes(g.id)) } : r);
  const commonStates = evaluateEvidence(common, read);
  const supported = (id: string) => commonStates.get(id)?.status === 'supported';
  const groups = (r: ClaimRecord) => r.supports.filter((g) => commonStates.get(r.id)?.groups.includes(g.id));
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
      if (seen.has(record.id) || !supported(record.id)) continue;
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
    const roots = state.roots.map((key) => { const [id, hash] = key.split(':'); return { id: Number(id), hash }; });
    if (roots.length > 100) throw new Error('认识查询来源超过工作上限');
    if (roots.some((s) => read(s.id)?.hash !== s.hash)) throw new Error('认识查询来源已变化');
    const base = { id: r.id, revision: r.revision, realm: r.realm, roots };
    if (r.kind === 'claim' && supported(r.id)) {
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
      candidates.push({ item: { ...base, kind: 'claim', status: 'supported', text: r.text, nature: r.nature, occurred: r.occurred, valid: r.valid,
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
  const byKey = new Map(candidates.map((c) => [c.item.id, c.item]));
  const ranked = rank(query, candidates.map((c) => ({ kind: 'memory', source: c.item.id, title: c.title, text: c.text, mtime: 0 })), 0);
  const result = { generation, items: ranked.slice(0, 6).map((hit) => byKey.get(hit.source)!), matched: ranked.length };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error('认识查询结果超过工作上限');
  return result;
}

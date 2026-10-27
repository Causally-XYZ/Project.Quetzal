// 前台只读选择：复用证据计算与现有词面排序，不在查询中生成新认识。
import { rank } from '../../../engine/src/retrieval.ts';
import { evaluateEvidence, spanCurrent, type SemanticRecord, type SourceReader, type Realm, type ClaimRecord, type SourceSpan } from './adaptive-evidence.ts';

interface BaseItem { id: string; revision: number; realm: Realm; roots: { id: number; hash: string }[] }
export type SemanticItem = BaseItem & ({ kind: 'claim'; status: 'supported'; text: string;
  nature: ClaimRecord['nature']; occurred: ClaimRecord['occurred']; valid: ClaimRecord['valid']; supports: ClaimRecord['supports'];
  participants: { role: string; mention: ClaimRecord['participants'][number]['mention']; object: { id: string; revision: number; name: string } }[] }
  | { kind: 'mention'; status: 'ambiguous'; anchor: SourceSpan; unknown: boolean;
    candidates: { id: string; revision: number; name: string }[] });
export interface SemanticSelection { generation: number; items: SemanticItem[]; matched: number }

export function selectSemantic(records: SemanticRecord[], query: string, generation: number, read: SourceReader, global: SourceReader): SemanticSelection {
  if (records.length > 1000 || query.length > 8000) throw new Error('认识查询超过工作上限');
  if (!query.trim()) return { generation, items: [], matched: 0 };
  const localStates = evaluateEvidence(records, read), globalStates = evaluateEvidence(records, global);
  const byId = new Map(records.map((r) => [r.id, r]));
  const supported = (id: string) => localStates.get(id)?.status === 'supported' && globalStates.get(id)?.status === 'supported';
  const candidates: { item: SemanticItem; title: string; text: string }[] = [];
  for (const r of records) {
    const state = localStates.get(r.id)!;
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
      candidates.push({ item: { ...base, kind: 'claim', status: 'supported', text: r.text, nature: r.nature, occurred: r.occurred, valid: r.valid,
        participants, supports: r.supports.filter((g) => state.groups.includes(g.id)) }, title: participants.map((p) => p.object.name).join(' '), text: r.text });
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

// 未决争议是现有证据图的读取视图，不是新增事实或第二套持久存储。
import { directSpans, recordRefs, spanCurrent, type ClaimRecord, type EvidenceState, type SemanticRecord, type SourceReader } from './adaptive-evidence.ts';

export const CONFLICT_BYTES = 64 * 1024;
export interface ConflictBundle { records: SemanticRecord[]; roots: { id: number; hash: string }[] }

/** 完整带回当前依赖；缺版本、不可见来源或超预算时不返回残缺争议。
 * indeterminate 包括受未决前提影响的下游；必须实际找到两个不同命题之间的未决反证边。
 * 无根循环、已被明确反证的 contested 命题及单纯身份歧义不由此变成冲突。
 */
export function conflictBundle(root: ClaimRecord, byId: Map<string, SemanticRecord>,
  local: Map<string, EvidenceState>, global: Map<string, EvidenceState>, read: SourceReader, all: SourceReader): ConflictBundle | undefined {
  const uncertain = (id: string) => local.get(id)?.status === 'indeterminate' && global.get(id)?.status === 'indeterminate';
  if (!uncertain(root.id)) return;
  const todo: SemanticRecord[] = [root], seen = new Map<string, SemanticRecord>(), roots = new Map<number, string>();
  let bytes = 0, work = 0, dispute = false;
  while (todo.length) {
    const r = todo.pop()!;
    if (seen.has(r.id)) continue;
    seen.set(r.id, r); bytes += Buffer.byteLength(JSON.stringify(r));
    if (bytes > CONFLICT_BYTES || seen.size > 1000 || r.state !== 'present') return;
    for (const span of directSpans(r)) {
      if (++work > 10_000 || !spanCurrent(span, read) || !spanCurrent(span, all) || read(span.source)?.role !== all(span.source)?.role) return;
      if (roots.has(span.source) && roots.get(span.source) !== span.hash) return;
      roots.set(span.source, span.hash);
      if (roots.size > 100) return;
    }
    for (const ref of recordRefs(r)) {
      if (++work > 10_000) return;
      const target = byId.get(ref.id);
      if (!target || target.kind !== ref.kind || target.revision !== ref.revision) return;
      todo.push(target);
    }
    if (r.kind === 'claim' && uncertain(r.id)) dispute ||= r.counters.some((g) => !g.assumptions.length &&
      g.premises.some((p) => p.kind === 'claim' && p.id !== r.id && uncertain(p.id)));
  }
  if (!dispute || !roots.size || Buffer.byteLength(JSON.stringify([...seen.values()])) > CONFLICT_BYTES) return;
  return { records: [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)),
    roots: [...roots].sort(([a], [b]) => a - b).map(([id, hash]) => ({ id, hash })) };
}

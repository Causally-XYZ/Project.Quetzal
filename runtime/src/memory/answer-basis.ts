// 回答使用过的消息来源快照；只作依赖失效，不证明回答正确，也不代替逐句引用。
import crypto from 'node:crypto';
import type { SourceReading } from './adaptive-reading.ts';

export interface AnswerSource { id: number; hash: string | null; reading: string }
export interface AnswerBasis { version: 1; agent: string; answerHash: string; consistent: boolean; sources: AnswerSource[] }
export const answerDigest = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function parseAnswerBasis(value: unknown): AnswerBasis {
  const b = value as AnswerBasis, hash = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
  if (!b || typeof b !== 'object' || Object.keys(b).sort().join(',') !== 'agent,answerHash,consistent,sources,version' || b.version !== 1 ||
      typeof b.agent !== 'string' || !b.agent || b.agent.length > 300 || !hash(b.answerHash) || typeof b.consistent !== 'boolean' ||
      !Array.isArray(b.sources) || b.sources.length > 1000 || b.sources.some((s) => !s || Object.keys(s).sort().join(',') !== 'hash,id,reading' ||
        !Number.isSafeInteger(s.id) || s.id <= 0 || !(s.hash === null || hash(s.hash)) || !hash(s.reading)) ||
      new Set(b.sources.map((s) => s.id)).size !== b.sources.length) throw new Error('回答来源凭据损坏');
  return b;
}
// generation 属于本机，不可作为跨身体版本；notice 顺序不是语义。
export const answerSource = (s: SourceReading['sources'][number]): AnswerSource => ({ id: s.id, hash: s.hash,
  reading: answerDigest([...s.notices].sort((a, b) => a.id.localeCompare(b.id))) });
export function mergeAnswerSources(previous: Pick<AnswerBasis, 'consistent' | 'sources'> | undefined, sources: AnswerSource[]) {
  const merged = new Map((previous?.sources ?? []).map((s) => [s.id, s]));
  let consistent = previous?.consistent ?? true;
  for (const source of sources) {
    const old = merged.get(source.id);
    if (old && JSON.stringify(old) !== JSON.stringify(source)) consistent = false;
    if (merged.size >= 1000 && !old) { consistent = false; continue; }
    merged.set(source.id, source);
  }
  return { consistent, sources: [...merged.values()].sort((a, b) => a.id - b.id) };
}
export function answerBasisStatus(basis: AnswerBasis, text: string, agent: string, view: SourceReading): 'unchanged' | 'changed' {
  if (!basis.consistent || basis.agent !== agent || basis.answerHash !== answerDigest(text)) return 'changed';
  const current = new Map(view.sources.map((s) => [s.id, answerSource(s)]));
  return basis.sources.every((s) => JSON.stringify(current.get(s.id)) === JSON.stringify(s)) ? 'unchanged' : 'changed';
}
export const ANSWER_CHANGED = '【这条历史回答使用过的消息来源或认识已变化、缺失，或生成期间存在混合版本；没有逐句依赖映射，不在当前上下文沿用旧回答正文。请按当前来源重新判断，历史记录仍保留。】';
export const ANSWER_UNBOUND = '【这条历史助手回答没有消息来源凭据；不能核查其依据，不能作为独立事实证据。】';

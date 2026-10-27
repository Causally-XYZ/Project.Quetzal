// 认识的版本与依据规则。不把模型置信度、同名或结构校验转换成世界事实确认。
import { ARTIFACT_ID } from './adaptive-artifact.ts';

export const SEMANTIC_SCHEMA = 'quetzal-adaptive-semantic-v1';
export interface SourceSpan { kind: 'source'; source: number; hash: string; start: number; end: number; quote: string }
export interface RecordRef { kind: 'node' | 'mention' | 'claim'; id: string; revision: number }
export type Premise = SourceSpan | RecordRef;
export interface Realm { world: 'real' | 'fiction' | 'hypothetical' | 'unknown'; context: string }
interface BaseRecord { id: string; revision: number; state: 'present' | 'withdrawn'; realm: Realm; reasons: SourceSpan[] }
export interface ObjectRecord extends BaseRecord { kind: 'node'; name: string; labels: string[] }
export interface MentionRecord extends BaseRecord {
  kind: 'mention'; anchor: SourceSpan; candidates: RecordRef[]; unknown: boolean; resolved: RecordRef | null;
}
export interface EvidenceGroup { id: string; premises: Premise[]; assumptions: string[] }
export interface TimeDescription { text: string; earliest: string | null; latest: string | null }
export interface ClaimRecord extends BaseRecord {
  kind: 'claim'; text: string; nature: 'reported' | 'inferred' | 'hypothesis';
  participants: { role: string; mention: RecordRef }[];
  occurred: TimeDescription; valid: TimeDescription;
  supports: EvidenceGroup[]; counters: EvidenceGroup[];
}
export type SemanticRecord = ObjectRecord | MentionRecord | ClaimRecord;
export interface SemanticBatch { baseGeneration: number; records: SemanticRecord[] }
export interface EvidenceSource { text: string; hash: string; role: string }
export type SourceReader = (id: number) => EvidenceSource | undefined;
export interface EvidenceState {
  status: 'supported' | 'ambiguous' | 'conditional' | 'unsupported' | 'indeterminate' | 'contested' | 'withdrawn';
  groups: string[]; roots: string[];
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(): never { throw new Error('认识记录格式或引用不合法'); }
const text = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
function fields(v: unknown, keys: string[]): asserts v is Record<string, any> {
  if (!object(v) || Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail();
}
function spans(value: unknown, min = 1): asserts value is SourceSpan[] {
  if (!Array.isArray(value) || value.length < min || value.length > 50) fail();
  for (const x of value) validateSpan(x);
}
export function validateSpan(v: unknown): asserts v is SourceSpan {
  fields(v, ['kind', 'source', 'hash', 'start', 'end', 'quote']);
  if (v.kind !== 'source' || !integer(v.source, 1) || typeof v.hash !== 'string' || !/^[a-f0-9]{64}$/.test(v.hash) ||
      !integer(v.start) || !integer(v.end, 1) || v.end <= v.start || !text(v.quote, 8000) || v.end - v.start !== v.quote.length) fail();
}
function reference(v: unknown): asserts v is RecordRef {
  fields(v, ['kind', 'id', 'revision']);
  if (!['node', 'mention', 'claim'].includes(v.kind) || typeof v.id !== 'string' || !ARTIFACT_ID.test(v.id) || !integer(v.revision, 1)) fail();
}
function time(v: unknown) {
  fields(v, ['text', 'earliest', 'latest']);
  if (typeof v.text !== 'string' || v.text.length > 500) fail();
  for (const t of [v.earliest, v.latest]) if (t !== null && (typeof t !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(t) ||
      !Number.isFinite(Date.parse(t)) || new Date(t).toISOString().replace('.000Z', 'Z') !== t.replace('.000Z', 'Z') || !v.text.trim())) fail();
  if (v.earliest !== null && v.latest !== null && Date.parse(v.earliest) > Date.parse(v.latest)) fail();
}
export function validateRecord(v: unknown): asserts v is SemanticRecord {
  if (!object(v)) fail();
  const base = ['id', 'revision', 'state', 'realm', 'reasons', 'kind'];
  if (v.kind === 'node') fields(v, [...base, 'name', 'labels']);
  else if (v.kind === 'mention') fields(v, [...base, 'anchor', 'candidates', 'unknown', 'resolved']);
  else if (v.kind === 'claim') fields(v, [...base, 'text', 'nature', 'participants', 'occurred', 'valid', 'supports', 'counters']);
  else fail();
  if (typeof v.id !== 'string' || !ARTIFACT_ID.test(v.id) || !integer(v.revision, 1) || !['present', 'withdrawn'].includes(v.state)) fail();
  fields(v.realm, ['world', 'context']);
  if (!['real', 'fiction', 'hypothetical', 'unknown'].includes(v.realm.world) || !text(v.realm.context, 300)) fail();
  spans(v.reasons);
  if (v.kind === 'node') {
    if (!text(v.name, 300) || !Array.isArray(v.labels) || v.labels.length > 20 || v.labels.some((x: unknown) => !text(x, 100))) fail();
  } else if (v.kind === 'mention') {
    validateSpan(v.anchor);
    if (!Array.isArray(v.candidates) || v.candidates.length > 20 || typeof v.unknown !== 'boolean') fail();
    const ids = new Set<string>();
    for (const candidate of v.candidates) { reference(candidate); if (candidate.kind !== 'node' || ids.has(candidate.id)) fail(); ids.add(candidate.id); }
    if (v.resolved !== null) {
      reference(v.resolved);
      if (v.unknown || !v.candidates.some((c: RecordRef) => refKey(c) === refKey(v.resolved))) fail();
    } else if (!v.unknown && !v.candidates.length) fail();
  } else {
    if (!text(v.text, 8000) || !['reported', 'inferred', 'hypothesis'].includes(v.nature) || !Array.isArray(v.participants) || v.participants.length > 30) fail();
    for (const p of v.participants) { fields(p, ['role', 'mention']); if (!text(p.role, 100)) fail(); reference(p.mention); if (p.mention.kind !== 'mention') fail(); }
    time(v.occurred); time(v.valid);
    if (!Array.isArray(v.supports) || v.supports.length > 20 || !Array.isArray(v.counters) || v.counters.length > 20) fail();
    const groups = new Set<string>();
    for (const g of [...v.supports, ...v.counters]) {
      fields(g, ['id', 'premises', 'assumptions']);
      if (!text(g.id, 100) || groups.has(g.id) || !Array.isArray(g.premises) || !g.premises.length || g.premises.length > 50 ||
          !Array.isArray(g.assumptions) || g.assumptions.length > 20 || g.assumptions.some((x: unknown) => !text(x, 500))) fail();
      groups.add(g.id);
      for (const p of g.premises) { if (p?.kind === 'source') validateSpan(p); else { reference(p); if (p.kind === 'node') fail(); } }
    }
  }
}
export function validateBatch(v: unknown): asserts v is SemanticBatch {
  fields(v, ['baseGeneration', 'records']);
  if (!integer(v.baseGeneration) || !Array.isArray(v.records) || !v.records.length || v.records.length > 100) fail();
  const ids = new Set<string>();
  for (const r of v.records) { validateRecord(r); if (ids.has(r.id)) fail(); ids.add(r.id); }
}
export const refKey = (ref: RecordRef) => `${ref.kind}:${ref.id}:${ref.revision}`;
export const sameRealm = (a: Realm, b: Realm) => a.world === b.world && a.context === b.context;
export function directSpans(r: SemanticRecord): SourceSpan[] {
  return [...r.reasons, ...(r.kind === 'mention' ? [r.anchor] : r.kind === 'claim'
    ? [...r.supports, ...r.counters].flatMap((g) => g.premises.filter((p): p is SourceSpan => p.kind === 'source')) : [])];
}
export function recordRefs(r: SemanticRecord): RecordRef[] {
  return r.kind === 'mention' ? r.candidates : r.kind === 'claim'
    ? [...r.participants.map((p) => p.mention), ...[...r.supports, ...r.counters].flatMap((g) => g.premises.filter((p): p is RecordRef => p.kind !== 'source'))] : [];
}
export function spanCurrent(span: SourceSpan, read: SourceReader): boolean {
  const source = read(span.source);
  const splitsPair = (i: number) => !!source && i > 0 && i < source.text.length &&
    /[\uD800-\uDBFF]/.test(source.text[i - 1]) && /[\uDC00-\uDFFF]/.test(source.text[i]);
  return !!source && source.hash === span.hash && !splitsPair(span.start) && !splitsPair(span.end) && source.text.slice(span.start, span.end) === span.quote;
}

/** 支持组用正向最小不动点；反证用交替上下界，负向循环保留未知。
 * 根来源集合去重；supported 只表示当前依据成立，不改变认识性质或个人确认门禁。
 */
export function evaluateEvidence(records: SemanticRecord[], read: SourceReader, maxWork = 100_000): Map<string, EvidenceState> {
  if (!Number.isSafeInteger(maxWork) || maxWork < 1) throw new Error('认识依据工作上限不合法');
  let work = 0;
  const step = () => { if (++work > maxWork) throw new Error('认识依据计算超过工作上限'); };
  const sources = new Map<number, EvidenceSource | undefined>();
  const source: SourceReader = (id) => { if (!sources.has(id)) sources.set(id, read(id)); return sources.get(id); };
  const current = new Map(records.map((r) => [r.id, r]));
  if (current.size !== records.length) throw new Error('认识快照包含重复 ID');
  const sourceRoot = (p: SourceSpan) => `${p.source}:${p.hash}`;
  const grounded = (p: SourceSpan) => { step(); return spanCurrent(p, source) && ['user', 'ambient'].includes(source(p.source)!.role); };
  // Claim reasons 是版本审计来源；证明所需条件只能放进 supports / counters，避免把 OR 偷换成全局 AND。
  const eligible = (r: SemanticRecord) => r.state === 'present' && (r.kind === 'claim' || r.reasons.every((p) => spanCurrent(p, source)));
  const target = (r: SemanticRecord, ref: RecordRef) => {
    step(); const found = current.get(ref.id);
    return found?.kind === ref.kind && found.revision === ref.revision && sameRealm(r.realm, found.realm) ? found : undefined;
  };
  const ready = (r: SemanticRecord, p: Premise, known: ReadonlySet<string>) => p.kind === 'source' ? grounded(p) : !!target(r, p) && known.has(p.id);
  const counter = (r: ClaimRecord, known: ReadonlySet<string>) => r.counters.some((g) => !g.assumptions.length && g.premises.every((p) => ready(r, p, known)));

  // 固定反证假设后，只做正向闭包。源 / 身份绑定、AND / OR 与根传播均单调。
  const close = (assumed: ReadonlySet<string>) => {
    const roots = new Map<string, Set<string>>(), groups = new Map<string, Set<string>>();
    const blocked = new Set(records.filter((r) => r.kind === 'claim' && counter(r, assumed)).map((r) => r.id));
    for (const r of records) {
      step(); groups.set(r.id, new Set());
      if (r.kind === 'node' && eligible(r) && r.reasons.every(grounded)) roots.set(r.id, new Set(r.reasons.map(sourceRoot)));
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of records) {
        step(); if (!eligible(r) || blocked.has(r.id)) continue;
        const add = (values: Iterable<string>) => {
          const set = roots.get(r.id) ?? new Set<string>();
          for (const value of values) { step(); if (!set.has(value)) { set.add(value); changed = true; } }
          if (set.size) roots.set(r.id, set);
        };
        if (r.kind === 'mention') {
          const n = r.resolved && target(r, r.resolved);
          if (n?.kind === 'node' && roots.has(n.id) && grounded(r.anchor) && r.reasons.every(grounded))
            add([...r.reasons.map(sourceRoot), sourceRoot(r.anchor), ...roots.get(n.id)!]);
        } else if (r.kind === 'claim') {
          const proof = (p: Premise): Set<string> | undefined => p.kind === 'source'
            ? grounded(p) ? new Set([sourceRoot(p)]) : undefined : target(r, p) ? roots.get(p.id) : undefined;
          const participants = r.participants.map((p) => proof(p.mention));
          if (participants.some((p) => !p)) continue;
          for (const group of r.supports) {
            step(); if (group.assumptions.length) continue;
            const evidence = group.premises.map(proof);
            if (evidence.every((p) => !!p)) {
              groups.get(r.id)!.add(group.id);
              add([...evidence.flatMap((p) => [...p!]), ...participants.flatMap((p) => [...p!])]);
            }
          }
        }
      }
    }
    return { roots, groups, ids: new Set(roots.keys()) };
  };
  const equal = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
  let lower = new Set<string>(), upper = new Set(records.filter(eligible).map((r) => r.id));
  let definite: ReturnType<typeof close>;
  for (;;) {
    definite = close(upper);
    const possible = close(definite.ids);
    if (equal(lower, definite.ids) && equal(upper, possible.ids)) break;
    lower = definite.ids; upper = possible.ids;
  }
  const result = new Map<string, EvidenceState>();
  for (const r of records) {
    step(); let status: EvidenceState['status'] = 'unsupported';
    if (r.state === 'withdrawn') status = 'withdrawn';
    else if (definite.ids.has(r.id)) status = 'supported';
    else if (r.kind === 'claim' && counter(r, definite.ids)) status = 'contested';
    else if (upper.has(r.id)) status = 'indeterminate';
    else if (eligible(r)) {
      if (r.kind === 'mention' && !r.resolved && spanCurrent(r.anchor, source)) status = 'ambiguous';
      if (r.kind === 'claim' && r.participants.every((p) => ready(r, p.mention, definite.ids)) &&
          r.supports.some((g) => g.assumptions.length && g.premises.every((p) => ready(r, p, definite.ids)))) status = 'conditional';
    }
    result.set(r.id, { status, roots: [...(definite.roots.get(r.id) ?? [])].sort(), groups: [...(definite.groups.get(r.id) ?? [])].sort() });
  }
  return result;
}

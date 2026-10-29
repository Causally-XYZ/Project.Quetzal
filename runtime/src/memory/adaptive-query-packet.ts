// 正式身体间的查询信封；验证结构与请求绑定，不把 supported 升格为事实真值。
import { ARTIFACT_ID } from './adaptive-artifact.ts';
import { directSpans, recordRefs, sameRealm, validateRecord, validateSpan } from './adaptive-evidence.ts';
import { CONFLICT_BYTES } from './adaptive-conflict.ts';
import { semanticDigest, type SemanticBasis, type SemanticItem } from './adaptive-query.ts';
import type { SemanticMemoryReading } from './adaptive.ts';

export interface SemanticQueryPacket extends SemanticMemoryReading { version: 1 | 2 | 3 | 4; queryHash: string; generatedAt: number; basis: SemanticBasis }
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, n: number) => typeof v === 'string' && v.length > 0 && v.length <= n;
const integer = (v: unknown, min = 0) => Number.isSafeInteger(v) && Number(v) >= min;
function requireValue(ok: unknown): asserts ok { if (!ok) throw new Error('认识查询信封格式或范围不合法'); }
function object(value: unknown, keys: string[]): Record<string, any> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  const v = value as Record<string, any>;
  requireValue(Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k))); return v;
}
function reference(value: unknown) {
  const r = object(value, ['kind', 'id', 'revision']);
  requireValue(['node', 'mention', 'claim'].includes(r.kind) && typeof r.id === 'string' && ARTIFACT_ID.test(r.id) && integer(r.revision, 1));
}
function time(value: unknown) {
  const t = object(value, ['text', 'earliest', 'latest']); requireValue(typeof t.text === 'string' && t.text.length <= 500);
  for (const key of ['earliest', 'latest']) if (t[key] !== null) requireValue(text(t.text.trim(), 500) && typeof t[key] === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(t[key]) && Number.isFinite(Date.parse(t[key])) &&
    new Date(t[key]).toISOString().replace('.000Z', 'Z') === t[key].replace('.000Z', 'Z'));
  requireValue(t.earliest === null || t.latest === null || Date.parse(t.earliest) <= Date.parse(t.latest));
}
function validateItem(value: unknown): asserts value is SemanticItem {
  const v = value as any;
  object(v, ['id', 'revision', 'realm', 'roots', 'kind', 'status', ...(v?.kind === 'claim'
    ? ['text', 'nature', 'occurred', 'valid', 'supports', 'participants', ...(Object.hasOwn(v, 'references') ? ['references'] : [])] : v?.kind === 'conflict' ? ['records'] : ['anchor', 'unknown', 'candidates'])]);
  requireValue(typeof v.id === 'string' && ARTIFACT_ID.test(v.id) && integer(v.revision, 1));
  const realm = object(v.realm, ['world', 'context']); requireValue(['real', 'fiction', 'hypothetical', 'unknown'].includes(realm.world) && text(realm.context, 300));
  requireValue(Array.isArray(v.roots) && v.roots.length > 0 && v.roots.length <= 100);
  const roots = new Set<number>();
  for (const root of v.roots) { object(root, ['id', 'hash']); requireValue(integer(root.id, 1) && hash(root.hash) && !roots.has(root.id)); roots.add(root.id); }
  if (v.kind === 'conflict') {
    requireValue(v.status === 'indeterminate' && Array.isArray(v.records) && v.records.length > 1 && v.records.length <= 1000 && Buffer.byteLength(JSON.stringify(v.records)) <= CONFLICT_BYTES);
    const ids = new Map<string, any>();
    for (const r of v.records) { validateRecord(r); requireValue(r.state === 'present' && !ids.has(r.id)); ids.set(r.id, r); }
    const root = ids.get(v.id); requireValue(root?.kind === 'claim' && root.revision === v.revision && sameRealm(root.realm, v.realm));
    for (const r of v.records) {
      for (const ref of recordRefs(r)) requireValue(ids.get(ref.id)?.kind === ref.kind && ids.get(ref.id)?.revision === ref.revision);
      for (const s of directSpans(r)) requireValue(v.roots.some((x: any) => x.id === s.source && x.hash === s.hash));
    }
  } else if (v.kind === 'mention') {
    requireValue(v.status === 'ambiguous' && typeof v.unknown === 'boolean' && Array.isArray(v.candidates) && v.candidates.length <= 20);
    validateSpan(v.anchor); requireValue(v.roots.some((r: any) => r.id === v.anchor.source && r.hash === v.anchor.hash));
    const ids = new Set<string>();
    for (const c of v.candidates) { object(c, ['id', 'revision', 'name']); requireValue(typeof c.id === 'string' && ARTIFACT_ID.test(c.id) && integer(c.revision, 1) && text(c.name, 300) && !ids.has(c.id)); ids.add(c.id); }
    requireValue(v.unknown || v.candidates.length > 0);
  } else {
    requireValue(v.kind === 'claim' && ['supported', 'conditional'].includes(v.status) && (v.status !== 'conditional' || v.nature !== 'reported') && text(v.text, 8000) && ['reported', 'inferred', 'hypothesis'].includes(v.nature));
    time(v.occurred); time(v.valid);
    requireValue(Array.isArray(v.participants) && v.participants.length <= 30 && Array.isArray(v.supports) && v.supports.length > 0 && v.supports.length <= 20);
    for (const p of v.participants) {
      object(p, ['role', 'mention', 'object']); requireValue(text(p.role, 100)); reference(p.mention); requireValue(p.mention.kind === 'mention');
      object(p.object, ['id', 'revision', 'name']); requireValue(typeof p.object.id === 'string' && ARTIFACT_ID.test(p.object.id) && integer(p.object.revision, 1) && text(p.object.name, 300));
    }
    if (Object.hasOwn(v, 'references')) {
      requireValue(Array.isArray(v.references) && v.references.length <= 30);
      for (const p of v.references) {
        object(p, ['role', 'mention', 'realm', 'object']); requireValue(text(p.role, 100)); reference(p.mention); requireValue(p.mention.kind === 'mention');
        const realm = object(p.realm, ['world', 'context']); requireValue(['real', 'fiction', 'hypothetical', 'unknown'].includes(realm.world) && text(realm.context, 300));
        object(p.object, ['id', 'revision', 'name']); requireValue(typeof p.object.id === 'string' && ARTIFACT_ID.test(p.object.id) && integer(p.object.revision, 1) && text(p.object.name, 300));
      }
    }
    const ids = new Set<string>();
    for (const g of v.supports) {
      object(g, ['id', 'premises', 'assumptions']); requireValue(text(g.id, 100) && !ids.has(g.id)); ids.add(g.id);
      requireValue(Array.isArray(g.assumptions) && (v.status === 'conditional' ? g.assumptions.length > 0 && g.assumptions.length <= 20 && g.assumptions.every((a: unknown) => text(a, 500)) : g.assumptions.length === 0) && Array.isArray(g.premises) && g.premises.length > 0 && g.premises.length <= 50);
      for (const p of g.premises) { if (p?.kind === 'source') validateSpan(p); else { reference(p); requireValue(p.kind !== 'node'); } }
    }
  }
}

export function decodeSemanticPacket(value: unknown, agent: string, host: string, query: string): SemanticQueryPacket {
  requireValue(Buffer.byteLength(JSON.stringify(value) ?? '') <= 512 * 1024);
  const p = object(value, ['version', 'queryHash', 'generatedAt', 'agent', 'host', 'status', 'freshness', 'generation', 'items', 'matched', 'basis']);
  requireValue([1, 2, 3, 4].includes(p.version) && p.agent === agent && p.host === host && p.queryHash === semanticDigest(query) && integer(p.generatedAt) &&
    p.generatedAt >= Date.now() - 60_000 && p.generatedAt <= Date.now() + 300_000 && ['ready', 'disabled', 'unavailable', 'stopped'].includes(p.status));
  requireValue(p.freshness === (p.status === 'ready' ? 'local-snapshot' : 'unknown') && integer(p.generation) && integer(p.matched) && p.matched <= 1000 && Array.isArray(p.items) && p.items.length <= 6 && p.items.length <= p.matched);
  object(p.basis, ['records', 'sources']);
  requireValue(Array.isArray(p.basis.records) && p.basis.records.length <= 1000 && Array.isArray(p.basis.sources) && p.basis.sources.length <= 1000);
  const records = new Map<string, number>(), sources = new Map<number, string | null>();
  for (const r of p.basis.records) { object(r, ['id', 'revision', 'hash']); requireValue(typeof r.id === 'string' && ARTIFACT_ID.test(r.id) && integer(r.revision, 1) && hash(r.hash) && !records.has(r.id)); records.set(r.id, r.revision); }
  for (const s of p.basis.sources) { object(s, ['id', 'hash']); requireValue(integer(s.id, 1) && (s.hash === null || hash(s.hash)) && !sources.has(s.id)); sources.set(s.id, s.hash); }
  const seen = new Set<string>();
  for (const item of p.items) {
    validateItem(item); requireValue(p.version >= 2 || !Object.hasOwn(item, 'references')); requireValue(p.version >= 3 || item.status !== 'conditional'); requireValue(!seen.has(item.id) && records.get(item.id) === item.revision); seen.add(item.id);
    for (const r of item.roots) requireValue(sources.get(r.id) === r.hash);
    if (item.kind === 'conflict') {
      requireValue(p.version >= 4);
      for (const r of item.records) requireValue(records.get(r.id) === r.revision && p.basis.records.some((b: any) => b.id === r.id && b.hash === semanticDigest(r)));
    }
    const refs = item.kind === 'conflict' ? item.records : item.kind === 'mention' ? item.candidates : [...[...item.participants, ...(item.references ?? [])].flatMap((x) => [x.mention, x.object]), ...item.supports.flatMap((g) => g.premises.filter((x) => x.kind !== 'source'))];
    for (const r of refs) requireValue(records.get(r.id) === r.revision);
    if (item.kind === 'claim') for (const g of item.supports) for (const s of g.premises) if (s.kind === 'source') requireValue(sources.get(s.source) === s.hash);
  }
  if (p.status !== 'ready') requireValue(!p.items.length && !p.matched && !p.generation && !records.size && !sources.size);
  // 返回副本，避免调用者修改被验证对象；不接受任何额外字段进入模型。
  return structuredClone(p) as SemanticQueryPacket;
}

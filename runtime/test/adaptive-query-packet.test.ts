import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { selectSemantic, semanticBasis, semanticDigest, compatibleSemanticBasis } from '../src/memory/adaptive-query.ts';
import { decodeSemanticPacket } from '../src/memory/adaptive-query-packet.ts';
import type { ClaimRecord, SourceSpan } from '../src/memory/adaptive-evidence.ts';
function fixture() {
  const span: SourceSpan = { kind: 'source', source: 1, hash: 'a'.repeat(64), start: 0, end: 2, quote: '采风' };
  const record: ClaimRecord = { id: crypto.randomUUID(), revision: 1, state: 'present', realm: { world: 'real', context: 'real' }, reasons: [span],
    kind: 'claim', text: '采风中的线索', nature: 'inferred', participants: [], occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
    supports: [{ id: 'source', premises: [span], assumptions: [] }], counters: [] };
  const read = () => ({ text: '采风', hash: span.hash, role: 'user' });
  const basis = semanticBasis([record], read), selection = selectSemantic([record], '采风', 1, read, read);
  const packet = { version: 1 as const, agent: 'x', host: 'center', queryHash: semanticDigest('采风'), generatedAt: Date.now(), status: 'ready' as const, freshness: 'local-snapshot' as const, ...selection, basis };
  return { record, packet, basis, read };
}
const decode = (p: unknown) => decodeSemanticPacket(p, 'x', 'center', '采风');
test('合法语义信封保留性质、状态、来源与版本，返回独立副本', () => {
  const { packet } = fixture(), decoded = decode(packet);
  assert.deepEqual(decoded, packet); assert.notEqual(decoded.items, packet.items);
});
test('拒绝其他请求、身份、版本、过时信封和额外字段', () => {
  const { packet } = fixture();
  for (const delta of [{ agent: 'other' }, { host: 'other' }, { version: 3 }, { queryHash: semanticDigest('另一个查询') }, { generatedAt: Date.now() - 61_000 }, { verified: true }, { generation: -1 }])
    assert.throws(() => decode({ ...packet, ...delta }), /信封/);
});
test('拒绝缺少依赖版本或来源、重复条目与伪造 supported 正文形状', () => {
  const { packet } = fixture();
  for (const edit of [
    (p: any) => p.basis.records.splice(0), (p: any) => p.basis.sources.splice(0), (p: any) => p.items.push(p.items[0]),
    (p: any) => p.items[0].nature = 'verified', (p: any) => p.items[0].supports[0].assumptions.push('未核实'),
    (p: any) => p.items[0].occurred.earliest = '2026-02-30T00:00:00Z', (p: any) => p.items[0].active = true,
    (p: any) => p.items[0].supports[0].premises[0].hash = 'b'.repeat(64),
  ]) { const p = structuredClone(packet); edit(p); assert.throws(() => decode(p)); }
  assert.throws(() => decode({ ...packet, status: 'unavailable', freshness: 'unknown' }));
});
test('本机更高版本、同版分叉、主机缺少本机记录及来源编辑均拒绝；可接受较新主机', () => {
  const { basis } = fixture(); assert.equal(compatibleSemanticBasis(basis, basis), true);
  const newer = structuredClone(basis); newer.records[0].revision++;
  assert.equal(compatibleSemanticBasis(basis, newer), false); assert.equal(compatibleSemanticBasis(newer, basis), true);
  const fork = structuredClone(basis); fork.records[0].hash = 'b'.repeat(64); assert.equal(compatibleSemanticBasis(basis, fork), false);
  assert.equal(compatibleSemanticBasis({ records: [], sources: [] }, basis), false);
  const edited = structuredClone(basis); edited.sources[0].hash = null; assert.equal(compatibleSemanticBasis(basis, edited), false);
});

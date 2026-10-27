import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProposal, proposalPrompt, type ProposalContext } from '../src/memory/adaptive-proposal.ts';
import type { SemanticRecord, SourceSpan } from '../src/memory/adaptive-evidence.ts';
const context = (): ProposalContext => ({ generation: 3, current: 1, records: [], sources: [{ id: 1, revision: 4, hash: 'a'.repeat(64),
  text: '阿舟说：阿舟是我的昵称。🙂', role: 'user', ts: Date.parse('2026-01-01T12:00:00Z'), channel: 'synthetic', session: 'session', body: 'alpha', via: null }] });
const quote = (text = '阿舟', occurrence: number | null = 0) => ({ kind: 'source', source: 's1', text, occurrence });
const node = () => ({ key: 'p1', replace: null, kind: 'node', state: 'present', realm: 'real', reasons: [quote()], name: '阿舟', labels: ['人物'] });
const patch = () => ({ contexts: [], records: [node()] });

test('提案用宿主 ID、来源 hash、准确位置和快照代次，模型不指定可信状态', () => {
  const c = context(), result = normalizeProposal(patch(), c)!;
  assert.equal(result.baseGeneration, 3); assert.equal(result.records[0].revision, 1);
  assert.match(result.records[0].id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(result.records[0].reasons[0], { kind: 'source', source: 1, hash: 'a'.repeat(64), start: 0, end: 2, quote: '阿舟' });
  for (const field of ['verified', 'id', 'revision']) {
    const p = patch(); (p.records[0] as any)[field] = true;
    assert.throws(() => normalizeProposal(p, c), /字段/);
  }
});

test('同句重复引文必须定位，缺失片段、错误来源和半个代理对均被拒绝', () => {
  const c = context();
  for (const q of [quote('阿舟', null), quote('不存在'), quote('🙂', 3), quote('\ud83d'), { ...quote(), source: 's2' }]) {
    const p = patch(); p.records[0].reasons = [q]; assert.throws(() => normalizeProposal(p, c), /引文|引用/);
  }
  const p = patch(); p.records[0].reasons = [quote('阿舟', 1)];
  assert.equal(normalizeProposal(p, c)!.records[0].reasons[0].start, 4);
});

test('修订保留 ID、递增版本；新引用显式区分新版本 p-key 和旧版本 r-key', () => {
  const c = context(); c.records = normalizeProposal(patch(), c)!.records;
  const p: any = patch(); p.records[0].replace = 'r1'; p.records[0].name = '新名称';
  p.records.push({ key: 'p2', replace: null, kind: 'mention', state: 'present', realm: 'real', reasons: [quote()],
    anchor: quote(), candidates: ['p1'], unknown: false, resolved: 'p1' });
  const result = normalizeProposal(p, c)!;
  assert.equal(result.records[0].id, c.records[0].id); assert.equal(result.records[0].revision, 2);
  const m = result.records[1]; assert.equal(m.kind, 'mention'); if (m.kind === 'mention') assert.equal(m.resolved?.revision, 2);
  p.records[1].candidates = ['r1']; p.records[1].resolved = 'r1';
  const old = normalizeProposal(p, c)!.records[1]; if (old.kind === 'mention') assert.equal(old.resolved?.revision, 1);
  p.records[0].replace = 'r999'; assert.throws(() => normalizeProposal(p, c), /修订目标/);
});

test('新语境宿主分配身份；不存在的记录、重复修订、跨种类替换被拒绝', () => {
  const c = context(); c.records = normalizeProposal(patch(), c)!.records;
  const p: any = patch(); p.contexts = [{ key: 'c1', world: 'fiction', because: quote() }]; p.records[0].realm = 'c1';
  const result = normalizeProposal(p, c)!.records[0]; assert.equal(result.realm.world, 'fiction'); assert.notEqual(result.realm.context, 'c1');
  p.records[0].realm = 'made-up'; assert.throws(() => normalizeProposal(p, c), /语境/);
  const repeated: any = patch(); repeated.records[0].replace = 'r1'; repeated.records.push({ ...repeated.records[0], key: 'p2' });
  assert.throws(() => normalizeProposal(repeated, c), /修订目标/);
  const wrong: any = patch(); wrong.records[0].replace = 'r1'; wrong.records[0].kind = 'claim'; assert.throws(() => normalizeProposal(wrong, c), /修订目标/);
});

test('输入记录引用用可见句柄，旧版本和缺失来源不能被重新映射成最新', () => {
  const c = context(); const r = normalizeProposal(patch(), c)!.records[0]; c.records.push(r);
  const span: SourceSpan = { kind: 'source', source: 1, hash: 'a'.repeat(64), start: 0, end: 2, quote: '阿舟' };
  c.records.push({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', revision: 2, kind: 'mention', state: 'present', realm: r.realm, reasons: [span], anchor: span,
    candidates: [{ kind: 'node', id: r.id, revision: 99 }], resolved: null, unknown: true });
  const prompt = proposalPrompt(c), data = JSON.parse(prompt.user);
  assert.ok(!prompt.user.includes(r.id)); assert.ok(!prompt.user.includes('a'.repeat(64)));
  assert.deepEqual(data.records[1].candidates, [{ unavailableRevision: true }]);
  c.sources[0].hash = 'b'.repeat(64);
  assert.deepEqual(JSON.parse(proposalPrompt(c).user).records[0].reasons, [{ unavailableSource: true }]);
  assert.equal(normalizeProposal({ contexts: [], records: [] }, c), null);
});

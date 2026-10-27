// live 标签只是评分算术夹具；没有调用模型或实际语义审核，不能当正式成绩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSuite, makePlan } from '../tool/adaptive-eval/plan.ts';
import { digest, type Surface } from '../tool/adaptive-eval/spec.ts';
import { checkpoints, scoreSuite, type Receipt } from '../tool/adaptive-eval/score.ts';
import { reviewPacket, buildReview, verifyReview, saveReview, loadReview, validateSelection, type ReviewDraft } from '../tool/adaptive-eval/review.ts';

const suite = loadSuite(), c = suite.cases[0], entries = [{ file: 'runtime/src/synthetic.ts', sha256: '0'.repeat(64) }];
const plan = makePlan(suite, { revision: '0'.repeat(40), code: entries, codeHash: digest(entries) }, 'live');
const surfaces: Surface[] = ['records', 'material', 'answer', 'sources', 'events'];
const receipt: Receipt = { schema: 'quetzal-m2-receipt-v1', suiteHash: digest(suite), planHash: digest(plan), caseId: c.id, repeat: 1,
  kind: 'live', status: 'complete', artifacts: checkpoints(c).flatMap((p, i) => surfaces.map((surface) => {
    const data = { pipelineComplete: true, synthetic: '仅供评分算术的占位' };
    return { id: `p${i}-${surface}`, checkpoint: p.id, surface, sha256: digest(data), data };
  })), reviews: [] };
const draft = (): ReviewDraft => ({ packetHash: digest(reviewPacket(receipt, c)), method: '纯合成夹具，不是真实审核',
  assessments: checkpoints(c).flatMap((p) => p.checks.map((check) => ({ check: `${p.id}/${check.id}`, result: 'pass' as const,
    reason: '算术夹具占位，不代表实际语义正确', evidence: receipt.artifacts.filter((a) => a.checkpoint === p.id && check.surfaces.includes(a.surface))
      .map((a) => ({ artifact: a.id, pointer: '/synthetic' })) }))) });

test('审核草稿绑定精确材料且不得自报审核者、丢失断言或跨检查点借证据', () => {
  const valid = buildReview(receipt, c, draft(), 'agent', null); assert.deepEqual(verifyReview(valid, receipt, c), valid);
  for (const change of [
    (d: any) => { d.packetHash = 'f'.repeat(64); },
    (d: any) => { d.assessments.pop(); },
    (d: any) => { d.assessments[1] = d.assessments[0]; },
    (d: any) => { d.assessments[0].reviewer = 'human'; },
    (d: any) => { d.assessments[0].evidence = []; },
    (d: any) => { d.assessments[0].evidence[0].pointer = '/missing'; },
    (d: any) => { d.assessments[0].evidence[0].artifact = receipt.artifacts.find((a) => a.checkpoint !== receipt.artifacts[0].checkpoint)!.id; },
  ]) { const changed = draft(); change(changed); assert.throws(() => buildReview(receipt, c, changed, 'agent', null)); }
  const altered = structuredClone(receipt); altered.artifacts[0].data = { altered: true }; altered.artifacts[0].sha256 = digest(altered.artifacts[0].data);
  assert.throws(() => verifyReview(valid, altered, c));
});

test('纯模型审核不会成为通过证据，未评项不从前版继承', () => {
  const model = buildReview(receipt, c, draft(), 'model', null);
  const scored = scoreSuite(suite, digest(plan), (id, n) => id === c.id && n === 1 ? { ...receipt, reviews: model.reviews } : undefined);
  assert.equal(scored.semanticGate, false); assert.equal(Object.values(scored.total).reduce((n, x) => n + x.pass, 0), 0);
  const changed = draft(); changed.assessments[0] = { ...changed.assessments[0], result: 'unassessed', reason: '未核查', evidence: [] };
  const next = buildReview(receipt, c, changed, 'agent', digest(model));
  assert.equal(next.reviews[0].result, 'unassessed'); assert.equal(next.reviews.length, model.reviews.length);
  const forged = structuredClone(model); forged.reviews[0].reviewer = 'agent'; assert.throws(() => verifyReview(forged, receipt, c));
});

test('审核修订只增保存并验证完整前链，显式清单不可重复或改绑定', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-review-chain-'));
  try {
    const first = buildReview(receipt, c, draft(), 'agent', null), hash = saveReview(root, first);
    const original = fs.readFileSync(path.join(root, 'reviews', `${hash}.json`), 'utf8');
    const changed = draft(); changed.method = '第二次独立核查的合成夹具';
    const second = buildReview(receipt, c, changed, 'agent', hash), next = saveReview(root, second);
    assert.deepEqual(loadReview(root, next, receipt, c), second);
    assert.equal(fs.readFileSync(path.join(root, 'reviews', `${hash}.json`), 'utf8'), original);
    assert.throws(() => saveReview(root, first), /EEXIST/);
    const selection = { schema: 'quetzal-m2-review-selection-v1', suiteHash: digest(suite), planHash: digest(plan),
      entries: [{ caseId: c.id, repeat: 1, reviewHash: next }] };
    assert.deepEqual(validateSelection(selection, suite, plan), selection);
    assert.throws(() => validateSelection({ ...selection, entries: [...selection.entries, ...selection.entries] }, suite, plan));
    assert.throws(() => validateSelection({ ...selection, planHash: 'f'.repeat(64) }, suite, plan));
    fs.writeFileSync(path.join(root, 'reviews', `${hash}.json`), JSON.stringify({ ...first, method: '被改写' }));
    assert.throws(() => loadReview(root, next, receipt, c), /review-binding/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

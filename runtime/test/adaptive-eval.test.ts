// 以下评分回执全部是测试代码构造的算术夹具，不是真实模型、人工评审或正式留出成绩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makePlan } from '../tool/adaptive-eval/plan.ts';
import { buildSuite } from '../tool/adaptive-eval/cases.ts';
import { digest, releasedActions, validateSuite, type Case, type Surface, type Suite } from '../tool/adaptive-eval/spec.ts';
import { scoreSuite, scoreSequenceSuite, evidenceRequirements, checkpoints, type Receipt, type Artifact } from '../tool/adaptive-eval/score.ts';
import { reviewPacket, buildReview, verifyReview, saveReview, loadReview } from '../tool/adaptive-eval/review.ts';

const suite = buildSuite(), planHash = 'a'.repeat(64);
const fixture = (c: Case, repeat: number, input: Suite = suite): Receipt => {
  const points = checkpoints(c), surfaces: Surface[] = ['records', 'material', 'answer', 'sources', 'events'];
  const artifacts = points.flatMap((p, i) => surfaces.map((surface): Artifact => {
    const data = { pipelineComplete: true, text: '仅供评分器算术测试的合成占位，不能当成语义事实' };
    return { id: `p${i}-${surface}`, checkpoint: p.id, surface, data, sha256: digest(data) };
  }));
  return { schema: 'quetzal-m2-receipt-v1', suiteHash: digest(input), planHash, caseId: c.id, repeat, kind: 'live', status: 'complete', artifacts,
    reviews: points.flatMap((p) => p.checks.map((check) => ({ check: `${p.id}/${check.id}`, result: 'pass', reviewer: 'agent', reason: '合成回执，仅验证评分算术',
      evidence: artifacts.filter((a) => evidenceRequirements(p.id, check).some((e) => e.checkpoint === a.checkpoint && e.surfaces.includes(a.surface)))
        .map((a) => ({ artifact: a.id, pointer: '/text' })) }))) };
};
const receipts = new Map(suite.cases.flatMap((c) => [1, 2, 3].map((r) => [`${c.id}/${r}`, fixture(c, r)] as const)));
const load = (id: string, repeat: number) => structuredClone(receipts.get(`${id}/${repeat}`)!);

// v2 仅增加算术断言，不写出新题库，也不代表正式的第二次复用材料已登记或执行。
const v2: Suite = structuredClone(suite); v2.schema = 'quetzal-m5-eval-v2'; v2.id = 'synthetic-sequence-arithmetic';
for (const c of v2.cases) {
  const last = c.tracks.at(-1)!.steps.at(-1)!;
  last.checks.push(
    { id: 'first', metric: 'correction', requirement: '合成首次复用检查', sources: [last.id], surfaces: ['answer'], report: 'first-reuse' },
    { id: 'second', metric: 'correction', requirement: '合成再次复用检查', sources: [last.id], surfaces: ['answer'], report: 'second-reuse' },
    { id: 'access', metric: 'invariant', requirement: '合成具体跨 agent 访问检查', sources: [last.id], surfaces: ['sources'], hardBoundary: 'agent-access' });
  const points = c.tracks.map((t) => `${t.id}/${t.steps.at(-1)!.id}`);
  last.checks.push({ id: 'sequence', metric: 'sequence', requirement: '合成整段任务审核，跨轨合一票', sources: [], surfaces: ['records', 'answer'],
    evidenceAt: points.map((checkpoint) => ({ checkpoint, surfaces: ['records', 'answer'] })), required: [`${points.at(-1)!}/second`] });
}
const v2Receipts = new Map(v2.cases.flatMap((c) => [1, 2, 3].map((n) => [`${c.id}/${n}`, fixture(c, n, v2)] as const)));
const loadV2 = (id: string, repeat: number) => structuredClone(v2Receipts.get(`${id}/${repeat}`)!);
const reviewNamed = (r: Receipt, name: string) => r.reviews.find((a) => a.check.endsWith(`/${name}`))!;

test('v2 固定150票、多轨不增票；143及各族14通过，失败/未评不移分母', () => {
  validateSuite(v2);
  assert.throws(() => scoreSuite(v2, planHash, loadV2));
  assert.throws(() => scoreSequenceSuite(suite, planHash, load));
  const complete = scoreSequenceSuite(v2, planHash, loadV2);
  assert.deepEqual(complete.sequences, { expected: 150, pass: 150, fail: 0, unassessed: 0 });
  assert.ok(Object.values(complete.byFamily).every((f) => f.sequences.expected === 15));
  const missing = new Set(v2.cases.filter((c) => c.variant === 1).slice(0, 7).map((c) => c.id));
  const score = scoreSequenceSuite(v2, planHash, (id, n) => n === 1 && missing.has(id) ? undefined : loadV2(id, n));
  assert.equal(score.sequences.pass, 143); assert.equal(score.sequences.expected, 150); assert.equal(score.qualityGate, true);
  assert.equal(score.boundaries['agent-access'].unassessed, 7);
  assert.deepEqual(score.independentEngineering, { status: 'not-evaluated' });
  missing.add(v2.cases.filter((c) => c.variant === 1)[7].id);
  assert.equal(scoreSequenceSuite(v2, planHash, (id, n) => n === 1 && missing.has(id) ? undefined : loadV2(id, n)).gates.overall, false);
  const family = scoreSequenceSuite(v2, planHash, (id, n) => id === v2.cases[0].id && n <= 2 ? undefined : loadV2(id, n));
  assert.equal(family.sequences.pass, 148); assert.equal(family.gates.everyFamily, false);
  assert.equal(score.total.correction.expected, complete.total.correction.expected);
});

test('v2 未完成、未审、缺证、stub和模型自评均不加序列票', () => {
  for (const mode of ['failed', 'interrupted', 'stub', 'model', 'unreviewed', 'evidence', 'pipeline'] as const) {
    const score = scoreSequenceSuite(v2, planHash, (id, n) => {
      const r = loadV2(id, n); if (id !== v2.cases[0].id || n !== 1) return r;
      if (mode === 'failed' || mode === 'interrupted') r.status = mode;
      if (mode === 'stub') r.kind = 'stub';
      if (mode === 'model') r.reviews.forEach((a) => a.reviewer = 'model');
      if (mode === 'unreviewed') r.reviews = [];
      if (mode === 'evidence') reviewNamed(r, 'sequence').evidence = [];
      if (mode === 'pipeline') { const a = r.artifacts.find((a) => a.surface === 'events')!; a.data = { pipelineComplete: false, text: '合成' }; a.sha256 = digest(a.data); }
      return r;
    });
    assert.equal(score.sequences.expected, 150, mode); assert.equal(score.sequences.pass, 149, mode);
  }
});

test('v2 失败序列的具体硬违规仍否决；语义分项不被整类升级成硬门', () => {
  const failed = scoreSequenceSuite(v2, planHash, (id, n) => {
    const r = loadV2(id, n); if (id === v2.cases[0].id && n === 1) { r.status = 'failed'; reviewNamed(r, 'access').result = 'fail'; } return r;
  });
  assert.equal(failed.sequences.pass, 149); assert.equal(failed.violations.length, 1); assert.equal(failed.qualityGate, true); assert.equal(failed.gates.noKnownHardViolation, false);
  const delayed = scoreSequenceSuite(v2, planHash, (id, n) => {
    const r = loadV2(id, n); if (id === v2.cases[0].id && n === 1) reviewNamed(r, 'first').result = 'fail'; return r;
  });
  assert.equal(delayed.qualityGate, true); assert.equal(delayed.breakdown['first-reuse'].fail, 1);
  assert.equal(delayed.breakdown['second-reuse'].pass, 150); assert.equal(delayed.breakdown.recurrence.expected, 0);
  const contradicted = scoreSequenceSuite(v2, planHash, (id, n) => {
    const r = loadV2(id, n); if (id === v2.cases[0].id && n === 1) {
      reviewNamed(r, 'second').result = 'fail'; reviewNamed(r, 'access').result = 'fail';
    } return r;
  });
  assert.equal(contradicted.sequences.pass, 149); assert.equal(contradicted.breakdown['second-reuse'].fail, 1);
  assert.equal(contradicted.problems[0].code, 'sequence-required-not-passed'); assert.equal(contradicted.violations.length, 1);
});

test('v2 整体无效不加票，但无关损坏不能抹去可独立核验的硬失败', () => {
  const damaged = (mutate: (r: Receipt) => void) => scoreSequenceSuite(v2, planHash, (id, n) => {
    const r = loadV2(id, n);
    if (id === v2.cases[0].id && n === 1) { reviewNamed(r, 'access').result = 'fail'; mutate(r); }
    return r;
  });
  for (const mutate of [
    (r: Receipt) => { reviewNamed(r, 'first').evidence[0].pointer = '/missing'; },
    (r: Receipt) => { r.artifacts.find((a) => a.surface === 'answer')!.sha256 = '0'.repeat(64); },
  ]) {
    const score = damaged(mutate);
    assert.equal(score.execution.invalid, 1); assert.equal(score.sequences.pass, 149); assert.equal(score.qualityGate, true);
    assert.equal(score.gates.noKnownHardViolation, false); assert.equal(score.violations.length, 1);
    assert.equal(score.boundaries['agent-access'].fail, 1);
  }
  for (const mutate of [
    (r: Receipt) => { reviewNamed(r, 'access').evidence[0].pointer = '/missing'; },
    (r: Receipt) => { const id = reviewNamed(r, 'access').evidence[0].artifact; r.artifacts.find((a) => a.id === id)!.sha256 = '0'.repeat(64); },
    (r: Receipt) => { r.planHash = '0'.repeat(64); },
    (r: Receipt) => { r.caseId = 'AM-01-H2'; },
    (r: Receipt) => { const id = reviewNamed(r, 'access').evidence[0].artifact; r.artifacts.push(structuredClone(r.artifacts.find((a) => a.id === id)!)); },
    (r: Receipt) => { r.reviews.push({ ...structuredClone(reviewNamed(r, 'access')), result: 'pass' }); },
  ]) {
    const score = damaged(mutate);
    assert.equal(score.execution.invalid, 1); assert.equal(score.sequences.pass, 149);
    assert.equal(score.violations.length, 0); assert.equal(score.boundaries['agent-access'].unassessed, 1);
  }
});

test('v2 复用审核修订链，跨点必须逐点齐证且关键再次复用不许与序列pass矛盾', () => {
  const c = v2.cases.find((c) => c.tracks.length === 2)!, withReviews = loadV2(c.id, 1);
  const original = { ...withReviews, reviews: [] }, packet = reviewPacket(original, c);
  const draft = () => ({ packetHash: digest(packet), method: '合成审核链测试', assessments: withReviews.reviews.map(({ reviewer: _reviewer, ...a }) => structuredClone(a)) });
  const revision = buildReview(original, c, draft(), 'agent', null);
  assert.deepEqual(verifyReview(revision, original, c), revision);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-v2-review-'));
  try { const hash = saveReview(root, revision); assert.deepEqual(loadReview(root, hash, original, c), revision); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
  const incomplete = draft(), sequence = incomplete.assessments.find((a) => a.check.endsWith('/sequence'))!;
  const firstPoint = c.tracks[0].id;
  sequence.evidence = sequence.evidence.filter((e) => !original.artifacts.find((a) => a.id === e.artifact)!.checkpoint.startsWith(`${firstPoint}/`));
  assert.throws(() => buildReview(original, c, incomplete, 'agent', null), /review-evidence-missing/);
  const wrong = draft(); wrong.assessments.find((a) => a.check.endsWith('/second'))!.result = 'fail';
  assert.throws(() => buildReview(original, c, wrong, 'agent', null), /review-binding/);
  wrong.assessments.find((a) => a.check.endsWith('/sequence'))!.result = 'unassessed';
  assert.doesNotThrow(() => buildReview(original, c, wrong, 'agent', null));
  for (const refs of [['missing/S1/check'], ['main/S1/sequence'], []]) {
    const changed = structuredClone(v2); changed.cases[0].tracks.at(-1)!.steps.at(-1)!.checks.at(-1)!.required = refs;
    assert.throws(() => validateSuite(changed));
  }
  const changed = structuredClone(v2), last = changed.cases[0].tracks.at(-1)!.steps.at(-1)!.checks.at(-1)!;
  last.required!.push(last.required![0]); assert.throws(() => validateSuite(changed));
  const old = structuredClone(suite); old.cases[0].tracks[0].steps[0].checks[0].report = 'first-reuse';
  assert.throws(() => validateSuite(old));
});

test('冻结50变体/150序列；独立对照轨迹、逐步释放与摘要一致，未调用模型', () => {
  const bytes = fs.readFileSync(new URL('../tool/adaptive-eval/holdout-v1.json', import.meta.url));
  const frozen = JSON.parse(bytes.toString('utf8')), manifest = JSON.parse(fs.readFileSync(new URL('../tool/adaptive-eval/manifest-v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(frozen, suite); assert.equal(suite.cases.length, 50); assert.equal(suite.repeats, 3);
  assert.equal(manifest.suiteHash, digest(suite)); assert.equal(manifest.fileSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(manifest.caseHashes, suite.cases.map((c) => ({ id: c.id, sha256: digest(c) })));
  const visible = releasedActions(suite, 'AM-01-H1', 'main', 'S3');
  assert.equal(visible.length, 3); assert.ok(!JSON.stringify(visible).includes(suite.cases[0].tracks[0].steps[3].text));
  assert.ok(visible.every((s) => !('checks' in s) && !('query' in s)));
  visible[0].text = '独立副本'; assert.notEqual(suite.cases[0].tracks[0].steps[0].text, visible[0].text);
  assert.equal(suite.cases.filter((c) => ['AM-03', 'AM-10'].includes(c.family)).every((c) => c.tracks.length === 2), true);
});

test('数据拒绝未来出处、额外答案字段、缺族/重复变体和无效日期', () => {
  for (const mutate of [
    (s: any) => s.cases[0].tracks[0].steps[0].checks[0].sources.push('S4'),
    (s: any) => s.cases[0].tracks[0].steps[0].expectedAnswer = '不得出站',
    (s: any) => s.cases[1] = s.cases[0],
    (s: any) => s.cases.pop(),
    (s: any) => s.cases[0].tracks[0].steps[0].at = '2026-02-30T12:00:00Z',
  ]) { const copy = structuredClone(suite); mutate(copy); assert.throws(() => validateSuite(copy)); }
});

test('完整合成审核的评分算术；零容忍错误不被平均分掩盖', () => {
  const result = scoreSuite(suite, planHash, load); assert.equal(result.semanticGate, true); assert.equal(result.execution.complete, 150);
  const failed = scoreSuite(suite, planHash, (id, n) => { const r = load(id, n); if (id === 'AM-01-H1' && n === 1) r.reviews[0].result = 'fail'; return r; });
  assert.equal(failed.total.invariant.fail, 1); assert.equal(failed.semanticGate, false);
});

test('分母来自冻结检查点，缺失回执或审核、假模型和纯模型自评不能记为安全通过', () => {
  const baseline = scoreSuite(suite, planHash, load);
  for (const mode of ['missing', 'stub', 'unreviewed', 'model'] as const) {
    const result = scoreSuite(suite, planHash, (id, n) => {
      const r = load(id, n); if (id !== 'AM-01-H1' || n !== 1) return r;
      if (mode === 'missing') return undefined;
      if (mode === 'stub') r.kind = 'stub';
      if (mode === 'unreviewed') r.reviews = [];
      if (mode === 'model') for (const a of r.reviews) a.reviewer = 'model';
      return r;
    });
    assert.equal(result.total.invariant.expected, baseline.total.invariant.expected);
    assert.ok(result.total.invariant.unassessed > 0); assert.equal(result.semanticGate, false);
  }
});

test('整体明确绑定仍超过95%时，单族不足90%也不能通过', () => {
  let changed = 0;
  const result = scoreSuite(suite, planHash, (id, n) => {
    const r = load(id, n); if (id.startsWith('AM-02') && changed++ < 5) r.reviews.find((a) => a.check.endsWith('/nickname'))!.result = 'fail'; return r;
  });
  assert.ok(result.total.binding.pass / result.total.binding.expected >= 0.95);
  assert.ok(result.byFamily['AM-02'].binding.pass / result.byFamily['AM-02'].binding.expected < 0.90);
  assert.equal(result.gates.positive, false); assert.equal(result.semanticGate, false);
});

test('拒绝错误计划/重复次数、篡改材料、虚构或未来证据定位、重复评分', () => {
  for (const mutate of [
    (r: Receipt) => r.planHash = 'b'.repeat(64), (r: Receipt) => r.repeat = 2,
    (r: Receipt) => r.artifacts[0].data = '被改写',
    (r: Receipt) => r.reviews[0].evidence[0].pointer = '/不存在',
    (r: Receipt) => r.reviews[0].evidence[0].pointer = '/__proto__',
    (r: Receipt) => r.reviews[0].evidence[0].artifact = r.artifacts.at(-1)!.id,
    (r: Receipt) => r.reviews.push(r.reviews[0]),
  ]) {
    const result = scoreSuite(suite, planHash, (id, n) => { const r = load(id, n); if (id === 'AM-01-H1' && n === 1) mutate(r); return r; });
    assert.equal(result.execution.invalid, 1); assert.equal(result.semanticGate, false);
  }
});

test('完整运行还需每检查点五种材料与事件回执；失败运行仍计入所有断言分母', () => {
  const failed = scoreSuite(suite, planHash, (id, n) => { const r = load(id, n); if (id === 'AM-01-H1' && n === 1) r.status = 'failed'; return r; });
  assert.equal(failed.execution.complete, 149); assert.equal(failed.execution.failed, 1);
  const incomplete = scoreSuite(suite, planHash, (id, n) => { const r = load(id, n); if (id === 'AM-01-H1' && n === 1) {
    const a = r.artifacts.find((a) => a.surface === 'events')!; a.data = { pipelineComplete: false, text: '合成失败回执' }; a.sha256 = digest(a.data);
  } return r; });
  assert.equal(incomplete.execution.complete, 149); assert.equal(incomplete.execution.invalid, 1);
  assert.equal(incomplete.total.binding.expected, failed.total.binding.expected);
  assert.equal(incomplete.semanticGate, false);
});

test('实际只读入口校验冻结数据，空结果保持150组分母并非零退出，不创建回执', () => {
  const cli = fileURLToPath(new URL('../tool/adaptive-eval/cli.ts', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], { encoding: 'utf8', timeout: 10000 });
  const checked = run(['--check']); assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).checks, 800);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-eval-cli-test-'));
  try {
    const entries = [{ file: 'runtime/src/synthetic-test-fixture.ts', sha256: '0'.repeat(64) }];
    const code = { revision: '0'.repeat(40), code: entries, codeHash: digest(entries) };
    fs.writeFileSync(path.join(root, 'code.json'), JSON.stringify(code));
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(makePlan(suite, code, 'live')));
    const scored = run(['--score', root]); assert.equal(scored.status, 1, scored.stderr);
    const result = JSON.parse(scored.stdout);
    assert.equal(result.execution.expected, 150); assert.equal(result.execution.missing, 150);
    assert.equal(result.semanticGate, false); assert.equal(result.total.invariant.pass, 0);
    assert.equal(Object.values(result.total).reduce((n, value: any) => n + value.expected, 0), 2400);
    assert.deepEqual(fs.readdirSync(root).sort(), ['code.json', 'plan.json']);
    const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json'), 'utf8')); plan.suiteHash = 'b'.repeat(64);
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const wrong = run(['--score', root]); assert.notEqual(wrong.status, 0); assert.equal(wrong.stdout, '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

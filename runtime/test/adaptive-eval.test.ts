// 以下评分回执全部是测试代码构造的算术夹具，不是真实模型、人工评审或正式留出成绩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSuite } from '../tool/adaptive-eval/cases.ts';
import { digest, releasedActions, validateSuite, type Case, type Surface } from '../tool/adaptive-eval/spec.ts';
import { scoreSuite, checkpoints, type Receipt, type Artifact } from '../tool/adaptive-eval/score.ts';

const suite = buildSuite(), planHash = 'a'.repeat(64);
const fixture = (c: Case, repeat: number): Receipt => {
  const points = checkpoints(c), surfaces: Surface[] = ['records', 'material', 'answer', 'sources', 'events'];
  const artifacts = points.flatMap((p, i) => surfaces.map((surface): Artifact => {
    const data = { pipelineComplete: true, text: '仅供评分器算术测试的合成占位，不能当成语义事实' };
    return { id: `p${i}-${surface}`, checkpoint: p.id, surface, data, sha256: digest(data) };
  }));
  return { schema: 'quetzal-m2-receipt-v1', suiteHash: digest(suite), planHash, caseId: c.id, repeat, kind: 'live', status: 'complete', artifacts,
    reviews: points.flatMap((p) => p.checks.map((check) => ({ check: `${p.id}/${check.id}`, result: 'pass', reviewer: 'agent', reason: '合成回执，仅验证评分算术',
      evidence: artifacts.filter((a) => a.checkpoint === p.id && check.surfaces.includes(a.surface)).map((a) => ({ artifact: a.id, pointer: '/text' })) }))) };
};
const receipts = new Map(suite.cases.flatMap((c) => [1, 2, 3].map((r) => [`${c.id}/${r}`, fixture(c, r)] as const)));
const load = (id: string, repeat: number) => structuredClone(receipts.get(`${id}/${repeat}`)!);

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
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify({ schema: 'quetzal-m2-plan-v1', suiteHash: digest(suite),
      processorRevision: '0'.repeat(40), configuration: { syntheticUnitFixture: true } }));
    const scored = run(['--score', root]); assert.equal(scored.status, 1, scored.stderr);
    const result = JSON.parse(scored.stdout);
    assert.equal(result.execution.expected, 150); assert.equal(result.execution.missing, 150);
    assert.equal(result.semanticGate, false); assert.equal(result.total.invariant.pass, 0);
    assert.equal(Object.values(result.total).reduce((n, value: any) => n + value.expected, 0), 2400);
    assert.deepEqual(fs.readdirSync(root), ['plan.json']);
    const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json'), 'utf8')); plan.suiteHash = 'b'.repeat(64);
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const wrong = run(['--score', root]); assert.notEqual(wrong.status, 0); assert.equal(wrong.stdout, '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

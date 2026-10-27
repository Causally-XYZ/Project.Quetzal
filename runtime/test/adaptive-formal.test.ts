// 公开合成工程输入与占位代码清单；不运行正式留出的模型，也不写语义通过结论。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSuite, makePlan, verifyPlan, readEvidence, saveNew } from '../tool/adaptive-eval/plan.ts';
import { collectReceipt, inputTrack } from '../tool/adaptive-eval/receipt.ts';
import { runTrack } from '../tool/adaptive-eval/run-track.ts';
import { digest, type Case } from '../tool/adaptive-eval/spec.ts';
import { scoreSuite } from '../tool/adaptive-eval/score.ts';

const entries = [{ file: 'runtime/src/synthetic-fixture.ts', sha256: '1'.repeat(64) }];
const code = { revision: '0'.repeat(40), codeHash: digest(entries), code: entries };
test('完整执行计划固定配置、代码和运行环境，缺字段或漂移不能继续', () => {
  const suite = loadSuite(), plan = makePlan(suite, code, 'live'); assert.deepEqual(verifyPlan(plan, suite, code), plan);
  for (const change of [
    (p: any) => { p.configuration.routes.main = ['gemini-4-argon']; },
    (p: any) => { delete p.configuration.provider; },
    (p: any) => { p.configuration.budgets.maxCallsPerBody++; },
    (p: any) => { p.configuration.retrieval = 'lexical-only'; },
    (p: any) => { p.configuration.prompt.schemaHash = 'f'.repeat(64); },
    (p: any) => { p.configuration.runtime.node = '0.0.1'; },
    (p: any) => { p.codeHash = 'f'.repeat(64); },
    (p: any) => { p.extra = true; },
  ]) { const copy = structuredClone(plan); change(copy); assert.throws(() => verifyPlan(copy, suite, code)); }
  assert.throws(() => verifyPlan(plan, suite, { ...code, codeHash: 'f'.repeat(64) }));
  const historic = structuredClone(plan); historic.configuration.runtime.node = '22.0.0';
  assert.deepEqual(verifyPlan(historic, suite, code, false), historic, '只读评分可在不同 Node 上核对既有计划');
});

test('证据读取拒绝路径逃逸与超限，新文件禁止覆盖', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-formal-path-'));
  try {
    fs.mkdirSync(path.join(root, 'inside')); saveNew(path.join(root, 'outside.json'), { private: true });
    fs.symlinkSync(path.join(root, 'outside.json'), path.join(root, 'inside', 'link.json'));
    assert.throws(() => readEvidence(path.join(root, 'inside'), 'link.json'));
    assert.throws(() => readEvidence(path.join(root, 'inside'), '../outside.json'));
    assert.throws(() => readEvidence(root, 'outside.json', 1));
    assert.throws(() => saveNew(path.join(root, 'outside.json'), { overwritten: true }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('两条独立真实身体轨迹导出完整材料但未审核；损坏或缺失完成证据不能误计成功', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-formal-evidence-'));
  const c: Case = { id: 'AM-03-H1', family: 'AM-03', variant: 1, tracks: ['blue', 'purple'].map((name, i) => ({
    id: name, setup: 'empty', steps: [{ id: 'S1', at: '2026-05-10T12:00:00Z', body: 'B', speaker: 'owner', role: 'user', scope: 'accessible',
      text: i ? '公开隔离样例：紫色灯塔有人画画。' : '公开隔离样例：蓝色船屋有人修钟。', query: i ? '紫色灯塔有什么？' : '蓝色船屋有什么？',
      checks: [{ id: 'source', metric: 'requiredFields', requirement: '仅用于测试证据导出，不评判语义。', sources: ['S1'], surfaces: ['records', 'material', 'answer', 'sources', 'events'] }] }],
  })) };
  const suite = loadSuite(); suite.cases[suite.cases.findIndex((x) => x.id === c.id)] = c;
  const plan = makePlan(suite, code, 'stub');
  try {
    for (const track of c.tracks) {
      const input = inputTrack(track); assert.ok(!JSON.stringify(input).includes('仅用于测试证据导出'));
      const result = await runTrack({ root: path.join(root, track.id), track: input, kind: 'stub', model: 'gemini-3.8-flash', fullEvidence: true });
      assert.equal(result.status, 'pipeline-completed-needs-review');
    }
    const receipt = collectReceipt(root, c, 1, plan);
    assert.equal(receipt.status, 'complete'); assert.equal(receipt.kind, 'stub'); assert.equal(receipt.artifacts.length, 10); assert.deepEqual(receipt.reviews, []);
    assert.ok(receipt.artifacts.every((a) => a.sha256 === digest(a.data)));
    for (const a of receipt.artifacts.filter((a) => a.surface === 'material'))
      assert.ok((a.data as any).requests.every((r: any) => ['center', 'satellite'].includes(r.body)), '调用编号须与身体一起定位');
    const scored = scoreSuite(suite, digest(plan), (id, n) => id === c.id && n === 1 ? receipt : undefined);
    assert.equal(scored.execution.stub, 1); assert.equal(scored.execution.invalid, 0); assert.equal(scored.semanticGate, false);
    assert.ok(!JSON.stringify(receipt.artifacts.filter((a) => a.checkpoint.startsWith('purple/'))).includes(c.tracks[0].steps[0].text), '独立轨迹不得共享上一条记忆');
    for (const a of receipt.artifacts.filter((a) => a.surface === 'records')) assert.ok((a.data as any).history.length && Object.keys((a.data as any).evidence).length);
    const file = path.join(root, 'purple', 'result.json'), original = fs.readFileSync(file, 'utf8'), result = JSON.parse(original);
    // 从已保存结果构造损坏夹具，只测导出拒绝；不是实际执行或正式成绩。
    result.checkpoints[0].sha256 = 'f'.repeat(64); fs.writeFileSync(file, JSON.stringify(result));
    assert.throws(() => collectReceipt(root, c, 1, plan), /摘要/);
    result.checkpoints = []; fs.writeFileSync(file, JSON.stringify(result)); assert.throws(() => collectReceipt(root, c, 1, plan), /不完整/);
    result.status = 'failed'; fs.writeFileSync(file, JSON.stringify(result));
    const failure = collectReceipt(root, c, 1, plan); assert.equal(failure.status, 'failed'); assert.equal(failure.artifacts.length, 6);
    assert.equal((failure.artifacts.at(-1)!.data as any).pipelineComplete, false);
    assert.equal((failure.artifacts.at(-1)!.data as any).terminal.length, 2, '失败材料仍链接两个最终身体快照与调用');
    assert.deepEqual(failure.reviews, []);
    fs.writeFileSync(file, original);
    assert.throws(() => collectReceipt(root, c, 0, plan));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

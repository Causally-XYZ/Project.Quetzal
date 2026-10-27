// 真实独立进程/WebRTC/本地Git/网关，只有模型与信令目录为替身；不产生正式语义成绩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTrack, type InputTrack } from '../tool/adaptive-eval/run-track.ts';

const input: InputTrack = { id: 'development', setup: 'empty', steps: [
  { id: 'S1', at: '2026-01-10T12:00:00Z', body: 'B', role: 'user', scope: 'accessible', speaker: 'owner',
    text: '公开工程样例：蓝色船屋有人修旧钟。', query: '蓝色船屋里有什么？请简短回答。' },
  { id: 'S2', at: '2026-06-10T12:00:00Z', body: 'A', role: 'user', scope: 'accessible', speaker: 'owner',
    text: '后来采风还看到了紫色灯塔。', query: '前面两次采风分别提到了什么？' },
] };
test('评测执行链逐步释放并经真实网关回答，记录复制/自动发布/材料且结束全部身体', { timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-eval-runner-test-'));
  try {
    const root = path.join(tmp, 'track'), result = await runTrack({ root, track: input, kind: 'stub', model: 'gemini-3.8-flash', stepTimeoutMs: 30000 });
    assert.equal(result.status, 'pipeline-completed-needs-review', JSON.stringify(result));
    assert.equal(result.kind, 'stub'); assert.equal(result.checkpoints.length, 2);
    assert.notEqual(result.bodies[0].pid, result.bodies[1].pid); assert.notEqual(result.bodies[0].port, result.bodies[1].port);
    const first = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint-1.json'), 'utf8'));
    assert.ok(!JSON.stringify(first).includes(input.steps[1].text), '未来内容未进入第一步资料或请求');
    for (let i = 1; i <= 2; i++) {
      const cp = JSON.parse(fs.readFileSync(path.join(root, `checkpoint-${i}.json`), 'utf8'));
      assert.deepEqual(cp.preAnswer.center.records, cp.preAnswer.satellite.records);
      assert.ok(cp.preAnswer.center.records.length >= i);
      for (const b of ['center', 'satellite']) {
        const source = cp.preAnswer[b].messages.find((m: any) => m.id === cp.source);
        assert.equal(source.ts, Date.parse(input.steps[i - 1].at)); assert.equal(source.body, i === 1 ? 'satellite' : 'center');
      }
      const consumer = i === 1 ? 'center' : 'satellite';
      const calls = cp.postAnswer[consumer].calls.filter((c: any) => c.purpose === 'conversation');
      assert.ok(calls.length); assert.ok(JSON.stringify(calls.at(-1).request).includes('蓝色船屋'));
      const proposals = cp.postAnswer.center.calls.filter((c: any) => c.purpose === 'proposal');
      assert.ok(proposals.length); assert.ok(proposals.every((c: any) => c.request.responseSchema?.properties?.records));
      assert.ok(calls.every((c: any) => !c.request.responseSchema), '普通回答不继承提案格式');
      assert.ok(cp.postAnswer.center.publications.every((p: any) => p.state === 'published'));
    }
    for (const stop of result.shutdown) { assert.equal(stop.forced, false); assert.equal(stop.exitCode, 0); assert.throws(() => process.kill(stop.pid, 0)); }
    await assert.rejects(runTrack({ root, track: input, kind: 'stub', model: 'gemini-3.8-flash' }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('未知权限/缺失图声明和预期答案不启动执行；模型失败保留证据而不推进后续步骤', { timeout: 90000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-eval-runner-failure-'));
  try {
    for (const change of [
      (t: any) => { t.steps[0].scope = 'unexpected'; },
      (t: InputTrack) => { t.setup = 'and-or-graph'; },
      (t: any) => { t.steps[0].checks = [{ requirement: '不许传入答案' }]; },
    ]) { const track = structuredClone(input); change(track); await assert.rejects(runTrack({ root: path.join(tmp, 'unsupported'), track, kind: 'stub', model: 'gemini-3.8-flash' }), /not-supported/); }
    assert.equal(fs.existsSync(path.join(tmp, 'unsupported')), false);
    const root = path.join(tmp, 'failed'), result = await runTrack({ root, track: input, kind: 'stub', model: 'gemini-3.8-flash', stubFailAt: 1, stepTimeoutMs: 15000 });
    assert.equal(result.status, 'failed'); assert.equal(result.checkpoints.length, 0);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'final-body-1.json'), 'utf8'));
    assert.equal(state.calls[0].state, 'failed'); assert.equal(state.calls[0].failure.usage, null);
    assert.ok(!JSON.stringify(state).includes(input.steps[1].text));
    assert.ok(fs.existsSync(path.join(root, 'center/eval-calls/1-end.json')));
    assert.ok(result.shutdown.every((s: any) => !s.forced && s.exitCode === 0));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('受控 AND/OR 图经真实存档撤回、自动传播和对端查询，保留独立依据与审计版本', { timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-eval-controlled-test-'));
  const track: InputTrack = { id: 'graph-development', setup: 'and-or-graph', steps: [
    { ...input.steps[0], text: '合成证据实验：K 表示渡口恢复通航，支持组 G1 同时需要 A 与 B，独立组 G2 只需 C；另有独立结论 L。A、B、C 都存在。循环 K→A 不提供新独立证据。', query: '当前 K 和 L 有哪些依据？' },
    { ...input.steps[1], text: '撤回依据 A。B、C 和独立结论 L 没有变化。', query: '撤回 A 后 K 和 L 有哪些依据？', operation: { type: 'withdraw-premise', target: 'A' } },
    { ...input.steps[0], id: 'S3', at: '2026-07-10T12:00:00Z', text: '再撤回依据 C。没有新的依据，也没有修改 L。', query: '现在 K 和 L 还有哪些依据？', operation: { type: 'withdraw-premise', target: 'C' } },
  ] };
  try {
    for (const change of [
      (t: InputTrack) => { t.steps[1].operation!.target = 'C'; },
      (t: InputTrack) => { delete t.steps[2].operation; },
      (t: InputTrack) => { t.steps[0].role = 'assistant-summary'; },
      (t: InputTrack) => { t.steps[1].scope = 'denied'; },
    ]) { const invalid = structuredClone(track); change(invalid);
      await assert.rejects(runTrack({ root: path.join(tmp, 'unsupported'), track: invalid, kind: 'stub', model: 'gemini-3.8-flash' }), /not-supported/); }
    assert.equal(fs.existsSync(path.join(tmp, 'unsupported')), false);
    const root = path.join(tmp, 'track'), result = await runTrack({ root, track, kind: 'stub', model: 'gemini-3.8-flash', stepTimeoutMs: 30000, stubReviewDelayMs: 1500 });
    assert.equal(result.status, 'pipeline-completed-needs-review', JSON.stringify(result));
    assert.equal(result.checkpoints.length, 3);
    const points = [1, 2, 3].map((i) => JSON.parse(fs.readFileSync(path.join(root, `checkpoint-${i}.json`), 'utf8')));
    const initial = points[0].preAnswer.center.controlled;
    for (const [i, cp] of points.entries()) {
      const graph = cp.preAnswer.center.controlled, after = cp.postAnswer.center.controlled;
      assert.equal(cp.control.modelGenerated, false);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, `controlled-${i + 1}.json`), 'utf8')), cp.control);
      assert.deepEqual(cp.preAnswer.center.records, cp.preAnswer.satellite.records);
      assert.deepEqual(cp.postAnswer.center.records, cp.postAnswer.satellite.records);
      for (const snapshot of [graph, after]) {
        assert.deepEqual(snapshot.L, initial.L, '独立 L 的完整记录、历史和依据不变');
        assert.deepEqual(snapshot.B, initial.B, 'B 不随撤回改变');
        assert.equal(snapshot.K.evidence.status, i < 2 ? 'supported' : 'unsupported');
        assert.deepEqual([...snapshot.K.evidence.groups].sort(), i === 0 ? ['G1', 'G2'] : i === 1 ? ['G2'] : []);
        assert.equal(snapshot.K.evidence.roots.length, i < 2 ? 1 : 0, '循环不增加独立来源');
        assert.equal(snapshot.A.evidence.status, i === 0 ? 'supported' : 'withdrawn');
        assert.equal(snapshot.C.evidence.status, i < 2 ? 'supported' : 'withdrawn');
      }
      assert.equal(cp.reading.status, 'ready');
      assert.equal(cp.reading.items.some((r: any) => r.id === graph.K.id), i < 2);
      assert.ok(cp.reading.items.some((r: any) => r.id === graph.L.id), '不能靠全部返回空通过');
      const selectedK = cp.reading.items.find((r: any) => r.id === graph.K.id);
      if (selectedK) assert.deepEqual(selectedK.supports.map((g: any) => g.id).sort(), i === 0 ? ['G1', 'G2'] : ['G2']);
      const selectedIds: string[] = cp.plan.selectedIds;
      assert.equal(selectedIds.some((id) => id.startsWith(`memory:adaptive-semantic:${graph.K.id}:`)), i < 2);
      assert.ok(selectedIds.includes(`memory:adaptive-semantic:${graph.L.id}:1`));
      const answering = cp.postAnswer[cp.answerBody === 'A' ? 'center' : 'satellite'];
      const conversation = answering.calls.findLast((c: any) => c.purpose === 'conversation' && c.phase === cp.point);
      assert.ok(conversation);
      for (const item of cp.reading.items) if (selectedIds.includes(`memory:adaptive-semantic:${item.id}:${item.revision}`))
        assert.ok(conversation.request.messages.some((m: any) => m.content.includes(JSON.stringify(item))), '选中当前认识确实进入模型请求');
      for (const states of [cp.preAnswer, cp.postAnswer]) {
        assert.ok(states.center.calls.every((c: any) => c.state !== 'running'), 'idle 不代表进行中的重评已经完成');
        assert.ok(states.center.jobs.every((j: any) => !['running', 'queued'].includes(j.state)));
      }
      assert.ok(cp.preAnswer.center.receipts.some((r: any) => r.source === cp.source && r.processor === 'semantic-v1'));
      assert.ok(cp.preAnswer.center.publications.every((p: any) => p.state === 'published'));
      assert.equal(cp.preAnswer.center.held, false);
      for (const label of i === 0 ? [] : [i === 1 ? 'A' : 'C']) {
        assert.equal(graph[label].history.length, 2); assert.equal(graph[label].history[0].state, 'present');
        assert.equal(graph[label].record.state, 'withdrawn'); assert.equal(graph[label].record.revision, 2);
        assert.equal(cp.control.batch.records.length, 1); assert.equal(cp.control.batch.records[0].id, initial[label].id);
      }
    }
    assert.ok(!JSON.stringify(points[0]).includes(track.steps[1].text), '未来撤回未提前释放');
    const reviews = points[2].postAnswer.center.calls.filter((c: any) => c.purpose === 'proposal' && JSON.parse(c.request.messages.at(-1).content).review);
    assert.ok(reviews.length >= 2, '依赖变化仍触发正常后台重评');
    assert.ok(reviews.every((c: any) => JSON.parse(c.result.text).records.length === 0), '替身重评不冒充真实语义修正');
    assert.ok(result.shutdown.every((s: any) => !s.forced && s.exitCode === 0 && s.evidenceHash));
    for (const s of result.shutdown) assert.throws(() => process.kill(s.pid, 0));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('范围负例实际写入：ignored 原文排除、第三进程 agent 隔离及真实 RPC 正反对照', { timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-eval-scope-test-'));
  const sourceText = '公开开发资料：同事余晨负责 PUBLIC-MARKER 编辑工作。';
  const deniedText = '同事余晨另有 EXCLUDED-MARKER 私人计划。';
  const foreignText = '另一 agent 的余晨拥有 FOREIGN-MARKER 资料。';
  const track: InputTrack = { id: 'scope-development', setup: 'empty', steps: [
    { ...input.steps[0], id: 'S1', text: sourceText, query: '请回顾有权使用的余晨资料。' },
    { ...input.steps[1], id: 'S2', scope: 'denied', text: deniedText, query: '请回顾有权使用的余晨资料。' },
    { ...input.steps[1], id: 'S3', scope: 'other-agent', text: foreignText, query: '同名能让你读取另一个 agent 的余晨资料吗？' },
  ] };
  try {
    const root = path.join(tmp, 'track'), result = await runTrack({ root, track, kind: 'stub', model: 'gemini-3.8-flash', stepTimeoutMs: 30000 });
    assert.equal(result.status, 'pipeline-completed-needs-review', JSON.stringify(result));
    assert.equal(result.bodies.length, 3); assert.equal(new Set(result.bodies.map((b: any) => b.pid)).size, 3);
    const denied = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint-2.json'), 'utf8'));
    for (const body of ['center', 'satellite']) {
      const s = denied.postAnswer[body];
      assert.equal(s.messages.find((m: any) => m.id === denied.source)?.mode, 'ignored');
      assert.equal(s.messages.find((m: any) => m.id === denied.source)?.text, deniedText);
      assert.ok(!s.receipts.some((r: any) => r.source === denied.source));
      assert.ok(!JSON.stringify(s.calls).includes('EXCLUDED-MARKER'));
      assert.ok(!JSON.stringify(s.records).includes('EXCLUDED-MARKER'));
    }
    const foreign = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint-3.json'), 'utf8'));
    assert.equal(foreign.isolation.foreign.agent, 'isolated-evaluation');
    assert.ok(foreign.isolation.foreign.messages.some((m: any) => m.text === foreignText));
    assert.deepEqual(foreign.isolation.foreign.calls, []);
    assert.equal(foreign.isolation.probe.allowed.status, 'ready'); assert.equal(foreign.isolation.probe.allowed.agent, 'x');
    assert.equal(foreign.isolation.probe.rejected, true); assert.equal(foreign.isolation.probe.reason, 'agent-scope');
    for (const body of ['center', 'satellite']) {
      const s = foreign.postAnswer[body];
      assert.ok(!s.messages.some((m: any) => m.body === 'foreign'));
      assert.ok(!JSON.stringify(s.calls).includes('FOREIGN-MARKER'));
      assert.ok(!JSON.stringify(s.records).includes('FOREIGN-MARKER'));
      assert.ok(JSON.stringify(s.calls).includes('PUBLIC-MARKER'), '公开正例必须能进入实际材料，不能靠全部不读通过');
    }
    assert.ok(result.shutdown.every((s: any) => !s.forced && s.exitCode === 0 && s.evidenceHash));
    for (const s of result.shutdown) assert.throws(() => process.kill(s.pid, 0));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('撤回已接受后模型重评失败，保留控制存档证据且不释放下一步', { timeout: 90000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-eval-graph-failure-'));
  const track: InputTrack = { id: 'graph-failure', setup: 'and-or-graph', steps: [
    { ...input.steps[0], text: '合成规则：K 指渡口通航。G1 需要 A 与 B，G2 需要 C。A、B、C 都存在，L 独立，K→A 是循环。', query: 'K 和 L 的依据是什么？' },
    { ...input.steps[1], text: '撤回依据 A。', query: 'K 和 L 还有哪些依据？', operation: { type: 'withdraw-premise', target: 'A' } },
    { ...input.steps[0], id: 'S3', text: '随后再撤回 C，故障发生后不得提前释放这句。', query: 'K 还有哪些依据？', operation: { type: 'withdraw-premise', target: 'C' } },
  ] };
  try {
    const root = path.join(tmp, 'track'), result = await runTrack({ root, track, kind: 'stub', model: 'gemini-3.8-flash', stubFailAt: 3, stepTimeoutMs: 30000 });
    assert.equal(result.status, 'failed'); assert.equal(result.checkpoints.length, 1);
    const control = JSON.parse(fs.readFileSync(path.join(root, 'controlled-2.json'), 'utf8'));
    assert.equal(control.after.A.record.state, 'withdrawn'); assert.deepEqual(control.after.K.evidence.groups, ['G2']);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'final-body-1.json'), 'utf8'));
    assert.equal(state.controlled.A.record.state, 'withdrawn');
    const failed = state.calls.find((c: any) => c.state === 'failed');
    assert.ok(JSON.parse(failed.request.messages.at(-1).content).review, '故障应发生在真实调度的重评调用');
    assert.equal(failed.failure.usage, null);
    assert.ok(!JSON.stringify(state).includes(track.steps[2].text));
    assert.equal(fs.existsSync(path.join(root, 'controlled-3.json')), false);
    assert.ok(result.shutdown.every((s: any) => !s.forced && s.exitCode === 0 && s.evidenceHash));
    for (const s of result.shutdown) assert.throws(() => process.kill(s.pid, 0));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

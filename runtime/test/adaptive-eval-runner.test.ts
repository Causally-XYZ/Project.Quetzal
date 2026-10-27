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
      assert.ok(cp.postAnswer.center.publications.every((p: any) => p.state === 'published'));
    }
    for (const stop of result.shutdown) { assert.equal(stop.forced, false); assert.equal(stop.exitCode, 0); assert.throws(() => process.kill(stop.pid, 0)); }
    await assert.rejects(runTrack({ root, track: input, kind: 'stub', model: 'gemini-3.8-flash' }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('未知权限/受控图和预期答案不启动执行；模型失败保留证据而不推进后续步骤', { timeout: 90000 }, async () => {
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

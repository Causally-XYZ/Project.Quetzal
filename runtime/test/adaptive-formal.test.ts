// 公开合成工程输入与占位代码清单；不运行正式留出的模型，也不写语义通过结论。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSuite, makePlan, verifyPlan, readEvidence, saveNew, trackConfiguration } from '../tool/adaptive-eval/plan.ts';
import { collectReceipt, inputTrack } from '../tool/adaptive-eval/receipt.ts';
import { runTrack } from '../tool/adaptive-eval/run-track.ts';
import { digest, type Case } from '../tool/adaptive-eval/spec.ts';
import { scoreSuite } from '../tool/adaptive-eval/score.ts';
import { originalReceipt } from '../tool/adaptive-eval/review.ts';

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
  historic.configuration.prompt.schemaHash = 'f'.repeat(64);
  assert.deepEqual(verifyPlan(historic, suite, code, false), historic, '历史审核使用归档格式摘要，不用当前版本代替');
  assert.throws(() => verifyPlan(historic, suite, code));
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
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-formal-evidence-'));
  const root = path.join(parent, 'AM-03-H1', 'run-1'); fs.mkdirSync(root, { recursive: true });
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
    assert.ok(!JSON.stringify(receipt.artifacts.filter((a) => a.checkpoint.startsWith('purple/'))).includes(c.tracks[0].steps[0].text!), '独立轨迹不得共享上一条记忆');
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
    saveNew(path.join(parent, c.id, 'repeat-1.json'), receipt);
    saveNew(path.join(root, 'started.json'), { planHash: digest(plan), caseId: c.id, repeat: 1, at: Date.now() });
    saveNew(path.join(root, 'finished.json'), { status: receipt.status, receiptHash: digest(receipt), reviews: 0 });
    assert.deepEqual(originalReceipt(parent, c, 1, plan), JSON.parse(JSON.stringify(receipt)), '回执按 JSON 持久化；未定义的可选字段不参与文件比较');
    const wrongSchema = structuredClone(plan); wrongSchema.configuration.prompt.schemaHash = 'f'.repeat(64);
    assert.throws(() => collectReceipt(root, c, 1, wrongSchema), '实际提案请求必须符合归档格式摘要');
    const checkpoint = path.join(root, 'blue', 'checkpoint-1.json');
    const tampered = JSON.parse(fs.readFileSync(checkpoint, 'utf8')); tampered.answer = '改写的回答';
    fs.writeFileSync(checkpoint, JSON.stringify(tampered));
    assert.throws(() => originalReceipt(parent, c, 1, plan), '即使审核回执摘要未变，原始执行材料变化也必须拒绝');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('query-only导出核验未额外摄入、独立会话问题与回答；不能靠source:null伪装观察', { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-query-only-evidence-'));
  const source = { id: 'S1', at: '2026-05-10T12:00:00Z', body: 'B' as const, speaker: 'owner', role: 'user' as const, scope: 'accessible' as const,
    text: '公开工程样例：蓝色船屋有人修钟。', query: '船屋里有什么？', checks: [] };
  const c: Case = { id: 'AM-01-H1', family: 'AM-01', variant: 1, tracks: [{ id: 'observation', setup: 'empty', steps: [
    source, { ...source, id: 'U', text: '今天我想把寄信和擦桌子排成两行。', query: '请列成两行。' },
    ...['R1', 'R2'].map((id, i) => ({ id, at: source.at, body: i ? 'B' as const : 'A' as const, speaker: 'owner', role: 'user' as const, scope: 'accessible' as const,
      action: 'query-only' as const, query: i ? '请给船屋写一行简要记录。' : '船屋里有什么？', checks: [] })),
  ] }] };
  // 只测试输入/材料封装，不是正式v2计划、留出题目或语义成绩。
  const suite = loadSuite(); suite.schema = 'quetzal-m5-eval-v2'; suite.cases[0] = c;
  const plan = makePlan(suite, code, 'stub'), directory = path.join(root, c.tracks[0].id);
  try {
    const result = await runTrack({ root: directory, track: inputTrack(c.tracks[0]), kind: 'stub', ...trackConfiguration(plan, c.tracks[0].setup) });
    assert.equal(result.status, 'pipeline-completed-needs-review', JSON.stringify(result));
    const receipt = collectReceipt(root, c, 1, plan);
    assert.equal(receipt.status, 'complete'); assert.equal(receipt.artifacts.length, 20); assert.deepEqual(receipt.reviews, []);
    const sources = receipt.artifacts.filter((a) => a.surface === 'sources' && /\/R[12]$/.test(a.checkpoint));
    assert.equal(sources.length, 2); assert.ok(sources.every((a) => (a.data as any).source === null));
    const checkpointFile = path.join(directory, 'checkpoint-3.json'), resultFile = path.join(directory, 'result.json');
    const original = fs.readFileSync(checkpointFile, 'utf8'), originalResult = fs.readFileSync(resultFile, 'utf8');
    for (const mutate of [
      (cp: any) => { cp.source = 123; },
      (cp: any) => { cp.control = { kind: 'withdraw-claim-version' }; },
      (cp: any) => { for (const body of ['center', 'satellite']) cp.preAnswer[body].messages.push({ id: 987654, role: 'user', text: '伪造的新事实', session: 'source-3' }); },
      (cp: any) => { for (const body of ['center', 'satellite']) cp.postAnswer[body].messages.find((m: any) => m.session === 'answer-3' && m.role === 'user').text = '不是登记的问题'; },
      (cp: any) => { for (const body of ['center', 'satellite']) cp.postAnswer[body].messages.find((m: any) => m.session === 'answer-3' && m.role === 'agent').text = '不是实际回答'; },
    ]) {
      const cp = JSON.parse(original), altered = JSON.parse(originalResult); mutate(cp);
      altered.checkpoints[2].source = cp.source; altered.checkpoints[2].sha256 = digest(cp);
      fs.writeFileSync(checkpointFile, JSON.stringify(cp)); fs.writeFileSync(resultFile, JSON.stringify(altered));
      assert.throws(() => collectReceipt(root, c, 1, plan), /观察|后台尚未完成/);
    }
    fs.writeFileSync(checkpointFile, original); fs.writeFileSync(resultFile, originalResult);
    assert.deepEqual(collectReceipt(root, c, 1, plan), receipt);
    // 由实跑材料构造工具效果夹具，只验证封装允许有调用依据的摘要/交接，不冒充实跑模型使用了工具。
    const lastFile = path.join(directory, 'checkpoint-4.json'), lastOriginal = fs.readFileSync(lastFile, 'utf8');
    for (const tool of ['session_compact', 'session_new']) {
      const cp = JSON.parse(lastOriginal), altered = JSON.parse(originalResult), text = '合成的模型内部摘要或交接';
      const consumer = cp.answerBody === 'A' ? 'center' : 'satellite';
      const changedCall = cp.postAnswer[consumer].calls.findLast((call: any) => call.phase === cp.point && call.purpose === 'conversation');
      const endFile = path.join(directory, consumer, 'eval-calls', `${changedCall.id}-end.json`), endOriginal = fs.readFileSync(endFile, 'utf8');
      changedCall.result.toolCalls = [{ id: 'synthetic-tool', name: tool, args: tool === 'session_compact' ? { summary: text } : { handoff: text } }];
      for (const body of ['center', 'satellite']) {
        const messages = cp.postAnswer[body].messages, answer = messages.find((m: any) => m.session === 'answer-4' && m.role === 'agent');
        if (tool === 'session_new') answer.session = 'synthetic-new-session';
        messages.push({ ...answer, id: 987654, role: 'ambient', text, answerBasis: null });
        // v2还核对后台完成：构造相应回执，仍是变造的封装夹具，不宣称生产实际处理过这条摘要。
        for (const processor of ['semantic-v1', 'research-v1']) cp.postAnswer[body].receipts.push({ source: 987654, processor, revision: 1, completed: 1 });
      }
      altered.checkpoints[3].sha256 = digest(cp); fs.writeFileSync(lastFile, JSON.stringify(cp)); fs.writeFileSync(resultFile, JSON.stringify(altered));
      // 合成工具效果夹具须同步构造其调用原件；不能把变造结果伪装成原实跑记录。
      fs.writeFileSync(endFile, JSON.stringify(changedCall));
      assert.equal(collectReceipt(root, c, 1, plan).status, 'complete');
      cp.postAnswer[consumer].calls.findLast((call: any) => call.phase === cp.point && call.purpose === 'conversation').result.toolCalls = [];
      altered.checkpoints[3].sha256 = digest(cp); fs.writeFileSync(lastFile, JSON.stringify(cp)); fs.writeFileSync(resultFile, JSON.stringify(altered));
      fs.writeFileSync(endFile, JSON.stringify(changedCall));
      assert.throws(() => collectReceipt(root, c, 1, plan), /调用证据|关联证据/);
      fs.writeFileSync(endFile, endOriginal);
    }
    fs.writeFileSync(lastFile, lastOriginal); fs.writeFileSync(resultFile, originalResult);
    assert.ok(result.shutdown.every((s: any) => !s.forced && s.exitCode === 0));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// 只验证计划投影，不将合成标签题库当正式 v2 留出。
test('v2 计划显式绑定实际候选与轨迹例外，v1 配置和归档验证保持兼容', async () => {
  const { executionConfiguration, trackConfiguration, researchPlanSchema } = await import('../tool/adaptive-eval/plan.ts');
  const suite = loadSuite(), old = makePlan(suite, code, 'live');
  assert.equal(old.schema, 'quetzal-m2-plan-v1');
  assert.deepEqual(old.configuration, { ...executionConfiguration('live'), prompt: old.configuration.prompt });
  assert.equal(old.configuration.host.memoryLearning, false);
  assert.deepEqual(trackConfiguration(old, 'empty'), { model: 'gemini-3.8-flash', maxCalls: 36, stepTimeoutMs: 180000, fullEvidence: true });
  const synthetic = structuredClone(suite); synthetic.schema = 'quetzal-m5-eval-v2';
  const plan = makePlan(synthetic, code, 'live');
  assert.equal(plan.schema, 'quetzal-m5-plan-v2');
  assert.deepEqual(verifyPlan(plan, synthetic, code), plan);
  assert.equal(plan.configuration.provider.thinking, 'LOW');
  assert.equal(plan.configuration.host.memoryLearning, true);
  assert.equal(plan.configuration.budgets.timeoutScope, 'each-operation-and-settle;not-whole-step');
  assert.equal(plan.configuration.prompt.researchPlanSchemaHash, digest(researchPlanSchema()));
  assert.deepEqual(trackConfiguration(plan, 'empty'), { model: 'gemini-3.8-flash', maxCalls: 100, stepTimeoutMs: 300000,
    fullEvidence: true, inputMode: 'normal-converse-eligible', thinkingLevel: 'LOW', research: true, backgroundRetries: true });
  const controlled = trackConfiguration(plan, 'and-or-graph');
  assert.ok('research' in controlled); assert.equal(controlled.research, false);
  const stub = makePlan(synthetic, code, 'stub');
  assert.equal(stub.configuration.provider.thinking, 'provider-default');
  assert.equal(Object.hasOwn(trackConfiguration(stub, 'empty'), 'thinkingLevel'), false);
  assert.throws(() => verifyPlan(plan, suite, code));
  assert.throws(() => verifyPlan(old, synthetic, code));
  for (const change of [
    (p: any) => { p.configuration.host.memoryLearning = false; },
    (p: any) => { p.configuration.host.research['and-or-graph'] = true; },
    (p: any) => { p.configuration.input.mode = 'store'; },
    (p: any) => { p.configuration.provider.thinking = 'provider-default'; },
    (p: any) => { p.configuration.budgets.backgroundRetries = false; },
    (p: any) => { p.configuration.budgets.research.taskMs++; },
    (p: any) => { delete p.configuration.prompt.researchPlanSchemaHash; },
  ]) { const copy = structuredClone(plan); change(copy); assert.throws(() => verifyPlan(copy, synthetic, code)); }
  const archived = structuredClone(plan); archived.configuration.runtime.node = '22.0.0';
  archived.configuration.prompt.schemaHash = 'a'.repeat(64); archived.configuration.prompt.researchPlanSchemaHash = 'b'.repeat(64);
  assert.deepEqual(verifyPlan(archived, synthetic, code, false), archived);
  assert.throws(() => verifyPlan(archived, synthetic, code));
  if (!fs.existsSync(new URL('../tool/adaptive-eval/holdout-v2.json', import.meta.url))) assert.throws(() => loadSuite('v2'), /尚未提供/);
});

test('v2 研究 schema 副本与生产 researchNext 实际规划 prompt 一致', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { AdaptiveStore } = await import('../src/memory/adaptive-store.ts');
  const { AdaptiveArchive } = await import('../src/memory/adaptive-archive.ts');
  const { researchNext } = await import('../src/memory/adaptive-research.ts');
  const { researchPlanSchema } = await import('../tool/adaptive-eval/plan.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-plan-schema-')), soul = path.join(home, 'soul'); fs.mkdirSync(soul);
  const db = new DatabaseSync(path.join(home, 'memory.sqlite'));
  try {
    db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)');
    db.prepare('INSERT INTO messages VALUES(1,1000,?,?,?,?,NULL,NULL,NULL,NULL)').run('user', 'synthetic', '公开合成规划输入。', 'source-1');
    const queue = new AdaptiveStore(db, 'synthetic-plan'), archive = new AdaptiveArchive(queue, soul);
    queue.schedule('semantic-v1'); queue.complete(queue.claim('semantic-v1')!);
    let count = 0;
    const result = await researchNext({ queue, archive, exclusive: async (run) => run(), enabled: () => true,
      signal: new AbortController().signal, trace: () => {}, search: async () => [], generate: async (prompt) => {
        count++; assert.deepEqual(prompt.schema, researchPlanSchema());
        assert.equal(JSON.parse(prompt.user).research.purpose, 'explore');
        return { question: '', query: '' };
      } });
    assert.equal(count, 1); assert.equal(result.status, 'unchanged');
    assert.equal(queue.status('research-v1').counts.done, 1);
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('v2 回执核实际配置、研究格式、答复阶段与可证明的后台恢复，不以成功素材回复冒充答案', async () => {
  // 全部是合成回执夹具；包括 live 标签与 STOP 均为测试数据，不是实际模型执行证据。
  const { researchPlanSchema } = await import('../tool/adaptive-eval/plan.ts');
  const { sourceInputPath } = await import('../tool/adaptive-eval/spec.ts');
  const { proposalResponseSchema } = await import('../src/memory/adaptive-proposal.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-receipt-v2-synthetic-')), dir = path.join(home, 'track'); fs.mkdirSync(dir);
  const step = { id: 'S1', at: '2026-01-01T00:00:00Z', body: 'A' as const, speaker: 'owner', role: 'user' as const,
    scope: 'accessible' as const, text: '公开合成消息', query: '合成问题', checks: [] };
  const c: Case = { id: 'AM-02-H1', family: 'AM-02', variant: 1, tracks: [{ id: 'track', setup: 'empty', steps: [step] }] };
  const suite = loadSuite(); suite.schema = 'quetzal-m5-eval-v2'; const plan = makePlan(suite, code, 'live'), input = inputTrack(c.tracks[0]);
  const source = { key: 's1', role: 'user', recordedAt: step.at, text: step.text };
  const job = { id: 'synthetic-job', source: 1, revision: 1, processor: 'semantic-v1', attempts: 1 };
  const call = (id: number, purpose: string, schema?: unknown, extra: any = {}) => ({ id, phase: 'track/S1', purpose, model: 'gemini-3.8-flash', start: id,
    thinkingLevel: 'LOW', request: { messages: [{ role: 'user', content: JSON.stringify({ current: 's1', sources: [source], ...extra }) }], tools: [],
      maxTokens: purpose === 'proposal' ? 16384 : 4096, ...(schema ? { responseSchema: schema } : {}) }, state: 'returned',
    result: { text: '合成回答', toolCalls: [], model: 'gemini-3.8-flash', usage: { input: 1, output: 1 } },
    transport: [{ state: 'complete', model: 'gemini-3.8-flash', versions: ['gemini-3.8-flash'], finish: ['STOP'], thinkingLevel: 'LOW' }] });
  const failed: any = { ...call(2, 'proposal', proposalResponseSchema()), state: 'failed', backgroundJob: job,
    failure: { category: 'provider-failed', usage: null }, transport: [] }; delete failed.result;
  const success = { ...call(3, 'proposal', proposalResponseSchema()), backgroundJob: { ...job, attempts: 2 } };
  const centerCalls = [call(1, 'conversation'), failed, success, call(4, 'proposal', researchPlanSchema(), { research: { question: '', purpose: 'explore', steps: [] } })];
  const initial = [{ id: 1, ts: Date.parse(step.at), role: 'user', text: step.text, session: 'source-1', mode: null },
    { id: 2, ts: Date.parse(step.at) + 1, role: 'agent', text: '素材回复', session: 'source-1', mode: null }];
  const later = [...initial, { id: 3, ts: Date.parse(step.at) + 2, role: 'user', text: step.query, session: 'answer-1', mode: null },
    { id: 4, ts: Date.parse(step.at) + 3, role: 'agent', text: '合成回答', session: 'answer-1', mode: null }];
  const state = (calls: any[], messages: any[]) => ({ calls, messages, history: [], records: [], evidence: {},
    actualConfig: { adaptiveMemory: { enabled: true, semantic: true, research: true, hostBody: 'center' }, memorySemantic: false, memoryLearning: true, sentinel: false },
    sync: { unpushed: false }, jobs: [], backgroundJobs: [{ ...job, attempts: 2, state: 'done', error: null }], publications: [],
    receipts: messages.flatMap(m => [{ source: m.id, processor: 'semantic-v1', revision: 1 }, ...(m.role === 'user' ? [{ source: m.id, processor: 'research-v1', revision: 1 }] : [])]),
    retrievalExpected: 'fixed', status: { error: null, queue: { counts: { running: 0, queued: 0 } },
      retrieval: { state: 'ready', current: true, pending: 0, snapshot: 'fixed' },
      semantic: { state: 'research-idle', queue: { counts: { running: 0, queued: 0 } }, research: { queue: { counts: { running: 0, queued: 0 } } } } } });
  const original = { point: 'track/S1', source: 1, producer: 'A', answerBody: 'B', isolation: { policy: 'accessible' },
    preAnswer: { center: state(centerCalls, initial), satellite: state([], initial) },
    postAnswer: { center: state(centerCalls, later), satellite: state([call(1, 'conversation')], later) }, answer: '合成回答', reading: {}, plan: {} };
  const execution = { inputHash: digest(input), kind: 'live', model: 'gemini-3.8-flash', maxCallsPerBody: 100, stepTimeoutMs: 300000,
    fullEvidence: true, retrieval: plan.configuration.retrieval, disconnectStep: null, inputMode: 'normal-converse-eligible', inputPath: 'normal-converse-eligible',
    baseline: null, research: true, thinkingLevel: 'LOW', backgroundRetries: true,
    stepInputPaths: [{ id: 'S1', path: sourceInputPath(step, 'empty', 'normal-converse-eligible') }] };
  const put = (name: string, value: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  const persist = (cp: any) => {
    put('input.json', input); put('execution.json', execution); put('checkpoint-1.json', cp);
    put('result.json', { kind: 'live', status: 'pipeline-completed-needs-review', checkpoints: [{ point: cp.point, source: 1, file: 'checkpoint-1.json', sha256: digest(cp) }],
      shutdown: [{ forced: false, exitCode: 0 }, { forced: false, exitCode: 0 }] });
    for (const body of ['center', 'satellite']) { fs.mkdirSync(path.join(dir, body, 'eval-calls'), { recursive: true });
      for (const x of cp.postAnswer[body].calls) { const start: any = { ...x, state: 'running', transport: [] }; delete start.result; delete start.failure;
        put(`${body}/eval-calls/${x.id}-start.json`, start); put(`${body}/eval-calls/${x.id}-end.json`, x); }
    }
  };
  try {
    persist(original); const receipt = collectReceipt(home, c, 1, plan);
    assert.equal(receipt.status, 'complete');
    const answer: any = receipt.artifacts.find(a => a.surface === 'answer')!.data;
    assert.deepEqual(answer.calls.map((x: any) => [x.body, x.id]), [['satellite', 1]]);
    assert.equal((receipt.artifacts.find(a => a.surface === 'events')!.data as any).calls.filter((x: any) => x.state === 'failed').length, 1);
    for (const change of [
      (cp: any) => { cp.preAnswer.center.actualConfig.memoryLearning = false; },
      (cp: any) => { cp.preAnswer.center.backgroundJobs[0].attempts = 1; },
      (cp: any) => { cp.preAnswer.center.receipts = cp.preAnswer.center.receipts.filter((r: any) => r.source !== 1 || r.processor !== 'semantic-v1'); },
      (cp: any) => { for (const when of ['preAnswer', 'postAnswer']) cp[when].center.calls[3].request.responseSchema = proposalResponseSchema(); },
      (cp: any) => { for (const when of ['preAnswer', 'postAnswer']) cp[when].center.calls[3].thinkingLevel = 'HIGH'; },
      (cp: any) => { cp.postAnswer.satellite.calls[0].state = 'failed'; cp.postAnswer.satellite.calls[0].failure = { category: 'provider-failed' }; },
      (cp: any) => { cp.preAnswer.satellite.calls = structuredClone(cp.postAnswer.satellite.calls); },
      (cp: any) => { cp.postAnswer.satellite.calls[0].result.truncated = true; },
    ]) { const cp = structuredClone(original); change(cp); persist(cp); assert.throws(() => collectReceipt(home, c, 1, plan)); }
    persist(original); const end = path.join(dir, 'center/eval-calls/2-end.json'); fs.unlinkSync(end);
    assert.throws(() => collectReceipt(home, c, 1, plan), '失败尝试原件缺失不得算恢复');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('v2 输入例外链保留原角色与权限，只有可访问用户素材走普通对话', { timeout: 90000 }, async () => {
  // 公开合成开发工程轨迹；研究替身仅返回空计划，不评语义质量，不释放正式留出。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-v2-input-boundary-'));
  const c: Case = { id: 'AM-16-H1', family: 'AM-16', variant: 1, tracks: [{ id: 'input-boundaries', setup: 'empty', steps: [
    { role: 'user', scope: 'accessible', text: '公开合成资料：蓝桉工作室的活动安排在周六。', query: '工作室活动安排在哪天？' },
    { role: 'assistant-summary', scope: 'accessible', text: '助手历史摘要：有人猜想活动可能改期，但未经用户确认。', query: '历史助手猜想能当成用户已经确认的安排吗？' },
    { role: 'user', scope: 'denied', text: 'DENIED-V2-BOUNDARY-7F3 仅用于排除来源检查。', query: '请只回顾有权使用的活动安排。' },
    { role: 'user', scope: 'other-agent', text: 'FOREIGN-V2-BOUNDARY-9C2 是另一个 agent 的隔离资料。', query: '同名工作室能让你读取另一个 agent 的资料吗？' },
  ].map((s, i) => ({ ...s, role: s.role as 'user' | 'assistant-summary', scope: s.scope as 'accessible' | 'denied' | 'other-agent',
    id: `S${i + 1}`, at: `2026-0${i + 1}-01T00:00:00Z`, body: i % 2 ? 'B' : 'A', speaker: 'owner', checks: [] })) }] };
  const suite = loadSuite(); suite.schema = 'quetzal-m5-eval-v2'; const plan = makePlan(suite, code, 'stub'), track = c.tracks[0];
  const directory = path.join(home, track.id);
  try {
    const result = await runTrack({ root: directory, track: inputTrack(track), kind: 'stub', ...trackConfiguration(plan, track.setup) });
    assert.equal(result.status, 'pipeline-completed-needs-review', JSON.stringify(result));
    assert.equal(collectReceipt(home, c, 1, plan).status, 'complete');
    const execution = JSON.parse(fs.readFileSync(path.join(directory, 'execution.json'), 'utf8'));
    assert.deepEqual(execution.stepInputPaths.map((s: any) => s.path), ['normal-converse-with-synchronous-record-clock', 'agent-role-fixture', 'ignored-at-insert', 'foreign-storage-only']);
    for (let i = 0; i < 4; i++) {
      const cp = JSON.parse(fs.readFileSync(path.join(directory, `checkpoint-${i + 1}.json`), 'utf8'));
      const preCalls = [cp.preAnswer.center, cp.preAnswer.satellite].flatMap(s => s.calls.filter((x: any) => x.phase === cp.point && x.purpose === 'conversation'));
      assert.equal(preCalls.length > 0, i === 0, '仅第一条用户素材可产生输入阶段的普通回复');
      if (i === 0) assert.ok(cp.preAnswer.center.messages.some((m: any) => m.role === 'agent' && m.session === 'source-1'));
      const sources = i === 3 ? cp.isolation.foreign.messages : cp.preAnswer.center.messages;
      const source = sources.find((m: any) => m.id === cp.source);
      assert.equal(source.text, track.steps[i].text); assert.equal(source.role, i === 1 ? 'agent' : 'user');
      if (i === 2) assert.equal(source.mode, 'ignored');
      if (i === 3) { assert.equal(cp.isolation.foreign.agent, 'isolated-evaluation'); assert.deepEqual(cp.isolation.foreign.calls, []); assert.equal(cp.isolation.probe.rejected, true); }
      for (const body of [cp.postAnswer.center, cp.postAnswer.satellite]) {
        const requests = JSON.stringify(body.calls.map((x: any) => x.request));
        assert.ok(!requests.includes('DENIED-V2-BOUNDARY-7F3')); assert.ok(!requests.includes('FOREIGN-V2-BOUNDARY-9C2'));
      }
    }
    assert.ok(result.shutdown.every((s: any) => !s.forced && s.exitCode === 0));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { Msg } from "../src/providers/types.ts";
import crypto from "node:crypto";
import type { ClaimRecord, SourceSpan } from "../src/memory/adaptive-evidence.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-semantic-query-host-"));
process.env.QUETZAL_HOME = home;
const cfg = await import("../src/config.ts"); cfg.loadConfig();
cfg.saveConfig({ body: "reader", adaptiveMemory: { enabled: true, hostBody: "reader", semantic: true }, brain: { ...cfg.config.brain, memoryLearning: false, memorySemantic: false, maxOutputTokens: 256, contextWindow: 65536 } });
const store = await import("../src/store.ts"); store.openStore();
const soul = await import("../src/memory/soul-sync.ts"); await soul.ensureSoul();
const registry = await import("../src/providers/registry.ts");
const router = await import("../src/providers/router.ts");
const brain = await import("../src/mind/brain.ts");
const contextHost = await import("../src/mind/context.ts");

const { identity } = await import("../src/memory/identity.ts");


const seen: any[] = [];
let script: (request: any) => Promise<{ content?: string | null; tool_calls?: unknown[]; status?: number }> = async () => ({ content: "完成" });
const server = http.createServer((req, res) => {
  let text = "";
  req.on("data", (chunk) => { text += chunk; });
  req.on("end", () => {
    void (async () => {
      const request = JSON.parse(text); seen.push(request);
      const output = await script(request);
      if (output.status) { res.writeHead(output.status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "synthetic failure" } })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: output.content ?? null, ...(output.tool_calls ? { tool_calls: output.tool_calls } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    })().catch((error) => { res.writeHead(500); res.end(String(error instanceof Error ? error.message : "fixture failure")); });
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string");
const port = address.port;
function configure(models: { id: string; context: number; maxTokens?: number }[]) {
  registry.saveProviders({ providers: [{ id: "dynamic-provider", catalogId: "custom", name: "Synthetic", baseUrl: `http://127.0.0.1:${port}`, protocol: "openai-completions", enabled: true,
    keys: [{ id: "synthetic-key", label: "fixture", lastFour: "", enabled: true, secret: "synthetic-api-key" }],
    models: models.map((model, i) => ({ id: model.id, name: model.id, enabled: true, context: model.context, maxTokens: model.maxTokens ?? 256, sortOrder: i })) }], quickModelId: models[0]?.id }, registry.configVersion());
}
const joined = (request: any) => request.messages.map((message: any) => String(message.content ?? "")).join("\n");
after(async () => { await adaptive.stopAdaptiveMemory(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); assert.equal(cfg.config.soul.remote, ''); await soul.idle(); await soul.push('合成查询测试收尾'); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });

const { AdaptiveStore } = await import('../src/memory/adaptive-store.ts');
const { AdaptiveArchive } = await import('../src/memory/adaptive-archive.ts');
const queue = new AdaptiveStore(store.db, identity().id), archive = new AdaptiveArchive(queue, cfg.paths.soul);
function fixture(conv: string, long = false) {
  store.ensureSession(conv, '合成历史');
  const source = store.addMessage('user', '合成', '饭友是编辑。' + (long ? '待核查的旧资料。'.repeat(100) : ''), { session: conv });
  if (long) for (let i = 0; i < 12; i++) store.addMessage('user', '合成', `背景${i}：` + '待核查的旧资料。'.repeat(60), { session: conv });
  const correction = store.addMessage('user', '合成', '更正，饭友是弟弟。', { session: conv });
  queue.schedule();
  const span = (id: number): SourceSpan => { const s = queue.source(id)!; return { kind: 'source', source: id, hash: s.hash, start: 0, end: 6, quote: s.text.slice(0, 6) }; };
  const claim: ClaimRecord = { id: crypto.randomUUID(), revision: 1, kind: 'claim', state: 'present', realm: { world: 'real', context: 'real' },
    reasons: [span(source)], text: '饭友是编辑', nature: 'reported', participants: [],
    occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
    supports: [{ id: 'direct', premises: [span(source)], assumptions: [] }], counters: [] };
  function accept(record: ClaimRecord, anchor: number) {
    const processor = `history-${record.id}-${record.revision}`;
    queue.scheduleSource(processor, anchor);
    assert.equal(archive.accept(queue.claim(processor)!, [source, correction].map((id) => { const s = queue.source(id)!; return { id, revision: s.revision, hash: s.hash }; }),
      { baseGeneration: archive.generation(), records: [record] }), true);
  }
  accept(claim, source);
  return { source, correction, correct: () => accept({ ...claim, revision: 2, text: '饭友是弟弟', reasons: [span(correction)],
    supports: [{ id: 'corrected', premises: [span(correction)], assumptions: [] }] }, correction) };
}
const historyMessages = (conv: string): Msg[] => [{ role: 'system', content: '当前系统政策' }, ...brain.history(conv, Number.MAX_SAFE_INTEGER), { role: 'user', content: '当前请求只读，不允许写入' }];
const plan = (conv: string) => store.kv.get<any>(`context.plan.${conv}`, null);
const summaryRequest = (request: any) => joined(request).startsWith('压缩历史资料');


const adaptive = await import('../src/memory/adaptive.ts');
adaptive.setAdaptiveComponentPreparer(async () => false); // 此夹具不测试组件部署，不启动网络安装。
const { semanticDigest } = await import('../src/memory/adaptive-query.ts');
const { markBusy } = await import('../src/heart/heart.ts');
const { exclusive } = await import('../src/memory/memory.ts');
markBusy(true); adaptive.startAdaptiveMemory();

test('向量等待不占灵魂锁；等待中的纠正由最终快照拒绝旧候选', async () => {
  const f = fixture('vector-race');
  let keys: string[] = [];
  let action: () => Promise<void> = async () => {};
  const detach = adaptive.setAdaptiveRetriever(identity().id, {
    replace: (candidates) => { keys = candidates.filter((c) => c.item.roots.some((r) => r.id === f.source)).map((c) => c.key); },
    query: async (query) => { await action(); return { queryHash: semanticDigest(query), keys }; },
  });
  try {
    await adaptive.refreshAdaptiveRetrieval(); assert.equal(keys.length, 1);
    const before = await adaptive.queryAdaptiveSemantic('涮肉同行者');
    assert.equal(before.items.length, 1); const id = before.items[0].id;
    action = () => exclusive(() => { f.correct(); });
    const corrected = await adaptive.queryAdaptiveSemantic('涮肉同行者');
    assert.equal(corrected.status, 'ready'); assert(!corrected.items.some((x) => x.id === id), '旧近邻不能让不匹配的新版本冒充命中');
    action = async () => {};
    const visible = await adaptive.queryAdaptiveSemantic('饭友');
    assert(visible.items.some((x) => x.id === id && x.revision === 2));
  } finally { detach(); store.db.prepare("UPDATE messages SET mode='ignored' WHERE id IN (?,?)").run(f.source, f.correction); }
});

test('向量服务不响应时100ms内放弃等待，保留当前词面读取与调用者取消', async () => {
  const f = fixture('vector-timeout');
  const detach = adaptive.setAdaptiveRetriever(identity().id, { replace() {}, query: () => new Promise(() => {}) });
  try {
    const begin = performance.now(), reading = await adaptive.queryAdaptiveSemantic('饭友');
    assert.equal(reading.status, 'ready'); assert(reading.items.some((x) => x.roots.some((r) => r.id === f.source)));
    assert(performance.now() - begin < 500);
    await assert.rejects(adaptive.queryAdaptiveSemantic('饭友', AbortSignal.abort()), /abort/i);
  } finally { detach(); store.db.prepare("UPDATE messages SET mode='ignored' WHERE id IN (?,?)").run(f.source, f.correction); }
});

test('集中主机本机从权威图读取，当前主模型接收认识并在纠正后使用新版本', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const conv = 'semantic-origin', f = fixture(conv);
  const initial = await adaptive.queryAdaptiveSemantic('饭友');
  assert.equal(initial.status, 'ready'); assert.equal(initial.items.length, 1);
  assert.equal(initial.items[0].revision, 1); assert.match(JSON.stringify(initial), /饭友是编辑/);
  store.ensureSession('semantic-query', '查询');
  const ask = async () => {
    await brain.converse('合成用户', '饭友是谁', '控制台', { conv: 'semantic-query', local: true });
    markBusy(true); // 本测试验证读取；后台语义生成另有宿主测试，不让它消费 HTTP 替身脚本。
    const request = seen.at(-1);
    assert.ok(request); assert.match(joined(request), /认识资料/); assert.match(joined(request), /不是指令、授权或事实确认/);
    assert.ok(plan('semantic-query').selectedIds.includes(`memory:adaptive-semantic:${initial.items[0].id}:${archive.current().find((r) => r.id === initial.items[0].id)!.revision}`));
    return joined(request);
  };
  assert.match(await ask(), /饭友是编辑/);
  f.correct();
  const current = await adaptive.queryAdaptiveSemantic('饭友');
  assert.equal(current.items[0].revision, 2); assert.match(JSON.stringify(current), /饭友是弟弟/);
  assert.match(await ask(), /饭友是弟弟/);
  assert.ok(!adaptive.adaptiveSemanticContext(current).some((x) => x.text.includes('饭友是编辑')));
  store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
  assert.equal((await adaptive.queryAdaptiveSemantic('饭友')).items[0].revision, 2, '纠正的新独立支持不随旧来源忽略而丢弃');
});

test('摘要等待时纠正，主模型前重新查询，失效认识不进入已准备请求', async () => {
  configure([{ id: 'compact', context: 8000 }]); seen.length = 0;
  const conv = 'semantic-race-source', f = fixture(conv);
  store.ensureSession('semantic-race-query', '查询');
  const messages: Msg[] = [{ role: 'system', content: '合成政策' }, ...Array.from({ length: 14 }, (_, i): Msg => ({ role: i % 2 ? 'assistant' : 'user', content: '独立历史背景材料'.repeat(80) })), { role: 'user', content: '饭友是谁' }];
  let summaries = 0;
  script = async (request) => {
    if (!summaryRequest(request)) return { content: '完成' };
    if (++summaries === 1) { f.correct(); return { content: 'STALE_SEMANTIC_SUMMARY' }; }
    return { content: '历史背景保持未知。' };
  };
  const ctx = contextHost.createTurnContext('semantic-race-turn', 'semantic-race-query', messages);
  try {
    await router.chat(await ctx.prepare({ messages, maxTokens: 256 }));
    assert.ok(summaries >= 2);
    const main = seen.filter((r) => !summaryRequest(r)); assert.equal(main.length, 1);
    assert.ok(!joined(main[0]).includes('STALE_SEMANTIC_SUMMARY'));
    assert.ok(!joined(main[0]).includes('饭友是编辑')); assert.match(joined(main[0]), /饭友是弟弟/);
  } finally { ctx.close(); script = async () => ({ content: '完成' }); }
});

test('急停、关闭、非主机与未启动只返回空降级，取消传播且等锁超时不执行迟到读取', async () => {
  fs.writeFileSync(cfg.paths.stop, 'synthetic');
  assert.equal((await adaptive.queryAdaptiveSemantic('饭友')).status, 'stopped'); fs.rmSync(cfg.paths.stop);
  cfg.saveConfig({ adaptiveMemory: { ...cfg.config.adaptiveMemory, enabled: false } });
  assert.equal((await adaptive.queryAdaptiveSemantic('饭友')).status, 'disabled');
  cfg.saveConfig({ adaptiveMemory: { enabled: true, semantic: true, hostBody: 'remote' } });
  assert.equal((await adaptive.queryAdaptiveSemantic('饭友')).status, 'unavailable');
  cfg.saveConfig({ adaptiveMemory: { enabled: true, semantic: true, hostBody: 'reader' } });
  const c = new AbortController(); c.abort(new Error('用户取消'));
  await assert.rejects(adaptive.queryAdaptiveSemantic('饭友', c.signal), /用户取消/);
  let release!: () => void;
  const held = exclusive(() => new Promise<void>((resolve) => { release = resolve; })); await new Promise((resolve) => setImmediate(resolve));
  try { assert.equal((await adaptive.queryAdaptiveSemantic('饭友')).status, 'unavailable'); }
  finally { release(); await held; }
  assert.equal((await adaptive.queryAdaptiveSemantic('饭友')).status, 'ready');
  await adaptive.stopAdaptiveMemory();
  assert.equal((await adaptive.queryAdaptiveSemantic('饭友')).status, 'unavailable');
  adaptive.startAdaptiveMemory();
});

test('已接受结果损坏时查询降级，不使用 SQLite 中还存在的旧投影', async () => {
  const row = store.db.prepare('SELECT id,digest FROM adaptive_publications LIMIT 1').get()!;
  store.db.prepare('UPDATE adaptive_publications SET digest=? WHERE id=?').run('0'.repeat(64), row.id);
  try {
    const result = await adaptive.queryAdaptiveSemantic('饭友');
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.items, []);
  } finally { store.db.prepare('UPDATE adaptive_publications SET digest=? WHERE id=?').run(row.digest, row.id); }
});

test('中文问题经实际宿主与上下文选中英文改写，只有有效原文引文参与匹配', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0; markBusy(true);
  store.ensureSession('bilingual-origin', '合成跨语言');
  const source = store.addMessage('user', '合成', '我的编辑叫林岚。另一个话题是火山摄影。', { session: 'bilingual-origin' });
  queue.schedule(); const s = queue.source(source)!;
  const span: SourceSpan = { kind: 'source', source, hash: s.hash, start: 0, end: 7, quote: s.text.slice(0, 7) };
  const claim: ClaimRecord = { id: crypto.randomUUID(), revision: 1, kind: 'claim', state: 'present', realm: { world: 'real', context: 'real' },
    reasons: [span], text: 'The editor is Lin Lan.', nature: 'reported', participants: [], occurred: { text: '', earliest: null, latest: null },
    valid: { text: '', earliest: null, latest: null }, supports: [{ id: 'direct', premises: [span], assumptions: [] }], counters: [] };
  queue.scheduleSource('bilingual-fixture', source);
  assert.equal(archive.accept(queue.claim('bilingual-fixture')!, [{ id: source, revision: s.revision, hash: s.hash }],
    { baseGeneration: archive.generation(), records: [claim] }), true);
  const query = await adaptive.queryAdaptiveSemantic('我的编辑叫什么');
  assert.equal(query.status, 'ready'); assert.ok(query.items.some((r) => r.id === claim.id));
  assert.ok(!(await adaptive.queryAdaptiveSemantic('火山摄影')).items.some((r) => r.id === claim.id));
  await brain.converse('合成用户', '我的编辑叫什么', '控制台', { conv: 'bilingual-question', local: true }); markBusy(true);
  assert.ok(plan('bilingual-question').selectedIds.includes(`memory:adaptive-semantic:${claim.id}:1`));
  assert.match(joined(seen.at(-1)), /The editor is Lin Lan/);
  store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(source);
  assert.ok(!(await adaptive.queryAdaptiveSemantic('编辑')).items.some((r) => r.id === claim.id));
});

test('无认识命中、服务不可用和关闭时，真实对话及故障转移仍带完整证据使用规则', async () => {
  configure([{ id: 'primary', context: 131072 }, { id: 'fallback', context: 131072 }]);
  const before = { ...cfg.config.adaptiveMemory };
  script = async (request) => request.model === 'primary' ? { status: 404 } : { content: '工程替身回答，不能计为语义判断。' };
  try {
    for (const state of ['ready', 'unavailable', 'disabled']) {
      cfg.saveConfig({ adaptiveMemory: { enabled: state !== 'disabled', semantic: true, hostBody: state === 'unavailable' ? 'remote' : 'reader' } });
      markBusy(true); seen.length = 0;
      const query = 'quartzspectrometer observation', reading = await adaptive.queryAdaptiveSemantic(query);
      assert.equal(reading.status, state); assert.deepEqual(reading.items, []);
      await brain.converse('合成用户', query, '控制台', { conv: `evidence-${state}`, local: true }); markBusy(true);
      assert.deepEqual(seen.map((r) => r.model), ['primary', 'fallback']);
      for (const request of seen) {
        const policy = request.messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');
        assert.equal(policy.split('## 根据资料作判断').length - 1, 1);
        assert.match(policy, /未提及、未检索到、没有当前有效支持/);
        assert.match(policy, /来源明确否认/); assert.match(policy, /保留说话者、时间范围和推断性质/);
        assert.match(policy, /你自己以前的回答、摘要和重复表述不是独立事实证据/);
      }
      assert.ok(!plan(`evidence-${state}`).selectedIds.some((id: string) => id.startsWith('memory:adaptive-semantic:')));
    }
  } finally { cfg.saveConfig({ adaptiveMemory: before }); script = async () => ({ content: '完成' }); }
});

test('实际回答保存跨会话来源，后续派生回答继承；纠正后默认历史、回查和召回不沿用旧回答', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const f = fixture('answer-basis-origin'), conv = 'answer-basis-chat';
  store.ensureSession(conv, '来源凭据');
  let turn = 0;
  script = async () => ({ content: ++turn === 1 ? 'STALE_ANSWER_ONE 饭友是编辑。' : turn === 2 ? 'STALE_ANSWER_TWO 沿用此前结论。' : '本轮按当前来源重新判断。' });
  const ask = async () => { await brain.converse('合成用户', '饭友是谁', '控制台', { conv, local: true }); markBusy(true); return joined(seen.at(-1)); };
  try {
    await ask();
    const first = store.sessionMessages(conv).find((m) => m.text.includes('STALE_ANSWER_ONE'))!;
    assert.ok(first.answerBasis?.consistent); assert.ok(first.answerBasis.sources.some((s) => s.id === f.source));
    assert.ok((await ask()).includes('STALE_ANSWER_ONE'), '未发生变化的回答仍可作为历史阅读');
    const second = store.sessionMessages(conv).find((m) => m.text.includes('STALE_ANSWER_TWO'))!;
    assert.ok(second.answerBasis?.sources.some((s) => s.id === f.source), '不能只绑定上一条助手回答自身');
    f.correct();
    const current = await ask();
    assert.ok(!current.includes('STALE_ANSWER_ONE')); assert.ok(!current.includes('STALE_ANSWER_TWO'));
    assert.match(current, /饭友是弟弟/); assert.match(current, /不在当前上下文沿用旧回答正文/);
    assert.equal(store.getSessionMessage(first.id, conv)!.text, first.text, '不改写原始历史');
    await brain.converse('合成用户', '回顾饭友资料', '控制台', { conv: 'answer-basis-other', local: true }); markBusy(true);
    assert.ok(!joined(seen.at(-1)).includes('STALE_ANSWER_ONE')); assert.ok(!joined(seen.at(-1)).includes('STALE_ANSWER_TWO'), '其他会话近况也不能旁路');
    store.saveContextSource('answer-check', conv, JSON.stringify({ messageRef: { id: first.id, conv } }));
    const ctx = contextHost.createTurnContext('answer-read-turn', conv, [{ role: 'user', content: '回查' }]);
    try {
      const read = await contextHost.contextReadChecked('answer-read-turn', 'answer-check');
      assert.ok(!read.includes('STALE_ANSWER_ONE')); assert.match(read, /饭友是弟弟/);
      const recalled = await adaptive.searchAdaptiveHistory('STALE_ANSWER_ONE', { kinds: ['chat'], limit: 8 }, undefined, conv);
      assert.ok(!recalled.includes('STALE_ANSWER_ONE')); assert.match(recalled, /不在当前上下文沿用旧回答正文/);
      store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
      const hidden = await contextHost.contextReadChecked('answer-read-turn', 'answer-check');
      assert.ok(!hidden.includes('STALE_ANSWER_ONE'));
      const before = { ...cfg.config.adaptiveMemory };
      try {
        cfg.saveConfig({ adaptiveMemory: { ...before, enabled: false } });
        const disabled = await ask();
        assert.ok(!disabled.includes('STALE_ANSWER_ONE')); assert.ok(!disabled.includes('STALE_ANSWER_TWO'));
      } finally { cfg.saveConfig({ adaptiveMemory: before }); }
    } finally { ctx.close(); }
  } finally { script = async () => ({ content: '完成' }); }
});

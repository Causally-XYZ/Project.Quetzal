import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { Msg } from "../src/providers/types.ts";
import crypto from "node:crypto";
import type { ClaimRecord, SourceSpan } from "../src/memory/adaptive-evidence.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-adaptive-tool-reading-"));
process.env.QUETZAL_HOME = home;
const cfg = await import("../src/config.ts"); cfg.loadConfig();
cfg.saveConfig({ body: "reader", adaptiveMemory: { enabled: true, hostBody: "center", semantic: true }, brain: { ...cfg.config.brain, memoryLearning: false, memorySemantic: false, maxOutputTokens: 256, contextWindow: 65536 } });
const { DatabaseSync } = await import('node:sqlite');
const oldDb = new DatabaseSync(path.join(cfg.paths.data, 'quetzal.db'));
oldDb.exec("CREATE TABLE tool_calls(call TEXT,session TEXT,ts INTEGER,tool TEXT,args TEXT,result TEXT,status TEXT,ms INTEGER,PRIMARY KEY(call,session)); INSERT INTO tool_calls VALUES('old','old-turn',1,'recall','{}','OLD_UNBOUND_RESULT','ok',1)"); oldDb.close();
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
after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); assert.equal(cfg.config.soul.remote, ""); await soul.idle(); await soul.push("合成测试收尾"); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });

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
  return { source, correct: () => accept({ ...claim, revision: 2, text: '饭友是弟弟', reasons: [span(correction)],
    supports: [{ id: 'corrected', premises: [span(correction)], assumptions: [] }] }, correction) };
}
const historyMessages = (conv: string): Msg[] => [{ role: 'system', content: '当前系统政策' }, ...brain.history(conv, Number.MAX_SAFE_INTEGER), { role: 'user', content: '当前请求只读，不允许写入' }];
const plan = (conv: string) => store.kv.get<any>(`context.plan.${conv}`, null);
const summaryRequest = (request: any) => joined(request).startsWith('压缩历史资料');

const host = await import('../src/memory/structured.ts');
const mem = await import('../src/memory/memory.ts');
const { readMaterialViews, materialSources } = await import('../src/memory/adaptive-material.ts');
const { callTool } = await import('../src/mind/tools.ts');
const { Session } = await import('../src/mind/activity.ts');
async function record(conv: string, source: number, id: string, text = '饭友是编辑，曾经核对的旧认识') {
  const evidence = { id: `${id}-evidence`, ref: `message:${source}`, origin: 'user' as const, observedAt: Date.now(), summary: text, verified: true };
  const candidate = await host.recordMemory({ id, kind: 'fact', text, scope: { agentId: identity().id, userId: 'owner', sessionId: conv },
    conditions: { requiredTags: [], excludedTags: [], tools: [] }, stage: 'any', zone: 'golden', evidenceIds: [evidence.id] }, [evidence]);
  return host.reviewMemory(`${candidate.id}@1`, { accepted: true, independent: true, evaluator: 'synthetic-confirmation', score: 1, evidence: [evidence] });
}


const { prepareToolReadings, toolReadingKey } = await import('../src/mind/tool-reading.ts');
const { withAdaptiveSources } = await import('../src/memory/adaptive.ts');
afterEach(() => { script = async () => ({ content: '完成' }); store.db.prepare('UPDATE sessions SET archived=1').run(); });
async function execute(name: string, args: Record<string, unknown>, turn: string, conv: string, call = 'read-call') {
  const session = new Session('chat', '合成', turn, conv);
  try {
    const out = await callTool(name, args, '合成只读', { session }); assert.equal(out.status, 'ok');
    store.saveToolCall({ call, session: turn, ts: Date.now(), tool: name, args, result: out.text, status: out.status, ms: 1, reading: out.reading });
    return out;
  } finally { session.close(); }
}
const toolMessages = (name: string, args: Record<string, unknown>, text: string, call = 'read-call'): Msg[] => [
  { role: 'user', content: '查看资料' }, { role: 'assistant', content: '', toolCalls: [{ id: call, name, args }] },
  { role: 'tool', toolCallId: call, name, content: text.slice(0, 12000) },
];

test('旧工具表自动补列，旧记录不伪造读取凭据', async () => {
  assert.ok(store.db.prepare('PRAGMA table_info(tool_calls)').all().some((c: any) => c.name === 'reading'));
  const old = store.getToolCall('old', 'old-turn')!; assert.equal(old.result, 'OLD_UNBOUND_RESULT'); assert.equal(old.reading, undefined);
  const prepared = prepareToolReadings([old], 'old-conv');
  const views = await withAdaptiveSources(prepared.sources, (view) => prepared.render(view));
  assert.ok(!views.get(toolReadingKey(old))!.result.includes('OLD_UNBOUND_RESULT'));
  assert.match(views.get(toolReadingKey(old))!.result, /缺少完整来源凭据/);
});

test('实际笔记工具凭据持久化，下一步模型看到新纠正而原执行记录不改', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const conv = 'tool-correct', turn = 'tool-correct-turn', f = fixture(conv);
  await record(conv, f.source, 'tool-correct', 'ORIGINAL_TOOL_FACT');
  const args = { name: 'QuetzalMemory/tool-correct_v1' }, out = await execute('note_read', args, turn, conv);
  assert.equal(out.reading?.checked, true); assert.ok(out.reading!.sources.some((s) => s.id === f.source));
  assert.ok(out.reading!.documents.some((d) => d.kind === 'note')); const saved = store.getToolCall('read-call', turn);
  const prepared = prepareToolReadings([saved!], conv);
  const unchanged = await withAdaptiveSources(prepared.sources, (view) => prepared.render(view));
  assert.match(unchanged.get(toolReadingKey(saved!))!.result, /状态均与原读取一致/);
  assert.ok(unchanged.get(toolReadingKey(saved!))!.result.endsWith(out.text));
  const sourceHash = queue.source(f.source)!.hash;
  const messages = toolMessages('note_read', args, out.text), original = structuredClone(messages), context = contextHost.createTurnContext(turn, conv, messages);
  f.correct();
  assert.equal(queue.source(f.source)!.hash, sourceHash); // 新纠正没有编辑旧原文，仍必须发现修订变化。
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.match(joined(seen.at(-1)), /饭友是弟弟/); assert.match(joined(seen.at(-1)), /ORIGINAL_TOOL_FACT/);
    const tool = seen.at(-1).messages.find((m: any) => m.role === 'tool'); assert.ok(!tool.content.includes('工具结果节选'));
    assert.deepEqual(store.getToolCall('read-call', turn), saved); assert.deepEqual(messages, original);
    store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.ok(!joined(seen.at(-1)).includes('ORIGINAL_TOOL_FACT')); assert.match(joined(seen.at(-1)), /不输出旧正文/);
    assert.ok(!JSON.stringify(context.snapshot().state).includes('ORIGINAL_TOOL_FACT'));
  } finally { context.close(); }
});

test('长工具分页结果不再因重复核查元数据被替换为指向自身的回查', async () => {
  const conv = 'tool-page-no-recursion', turn = 'tool-page-no-recursion-turn'; store.ensureSession(conv, '合成');
  mem.saveNote('分页读取', 'PAGED_BEGIN\n' + '内容'.repeat(12000));
  await execute('note_read', { name: '分页读取' }, turn, conv, 'large-read');
  const context = contextHost.createTurnContext(turn, conv, [{ role: 'user', content: '读取第一页' }]);
  store.saveContextSource('large-page-ref', conv, JSON.stringify({ toolRef: { call: 'large-read', turn } }));
  try {
    const page = await execute('context_read', { ref: 'large-page-ref', limit: 8000 }, turn, conv, 'page-read');
    const row = store.getToolCall('page-read', turn)!, prepared = prepareToolReadings([row], conv);
    const views = await withAdaptiveSources(prepared.sources, (view) => prepared.render(view, () => 'SELF_REFERENCE'));
    const text = views.get(toolReadingKey(row))!.result;
    assert.match(text, /PAGED_BEGIN/); assert.ok(!text.includes('SELF_REFERENCE'));
    assert.ok(text.length < 12000);
    assert.equal(store.getToolCall('page-read', turn)!.result, page.text);
  } finally { context.close(); }
});

test('普通笔记和文档召回绑定文件快照，编辑后不沿用旧结果，也不重放工具', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const conv = 'tool-docs', turn = 'tool-docs-turn'; store.ensureSession(conv, '合成');
  mem.saveNote('普通笔记', 'OLD_DOCUMENT_BODY');
  const args = { name: '普通笔记' }, out = await execute('note_read', args, turn, conv), messages = toolMessages('note_read', args, out.text);
  const context = contextHost.createTurnContext(turn, conv, messages);
  const auditBefore = store.listAudit(1000).length;
  mem.saveNote('普通笔记', 'NEW_DOCUMENT_BODY');
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.ok(!joined(seen.at(-1)).includes('OLD_DOCUMENT_BODY')); assert.equal(store.listAudit(1000).length, auditBefore);
  } finally { context.close(); }
  mem.editMemory('memory', 'add', 'OLD_CORE_TOOL_BODY');
  const core = await execute('recall', { query: 'OLD_CORE_TOOL_BODY' }, 'tool-core-turn', conv);
  assert.ok(core.reading!.documents.some((d) => d.kind === 'document'));
  mem.editMemory('memory', 'replace', 'NEW_CORE_TOOL_BODY', 'OLD_CORE_TOOL_BODY');
  const row = store.getToolCall('read-call', 'tool-core-turn')!, prepared = prepareToolReadings([row], conv);
  const views = await withAdaptiveSources(prepared.sources, (view) => prepared.render(view));
  assert.ok(!views.get(toolReadingKey(row))!.result.includes('OLD_CORE_TOOL_BODY'));
});

test('完整工具回查每页重复当前修订，转读凭据继续绑定原文件与消息', async () => {
  const conv = 'tool-pages', turn = 'tool-pages-turn', f = fixture(conv); await record(conv, f.source, 'tool-pages', 'PAGED_ORIGINAL_BODY');
  const out = await execute('note_read', { name: 'QuetzalMemory/tool-pages_v1' }, turn, conv);
  const messages: Msg[] = [{ role: 'user', content: '回查' }], context = contextHost.createTurnContext(turn, conv, messages);
  store.saveContextSource('tool-page-ref', conv, JSON.stringify({ toolRef: { call: 'read-call', turn } })); f.correct();
  try {
    for (const offset of [0, 8000]) assert.match(await contextHost.contextReadChecked(turn, 'tool-page-ref', offset, 100), /饭友是弟弟/);
    const reread = await execute('context_read', { ref: 'tool-page-ref', offset: 0, limit: 8000 }, turn, conv, 'page-call');
    assert.ok(reread.reading!.sources.some((s) => s.id === f.source)); assert.ok(reread.reading!.documents.some((d) => d.kind === 'tool'));
    store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
    const hidden = await contextHost.contextReadChecked(turn, 'tool-page-ref'); assert.ok(!hidden.includes('PAGED_ORIGINAL_BODY'));
    assert.equal(store.getToolCall('read-call', turn)!.result, out.text);
  } finally { context.close(); }
});

test('读取时已带纠正且此后状态未变，跳页仍携带实际修订而非仅状态一致声明', async () => {
  const conv = 'tool-page-stable-correction', turn = 'tool-page-stable-correction-turn', f = fixture(conv);
  await record(conv, f.source, 'stable-correction', 'OLD_BODY_' + '饭友是编辑。'.repeat(3000)); f.correct();
  await execute('note_read', { name: 'QuetzalMemory/stable-correction_v1' }, turn, conv);
  const context = contextHost.createTurnContext(turn, conv, [{ role: 'user', content: '回查旧原文' }]);
  store.saveContextSource('stable-correction-ref', conv, JSON.stringify({ toolRef: { call: 'read-call', turn } }));
  try {
    for (const offset of [8000, 16000]) {
      const page = await execute('context_read', { ref: 'stable-correction-ref', offset, limit: 8000 }, turn, conv, `page-${offset}`);
      assert.match(page.text, /饭友是弟弟/);
      const row = store.getToolCall(`page-${offset}`, turn)!, prepared = prepareToolReadings([row], conv);
      const views = await withAdaptiveSources(prepared.sources, (view) => prepared.render(view, () => 'SELF_REFERENCE'));
      const text = views.get(toolReadingKey(row))!.result;
      assert.match(text, /饭友是弟弟/); assert.ok(!text.includes('SELF_REFERENCE'));
    }
  } finally { context.close(); }
});

test('损坏、跨会话、改写结果及等锁时修改执行记录均拒绝旧工具视图', async () => {
  const conv = 'tool-integrity', turn = 'tool-integrity-turn'; store.ensureSession(conv, '合成'); mem.saveNote('完整性', 'BODY');
  await execute('note_read', { name: '完整性' }, turn, conv);
  const row = store.getToolCall('read-call', turn)!;
  assert.throws(() => prepareToolReadings([{ ...row, reading: { version: 99 } }], conv), /凭据损坏/);
  assert.throws(() => prepareToolReadings([row], 'elsewhere'), /不匹配/);
  assert.throws(() => prepareToolReadings([{ ...row, result: 'FORGED' }], conv), /不匹配/);
  const prepared = prepareToolReadings([row], conv); let release!: () => void;
  const held = mem.exclusive(() => new Promise<void>((resolve) => { release = resolve; })); await new Promise((resolve) => setImmediate(resolve));
  const pending = withAdaptiveSources(prepared.sources, (view) => prepared.render(view));
  store.saveToolCall({ ...row, ts: row.ts + 1 }); release(); await held;
  await assert.rejects(pending, /执行记录在读取期间已改变/);
});

test('真实 converse 工具循环将凭据穿过引擎写入 SQLite，下一步正确投影', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const conv = 'tool-production', f = fixture(conv); await record(conv, f.source, 'tool-production', 'PRODUCTION_TOOL_BODY');
  let main = 0;
  script = async () => {
    if (++main === 1) return { tool_calls: [{ id: 'production-read', type: 'function', function: { name: 'note_read', arguments: JSON.stringify({ name: 'QuetzalMemory/tool-production_v1' }) } }] };
    return { content: '完成' };
  };
  assert.equal(await brain.converse('合成用户', '读一下笔记', '控制台', { conv, turn: 'tool-production-turn', local: true }), '完成');
  assert.equal(main, 2); assert.equal((store.getToolCall('production-read', 'tool-production-turn')!.reading as any).checked, true);
  assert.match(joined(seen.at(-1)), /历史工具 note_read 的当前来源核查/);
});

test('超过首屏的记忆结果给可用引用，不截出缺少状态的头尾文字', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const conv = 'tool-long', turn = 'tool-long-turn'; store.ensureSession(conv, '合成');
  mem.saveNote('长笔记', 'LONG_NOTE_START' + 'x'.repeat(14000) + 'LONG_NOTE_TAIL');
  const args = { name: '长笔记' }, out = await execute('note_read', args, turn, conv), messages = toolMessages('note_read', args, out.text);
  const context = contextHost.createTurnContext(turn, conv, messages);
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    const text = joined(seen.at(-1)); assert.match(text, /完整工具结果超过首屏预算/); assert.ok(!text.includes('LONG_NOTE_START'));
    const match = /context_read\(ref=("[^"\n]+")\)/.exec(text); assert.ok(match); const ref = JSON.parse(match[1]);
    const pages = await Promise.all([0, 8000, 16000].map((offset) => contextHost.contextReadChecked(turn, ref, offset, 8000)));
    assert.ok(pages.every((p) => p.includes('历史工具 note_read 的当前来源核查')));
    assert.ok(pages.join('').includes('LONG_NOTE_START')); assert.ok(pages.join('').includes('LONG_NOTE_TAIL'));
  } finally { context.close(); }
});

test('摘要等待期间旧工具来源变化，清缓存重建，不让任务证据保留旧正文', async () => {
  const conv = 'tool-summary', turn = 'tool-summary-turn', f = fixture(conv, true); await record(conv, f.source, 'tool-summary', 'STALE_TOOL_DERIVED');
  const args = { name: 'QuetzalMemory/tool-summary_v1' }, out = await execute('note_read', args, turn, conv);
  const messages: Msg[] = [...toolMessages('note_read', args, out.text), ...brain.history(conv, Number.MAX_SAFE_INTEGER), { role: 'user', content: '继续，不要改东西' }];
  configure([{ id: 'compact', context: 10000 }]); seen.length = 0; let summaries = 0;
  script = async (request) => {
    if (!summaryRequest(request)) return { content: '完成' };
    if (++summaries === 1) { store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source); return { content: 'STALE_TOOL_SUMMARY' }; }
    return { content: '已按当前资料重新核对。' };
  };
  const context = contextHost.createTurnContext(turn, conv, messages);
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.ok(summaries >= 2);
    const main = seen.filter((r) => !summaryRequest(r)); assert.equal(main.length, 1);
    assert.ok(!joined(main[0]).includes('STALE_TOOL_DERIVED')); assert.ok(!joined(main[0]).includes('STALE_TOOL_SUMMARY'));
    assert.equal(store.kv.get<any>(`context.plan.${conv}`, {}).adaptiveBasis, undefined, '工具混合摘要没有伪造纯历史凭据');
  } finally { context.close(); }
});

test('跨轮过程附注仅作索引，完整结果回查核对纠正和后续撤回，每页不返回旧副本', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const conv = 'process-local', turn = 'process-original', f = fixture(conv);
  await record(conv, f.source, 'process-local', 'BOUND_PROCESS_FACT');
  await execute('note_read', { name: 'QuetzalMemory/process-local_v1' }, turn, conv);
  const process = [
    { type: 'tool', call: 'read-call', name: 'note_read', status: 'ok', ms: 1, summary: 'STALE_PROCESS_ARGS', result: 'STALE_PROCESS_COPY' },
    { type: 'text', text: 'STALE_PROCESS_NARRATIVE' },
    { type: 'steer', text: 'STALE_PROCESS_STEER', ambient: true },
  ];
  const reply = store.addMessage('agent', '合成', '回复历史原文', { session: conv, process });
  store.saveContextSource(`message-tools:${reply}`, conv, JSON.stringify([{ call: 'read-call', turn }]));
  const messages = historyMessages(conv), original = structuredClone(messages), raw = store.getSessionMessage(reply, conv);
  assert.ok(!JSON.stringify(messages).includes('STALE_PROCESS_'));
  const ctx = contextHost.createTurnContext('process-next', conv, messages);
  try {
    f.correct(); await router.chat(await ctx.prepare({ messages, maxTokens: 256 }));
    const text = joined(seen.at(-1));
    assert.ok(!text.includes('STALE_PROCESS_')); assert.match(text, /note_read/); assert.match(text, /回复历史原文/);
    const ref = `history-message:${reply}`; assert.ok(text.includes(ref));
    const first = await contextHost.contextReadChecked('process-next', ref, 0, 8000);
    assert.match(first, /饭友是弟弟/); assert.match(first, /BOUND_PROCESS_FACT/);
    assert.ok(!first.includes('STALE_PROCESS_'));
    const later = await contextHost.contextReadChecked('process-next', ref, 100, 80);
    assert.match(later, /饭友是弟弟/); assert.match(later, /没有独立来源凭据/);
    store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
    const revoked = await contextHost.contextReadChecked('process-next', ref, 0, 8000);
    assert.ok(!revoked.includes('BOUND_PROCESS_FACT')); assert.ok(!revoked.includes('STALE_PROCESS_'));
    assert.match(revoked, /不输出旧正文/);
    assert.deepEqual(messages, original); assert.deepEqual(store.getSessionMessage(reply, conv), raw);
  } finally { ctx.close(); }
});

test('无本机工具记录的过程不会猜关联，旧附注对象在发送前也重建', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const conv = 'process-unbound'; store.ensureSession(conv, '合成');
  const reply = store.addMessage('agent', '主动', '无绑定的历史回复', { session: conv,
    process: [{ type: 'tool', call: 'other-body-call', name: 'recall', status: 'ok', result: 'UNBOUND_PROCESS_COPY' }, { type: 'text', text: 'UNBOUND_PROCESS_NARRATIVE' }] });
  // 模拟启用修订前生成、带完整来源对象但仍含旧附注的缓存；不能依靠 history() 当时的模式。
  const note = contextHost.registerHistorySource({ role: 'user', content: 'UNBOUND_PROCESS_COPY UNBOUND_PROCESS_NARRATIVE' }, reply, conv, true);
  const messages: Msg[] = [note, { role: 'user', content: '继续' }], ctx = contextHost.createTurnContext('process-unbound-turn', conv, messages);
  try {
    await router.chat(await ctx.prepare({ messages, maxTokens: 256 }));
    assert.ok(!joined(seen.at(-1)).includes('UNBOUND_PROCESS_')); assert.match(joined(seen.at(-1)), /other-body-call/);
    const ref = `history-message:${reply}`;
    const page = await contextHost.contextReadChecked('process-unbound-turn', ref);
    assert.ok(!page.includes('UNBOUND_PROCESS_')); assert.match(page, /缺失时需重新读取/);
    assert.match(note.content, /UNBOUND_PROCESS_COPY/);
    store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(reply);
    await assert.rejects(contextHost.contextReadChecked('process-unbound-turn', ref), /不可访问/);
  } finally { ctx.close(); }
});

test('等锁期间替换过程或单工具回查引用，不能退回未经核查的完整记录', async () => {
  const conv = 'process-race'; store.ensureSession(conv, '合成'); mem.saveNote('竞态笔记', 'RACE_TOOL_BODY');
  await execute('note_read', { name: '竞态笔记' }, 'race-original', conv, 'race-new');
  const reply = store.addMessage('agent', '合成', '历史结果', { session: conv });
  store.saveContextSource('race-message-ref', conv, JSON.stringify({ messageRef: { id: reply, conv } }));
  const ctx = contextHost.createTurnContext('process-race-turn', conv, []);
  const replaceWhileWaiting = async (ref: string, mutate: () => void) => {
    let release!: () => void;
    const held = mem.exclusive(() => new Promise<void>((resolve) => { release = resolve; })); await new Promise((resolve) => setImmediate(resolve));
    const pending = contextHost.contextReadChecked('process-race-turn', ref);
    mutate(); release(); await held;
    await assert.rejects(pending, /引用在核查期间改变/);
  };
  try {
    await replaceWhileWaiting('race-message-ref', () => store.saveContextSource(`message-tools:${reply}`, conv, JSON.stringify([{ call: 'race-new', turn: 'race-original' }])));
    store.saveContextSource('race-tool-ref', conv, JSON.stringify({ toolRef: { call: 'missing', turn: 'race-original' } }));
    await replaceWhileWaiting('race-tool-ref', () => store.saveContextSource('race-tool-ref', conv, JSON.stringify({ toolRef: { call: 'race-new', turn: 'race-original' } })));
    assert.match(await contextHost.contextReadChecked('process-race-turn', 'race-message-ref'), /RACE_TOOL_BODY/);
  } finally { ctx.close(); }
});

test('数据库重新打开后凭据仍在，关闭后台不取消旧工具核查', async () => {
  const conv = 'tool-reopen', turn = 'tool-reopen-turn'; store.ensureSession(conv, '合成'); mem.saveNote('持久笔记', 'PERSISTED_TOOL_TEXT');
  await execute('note_read', { name: '持久笔记' }, turn, conv);
  const before = store.getToolCall('read-call', turn)!;
  await soul.idle(); store.db.close(); store.openStore();
  assert.deepEqual(store.getToolCall('read-call', turn), before);
  cfg.saveConfig({ adaptiveMemory: { ...cfg.config.adaptiveMemory, enabled: false, semantic: false } });
  mem.saveNote('持久笔记', 'CHANGED_AFTER_REOPEN');
  try {
    const prepared = prepareToolReadings([before], conv);
    const views = await withAdaptiveSources(prepared.sources, (view) => prepared.render(view));
    assert.ok(!views.get(toolReadingKey(before))!.result.includes('PERSISTED_TOOL_TEXT'));
  } finally { cfg.saveConfig({ adaptiveMemory: { ...cfg.config.adaptiveMemory, enabled: true, semantic: true } }); }
});

test('笔记凭据使用规范路径，合法读取不因调用者的冗长别名变成损坏凭据', async () => {
  const conv = 'tool-normalized', turn = 'tool-normalized-turn', name = 'x'.repeat(2101);
  store.ensureSession(conv, '合成'); mem.saveNote(name, 'NORMALIZED_DOCUMENT_BODY');
  const out = await execute('note_read', { name }, turn, conv);
  assert.ok(out.reading!.documents.filter((d) => d.kind === 'note').every((d) => d.key.length <= 60));
  const row = store.getToolCall('read-call', turn)!, prepared = prepareToolReadings([row], conv);
  const views = await withAdaptiveSources(prepared.sources, (view) => prepared.render(view));
  assert.match(views.get(toolReadingKey(row))!.result, /NORMALIZED_DOCUMENT_BODY/);
});

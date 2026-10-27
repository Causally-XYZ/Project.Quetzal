import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { Msg } from "../src/providers/types.ts";
import crypto from "node:crypto";
import type { ClaimRecord, SourceSpan } from "../src/memory/adaptive-evidence.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-adaptive-history-"));
process.env.QUETZAL_HOME = home;
const cfg = await import("../src/config.ts"); cfg.loadConfig();
cfg.saveConfig({ body: "reader", adaptiveMemory: { enabled: true, hostBody: "center", semantic: true }, brain: { ...cfg.config.brain, memoryLearning: false, memorySemantic: false, maxOutputTokens: 256, contextWindow: 65536 } });
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
after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });

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

test('真正模型请求读取新修订，手动摘要不截断原文，未修改调用者轨迹', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const conv = 'history-correct', f = fixture(conv);
  store.addMessage('ambient', '摘要', 'OPAQUE_OLD_SUMMARY', { session: conv });
  const messages = historyMessages(conv), original = structuredClone(messages);
  assert.ok(joined({ messages }).includes('饭友是编辑'));
  const context = contextHost.createTurnContext('history-turn', conv, messages);
  f.correct();
  store.kv.set(`context.plan.${conv}`, { summary: { text: 'UNVERSIONED_SUMMARY' } });
  // 另起一轮读取没有来源版本的旧持久摘要。
  const next = contextHost.createTurnContext('history-next', conv, messages);
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    await router.chat(await next.prepare({ messages, maxTokens: 256 }));
    for (const request of seen) {
      const text = joined(request);
      assert.match(text, /饭友是弟弟/); assert.match(text, /饭友是编辑/);
      assert.match(text, /不保证中心最新/); assert.match(text, /当前系统政策/); assert.match(text, /当前请求只读/);
      assert.ok(!text.includes('OPAQUE_OLD_SUMMARY')); assert.ok(!text.includes('UNVERSIONED_SUMMARY'));
    }
    assert.deepEqual(messages, original);
  } finally { context.close(); next.close(); }
});

test('历史生成后原文编辑或忽略，发送当前内容或占位，不沿用旧正文与图像', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const conv = 'history-edit'; store.ensureSession(conv, '合成');
  const source = store.addMessage('user', '合成', 'PRIVATE_OLD_TEXT', { session: conv });
  const historical = contextHost.registerHistorySource({ role: 'user', content: 'PRIVATE_OLD_TEXT', images: [{ data: 'OLD_IMAGE_DATA', mime: 'image/png' }] }, source, conv);
  const messages: Msg[] = [historical, { role: 'user', content: '当前请求' }];
  const context = contextHost.createTurnContext('edit-turn', conv, messages);
  try {
    store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('CURRENT_EDIT', source);
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.match(joined(seen.at(-1)), /CURRENT_EDIT/); assert.ok(!JSON.stringify(seen.at(-1)).includes('OLD_IMAGE_DATA'));
    assert.ok(!joined(seen.at(-1)).includes('PRIVATE_OLD_TEXT'));
    store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(source);
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.match(joined(seen.at(-1)), /已不存在或不可访问/); assert.ok(!joined(seen.at(-1)).includes('CURRENT_EDIT'));
    assert.equal(historical.content, 'PRIVATE_OLD_TEXT');
  } finally { context.close(); }
});

test('摘要等待时接受纠正，丢弃旧摘要重建；缓存可复用，来源引用保持可回查', async () => {
  configure([{ id: 'compact', context: 8000 }]); seen.length = 0;
  const conv = 'history-race', f = fixture(conv, true), messages = historyMessages(conv);
  let summaries = 0;
  script = async (request) => {
    if (!summaryRequest(request)) return { content: '完成' };
    if (++summaries === 1) { f.correct(); return { content: 'GHOST_STALE_SUMMARY' }; }
    return { content: '当前认识需按来源核查。' };
  };
  const context = contextHost.createTurnContext('race-turn', conv, messages);
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.ok(summaries >= 2);
    const main = seen.filter((r) => !summaryRequest(r)); assert.equal(main.length, 1); assert.ok(!joined(main[0]).includes('GHOST_STALE_SUMMARY'));
    assert.ok(!JSON.stringify(plan(conv)).includes('GHOST_STALE_SUMMARY')); assert.ok(plan(conv).adaptiveBasis);
    const count = summaries;
    await router.chat(await context.prepare({ messages, maxTokens: 256 })); assert.equal(summaries, count);
    const sourceId = plan(conv).compactedIds.find((id: string) => JSON.parse(store.readContextSource(`race-turn/${id}`, conv) ?? '{}').messageRef?.id === f.source);
    assert.ok(sourceId); assert.match(await contextHost.contextReadChecked('race-turn', `race-turn/${sourceId}`), /饭友是弟弟/);
  } finally { context.close(); }
});

test('持久摘要只有相同来源版本时继承，后续来源变动即失效', async () => {
  configure([{ id: 'compact', context: 8000 }]); seen.length = 0;
  const conv = 'history-inherit', f = fixture(conv, true), messages = historyMessages(conv);
  script = async (request) => ({ content: summaryRequest(request) ? 'VERSIONED_SUMMARY' : '完成' });
  const initial = contextHost.createTurnContext('inherit-first', conv, messages);
  try { await router.chat(await initial.prepare({ messages, maxTokens: 256 })); } finally { initial.close(); }
  assert.ok(plan(conv).adaptiveBasis); assert.equal(plan(conv).summary.fallback, false); const saved = structuredClone(plan(conv));
  configure([{ id: 'large', context: 131072 }]);
  const next = contextHost.createTurnContext('inherit-next', conv, [{ role: 'user', content: '继续' }]);
  try { await router.chat(await next.prepare({ messages: [{ role: 'user', content: '继续' }], maxTokens: 256 })); assert.match(joined(seen.at(-1)), /VERSIONED_SUMMARY/); }
  finally { next.close(); }
  store.kv.set(`context.plan.${conv}`, saved); f.correct();
  const corrected = contextHost.createTurnContext('inherit-corrected', conv, [{ role: 'user', content: '继续' }]);
  try { await router.chat(await corrected.prepare({ messages: [{ role: 'user', content: '继续' }], maxTokens: 256 })); assert.ok(!joined(seen.at(-1)).includes('VERSIONED_SUMMARY')); }
  finally { corrected.close(); }
});

test('连续两次压缩期间来源变化，有界失败且不保存或发送过期计划', async () => {
  configure([{ id: 'compact', context: 8000 }]); seen.length = 0;
  const conv = 'history-moving', f = fixture(conv, true), messages = historyMessages(conv);
  let calls = 0;
  script = async (request) => {
    assert.ok(summaryRequest(request)); calls++;
    store.db.prepare('UPDATE messages SET text=text || ? WHERE id=?').run(`变化${calls}`, f.source);
    return { content: 'MOVING_SUMMARY' };
  };
  const context = contextHost.createTurnContext('moving-turn', conv, messages);
  try {
    await assert.rejects(router.chat(await context.prepare({ messages, maxTokens: 256 })), /持续变化/);
    assert.ok(calls >= 2 && calls <= 12); assert.equal(plan(conv), null);
  } finally { context.close(); }
});

test('摘要混有未绑定来源的资料时不发布来源版本凭据，下一轮不继承', async () => {
  configure([{ id: 'compact', context: 8000 }]); seen.length = 0;
  const conv = 'history-opaque'; fixture(conv, true);
  const messages = historyMessages(conv);
  messages.splice(1, 0, { role: 'assistant', content: '无来源的旧工具摘录'.repeat(60) });
  script = async (request) => ({ content: summaryRequest(request) ? 'OPAQUE_DERIVED_SUMMARY' : '完成' });
  const context = contextHost.createTurnContext('opaque-turn', conv, messages);
  try { await router.chat(await context.prepare({ messages, maxTokens: 256 })); assert.ok(plan(conv).summary); assert.equal(plan(conv).adaptiveBasis, undefined); }
  finally { context.close(); }
  configure([{ id: 'large', context: 131072 }]);
  const nextMessages: Msg[] = [{ role: 'user', content: '继续' }], next = contextHost.createTurnContext('opaque-next', conv, nextMessages);
  try { await router.chat(await next.prepare({ messages: nextMessages, maxTokens: 256 })); assert.ok(!joined(seen.at(-1)).includes('OPAQUE_DERIVED_SUMMARY')); }
  finally { next.close(); }
});

test('滚动历史合并来源超限时丢弃旧摘要，不阻断当前历史', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const conv = 'history-rolling'; fixture(conv);
  store.kv.set(`context.plan.${conv}`, { summary: { text: 'OVER_LIMIT_SUMMARY' }, adaptiveBasis: { sources: Array.from({ length: 1000 }, (_, i) => 100000 + i), key: '0'.repeat(64) } });
  const messages = historyMessages(conv), context = contextHost.createTurnContext('rolling-turn', conv, messages);
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.match(joined(seen.at(-1)), /饭友是编辑/); assert.ok(!joined(seen.at(-1)).includes('OVER_LIMIT_SUMMARY'));
  } finally { context.close(); }
});

test('实际 session_compact 在修订模式仅存档，不承诺截断旧原文或回传无版本摘要', async () => {
  const { Session } = await import('../src/mind/activity.ts'), { callTool } = await import('../src/mind/tools.ts');
  const conv = 'history-manual'; fixture(conv);
  const session = new Session('chat', '合成', 'manual-turn', conv);
  try {
    const result = await callTool('session_compact', { summary: 'MANUAL_UNVERSIONED' }, '合成', { session });
    assert.equal(result.status, 'ok'); assert.match(result.text, /已存档摘要/); assert.ok(!result.text.includes('MANUAL_UNVERSIONED'));
    assert.ok(store.sessionMessages(conv).some((row) => row.channel === '摘要' && row.text === 'MANUAL_UNVERSIONED'));
    const text = joined({ messages: brain.history(conv, Number.MAX_SAFE_INTEGER) });
    assert.match(text, /饭友是编辑/); assert.ok(!text.includes('MANUAL_UNVERSIONED'));
  } finally { session.close(); }
});


test('升级过程读取规则后不继承旧规则生成的持久摘要，即使消息和图版本未变', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0; script = async () => ({ content: '完成' });
  const conv = 'history-old-policy'; store.ensureSession(conv, '合成');
  const source = store.addMessage('agent', '合成', '历史回复', { session: conv, process: [{ type: 'text', text: 'OLD_PROCESS_IN_SUMMARY' }] });
  const { withAdaptiveSources } = await import('../src/memory/adaptive.ts');
  const key = await withAdaptiveSources([source], (view) => {
    assert.ok(view);
    const reading = crypto.createHash('sha256').update(JSON.stringify({ generation: view.generation, sources: view.sources })).digest('hex');
    return crypto.createHash('sha256').update(JSON.stringify({ reading, rows: [[source, store.getSessionMessage(source, conv)]] })).digest('hex');
  });
  store.kv.set(`context.plan.${conv}`, { summary: { text: 'OLD_PROCESS_IN_SUMMARY' }, adaptiveBasis: { sources: [source], key } });
  const messages: Msg[] = [{ role: 'user', content: '继续' }], ctx = contextHost.createTurnContext('old-policy-turn', conv, messages);
  try {
    await router.chat(await ctx.prepare({ messages, maxTokens: 256 }));
    assert.ok(!joined(seen.at(-1)).includes('OLD_PROCESS_IN_SUMMARY'));
  } finally { ctx.close(); }
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { Msg } from "../src/providers/types.ts";
import crypto from "node:crypto";
import type { ClaimRecord, SourceSpan } from "../src/memory/adaptive-evidence.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-adaptive-selection-"));
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

const { selectContextMemory } = await import('../src/memory/semantic.ts');
const selectionQuery = (conv: string) => ({ scope: { agentId: identity().id, userId: 'owner', sessionId: conv },
  text: '饭友编辑资料', now: Date.now(), stage: 'any' as const, tags: [], tools: [], limit: 6 });
const answer = (keys: string[]) => ({ text: JSON.stringify({ keys }), toolCalls: [], model: 'synthetic-selection', usage: { input: 2, output: 3 } });
cfg.saveConfig({ brain: { ...cfg.config.brain, memorySemantic: true } });

test('选择模型收到独立修订字段且不收到隐藏正文，不能猜回未发送的候选key', async () => {
  const conv = 'selection-correct', f = fixture(conv); await record(conv, f.source, 'selection-correct'); f.correct();
  const hidden = store.addMessage('user', '合成', 'SECRET_SELECTION_SOURCE', { session: conv });
  await record(conv, hidden, 'selection-hidden', '饭友编辑 SECRET_SELECTION_DERIVED');
  store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(hidden);
  let calls = 0;
  const chosen = await selectContextMemory(selectionQuery(conv), undefined, async (request) => {
    calls++;
    const text = request.messages.at(-1)!.content, candidates = JSON.parse(text).candidates;
    assert.ok(!text.includes('SECRET_SELECTION_DERIVED')); assert.ok(!text.includes('selection-hidden'));
    assert.match(JSON.stringify(candidates), /饭友是弟弟/); assert.equal(candidates[0].reading.status, 'historical');
    return answer(['selection-correct@1', 'selection-hidden@1']);
  });
  assert.equal(calls, 1); assert.deepEqual(chosen.map((r) => r.id), ['selection-correct']);
});

test('来源不变复用缓存；只有原文hash变化也重新选择，来源忽略后不调用模型', async () => {
  const conv = 'selection-cache', f = fixture(conv); await record(conv, f.source, 'selection-cache');
  let calls = 0;
  const model = async () => { calls++; return answer(['selection-cache@1']); };
  assert.equal((await selectContextMemory(selectionQuery(conv), undefined, model)).length, 1);
  assert.equal((await selectContextMemory(selectionQuery(conv), undefined, model)).length, 1); assert.equal(calls, 1);
  store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('编辑了原文但尚未处理', f.source);
  assert.equal((await selectContextMemory(selectionQuery(conv), undefined, model)).length, 1); assert.equal(calls, 2);
  store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
  assert.deepEqual(await selectContextMemory(selectionQuery(conv), undefined, model), []); assert.equal(calls, 2);
});

test('选择模型等待期间来源失效，返回的key不进入缓存或词面降级结果', async () => {
  const conv = 'selection-race', f = fixture(conv); await record(conv, f.source, 'selection-race');
  let calls = 0;
  const result = await selectContextMemory(selectionQuery(conv), undefined, async () => {
    calls++; store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
    return answer(['selection-race@1']);
  });
  assert.deepEqual(result, []); assert.equal(calls, 1);
  store.db.prepare('UPDATE messages SET mode=NULL WHERE id=?').run(f.source);
  assert.equal((await selectContextMemory(selectionQuery(conv), undefined, async () => { calls++; return answer(['selection-race@1']); })).length, 1);
  assert.equal(calls, 2);
});

test('选择器失败或关闭时，词面降级同样不能返回已忽略来源', async () => {
  const conv = 'selection-fallback', f = fixture(conv); await record(conv, f.source, 'selection-fallback');
  const result = await selectContextMemory(selectionQuery(conv), undefined, async () => {
    store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
    throw new Error('synthetic selection failure');
  });
  assert.deepEqual(result, []);
  cfg.saveConfig({ brain: { ...cfg.config.brain, memorySemantic: false } });
  try { assert.deepEqual(await selectContextMemory(selectionQuery(conv)), []); }
  finally { cfg.saveConfig({ brain: { ...cfg.config.brain, memorySemantic: true } }); }
});

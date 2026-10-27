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
  return { source, correct: () => accept({ ...claim, revision: 2, text: '饭友是弟弟', reasons: [span(correction)],
    supports: [{ id: 'corrected', premises: [span(correction)], assumptions: [] }] }, correction) };
}
const historyMessages = (conv: string): Msg[] => [{ role: 'system', content: '当前系统政策' }, ...brain.history(conv, Number.MAX_SAFE_INTEGER), { role: 'user', content: '当前请求只读，不允许写入' }];
const plan = (conv: string) => store.kv.get<any>(`context.plan.${conv}`, null);
const summaryRequest = (request: any) => joined(request).startsWith('压缩历史资料');


const adaptive = await import('../src/memory/adaptive.ts');
const { markBusy } = await import('../src/heart/heart.ts');
const { exclusive } = await import('../src/memory/memory.ts');
markBusy(true); adaptive.startAdaptiveMemory();

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

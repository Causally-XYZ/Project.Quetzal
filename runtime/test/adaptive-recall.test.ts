import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { Msg } from "../src/providers/types.ts";
import crypto from "node:crypto";
import type { ClaimRecord, SourceSpan } from "../src/memory/adaptive-evidence.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-adaptive-recall-"));
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

const { searchAdaptiveHistory } = await import('../src/memory/adaptive.ts');

test('实际 recall 文档命中返回当前修订，原审核和历史正文不冒充现行依据', async () => {
  const conv = 'recall-correct', f = fixture(conv); await record(conv, f.source, 'recall-correct', '琥珀调查：饭友是编辑'); f.correct();
  const session = new Session('chat', '合成', 'recall-correct-turn', conv);
  try {
    const result = await callTool('recall', { query: '琥珀调查', scope: 'memory' }, '合成', { session });
    assert.equal(result.status, 'ok'); assert.match(result.text, /饭友是弟弟/); assert.match(result.text, /historical/);
    assert.match(result.text, /琥珀调查：饭友是编辑/); assert.match(result.text, /旧记忆当时的审核记录/);
  } finally { session.close(); }
});

test('忽略来源后搜索片段不能带出派生正文，其他会话也看不到受限笔记标题或正文', async () => {
  const conv = 'recall-hidden', f = fixture(conv); await record(conv, f.source, 'hidden-title', 'HIDDEN_RECALL_EVIDENCE');
  const other = await callTool('recall', { query: 'HIDDEN_RECALL_EVIDENCE', scope: 'memory' }, '其他会话');
  assert.equal(other.status, 'ok'); assert.ok(!other.text.includes('hidden-title')); assert.ok(!other.text.includes('HIDDEN_RECALL_EVIDENCE'));
  store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
  const session = new Session('chat', '合成', 'hidden-recall-turn', conv);
  try {
    const result = await callTool('recall', { query: 'HIDDEN_RECALL_EVIDENCE', scope: 'memory' }, '合成', { session });
    assert.equal(result.status, 'ok'); assert.ok(!result.text.includes('HIDDEN_RECALL_EVIDENCE')); assert.ok(!result.text.includes('hidden-title'));
  } finally { session.close(); }
});

test('先过滤再取结果数，不可访问的高分候选不能挤空普通可读笔记', async () => {
  const conv = 'recall-fill', f = fixture(conv);
  for (let i = 0; i < 9; i++) await record('unrelated-private', f.source, `fill-${i}`, '紫砂茶会 '.repeat(5));
  mem.saveNote('合成可读笔记', '紫砂茶会 PUBLIC_FILL_RESULT');
  const result = await searchAdaptiveHistory('紫砂茶会', { kinds: ['note'], limit: 1 }, undefined, conv);
  assert.match(result, /PUBLIC_FILL_RESULT/); assert.ok(!result.includes('笔记/QuetzalMemory/fill-'));
  assert.match(result, /没有可解析的消息来源/);
});

test('等锁期间普通笔记被编辑，不能返回旧搜索片段', async () => {
  mem.saveNote('并发候选', 'OBSOLETE_NOTE_FRAGMENT');
  let release!: () => void;
  const held = mem.exclusive(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const pending = searchAdaptiveHistory('OBSOLETE_NOTE_FRAGMENT', { kinds: ['note'] });
  mem.saveNote('并发候选', 'REPLACEMENT_NOTE_FRAGMENT');
  release(); await held;
  await assert.rejects(pending, /笔记在读取期间已改变/);
  assert.match(await searchAdaptiveHistory('REPLACEMENT_NOTE_FRAGMENT', { kinds: ['note'] }), /REPLACEMENT_NOTE_FRAGMENT/);
});

test('受管笔记等锁期间失效，也不能走旧全文或旧片段回退', async () => {
  const conv = 'recall-archive', f = fixture(conv); await record(conv, f.source, 'recall-archive', 'OLD_MANAGED_SNIPPET');
  const file = path.join(cfg.paths.soul, 'notes', 'QuetzalMemory', 'recall-archive_v1.md'), original = fs.readFileSync(file, 'utf8');
  let release!: () => void;
  const held = mem.exclusive(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const pending = searchAdaptiveHistory('OLD_MANAGED_SNIPPET', { kinds: ['note'] }, undefined, conv);
  fs.writeFileSync(file, original.replace('"state": "active"', '"state": "archived"'));
  release(); await held;
  try { await assert.rejects(pending, /笔记在读取期间已改变/); } finally { fs.writeFileSync(file, original); }
});

test('无出处常驻记忆返回前也核对当前文件，条目位置变化不能沿用旧片段', async () => {
  mem.editMemory('memory', 'add', 'OLD_CORE_FRAGMENT');
  let release!: () => void;
  const held = mem.exclusive(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const pending = searchAdaptiveHistory('OLD_CORE_FRAGMENT', { kinds: ['memory'] });
  mem.editMemory('memory', 'replace', 'NEW_CORE_FRAGMENT', 'OLD_CORE_FRAGMENT');
  release(); await held;
  await assert.rejects(pending, /文档召回来源已改变/);
  const result = await searchAdaptiveHistory('NEW_CORE_FRAGMENT', { kinds: ['memory'] });
  assert.match(result, /NEW_CORE_FRAGMENT/); assert.match(result, /没有可解析的消息来源/);
});

test('停止或权威存档异常时，文档召回不得退回旧索引正文', async () => {
  const conv = 'recall-authority', f = fixture(conv); await record(conv, f.source, 'recall-authority', 'AUTHORITY_TEST_PHRASE'); f.correct();
  const stop = new AbortController(); stop.abort(new Error('cancel-recall-doc'));
  await assert.rejects(searchAdaptiveHistory('AUTHORITY_TEST_PHRASE', { kinds: ['note'] }, stop.signal, conv), /cancel-recall-doc/);
  const { publishPending, publicationRoot } = await import('../src/memory/adaptive-publication.ts');
  for (let i = 0; i < 20 && queue.pendingPublications().length; i++) assert.ok(publishPending(queue, cfg.paths.soul, () => true) > 0);
  const file = path.join(publicationRoot(cfg.paths.soul), `${archive.checkpoint()!.artifact}.md`), content = fs.readFileSync(file);
  fs.unlinkSync(file);
  try { await assert.rejects(searchAdaptiveHistory('AUTHORITY_TEST_PHRASE', { kinds: ['note'] }, undefined, conv), /文件缺失|结果缺失/); }
  finally { fs.writeFileSync(file, content); }
});

test('日记小节在等锁期间变化时拒绝旧片段，新检索仍按未核实资料返回', async () => {
  mem.writeJournal('合成旧经历', 'OLD_JOURNAL_FRAGMENT');
  const journal = mem.listJournal().find((j) => j.body === cfg.config.body)!;
  const file = path.join(cfg.paths.soul, 'journal', journal.body, `${journal.day}.md`);
  let release!: () => void;
  const held = mem.exclusive(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const pending = searchAdaptiveHistory('OLD_JOURNAL_FRAGMENT', { kinds: ['journal'] });
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('OLD_JOURNAL_FRAGMENT', 'NEW_JOURNAL_FRAGMENT'));
  release(); await held;
  await assert.rejects(pending, /文档召回来源已改变/);
  const result = await searchAdaptiveHistory('NEW_JOURNAL_FRAGMENT', { kinds: ['journal'] });
  assert.match(result, /NEW_JOURNAL_FRAGMENT/); assert.match(result, /没有可解析的消息来源/);
});

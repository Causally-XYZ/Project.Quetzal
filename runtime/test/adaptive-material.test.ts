import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { Msg } from "../src/providers/types.ts";
import crypto from "node:crypto";
import type { ClaimRecord, SourceSpan } from "../src/memory/adaptive-evidence.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-adaptive-material-"));
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

test('实际 memory_records 保留原审核并另附来源纠正，不把 verified 当作当前证据', async () => {
  const conv = 'material-inspect', f = fixture(conv); await record(conv, f.source, 'material-inspect'); f.correct();
  const session = new Session('chat', '合成', 'inspect-turn', conv);
  try {
    const response = await callTool('memory_records', {}, '合成', { session }); assert.equal(response.status, 'ok');
    const [item] = JSON.parse(response.text);
    assert.equal(item.state, 'active'); assert.equal(item.validation.status, 'verified');
    assert.equal(item.reading.status, 'historical'); assert.match(item.text, /饭友是编辑/);
    assert.equal(item.reading.sources[0].notices[0].current.text, '饭友是弟弟');
    assert.equal(host.readStructuredRecords().find((r) => r.id === 'material-inspect')!.text, item.text);
  } finally { session.close(); }
});

test('来源忽略后工具不返回派生正文或证据引语，仍能管理原记录且不泄漏其他会话', async () => {
  const conv = 'material-hidden', f = fixture(conv); await record(conv, f.source, 'material-hidden', 'HIDDEN_DERIVED_QUOTE');
  await record('other-conv', f.source, 'other-material', 'OTHER_SCOPE_TEXT');
  store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
  const session = new Session('chat', '合成', 'hidden-turn', conv);
  try {
    const response = await callTool('memory_records', {}, '合成', { session }); assert.equal(response.status, 'ok');
    assert.ok(!response.text.includes('HIDDEN_DERIVED_QUOTE')); assert.ok(!response.text.includes('OTHER_SCOPE_TEXT'));
    const [item] = JSON.parse(response.text); assert.equal(item.key, 'material-hidden@1'); assert.equal(item.reading.status, 'unavailable');
    assert.equal(item.text, undefined); assert.equal(item.evidence, undefined);
  } finally { session.close(); }
});

test('真实模型请求中的旧候选带纠正，下一步忽略来源后不注入旧正文', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const conv = 'material-context', f = fixture(conv); await record(conv, f.source, 'material-context'); f.correct();
  const messages: Msg[] = [{ role: 'system', content: '只读政策' }, { role: 'user', content: '核查饭友编辑的认识' }];
  const context = contextHost.createTurnContext('material-context-turn', conv, messages);
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.match(joined(seen.at(-1)), /饭友是弟弟/); assert.match(joined(seen.at(-1)), /旧记忆档案/);
    assert.match(joined(seen.at(-1)), /曾经核对的旧认识/);
    store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.ok(!joined(seen.at(-1)).includes('曾经核对的旧认识')); assert.match(joined(seen.at(-1)), /只读政策/);
  } finally { context.close(); }
});

test('旧结构化语义选择缓存命中后，主模型入口仍重新核对来源', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const conv = 'material-cache', f = fixture(conv); await record(conv, f.source, 'material-cache', '饭友是编辑 CACHED_DERIVED_TEXT');
  cfg.saveConfig({ brain: { ...cfg.config.brain, memorySemantic: true } });
  let selections = 0;
  script = async (request) => {
    if (joined(request).startsWith('你只做记忆选择')) { selections++; return { content: '{"keys":["material-cache@1"]}' }; }
    return { content: '完成' };
  };
  const messages: Msg[] = [{ role: 'user', content: '饭友编辑的资料' }], context = contextHost.createTurnContext('cache-turn', conv, messages);
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 })); assert.match(joined(seen.at(-1)), /CACHED_DERIVED_TEXT/);
    f.correct();
    await router.chat(await context.prepare({ messages, maxTokens: 256 })); assert.match(joined(seen.at(-1)), /饭友是弟弟/);
    store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
    await router.chat(await context.prepare({ messages, maxTokens: 256 })); assert.ok(!joined(seen.at(-1)).includes('CACHED_DERIVED_TEXT'));
    assert.equal(selections, 1, '实际命中了既有选择缓存，当前来源门禁仍生效');
  } finally { context.close(); cfg.saveConfig({ brain: { ...cfg.config.brain, memorySemantic: false } }); script = async () => ({ content: '完成' }); }
});

test('只有候选来源在摘要等待期间被纠正时也重建计划，最终发送带新修订的候选', async () => {
  configure([{ id: 'compact', context: 12000 }]); seen.length = 0;
  const conv = 'material-race', f = fixture(conv); await record(conv, f.source, 'material-race');
  const messages: Msg[] = [{ role: 'system', content: '只读政策' }];
  for (let i = 0; i < 6; i++) messages.push({ role: 'assistant', content: `旧轨迹${i}` + '背景'.repeat(600) });
  messages.push({ role: 'user', content: '核查饭友编辑' });
  let summaries = 0;
  script = async (request) => {
    if (summaryRequest(request)) { if (++summaries === 1) { f.correct(); return { content: 'STALE_MATERIAL_SUMMARY' }; } return { content: '资料需要核查。' }; }
    return { content: '完成' };
  };
  const context = contextHost.createTurnContext('material-race-turn', conv, messages);
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 })); assert.ok(summaries >= 2);
    assert.match(joined(seen.at(-1)), /饭友是弟弟/); assert.ok(!joined(seen.at(-1)).includes('STALE_MATERIAL_SUMMARY'));
  } finally { context.close(); script = async () => ({ content: '完成' }); }
});

test('等锁期间受管文件改变，即使 id 以 legacy_ 开头也不沿用候选副本', async () => {
  const conv = 'material-changed', f = fixture(conv), candidate = await record(conv, f.source, 'legacy_managed');
  const file = path.join(cfg.paths.soul, 'notes', 'QuetzalMemory', 'legacy_managed_v1.md'), original = fs.readFileSync(file, 'utf8');
  let release!: () => void;
  const held = mem.exclusive(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const pending = readMaterialViews([candidate]);
  fs.writeFileSync(file, original.replace('"state": "active"', '"state": "archived"'));
  release(); await held;
  try { await assert.rejects(pending, /版本已改变/); } finally { fs.writeFileSync(file, original); }
});

test('无来源旧材料只标不可核实，正文中的 message 字样不伪造来源；文件变化仍拒绝旧副本', async () => {
  mem.saveNote('合成普通笔记', '饭友旧资料，随便写的 message:123 不能成为出处。');
  const candidate = host.readLegacyRecords().find((r) => r.evidence[0].ref.includes('合成普通笔记'))!;
  const [view] = await readMaterialViews([candidate]); assert.equal(view.reading?.status, 'unverifiable');
  assert.deepEqual(materialSources(candidate), []); assert.match(view.text!, /message:123/);
  mem.saveNote('合成普通笔记', '已经编辑的新资料');
  await assert.rejects(readMaterialViews([candidate]), /版本已改变/);
});

test('关闭后台仍读取已知修订，取消请求不返回旧候选', async () => {
  const conv = 'material-disabled', f = fixture(conv), candidate = await record(conv, f.source, 'material-disabled'); f.correct();
  cfg.saveConfig({ adaptiveMemory: { enabled: false, hostBody: 'center', semantic: false } });
  try {
    assert.match(JSON.stringify(await readMaterialViews([candidate])), /饭友是弟弟/);
    const stop = new AbortController(); stop.abort(new Error('cancel-material'));
    await assert.rejects(readMaterialViews([candidate], stop.signal), /cancel-material/);
  } finally { cfg.saveConfig({ adaptiveMemory: { enabled: true, hostBody: 'center', semantic: true } }); }
});

test('实际 note_read 读取受管记录及文件别名仍带纠正，并校验会话范围', async () => {
  const conv = 'material-note', f = fixture(conv); await record(conv, f.source, 'material-note'); f.correct();
  const session = new Session('chat', '合成', 'note-turn', conv);
  const alias = path.join(cfg.paths.soul, 'notes', 'synthetic-alias.md');
  fs.symlinkSync(path.join(cfg.paths.soul, 'notes', 'QuetzalMemory', 'material-note_v1.md'), alias);
  try {
    for (const name of ['QuetzalMemory/material-note_v1', 'synthetic-alias']) {
      const result = await callTool('note_read', { name }, '合成', { session }); assert.equal(result.status, 'ok');
      assert.match(result.text, /饭友是弟弟/); assert.equal(JSON.parse(result.text).reading.status, 'historical');
      const other = await callTool('note_read', { name }, '其他会话'); assert.equal(other.status, 'error'); assert.match(other.text, /范围/);
    }
    store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
    const hidden = await callTool('note_read', { name: 'synthetic-alias' }, '合成', { session });
    assert.equal(hidden.status, 'ok'); assert.equal(JSON.parse(hidden.text).reading.status, 'unavailable'); assert.ok(!hidden.text.includes('曾经核对的旧认识'));
  } finally { session.close(); fs.unlinkSync(alias); }
});

test('普通笔记原文保留但不猜出处；格式错误的受管文件不能当自由笔记返回', async () => {
  mem.saveNote('普通资料', '饭友资料 message:123');
  const ordinary = await callTool('note_read', { name: '普通资料' }, '合成'); assert.equal(ordinary.status, 'ok');
  assert.match(ordinary.text, /没有可解析的消息来源/); assert.match(ordinary.text, /饭友资料 message:123/);
  mem.saveNote('格式样例', '```json\n{"format":"quetzal-memory-v1","record":null}\n```');
  const example = await callTool('note_read', { name: '格式样例' }, '合成'); assert.equal(example.status, 'ok');
  assert.match(example.text, /没有可解析的消息来源/); assert.match(example.text, /"record":null/);
  const file = path.join(cfg.paths.soul, 'notes', 'QuetzalMemory', 'broken-read.md');
  const alias = path.join(cfg.paths.soul, 'notes', 'broken-alias.md');
  fs.writeFileSync(file, '# broken\nRAW_MANAGED_CONTENT\n```json\n{invalid}\n```\n');
  fs.symlinkSync(file, alias);
  try {
    for (const name of ['QuetzalMemory/broken-read', 'broken-alias']) {
      const broken = await callTool('note_read', { name }, '合成'); assert.equal(broken.status, 'error');
      assert.ok(!broken.text.includes('RAW_MANAGED_CONTENT'));
    }
  } finally { fs.unlinkSync(file); fs.unlinkSync(alias); }
});

test('直接读取旧自适应存档也核对当前修订；忽略输入后不返回旧 payload', async () => {
  const conv = 'material-artifact', f = fixture(conv); f.correct();
  const checkpoint = archive.checkpoint()!;
  const { publishPending } = await import('../src/memory/adaptive-publication.ts');
  for (let i = 0; i < 20 && queue.pendingPublications().length; i++) assert.ok(publishPending(queue, cfg.paths.soul, () => true) > 0);
  assert.equal(queue.pendingPublications().length, 0);
  const name = `QuetzalMemory/Adaptive/${checkpoint.artifact}`;
  const result = await callTool('note_read', { name }, '合成'); assert.equal(result.status, 'ok');
  assert.match(result.text, /记忆修订核对/); assert.match(result.text, /饭友是弟弟/); assert.match(result.text, /quetzal-adaptive-result-v1/);
  store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
  const hidden = await callTool('note_read', { name }, '合成'); assert.equal(hidden.status, 'ok');
  assert.match(hidden.text, /来源不可访问/); assert.ok(!hidden.text.includes('quetzal-adaptive-result-v1')); assert.ok(!hidden.text.includes('饭友是弟弟'));
});

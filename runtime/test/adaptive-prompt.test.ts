import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { Msg } from "../src/providers/types.ts";
import crypto from "node:crypto";
import type { ClaimRecord, SourceSpan } from "../src/memory/adaptive-evidence.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-adaptive-prompt-"));
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
  return { source, correction, correct: (text = '饭友是弟弟') => accept({ ...claim, revision: 2, text, reasons: [span(correction)],
    supports: [{ id: 'corrected', premises: [span(correction)], assumptions: [] }] }, correction) };
}

const { systemMessage, systemPrompt, readSystemMessages, withSystemReading } = await import('../src/mind/prompt.ts');
const mem = await import('../src/memory/memory.ts');
const { foldRemote } = await import('../src/mind/activity.ts');
const summaryRequest = (request: any) => joined(request).startsWith('压缩历史资料');
afterEach(() => { store.db.prepare('UPDATE sessions SET archived=1').run(); script = async () => ({ content: '完成' }); });

test('跨会话近况分别保留每条消息的历史时间，不用会话更新时间覆盖，编辑时间会更新读取视图', async () => {
  store.ensureSession('dated-history', '合成跨月历史');
  const first = store.addMessage('user', '合成', '昨天整理录音。', { session: 'dated-history' });
  const second = store.addMessage('user', '合成', '后来更正了一处口误。', { session: 'dated-history' });
  const a = '2026-02-10T12:00:00.000Z', b = '2026-08-10T12:00:00.000Z', c = '2026-03-10T12:00:00.000Z';
  store.db.prepare('UPDATE messages SET ts=? WHERE id=?').run(Date.parse(a), first);
  store.db.prepare('UPDATE messages SET ts=? WHERE id=?').run(Date.parse(b), second);
  const messages = [systemMessage('', { conv: 'current', dynamic: true })];
  const initial = joined({ messages: await readSystemMessages(messages) });
  assert(initial.includes(a) && initial.includes(b)); assert(initial.includes('会话更新时间（不是下列消息的发言时间）'));
  store.db.prepare('UPDATE messages SET ts=? WHERE id=?').run(Date.parse(c), first);
  const edited = joined({ messages: await readSystemMessages(messages) });
  assert(!edited.includes(a)); assert(edited.includes(c) && edited.includes(b));
  store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(first);
  const hidden = joined({ messages: await readSystemMessages(messages) });
  assert(!hidden.includes(c)); assert(!hidden.includes('昨天整理录音')); assert(hidden.includes(b));
});

test('生产系统消息在实际模型准备时读跨会话修订，保持历史性质和原调用对象', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const f = fixture('other-correct'); store.ensureSession('current', '当前会话');
  const system = systemMessage('', { conv: 'current', dynamic: true }), original = system.content;
  assert.ok(!original.includes('饭友是编辑'));
  const messages: Msg[] = [system, { role: 'user', content: '看看其他会话提过什么' }];
  const context = contextHost.createTurnContext('prompt-turn', 'current', messages);
  f.correct();
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    const text = joined(seen.at(-1));
    assert.match(text, /饭友是弟弟/); assert.match(text, /饭友是编辑/);
    assert.match(text, /本机已收到的快照/); assert.match(text, /历史/); assert.match(text, /红线/);
    assert.equal(system.content, original);
    store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(f.source);
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.ok(!joined(seen.at(-1)).includes('饭友是编辑'));
  } finally { context.close(); }
});

test('当前文件外的会话原文编辑、忽略、摘要与未绑定实时草稿不沿用旧正文', async () => {
  store.ensureSession('other-edit', '其他会话');
  const source = store.addMessage('user', '控制台', 'OLD_OTHER_TEXT', { session: 'other-edit' });
  const messages: Msg[] = [systemMessage('', { conv: 'current', dynamic: true })];
  store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('CURRENT_OTHER_TEXT', source);
  assert.match(joined({ messages: await readSystemMessages(messages) }), /CURRENT_OTHER_TEXT/);
  assert.ok(!joined({ messages: await readSystemMessages(messages) }).includes('OLD_OTHER_TEXT'));
  store.addMessage('ambient', '摘要', 'OPAQUE_OTHER_SUMMARY', { session: 'other-edit' });
  foldRemote({ session: 'live-prompt', conv: 'other-edit', origin: 'chat', channel: '控制台', ts: Date.now(), body: 'remote', kind: 'start', text: 'UNBOUND_LIVE_INPUT' } as any);
  try {
    store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(source);
    const text = joined({ messages: await readSystemMessages(messages) });
    assert.ok(!text.includes('CURRENT_OTHER_TEXT')); assert.ok(!text.includes('OPAQUE_OTHER_SUMMARY')); assert.ok(!text.includes('UNBOUND_LIVE_INPUT'));
    assert.match(text, /历史摘要.*未绑定来源版本/); assert.match(text, /进行中/);
  } finally { foldRemote({ session: 'live-prompt', conv: 'other-edit', origin: 'chat', ts: Date.now(), body: 'remote', kind: 'done' } as any); }
});

test('直接 quick 的模型故障转移重新读取系统来源，不复用失败模型的正文', async () => {
  configure([{ id: 'first', context: 131072 }, { id: 'second', context: 131072 }]); seen.length = 0;
  store.ensureSession('quick-other', '其他会话');
  const source = store.addMessage('user', '控制台', 'BEFORE_MODEL_FAILURE', { session: 'quick-other' });
  script = async (request) => {
    if (request.model === 'first') {
      store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('AFTER_MODEL_FAILURE', source);
      return { status: 503 };
    }
    return { content: '完成' };
  };
  await router.chat(withSystemReading({ messages: [systemMessage('', { dynamic: true }), { role: 'user', content: '快速内省' }], maxTokens: 256 }), { quick: true });
  assert.ok(seen.some((r) => r.model === 'first'));
  assert.match(joined(seen.at(-1)), /AFTER_MODEL_FAILURE/); assert.ok(!joined(seen.at(-1)).includes('BEFORE_MODEL_FAILURE'));
});

test('等锁时跨会话消息变化拒绝旧快照；取消和权威文件损坏不回退静态原文', async () => {
  const f = fixture('prompt-race'); f.correct();
  const messages: Msg[] = [systemMessage('', { dynamic: true })];
  let release!: () => void;
  const held = mem.exclusive(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const pending = readSystemMessages(messages);
  store.db.prepare('UPDATE messages SET text=text || ? WHERE id=?').run('改动', f.source);
  release(); await held;
  await assert.rejects(pending, /跨会话来源在准备期间已改变/);
  const stopped = new AbortController(); stopped.abort(new Error('cancel-system'));
  await assert.rejects(readSystemMessages(messages, stopped.signal), /cancel-system/);
  const { publishPending, publicationRoot } = await import('../src/memory/adaptive-publication.ts');
  for (let i = 0; i < 20 && queue.pendingPublications().length; i++) assert.ok(publishPending(queue, cfg.paths.soul, () => true) > 0);
  const file = path.join(publicationRoot(cfg.paths.soul), `${archive.checkpoint()!.artifact}.md`), content = fs.readFileSync(file);
  fs.unlinkSync(file);
  try { await assert.rejects(readSystemMessages(messages), /文件缺失|结果缺失/); }
  finally { fs.writeFileSync(file, content); }
});

test('主会话摘要等待时其他会话发生纠正，旧计划丢弃后重建', async () => {
  const f = fixture('other-during-summary'); fixture('prompt-history', true);
  const messages: Msg[] = [systemMessage('', { conv: 'prompt-history', dynamic: true }), ...brain.history('prompt-history', Number.MAX_SAFE_INTEGER), { role: 'user', content: '继续当前任务' }];
  configure([{ id: 'compact', context: Buffer.byteLength(messages[0].content) + 8000 }]); seen.length = 0;
  let summaries = 0;
  script = async (request) => {
    if (!summaryRequest(request)) return { content: '完成' };
    if (++summaries === 1) { f.correct(); return { content: 'STALE_CROSS_SESSION_PLAN' }; }
    return { content: '重新按当前资料核对。' };
  };
  const context = contextHost.createTurnContext('prompt-summary-turn', 'prompt-history', messages);
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.ok(summaries >= 2);
    const main = seen.filter((r) => !summaryRequest(r)); assert.equal(main.length, 1);
    assert.match(joined(main[0]), /饭友是弟弟/); assert.ok(!joined(main[0]).includes('STALE_CROSS_SESSION_PLAN'));
    assert.ok(!JSON.stringify(store.kv.get('context.plan.prompt-history', null)).includes('STALE_CROSS_SESSION_PLAN'));
  } finally { context.close(); }
});

test('关闭生成仍核查已有认识；静态兼容预览不能带入未核查常驻资料', async () => {
  const f = fixture('prompt-disabled'); f.correct();
  mem.editMemory('memory', 'add', 'UNVERIFIED_STATIC_CORE');
  cfg.saveConfig({ adaptiveMemory: { ...cfg.config.adaptiveMemory, enabled: false, semantic: false } });
  try {
    const preview = systemPrompt();
    assert.ok(!preview.includes('饭友是编辑')); assert.ok(!preview.includes('UNVERIFIED_STATIC_CORE'));
    const text = joined({ messages: await readSystemMessages([systemMessage()]) });
    assert.match(text, /饭友是弟弟/); assert.ok(!text.includes('UNVERIFIED_STATIC_CORE'));
  } finally { cfg.saveConfig({ adaptiveMemory: { ...cfg.config.adaptiveMemory, enabled: true, semantic: true } }); }
});


test('实际 converse 工具循环通过生产系统消息入口读取其他会话修订', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const f = fixture('production-other'); f.correct();
  assert.equal(await brain.converse('合成用户', '回顾我们之前讨论的资料', '控制台', { conv: 'production-current', local: true }), '完成');
  assert.ok(seen.length > 0);
  assert.match(joined(seen.at(-1)), /饭友是弟弟/);
  assert.match(joined(seen.at(-1)), /本机已收到的快照/);
});

test('跨会话修订超过局部预算时整项省略，不能留下旧正文而截掉修订', async () => {
  const f = fixture('prompt-large-reading'); f.correct('LONG_CORRECTION_START' + '修订材料'.repeat(1100) + 'LONG_CORRECTION_END');
  const text = joined({ messages: await readSystemMessages([systemMessage('', { dynamic: true })]) });
  assert.match(text, /超过预算，已整项略过/);
  assert.ok(!text.includes('饭友是编辑')); assert.ok(!text.includes('LONG_CORRECTION_START')); assert.ok(!text.includes('LONG_CORRECTION_END'));
});

test('同一轮中新消息与删除会话重新取样，不沿用最初系统快照', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  store.ensureSession('growing-other', '新进展');
  store.addMessage('user', '控制台', 'FIRST_OTHER_MESSAGE', { session: 'growing-other' });
  const messages: Msg[] = [systemMessage('', { conv: 'growing-current', dynamic: true }), { role: 'user', content: '继续' }];
  const context = contextHost.createTurnContext('growing-turn', 'growing-current', messages);
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 })); assert.match(joined(seen.at(-1)), /FIRST_OTHER_MESSAGE/);
    store.addMessage('user', '控制台', 'LATER_OTHER_MESSAGE', { session: 'growing-other' });
    await router.chat(await context.prepare({ messages, maxTokens: 256 })); assert.match(joined(seen.at(-1)), /LATER_OTHER_MESSAGE/);
    store.db.prepare('DELETE FROM messages WHERE session=?').run('growing-other');
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.ok(!joined(seen.at(-1)).includes('FIRST_OTHER_MESSAGE')); assert.ok(!joined(seen.at(-1)).includes('LATER_OTHER_MESSAGE'));
  } finally { context.close(); }
});


test('实际 wake 快速内省收到核查后的系统资料，不需要进入工具循环', async () => {
  configure([{ id: 'large', context: 131072 }]); seen.length = 0;
  const f = fixture('wake-other'); f.correct();
  script = async () => ({ content: JSON.stringify({ engage: false, intent: '继续休息' }) });
  const result = await brain.wake('think', '合成内省');
  assert.equal(result.effort, 0.005); assert.equal(seen.length, 1);
  assert.match(joined(seen[0]), /饭友是弟弟/); assert.match(joined(seen[0]), /本机已收到的快照/);
});

test('连续两次摘要期间仅跨会话原文变化，有界失败且不发送旧系统资料', async () => {
  const f = fixture('moving-other'); fixture('moving-current', true);
  const messages: Msg[] = [systemMessage('', { conv: 'moving-current' }), ...brain.history('moving-current', Number.MAX_SAFE_INTEGER), { role: 'user', content: '继续' }];
  configure([{ id: 'compact', context: Buffer.byteLength(messages[0].content) + 8000 }]); seen.length = 0;
  let summaries = 0;
  script = async (request) => {
    assert.ok(summaryRequest(request));
    store.db.prepare('UPDATE messages SET text=text || ? WHERE id=?').run(`新资料${++summaries}`, f.source);
    return { content: 'STALE_CONTINUOUS_SYSTEM' };
  };
  const context = contextHost.createTurnContext('moving-system-turn', 'moving-current', messages);
  try {
    await assert.rejects(router.chat(await context.prepare({ messages, maxTokens: 256 })), /持续变化/);
    assert.ok(summaries >= 2 && summaries <= 12);
    assert.equal(store.kv.get('context.plan.moving-current', null), null);
  } finally { context.close(); }
});

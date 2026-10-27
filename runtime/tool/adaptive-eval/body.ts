// 仅由评测控制进程启动。独立数据库、网关、真实 mesh 与后台；不读取数据集或预期答案。
import fs from 'node:fs';
import path from 'node:path';
import { observeModel, type ObservedCall } from './model-observer.ts';
import { ControlledGraph } from './controlled-graph.ts';
import { observeRetrieval } from './retrieval-observer.ts';
import { semanticDigest } from '../../src/memory/adaptive-query.ts';

if (!process.send || !process.env.QUETZAL_EVAL_BODY) throw new Error('评测身体必须由控制进程启动');
const settings = JSON.parse(process.env.QUETZAL_EVAL_BODY);
const cfg = await import('../../src/config.ts'); cfg.loadConfig();
const legacy = settings.baseline === 'legacy', raw = settings.baseline === 'raw-fts';
cfg.saveConfig({ body: settings.body, gateway: { port: 0, host: '127.0.0.1', lan: false },
  soul: { remote: settings.remote, branch: 'main' }, adaptiveMemory: { enabled: !settings.storageOnly && !legacy, hostBody: 'center', semantic: !legacy && !raw, research: settings.research === true },
  brain: { memorySemantic: legacy, memoryLearning: legacy }, guard: { sentinel: { enabled: false } } }, { remote: true });
const store = await import('../../src/store.ts'); store.openStore();
await (await import('../../src/body/uuid.ts')).ensureBodyUuid();
const soul = await import('../../src/memory/soul-sync.ts'); await soul.ensureSoul();
const observer = settings.storageOnly ? { calls: [] as ObservedCall[], setPhase: (_value: string) => {}, abort: () => {}, close: async () => {} }
  : await observeModel({ directory: path.join(cfg.paths.home, 'eval-calls'), model: settings.model,
    kind: settings.kind, maxCalls: settings.maxCalls, stubFailAt: settings.stubFailAt, stubReviewDelayMs: settings.stubReviewDelayMs, thinkingLevel: settings.thinkingLevel });
cfg.saveConfig({ sharedRev: { providers: 1 } }, { remote: true });
const { Mesh } = await import('../../src/mesh/mesh.ts');
const { loadNodeKey } = await import('../../src/mesh/identity.ts');
const ndc = (await import('node-datachannel')).default;
const mesh = new Mesh({ me: settings.body, key: loadNodeKey(path.join(cfg.paths.secrets, 'mesh_ed25519')), ndc,
  binding: { server: settings.sync, token: settings.body, agent: settings.agent ?? 'x', body: settings.body, account: 'synthetic' },
  keyOf: (body) => settings.keys[body], hello: () => ({ version: 'evaluation' }), log: () => {} });
const uninstall = [
  (await import('../../src/mesh/replica.ts')).installReplica(mesh),
  (await import('../../src/mesh/shared.ts')).installShared(mesh),
  (await import('../../src/mesh/adaptive-memory.ts')).installAdaptiveMemory(mesh),
  (await import('../../src/mesh/soul-sync.ts')).installSoulSync(mesh),
];
const adaptive = await import('../../src/memory/adaptive.ts');
if (!settings.vector) adaptive.setAdaptiveComponentPreparer(async () => false);
const vector = settings.vector ? observeRetrieval() : undefined;
const brain = await import('../../src/mind/brain.ts');
const { readStructuredRecords } = await import('../../src/memory/structured.ts');
const { documents } = await import('../../src/memory/retrieval.ts');
const { identity } = await import('../../src/memory/identity.ts');
if (identity().id !== (settings.agent ?? 'x')) throw new Error('评测灵魂身份不匹配');
const { AdaptiveStore } = await import('../../src/memory/adaptive-store.ts');
const { AdaptiveArchive } = await import('../../src/memory/adaptive-archive.ts');
const { exclusive } = await import('../../src/memory/memory.ts');
const queue = new AdaptiveStore(store.db, identity().id), archive = new AdaptiveArchive(queue, cfg.paths.soul);
const controlled = settings.controlled && settings.body === 'center' ? new ControlledGraph(queue, archive) : undefined;
let held = false;
const gateway = (await import('../../src/gateway.ts')).startGateway(false); await gateway.ready;
if (!settings.storageOnly) { adaptive.startAdaptiveMemory(); mesh.start(); }
let shutting = false;
async function shutdown() {
  if (shutting) return; shutting = true;
  observer.abort();
  await Promise.allSettled(store.db.prepare('SELECT id FROM sessions').all().map((s) => brain.stopTurn(String(s.id), { local: true })));
  await adaptive.stopAdaptiveMemory(); await observer.close(); vector?.close();
  for (const fn of uninstall) fn();
  mesh.stop(); await gateway.close(); await soul.idle();
  fs.writeFileSync(path.join(cfg.paths.home, 'shutdown-evidence.json'), JSON.stringify({ calls: observer.calls,
    status: adaptive.adaptiveStatus(), jobs: queue.jobs(1000), at: Date.now() }, null, 2), { flag: 'wx' });
  ndc.cleanup(); store.db.close();
}
const commands: Record<string, (args: any) => unknown> = {
  connected: () => mesh.connected(),
  connection: (a) => {
    if (settings.storageOnly || settings.body !== 'satellite' || typeof a.online !== 'boolean') throw new Error();
    if (a.online) mesh.start(); else mesh.stop(); return true;
  },
  phase: (a) => { if (!/^[a-zA-Z0-9._/-]{1,100}$/.test(a.value)) throw new Error(); observer.setPhase(a.value); return true; },
  controlledHold: async () => {
    if (!controlled || held || adaptive.adaptiveStatus().semantic.state !== 'idle' || observer.calls.some((c) => c.state === 'running')) throw new Error();
    await adaptive.stopAdaptiveMemory(); held = true; return true;
  },
  controlledApply: (a) => {
    if (!controlled || !held) throw new Error();
    return exclusive(() => controlled.apply(a.source, a.operation));
  },
  controlledResume: () => {
    if (!controlled || !held) throw new Error();
    held = false; adaptive.startAdaptiveMemory(); return true;
  },
  source: (a) => {
    if (!['user', 'assistant-summary'].includes(a.role) || !['accessible', 'denied'].includes(a.scope) || a.operation
      || typeof a.text !== 'string' || !a.text || a.text.length > 8000 || !Number.isFinite(Date.parse(a.at))
      || !/^[a-zA-Z0-9._-]{1,64}$/.test(a.session)) throw new Error('不支持的评测输入');
    store.ensureSession(a.session, '合成历史');
    // 只在同步写入/广播期间注入记录时钟，避免先广播当前时间、再仅修改本机时间的复制分叉。
    // 没有 await；所有异步后台与传输计时仍用真实时钟。不是用户界面发言时间模拟。
    const original = Date.now;
    try {
      Date.now = () => Date.parse(a.at);
      if (settings.baseline) {
        // 正常对话同步写入来源；必须先恢复时钟，再等待回复和后台学习。
        const reply = brain.converse('合成用户', a.text, '合成对照', { conv: a.session });
        const source = store.db.prepare('SELECT id FROM messages WHERE session=? AND role=? ORDER BY id DESC LIMIT 1').get(a.session, 'user');
        return reply.then(() => { if (!source) throw new Error('对照来源未写入'); return Number(source.id); });
      }
      return store.addMessage(a.role === 'user' ? 'user' : 'agent', '合成历史', a.text,
      { session: a.session, ...(a.scope === 'denied' ? { mode: 'ignored' } : {}) }); }
    finally { Date.now = original; }
  },
  snapshot: () => exclusive(() => ({ ...(settings.fullEvidence ? { history: archive.current().flatMap((r) => archive.history(r.id)),
      evidence: Object.fromEntries(archive.assess()) } : {}), agent: identity().id, records: archive.current(), generation: archive.generation(), calls: observer.calls,
    ...(settings.baseline ? { learningPending: brain.pendingMemoryLearning(), structured: readStructuredRecords(),
      legacyDocuments: documents().map(({ source, text }) => ({ source, text })).sort((a, b) => a.source.localeCompare(b.source)),
      memoryConfig: { adaptive: cfg.config.adaptiveMemory, brain: cfg.config.brain } } : {}),
    ...(vector ? { retrievalCalls: vector.calls,
      retrievalExpected: semanticDigest(archive.candidates().map(({ key, title, text }) => ({ key, title, text }))) } : {}),
    ...(controlled ? { controlled: controlled.snapshot(), held } : {}),
    messages: store.db.prepare('SELECT id,ts,role,text,session,body,mode,answerBasis FROM messages ORDER BY id').all(),
    receipts: store.db.prepare('SELECT source,processor,revision,completed FROM adaptive_receipts').all(),
    publications: store.db.prepare('SELECT id,digest,state,error FROM adaptive_publications').all(), jobs: queue.jobs(1000),
    status: adaptive.adaptiveStatus(), sync: { unpushed: soul.syncStatus().unpushed }, pid: process.pid })),
  plan: (a) => store.kv.get(`context.plan.${a.session}`, null),
  lexical: (a) => exclusive(() => archive.query(a.query)),
  probeScope: async (a) => {
    if (settings.storageOnly || settings.body !== 'satellite' || a.foreignAgent !== 'isolated-evaluation') throw new Error();
    // 正对照必须成功。失联、超时、未知方法等错误不能冒充跨 agent 拒绝。
    const allowed = await mesh.request<any>('center', 'memory.adaptive.semantic.query', { agent: identity().id, query: a.query }, 2000);
    if (allowed.status !== 'ready' || allowed.agent !== identity().id) throw new Error();
    try {
      await mesh.request('center', 'memory.adaptive.semantic.query', { agent: a.foreignAgent, query: a.query }, 2000);
      return { allowed, rejected: false };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== '认识查询范围或形状不合法') throw new Error();
      return { allowed, rejected: true, reason: 'agent-scope' };
    }
  },
};
process.on('message', async (message: any) => {
  if (!Number.isSafeInteger(message?.id)) return;
  try {
    if (message.cmd === 'stop') {
      await shutdown(); process.send!({ id: message.id, result: true }, () => process.exit(0)); return;
    }
    if (shutting || !Object.hasOwn(commands, message.cmd)) throw new Error();
    const result = await commands[message.cmd](message.args ?? {}); process.send!({ id: message.id, result });
  } catch { process.send!({ id: message.id, error: 'evaluation-command-failed' }); }
});
process.on('disconnect', () => { void shutdown().finally(() => process.exit(1)); });
process.send!({ ready: true, port: (gateway.plain.address() as { port: number }).port, pid: process.pid });

// 仅由评测控制进程启动。独立数据库、网关、真实 mesh 与后台；不读取数据集或预期答案。
import fs from 'node:fs';
import path from 'node:path';
import { observeModel } from './model-observer.ts';

if (!process.send || !process.env.QUETZAL_EVAL_BODY) throw new Error('评测身体必须由控制进程启动');
const settings = JSON.parse(process.env.QUETZAL_EVAL_BODY);
const cfg = await import('../../src/config.ts'); cfg.loadConfig();
cfg.saveConfig({ body: settings.body, gateway: { port: 0, host: '127.0.0.1', lan: false },
  soul: { remote: settings.remote, branch: 'main' }, adaptiveMemory: { enabled: true, hostBody: 'center', semantic: true },
  brain: { memorySemantic: false, memoryLearning: false }, guard: { sentinel: { enabled: false } } }, { remote: true });
const store = await import('../../src/store.ts'); store.openStore();
await (await import('../../src/body/uuid.ts')).ensureBodyUuid();
const soul = await import('../../src/memory/soul-sync.ts'); await soul.ensureSoul();
const observer = await observeModel({ directory: path.join(cfg.paths.home, 'eval-calls'), model: settings.model,
  kind: settings.kind, maxCalls: settings.maxCalls, stubFailAt: settings.stubFailAt });
cfg.saveConfig({ sharedRev: { providers: 1 } }, { remote: true });
const { Mesh } = await import('../../src/mesh/mesh.ts');
const { loadNodeKey } = await import('../../src/mesh/identity.ts');
const ndc = (await import('node-datachannel')).default;
const mesh = new Mesh({ me: settings.body, key: loadNodeKey(path.join(cfg.paths.secrets, 'mesh_ed25519')), ndc,
  binding: { server: settings.sync, token: settings.body, agent: 'x', body: settings.body, account: 'synthetic' },
  keyOf: (body) => settings.keys[body], hello: () => ({ version: 'evaluation' }), log: () => {} });
const uninstall = [
  (await import('../../src/mesh/replica.ts')).installReplica(mesh),
  (await import('../../src/mesh/shared.ts')).installShared(mesh),
  (await import('../../src/mesh/adaptive-memory.ts')).installAdaptiveMemory(mesh),
  (await import('../../src/mesh/soul-sync.ts')).installSoulSync(mesh),
];
const adaptive = await import('../../src/memory/adaptive.ts');
const brain = await import('../../src/mind/brain.ts');
const { identity } = await import('../../src/memory/identity.ts');
const { AdaptiveStore } = await import('../../src/memory/adaptive-store.ts');
const { AdaptiveArchive } = await import('../../src/memory/adaptive-archive.ts');
const { exclusive } = await import('../../src/memory/memory.ts');
const queue = new AdaptiveStore(store.db, identity().id), archive = new AdaptiveArchive(queue, cfg.paths.soul);
const gateway = (await import('../../src/gateway.ts')).startGateway(false); await gateway.ready;
adaptive.startAdaptiveMemory(); mesh.start();
let shutting = false;
async function shutdown() {
  if (shutting) return; shutting = true;
  observer.abort();
  await Promise.allSettled(store.db.prepare('SELECT id FROM sessions').all().map((s) => brain.stopTurn(String(s.id), { local: true })));
  await adaptive.stopAdaptiveMemory(); await observer.close();
  for (const fn of uninstall) fn();
  mesh.stop(); await gateway.close(); await soul.idle();
  fs.writeFileSync(path.join(cfg.paths.home, 'shutdown-evidence.json'), JSON.stringify({ calls: observer.calls,
    status: adaptive.adaptiveStatus(), jobs: queue.jobs(1000), at: Date.now() }, null, 2), { flag: 'wx' });
  ndc.cleanup(); store.db.close();
}
const commands: Record<string, (args: any) => unknown> = {
  connected: () => mesh.connected(),
  phase: (a) => { if (!/^[a-zA-Z0-9._/-]{1,100}$/.test(a.value)) throw new Error(); observer.setPhase(a.value); return true; },
  source: (a) => {
    if (!['user', 'assistant-summary'].includes(a.role) || a.scope !== 'accessible' || a.operation
      || typeof a.text !== 'string' || !a.text || a.text.length > 8000 || !Number.isFinite(Date.parse(a.at))
      || !/^[a-zA-Z0-9._-]{1,64}$/.test(a.session)) throw new Error('不支持的评测输入');
    store.ensureSession(a.session, '合成历史');
    // 只在同步写入/广播期间注入记录时钟，避免先广播当前时间、再仅修改本机时间的复制分叉。
    // 没有 await；所有异步后台与传输计时仍用真实时钟。不是用户界面发言时间模拟。
    const original = Date.now;
    try { Date.now = () => Date.parse(a.at); return store.addMessage(a.role === 'user' ? 'user' : 'agent', '合成历史', a.text, { session: a.session }); }
    finally { Date.now = original; }
  },
  snapshot: () => exclusive(() => ({ records: archive.current(), generation: archive.generation(), calls: observer.calls,
    messages: store.db.prepare('SELECT id,ts,role,text,session,body,mode FROM messages ORDER BY id').all(),
    receipts: store.db.prepare('SELECT source,processor,revision,completed FROM adaptive_receipts').all(),
    publications: store.db.prepare('SELECT id,digest,state,error FROM adaptive_publications').all(), jobs: queue.jobs(1000),
    status: adaptive.adaptiveStatus(), sync: { unpushed: soul.syncStatus().unpushed }, pid: process.pid })),
  plan: (a) => store.kv.get(`context.plan.${a.session}`, null),
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

// 隔离进程中的真实网关、存储、复制与记忆宿主；只有信令目录和回答模型为本机测试替身。
import http from 'node:http';
import path from 'node:path';
const cfg = await import('../../src/config.ts');
cfg.loadConfig();
cfg.saveConfig({ body: process.env.BODY, gateway: { port: 0, host: '127.0.0.1', lan: false },
  brain: { memorySemantic: false, memoryLearning: false }, guard: { sentinel: { enabled: false } } }, { remote: true });
const store = await import('../../src/store.ts'); store.openStore();
await (await import('../../src/body/uuid.ts')).ensureBodyUuid();
const seen: string[] = [];
const model = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
    seen.push(body); seen.splice(0, Math.max(0, seen.length - 20));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '合成模型已回答' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
const reg = await import('../../src/providers/registry.ts');
reg.saveProviders({ providers: [{ id: 'test', catalogId: 'custom', name: '合成模型',
  baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}`, protocol: 'openai-completions', enabled: true,
  keys: [{ id: 'test-key', label: '合成', lastFour: '', enabled: true, secret: 'synthetic-test-key' }],
  models: [{ id: 'test-model', name: 'test', enabled: true, context: 131072, maxTokens: 256, sortOrder: 0 }] }] }, reg.configVersion());
cfg.saveConfig({ sharedRev: { providers: 1 } }, { remote: true });
const { Mesh } = await import('../../src/mesh/mesh.ts');
const { loadNodeKey } = await import('../../src/mesh/identity.ts');
const ndc = (await import('node-datachannel')).default;
const keys = JSON.parse(process.env.KEYS!) as Record<string, string>;
const mesh = new Mesh({ me: process.env.BODY!, key: loadNodeKey(path.join(cfg.paths.secrets, 'mesh_ed25519')), ndc,
  binding: { server: process.env.SYNC!, token: process.env.BODY!, agent: 'x', body: process.env.BODY!, account: 'test' },
  keyOf: (b) => keys[b], hello: () => ({ version: 'test' }), log: () => {} });
(await import('../../src/mesh/replica.ts')).installReplica(mesh);
(await import('../../src/mesh/shared.ts')).installShared(mesh);
(await import('../../src/mesh/adaptive-memory.ts')).installAdaptiveMemory(mesh);
const adaptive = await import('../../src/memory/adaptive.ts');
adaptive.startAdaptiveMemory(); mesh.start();
const { startGateway } = await import('../../src/gateway.ts');
const gateway = startGateway(false); await gateway.ready;
const { AdaptiveStore } = await import('../../src/memory/adaptive-store.ts');
const { identity } = await import('../../src/memory/identity.ts');
const queue = () => new AdaptiveStore(store.db, identity().id);
let loadTimer: NodeJS.Timeout | undefined;
let arrivals: { id: number; at: number }[] = [];
const commands: Record<string, (a: any) => unknown> = {
  connected: () => mesh.connected(), seen: () => seen,
  lease: () => {
    adaptive.processAdaptiveBatch();
    adaptive.stopAdaptiveMemory();
    const id = store.addMessage('user', '合成', '租约恢复测试来源', { session: 'lease' }), q = queue();
    q.schedule(); const job = q.claim('source-v1', Date.now(), 1000);
    if (job?.source !== id) throw new Error('测试未取得指定来源租约');
    return job;
  },
  seedGap: () => {
    const base = store.idPrefixOf('gap-author') * store.ID_RANGE;
    store.applyRemote('messages', (cfg.config.body === 'center' ? [2] : [1, 2]).map((n) => ({
      id: base + n, ts: Date.now() - 1000, role: 'user', channel: '合成', text: `缺口恢复线索 ${n}`, session: 'gap', body: 'gap-author',
    })), { from: 'gap-author', catchUp: true });
    return true;
  },
  seedHistory: () => {
    const q = queue(), base = store.idPrefixOf('archive') * store.ID_RANGE;
    for (let page = 0; page < 10; page++) store.applyRemote('messages', Array.from({ length: 1000 }, (_, i) => ({
      id: base + page * 1000 + i + 1, ts: Date.now() - 86400_000, role: 'user', channel: '合成',
      text: `合成历史基准线索 ${page * 1000 + i}：港口采风与旧物修复`, session: 'archive', body: 'archive',
    })), { from: 'archive', catchUp: true });
    while (q.schedule('source-v1', Date.now(), 1000)) {
      let job; while ((job = q.claim())) q.complete(job);
    }
    return { count: 10_000 };
  },
  startLoad: () => {
    arrivals = []; clearInterval(loadTimer);
    loadTimer = setInterval(() => {
      for (let i = 0; i < 10; i++) {
        const id = store.addMessage('user', '合成', `活跃输入基准线索 ${arrivals.length}`, { session: 'load' });
        arrivals.push({ id, at: Date.now() });
      }
      if (arrivals.length >= 300) clearInterval(loadTimer);
    }, 100);
    return true;
  },
  loadState: () => ({ count: arrivals.length, latencies: arrivals.flatMap(({ id, at }) => {
    const receipt = store.db.prepare("SELECT completed FROM adaptive_receipts WHERE source=? AND processor='source-v1'").get(id);
    return receipt ? [Number(receipt.completed) - at] : [];
  }) }),
  messages: (a) => store.sessionMessages(a.session),
  mode: (a) => store.setMessageMode(a.id, a.mode),
  request: (a) => mesh.request(a.body, 'memory.adaptive.query', a.params, 1000),
  duplicate: (a) => mesh.broadcast('replica', { table: 'messages', rows: [store.db.prepare('SELECT * FROM messages WHERE id=?').get(a.id)] }),
};
process.on('message', async (m: any) => {
  try { process.send!({ id: m.id, result: await commands[m.cmd](m.args ?? {}) }); }
  catch (e) { process.send!({ id: m.id, error: (e as Error).message }); }
});
process.send!({ ready: true, port: (gateway.plain.address() as { port: number }).port });

// 真实宿主定时器 / 模型路由 / HTTP / SQLite / 灵魂文件，模型语义为明确的合成替身。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-adaptive-production-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../src/config.ts'); cfg.loadConfig();
cfg.saveConfig({ body: 'center', adaptiveMemory: { enabled: true, hostBody: 'center', semantic: false } });
const store = await import('../src/store.ts'); store.openStore();
await (await import('../src/memory/soul-sync.ts')).ensureSoul();
const registry = await import('../src/providers/registry.ts');
const host = await import('../src/memory/adaptive.ts');
const { generateAdaptiveProposal, boundedProposal } = await import('../src/memory/adaptive-model.ts');
const { proposalPrompt } = await import('../src/memory/adaptive-proposal.ts');
const { AdaptiveStore } = await import('../src/memory/adaptive-store.ts');
const { AdaptiveArchive } = await import('../src/memory/adaptive-archive.ts');
const { identity } = await import('../src/memory/identity.ts');
const { processSemanticNext } = await import('../src/memory/adaptive-worker.ts');
const { exclusive } = await import('../src/memory/memory.ts');
const queue = new AdaptiveStore(store.db, identity().id), archive = new AdaptiveArchive(queue, cfg.paths.soul);
const seen: any[] = [];
let mode = 'valid';
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
    const request = JSON.parse(body); seen.push(request);
    if (mode === 'fallback' && request.model === 'main') { res.writeHead(404); res.end('{}'); return; }
    const input = JSON.parse(request.messages[1].content), source = input.sources.find((s: any) => s.key === input.current);
    const quote = { kind: 'source', source: source.key, text: source.text, occurrence: null };
    const time = { text: '', earliest: null, latest: null };
    const patch = { contexts: [], records: [{ key: 'p1', replace: null, kind: 'claim', state: 'present', realm: 'real',
      reasons: [quote], text: source.text, nature: 'reported', participants: [], occurred: time, valid: time,
      supports: [{ id: 'direct', premises: [quote], assumptions: [] }], counters: [] }] };
    const text = mode === 'fences' ? '```json\n{}\n```' : JSON.stringify(patch);
    const tools = mode === 'tools' ? [{ id: 'forbidden', type: 'function', function: { name: 'run', arguments: '{}' } }] : undefined;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{
      message: { content: text, tool_calls: tools }, finish_reason: mode === 'truncated' ? 'length' : 'stop',
    }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const configure = () => registry.saveProviders({ quickModelId: 'quick', providers: [{
  id: 'synthetic-provider', name: 'Synthetic', catalogId: 'custom', baseUrl: `http://127.0.0.1:${address.port}`, protocol: 'openai-completions', enabled: true,
  keys: [{ id: 'fixture-key', label: 'fixture', enabled: true, lastFour: '', secret: 'synthetic-adaptive-key' }],
  models: ['tiny', 'main', 'quick'].map((id, sortOrder) => ({ id, name: id, enabled: true, context: id === 'tiny' ? 1000 : 65536, maxTokens: 4096, sortOrder })),
}] }, registry.configVersion());
configure();
after(async () => { await host.stopAdaptiveMemory(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });
async function eventually(check: () => boolean) {
  const until = Date.now() + 8000;
  while (!check()) { if (Date.now() > until) throw new Error('后台试验未在测试时限内完成'); await new Promise((r) => setTimeout(r, 20)); }
}
let first = 0;
const prompt = () => proposalPrompt({ generation: archive.generation(), current: first, records: [], sources: [queue.source(first)!] });

test('现有宿主开关启用后台整合，经真实主路由和存档自动发布；默认不调用语义模型', async () => {
  store.ensureSession('synthetic', '合成'); first = store.addMessage('user', '合成', '周末准备去河边散步。', { session: 'synthetic' });
  host.startAdaptiveMemory(); host.processAdaptiveBatch();
  assert.equal(queue.status('semantic-v1').counts.running, 0); assert.equal(seen.length, 0);
  host.configureAdaptiveMemory({ enabled: true, hostBody: 'center', semantic: true });
  host.processAdaptiveBatch();
  await eventually(() => !!queue.processed(first, 'semantic-v1'));
  assert.ok(archive.current().some((r) => r.kind === 'claim' && r.text === '周末准备去河边散步。'));
  assert.equal(archive.supportedClaims().length, 1);
  assert.deepEqual(seen.map((r) => r.model), ['main'], 'tiny 窗口不足不发请求，quick 不被优先选择');
  assert.equal((host.adaptiveStatus().semantic as any).lastModel.model, 'Synthetic/main');
  await eventually(() => Number(store.db.prepare("SELECT COUNT(*) n FROM adaptive_publications WHERE state='published'").get()!.n) > 0);
  assert.equal((await host.queryAdaptive('散步')).status, 'unavailable', '前台覆盖层未接好时不以旧原文观察旁路语义纠正');
  await host.stopAdaptiveMemory();
});

test('现有模型故障转移报告实际模型；截断、工具调用和 Markdown 围栏不能冒充提案', async () => {
  mode = 'fallback'; const usage: any[] = [];
  await generateAdaptiveProposal(prompt(), new AbortController().signal, (u) => usage.push(u));
  assert.equal(usage[0].model, 'Synthetic/quick'); assert.equal(usage[0].input, 20);
  for (const bad of ['truncated', 'tools', 'fences']) {
    mode = bad; await assert.rejects(generateAdaptiveProposal(prompt(), new AbortController().signal), /输出|JSON/);
  }
  mode = 'valid';
});

test('模型出站保密值被替换，来源原文保持不变；时间墙不等待无响应生成器', async () => {
  const p = prompt(); p.user = p.user.replace('周末准备去河边散步。', '包含 synthetic-adaptive-key 的合成资料');
  await generateAdaptiveProposal(p, new AbortController().signal);
  assert.ok(!seen.at(-1).messages[1].content.includes('synthetic-adaptive-key'));
  assert.equal(queue.source(first)!.text, '周末准备去河边散步。');
  await assert.rejects(boundedProposal(async () => new Promise(() => {}), new AbortController().signal, 5), /中止/);
});

test('增量输入不含未处理未来消息；取消任务不会安装，重新实例化队列不复活取消回执', async () => {
  const second = store.addMessage('user', '合成', '先说今天见到老同学。', { session: 'synthetic' });
  store.addMessage('user', '合成', '未来检查点才出现的纠正。', { session: 'synthetic' });
  let input: any;
  const options = { queue, archive, exclusive, enabled: () => true, signal: new AbortController().signal };
  const result = await processSemanticNext({ ...options, generate: async (p) => { input = JSON.parse(p.user); return { contexts: [], records: [] }; } });
  assert.equal(result.status, 'unchanged'); assert.equal(result.source, second);
  assert.ok(!JSON.stringify(input).includes('未来检查点'));
  const before = archive.generation();
  const cancelled = await processSemanticNext({ ...options, claimed: (job) => queue.cancel(job.id), generate: async () => ({ contexts: [], records: [] }) });
  assert.equal(cancelled.status, 'stale'); assert.equal(archive.generation(), before);
  const reopened = new AdaptiveStore(store.db, identity().id);
  assert.equal(reopened.status('semantic-v1').counts.cancelled, 1);
  assert.equal((await processSemanticNext({ ...options, queue: reopened, generate: async () => { throw new Error('不应复活'); } })).status, 'idle');
});

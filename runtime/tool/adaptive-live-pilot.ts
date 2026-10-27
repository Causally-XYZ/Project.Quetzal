// 公开开发案例的真实宿主试跑；与正式留出集、真人和多身体/UI 验收分开。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { adcFetch, loadAdc, vertexModels, vertexPlaceholder, type VertexReceipt } from './adaptive-vertex-transport.ts';

const model = process.argv.find((a) => a.startsWith('--model='))?.slice(8) ?? vertexModels[1];
if (!vertexModels.includes(model)) throw new Error('模型不在已批准的开发列表内');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-adaptive-live-'));
process.env.QUETZAL_HOME = home;
const dataset = {
  id: 'AM-02-live-development-v1',
  episodes: [
    ['2026-01-10T12:00:00Z', '我的编辑叫周宁，工作室里叫他阿舟。我的弟弟叫周宇，家里也叫他阿舟。'],
    ['2026-04-10T12:00:00Z', '昨晚和阿舟吃饭，他说别急着下结论。我决定周末再去港口采风。'],
    ['2026-06-10T12:00:00Z', '更正：四月那顿饭的阿舟是我弟弟周宇，不是编辑周宁。另外“别急着下结论”其实是我说的，我上次说反了。周末去港口采风的决定没有变。'],
  ],
  question: '回顾一下：四月和我吃饭的是谁，“别急着下结论”是谁说的？我的编辑叫什么？周末采风的决定后来变了吗？请按目前已有的认识简短回答；没有依据就明确说不确定，不执行其他操作。',
  required: ['两个现实人物不合并；昵称均保留。', '第二步饭友和引语说话人不强行消歧。',
    '第三步改为弟弟周宇和用户本人；原节点修订，不把旧归属继续当作事实。', '编辑身份和周末采风决定保留。'],
};
fs.writeFileSync(path.join(home, 'dataset.json'), JSON.stringify(dataset, null, 2));
const report: any = { schema: 'quetzal-adaptive-live-development-v1', model, dataset: dataset.id,
  datasetHash: crypto.createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),
  status: 'running', calls: [], transport: [], checkpoints: [],
  limits: '开发资料，非正式留出集；实际宿主/路由/Google适配器/对话循环，ADC仅注入传输认证；未测多身体/UI，未隔离其他历史召回，不能证明回答收益仅来自新图。' };
const save = () => fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
save(); console.log(JSON.stringify({ home, case: dataset.id, model }));
const cfg = await import('../src/config.ts'); cfg.loadConfig();
cfg.saveConfig({ body: 'center', adaptiveMemory: { enabled: true, hostBody: 'center', semantic: true },
  brain: { memorySemantic: false, memoryLearning: false }, guard: { sentinel: { enabled: false } } });
const store = await import('../src/store.ts'); store.openStore();
await (await import('../src/memory/soul-sync.ts')).ensureSoul();
const { identity } = await import('../src/memory/identity.ts');
const { AdaptiveStore } = await import('../src/memory/adaptive-store.ts');
const { AdaptiveArchive } = await import('../src/memory/adaptive-archive.ts');
const { exclusive } = await import('../src/memory/memory.ts');
const queue = new AdaptiveStore(store.db, identity().id), archive = new AdaptiveArchive(queue, cfg.paths.soul);
const registry = await import('../src/providers/registry.ts');
registry.saveProviders({ providers: [{ id: 'development-adc', name: '开发 ADC', catalogId: 'custom', enabled: true,
  baseUrl: vertexPlaceholder, protocol: 'google-generative-ai',
  keys: [{ id: 'placeholder', label: '开发占位', enabled: true, lastFour: '', secret: 'synthetic-noncredential' }],
  models: [{ id: model, name: model, enabled: true, context: 131072, maxTokens: 16384, sortOrder: 0 }],
}] }, registry.configVersion());
const { adapters } = await import('../src/providers/adapters.ts');
const { ProviderError } = await import('../src/providers/types.ts');
const originalAdapter = adapters['google-generative-ai'], originalFetch = globalThis.fetch;
const deadline = new AbortController();
const pending = new Set<Promise<unknown>>();
let phase = 'setup', callCount = 0;
globalThis.fetch = adcFetch(originalFetch, loadAdc, (receipt: VertexReceipt) => { report.transport.push(receipt); save(); });
const runAdapter: typeof originalAdapter = async (target, request) => {
  if (++callCount > 12) throw new ProviderError('开发试验请求预算耗尽', 0, true);
  const purpose = request.messages[0]?.content.includes('Return exactly one JSON object conforming to this response schema.') ? 'proposal' : 'conversation';
  const call: any = { phase, purpose, model: target.model, start: Date.now(), messages: structuredClone(request.messages), state: 'running' };
  report.calls.push(call); save();
  try {
    const result = await originalAdapter(target, { ...request, signal: request.signal ? AbortSignal.any([request.signal, deadline.signal]) : deadline.signal,
      onChunk: () => { call.firstChunkMs ??= Date.now() - call.start; request.onChunk?.(); },
      onText: (text) => { call.firstTextMs ??= Date.now() - call.start; request.onText?.(text); } });
    Object.assign(call, { state: 'returned', completedAt: Date.now(), elapsedMs: Date.now() - call.start, result }); save(); return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const category = /没有收到任何数据|没有任何内容/.test(message) ? 'idle-timeout'
      : /中止/.test(message) || deadline.signal.aborted || request.signal?.aborted ? 'cancelled'
      : error instanceof ProviderError && error.status ? 'http' : 'transport-or-protocol';
    Object.assign(call, { state: 'failed', completedAt: Date.now(), elapsedMs: Date.now() - call.start, failure: { category,
      status: error instanceof ProviderError ? error.status : null, usage: null } }); save();
    throw new ProviderError('开发试验模型调用失败，详情仅保留白名单状态', 0, true); }
};
adapters['google-generative-ai'] = (target, request) => {
  const task = runAdapter(target, request); pending.add(task);
  void task.then(() => pending.delete(task), () => pending.delete(task)); return task;
};
const host = await import('../src/memory/adaptive.ts');
const brain = await import('../src/mind/brain.ts');
const wall = setTimeout(() => {
  fs.writeFileSync(cfg.paths.stop, 'development-timeout'); deadline.abort(); void brain.stopTurn('synthetic-answer', { local: true });
}, 480_000);
async function eventually(check: () => boolean, timeout = 180_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end || fs.existsSync(cfg.paths.stop)) throw new Error('开发试验等待超时');
    if (queue.jobs().some((job) => job.processor === 'semantic-v1' && job.error)) throw new Error('后台处理失败；本次试跑保留首次失败，不等待后台重试');
    await new Promise((r) => setTimeout(r, 100));
  }
}
try {
  host.startAdaptiveMemory();
  for (const [index, [at, text]] of dataset.episodes.entries()) {
    phase = `episode-${index + 1}`;
    const conv = `synthetic-episode-${index + 1}`; store.ensureSession(conv, '合成采风');
    const start = Date.now(), source = store.addMessage('user', '合成试用', text, { session: conv });
    // 只固定公开案例的原始时间；随后由正常定时器观察和处理，不能手工接受任何提案。
    store.db.prepare('UPDATE messages SET ts=? WHERE id=?').run(Date.parse(at), source);
    await eventually(() => !!queue.processed(source, 'semantic-v1'));
    await eventually(() => Number(store.db.prepare("SELECT COUNT(*) n FROM adaptive_publications WHERE state<>'published'").get()!.n) === 0);
    const records = await exclusive(() => archive.current());
    const checkpoint = { episode: index + 1, source, elapsedMs: Date.now() - start, records,
      query: await host.queryAdaptiveSemantic('阿舟 四月 吃饭 下结论 编辑 周末 港口 采风'), status: host.adaptiveStatus() };
    report.checkpoints.push(checkpoint); save();
    console.log(JSON.stringify({ episode: index + 1, records: records.length, elapsedMs: checkpoint.elapsedMs }));
  }
  phase = 'answer';
  const start = Date.now();
  report.answer = await brain.converse('合成试用者', dataset.question, '合成试用', { conv: 'synthetic-answer' });
  report.answerElapsedMs = Date.now() - start;
  report.plan = store.kv.get('context.plan.synthetic-answer', null);
  report.status = 'pipeline-completed-needs-semantic-review';
} catch (error) {
  report.status = 'failed'; report.failure = error instanceof Error && error.message.startsWith('后台处理失败') ? 'background-failed' : 'development-run-failed';
  process.exitCode = 1;
} finally {
  clearTimeout(wall); report.shutdownAt = Date.now(); await host.stopAdaptiveMemory(); await Promise.allSettled([...pending]);
  // 回答期间正常后台可能开始处理刚收到的问题；试跑结束时中止此额外工作，不冒充模型成功，也不混同必需检查点失败。
  for (const call of report.calls) if (call.phase === 'answer' && call.purpose === 'proposal' && call.failure?.category === 'cancelled' && call.completedAt >= report.shutdownAt)
    call.state = 'cancelled-at-shutdown';
  if (report.status !== 'failed') {
    if (deadline.signal.aborted || !report.answer || report.calls.some((c: any) => c.state !== 'returned' && c.state !== 'cancelled-at-shutdown' || c.result?.truncated)) {
      report.status = 'pipeline-incomplete'; process.exitCode = 1;
    }
    if (!report.transport.length || report.transport.some((r: VertexReceipt) => r.versions.length !== 1 || r.versions[0] !== model || !r.finish.includes('STOP'))) {
      report.status = 'model-metadata-incomplete-or-unexpected'; process.exitCode = 1;
    }
  }
  report.finalStatus = host.adaptiveStatus(); report.finalQueue = queue.status('semantic-v1'); report.finalJobs = queue.jobs(100); save();
  adapters['google-generative-ai'] = originalAdapter; globalThis.fetch = originalFetch;
  console.log(JSON.stringify({ home, status: report.status, calls: report.calls.length, checkpoints: report.checkpoints.length }));
}

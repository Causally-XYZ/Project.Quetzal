// 显式联网的部署开发验收：真实 npm ci、固定公开模型续传、正常中心生命周期与原生 worker。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveVectorRetriever, VECTOR_SPACE } from '../../src/memory/adaptive-vector.ts';
import { semanticDigest } from '../../src/memory/adaptive-query.ts';
import { seedReadWorkload } from '../adaptive-read-workload.ts';
import { prepareAdaptiveComponent } from '../../src/memory/adaptive-component.ts';

const work = fs.realpathSync(process.argv[2]), prepared = fs.realpathSync(process.argv[3]);
const repo = fs.realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
assert(work !== repo && !work.startsWith(repo + path.sep));
const home = fs.mkdtempSync(path.join(work, 'deployment-'));
process.env.QUETZAL_HOME = home;
const component = path.join(home, 'data/adaptive-retrieval/component'); fs.mkdirSync(path.join(component, 'model/onnx'), { recursive: true });
// 准备外部公开缓存，不复制 node_modules、完成标记或用户记忆；明确不算全冷下载计时。
fs.cpSync(path.join(prepared, 'npm-cache'), path.join(home, 'data/adaptive-retrieval/npm-cache'), { recursive: true });
for (const name of ['config.json', 'special_tokens_map.json', 'tokenizer_config.json', 'tokenizer.json'])
  fs.copyFileSync(path.join(prepared, 'component/model', name), path.join(component, 'model', name));
const weights = fs.readFileSync(path.join(prepared, 'component/model/onnx/model_quantized.onnx'));
fs.writeFileSync(path.join(component, 'model/onnx/model_quantized.onnx.part'), weights.subarray(0, weights.length - 1024));

const cfg = await import('../../src/config.ts'); cfg.loadConfig();
cfg.saveConfig({ body: 'center', adaptiveMemory: { enabled: true, hostBody: 'center', semantic: true } });
const store = await import('../../src/store.ts'); store.openStore();
const soul = await import('../../src/memory/soul-sync.ts'); await soul.ensureSoul();
const { identity } = await import('../../src/memory/identity.ts');
const { AdaptiveStore } = await import('../../src/memory/adaptive-store.ts');
const { AdaptiveArchive } = await import('../../src/memory/adaptive-archive.ts');
const host = await import('../../src/memory/adaptive.ts');
const queue = new AdaptiveStore(store.db, identity().id), archive = new AdaptiveArchive(queue, cfg.paths.soul);
seedReadWorkload(queue, cfg.paths.soul, 2);
const originalFetch = globalThis.fetch; let fetches = 0;
globalThis.fetch = (...args) => { fetches++; return originalFetch(...args); };
const report: any = { kind: 'actual-component-deployment', modelSpace: VECTOR_SPACE, cachePrefilled: true, weightBytesRemaining: 1024, checks: [], states: [],
  sourceHashes: Object.fromEntries(['adaptive-component.ts', 'adaptive-vector.ts', 'adaptive-vector-worker.ts', 'adaptive.ts'].map((name) => [name,
    crypto.createHash('sha256').update(fs.readFileSync(new URL(`../../src/memory/${name}`, import.meta.url))).digest('hex')])) };
let backend: AdaptiveVectorRetriever | undefined, blocker: DatabaseSync | undefined;
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(check: () => boolean, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('development_timeout'); await tick(); }
}
function ready() { const s = host.adaptiveStatus().retrieval; return 'current' in s && s.current && s.pending === 0 && s.indexed === 2; }
try {
  const start = performance.now(); host.startAdaptiveMemory();
  assert.equal(host.adaptiveStatus().retrieval.state, 'preparing');
  const queryStart = performance.now(), during = await host.queryAdaptiveSemantic('港口采风');
  report.queryDuringPreparationMs = performance.now() - queryStart;
  assert.equal(during.status, 'ready'); assert.equal(during.items.length, 2); assert(report.queryDuringPreparationMs < 500);
  let last = '';
  await until(() => {
    const state = host.adaptiveStatus().retrieval, key = state.state + ('preparation' in state ? ':' + state.preparation.phase : '');
    if (key !== last) { report.states.push({ elapsedMs: performance.now() - start, ...state }); last = key; }
    return ready();
  });
  report.preparedMs = performance.now() - start; report.initialFetches = fetches; assert.equal(fetches, 1);
  assert.equal((await host.queryAdaptiveSemantic('沿海走访材料')).items.length, 2);
  report.checks.push('中心启动自动安装并续传模型，准备期间前台词面读取可用');
  await host.stopAdaptiveMemory();
  const packageRoot = path.join(component, 'node_modules/@huggingface/transformers');
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const entry = path.join(packageRoot, metadata.exports.node.import.default);
  fs.unlinkSync(entry); fetches = 0;
  const repairStart = performance.now(); host.startAdaptiveMemory();
  await until(() => { const state = host.adaptiveStatus().retrieval; return 'error' in state && state.error === 'component_load_failed'; }, 10_000);
  assert.equal((await host.queryAdaptiveSemantic('港口采风')).items.length, 2);
  await until(ready); report.dependencyRepairMs = performance.now() - repairStart;
  assert(fs.existsSync(entry)); assert.equal(fetches, 0);
  report.checks.push('库文件损坏时自动识别、退避重装并恢复；故障期间仍可词面查询');
  await host.stopAdaptiveMemory();
  const dependencyTime = fs.statSync(path.join(component, 'dependencies.json')).mtimeMs;
  const cache = path.join(cfg.paths.data, 'adaptive-retrieval', `${semanticDigest(identity().id)}.sqlite`);
  const broken = Buffer.from('公开合成损坏索引'); fs.writeFileSync(cache, broken);
  fetches = 0; host.startAdaptiveMemory(); await until(ready);
  const recovered = host.adaptiveStatus().retrieval; assert('cacheRecovered' in recovered && recovered.cacheRecovered);
  assert.equal(fetches, 0); assert.equal(fs.statSync(path.join(component, 'dependencies.json')).mtimeMs, dependencyTime);
  const quarantines = fs.readdirSync(path.dirname(cache)).filter((name) => name.startsWith(path.basename(cache) + '.damaged-') && !name.endsWith('-wal') && !name.endsWith('-shm'));
  assert.equal(quarantines.length, 1); assert.deepEqual(fs.readFileSync(path.join(path.dirname(cache), quarantines[0])), broken);
  assert.equal((await host.queryAdaptiveSemantic('沿海走访材料')).items.length, 2);
  report.recovered = recovered; report.checks.push('重启复用已核验组件，无网络或重复安装；损坏派生库隔离并自动重建');
  await host.stopAdaptiveMemory();

  const candidates = archive.candidates(), retryCache = path.join(cfg.paths.data, 'retry.sqlite'); assert.equal(candidates.length, 2);
  backend = new AdaptiveVectorRetriever({ root: component, cache: retryCache, agent: identity().id });
  backend.replace(candidates.slice(0, 1)); await until(() => backend!.status().current && backend!.status().indexed === 1, 30_000);
  blocker = new DatabaseSync(retryCache); blocker.exec('BEGIN IMMEDIATE');
  backend.replace(candidates);
  await until(() => backend!.status().retrying === 1, 10_000);
  assert.equal(backend.status().indexed, 1); report.locked = backend.status();
  blocker.exec('ROLLBACK'); blocker.close(); blocker = undefined;
  const retryStart = performance.now();
  await until(() => backend!.status().indexed === 2 && backend!.status().pending === 0, 10_000);
  report.retryMs = performance.now() - retryStart; report.retried = backend.status();
  assert.equal(report.retried.retrying, 0); assert.equal(report.retried.cacheRecovered, false);
  assert((await backend.query('港口采风'))?.keys.includes(candidates[1].key));
  report.checks.push('真实 SQLite 写锁造成暂时失败，释放后无需新输入自动重试，不把 busy 当作损坏');
  const cancelledRoot = path.join(cfg.paths.data, 'adaptive-retrieval/cancelled-component'), controller = new AbortController();
  const pending = prepareAdaptiveComponent(cancelledRoot, controller.signal).then(() => 'completed', (error) => error.name);
  const pidFile = path.join(cancelledRoot, 'npm.pid'); await until(() => fs.existsSync(pidFile), 10_000);
  const pid = Number(fs.readFileSync(pidFile, 'utf8')); assert(Number.isSafeInteger(pid) && pid > 0);
  controller.abort(); assert.equal(await pending, 'AbortError');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); assert(!fs.existsSync(pidFile)); assert(!fs.existsSync(path.join(cancelledRoot, 'prepared.json')));
  fs.cpSync(path.join(component, 'model'), path.join(cancelledRoot, 'model'), { recursive: true });
  await prepareAdaptiveComponent(cancelledRoot, new AbortController().signal); assert(fs.existsSync(path.join(cancelledRoot, 'prepared.json')));
  report.checks.push('取消正在执行的真实 npm 安装后子进程退出，重启无需手动清理即可补齐');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error instanceof Error && !/https?:|\/Users\//.test(error.message) ? error.message : 'development_failure'; process.exitCode = 1;
} finally {
  if (blocker) { try { blocker.exec('ROLLBACK'); } finally { blocker.close(); } }
  await backend?.close(); await host.stopAdaptiveMemory(); globalThis.fetch = originalFetch;
  assert.equal(cfg.config.soul.remote, ''); await soul.idle(); await soul.push('合成部署实验收尾'); store.db.close();
  const target = path.join(home, 'report.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: target, status: report.status, checks: report.checks, preparedMs: report.preparedMs,
    queryDuringPreparationMs: report.queryDuringPreparationMs, retryMs: report.retryMs, failure: report.failure }, null, 2));
}

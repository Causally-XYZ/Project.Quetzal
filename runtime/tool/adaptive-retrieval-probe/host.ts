// 明确运行的真实本机组件 / 权威存档 / 宿主查询实验；没有 LLM，没有正式留出输入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AdaptiveVectorRetriever, VECTOR_SPACE } from '../../src/memory/adaptive-vector.ts';
import type { ClaimRecord, SourceSpan } from '../../src/memory/adaptive-evidence.ts';

const root = fs.realpathSync(process.argv[2]);
const repo = fs.realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
assert(root !== repo && !root.startsWith(repo + path.sep));
const home = fs.mkdtempSync(path.join(root, 'host-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../../src/config.ts'); cfg.loadConfig();
cfg.saveConfig({ body: 'center', adaptiveMemory: { enabled: true, hostBody: 'center', semantic: true } });
const store = await import('../../src/store.ts'); store.openStore();
const soul = await import('../../src/memory/soul-sync.ts'); await soul.ensureSoul();
const { identity } = await import('../../src/memory/identity.ts');
const { AdaptiveStore } = await import('../../src/memory/adaptive-store.ts');
const { AdaptiveArchive } = await import('../../src/memory/adaptive-archive.ts');
const { markBusy } = await import('../../src/heart/heart.ts');
const host = await import('../../src/memory/adaptive.ts');
host.setAdaptiveComponentPreparer(async (root) => fs.existsSync(path.join(root, 'node_modules'))); // 本实验复用已核验组件；首次安装另测。
const casesBytes = fs.readFileSync(new URL('cases.json', import.meta.url));
const cases = JSON.parse(casesBytes.toString()) as { documents: string[][]; queries: { id: string; query: string; relevant: string[] }[] };
const queue = new AdaptiveStore(store.db, identity().id), archive = new AdaptiveArchive(queue, cfg.paths.soul);
const objects = new Map<string, { source: number; record: ClaimRecord }>();
store.ensureSession('fixture', '公开检索合成资料');
function accept(label: string, text: string) {
  const previous = objects.get(label), source = store.addMessage('user', '合成', text, { session: 'fixture' });
  queue.schedule();
  const s = queue.source(source)!;
  const span: SourceSpan = { kind: 'source', source, hash: s.hash, start: 0, end: text.length, quote: text };
  const record: ClaimRecord = { id: previous?.record.id ?? crypto.randomUUID(), revision: (previous?.record.revision ?? 0) + 1,
    kind: 'claim', state: 'present', realm: { world: 'real', context: 'real' }, reasons: [span], text,
    nature: 'reported', participants: [], occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
    supports: [{ id: 'direct', premises: [span], assumptions: [] }], counters: [] };
  queue.scheduleSource(`probe-${label}-${record.revision}`, source);
  assert(archive.accept(queue.claim(`probe-${label}-${record.revision}`)!, [{ id: source, hash: s.hash, revision: s.revision }], { baseGeneration: archive.generation(), records: [record] }));
  objects.set(label, { source, record }); return record;
}
const report: any = { kind: 'actual-vector-host-development', space: VECTOR_SPACE, casesHash: crypto.createHash('sha256').update(casesBytes).digest('hex'),
  sourceHashes: Object.fromEntries(['adaptive-vector.ts', 'adaptive-vector-worker.ts', 'adaptive.ts', 'adaptive-query.ts'].map((name) => [name, crypto.createHash('sha256').update(fs.readFileSync(new URL(`../../src/memory/${name}`, import.meta.url))).digest('hex')])), checks: [], rows: [] };
let backend: AdaptiveVectorRetriever | undefined, detach: (() => void) | undefined;
const check = (name: string) => report.checks.push(name);
async function settled(expected: number) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const status = backend!.status();
    assert.notEqual(status.state, 'failed'); assert.equal(status.errors, 0);
    if (status.state === 'ready' && status.current && status.indexed === expected && status.pending === 0) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('index_timeout');
}
try {
  for (const [id, , text] of cases.documents) accept(id, text);
  markBusy(true); host.startAdaptiveMemory();
  for (const q of cases.queries) {
    const result = await host.queryAdaptiveSemantic(q.query);
    assert.equal(result.status, 'ready'); report.rows.push({ ...q, lexical: result.items.map((x) => [...objects].find(([, o]) => o.record.id === x.id)![0]) });
  }
  const options = { root, cache: path.join(cfg.paths.data, 'adaptive-vectors.sqlite'), agent: identity().id };
  backend = new AdaptiveVectorRetriever(options); detach = host.setAdaptiveRetriever(identity().id, backend);
  await host.refreshAdaptiveRetrieval(); report.initial = await settled(30); check('真实 worker 完成当前存档30项索引');
  const durations: number[] = [];
  for (let repeat = 0; repeat < 3; repeat++) for (const q of cases.queries) {
    const start = performance.now(), result = await host.queryAdaptiveSemantic(q.query); durations.push(performance.now() - start);
    assert.equal(result.status, 'ready');
    if (!repeat) report.rows.find((r: any) => r.id === q.id).hybrid = result.items.map((x) => [...objects].find(([, o]) => o.record.id === x.id)![0]);
  }
  const positives = report.rows.filter((r: any) => r.relevant.length);
  report.hit6 = Object.fromEntries(['lexical', 'hybrid'].map((method) => [method, positives.filter((r: any) => r[method].some((id: string) => r.relevant.includes(id))).length]));
  assert(report.hit6.hybrid > report.hit6.lexical); check('实际宿主改述召回优于同输入词面基线');
  durations.sort((a, b) => a - b); report.queryP50Ms = durations[22]; report.queryP95Ms = durations[42]; assert(report.queryP95Ms < 500);
  const revised = accept('dinner', '更正：周五约我吃火锅的是弟弟，编辑没有发出这次邀请。');
  const stale = await host.queryAdaptiveSemantic('一起涮肉的那位到底是哪一个人？');
  assert(!stale.items.some((x) => x.id === revised.id && x.revision === 1)); check('索引尚未刷新时，旧认识版本已被宿主剔除');
  await host.refreshAdaptiveRetrieval(); report.corrected = await settled(30);
  assert((await host.queryAdaptiveSemantic('一起涮肉的那位到底是哪一个人？')).items.some((x) => x.id === revised.id && x.revision === 2)); check('后台增量索引新版本后改述查询命中纠正');
  detach(); await backend.close(); backend = new AdaptiveVectorRetriever(options); detach = host.setAdaptiveRetriever(identity().id, backend);
  await host.refreshAdaptiveRetrieval(); report.restart = await settled(30);
  assert.equal(report.restart.reused, 30); assert.equal(report.restart.computed, 0); check('重启复用相同模型空间与候选版本的持久向量');
  store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(objects.get('dinner')!.source);
  assert(!(await host.queryAdaptiveSemantic('一起涮肉的那位到底是哪一个人？')).items.some((x) => x.id === revised.id));
  await host.refreshAdaptiveRetrieval(); report.ignored = await settled(29); check('来源忽略立即阻止返回，后台清理旧向量');
  detach(); await backend.close();
  const corrupt = fs.readFileSync(options.cache); assert(corrupt.length > 0);
  const { DatabaseSync } = await import('node:sqlite');
  const cache = new DatabaseSync(options.cache); cache.prepare("UPDATE vectors SET value='[]' WHERE key=(SELECT key FROM vectors LIMIT 1)").run(); cache.close();
  backend = new AdaptiveVectorRetriever(options); detach = host.setAdaptiveRetriever(identity().id, backend);
  await host.refreshAdaptiveRetrieval(); report.repair = await settled(29);
  assert.equal(report.repair.reused, 28); assert.equal(report.repair.computed, 1); check('损坏缓存只重建受影响候选，不信任损坏向量');
  // 长输入通过合法的多段来源引文组成，核心线索位于512 token之后。
  const text = '今天的天气没有变化。'.repeat(500) + '修表匠把蓝色钥匙藏在旧钟的摆锤后面。';
  const long = accept('long-tail', text);
  await host.refreshAdaptiveRetrieval();
  const concurrentStart = performance.now(), concurrent = await host.queryAdaptiveSemantic('吵架后不住在一起了，小孩的抚养目前怎么商议？');
  report.queryDuringIndexMs = performance.now() - concurrentStart;
  report.queryDuringIndex = { status: concurrent.status, items: concurrent.items.map((x) => [...objects].find(([, o]) => o.record.id === x.id)?.[0]), backend: backend.status() };
  assert(report.queryDuringIndexMs < 500); assert(concurrent.items.some((x) => x.id === objects.get('family')!.record.id));
  check('长文增量索引期间，前台查询优先完成');
  report.long = await settled(30);
  assert((await host.queryAdaptiveSemantic('钟表维修者把开启门锁的东西放到哪里？')).items.some((x) => x.id === long.id)); check('实际分块找回超过512 token的末尾线索');
  detach(); await backend.close(); backend = undefined; detach = undefined;
  // 只复用已经实装、摘要核查过的组件，验证正常 runtime 生命周期，不冒充首次自动安装验收。
  const componentRoot = host.adaptiveVectorComponentRoot(); fs.mkdirSync(componentRoot, { recursive: true });
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(componentRoot, 'package-lock.json'));
  for (const name of ['model', 'node_modules']) fs.symlinkSync(path.join(root, name), path.join(componentRoot, name), 'dir');
  markBusy(false); await host.stopAdaptiveMemory(); host.startAdaptiveMemory();
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const status = host.adaptiveStatus().retrieval;
    if ('current' in status && status.current && status.indexed === 30 && status.pending === 0) break;
    assert.notEqual(status.state, 'failed'); await new Promise((resolve) => setTimeout(resolve, 20));
  }
  report.auto = host.adaptiveStatus().retrieval;
  assert.equal(report.auto.indexed, 30); assert.equal(report.auto.pending, 0);
  assert((await host.queryAdaptiveSemantic('钟表维修者把开启门锁的东西放到哪里？')).items.some((x) => x.id === long.id));
  await host.stopAdaptiveMemory(); assert.equal(host.adaptiveStatus().retrieval.state, 'inactive');
  check('已准备组件随中心启动自动加载、索引、查询，并随停止释放 worker');
  const interruptedOptions = { ...options, cache: path.join(cfg.paths.data, 'interrupted.sqlite') };
  backend = new AdaptiveVectorRetriever(interruptedOptions);
  const longCandidate = archive.candidatePage().entries.filter((e) => e.id === long.id).flatMap((e) => e.candidate ? [{ ...e.candidate, item: { id: e.id } }] : []); assert.equal(longCandidate.length, 1);
  backend.replace(longCandidate);
  const stopDeadline = Date.now() + 10_000;
  while (Date.now() < stopDeadline && !(backend.status().current && backend.status().pending === 1)) {
    assert.notEqual(backend.status().state, 'failed'); await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(backend.status().pending, 1);
  const stopStart = performance.now(); await backend.close(); report.stopDuringIndexMs = performance.now() - stopStart;
  backend = new AdaptiveVectorRetriever(interruptedOptions); backend.replace(longCandidate);
  report.interruptedRecovery = await settled(1); assert.equal(report.interruptedRecovery.computed, 1);
  check('索引进行中关闭等待原生调用释放；重启补做未提交候选');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error instanceof Error ? error.message : 'failure'; process.exitCode = 1;
} finally {
  detach?.(); await backend?.close(); await host.stopAdaptiveMemory();
  assert.equal(cfg.config.soul.remote, ''); await soul.idle(); await soul.push('合成向量实验收尾'); store.db.close();
  const destination = path.join(root, `host-report-${Date.now()}.json`);
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report: destination, status: report.status, checks: report.checks, hit6: report.hit6, queryP95Ms: report.queryP95Ms, failure: report.failure }, null, 2));
}

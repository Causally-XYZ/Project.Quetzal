// 实际宿主 + 固定本机E5；缓存向量为合成单位向量，新增一条及查询实际嵌入，不测语义质量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import { seedReadWorkload } from '../tool/adaptive-read-workload.ts';
import { AdaptiveVectorRetriever, VECTOR_SPACE, type VectorBatch } from '../src/memory/adaptive-vector.ts';
import { semanticDigest } from '../src/memory/adaptive-query.ts';
import { retrievalInventory, retrievalSnapshotReady } from '../tool/adaptive-eval/retrieval-observer.ts';

const component = process.env.QUETZAL_TEST_VECTOR_COMPONENT;
test('实际宿主：分页跨1000、来源独立变更、ACK重放与重启完整清单', { skip: !component, timeout: 90_000 }, async (t) => {
  const started = performance.now(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-retrieval-capacity-'));
  process.env.QUETZAL_HOME = home;
  const cfg = await import('../src/config.ts'); cfg.loadConfig();
  cfg.saveConfig({ body: 'reader', adaptiveMemory: { enabled: true, hostBody: 'reader', semantic: true } });
  const store = await import('../src/store.ts'); store.openStore();
  const soul = await import('../src/memory/soul-sync.ts'); await soul.ensureSoul();
  const { identity } = await import('../src/memory/identity.ts');
  const { AdaptiveStore } = await import('../src/memory/adaptive-store.ts');
  const { AdaptiveArchive } = await import('../src/memory/adaptive-archive.ts');
  const host = await import('../src/memory/adaptive.ts');
  const { markBusy } = await import('../src/heart/heart.ts');
  markBusy(true); // 只显式驱动正式刷新，不让500ms后台tick改变故障注入时序。
  const queue = new AdaptiveStore(store.db, identity().id), archive = new AdaptiveArchive(queue, cfg.paths.soul);
  const exits: number[] = [], workers = new Set<AdaptiveVectorRetriever>();
  const batches: VectorBatch[] = [];
  let backend: AdaptiveVectorRetriever | undefined, loseFinalAck = true;
  const apply = AdaptiveVectorRetriever.prototype.applyBatch;
  t.mock.method(AdaptiveVectorRetriever.prototype, 'applyBatch', async function(this: AdaptiveVectorRetriever, batch: VectorBatch) {
    backend = this; batches.push(structuredClone(batch));
    if (!workers.has(this)) {
      workers.add(this);
      (this as unknown as { worker: Worker }).worker.once('exit', (code) => exits.push(code));
    }
    assert.ok(batch.upsert.length + batch.remove.length <= 32, '宿主消息有界，不把全库搬到worker');
    const ack = await apply.call(this, batch);
    if (batch.complete && loseFinalAck) { loseFinalAck = false; throw new Error('synthetic_lost_ack'); }
    return ack;
  });
  const restorePreparer = host.setAdaptiveComponentPreparer(async (root) => {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    if (!fs.existsSync(root)) fs.symlinkSync(component!, root, 'dir');
    return true;
  });
  let check: DatabaseSync | undefined;
  t.after(async () => {
    await host.stopAdaptiveMemory(); restorePreparer(); check?.close();
    await soul.idle(); store.db.close(); fs.rmSync(home, { recursive: true, force: true });
    assert.equal(workers.size, 2); assert.deepEqual(exits, [0, 0], '两个真实worker均正常dispose退出');
  });
  seedReadWorkload(queue, cfg.paths.soul, 1001);
  const entries = [];
  for (let cursor = ''; ;) {
    const page = archive.candidatePage(cursor); entries.push(...page.entries);
    if (page.done) break; cursor = page.next;
  }
  assert.equal(entries.length, 1001); assert(entries.every((e) => e.candidate));
  const first = entries[0], last = entries.at(-1)!;
  const sourceFor = (id: string) => archive.readLocal((lookup) => {
    const record = lookup.get(id)!;
    const span = record.reasons.find((r) => r.kind === 'source'); assert(span?.kind === 'source'); return span.source;
  });
  const lastSource = sourceFor(last.id), firstSource = sourceFor(first.id);
  const generation = archive.generation();
  store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(lastSource);
  const cache = path.join(cfg.paths.data, 'adaptive-retrieval', `${semanticDigest(identity().id)}.sqlite`);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  const seed = new DatabaseSync(cache);
  seed.exec('CREATE TABLE vectors(agent TEXT,space TEXT,key TEXT,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(agent,space,key))');
  const value = JSON.stringify([Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0)]);
  const digest = crypto.createHash('sha256').update(value).digest('hex');
  for (const e of entries.slice(0, -1)) seed.prepare('INSERT INTO vectors VALUES(?,?,?,?,?)').run(identity().id, VECTOR_SPACE, e.candidate!.key, value, digest);
  seed.close();
  const status = () => host.adaptiveStatus().retrieval as { state: string; current?: boolean; hostCurrent?: boolean; indexed?: number; pending?: number };
  const until = async (condition: () => boolean) => {
    const deadline = performance.now() + 20_000;
    while (!condition()) {
      assert.notEqual(status().state, 'failed'); assert(performance.now() < deadline, JSON.stringify(status()));
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const drain = async () => {
    for (let count = 0; count < 150; count++) {
      await host.refreshAdaptiveRetrieval();
      if (status().current) return;
    }
    assert.fail(`清单未追平: ${JSON.stringify(status())}`);
  };
  host.startAdaptiveMemory(); await until(() => status().state === 'ready');
  let failed = false;
  for (let count = 0; count < 150 && !failed; count++) {
    try { await host.refreshAdaptiveRetrieval(); }
    catch (error) { assert.match(String(error), /synthetic_lost_ack/); failed = true; }
  }
  assert(failed, '确实在worker已持久化末批之后丢失ACK');
  assert.equal(backend!.status().current, true);
  assert.equal(status().current, false, 'worker旧完成状态不能替宿主未确认清单声称ready');
  assert.equal(archive.retrievalState().complete, false);
  const lost = structuredClone(batches.at(-1)!);
  await host.refreshAdaptiveRetrieval();
  assert.deepEqual(batches.at(-1), lost, '重发同一epoch/seq/payload，不跳过失败页');
  await drain(); await until(() => status().indexed === 1000 && status().pending === 0);
  check = new DatabaseSync(cache, { readOnly: true });
  const catalog = (id: string) => check!.prepare('SELECT key FROM vector_catalog WHERE id=?').get(id)?.key;
  assert.equal(catalog(first.id), first.candidate!.key); assert.equal(catalog(last.id), undefined);

  store.db.prepare('UPDATE messages SET mode=NULL WHERE id=?').run(lastSource);
  assert.equal(archive.generation(), generation);
  assert.equal(status().current, false, '来源票据变化立即使宿主清单不再current');
  await drain(); await until(() => status().indexed === 1001 && status().pending === 0);
  assert.equal(catalog(last.id), last.candidate!.key); assert.equal(catalog(first.id), first.candidate!.key);
  assert.equal(backend!.status().computed, 1, '只新增一条实际E5嵌入，旧1000条不重算');
  const inventory = retrievalInventory(archive, cache, identity().id);
  assert.equal(inventory.expected.length, 1001);
  assert.deepEqual(inventory.observed, inventory.expected, '独立取证库存逐项匹配真实worker持久清单');
  assert.equal(retrievalSnapshotReady({ status: host.adaptiveStatus(), retrievalInventory: inventory,
    retrievalExpected: semanticDigest(inventory.expected) }), true, '正式开发回执能识别实际已追平的分页索引');
  const query = '海湾访问计划'; // 不直接复述来源词面；合成缓存只检验路径，不评价语义质量。
  await backend!.query(query); // 明确一次冷查询；生产100ms预算不延长。
  let receivedKeys: string[] | undefined;
  const queryBackend = backend!.query.bind(backend);
  const observeQuery = t.mock.method(backend!, 'query', async (text: string, signal?: AbortSignal) => {
    const result = await queryBackend(text, signal); receivedKeys = result?.keys; return result;
  });
  const queryStart = performance.now(), answer = await host.queryAdaptiveSemantic(query), hostQueryMs = performance.now() - queryStart;
  observeQuery.mock.restore();
  assert.equal(receivedKeys?.[0], last.candidate!.key, '真实E5近邻跨越扫描页，并实际交给宿主');
  assert.equal(answer.status, 'ready'); assert(answer.items.some((item) => item.id === last.id), '末页新增材料经真实向量与最终key核查进入宿主读取');

  const originalText = queue.source(firstSource)!.text;
  store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('改写的来源不再支持原文', firstSource);
  assert.equal(archive.generation(), generation); await drain();
  assert.equal(catalog(first.id), undefined, '无graph generation变化也撤除旧hash候选');
  assert.equal(catalog(last.id), last.candidate!.key);
  store.db.prepare('UPDATE messages SET text=? WHERE id=?').run(originalText, firstSource);
  await drain(); await until(() => status().indexed === 1001 && status().pending === 0);
  const computed = backend!.status().computed;

  await host.stopAdaptiveMemory(); host.startAdaptiveMemory();
  await until(() => status().state === 'ready');
  assert.equal(status().current, false, '新宿主不能把持久旧清单直接称为已追平');
  await host.refreshAdaptiveRetrieval();
  assert.equal(status().current, false, '新epoch半个sweep尚未完成');
  assert.equal(check.prepare('SELECT count(*) n FROM vector_catalog').get()!.n, 1001, '半扫不能清掉尚未遍历的历史');
  await drain(); await until(() => status().indexed === 1001 && status().pending === 0);
  assert.equal(backend!.status().computed, 0, '新worker复用全部有效向量');
  assert.equal(archive.generation(), generation);
  t.diagnostic(JSON.stringify({ elapsedMs: performance.now() - started, hostQueryMs,
    batches: batches.length, candidates: 1001, firstWorkerComputed: computed, restoredComputed: backend!.status().computed,
    queryBudgetMs: 100, seededVectors: 1000, realE5: true }));
});

test('实际worker：10000候选（含多块长文档共20000分块）与真实E5查询在100ms前台预算内稳定返回近邻', { skip: !component, timeout: 60_000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-vector-10k-'));
  const cache = path.join(home, 'vectors-10k.sqlite');
  const agent = 'synthetic-10k-agent';
  const db = new DatabaseSync(cache);
  db.exec('CREATE TABLE vectors(agent TEXT,space TEXT,key TEXT,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(agent,space,key))');
  const unit = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);
  const multiValue = JSON.stringify([unit, unit]);
  const multiDigest = crypto.createHash('sha256').update(multiValue).digest('hex');
  const entries = Array.from({ length: 10_000 }, (_, i) => {
    const id = String(i + 1).padStart(6, '0');
    const key = semanticDigest({ id, i });
    return { id, key, title: '合成10k', text: `港口采风合成记录 ${i + 1}` };
  });
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO vectors VALUES(?,?,?,?,?)');
  for (const e of entries) insert.run(agent, VECTOR_SPACE, e.key, multiValue, multiDigest);
  db.exec('COMMIT'); db.close();
  const backend = new AdaptiveVectorRetriever({ root: component!, cache, agent });
  t.after(async () => { await backend.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const deadline = performance.now() + 15_000;
  while (backend.status().state !== 'ready') {
    assert.notEqual(backend.status().state, 'failed');
    assert(performance.now() < deadline);
    await new Promise((r) => setTimeout(r, 10));
  }
  for (let i = 0; i < 10; i++) {
    await backend.applyBatch({
      epoch: 'sweep-10k',
      seq: i + 1,
      ...(i === 0 ? { begin: true } : {}),
      ...(i === 9 ? { complete: true } : {}),
      upsert: entries.slice(i * 1000, (i + 1) * 1000),
      remove: [],
    });
  }
  assert.equal(backend.status().current, true);
  assert.equal(backend.status().indexed, 10_000);
  assert.equal(backend.status().pending, 0);
  const queryDurations: number[] = [];
  for (let i = 0; i < 4; i++) {
    const qStart = performance.now();
    const res = await backend.query('海湾访问计划');
    const elapsed = performance.now() - qStart;
    queryDurations.push(elapsed);
    assert.ok(res && res.keys.length === 1000, `第 ${i + 1} 次 10000 候选（20000分块）查询须在 100ms 预算内返回 Top-1000（耗时 ${elapsed.toFixed(2)}ms）`);
    assert.equal(res.keys[0], entries[0].key);
  }
  t.diagnostic(JSON.stringify({ candidates: 10_000, totalChunks: 20_000, queryMs: queryDurations }));
});

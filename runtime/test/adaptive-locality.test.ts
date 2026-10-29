// 验证正常增量路径不调用全图正文接口；不是只检查提示是否被截短。
import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';
import { AdaptiveArchive } from '../src/memory/adaptive-archive.ts';
import { AdaptiveGraph } from '../src/memory/adaptive-graph.ts';
import { AdaptiveLookup } from '../src/memory/adaptive-lookup.ts';
import { seedReadWorkload } from '../tool/adaptive-read-workload.ts';
import type { ClaimRecord, SourceSpan } from '../src/memory/adaptive-evidence.ts';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-locality-runtime-'));
process.env.QUETZAL_HOME = isolatedHome;
const { processSemanticNext } = await import('../src/memory/adaptive-worker.ts');
after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));

function fixture(t: TestContext, size: number) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-locality-')), soul = path.join(home, 'soul'); fs.mkdirSync(soul);
  const db = new DatabaseSync(path.join(home, 'data.db'));
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)');
  const queue = new AdaptiveStore(db, 'synthetic-agent'), archive = new AdaptiveArchive(queue, soul);
  seedReadWorkload(queue, soul, size); assert.equal(archive.generation(), size);
  queue.schedule('semantic-v1', Date.now(), 1000);
  for (let job; (job = queue.claim('semantic-v1'));) queue.complete(job);
  if (size > 1000) { queue.schedule('semantic-v1', Date.now(), 1000); for (let job; (job = queue.claim('semantic-v1'));) queue.complete(job); }
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { db, queue, archive };
}

test('超过旧全图1000条上限后，增量整合、接受、查询与来源核查只点读局部正文', async (t) => {
  const size = 1200, f = fixture(t, size);
  const oldCurrent = AdaptiveGraph.prototype.current, oldGet = AdaptiveLookup.prototype.get;
  let loads = 0;
  AdaptiveGraph.prototype.current = () => { throw new Error('禁止全图正文物化'); };
  AdaptiveLookup.prototype.get = function (id) { loads++; return oldGet.call(this, id); };
  t.after(() => { AdaptiveGraph.prototype.current = oldCurrent; AdaptiveLookup.prototype.get = oldGet; });
  f.db.prepare("INSERT INTO messages VALUES(?,?,'user','synthetic',?,'new','reader',NULL,NULL,NULL)").run(size + 1, 9999999, '另一个独立项目，准备讨论新需求。');
  const result = await processSemanticNext({ queue: f.queue, archive: f.archive,
    exclusive: async <T>(run: () => T) => run(), enabled: () => true, signal: new AbortController().signal,
    generate: async (prompt) => {
      const input = JSON.parse(prompt.user);
      assert.ok(input.records.length < size / 2);
      assert.ok(Buffer.byteLength(JSON.stringify(prompt)) <= 256 * 1024);
      const source = input.sources.find((s: any) => s.key === input.current);
      const quote = { kind: 'source', source: source.key, text: source.text, occurrence: null };
      return { contexts: [], records: [{ key: 'p1', replace: null, kind: 'claim', state: 'present', realm: 'real',
        text: '用户准备讨论独立新项目的需求。', nature: 'reported', reasons: [quote], participants: [], references: [],
        occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
        supports: [{ id: 'direct', premises: [quote], assumptions: [] }], counters: [] }] };
    } });
  assert.equal(result.status, 'revised'); assert.ok(loads < size / 2);
  loads = 0; const reading = f.archive.query('1199');
  assert.ok(reading.items.some((r) => r.kind === 'claim' && r.text.includes('1199')));
  assert.ok(loads < size / 2);
  loads = 0; const source = f.archive.readSources([1199]);
  assert.equal(source.sources[0].hash, f.queue.source(1199)!.hash);
  assert.ok(loads < size / 2);
});

test('倒排与邻接索引随事务更新，污染后从权威文件恢复，不把索引当事实', (t) => {
  const f = fixture(t, 3);
  f.db.exec("UPDATE adaptive_lookup_heads SET revision=999; DELETE FROM adaptive_lookup_terms;");
  const result = f.archive.query('线索');
  assert.equal(result.matched, 3);
  assert.equal(f.db.prepare('SELECT MAX(revision) n FROM adaptive_lookup_heads').get()!.n, 1);
  assert.ok(f.db.prepare('SELECT COUNT(*) n FROM adaptive_lookup_terms').get()!.n as number > 0);
});

test('倒排命中不可读的旧分支时，不借其词项暴露仍有独立支持的认识或命中数', (t) => {
  const f = fixture(t, 2);
  const records = f.archive.current() as ClaimRecord[], target = records.find((r) => r.reasons[0].source === 1)!;
  const independent = f.queue.source(2)!;
  const span: SourceSpan = { kind: 'source', source: 2, hash: independent.hash, start: 0, end: independent.text.length, quote: independent.text };
  const revision: ClaimRecord = { ...target, revision: 2, text: 'ordinary statement',
    supports: [...target.supports, { id: 'independent', premises: [span], assumptions: [] }] };
  f.queue.schedule('locality-privacy', Date.now()); const job = f.queue.claim('locality-privacy')!;
  const inputs = [1, 2].map((id) => { const s = f.queue.source(id)!; return { id, revision: s.revision, hash: s.hash }; });
  assert.equal(f.archive.accept(job, inputs, { baseGeneration: 2, records: [revision] }), true);
  f.db.exec("UPDATE messages SET mode='ignored' WHERE id=1");
  // 词项仅存在于失效分支；注入派生索引建议也不能变成当前匹配或数量泄露。
  f.db.prepare('INSERT INTO adaptive_lookup_terms VALUES(?,?,1)').run('unreadableword', target.id);
  // 直接查询图，隔离候选核查；archive 对索引污染会另行从权威链修复。
  const graph = new AdaptiveGraph(f.queue), result = graph.query('unreadableword');
  assert.equal(result.matched, 0); assert.deepEqual(result.items, []);
});

import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';
import { AdaptiveArchive } from '../src/memory/adaptive-archive.ts';
import type { ClaimRecord, SourceSpan } from '../src/memory/adaptive-evidence.ts';
import type { ResearchTrace } from '../src/memory/adaptive-research.ts';
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-research-runtime-'));
process.env.QUETZAL_HOME = isolated;
const { researchNext, RESEARCH_PROCESSOR } = await import('../src/memory/adaptive-research.ts');
after(() => fs.rmSync(isolated, { recursive: true, force: true }));

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-research-')), soul = path.join(root, 'soul'); fs.mkdirSync(soul);
  const db = new DatabaseSync(path.join(root, 'db'));
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)');
  const queue = new AdaptiveStore(db, 'synthetic'), archive = new AdaptiveArchive(queue, soul);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const add = (id: number, text: string, role = 'user', mode: string | null = null) => db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,NULL,NULL,?,NULL)').run(id, id * 1000, role, 'synthetic', text, `session-${id}`, mode);
  add(1, '活动安排在周六。'); add(2, '周六这条线路要维护。');
  const span = (id: number): SourceSpan => { const s = queue.source(id)!; return { kind: 'source', source: id, hash: s.hash, start: 0, end: s.text.length, quote: s.text }; };
  const fact = (id: number): ClaimRecord => ({ id: crypto.randomUUID(), revision: 1, kind: 'claim', state: 'present', realm: { world: 'real', context: 'real' },
    reasons: [span(id)], text: queue.source(id)!.text, nature: 'reported', participants: [],
    occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
    supports: [{ id: 'report', premises: [span(id)], assumptions: [] }], counters: [] });
  const a = fact(1), b = fact(2);
  queue.scheduleSource('setup', 1);
  assert.ok(archive.accept(queue.claim('setup')!, [1, 2].map((id) => { const s = queue.source(id)!; return { id, revision: s.revision, hash: s.hash }; }), { baseGeneration: 0, records: [a, b] }));
  const process = () => { queue.schedule('semantic-v1'); for (let job; (job = queue.claim('semantic-v1'));) queue.complete(job); };
  process();
  const traces: ResearchTrace[] = [], queries: string[] = [], signal = new AbortController();
  const options = { queue, archive, exclusive: async <T>(run: () => T) => run(), enabled: () => true, signal: signal.signal,
    trace: (value: ResearchTrace) => traces.push(value), search: async (query: string) => { queries.push(query); return [2]; } };
  return { ...options, options, root, db, queue, archive, a, b, add, span, process, traces, queries, signal };
}
function proposal(prompt: { user: string }) {
  const data = JSON.parse(prompt.user);
  const quotes = data.sources.map((s: any) => ({ kind: 'source', source: s.key, text: s.text, occurrence: null }));
  return { contexts: [], records: [{ key: 'p1', replace: null, kind: 'claim', state: 'present', realm: 'real', reasons: quotes,
    text: '活动可能受到线路维护影响，尚需核实交通安排。', nature: 'hypothesis', participants: [], references: [],
    occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
    supports: [{ id: 'connection', premises: data.records.map((r: any) => ({ kind: 'record', key: r.key })), assumptions: [] }], counters: [] }] };
}
const planner = (prompt: { user: string }) => { const d = JSON.parse(prompt.user); return { question: '活动是否受交通影响', query: `检索-${d.research.purpose}` }; };

test('后台走探索、桥接与反证后安装有版本依赖的推测；原前提修订立即使推测失效', async (t) => {
  const f = fixture(t); let calls = 0;
  const result = await researchNext({ ...f.options, generate: async (p) => { calls++; return JSON.parse(p.user).research.purpose ? planner(p) : proposal(p); } });
  assert.equal(result.status, 'revised'); assert.equal(calls, 4); assert.equal(f.queries.length, 4);
  const trace = f.traces.at(-1)!;
  assert.deepEqual(trace.steps.map((s) => s.purpose), ['explore', 'bridge', 'counter']);
  assert.equal(trace.state, 'accepted'); assert.equal(trace.inputs.length, 2);
  const insight = f.archive.current().find((r) => r.id !== f.a.id && r.id !== f.b.id)!;
  assert.equal(insight.kind === 'claim' && insight.nature, 'hypothesis');
  assert.equal(f.archive.assess().get(insight.id)?.status, 'supported');
  assert.ok(f.archive.query('活动', (id) => f.queue.source(id)).items.some((i) => i.id === insight.id));
  assert.equal(f.queue.status(RESEARCH_PROCESSOR).counts.done, 1);
  f.db.prepare('UPDATE messages SET text=? WHERE id=2').run('更正：周六线路正常运行。');
  assert.equal(f.archive.assess().get(insight.id)?.status, 'unsupported');
  assert.ok(!f.archive.query('活动', (id) => f.queue.source(id)).items.some((i) => i.id === insight.id));
});

test('原文回查不能引入助手、内部生成消息、ignored或未完成整合的输入；重复查询不重搜但仍审查已有线索', async (t) => {
  const f = fixture(t); f.add(3, '助手假设不能自证', 'agent'); f.add(4, '排除的私人资料', 'user', 'ignored');
  f.db.prepare("INSERT INTO messages VALUES(6,6000,'ambient','摘要','内部压缩摘要不应被研究', 'session-6',NULL,NULL,NULL,NULL)").run();
  f.db.prepare("INSERT INTO messages VALUES(7,7000,'ambient','子agent','子agent报告不应被研究', 'session-7',NULL,NULL,NULL,NULL)").run();
  f.process(); f.add(5, '尚未处理的新输入');
  let calls = 0;
  const result = await researchNext({ ...f.options, search: async () => [2, 3, 4, 5, 6, 7, 999], generate: async (p) => {
    calls++; const d = JSON.parse(p.user); assert.equal(d.sources.length, 2);
    assert.ok(!p.user.includes('助手假设')); assert.ok(!p.user.includes('私人资料')); assert.ok(!p.user.includes('尚未处理'));
    assert.ok(!p.user.includes('内部压缩摘要')); assert.ok(!p.user.includes('子agent报告'));
    return d.research.purpose ? { question: '同一个问题', query: '同一次检索' } : { contexts: [], records: [] };
  } });
  assert.equal(result.status, 'unchanged'); assert.equal(calls, 4); assert.equal(f.traces.at(-1)?.steps.length, 1);
  assert.equal(f.traces.at(-1)?.state, 'empty'); assert.equal(f.archive.current().length, 2);
});

test('研究等待期间来源变化不安装混合快照；失败留在原持久任务而非伪造完成', async (t) => {
  const f = fixture(t);
  const result = await researchNext({ ...f.options, generate: async (p) => {
    if (JSON.parse(p.user).research.purpose) return planner(p);
    const output = proposal(p); f.db.prepare('UPDATE messages SET text=? WHERE id=2').run('已修改的来源'); return output;
  } });
  assert.equal(result.status, 'failed'); assert.equal(f.archive.current().length, 2);
  assert.equal(f.queue.status(RESEARCH_PROCESSOR).counts.done, 0);
  assert.equal(f.traces.at(-1)?.state, 'failed');
  assert.equal(f.db.prepare('SELECT attempts FROM adaptive_jobs WHERE id=?').get(f.traces[0].job)?.attempts, 1);
});

test('研究不能把猜测写成 reported 或改写已有身份和事实', async (t) => {
  for (const change of ['reported', 'revision', 'source-only', 'realm']) {
    const f = fixture(t);
    const result = await researchNext({ ...f.options, generate: async (p) => {
      if (JSON.parse(p.user).research.purpose) return planner(p);
      const output = proposal(p);
      if (change === 'reported') output.records[0].nature = 'reported';
      else if (change === 'revision') output.records[0].replace = JSON.parse(p.user).records[0].key;
      else if (change === 'source-only') output.records[0].supports[0].premises = output.records[0].reasons;
      else (output.contexts as unknown[]) = [{ key: 'c1', world: 'fiction', because: output.records[0].reasons[0] }];
      return output;
    } });
    assert.equal(result.status, 'failed', change); assert.equal(f.archive.current().length, 2);
    assert.equal(f.archive.history(f.a.id).length, 1);
  }
});

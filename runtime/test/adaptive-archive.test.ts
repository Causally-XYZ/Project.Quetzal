import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';
import { AdaptiveGraph } from '../src/memory/adaptive-graph.ts';
import { AdaptiveArchive } from '../src/memory/adaptive-archive.ts';
import { artifactDigest, type MemoryArtifact } from '../src/memory/adaptive-artifact.ts';
import { installPublication, publicationRoot, publicationMarkdown } from '../src/memory/adaptive-publication.ts';
import { type ClaimRecord, type SourceSpan } from '../src/memory/adaptive-evidence.ts';

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-archive-')), soul = path.join(home, 'soul');
  fs.mkdirSync(soul);
  const connections: DatabaseSync[] = [];
  const open = (name: string) => {
    const db = new DatabaseSync(path.join(home, name)); connections.push(db);
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)');
    return new AdaptiveStore(db, 'synthetic-agent');
  };
  const queue = open('center.db'), graph = new AdaptiveGraph(queue), archive = new AdaptiveArchive(queue, soul);
  t.after(() => { for (const db of connections) db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  let processor = 0;
  const add = (q: AdaptiveStore, id: number, text: string) => q.db.prepare("INSERT INTO messages VALUES(?,?,'user','synthetic',?,'conversation','alpha',NULL,NULL,NULL)").run(id, id * 1000, text);
  add(queue, 1, '用户最初说饭友是编辑'); add(queue, 2, '用户纠正饭友是弟弟');
  const span = (id: number): SourceSpan => { const s = queue.source(id)!; return { kind: 'source', source: id, hash: s.hash, start: 0, end: s.text.length, quote: s.text }; };
  const claim: ClaimRecord = { id: crypto.randomUUID(), revision: 1, state: 'present', realm: { world: 'real', context: 'synthetic' },
    reasons: [span(1)], kind: 'claim', text: '饭友是编辑', nature: 'reported', participants: [], occurred: { text: '', earliest: null, latest: null },
    valid: { text: '', earliest: null, latest: null }, supports: [{ id: 'direct', premises: [span(1)], assumptions: [] }], counters: [] };
  const accept = (r: ClaimRecord) => {
    const p = `archive-test-${++processor}`; queue.schedule(p, 100); const job = queue.claim(p, 100, 10000)!;
    const inputs = [1, 2].map((id) => { const s = queue.source(id)!; return { id, hash: s.hash, revision: s.revision }; });
    assert.equal(archive.accept(job, inputs, { baseGeneration: archive.generation(), records: [r] }, 101), true);
  };
  const artifacts = () => queue.db.prepare('SELECT document FROM adaptive_publications ORDER BY rowid').all().map((r) => JSON.parse(String(r.document)) as MemoryArtifact);
  const publish = () => {
    for (const row of queue.pendingPublications(102)) {
      installPublication(soul, queue.agent, row);
      // 单测仅模拟 Git 回执。真实文件 / Git / 强杀恢复由 adaptive-publication.test.ts 验证。
      queue.publicationWritten(row.id, row.digest, 102); queue.publicationCommitted(row.id, row.digest);
    }
  };
  const file = (a: MemoryArtifact) => path.join(publicationRoot(soul), `${a.id}.md`);
  return { home, soul, queue, graph, archive, open, add, span, claim, accept, artifacts, publish, file };
}

test('AM-22：新数据库仅从文件恢复版本与纠正，不伪造发件箱或任务；来源晚到后才可用', (t) => {
  const f = fixture(t); f.accept(f.claim);
  f.accept({ ...f.claim, revision: 2, text: '饭友是弟弟', reasons: [f.span(2)], supports: [{ id: 'correction', premises: [f.span(2)], assumptions: [] }] });
  f.publish(); const checkpoint = f.archive.checkpoint()!;
  const replica = f.open('restore.db'), restored = new AdaptiveArchive(replica, f.soul, checkpoint);
  assert.equal(restored.history(f.claim.id).length, 2);
  assert.deepEqual(restored.supportedClaims(), [], '没有原文不能把存档中的引文当作当前来源');
  f.add(replica, 1, '用户最初说饭友是编辑'); f.add(replica, 2, '用户纠正饭友是弟弟');
  // 原文的本机修订计数不同，但 agent / ID / hash 相同，恢复不要求跨身体 revision 相等。
  replica.db.exec('UPDATE adaptive_sources SET revision=9');
  assert.equal(restored.supportedClaims()[0].record.text, '饭友是弟弟');
  assert.equal(replica.db.prepare('SELECT COUNT(*) n FROM adaptive_publications').get()!.n, 0);
  assert.equal(replica.db.prepare('SELECT COUNT(*) n FROM adaptive_jobs').get()!.n, 0);
  replica.db.exec("UPDATE messages SET mode='ignored' WHERE id=2");
  assert.deepEqual(restored.supportedClaims(), []);
  assert.equal(restored.history(f.claim.id).length, 2, '来源失效不阻止恢复历史修订');
});

test('AM-07/22：撤回尾部文件缺失时停止读取；重新出现后恢复，不回退旧结论', (t) => {
  const f = fixture(t); f.accept(f.claim); f.accept({ ...f.claim, revision: 2, state: 'withdrawn', reasons: [f.span(2)] }); f.publish();
  const checkpoint = f.archive.checkpoint()!, tail = f.artifacts()[1], text = fs.readFileSync(f.file(tail), 'utf8');
  assert.equal(f.archive.assess().get(f.claim.id)?.status, 'withdrawn');
  fs.unlinkSync(f.file(tail));
  assert.throws(() => f.archive.supportedClaims(), /缺失/);
  assert.throws(() => new AdaptiveArchive(f.open('fresh.db'), f.soul, checkpoint).supportedClaims(), /检查点/);
  fs.writeFileSync(f.file(tail), text);
  assert.equal(f.archive.assess().get(f.claim.id)?.status, 'withdrawn');
  assert.deepEqual(f.archive.supportedClaims(), []);
});

test('AM-12/22：文件修改、已见结果被删除、缺失中段与重复代次不会静默进入投影', (t) => {
  const f = fixture(t); f.accept(f.claim); f.accept({ ...f.claim, revision: 2, text: '修订' }); f.publish();
  const all = f.artifacts(), before = f.graph.history(f.claim.id);
  const changed = structuredClone(all[1]); (changed.payload.data as { records: ClaimRecord[] }).records[0].text = '被改动';
  fs.writeFileSync(f.file(changed), publicationMarkdown(JSON.stringify(changed), changed.id));
  assert.throws(() => f.archive.current(), /不同/);
  assert.deepEqual(f.graph.history(f.claim.id), before, '失败事务保留原投影供审计，archive 不返回它');
  const fresh = new AdaptiveGraph(f.open('fresh.db'));
  assert.throws(() => fresh.rebuild([all[1]]), /链不完整/);
  const fork = structuredClone(all[0]); fork.id = crypto.randomUUID();
  assert.throws(() => fresh.rebuild([all[0], fork]), /链不完整/);
  assert.equal(fresh.generation(), 0);
  fresh.rebuild(all);
  assert.throws(() => fresh.rebuild([all[0]]), /缺失或改变/);
  assert.throws(() => fresh.rebuild([all[0], all[0]]), /身份或格式/);
});

test('AM-12：待发布结果可由发件箱恢复，安装后 Git 失败不能绕过文件缺失', (t) => {
  const f = fixture(t); f.accept(f.claim);
  assert.equal(f.archive.supportedClaims().length, 1);
  const row = f.queue.pendingPublications(102)[0]; installPublication(f.soul, f.queue.agent, row);
  f.queue.publicationWritten(row.id, row.digest, 102);
  for (let i = 0; i < 5; i++) f.queue.publicationCommitFailed(row.id, 103 + i);
  fs.unlinkSync(f.file(f.artifacts()[0]));
  assert.throws(() => f.archive.supportedClaims(), /缺失/);
});

test('AM-12：重放途中数据库错误整体回滚；来源已经修改仍能恢复历史但不支持旧结论', (t) => {
  const f = fixture(t); f.accept(f.claim); f.publish(); const all = f.artifacts();
  const q = f.open('fresh.db'), graph = new AdaptiveGraph(q);
  q.db.exec("CREATE TRIGGER injected BEFORE INSERT ON adaptive_graph_records BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => graph.rebuild(all), /injected/);
  assert.equal(graph.generation(), 0);
  assert.equal(q.db.prepare('SELECT COUNT(*) n FROM adaptive_graph_batches').get()!.n, 0);
  q.db.exec('DROP TRIGGER injected'); f.add(q, 1, '另一段不同原文');
  graph.rebuild(all); assert.equal(graph.history(f.claim.id).length, 1); assert.deepEqual(graph.supportedClaims(), []);
});

test('AM-16：父目录链接、结果链接、超长结果与未知文件拒绝读取，临时文件不作为存档', (t) => {
  const f = fixture(t); f.accept(f.claim); f.publish(); const file = f.file(f.artifacts()[0]);
  fs.writeFileSync(`${file}.partial.tmp`, 'incomplete'); assert.equal(f.archive.current().length, 1);
  const old = fs.readFileSync(file); fs.unlinkSync(file); fs.symlinkSync(path.join(f.home, 'outside'), file);
  assert.throws(() => f.archive.current(), /不合法/); fs.unlinkSync(file);
  fs.writeFileSync(file, Buffer.alloc(270000)); assert.throws(() => f.archive.current(), /不合法/); fs.writeFileSync(file, old);
  const root = publicationRoot(f.soul), moved = `${root}-moved`; fs.renameSync(root, moved); fs.symlinkSync(moved, root);
  assert.throws(() => f.archive.current(), /目录不合法/); fs.unlinkSync(root); fs.renameSync(moved, root);
  fs.writeFileSync(path.join(root, 'unexpected.md'), 'unknown'); assert.throws(() => f.archive.current(), /未知文件/);
});

test('AM-12：投影 schema 1 原子迁移到 2，原历史保留且不再依赖本机发件箱', (t) => {
  const f = fixture(t); f.accept(f.claim);
  f.queue.db.exec(`DROP INDEX adaptive_graph_artifact;
    ALTER TABLE adaptive_graph_records RENAME TO old_records;
    CREATE TABLE adaptive_graph_records(id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL,artifact TEXT NOT NULL,
      PRIMARY KEY(id,revision),FOREIGN KEY(artifact) REFERENCES adaptive_publications(id));
    INSERT INTO adaptive_graph_records SELECT * FROM old_records; DROP TABLE old_records;
    CREATE INDEX adaptive_graph_artifact ON adaptive_graph_records(artifact);
    UPDATE adaptive_graph_meta SET version=1`);
  const graph = new AdaptiveGraph(f.queue);
  assert.equal(f.queue.db.prepare('SELECT version FROM adaptive_graph_meta').get()!.version, 2);
  assert.equal(graph.history(f.claim.id).length, 1);
  assert.equal(f.queue.db.prepare('PRAGMA foreign_key_list(adaptive_graph_records)').get()!.table, 'adaptive_graph_batches');
  assert.equal(artifactDigest(JSON.stringify(f.artifacts()[0])), f.archive.checkpoint()!.digest);
});


test('AM-22：真实灵魂 Git 反向提交删除撤回文件时拒绝回流，再次反向提交后恢复', (t) => {
  const f = fixture(t);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: f.soul, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); f.accept(f.claim); f.publish(); git('add', 'notes'); git('commit', '-qm', '合成测试：记录初始认识');
  f.accept({ ...f.claim, revision: 2, state: 'withdrawn', reasons: [f.span(2)] }); f.publish();
  git('add', 'notes'); git('commit', '-qm', '合成测试：撤回认识');
  assert.equal(f.archive.assess().get(f.claim.id)?.status, 'withdrawn');
  git('revert', '--no-edit', 'HEAD');
  assert.throws(() => f.archive.supportedClaims(), /缺失/);
  git('revert', '--no-edit', 'HEAD');
  assert.equal(f.archive.assess().get(f.claim.id)?.status, 'withdrawn');
  assert.deepEqual(f.archive.supportedClaims(), []);
});

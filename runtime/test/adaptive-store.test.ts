import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-adaptive-'));
  const file = path.join(home, 'source.db');
  const connections: DatabaseSync[] = [];
  const open = () => { const db = new DatabaseSync(file); connections.push(db); return db; };
  const db = open();
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)`);
  t.after(() => { for (const c of connections) { try { c.close(); } catch {} } fs.rmSync(home, { recursive: true, force: true }); });
  const add = (id: number, text = '合成原文', ts = id) => db.prepare("INSERT OR IGNORE INTO messages VALUES(?,?,'user','测试',?,'conversation','alpha',NULL,NULL,NULL)").run(id, ts, text);
  return { db, open, add, queue: () => new AdaptiveStore(db, 'synthetic-agent') };
}

test('AM-11/20：旧库补扫、重复投递、低编号和晚到旧时间消息均按来源登记', (t) => {
  const f = fixture(t);
  f.add(900); f.add(901);
  const q = f.queue();
  assert.equal(q.schedule('source-v1', 1000, 1), 1);
  assert.equal(q.schedule('source-v1', 1000, 1), 1);
  assert.equal(q.schedule('source-v1', 1000), 0);
  f.add(900); f.add(1, '后来才到的旧消息', 1);
  assert.equal(q.schedule('source-v1', 1000), 1);
  assert.equal(q.status().counts.queued, 3);
  assert.equal(q.source(900)?.revision, 1);
  q.schedule('source-v2', 1000);
  assert.equal(q.status('source-v2').counts.queued, 3, '处理器升级与普通重试分开');
});

test('AM-12：来源修订登记与消息事务一起回滚，事件缺失不影响补做', (t) => {
  const f = fixture(t), q = f.queue();
  f.db.exec('BEGIN'); f.add(1); f.db.exec('ROLLBACK');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM adaptive_sources').get()!.n, 0);
  f.db.exec('BEGIN'); f.add(2); f.db.exec('COMMIT'); // 没有发送任何进程内事件
  assert.equal(q.schedule('source-v1', 100), 1);
  const job = q.claim('source-v1', 100)!;
  assert.equal(q.complete(job, 101), true);
  assert.equal(q.complete(job, 102), false, '同一结果不能安装两次');
  assert.equal(q.processed(2)?.text, '合成原文');
});

test('AM-12/20：租约过期换领，原工作者不能覆盖新工作者的结果', (t) => {
  const f = fixture(t), q = f.queue(); f.add(1); q.schedule('source-v1', 0);
  const first = q.claim('source-v1', 0, 100)!;
  const other = new AdaptiveStore(f.open(), 'synthetic-agent');
  assert.equal(other.claim('source-v1', 99), undefined);
  assert.equal(q.complete(first, 100), false, '过期后即使未换领也不能提交');
  const second = other.claim('source-v1', 100, 100)!;
  assert.notEqual(second.token, first.token);
  assert.equal(second.attempts, 2);
  assert.equal(q.complete(first, 101), false);
  assert.equal(other.complete(second, 101), true);
  assert.equal(q.status().counts.done, 1);
});

test('AM-12：关闭连接后重建队列保留未完成租约、取消状态及成功回执', (t) => {
  const f = fixture(t), q = f.queue();
  f.add(1); f.add(2); f.add(3); q.schedule('source-v1', 0);
  const a = q.claim('source-v1', 0, 10)!;
  const b = q.claim('source-v1', 0, 10)!; q.cancel(b.id, 1);
  const c = q.claim('source-v1', 0, 10)!; q.complete(c, 1);
  f.db.close();
  const restored = new AdaptiveStore(f.open(), 'synthetic-agent');
  restored.schedule('source-v1', 20);
  assert.equal(restored.claim('source-v1', 20)?.id, a.id);
  assert.equal(restored.status().counts.cancelled, 1);
  assert.equal(restored.status().counts.done, 1);
  assert.equal(restored.processed(c.source)?.id, c.source);
});

test('AM-20：修改来源立即清理回执并拒绝旧输入版本，忽略的声音不被重新排队', (t) => {
  const f = fixture(t), q = f.queue(); f.add(1); q.schedule('source-v1', 0);
  const old = q.claim('source-v1', 0)!;
  assert.equal(q.complete({ ...old, source: 2 }, 1), false, '不能伪造租约指向');
  assert.equal(q.complete(old, 1), true);
  const oldHash = q.processed(1)!.hash;
  f.db.prepare("UPDATE messages SET mode='ignored' WHERE id=1").run();
  assert.equal(q.processed(1), undefined);
  assert.equal(q.source(1), undefined);
  assert.equal(q.schedule('source-v1', 2), 0);
  f.db.prepare("UPDATE messages SET mode=NULL,text='修正后的来源' WHERE id=1").run();
  q.schedule('source-v1', 3);
  const next = q.claim('source-v1', 3)!;
  assert.equal(next.revision, 3);
  assert.equal(q.complete(old, 4), false);
  assert.equal(q.complete(next, 4), true);
  assert.notEqual(q.processed(1)!.hash, oldHash);
  f.db.prepare('UPDATE messages SET text=text WHERE id=1').run();
  assert.equal(q.source(1)!.revision, 3, '同值更新不制造修订');
  f.db.prepare('DELETE FROM messages WHERE id=1').run();
  assert.equal(q.processed(1), undefined);
  assert.equal(q.schedule('source-v1', 5), 0);
});

test('AM-12：写回执故障回滚整个完成事务，重试仍只能成功一次', (t) => {
  const f = fixture(t), q = f.queue(); f.add(1); q.schedule('source-v1', 0);
  const job = q.claim('source-v1', 0)!;
  f.db.exec("CREATE TRIGGER fail_receipt AFTER INSERT ON adaptive_receipts BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => q.complete(job, 1), /injected/);
  assert.equal(q.status().counts.running, 1);
  assert.equal(q.processed(1), undefined);
  f.db.exec('DROP TRIGGER fail_receipt');
  assert.equal(q.complete(job, 2), true);
  assert.equal(q.complete(job, 3), false);
});

test('AM-14：退避和尝试次数有界，显式取消不被补扫复活', (t) => {
  const f = fixture(t), q = f.queue(); f.add(1); q.schedule('source-v1', 0);
  let now = 0;
  for (let n = 1; n <= 5; n++) {
    const job = q.claim('source-v1', now)!;
    assert.equal(job.attempts, n);
    assert.equal(q.fail(job, 'timeout', now + 1), true);
    assert.equal(q.claim('source-v1', now + 2), undefined);
    now += 61_000;
  }
  assert.equal(q.status().counts.failed, 1);
  q.schedule('source-v1', now);
  assert.equal(q.claim('source-v1', now), undefined);
  assert.equal(q.cancel(q.jobs()[0].id, now), true);
  q.schedule('source-v1', now + 1);
  assert.equal(q.status().counts.cancelled, 1);
});

test('AM-15/16：错误 agent、未知存储版本和畸形参数拒绝，原任务不被修改', (t) => {
  const f = fixture(t), q = f.queue(); f.add(1); q.schedule('source-v1', 0);
  assert.throws(() => new AdaptiveStore(f.db, 'other-agent'), /不匹配/);
  assert.throws(() => q.schedule('bad processor'), /不合法/);
  assert.throws(() => q.schedule('source-v1', 0, 1001), /不合法/);
  assert.throws(() => q.claim('source-v1', 0, -1), /不合法/);
  f.db.prepare('UPDATE adaptive_meta SET version=99').run();
  assert.throws(() => new AdaptiveStore(f.db, 'synthetic-agent'), /不匹配/);
  assert.equal(q.status().counts.queued, 1);
});

test('失败任务显式追加一次尝试；重发旧请求不能批准下一次重试，也不伪造成功回执', (t) => {
  const f = fixture(t), q = f.queue(); f.add(1); q.schedule('source-v1', 0);
  let now = 0;
  for (let n = 0; n < 5; n++) { q.fail(q.claim('source-v1', now)!, 'processor_failed', now + 1); now += 61000; }
  const failed = q.jobs()[0];
  assert.equal(q.retryFailed(failed.id, 5, now)?.error, 'processor_failed');
  assert.equal(q.processed(1), undefined); assert.equal(q.pendingPublications(now).length, 0);
  assert.equal(q.retryFailed(failed.id, 5, now), undefined);
  const sixth = q.claim('source-v1', now)!; assert.equal(sixth.attempts, 6);
  q.fail(sixth, 'timeout', now + 1); assert.equal(q.status().counts.failed, 1);
  assert.equal(q.retryFailed(failed.id, 5, now + 2), undefined, '旧RPC即使此时又failed也不能重开');
  assert.equal(q.claim('source-v1', now + 61000), undefined);
  assert.ok(q.retryFailed(failed.id, 6, now + 61000));
  const seventh = q.claim('source-v1', now + 61000, 10)!;
  assert.equal(q.claim('source-v1', now + 61010), undefined, '追加尝试的租约过期后不自动再领');
  assert.equal(q.retryFailed(failed.id, 6, now + 61011), undefined);
  assert.ok(q.retryFailed(failed.id, seventh.attempts, now + 61011));
  assert.equal(q.complete(q.claim('source-v1', now + 61011)!, now + 61012), true);
  assert.equal(q.retryFailed(failed.id, 8, now + 61013), undefined, '完成结果不可重做');
});

test('重试拒绝取消、已变来源和关闭的处理器；失败列表不被较新的成功任务遮住', (t) => {
  const f = fixture(t), q = f.queue(); f.add(1); q.schedule('source-v1', 0);
  let now = 0;
  for (let n = 0; n < 5; n++) { q.fail(q.claim('source-v1', now)!, 'timeout', now + 1); now += 61000; }
  const failed = q.jobs()[0];
  assert.equal(q.retryFailed(failed.id, 5, now, () => false), undefined);
  for (let id = 2; id <= 30; id++) f.add(id);
  q.schedule('source-v1', now);
  for (let id = 2; id <= 30; id++) q.complete(q.claim('source-v1', now)!, now + 1);
  assert.ok(!q.jobs().some((j) => j.id === failed.id));
  assert.equal(q.jobs(100, true)[0].id, failed.id);
  q.cancel(failed.id, now + 2); assert.equal(q.retryFailed(failed.id, 5, now + 3), undefined);
  f.add(31); q.scheduleSource('source-v1', 31, now);
  for (let n = 0; n < 5; n++) { q.fail(q.claim('source-v1', now)!, 'timeout', now + 1); now += 61000; }
  const stale = q.jobs(100, true)[0];
  f.db.prepare("UPDATE messages SET mode='ignored' WHERE id=31").run();
  assert.equal(q.retryFailed(stale.id, 5, now), undefined); assert.equal(q.source(31), undefined);
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';
import { ARTIFACT_BYTES, artifactDigest, parseArtifact } from '../src/memory/adaptive-artifact.ts';
import { installPublication, readPublication, publicationRoot, publishPending, commitPending } from '../src/memory/adaptive-publication.ts';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-publication-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../src/config.ts'); cfg.loadConfig();
const store = await import('../src/store.ts'); store.openStore();
const { identity } = await import('../src/memory/identity.ts');
const agent = identity().id;
let queue = new AdaptiveStore(store.db, agent);
after(() => { store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });
const payload = { schema: 'synthetic-v1', data: { text: '待校验认识，不是已确认事实' } };
function work() {
  const source = store.addMessage('user', '测试', '合成来源：小说中有人修钟', { session: 'fixture' });
  queue.schedule('publish-test-v1');
  const job = queue.claim('publish-test-v1')!;
  assert.equal(job.source, source);
  const { id, revision, hash } = queue.source(source)!;
  return { job, inputs: [{ id, revision, hash }] };
}

test('AM-12：结果与完成同事务；输出写失败回滚，重试不重复接受', () => {
  const { job, inputs } = work();
  store.db.exec("CREATE TRIGGER fail_output AFTER INSERT ON adaptive_publications BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => queue.acceptResult(job, inputs, payload), /injected/);
  assert.equal(queue.pendingPublications().length, 0);
  assert.equal(queue.processed(job.source, job.processor), undefined);
  store.db.exec('DROP TRIGGER fail_output');
  assert.equal(queue.acceptResult(job, inputs, payload), true);
  assert.equal(queue.acceptResult(job, inputs, payload), false);
  const row = queue.pendingPublications()[0]; assert.equal(row.id, job.id);
  store.db.close(); store.openStore(); queue = new AdaptiveStore(store.db, agent);
  assert.equal(queue.pendingPublications()[0].document, row.document);
  assert.equal(queue.claim('publish-test-v1'), undefined, '已接受结果的工作不再领取或调用模型');
  publishPending(queue, cfg.paths.soul, () => true);
});

test('AM-20：任何输入来源版本改变都拒绝接受；租约与取消门禁不能绕过', () => {
  const { job, inputs } = work();
  const other = store.addMessage('user', '测试', '第二条合成来源');
  const { id, revision, hash } = queue.source(other)!;
  inputs.push({ id, revision, hash });
  store.setMessageMode(other, 'ignored');
  assert.equal(queue.acceptResult(job, inputs, payload), false);
  assert.equal(queue.acceptResult({ ...job, token: 'wrong' }, inputs.slice(0, 1), payload), false);
  queue.cancel(job.id);
  assert.equal(queue.acceptResult(job, inputs.slice(0, 1), payload), false);
  // 排队清理只针对这个测试的另一个来源，后面的 work 不应误领它。
  queue.schedule('publish-test-v1');
  for (const j of queue.jobs(100)) if (j.state === 'queued') queue.cancel(j.id);
});

test('AM-12：文件安装后回执前故障，重试只补回执，不覆盖或重复建文件', () => {
  const { job, inputs } = work(); queue.acceptResult(job, inputs, payload);
  const row = queue.pendingPublications()[0];
  assert.throws(() => installPublication(cfg.paths.soul, agent, row, { installed() { throw new Error('crash'); } }), /crash/);
  const file = path.join(publicationRoot(cfg.paths.soul), `${job.id}.md`);
  const before = fs.readFileSync(file, 'utf8'), mtime = fs.statSync(file).mtimeMs;
  assert.equal(queue.pendingPublications()[0].id, job.id);
  assert.equal(publishPending(queue, cfg.paths.soul, () => true), 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.equal(queue.pendingPublications().length, 0);
  assert.equal(readPublication(cfg.paths.soul, job.id, agent).payload.schema, 'synthetic-v1');
});

test('AM-14/15：急停门禁不发布；同名不同内容保留原件并显式失败', () => {
  const { job, inputs } = work(); queue.acceptResult(job, inputs, payload);
  const row = queue.pendingPublications()[0];
  assert.equal(publishPending(queue, cfg.paths.soul, () => false), 0);
  assert.ok(!fs.existsSync(path.join(publicationRoot(cfg.paths.soul), `${job.id}.md`)));
  installPublication(cfg.paths.soul, agent, row);
  const file = path.join(publicationRoot(cfg.paths.soul), `${job.id}.md`);
  fs.writeFileSync(file, '# 外部改动，不能覆盖\n');
  assert.equal(publishPending(queue, cfg.paths.soul, () => true), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '# 外部改动，不能覆盖\n');
  assert.equal(queue.pendingPublications().length, 0);
  assert.equal(queue.status().publications.failed, 1);
});

test('信封大小、未知版本、错误 agent 与父目录链接均不能进入结果读取器', () => {
  const { job, inputs } = work();
  assert.throws(() => queue.acceptResult(job, inputs, { schema: 'synthetic-v1', data: 'x'.repeat(ARTIFACT_BYTES) }), /大小/);
  assert.equal(queue.acceptResult(job, inputs, payload), true);
  const row = queue.pendingPublications()[0], a = JSON.parse(row.document);
  assert.throws(() => parseArtifact(JSON.stringify({ ...a, format: 'v99' }), agent), /版本/);
  assert.throws(() => parseArtifact(row.document, 'other'), /agent/);
  const bad = path.join(home, 'linked-soul'), outside = path.join(home, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, bad, 'dir');
  assert.throws(() => installPublication(bad, agent, row), /目录/);
  assert.throws(() => installPublication(cfg.paths.soul, agent, { ...row, digest: artifactDigest('wrong') }), /摘要/);
  assert.deepEqual(fs.readdirSync(outside), []);
  publishPending(queue, cfg.paths.soul, () => true);
});

test('未知 payload 存档不会作为旧笔记或普通检索材料旁路进入上下文', async () => {
  const { job, inputs } = work(); queue.acceptResult(job, inputs, { schema: 'future-v99', data: { text: '独有危险候选银色沙漏' } });
  publishPending(queue, cfg.paths.soul, () => true);
  const { retrieve, documents } = await import('../src/memory/retrieval.ts');
  const { readLegacyRecords } = await import('../src/memory/structured.ts');
  assert.ok(!documents().some((d) => d.text.includes('银色沙漏')));
  assert.equal(retrieve('银色沙漏', { kinds: ['note'] }).length, 0);
  assert.ok(!readLegacyRecords().some((r) => r.text.includes('银色沙漏')));
  assert.equal(readPublication(cfg.paths.soul, job.id, agent).payload.schema, 'future-v99', '存档可检查不等于语义可用');
});

test('AM-12：文件完成后 Git 失败可重启补做，只有 HEAD 完整匹配才记发布成功', async () => {
  const { ensureSoul, touched, verifyRecordedFiles } = await import('../src/memory/soul-sync.ts');
  await ensureSoul();
  const { job, inputs } = work(); queue.acceptResult(job, inputs, payload);
  publishPending(queue, cfg.paths.soul, () => true);
  const now = Date.now();
  assert.ok(queue.uncommittedPublications().some((r) => r.id === job.id));
  assert.equal(await commitPending(queue, () => true, async () => { throw new Error('injected git failure'); }, now), 0);
  assert.equal(queue.pendingPublications().length, 0, '文件已存在，不能重新生成');
  store.db.close(); store.openStore(); queue = new AdaptiveStore(store.db, agent);
  assert.ok(queue.uncommittedPublications(now + 30_001).length);
  const record = async (files: { path: string; content: string }[]) => {
    await touched({ tool: '合成测试发布' }); await verifyRecordedFiles(files);
  };
  while (queue.uncommittedPublications(now + 30_001).length) {
    assert.ok(await commitPending(queue, () => true, record, now + 30_001));
  }
  assert.equal(queue.status().publications.written, 0);
  assert.ok(queue.status().publications.published > 0);
  await assert.rejects(verifyRecordedFiles([{ path: `notes/QuetzalMemory/Adaptive/${job.id}.md`, content: '不同内容' }]), /尚未进入/);
});

test('AM-12：真实进程在接受后、临时文件后、安装后、Git 提交后强杀，重启不重跑结果生成', () => {
  for (const point of ['accepted', 'prepared', 'installed', 'committed']) {
    const dir = path.join(home, point); fs.mkdirSync(dir);
    const run = (stage: string) => spawnSync(process.execPath, ['--experimental-strip-types', path.join(import.meta.dirname, 'fixtures', 'publication-worker.ts'), stage],
      { env: { ...process.env, QUETZAL_HOME: dir }, encoding: 'utf8', timeout: 10_000 });
    const crashed = run(point); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    const recovered = run('recover'); assert.equal(recovered.status, 0, recovered.stderr);
    const result = JSON.parse(recovered.stdout.trim().split('\n').at(-1)!);
    assert.equal(result.generated, 1); assert.equal(result.files, 1); assert.equal(result.pending, 0); assert.equal(result.published, 1); assert.equal(result.written, 0);
    const twice = run('recover'); assert.equal(twice.status, 0, twice.stderr);
    assert.equal(JSON.parse(twice.stdout.trim().split('\n').at(-1)!).generated, 1);
  }
});

test('schema 1 原子升级为 2，保留既有来源和任务；未知版本拒绝打开', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,text TEXT,role TEXT,channel TEXT,session TEXT,ts INTEGER,body TEXT,via TEXT,mode TEXT,attachments TEXT)');
    let old = new AdaptiveStore(db, 'synthetic-agent');
    db.exec("INSERT INTO messages(id,text,role,channel,session,ts) VALUES(1,'来源','user','测试','test',1)");
    old.schedule();
    db.exec('DROP TABLE adaptive_publications; UPDATE adaptive_meta SET version=1');
    old = new AdaptiveStore(db, 'synthetic-agent');
    assert.equal(old.jobs().length, 1); assert.equal(old.source(1)?.text, '来源');
    assert.equal(db.prepare('SELECT version FROM adaptive_meta').get()?.version, 2);
    assert.deepEqual(old.status().publications, { pending: 0, written: 0, published: 0, failed: 0 });
    db.exec('UPDATE adaptive_meta SET version=99');
    assert.throws(() => new AdaptiveStore(db, 'synthetic-agent'), /版本/);
  } finally { db.close(); }
});

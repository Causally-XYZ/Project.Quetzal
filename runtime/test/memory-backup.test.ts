import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawnSync } from 'node:child_process';
import type { ClaimRecord, SourceSpan } from '../src/memory/adaptive-evidence.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-memory-backup-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../src/config.ts'); cfg.loadConfig(); cfg.saveConfig({ body: 'center' });
const store = await import('../src/store.ts'); store.openStore();
const soul = await import('../src/memory/soul-sync.ts'); await soul.ensureSoul();
const { exclusive } = await import('../src/memory/memory.ts');
const { identity } = await import('../src/memory/identity.ts');
const { AdaptiveStore } = await import('../src/memory/adaptive-store.ts');
const { AdaptiveArchive } = await import('../src/memory/adaptive-archive.ts');
const { installPublication } = await import('../src/memory/adaptive-publication.ts');
const { ops } = await import('../src/ops.ts');
const { verifyMemoryBackup } = await import('../src/memory/backup.ts');
const { restoreMemoryBackup } = await import('../src/memory/restore.ts');
const agent = identity().id;
after(async () => { await soul.idle(); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });

test('管理入口备份 WAL 原话、两版认识、未发布结果、Git 历史和附件，后续变化不改快照', async () => {
  store.db.exec('PRAGMA wal_autocheckpoint=0');
  const q = new AdaptiveStore(store.db, agent), archive = new AdaptiveArchive(q, cfg.paths.soul);
  const attachment = { id: 'synthetic-file', name: 'attachment.txt', path: path.join(home, 'data/uploads/day/attachment.txt'), rel: 'day/attachment.txt', mime: 'text/plain', size: 12, kind: 'text' as const };
  const a = store.addMessage('user', '合成', '饭友是编辑', { attachments: [attachment] }), b = store.addMessage('user', '合成', '纠正：饭友是弟弟');
  const span = (id: number): SourceSpan => { const s = q.source(id)!; return { kind: 'source', source: id, hash: s.hash, start: 0, end: s.text.length, quote: s.text }; };
  const claim: ClaimRecord = { id: crypto.randomUUID(), revision: 1, state: 'present', realm: { world: 'real', context: 'synthetic' },
    reasons: [span(a)], kind: 'claim', text: '饭友是编辑', nature: 'reported', participants: [],
    occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
    supports: [{ id: 'direct', premises: [span(a)], assumptions: [] }], counters: [] };
  const accept = (revision: number) => {
    const p = `backup-${revision}`; q.schedule(p, 100); const job = q.claim(p, 100, 10000)!;
    const inputs = [a, b].map((id) => { const s = q.source(id)!; return { id, hash: s.hash, revision: s.revision }; });
    const r = revision === 1 ? claim : { ...claim, revision, text: '饭友是弟弟', reasons: [span(b)], supports: [{ id: 'corrected', premises: [span(b)], assumptions: [] }] };
    assert.equal(archive.accept(job, inputs, { baseGeneration: archive.generation(), records: [r] }, 101), true);
  };
  accept(1);
  for (const p of q.pendingPublications(102)) { installPublication(cfg.paths.soul, agent, p); q.publicationWritten(p.id, p.digest, 102); }
  await soul.push('合成备份前发布');
  for (const p of q.uncommittedPublications(102)) q.publicationCommitted(p.id, p.digest);
  accept(2); // 第二版仍在 SQLite 发件箱，不得仅备份 Git 或强迫模型重算。
  const checkpoint = archive.checkpoint()!;
  const put = (rel: string, content: string) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  put('data/uploads/day/attachment.txt', '合成附件'); put('data/media/recording.wav', 'synthetic-media');
  put('data/adaptive-retrieval/cache.bin', '可重建，不备份'); put('secrets/fixture-key', 'synthetic-secret');
  put('soul/notes/uncommitted.md', '尚未提交的笔记');
  store.kv.set('reminders', [{ id: 'synthetic-reminder', text: '旧提醒不能重发', at: Date.now() - 1000 }]);
  store.kv.set('turns', [{ id: 'synthetic-turn', body: 'center', status: 'running', updated: Date.now() }]);
  store.kv.set('agents', [{ id: 'synthetic-agent', body: 'center', status: 'running' }]);
  store.kv.set('projects', [{ id: 'synthetic-project', title: '小说' }]);
  q.schedule('restore-work', Date.now());
  const leased = q.claim('restore-work', Date.now(), 60000)!;
  const cancelled = String(store.db.prepare("SELECT id FROM adaptive_jobs WHERE processor='restore-work' AND state='queued' LIMIT 1").get()!.id);
  assert.equal(q.cancel(cancelled), true);
  const queued = exclusive(async () => { await new Promise((r) => setTimeout(r, 15)); put('soul/notes/queued.md', '先前写入必须完成'); });
  const pending = ops['memory.backup.create']({}, '合成管理者');
  await assert.rejects(ops['memory.backup.create']({}, '合成管理者'), /正在创建/);
  const backup = await pending; await queued;
  assert.equal(backup.verified, true); assert.equal(backup.agent, agent);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(backup.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(backup.directory, 'data/quetzal.db')).mode & 0o777, 0o600);
  }
  assert.ok(fs.statSync(path.join(cfg.paths.data, 'quetzal.db-wal')).size > 0);
  assert.equal(fs.readFileSync(path.join(backup.directory, 'soul/notes/queued.md'), 'utf8'), '先前写入必须完成');
  assert.equal(fs.readFileSync(path.join(backup.directory, 'data/uploads/day/attachment.txt'), 'utf8'), '合成附件');
  assert.ok(!fs.existsSync(path.join(backup.directory, 'data/adaptive-retrieval')));
  assert.ok(!fs.existsSync(path.join(backup.directory, 'secrets')));
  assert.ok(!fs.existsSync(path.join(backup.directory, 'config')));
  const git = (dir: string) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(git(path.join(backup.directory, 'soul')), git(cfg.paths.soul));
  const restoredDir = path.join(home, 'restore-experiment'); fs.cpSync(backup.directory, restoredDir, { recursive: true });
  const restored = new DatabaseSync(path.join(restoredDir, 'data/quetzal.db'));
  try {
    assert.equal(restored.prepare('SELECT text FROM messages WHERE id=?').get(b)?.text, '纠正：饭友是弟弟');
    assert.deepEqual(restored.prepare('SELECT state FROM adaptive_publications ORDER BY rowid').all().map((r) => r.state), ['published', 'pending']);
    const restoredArchive = new AdaptiveArchive(new AdaptiveStore(restored, agent), path.join(restoredDir, 'soul'), checkpoint);
    assert.equal(restoredArchive.history(claim.id).length, 2);
    assert.equal(restoredArchive.supportedClaims()[0].record.text, '饭友是弟弟');
  } finally { restored.close(); }
  assert.equal(ops['memory.backup.verify']({ id: backup.id }).verified, true, '恢复重建不改原备份');
  const target = path.join(home, 'new-body');
  const recovery = restoreMemoryBackup(backup.directory, target);
  assert.notEqual(recovery.body, cfg.config.body);
  assert.notEqual(store.idPrefixOf(recovery.body), store.idPrefixOf(cfg.config.body));
  assert.equal(recovery.agent, agent);
  const copy = new DatabaseSync(path.join(target, 'data/quetzal.db'));
  try {
    const restoredQueue = new AdaptiveStore(copy, agent), restoredArchive = new AdaptiveArchive(restoredQueue, path.join(target, 'soul'), checkpoint);
    assert.equal(restoredQueue.source(a)!.hash, q.source(a)!.hash);
    assert.equal(restoredQueue.source(b)!.hash, q.source(b)!.hash);
    assert.equal(restoredArchive.history(claim.id).length, 2);
    assert.equal(restoredArchive.supportedClaims()[0].record.text, '饭友是弟弟');
    assert.equal(copy.prepare("SELECT count(*) n FROM kv WHERE k IN ('reminders','turns','agents')").get()!.n, 0);
    assert.equal(copy.prepare("SELECT v FROM kv WHERE k='projects'").get()!.v, JSON.stringify([{ id: 'synthetic-project', title: '小说' }]));
    assert.deepEqual(copy.prepare('SELECT state FROM adaptive_publications ORDER BY rowid').all().map((r) => r.state), ['published', 'pending']);
    assert.equal(copy.prepare('SELECT state FROM adaptive_jobs WHERE id=?').get(leased.id)!.state, 'queued');
    assert.equal(copy.prepare('SELECT token FROM adaptive_jobs WHERE id=?').get(leased.id)!.token, null);
    assert.equal(copy.prepare('SELECT state FROM adaptive_jobs WHERE id=?').get(cancelled)!.state, 'cancelled');
  } finally { copy.close(); }
  const historyFile = fs.readdirSync(path.join(target, 'data/restorations'))[0];
  const oldState = JSON.parse(fs.readFileSync(path.join(target, 'data/restorations', historyFile), 'utf8'));
  assert.ok(oldState.state.some((r: { k: string }) => r.k === 'reminders'));
  assert.equal(fs.readFileSync(path.join(target, 'data/uploads/day/attachment.txt'), 'utf8'), '合成附件');
  assert.throws(() => restoreMemoryBackup(backup.directory, target), /EEXIST/);
  assert.throws(() => restoreMemoryBackup(backup.directory, path.join(backup.directory, 'nested')), /备份内/);
  assert.ok(!fs.existsSync(path.join(target, '.restore-incomplete')));
  const probe = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    const cfg = await import(${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)}); cfg.loadConfig();
    const s = await import(${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)}); s.openStore();
    const u = await import(${JSON.stringify(new URL('../src/body/uuid.ts', import.meta.url).href)});
    const identity = await u.ensureBodyUuid(async () => 'same-physical-device');
    const message = s.getSessionMessage(${a}, 'first');
    console.log(JSON.stringify({ id: s.addMessage('user', '合成', '恢复后的新话'), identity, body: cfg.config.body, paused: cfg.config.heart.paused, mesh: cfg.config.mesh, reminders: s.kv.get('reminders', []), attachment: message?.attachments?.[0], rawAttachment: s.db.prepare('SELECT attachments FROM messages WHERE id=?').get(${a}).attachments })); s.db.close();
  `], { env: { ...process.env, QUETZAL_HOME: target }, encoding: 'utf8' });
  const fresh = JSON.parse(probe.trim());
  assert.equal(Math.floor(fresh.id / store.ID_RANGE), store.idPrefixOf(recovery.body));
  assert.equal(fresh.identity.uuid, recovery.uuid); assert.equal(fresh.identity.source, 'stored');
  assert.equal(fresh.paused, true); assert.equal(fresh.mesh.lan, false);
  assert.ok(!fs.existsSync(path.join(target, 'secrets/sync.json')));
  assert.equal(fresh.attachment.path, path.join(target, 'data/uploads/day/attachment.txt'));
  assert.equal(JSON.parse(fresh.rawAttachment)[0].path, attachment.path, '读取换路径不改持久来源');
  assert.deepEqual(fresh.reminders, []);
  assert.equal(ops['memory.backup.verify']({ id: backup.id }).verified, true);
  // 正式入口在 loadConfig / openStore 前分流，不启动模型、网关或守护服务。
  const cliTarget = path.join(home, 'command-restored');
  const command = execFileSync(process.execPath, ['--experimental-strip-types', new URL('../src/main.ts', import.meta.url).pathname, '--restore-memory', backup.directory], { env: { ...process.env, QUETZAL_HOME: cliTarget }, encoding: 'utf8', timeout: 20000 });
  assert.equal(JSON.parse(command).home, fs.realpathSync(cliTarget));
  const stable = await ops['memory.backup.create']({}, '合成管理者');
  store.addMessage('user', '合成', '备份之后的新消息'); put('soul/notes/later.md', '后来的笔记');
  assert.equal(ops['memory.backup.verify']({ id: stable.id }).verified, true);
  assert.equal(ops['memory.backup.list']().length, 2);
  fs.appendFileSync(path.join(stable.directory, 'soul/notes/uncommitted.md'), '损坏');
  assert.throws(() => verifyMemoryBackup(stable.id), /内容损坏/);
  const rejected = path.join(home, 'must-not-exist');
  assert.throws(() => restoreMemoryBackup(stable.directory, rejected), /内容损坏/);
  assert.equal(fs.existsSync(rejected), false);
  const manifestPath = path.join(backup.directory, 'manifest.json');
  const original = fs.readFileSync(manifestPath, 'utf8');
  try {
    fs.writeFileSync(manifestPath, original.replace('quetzal-memory-backup-v1', 'quetzal-memory-backup-future'));
    assert.throws(() => restoreMemoryBackup(backup.directory, rejected), /格式不支持/);
    assert.equal(fs.existsSync(rejected), false);
  } finally { fs.writeFileSync(manifestPath, original); }
});

test('拒绝目录穿越、链接与活动 Git 锁；失败不留下可见成功备份', async () => {
  assert.throws(() => verifyMemoryBackup('../soul'), /编号/);
  const count = ops['memory.backup.list']().length;
  const lock = path.join(cfg.paths.soul, '.git/index.lock'); fs.writeFileSync(lock, '');
  try { await assert.rejects(ops['memory.backup.create']({}, '合成管理者'), /Git 锁/); } finally { fs.unlinkSync(lock); }
  const link = path.join(cfg.paths.soul, 'linked-secret'); fs.symlinkSync(cfg.paths.secrets, link, 'junction');
  try { await assert.rejects(ops['memory.backup.create']({}, '合成管理者'), /符号链接/); } finally { fs.unlinkSync(link); }
  assert.equal(ops['memory.backup.list']().length, count);
  assert.equal(fs.readdirSync(path.join(cfg.paths.data, 'memory-backups')).some((n) => n.startsWith('.partial-')), false);
});

test('不支持的数据格式清理新目标；恢复未完成的家目录不能启动', async () => {
  const backup = await ops['memory.backup.create']({}, '合成管理者');
  const copied = path.join(home, 'unsupported-backup'); fs.cpSync(backup.directory, copied, { recursive: true });
  const db = new DatabaseSync(path.join(copied, 'data/quetzal.db'));
  db.exec('UPDATE adaptive_meta SET version=99'); db.close();
  const { digest } = await import('../src/memory/backup-files.ts');
  const file = path.join(copied, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.files = manifest.files.map((f: { path: string }) => digest(copied, f.path));
  fs.writeFileSync(file, JSON.stringify(manifest));
  const target = path.join(home, 'unsupported-target');
  assert.throws(() => restoreMemoryBackup(copied, target), /认识数据格式不支持/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(verifyMemoryBackup(backup.id).verified, true);
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, '.restore-incomplete'), backup.id);
  const command = spawnSync(process.execPath, ['--experimental-strip-types', new URL('../src/main.ts', import.meta.url).pathname], { env: { ...process.env, QUETZAL_HOME: target }, encoding: 'utf8', timeout: 20000 });
  assert.equal(command.status, 1); assert.match(command.stdout, /恢复未完成/);
  assert.equal(fs.existsSync(path.join(target, 'config')), false, '必须在启动配置、网关与数据库前拒绝');
});

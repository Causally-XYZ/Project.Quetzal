import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
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
const agent = identity().id;
after(async () => { await soul.idle(); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });

test('管理入口备份 WAL 原话、两版认识、未发布结果、Git 历史和附件，后续变化不改快照', async () => {
  store.db.exec('PRAGMA wal_autocheckpoint=0');
  const q = new AdaptiveStore(store.db, agent), archive = new AdaptiveArchive(q, cfg.paths.soul);
  const a = store.addMessage('user', '合成', '饭友是编辑'), b = store.addMessage('user', '合成', '纠正：饭友是弟弟');
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
  const stable = await ops['memory.backup.create']({}, '合成管理者');
  store.addMessage('user', '合成', '备份之后的新消息'); put('soul/notes/later.md', '后来的笔记');
  assert.equal(ops['memory.backup.verify']({ id: stable.id }).verified, true);
  assert.equal(ops['memory.backup.list']().length, 2);
  fs.appendFileSync(path.join(stable.directory, 'soul/notes/uncommitted.md'), '损坏');
  assert.throws(() => verifyMemoryBackup(stable.id), /内容损坏/);
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

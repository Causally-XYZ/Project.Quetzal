// 实际 context_read 工具与本机权威存档；语义修订由测试宿主明确构造。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ClaimRecord, SourceSpan } from '../src/memory/adaptive-evidence.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-adaptive-read-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../src/config.ts'); cfg.loadConfig();
cfg.saveConfig({ body: 'reader', adaptiveMemory: { enabled: true, hostBody: 'center', semantic: true } });
const store = await import('../src/store.ts'); store.openStore();
await (await import('../src/memory/soul-sync.ts')).ensureSoul();
const { identity } = await import('../src/memory/identity.ts');
const { AdaptiveStore } = await import('../src/memory/adaptive-store.ts');
const { AdaptiveArchive } = await import('../src/memory/adaptive-archive.ts');
const { publishPending, publicationRoot } = await import('../src/memory/adaptive-publication.ts');
const { withAdaptiveSources, searchAdaptiveHistory } = await import('../src/memory/adaptive.ts');
const { exclusive } = await import('../src/memory/memory.ts');
const context = await import('../src/mind/context.ts');
const { Session } = await import('../src/mind/activity.ts');
const { callTool } = await import('../src/mind/tools.ts');
const queue = new AdaptiveStore(store.db, identity().id), archive = new AdaptiveArchive(queue, cfg.paths.soul);
store.ensureSession('synthetic-history', '合成历史');
const source = store.addMessage('user', '合成', '饭友是编辑。'.repeat(30), { session: 'synthetic-history' });
const correction = store.addMessage('user', '合成', '更正，饭友是弟弟。', { session: 'synthetic-history' });
queue.schedule();
const span = (id: number): SourceSpan => { const s = queue.source(id)!; return { kind: 'source', source: id, hash: s.hash, start: 0, end: s.text.length, quote: s.text }; };
const claim: ClaimRecord = { id: crypto.randomUUID(), revision: 1, kind: 'claim', state: 'present', realm: { world: 'real', context: 'real' },
  reasons: [span(source)], text: '饭友是编辑', nature: 'reported', participants: [],
  occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
  supports: [{ id: 'direct', premises: [span(source)], assumptions: [] }], counters: [] };
function accept(record: ClaimRecord, processor: string, anchor: number) {
  queue.scheduleSource(processor, anchor);
  assert.equal(archive.accept(queue.claim(processor)!, [source, correction].map((id) => { const s = queue.source(id)!; return { id, revision: s.revision, hash: s.hash }; }),
    { baseGeneration: archive.generation(), records: [record] }), true);
}
accept(claim, 'setup-original', source);
accept({ ...claim, revision: 2, text: '饭友是弟弟', reasons: [span(correction)], supports: [{ id: 'corrected', premises: [span(correction)], assumptions: [] }] }, 'setup-corrected', correction);
const session = new Session('chat', '合成', 'read-turn', 'synthetic-history');
const turn = context.createTurnContext(session.id, session.conv, [{ role: 'user', content: '当时说了什么？' }]);
store.saveContextSource('old-message', session.conv, JSON.stringify({ messageRef: { id: source, conv: session.conv } }));
after(() => { turn.close(); session.close(); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });

test('实际原文工具在非中心身体逐页附带已知修订，原分页可重建，不能走同步旧入口绕过', async () => {
  let full = '';
  for (let offset = 0; ; offset += 80) {
    const result = await callTool('context_read', { ref: 'old-message', offset, limit: 80 }, '合成', { session });
    assert.equal(result.status, 'ok');
    assert.match(result.text, /饭友是弟弟/); assert.match(result.text, /不保证中心最新/);
    const chunk = result.text.split(/\n\[原文 [^\n]+\n/)[1]; assert.notEqual(chunk, undefined);
    full += chunk; if (chunk.length < 80) break;
  }
  assert.equal(JSON.parse(full).message.text, '饭友是编辑。'.repeat(30));
  assert.throws(() => context.contextRead(session.id, 'old-message'), /当前修订读取入口/);
});

test('刚入库尚未排入后台任务的原文可读取；忽略来源后不能通过旧缓存返回正文', async () => {
  const fresh = store.addMessage('user', '合成', '尚未学习的新资料', { session: session.conv });
  assert.ok(!queue.jobs().some((job) => job.source === fresh));
  store.saveContextSource('fresh-message', session.conv, JSON.stringify({ messageRef: { id: fresh, conv: session.conv } }));
  assert.match(await context.contextReadChecked(session.id, 'fresh-message'), /尚未学习的新资料/);
  store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(source);
  try {
    const result = await callTool('context_read', { ref: 'old-message' }, '合成', { session });
    assert.equal(result.status, 'error'); assert.ok(!result.text.includes('饭友是编辑'));
  } finally { store.db.prepare('UPDATE messages SET mode=NULL WHERE id=?').run(source); }
});

test('来源指针不能跨会话；未绑定来源的缓存明确不可用于当前事实确认', async () => {
  store.saveContextSource('bad-pointer', session.conv, JSON.stringify({ messageRef: { id: source, conv: 'other-session' } }));
  await assert.rejects(context.contextReadChecked(session.id, 'bad-pointer'), /不属于当前会话/);
  store.saveContextSource('old-summary', session.conv, '曾经压缩出的摘要资料');
  assert.match(await context.contextReadChecked(session.id, 'old-summary'), /没有可解析的消息来源/);
});

test('权威文件缺失拒绝原文工具返回旧投影；恢复文件后可重新核对', async () => {
  publishPending(queue, cfg.paths.soul, () => true);
  const files = fs.readdirSync(publicationRoot(cfg.paths.soul)).filter((f) => f.endsWith('.md'));
  const file = path.join(publicationRoot(cfg.paths.soul), files[0]), saved = fs.readFileSync(file);
  fs.unlinkSync(file);
  try { await assert.rejects(context.contextReadChecked(session.id, 'old-message'), /文件缺失|结果缺失/); }
  finally { fs.writeFileSync(file, saved); }
  assert.match(await context.contextReadChecked(session.id, 'old-message'), /饭友是弟弟/);
});

test('等灵魂锁超过读取截止或被取消，不执行迟到回调', async () => {
  let release!: () => void, calls = 0;
  const held = exclusive(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  try { await assert.rejects(withAdaptiveSources([source], () => { calls++; return '不应返回'; })); }
  finally { release(); await held; await exclusive(() => {}); }
  assert.equal(calls, 0);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(context.contextReadChecked(session.id, 'old-message', 0, 80, aborted.signal));
});

test('实际 recall 的命中和邻句都附带修订；ignored 邻句不泄漏', async () => {
  const result = await callTool('recall', { query: '编辑', scope: 'chats' }, '合成', { session });
  assert.equal(result.status, 'ok'); assert.match(result.text, /饭友是弟弟/); assert.match(result.text, /generation=/);
  assert.match(result.text, /饭友是编辑/);
  store.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(source);
  try {
    const filtered = await callTool('recall', { query: '更正', scope: 'chats' }, '合成', { session });
    assert.equal(filtered.status, 'ok'); assert.ok(!filtered.text.includes('饭友是编辑'));
  } finally { store.db.prepare('UPDATE messages SET mode=NULL WHERE id=?').run(source); }
});

test('recall 候选等待锁时来源变动，返回前拒绝旧正文', async () => {
  let release!: () => void;
  const held = exclusive(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const pending = searchAdaptiveHistory('编辑', { kinds: ['chat'] });
  store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('已编辑的新原文', source);
  release(); await held;
  try { await assert.rejects(pending, /来源已改变/); }
  finally { store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('饭友是编辑。'.repeat(30), source); }
});

test('关闭新功能不抹去已接受修订的读取门禁', async () => {
  cfg.saveConfig({ adaptiveMemory: { enabled: false, hostBody: 'center', semantic: false } });
  try {
    assert.match(await context.contextReadChecked(session.id, 'old-message'), /饭友是弟弟/);
    const recalled = await callTool('recall', { query: '编辑', scope: 'chats' }, '合成', { session });
    assert.equal(recalled.status, 'ok'); assert.match(recalled.text, /饭友是弟弟/);
    assert.throws(() => context.contextRead(session.id, 'old-message'), /当前修订读取入口/);
  } finally { cfg.saveConfig({ adaptiveMemory: { enabled: true, hostBody: 'center', semantic: true } }); }
});

test('同步读取回调超过截止也不把结果返回为成功', async () => {
  const now = Date.now;
  try {
    await assert.rejects(withAdaptiveSources([source], () => {
      Date.now = () => now() + 1000; // 合成经过时间，不用忙等阻塞测试进程。
      return '迟到结果';
    }), /读取超时/);
  } finally { Date.now = now; }
});

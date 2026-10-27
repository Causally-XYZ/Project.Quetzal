import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answerDigest, type AnswerBasis } from '../src/memory/answer-basis.ts';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-answer-store-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../src/config.ts'); cfg.loadConfig(); cfg.saveConfig({ body: 'reader' });
const store = await import('../src/store.ts'); store.openStore();
after(() => { store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });
const basis: AnswerBasis = { version: 1, agent: 'synthetic', answerHash: answerDigest('合成回复'), consistent: true,
  sources: [{ id: 1, hash: 'a'.repeat(64), reading: 'b'.repeat(64) }] };
test('消息与凭据一同写入并出现在复制行，重开存储后仍可读取', () => {
  const id = store.addMessage('agent', '合成', '合成回复', { session: 'source', answerBasis: basis });
  assert.deepEqual(store.getSessionMessage(id, 'source')!.answerBasis, basis);
  const raw = store.rowsAfter('messages', {}, 10).find((r) => r.id === id)!;
  assert.deepEqual(JSON.parse(raw.answerBasis), basis);
  store.db.close(); store.openStore();
  assert.deepEqual(store.getSessionMessage(id, 'source')!.answerBasis, basis);
  assert.throws(() => store.addMessage('user', '合成', '合成回复', { answerBasis: basis }));
  assert.throws(() => store.addMessage('agent', '合成', '改了的正文', { answerBasis: basis }));
});
test('仅收到回答凭据且后台关闭的新身体仍启用读取核查，不等认识文件到达才保护', async () => {
  cfg.saveConfig({ adaptiveMemory: { enabled: false, semantic: false, hostBody: '' } });
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='adaptive_graph_meta'").get(), undefined);
  const { adaptiveReadingRequired } = await import('../src/memory/adaptive.ts');
  assert.equal(adaptiveReadingRequired(), true);
  const query = store.db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM messages WHERE answerBasis IS NOT NULL LIMIT 1').all();
  assert.match(JSON.stringify(query), /messages_answer_basis/);
});
test('远端凭据形状、正文绑定和角色校验；旧身体无凭据的消息仍可接收', () => {
  const base = store.idPrefixOf('peer') * store.ID_RANGE;
  const raw = { id: base + 1, ts: Date.now(), role: 'agent', channel: '合成', text: '合成回复', session: 'remote', body: 'peer', answerBasis: JSON.stringify(basis) };
  assert.equal(store.applyRemote('messages', [raw], { from: 'peer' }).changed.length, 1);
  assert.deepEqual(store.getSessionMessage(raw.id, 'remote')!.answerBasis, basis);
  for (const [i, patch] of [{ text: '被换过的正文' }, { role: 'user' }, { answerBasis: '{' }, { answerBasis: JSON.stringify({ ...basis, version: 2 }) }].entries())
    assert.equal(store.applyRemote('messages', [{ ...raw, ...patch, id: base + i + 2 }], { from: 'peer' }).rejected, 1);
  assert.equal(store.applyRemote('messages', [{ ...raw, id: base + 10, answerBasis: undefined }], { from: 'peer' }).changed.length, 1);
  assert.equal(store.getSessionMessage(base + 10, 'remote')!.answerBasis, null);
  const complete = { ...raw, id: base + 10 };
  assert.equal(store.applyRemote('messages', [{ ...complete, ts: raw.ts - 1 }], { from: 'peer', catchUp: true }).changed.length, 0, '不同原文版本不能补凭据');
  assert.equal(store.applyRemote('messages', [complete], { from: 'peer', catchUp: true }).changed.length, 1, '新版补齐可恢复旧中转丢失的凭据');
  assert.deepEqual(store.getSessionMessage(base + 10, 'remote')!.answerBasis, basis);
  assert.equal(store.applyRemote('messages', [{ ...complete, answerBasis: JSON.stringify({ ...basis, consistent: false }) }], { from: 'peer', catchUp: true }).changed.length, 0, '已有凭据不被后续副本覆盖');
});

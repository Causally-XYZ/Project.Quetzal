import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-message-mode-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../src/config.ts'); cfg.loadConfig(); cfg.saveConfig({ body: 'alpha' });
const s = await import('../src/store.ts'); s.openStore();
const { bus } = await import('../src/bus.ts');
after(() => { s.db.close(); fs.rmSync(home, { recursive: true, force: true }); });
const add = () => s.addMessage('user', '合成', '旧来源', { session: 'test' });
const mode = (id: number) => s.db.prepare('SELECT mode FROM messages WHERE id=?').get(id)?.mode;

test('消息状态与版本同事务保存；更新失败不发事件，旧值与版本均保留', () => {
  const id = add(); s.setMessageMode(id, 'ignored');
  assert.deepEqual({ ...s.messageMode(id) }, { id, mode: 'ignored', revision: 1, writer: 'alpha' });
  let emitted = 0; const onReplica = () => emitted++; bus.on('replica', onReplica);
  try {
    s.db.exec("CREATE TRIGGER mode_fail BEFORE UPDATE OF mode ON messages BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => s.setMessageMode(id, null), /injected/);
    assert.equal(mode(id), 'ignored'); assert.equal(s.messageMode(id)?.revision, 1); assert.equal(emitted, 0);
  } finally { s.db.exec('DROP TRIGGER mode_fail'); bus.off('replica', onReplica); }
  s.setMessageMode(id, null);
  assert.equal(mode(id), null); assert.equal(s.messageMode(id)?.revision, 2);
});

test('乱序与重复：旧 ignored 不能覆盖因果后续的清空，同版本只应用一次', () => {
  const id = add();
  const newer = { id, mode: null, revision: 2, writer: 'beta' };
  assert.equal(s.applyRemote('message.mode', [newer], { from: 'beta' }).changed.length, 1);
  assert.equal(s.applyRemote('message.mode', [{ ...newer, revision: 1, mode: 'ignored' }, newer], { from: 'beta' }).changed.length, 0);
  assert.equal(mode(id), null); assert.equal(s.messageMode(id)?.revision, 2);
  s.setMessageMode(id, 'ignored'); assert.equal(s.messageMode(id)?.revision, 3);
});

test('并发同版本可交换合并：ignored 优先；非 ignored 按 writer 确定收敛', () => {
  for (const order of [[0, 1], [1, 0]]) {
    const id = add();
    const rows = [{ id, mode: 'ignored', revision: 1, writer: 'alpha' }, { id, mode: null, revision: 1, writer: 'beta' }];
    for (const i of order) s.applyRemote('message.mode', [rows[i]], { from: rows[i].writer });
    assert.equal(mode(id), 'ignored');
    s.applyRemote('message.mode', [{ id, mode: null, revision: 2, writer: 'beta' }], { from: 'beta' });
    assert.equal(mode(id), null);
    const pair = [{ id, mode: 'steer', revision: 3, writer: 'alpha' }, { id, mode: 'queue', revision: 3, writer: 'beta' }];
    for (const i of order) s.applyRemote('message.mode', [pair[i]], { from: pair[i].writer });
    assert.equal(mode(id), 'queue');
  }
});

test('标记先于原文到达，重开数据库后仍保留；原文事务采用已知状态', () => {
  const id = s.idPrefixOf('beta') * s.ID_RANGE + 1;
  s.applyRemote('message.mode', [{ id, mode: 'ignored', revision: 1, writer: 'beta' }], { from: 'beta' });
  s.db.close(); s.openStore();
  const result = s.applyRemote('messages', [{ id, ts: Date.now(), role: 'user', channel: '合成', text: '晚到的原文', session: 'remote', body: 'beta', mode: null }], { from: 'beta' });
  assert.equal(mode(id), 'ignored'); assert.equal(result.changed[0].mode, 'ignored');
});

test('逐字段校验与作者验证；补齐允许转带其他身体的合法修订', () => {
  const id = add();
  for (const row of [null, { id, mode: 'ignored', revision: -1, writer: 'beta' }, { id, mode: null, revision: 1.5, writer: 'beta' },
    { id, mode: null, revision: 1, writer: 'alpha' }, { id, mode: null, revision: 1, writer: '../bad' },
    { id: -1, mode: null, revision: 1, writer: 'beta' }, { id, mode: {}, revision: 1, writer: 'beta' }, { id, mode: null, revision: 0, writer: '' }]) {
    assert.equal(s.applyRemote('message.mode', [row], { from: 'beta' }).rejected, 1);
  }
  assert.equal(s.messageMode(id), undefined);
  assert.equal(s.applyRemote('message.mode', [{ id, mode: 'ignored', revision: 1, writer: 'alpha' }], { from: 'beta', catchUp: true }).changed.length, 1);
});

test('升级快照不伪造作者，旧协议不能覆盖版本化状态，清空仍可传播', () => {
  const id = add(); s.db.prepare("UPDATE messages SET mode='ignored' WHERE id=?").run(id);
  s.db.prepare("DELETE FROM kv WHERE k='store.message-modes'").run(); s.db.close(); s.openStore();
  assert.deepEqual({ ...s.messageMode(id) }, { id, mode: 'ignored', revision: 0, writer: '' });
  assert.equal(s.applyRemote('message.mode', [{ id, mode: null }], { from: 'legacy' }).changed.length, 0);
  s.setMessageMode(id, null); assert.equal(mode(id), null);
  assert.equal(s.applyRemote('message.mode', [{ id, mode: 'ignored' }], { from: 'legacy' }).changed.length, 0);
  const initial = s.addMessage('ambient', '合成', '初始即忽略的声音', { mode: 'ignored' });
  s.applyRemote('message.mode', [{ id: initial, mode: null }], { from: 'legacy' });
  assert.equal(mode(initial), 'ignored', '未建立独立版本的原文状态也不能被旧清空复活');
});

test('分页包含清空状态，乱序请求参数被拒绝', () => {
  for (let i = 0; i < 505; i++) s.setMessageMode(add(), i % 2 ? 'ignored' : null);
  const first = s.messageModesAfter(0, 500), last = first.at(-1)!.id;
  const second = s.messageModesAfter(last);
  assert.equal(first.length, 500); assert.ok(second.length > 5); assert.ok(second.every((r) => r.id > last));
  assert.ok(first.some((r) => r.mode === null));
  assert.throws(() => s.messageModesAfter(-1), /不合法/);
  assert.throws(() => s.messageModesAfter(0, 1001), /不合法/);
});

test('旧库不同快照以任意顺序补齐仍收敛，不受空作者与重复投递影响', () => {
  for (const order of [[null, 'queue', 'steer'], ['steer', null, 'queue'], ['queue', 'steer', null]]) {
    const id = add();
    for (const value of [...order, ...order]) s.applyRemote('message.mode', [{ id, mode: value, revision: 0, writer: '' }], { from: 'relay', catchUp: true });
    assert.equal(mode(id), 'steer');
  }
});

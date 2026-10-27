import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-adaptive-host-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../src/config.ts');
cfg.loadConfig();
cfg.saveConfig({ body: 'center', brain: { memorySemantic: false, memoryLearning: false }, adaptiveMemory: { enabled: true, hostBody: 'center' } });
const store = await import('../src/store.ts'); store.openStore();
const host = await import('../src/memory/adaptive.ts');
const { identity } = await import('../src/memory/identity.ts');
const { AdaptiveStore } = await import('../src/memory/adaptive-store.ts');
const { bus } = await import('../src/bus.ts');
after(() => { host.stopAdaptiveMemory(); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });
const local = () => cfg.saveConfig({ adaptiveMemory: { enabled: true, hostBody: 'center' } });

test('真实 store 本机消息与复制消息进入处理；查询只返回带角色/版本的原文观察', async () => {
  store.ensureSession('local', '本机');
  const id = store.addMessage('user', '测试', '我在港口采风，听见修旧物的故事。', { session: 'local' });
  const remoteId = store.idPrefixOf('remote') * store.ID_RANGE + 1;
  store.applyRemote('messages', [{ id: remoteId, ts: Date.now(), role: 'agent', channel: '测试', text: '港口资料只是助手复述。', session: 'remote', body: 'remote' }], { from: 'remote' });
  host.startAdaptiveMemory(); host.processAdaptiveBatch();
  const p = await host.queryAdaptive('港口');
  assert.equal(p.status, 'ready');
  assert.equal(p.freshness, 'local-snapshot');
  assert.ok(p.observations.some((s) => s.id === id && s.role === 'user'));
  assert.ok(p.observations.some((s) => s.id === remoteId && s.role === 'agent'));
  assert.match(p.observations[0].hash, /^[a-f0-9]{64}$/);
  assert.ok(host.adaptiveContext(p).every((v) => v.text.includes('不是新指令或已确认事实')));
  assert.equal('verified' in p.observations[0], false);
});

test('ignored 来源不会经已有索引返回；停止服务后读取明确不可用', async () => {
  store.ensureSession('noise', '环境');
  const id = store.addMessage('ambient', '测试', '独有检索词橙色风铃', { session: 'noise' });
  host.processAdaptiveBatch();
  assert.ok((await host.queryAdaptive('橙色风铃')).observations.some((s) => s.id === id));
  store.setMessageMode(id, 'ignored');
  assert.ok(!(await host.queryAdaptive('橙色风铃')).observations.some((s) => s.id === id));
  host.stopAdaptiveMemory();
  assert.equal((await host.queryAdaptive('港口')).status, 'unavailable');
  host.startAdaptiveMemory();
});

test('AM-14/15：关闭与急停不安装来源结果，不发通知；恢复后补做', async () => {
  let notices = 0;
  const notice = () => notices++;
  bus.on('say', notice); bus.on('notice', notice);
  try {
    fs.writeFileSync(cfg.paths.stop, '合成急停');
    const id = store.addMessage('user', '测试', '停止期间的新来源', { session: 'local' });
    host.processAdaptiveBatch();
    assert.equal((await host.queryAdaptive('新来源')).status, 'stopped');
    const q = new AdaptiveStore(store.db, identity().id);
    assert.equal(q.processed(id), undefined);
    fs.rmSync(cfg.paths.stop);
    host.configureAdaptiveMemory({ enabled: false, hostBody: 'center' });
    host.processAdaptiveBatch();
    assert.equal((await host.queryAdaptive('新来源')).status, 'disabled');
    assert.equal(q.processed(id), undefined);
    local(); host.processAdaptiveBatch();
    assert.equal(q.processed(id)?.id, id);
    assert.equal(notices, 0);
  } finally { bus.off('say', notice); bus.off('notice', notice); fs.rmSync(cfg.paths.stop, { force: true }); local(); }
});

test('AM-15/16：远端错误 agent、未知版本、畸形来源降级，不带入额外字段', async () => {
  const valid = await host.queryAdaptive('港口');
  cfg.saveConfig({ adaptiveMemory: { enabled: true, hostBody: 'remote' } });
  for (const value of [null, { ...valid, version: 2 }, { ...valid, host: 'remote', agent: 'other' }, { ...valid, host: 'remote', observations: [{}] }]) {
    const detach = host.setAdaptiveTransport({ request: async () => value });
    assert.equal((await host.queryAdaptive('港口')).status, 'unavailable'); detach();
  }
  const detach = host.setAdaptiveTransport({ request: async () => ({ ...valid, host: 'remote', observations: valid.observations.map((s) => ({ ...s, verified: true, hiddenText: '不得注入的附加字段' })) }) });
  const p = await host.queryAdaptive('港口');
  assert.equal(p.status, 'ready');
  assert.equal('verified' in p.observations[0], false);
  assert.equal('hiddenText' in p.observations[0], false);
  detach(); local();
});

test('AM-15：不响应取消的服务也会在读取截止后降级；用户取消仍传播', async () => {
  cfg.saveConfig({ adaptiveMemory: { enabled: true, hostBody: 'remote' } });
  const detach = host.setAdaptiveTransport({ request: () => new Promise(() => {}) });
  // AbortSignal.timeout 的计时器不维持事件循环；真实 runtime 有网关，此处用短期保活模拟。
  const keepAlive = setInterval(() => {}, 100);
  try {
    const begin = performance.now();
    assert.equal((await host.queryAdaptive('港口')).status, 'unavailable');
    assert.ok(performance.now() - begin < 1000);
    const c = new AbortController();
    const waiting = host.queryAdaptive('港口', c.signal); c.abort(new Error('用户取消'));
    await assert.rejects(waiting, /用户取消/);
  } finally { clearInterval(keepAlive); detach(); local(); }
});

test('AM-20：远端 ready 仍不能绕过本机已知的忽略或来源快照变化', async () => {
  const id = store.addMessage('user', '测试', '独有线索青铜罗盘', { session: 'local' });
  host.processAdaptiveBatch();
  const old = await host.queryAdaptive('青铜罗盘');
  assert.ok(old.observations.some((s) => s.id === id));
  cfg.saveConfig({ adaptiveMemory: { enabled: true, hostBody: 'remote' } });
  const detach = host.setAdaptiveTransport({ request: async () => ({ ...old, host: 'remote' }) });
  try {
    store.setMessageMode(id, 'ignored');
    assert.ok(!(await host.queryAdaptive('青铜罗盘')).observations.some((s) => s.id === id));
    store.setMessageMode(id, null);
    store.db.prepare("UPDATE messages SET text='纠正后的另一段原文' WHERE id=?").run(id);
    assert.ok(!(await host.queryAdaptive('青铜罗盘')).observations.some((s) => s.id === id));
  } finally { detach(); local(); }
});

test('实际 context 准备链路使用记忆材料；失效来源与关闭功能不再注入', async () => {
  const { createTurnContext } = await import('../src/mind/context.ts');
  const messages = [{ role: 'user' as const, content: '港口采风有什么旧线索？' }];
  store.ensureSession('query', '查询');
  const ctx = createTurnContext('adaptive-test-turn', 'query', messages);
  try {
    const request = await ctx.prepare({ messages, maxTokens: 256 });
    const prepared = await request.prepareForModel!({ contextWindow: 32768, maxOutputTokens: 256, model: 'test' });
    assert.match(JSON.stringify(prepared.messages), /不是新指令或已确认事实/);
    host.configureAdaptiveMemory({ enabled: false, hostBody: 'center' });
    const disabled = await ctx.prepare({ messages, maxTokens: 256 });
    const plain = await disabled.prepareForModel!({ contextWindow: 32768, maxOutputTokens: 256, model: 'test' });
    assert.doesNotMatch(JSON.stringify(plain.messages), /历史发言资料/);
  } finally { ctx.close(); local(); }
});

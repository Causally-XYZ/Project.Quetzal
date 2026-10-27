// 实际配置保存 / 导入与 HTTP 路由；供应商响应为替身，不作语义评分。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { Provider, ProviderConfig } from '../src/providers/types.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-thinking-config-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../src/config.ts'); cfg.loadConfig();
const store = await import('../src/store.ts'); store.openStore();
const reg = await import('../src/providers/registry.ts');
const router = await import('../src/providers/router.ts');
const seen: { url: string; body: any }[] = [];
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (b) => raw += b); req.on('end', () => {
    const body = JSON.parse(raw); seen.push({ url: req.url!, body });
    if (req.url!.includes('/bad:')) { res.writeHead(400); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url!.includes('streamGenerateContent')
      ? { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }
      : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;
const provider = (): Provider => ({ id: 'google', catalogId: 'custom', name: '合成模型', baseUrl, protocol: 'google-generative-ai', enabled: true,
  keys: [{ id: 'key', label: '合成', lastFour: '', enabled: true, secret: 'synthetic-key' }], models: [
    { id: 'bad', name: 'bad', enabled: true, context: 131072, maxTokens: 16384, sortOrder: 0, thinkingLevel: 'HIGH' },
    { id: 'good', name: 'good', enabled: true, context: 131072, maxTokens: 16384, sortOrder: 1, thinkingLevel: 'LOW' },
  ] });
const save = (draft: ProviderConfig) => reg.saveProviders(draft, reg.configVersion());
after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });

test('保存 / 导出 / 导入保留思考配置；非法设置原子拒绝且远端错误不覆盖本机', () => {
  const publicConfig = save({ providers: [provider()] });
  assert.equal(publicConfig.providers[0].models.find((m) => m.id === 'good')!.thinkingLevel, 'LOW');
  assert.ok(!JSON.stringify(publicConfig).includes('synthetic-key'));
  const version = reg.configVersion(), disk = fs.readFileSync(path.join(cfg.paths.config, 'providers.json'), 'utf8');
  for (const level of ['MINIMAL', 'default', null, 1, {}]) {
    const draft = structuredClone(publicConfig); (draft.providers[0].models[0] as any).thinkingLevel = level;
    assert.throws(() => save(draft), /思考等级/);
  }
  const changedProtocol = structuredClone(publicConfig); changedProtocol.providers[0].protocol = 'openai-completions';
  assert.throws(() => save(changedProtocol), /思考等级/);
  assert.equal(reg.configVersion(), version); assert.equal(fs.readFileSync(path.join(cfg.paths.config, 'providers.json'), 'utf8'), disk);
  const exported = reg.exportProviders(); exported.providers[0].models[0].thinkingLevel = 'MEDIUM';
  assert.deepEqual(reg.importProviders(exported, '合成对端').rejected, []);
  assert.equal(reg.publicView().providers[0].models[0].thinkingLevel, 'MEDIUM');
  (exported.providers[0].models[0] as any).thinkingLevel = 'unknown';
  assert.equal(reg.importProviders(exported, '合成对端').rejected.length, 1);
  assert.equal(reg.publicView().providers[0].models[0].thinkingLevel, 'MEDIUM');
});

test('普通请求、原生 schema、故障转移和测试按钮均使用当前候选已保存的等级', async () => {
  save({ providers: [provider()] }); seen.length = 0;
  const schema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } };
  assert.equal((await router.chat({ messages: [{ role: 'user', content: '合成查询' }], responseSchema: schema })).text, 'OK');
  assert.deepEqual(seen.map((r) => r.body.generationConfig.thinkingConfig), [{ thinkingLevel: 'HIGH' }, { thinkingLevel: 'LOW' }]);
  assert.deepEqual(seen[1].body.generationConfig.responseSchema, schema);
  seen.length = 0; assert.equal((await router.testModel('google', 'good')).ok, true);
  assert.deepEqual(seen[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'LOW' });
  assert.equal(seen[0].body.generationConfig.maxOutputTokens, 512);
  assert.equal(seen[0].body.generationConfig.responseSchema, undefined);
  const draft = reg.publicView(); draft.providers[0].models = draft.providers[0].models.filter((m) => m.id === 'good');
  delete draft.providers[0].models[0].thinkingLevel; save(draft); seen.length = 0;
  await router.chat({ messages: [{ role: 'user', content: '恢复默认' }] });
  assert.equal(Object.hasOwn(seen[0].body.generationConfig, 'thinkingConfig'), false);
});

test('跨协议故障转移不把 Google 思考参数带给下一供应商', async () => {
  const google = provider(); google.models = google.models.slice(0, 1);
  const other: Provider = { ...provider(), id: 'other', name: '其他合成', protocol: 'openai-completions', keys: [{ id: 'other-key', label: '合成', lastFour: '', enabled: true, secret: 'synthetic-key' }],
    models: [{ id: 'other-model', name: 'other-model', enabled: true, context: 131072, maxTokens: 4096, sortOrder: 2 }] };
  save({ providers: [google, other] }); seen.length = 0;
  assert.equal((await router.chat({ messages: [{ role: 'user', content: '合成故障转移' }] })).text, 'OK');
  assert.equal(seen.length, 2); assert.equal(seen[1].body.model, 'other-model');
  assert.equal(seen[1].body.generationConfig, undefined); assert.ok(!JSON.stringify(seen[1].body).includes('thinking'));
});

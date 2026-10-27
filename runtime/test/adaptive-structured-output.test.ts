// 实际路由和 HTTP 适配器；供应商响应为合成数据，不计为真实语义成绩。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-output-schema-'));
process.env.QUETZAL_HOME = home;
const cfg = await import('../src/config.ts'); cfg.loadConfig();
const store = await import('../src/store.ts'); store.openStore();
const registry = await import('../src/providers/registry.ts');
const { chat } = await import('../src/providers/router.ts');
const { generateAdaptiveProposal } = await import('../src/memory/adaptive-model.ts');
const { proposalResponseSchema } = await import('../src/memory/adaptive-proposal.ts');
const prompt = { system: '提取合成资料', user: '当前来源：一个合成对象。', schema: proposalResponseSchema() };
const patch = { contexts: [], records: [] };
const seen: { google: boolean; body: any }[] = [];
let mode = 'valid';
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (part) => { raw += part; }); req.on('end', () => {
    const google = req.url!.includes('streamGenerateContent'), body = JSON.parse(raw); seen.push({ google, body });
    if (google && mode === 'fallback') { res.writeHead(400); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    const text = mode === 'fences' ? '```json\n{}\n```' : JSON.stringify(patch);
    res.end(JSON.stringify(google ? { candidates: [{ content: { parts: mode === 'tools' ? [{ functionCall: { name: 'unexpected', args: {} } }] : [{ text }] },
      finishReason: mode === 'truncated' ? 'MAX_TOKENS' : 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }
      : { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;
function configure(protocols: ('google-generative-ai' | 'openai-completions')[], context = 131072) {
  registry.saveProviders({ providers: protocols.map((protocol, i) => ({ id: `p${i}`, name: `Synthetic${i}`, catalogId: 'custom', baseUrl, protocol, enabled: true,
    keys: [{ id: `k${i}`, label: 'fixture', lastFour: '', enabled: true, secret: 'synthetic-key' }],
    models: [{ id: `m${i}`, name: 'synthetic', enabled: true, context, maxTokens: 16384, sortOrder: i }] })) }, registry.configVersion());
  seen.length = 0;
}
after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });

test('Google 原生 schema 经实际路由进入请求；提示不重复 schema，普通对话不启用', async () => {
  configure(['google-generative-ai']); mode = 'valid';
  assert.deepEqual(await generateAdaptiveProposal(prompt, new AbortController().signal), patch);
  const body = seen[0].body;
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema, prompt.schema);
  assert.ok(!body.systemInstruction.parts[0].text.includes(JSON.stringify(prompt.schema)));
  assert.equal(body.tools, undefined);
  await chat({ messages: [{ role: 'user', content: '普通对话' }] });
  assert.equal(seen[1].body.generationConfig.responseMimeType, undefined);
  assert.equal(seen[1].body.generationConfig.responseSchema, undefined);
});

test('Google 拒绝约束后按既有顺序故障转移；其他协议重新准备完整提示且不接收不支持字段', async () => {
  configure(['google-generative-ai', 'openai-completions']); mode = 'fallback'; const usage: any[] = [];
  assert.deepEqual(await generateAdaptiveProposal(prompt, new AbortController().signal, (u) => usage.push(u)), patch);
  assert.deepEqual(seen.map((r) => r.google), [true, false]);
  assert.ok(seen[1].body.messages[0].content.includes(JSON.stringify(prompt.schema)));
  assert.equal(seen[1].body.responseSchema, undefined); assert.equal(seen[1].body.response_format, undefined);
  assert.equal(usage[0].model, 'Synthetic1/synthetic');
  configure(['openai-completions']);
  await assert.rejects(chat({ messages: [], responseSchema: prompt.schema }), /尚未接入原生结构化输出/);
  assert.equal(seen.length, 0, '不得悄悄忽略显式原生约束');
});

test('原生格式请求不豁免本地校验；围栏、工具调用、截断仍失败，完整 schema 仍计入窗口', async () => {
  configure(['google-generative-ai']); const usage: any[] = [];
  for (mode of ['fences', 'tools', 'truncated'])
    await assert.rejects(generateAdaptiveProposal(prompt, new AbortController().signal, (u) => usage.push(u)), /JSON|输出/);
  assert.equal(usage.length, 3, '格式失败也不能丢失已经返回的用量');
  configure(['google-generative-ai'], 2000); mode = 'valid';
  await assert.rejects(generateAdaptiveProposal(prompt, new AbortController().signal), /超出模型窗口/);
  assert.equal(seen.length, 0);
});

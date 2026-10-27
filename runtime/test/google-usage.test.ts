// 合成 HTTP 响应验证真实适配器、路由、SQLite 与记忆用量回调；不访问真实供应商。
import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { adapters, type Target } from '../src/providers/adapters.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-google-usage-'));
process.env.QUETZAL_HOME = home;
const { loadConfig } = await import('../src/config.ts'); loadConfig();
const store = await import('../src/store.ts'); store.openStore();
const registry = await import('../src/providers/registry.ts');
const { generateAdaptiveProposal } = await import('../src/memory/adaptive-model.ts');
after(() => { store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });

async function endpoint(t: TestContext, chunks: unknown[], format: 'sse' | 'json' | 'array' = 'sse'): Promise<Target> {
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': format === 'sse' ? 'text/event-stream' : 'application/json' });
      res.end(format === 'sse' ? chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')
        : JSON.stringify(format === 'array' ? chunks : chunks[0]));
    });
  });
  t.after(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { protocol: 'google-generative-ai', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'synthetic-key', model: 'synthetic-model', maxTokens: 16384 };
}
const request = { messages: [{ role: 'user' as const, content: '合成输入' }] };
const response = (text: string) => ({ candidates: [{ content: { parts: [{ text: '隐藏的思考', thought: true }, { text }] }, finishReason: 'STOP' }] });

test('Gemini SSE 累计用量不重复相加；后续缺字段或非法值不清零，思考不进入正文', async (t) => {
  const metadata = { promptTokenCount: 100, candidatesTokenCount: 5, thoughtsTokenCount: 20, toolUsePromptTokenCount: 3, totalTokenCount: 128 };
  const target = await endpoint(t, [
    { ...response('答'), usageMetadata: metadata }, { usageMetadata: metadata },
    { candidates: [{ content: { parts: [{ text: '案' }] } }], usageMetadata: { candidatesTokenCount: 8, totalTokenCount: 131 } },
    { usageMetadata: { promptTokenCount: null, candidatesTokenCount: -1, thoughtsTokenCount: '99', totalTokenCount: 1.5, toolUsePromptTokenCount: 1e30 } },
  ]);
  let streamed = '';
  const result = await adapters[target.protocol](target, { ...request, onText: (text) => { streamed += text; } });
  assert.equal(result.text, '答案'); assert.equal(streamed, '答案');
  assert.deepEqual(result.usage, { input: 103, output: 28, reasoning: 20, total: 131 });
});

test('Gemini JSON 对象与数组采用相同用量口径；供应商 total 原样保留不覆盖为推算值', async (t) => {
  for (const format of ['json', 'array'] as const) {
    const target = await endpoint(t, [{ ...response('{}'), usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 2, thoughtsTokenCount: 9, totalTokenCount: 60 } }], format);
    const result = await adapters[target.protocol](target, request);
    assert.deepEqual(result.usage, { input: 40, output: 11, reasoning: 9, total: 60 });
    assert.equal(result.text, '{}');
  }
});

test('未报告思考和总量保持缺失；明确零可覆盖旧快照，思考独占输出也可计量', async (t) => {
  for (const [chunks, expected] of [
    [[{ ...response('{}'), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }], { input: 10, output: 2 }],
    [[{ usageMetadata: { thoughtsTokenCount: 7 } }], { input: 0, output: 7, reasoning: 7 }],
    [[{ usageMetadata: { thoughtsTokenCount: 7 } }, { usageMetadata: { thoughtsTokenCount: 0, totalTokenCount: 0 } }], { input: 0, output: 0, reasoning: 0, total: 0 }],
    [[response('{}')], { input: 0, output: 0 }],
  ] as const) {
    const target = await endpoint(t, [...chunks]);
    assert.deepEqual((await adapters[target.protocol](target, request)).usage, expected);
  }
  const target = await endpoint(t, [{ usageMetadata: { candidatesTokenCount: Number.MAX_SAFE_INTEGER, thoughtsTokenCount: 1 } }]);
  await assert.rejects(adapters[target.protocol](target, request), /安全整数/);
});

test('真实路由的每日聚合与估算费用包含思考一次；后台回调保留明细，包括不可安装的提案', async (t) => {
  const reports: unknown[] = [];
  const before = store.usageToday();
  for (const text of ['{}', '不是 JSON']) {
    const target = await endpoint(t, [{ ...response(text), usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 30, totalTokenCount: 140 } }]);
    registry.saveProviders({ providers: [{ id: 'p', catalogId: 'custom', name: 'Synthetic', enabled: true, baseUrl: target.baseUrl,
      protocol: target.protocol, keys: [{ id: 'k', label: '合成', lastFour: '', enabled: true, secret: target.apiKey }],
      models: [{ id: 'm', name: target.model, enabled: true, context: 131072, maxTokens: 16384, sortOrder: 0, cost: { input: 1, output: 2 } }],
    }] }, registry.configVersion());
    const result = generateAdaptiveProposal({ system: '合成测试', user: '合成输入',
      schema: { type: 'OBJECT', properties: {}, required: [], propertyOrdering: [] } }, new AbortController().signal, (usage) => reports.push(usage));
    if (text === '{}') assert.deepEqual(await result, {}); else await assert.rejects(result, /完整 JSON/);
  }
  assert.deepEqual(reports, Array.from({ length: 2 }, () => ({ model: 'Synthetic/synthetic-model', input: 100, output: 40, reasoning: 30, total: 140 })));
  assert.equal(store.usageToday().tokens - before.tokens, 280);
  assert.ok(Math.abs(store.usageToday().cost - before.cost - 0.00036) < 1e-12);
  const rows = store.usageRows(); assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 200); assert.equal(rows[0].output, 80);
});

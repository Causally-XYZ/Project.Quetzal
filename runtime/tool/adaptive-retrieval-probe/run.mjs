// 实际本机嵌入 + 生产词面函数 + 固定上游 RRF；仅公开开发案例，不加载用户数据。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { rank } from '../../../engine/src/retrieval.ts';
import { reciprocalRankFusion } from '../../src/memory/adaptive-ranking.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = await realpath(process.argv[2]);
const repo = await realpath(path.resolve(here, '../../..'));
assert(!work.startsWith(repo + path.sep) && work !== repo, '依赖、模型和报告必须在仓库外');
const oss = process.argv[3];
assert(oss, '用法：node run.mjs <仓库外工作目录> <固定上游 clone 父目录 | --lexical-only>');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const pin = JSON.parse(await readFile(path.join(here, 'model.json'), 'utf8'));
const data = await readFile(path.join(here, 'cases.json'));
const cases = JSON.parse(data);
assert.equal(cases.documents.length, new Set(cases.documents.map((d) => d[0])).size);
assert.equal(cases.queries.length, new Set(cases.queries.map((q) => q.id)).size);
for (const q of cases.queries) for (const id of q.relevant) assert(cases.documents.some((d) => d[0] === id));
const docs = cases.documents.map(([source, title, text]) => ({ kind: 'memory', source, title, text, mtime: 0 }));
const summarize = (rows, methods) => {
  const eligible = rows.filter((r) => r.relevant.length);
  return Object.fromEntries(methods.map((method) => [method,
    Object.fromEntries([1, 3, 6].map((k) => [k, {
      hit: eligible.filter((r) => r[method].slice(0, k).some((x) => r.relevant.includes(x.id))).length,
      total: eligible.length,
      recall: eligible.reduce((sum, r) => sum + r[method].slice(0, k).filter((x) => r.relevant.includes(x.id)).length / r.relevant.length, 0) / eligible.length,
    }]))]));
};
if (oss === '--lexical-only') {
  const rows = cases.queries.map((q) => ({ ...q, lexical: rank(q.query, docs, 0).map((x) => ({ id: x.source, score: x.score })) }));
  const report = { version: 1, kind: 'lexical-only', casesHash: hash(data),
    lexicalHash: hash(await readFile(path.join(repo, 'engine/src/retrieval.ts'))),
    summary: summarize(rows, ['lexical']), rows };
  const target = path.join(work, `baseline-${Date.now()}.json`);
  await writeFile(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report: target, summary: report.summary }, null, 2));
  process.exit(0);
}
function verifyFusion(input) {
  const result = spawnSync('python3', ['-B', path.join(here, 'fuse.py'), oss], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const original = JSON.parse(result.stdout);
  return input.map((row, i) => Object.fromEntries([1, 60].map((k) => {
    const actual = reciprocalRankFusion(row, k);
    assert.deepEqual(actual.map((x) => x.key), original[i][k][0]);
    actual.forEach((x, j) => assert(Math.abs(x.score - original[i][k][1][j]) < 1e-12));
    return [k, actual];
  })));
}
if (process.argv[4] === '--fusion-only') {
  let seed = 17;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const input = [[], [[], []], [['a', 'b'], ['b', 'c']], ...Array.from({ length: 200 }, () =>
    Array.from({ length: next() % 4 }, () => Array.from({ length: next() % 20 }, () => `key-${next() % 15}`)))];
  verifyFusion(input);
  console.log(JSON.stringify({ status: 'passed', cases: input.length, constants: [1, 60], inputHash: hash(JSON.stringify(input)) }));
  process.exit(0);
}
if (process.argv[4] === '--vertex') {
  const receipt = await readFile(process.argv[5]);
  const source = JSON.parse(receipt);
  assert.equal(source.status, 'completed'); assert.equal(source.model, 'gemini-embedding-001');
  assert.equal(source.casesHash, hash(data)); assert.equal(source.dimensions, 768);
  assert.equal(source.scriptHash, hash(await readFile(path.join(here, 'vertex.py'))));
  assert.equal(source.transportScriptHash, hash(await readFile(path.join(here, '../adaptive-vertex-proposal.py'))));
  assert(['urllib', 'curl'].includes(source.transport));
  assert.equal(source.documents.length, docs.length); assert.equal(source.queries.length, cases.queries.length * 3);
  assert.equal(source.calls.length, docs.length + cases.queries.length * 3);
  assert(source.calls.every((c) => c.ok && c.truncated === false && Number.isFinite(c.latencyMs)));
  const vectors = [...source.documents, ...source.queries];
  for (const item of vectors) {
    assert.equal(item.vector.length, 768); assert(item.vector.every(Number.isFinite));
    assert(Math.abs(Math.hypot(...item.vector) - 1) < 1e-6);
  }
  const find = (list, id, repeat) => {
    const matches = list.filter((v) => v.id === id && v.repeat === repeat);
    assert.equal(matches.length, 1); return matches[0].vector;
  };
  const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
  const rows = cases.queries.map((q) => {
    const query = find(source.queries, q.id, 0);
    return { ...q, lexical: rank(q.query, docs, 0).map((x) => ({ id: x.source, score: x.score })),
      dense: docs.map((d) => ({ id: d.source, score: dot(query, find(source.documents, d.source, 0)) })).sort((a, b) => b.score - a.score),
      repeatSimilarity: [1, 2].map((repeat) => dot(query, find(source.queries, q.id, repeat))) };
  });
  const fused = verifyFusion(rows.map((r) => [r.lexical.slice(0, 6).map((x) => x.id), r.dense.slice(0, 6).map((x) => x.id)]));
  rows.forEach((row, i) => { for (const k of [1, 60]) row[`rrf${k}`] = fused[i][k].map((x) => ({ id: x.key, score: x.score })); });
  const latencies = source.calls.filter((c) => c.kind === 'query').map((c) => c.latencyMs).sort((a, b) => a - b);
  assert.equal(latencies.length, cases.queries.length * 3);
  const report = { version: 1, kind: 'vertex-embedding-comparison', model: source.model, modelVersion: source.modelVersion, transport: source.transport, requestTimeoutSeconds: source.requestTimeoutSeconds,
    receiptHash: hash(receipt), casesHash: hash(data), sourceHashes: {
      ranking: hash(await readFile(path.join(repo, 'runtime/src/memory/adaptive-ranking.ts'))),
      lexical: hash(await readFile(path.join(repo, 'engine/src/retrieval.ts'))), run: hash(await readFile(path.join(here, 'run.mjs'))),
    }, summary: summarize(rows, ['lexical', 'dense', 'rrf1', 'rrf60']), rows,
    queryP50Ms: latencies[Math.ceil(latencies.length * 0.5) - 1], queryP95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
    tokensReported: source.calls.every((c) => Number.isFinite(c.tokenCount)) ? source.calls.reduce((s, c) => s + c.tokenCount, 0) : null,
    billableCharactersReported: source.calls.every((c) => Number.isFinite(c.billableCharacterCount)) ? source.calls.reduce((s, c) => s + c.billableCharacterCount, 0) : null,
    warnings: ['公开短材料召回对照，不是事实判断或正式留出成绩', '无相关性阈值，无关问题也会有向量近邻', '采样期间有组件下载，延迟含网络和请求开销，不是纯模型推理时间'] };
  const target = path.join(work, `vertex-comparison-${Date.now()}.json`);
  await writeFile(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report: target, summary: report.summary, queryP50Ms: report.queryP50Ms, queryP95Ms: report.queryP95Ms }, null, 2));
  process.exit(0);
}
const lockBytes = await readFile(path.join(work, 'package-lock.json'));
assert.equal(hash(lockBytes), hash(await readFile(path.join(here, 'package-lock.json'))), '锁文件不一致');
const lock = JSON.parse(lockBytes);
for (const [name, value] of Object.entries(lock.packages)) {
  if (!name) continue;
  assert(value.resolved.startsWith('https://registry.npmjs.org/') && value.integrity.startsWith('sha512-'), `未锁定来源：${name}`);
}
for (const file of pin.files) {
  const content = await readFile(path.join(work, 'model', file.path));
  assert.equal(content.length, file.size, file.path);
  const digest = file.sha256 ? hash(content) : createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  assert.equal(digest, file.sha256 ?? file.git, file.path);
}
const packagePath = path.join(work, 'node_modules/@huggingface/transformers/package.json');
const packageMeta = JSON.parse(await readFile(packagePath, 'utf8'));
assert.equal(packageMeta.version, '3.8.1');
const { pipeline, env } = await import(pathToFileURL(path.join(path.dirname(packagePath), packageMeta.exports.node.import.default)));
// 测量期间严格本地加载；首次下载由 prepare.py 显式执行并校验，不触发自动取权重。
env.allowRemoteModels = false;
env.useBrowserCache = false;
const loadStart = performance.now();
const extractor = await pipeline('feature-extraction', path.join(work, 'model'), {
  dtype: 'q8', device: 'cpu', local_files_only: true,
  session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
});
const loadMs = performance.now() - loadStart;
assert.equal(extractor.tokenizer.model_max_length, 512);
const timings = { passages: [], queries: [] };
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const embed = async (text, kind) => {
  const start = performance.now();
  const tensor = await extractor(`${kind === 'passages' ? 'passage' : 'query'}: ${text}`, {
    pooling: 'mean', normalize: true,
  });
  const vector = Array.from(tensor.data);
  assert.equal(vector.length, 384);
  assert(vector.every(Number.isFinite));
  assert(Math.abs(Math.hypot(...vector) - 1) < 0.0001);
  timings[kind].push(performance.now() - start);
  return vector;
};
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const rows = [];
const firstQueries = new Map();
try {
  const vectors = [];
  for (const doc of docs) vectors.push(await embed(`${doc.title}\n${doc.text}`, 'passages'));
  for (let repeat = 0; repeat < 3; repeat++) for (const query of cases.queries) {
    const v = await embed(query.query, 'queries');
    const dense = docs.map((doc, i) => ({ id: doc.source, score: dot(v, vectors[i]) }))
      .sort((a, b) => b.score - a.score);
    if (repeat === 0) {
      const lexical = rank(query.query, docs, 0).map((hit) => ({ id: hit.source, score: hit.score }));
      rows.push({ ...query, lexical, dense });
      firstQueries.set(query.id, v);
    } else assert(dot(v, firstQueries.get(query.id)) > 0.9999, '重复运行嵌入发生漂移');
  }
  // 与 Graphiti 默认 RRF 和常见常数 60 对照；各通路先取6候选，既定设置不按结果改写。
  const input = rows.map((r) => [r.lexical.slice(0, 6).map((x) => x.id), r.dense.slice(0, 6).map((x) => x.id)]);
  const fused = verifyFusion(input);
  rows.forEach((row, i) => {
    for (const k of [1, 60]) row[`rrf${k}`] = fused[i][k].map((x) => ({ id: x.key, score: x.score }));
  });
  const summary = summarize(rows, ['lexical', 'dense', 'rrf1', 'rrf60']);
  const longText = 'query: ' + '无关的背景细节。'.repeat(1000) + '真正的问题在最后：饭友是谁？';
  const longInput = extractor.tokenizer(longText, { padding: true, truncation: true });
  assert.equal(longInput.input_ids.dims[1], 512);
  const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1];
  lag.disable();
  const report = { version: 1, purpose: cases.purpose, node: process.version,
    model: pin, library: '3.8.1', dtype: 'q8', device: 'cpu', threads: 1,
    casesHash: hash(data), lockHash: hash(lockBytes),
    sourceHashes: Object.fromEntries(await Promise.all(['run.mjs', 'fuse.py', 'prepare.py'].map(async (file) => [file, hash(await readFile(path.join(here, file)))]))),
    lexicalHash: hash(await readFile(path.join(repo, 'engine/src/retrieval.ts'))),
    graphiti: '2b5db9e139b2627c3ba18ff55f9181569b0d8224',
    longInput: { characters: longText.length, usedTokens: longInput.input_ids.dims[1], truncated: true },
    loadMs, timings, queryP50: percentile(timings.queries, 0.5), queryP95: percentile(timings.queries, 0.95),
    eventLoopMaxMs: lag.max / 1e6, maxRssBytes: process.resourceUsage().maxRSS * 1024,
    summary, rows, warnings: ['仅候选召回；不是语义真值、身份绑定或全产品延迟验收',
      '没有零命中阈值，向量为无关问题也返回候选', '短合成资料，无长文分块、生产索引和跨身体接入'] };
  // 不覆盖旧运行证据。
  const target = path.join(work, `report-${Date.now()}.json`);
  await writeFile(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report: target, loadMs, queryP50: report.queryP50, queryP95: report.queryP95,
    eventLoopMaxMs: report.eventLoopMaxMs, maxRssBytes: report.maxRssBytes, summary }, null, 2));
} finally {
  lag.disable();
  await extractor.dispose();
}

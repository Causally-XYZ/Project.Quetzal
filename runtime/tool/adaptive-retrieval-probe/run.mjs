// 实际本机嵌入 + 生产词面函数 + 固定上游 RRF；仅公开开发案例，不加载用户数据。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { rank } from '../../../engine/src/retrieval.ts';

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
  const result = spawnSync('python3', ['-B', path.join(here, 'fuse.py'), oss], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const fused = JSON.parse(result.stdout);
  rows.forEach((row, i) => {
    for (const k of [1, 60]) row[`rrf${k}`] = fused[i][k][0].map((id, j) => ({ id, score: fused[i][k][1][j] }));
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

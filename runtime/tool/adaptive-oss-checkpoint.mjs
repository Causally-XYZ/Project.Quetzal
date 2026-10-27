// 已安装的固定 npm 版本契约实验，不冒充持久数据库或完整 LangGraph 执行器。
// node runtime/tool/adaptive-oss-checkpoint.mjs <仓库外 npm install --prefix 的目录>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('请提供仓库外安装目录');
const packageDir = path.resolve(root, 'node_modules/@langchain/langgraph-checkpoint');
const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
assert.equal(pkg.version, '1.2.1');
assert.equal(JSON.parse(fs.readFileSync(path.resolve(root, 'node_modules/@langchain/core/package.json'), 'utf8')).version, '1.1.48');
const lock = JSON.parse(fs.readFileSync(path.resolve(root, 'package-lock.json'), 'utf8'));
assert.equal(lock.lockfileVersion, 3);
for (const [name, entry] of Object.entries(lock.packages)) {
  if (!name) continue;
  assert.ok(name.startsWith('node_modules/') && !name.split('/').includes('..'));
  assert.ok(entry.resolved?.startsWith('https://registry.npmjs.org/') && entry.integrity?.startsWith('sha512-'));
  assert.equal(JSON.parse(fs.readFileSync(path.resolve(root, name, 'package.json'), 'utf8')).version, entry.version);
}
const { MemorySaver, emptyCheckpoint } = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')).href);
const saver = new MemorySaver();
const config = { configurable: { thread_id: 'synthetic-agent', checkpoint_ns: 'memory-job' } };
const metadata = { source: 'update', step: 0, parents: {} };
const first = emptyCheckpoint();
first.channel_values = { sourceRevision: 1, candidates: ['editor', 'brother'], state: 'unresolved' };
const saved = await saver.put(config, first, metadata);
await saver.putWrites(saved, [['proposal', { binding: 'editor' }]], 'extract-job', '0');
await saver.putWrites(saved, [['proposal', { binding: 'brother' }]], 'extract-job', '0');
let read = await saver.getTuple(saved);
assert.equal(read.pendingWrites.length, 1);
assert.equal(read.pendingWrites[0][2].binding, 'editor'); // 普通同 task/index 写入幂等

const second = emptyCheckpoint();
second.channel_values = { sourceRevision: 2, candidates: ['brother'], state: 'corrected' };
const corrected = await saver.put(saved, second, { ...metadata, step: 1 });
read = await saver.getTuple(corrected);
assert.equal(read.parentConfig.configurable.checkpoint_id, saved.configurable.checkpoint_id);
assert.equal((await saver.getTuple(saved)).checkpoint.channel_values.sourceRevision, 1);
assert.equal(read.checkpoint.channel_values.sourceRevision, 2);
assert.equal(await saver.getTuple({ configurable: { thread_id: 'other-agent' } }), undefined);

// 检查点有版本不等于旧前提被禁止安装：put 本身没有 Quetzal 的来源修订门禁。
const stale = emptyCheckpoint();
stale.channel_values = { sourceRevision: 1, state: 'old-result' };
const staleConfig = await saver.put(corrected, stale, { ...metadata, step: 2 });
assert.equal((await saver.getTuple(staleConfig)).checkpoint.channel_values.sourceRevision, 1);
assert.equal(await new MemorySaver().getTuple(staleConfig), undefined); // 内存 saver 不恢复进程数据
await saver.deleteThread('synthetic-agent');
assert.equal(await saver.getTuple(saved), undefined);
assert.equal(await saver.getTuple(corrected), undefined);
assert.equal(await saver.getTuple(staleConfig), undefined);

console.log(JSON.stringify({ schema: 'quetzal-oss-probe-v1', package: pkg.name, version: pkg.version,
  lockedPackages: Object.keys(lock.packages).length - 1,
  scope: '真实 MemorySaver；非 SQLite、非完整执行器、无模型调用', checks: 5,
  results: ['同任务写入幂等', '检查点保留父版本', '不同 thread 隔离',
    '旧来源结果可保存，宿主仍须做版本门禁', '内存 saver 不跨实例恢复，deleteThread 清理历史'],
}, null, 2));

// 合成读取基准：真实权威文件、SQLite 投影和证据查询；不调用模型，不写真实家目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';
import { AdaptiveArchive } from '../src/memory/adaptive-archive.ts';
import { seedReadWorkload } from './adaptive-read-workload.ts';

const samples = Number(process.argv[2] ?? 100), sizes = (process.argv[3] ?? '100,500,1000').split(',').map(Number);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 1000 || sizes.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 1000))
  throw new Error('样本数需为1～1000，语料规模需为1～1000的逗号分隔整数');
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), at = (p: number) => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(3));
  return { count: sorted.length, p50Ms: at(.5), p95Ms: at(.95), maxMs: at(1), over500ms: values.filter((n) => n > 500).length };
};
for (const size of sizes) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-read-bench-')), soul = path.join(home, 'soul');
  fs.mkdirSync(soul);
  const db = new DatabaseSync(path.join(home, 'data.db'));
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)');
    const queue = new AdaptiveStore(db, 'synthetic-benchmark');
    const { bytes } = seedReadWorkload(queue, soul, size);
    const started = performance.now();
    const archive = new AdaptiveArchive(queue, soul); assert.equal(archive.current().length, size);
    const coldMs = performance.now() - started, queryMs: number[] = [], historyMs: number[] = [];
    for (let i = 0; i < samples; i++) {
      // 实际宿主每次快照创建 Archive 实例，不能只测复用对象的缓存命中。
      let begin = performance.now();
      const selection = new AdaptiveArchive(queue, soul).query('港口采风', (id) => queue.source(id));
      queryMs.push(performance.now() - begin); assert.equal(selection.matched, size);
      begin = performance.now(); new AdaptiveArchive(queue, soul).readSources([1]); historyMs.push(performance.now() - begin);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    db.exec("UPDATE messages SET mode='ignored' WHERE id=1");
    assert.equal(new AdaptiveArchive(queue, soul).query('港口采风', (id) => queue.source(id)).matched, size - 1);
    console.log(JSON.stringify({ size, artifacts: size, artifactBytes: bytes, samples, coldMs: Number(coldMs.toFixed(3)),
      query: stats(queryMs), sourceReading: stats(historyMs), ignoredSourceExcluded: true, node: process.version }));
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
}

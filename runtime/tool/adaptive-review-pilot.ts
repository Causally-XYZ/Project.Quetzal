// 在已有合成开发库的独立副本上执行真实依赖重评；不作为生产入口或留出集成绩。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';
import { AdaptiveArchive } from '../src/memory/adaptive-archive.ts';
import { reviewNext } from '../src/memory/adaptive-review.ts';
import { publishPending } from '../src/memory/adaptive-publication.ts';

const [model, home] = process.argv.slice(2);
if (!['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'].includes(model) || !home || !path.isAbsolute(home)) throw new Error('请提供测试模型和仓库外已有合成试跑库副本');
const root = fs.realpathSync(home), repo = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
if (root === repo || root.startsWith(`${repo}${path.sep}`)) throw new Error('评测必须在仓库外');
if (!fs.existsSync(path.join(root, 'pilot.db')) || !fs.existsSync(path.join(root, 'soul')) || fs.existsSync(path.join(root, 'review-report.json')))
  throw new Error('需要尚未执行重评的开发库独立副本');
const db = new DatabaseSync(path.join(root, 'pilot.db')); db.exec('PRAGMA foreign_keys=ON');
const queue = new AdaptiveStore(db, 'synthetic-pilot-agent'), archive = new AdaptiveArchive(queue, path.join(root, 'soul'));
const calls: any[] = [], results = [], pending: Promise<void>[] = [];
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 });
try {
  for (let step = 0; step < 5; step++) {
    const result = await reviewNext({ archive, queue, exclusive: async (run) => run(), enabled: () => true, timeoutMs: 150_000,
      generate: async (prompt, signal) => {
        const request = { ...prompt, model, config: { maxOutputTokens: 16384, responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: model === 'gemini-4-argon' ? 'MEDIUM' : model === 'gemini-3.5-flash-lite' ? 'MINIMAL' : 'LOW' } } };
        const n = calls.length + 1; save(`review-request-${n}.json`, request);
        // execFile 没有 input 参数；显式写入 stdin，信号取消可终止子进程。
        let response: any;
        const completion = new Promise<void>((resolve) => {
          const child = execFile('python3', ['-B', fileURLToPath(new URL('./adaptive-vertex-proposal.py', import.meta.url))],
            { signal, timeout: 150_000, maxBuffer: 2 * 1024 * 1024 }, (_error, stdout) => {
              try { response = JSON.parse(stdout); } catch { response = { ok: false, error: 'runner-failed', usage: null }; }
              resolve();
            });
          child.stdin!.on('error', () => {}); child.stdin!.end(JSON.stringify(request));
        });
        pending.push(completion); await completion;
        save(`review-response-${n}.json`, response);
        const call = { model, modelVersion: response.modelVersion, ok: response.ok, latencyMs: response.latencyMs, usage: response.usage, error: response.error };
        calls.push(call); console.log(JSON.stringify(call));
        if (!response.ok) throw new Error('模型重评失败');
        return response.proposal;
      } });
    results.push(result); console.log(JSON.stringify(result));
    publishPending(queue, path.join(root, 'soul'), () => true); // 同原开发工具，仅安装文件，没有真实 Git 发布。
    if (!['revised', 'unchanged'].includes(result.status)) break;
  }
  await Promise.allSettled(pending);
  save('review-report.json', { dataset: 'AM-01-development-v1-repair', model, calls, results });
  save('review-state.json', { records: archive.current(), evidence: [...archive.assess()] });
  if (results.at(-1)?.status !== 'idle') process.exitCode = 1;
} finally { db.close(); }

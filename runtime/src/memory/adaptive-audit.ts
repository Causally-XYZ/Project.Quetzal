import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { graphToken, soulEpoch, trustedIntegrity, type IntegrityState } from './adaptive-integrity.ts';

// 构建时将独立 worker 的正式依赖图嵌入 main.cjs；源码运行直接 import TS，不需附属部署文件。
declare const QUETZAL_ADAPTIVE_AUDIT_CODE: string;
const running = new Set<Promise<void>>();
export async function drainAdaptiveAudits() { await Promise.all([...running]); }
export function auditIntegrity(db: DatabaseSync, state: IntegrityState, force = false): Promise<void> | undefined {
  if (state.task) return state.task;
  const now = Date.now();
  if (!trustedIntegrity(db, state) || !force && (now < state.retryAt || now - state.checkedAt < 60_000)) return;
  const file = String(db.prepare('PRAGMA database_list').all().find((r) => r.name === 'main')?.file ?? '');
  if (!file) return; // 内存单测库无法从另一连接读取；产品始终使用磁盘库。
  const generation = Number(db.prepare('SELECT generation FROM adaptive_graph_meta WHERE singleton=1').get()!.generation);
  const token = graphToken(db), epoch = soulEpoch(state.soul);
  let scratch: string;
  try {
    const root = path.join(path.dirname(file), 'adaptive-audit');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('巡检临时目录不合法');
    // 只清理本组件遗留的超时临时库；正常线程至多30秒，崩溃后无需人工删文件。
    const entries = fs.opendirSync(root);
    try {
      for (let i = 0, entry = entries.readSync(); entry && i < 32; i++, entry = entries.readSync()) {
        if (!/^scan-[a-zA-Z0-9]{6}$/.test(entry.name) || !entry.isDirectory()) continue;
        const old = path.join(root, entry.name);
        if (now - fs.lstatSync(old).mtimeMs > 120_000) fs.rmSync(old, { recursive: true, force: true });
      }
    } finally { entries.closeSync(); }
    scratch = fs.mkdtempSync(path.join(root, 'scan-'));
  }
  catch { state.status = 'failed'; state.retryAt = now + 10_000; return; }
  const code = typeof QUETZAL_ADAPTIVE_AUDIT_CODE === 'string' ? QUETZAL_ADAPTIVE_AUDIT_CODE :
    `import(${JSON.stringify(import.meta.resolve('./adaptive-audit-worker.ts'))})`;
  state.status = 'checking';
  const task = new Promise<void>((resolve) => {
    let result: { status: 'ready' | 'failed' | 'changed'; generation: number; extra?: boolean } = { status: 'failed', generation: -1 };
    let worker: Worker;
    const finish = () => {
      try {
        const current = Number(db.prepare('SELECT generation FROM adaptive_graph_meta WHERE singleton=1').get()?.generation);
        const unchanged = state.token === token && graphToken(db) === token && soulEpoch(state.soul) === epoch && current >= result.generation;
        if (!unchanged || result.status === 'changed') { state.status = 'changed'; state.retryAt = Date.now() + 2000; }
        else if (result.status === 'ready' && !(result.extra && current === result.generation)) { state.status = 'ready'; state.checkedAt = Date.now(); }
        else { state.status = 'failed'; state.token = undefined; }
      } catch { state.status = 'failed'; state.token = undefined; }
      finally {
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* 下次巡检清理超时的本组件临时投影。 */ }
        resolve();
      }
    };
    try {
      worker = new Worker(code, { eval: true, workerData: { file, scratch, soul: state.soul, agent: state.agent, generation, token } });
      worker.on('message', (value) => { if (value && ['ready', 'failed', 'changed'].includes(value.status) && Number.isSafeInteger(value.generation)) result = value; });
      worker.on('error', () => { result = { status: 'failed', generation: -1 }; });
      const timer = setTimeout(() => { result = { status: 'failed', generation: -1 }; void worker.terminate(); }, 30_000); timer.unref();
      worker.once('exit', (code) => { clearTimeout(timer); if (code) result = { status: 'failed', generation: -1 }; finish(); });
    } catch { finish(); }
  });
  state.task = task; running.add(task);
  void task.finally(() => { if (state.task === task) state.task = undefined; running.delete(task); });
  return task;
}

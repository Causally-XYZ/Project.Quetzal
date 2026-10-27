import { Worker } from 'node:worker_threads';
import { semanticDigest, type SemanticCandidate, type SemanticNeighbors } from './adaptive-query.ts';
import { adaptiveVectorWorker } from './adaptive-vector-worker.ts';
import pin from '../../components/adaptive-retrieval/model.json' with { type: 'json' };
import lock from '../../components/adaptive-retrieval/package-lock.json' with { type: 'json' };

export interface AdaptiveRetriever {
  replace(candidates: SemanticCandidate[]): void;
  query(query: string, signal?: AbortSignal): Promise<SemanticNeighbors | undefined>;
}
// 分块、输入前缀、归一化、模型或依赖改变均进入新空间，禁止复用另一模型的缓存。
export const VECTOR_SPACE = semanticDigest({ pin, lock, dtype: 'q8', pooling: 'mean', normalize: true, dimensions: 384,
  input: 'title-newline-text', chunks: { passage: [128, 512, 32], query: [480, 2048, 64], max: 128 }, prefixes: ['query: ', 'passage: '] });

/** 仅集中身体启动。root 为已经核验安装的组件目录；缓存位于 QUETZAL_HOME/data，绝不进灵魂。 */
export class AdaptiveVectorRetriever implements AdaptiveRetriever {
  private readonly worker: Worker;
  private sequence = 0;
  private latest: Pick<SemanticCandidate, 'key' | 'title' | 'text'>[] = [];
  private fingerprint = '';
  private readonly requests = new Map<number, (keys?: string[]) => void>();
  private state: 'loading' | 'ready' | 'failed' | 'closed' = 'loading';
  private exited = false;
  private closing?: Promise<void>;
  private stats = { snapshot: '', indexed: 0, pending: 0, reused: 0, computed: 0, errors: 0 };
  constructor(options: { root: string; cache: string; agent: string }) {
    this.worker = new Worker(`(${adaptiveVectorWorker.toString()})()`, { eval: true, workerData: { ...options, pin, lock, space: VECTOR_SPACE } });
    this.worker.on('message', (message) => {
      if (this.state === 'closed') return;
      if (message.type === 'ready') { this.state = 'ready'; this.worker.postMessage({ type: 'replace', candidates: this.latest }); }
      else if (message.type === 'failed') this.fail();
      else if (message.type === 'status') this.stats = { ...this.stats, snapshot: message.snapshot, indexed: message.indexed, pending: message.pending, reused: message.reused, computed: message.computed };
      else if (message.type === 'index-error') this.stats.errors++;
      else if (message.type === 'answer') this.requests.get(message.id)?.(message.keys);
    });
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => { this.exited = true; if (this.state !== 'closed') this.fail(); });
    this.worker.unref();
  }
  status() { return { state: this.state, current: this.fingerprint === this.stats.snapshot, ...this.stats }; }
  private fail() {
    if (this.state !== 'closed') this.state = 'failed';
    for (const finish of [...this.requests.values()]) finish();
  }
  replace(candidates: SemanticCandidate[]) {
    if (this.state === 'closed' || this.state === 'failed') return;
    const latest = candidates.map(({ key, title, text }) => ({ key, title, text }));
    if (latest.length > 1000 || Buffer.byteLength(JSON.stringify(latest)) > 8 * 1024 * 1024) throw new Error('向量候选超过工作上限');
    const fingerprint = semanticDigest(latest);
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint; this.latest = latest;
    if (this.state === 'ready') this.worker.postMessage({ type: 'replace', candidates: latest });
  }
  query(query: string, signal?: AbortSignal): Promise<SemanticNeighbors | undefined> {
    signal?.throwIfAborted();
    if (this.state !== 'ready' || !query.trim() || query.length > 8000 || this.requests.size >= 16) return Promise.resolve(undefined);
    const id = ++this.sequence;
    return new Promise((resolve) => {
      const finish = (keys?: string[]) => {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.requests.delete(id);
        resolve(keys?.length ? { queryHash: semanticDigest(query), keys } : undefined);
      };
      const cancel = () => { this.worker.postMessage({ type: 'cancel', id }); finish(); };
      const timer = setTimeout(cancel, 100); // 进行中的请求必须保活，不能让仅剩顶层 await 的进程提前退出。
      signal?.addEventListener('abort', cancel, { once: true }); this.requests.set(id, finish);
      this.worker.postMessage({ type: 'query', id, query, deadline: Date.now() + 100 });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = 'closed'; for (const finish of [...this.requests.values()]) finish();
    if (this.exited) return Promise.resolve();
    // terminate() 可能在 ONNX 的原生回调尚未结束时卸载环境，导致整个进程崩溃。
    // 保活并等待 worker 在当前块结束后 dispose；不强杀仍在使用原生资源的线程。
    this.worker.ref();
    return this.closing = new Promise((resolve) => {
      this.worker.once('exit', () => resolve()); this.worker.postMessage({ type: 'stop' });
    });
  }
}

import { Worker } from 'node:worker_threads';
import { semanticDigest, type SemanticCandidate, type SemanticNeighbors } from './adaptive-query.ts';
import { adaptiveVectorWorker } from './adaptive-vector-worker.ts';
import pin from '../../components/adaptive-retrieval/model.json' with { type: 'json' };
import lock from '../../components/adaptive-retrieval/package-lock.json' with { type: 'json' };

export interface VectorCandidate { id: string; key: string; title: string; text: string }
export interface VectorBatch {
  epoch: string; seq: number; begin?: boolean; complete?: boolean;
  upsert: VectorCandidate[]; remove: { id: string; key?: string }[];
}
export interface VectorAck { epoch: string; seq: number; scanComplete: boolean }
export interface AdaptiveRetriever {
  applyBatch(batch: VectorBatch): Promise<VectorAck>;
  query(query: string, signal?: AbortSignal): Promise<SemanticNeighbors | undefined>;
}
// 分块、输入前缀、归一化、模型或依赖改变均进入新空间，禁止复用另一模型的缓存。
export const VECTOR_SPACE = semanticDigest({ pin, lock, dtype: 'q8', pooling: 'mean', normalize: true, dimensions: 384,
  input: 'title-newline-text', chunks: { passage: [128, 512, 32], query: [480, 2048, 64], max: 128 }, prefixes: ['query: ', 'passage: '] });

/** 仅集中身体启动。持久清单与向量位于QUETZAL_HOME，不进入灵魂；生产只提交有界批次。 */
export class AdaptiveVectorRetriever implements AdaptiveRetriever {
  private readonly worker: Worker;
  private sequence = 0;
  private readonly requests = new Map<number, (keys?: string[]) => void>();
  private batch?: { value: VectorBatch; resolve(ack: VectorAck): void; reject(error: Error): void; sent: boolean };
  private state: 'loading' | 'ready' | 'failed' | 'closed' = 'loading';
  private failure: 'component' | 'cache' | 'worker' | null = null;
  private exited = false;
  private closing?: Promise<void>;
  private stats = { snapshot: '', epoch: '', seq: 0, scanComplete: false, indexed: 0, pending: 0,
    reused: 0, computed: 0, errors: 0, retrying: 0, blocked: 0, cacheRecovered: false };
  // 仅旧小型开发夹具使用；生产applyBatch路径不建立全量候选副本。
  private compatibility?: { desired: VectorCandidate[]; sent: VectorCandidate[]; fingerprint: string; accepted: string;
    epoch: string; seq: number; running: boolean };
  constructor(options: { root: string; cache: string; agent: string }) {
    this.worker = new Worker(`(${adaptiveVectorWorker.toString()})()`, { eval: true, workerData: { ...options, pin, lock, space: VECTOR_SPACE } });
    this.worker.on('message', (message) => {
      if (this.state === 'closed') return;
      if (message.type === 'ready') { this.state = 'ready'; this.sendBatch(); void this.flushCompatibility(); }
      else if (message.type === 'failed') this.fail(message.stage === 'component' || message.stage === 'cache' ? message.stage : 'worker');
      else if (message.type === 'status') {
        this.stats = { ...this.stats, snapshot: message.snapshot, epoch: message.epoch, seq: message.seq, scanComplete: message.scanComplete,
          indexed: message.indexed, pending: message.pending, reused: message.reused, computed: message.computed,
          retrying: message.retrying, blocked: message.blocked, cacheRecovered: message.cacheRecovered };
      } else if (message.type === 'ack') {
        const pending = this.batch;
        if (!pending || pending.value.epoch !== message.epoch || pending.value.seq !== message.seq) { this.fail(); return; }
        this.batch = undefined; this.worker.unref();
        pending.resolve({ epoch: message.epoch, seq: message.seq, scanComplete: message.scanComplete });
      } else if (message.type === 'index-error') this.stats.errors++;
      else if (message.type === 'answer') this.requests.get(message.id)?.(message.keys);
    });
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => { this.exited = true; if (this.state !== 'closed') this.fail(); });
    this.worker.unref();
  }
  status() {
    const compatible = !this.compatibility || this.compatibility.fingerprint === this.compatibility.accepted;
    return { state: this.state, failure: this.failure, current: this.state === 'ready' && !this.batch && compatible &&
      this.stats.scanComplete, ...this.stats };
  }
  private fail(reason: 'component' | 'cache' | 'worker' = this.state === 'loading' ? 'component' : 'worker') {
    this.failure ??= reason;
    if (this.state !== 'closed') this.state = 'failed';
    const pending = this.batch; this.batch = undefined; pending?.reject(new Error(`vector_${reason}`));
    for (const finish of [...this.requests.values()]) finish();
  }
  applyBatch(value: VectorBatch): Promise<VectorAck> {
    if (this.state === 'closed' || this.state === 'failed') return Promise.reject(new Error('向量组件不可用'));
    if (this.batch) return Promise.reject(new Error('向量批次尚未确认'));
    if (!value || !Array.isArray(value.upsert) || !Array.isArray(value.remove) || value.upsert.length > 1000 ||
        value.remove.length > 1000 || Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) return Promise.reject(new Error('向量批次超过工作上限'));
    return new Promise((resolve, reject) => {
      this.batch = { value: structuredClone(value), resolve, reject, sent: false };
      this.worker.ref(); this.sendBatch();
    });
  }
  private sendBatch() {
    if (this.state !== 'ready' || !this.batch || this.batch.sent) return;
    this.batch.sent = true;
    try { this.worker.postMessage({ type: 'batch', batch: this.batch.value }); } catch { this.fail(); }
  }
  /** 小型开发兼容入口，最多1000项；完整生产索引须使用applyBatch，不能以此枚举全库。 */
  replace(candidates: (Pick<SemanticCandidate, 'key' | 'title' | 'text'> & { item?: { id: string } })[]) {
    if (this.state === 'closed' || this.state === 'failed') return;
    const latest = candidates.map(({ key, item, title, text }) => ({ id: item?.id ?? key, key, title, text }));
    if (latest.length > 1000 || Buffer.byteLength(JSON.stringify(latest)) > 8 * 1024 * 1024) throw new Error('向量候选超过工作上限');
    const previous = new Map(this.compatibility?.desired.map((c) => [c.key, c]));
    if (new Set(latest.map((c) => c.id)).size !== latest.length || new Set(latest.map((c) => c.key)).size !== latest.length || latest.some((c) => {
      const old = previous.get(c.key); return !/^[a-f0-9]{64}$/.test(c.key) || old && (old.title !== c.title || old.text !== c.text);
    })) throw new Error('向量候选摘要不一致');
    const fingerprint = semanticDigest(latest);
    if (!this.compatibility) this.compatibility = { desired: [], sent: [], fingerprint: '', accepted: '',
      epoch: `development-${Date.now()}-${Math.random()}`, seq: 0, running: false };
    this.compatibility.desired = latest; this.compatibility.fingerprint = fingerprint;
    void this.flushCompatibility();
  }
  private async flushCompatibility() {
    const c = this.compatibility;
    if (!c || c.running || this.state !== 'ready' || c.fingerprint === c.accepted) return;
    c.running = true;
    try {
      while (this.state === 'ready' && c.fingerprint !== c.accepted) {
        const latest = c.desired, fingerprint = c.fingerprint, previous = new Map(c.sent.map((v) => [v.id, v]));
        const next = new Map(latest.map((v) => [v.id, v]));
        const initial = c.seq === 0;
        await this.applyBatch({ epoch: c.epoch, seq: c.seq + 1, ...(initial ? { begin: true, complete: true } : {}),
          upsert: latest.filter((v) => previous.get(v.id)?.key !== v.key),
          remove: c.sent.filter((v) => !next.has(v.id)).map((v) => ({ id: v.id, key: v.key })) });
        c.seq++; c.sent = latest; c.accepted = fingerprint;
      }
    } catch { if (this.status().state !== 'closed') this.fail(); }
    finally { c.running = false; }
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
      const timer = setTimeout(cancel, 100);
      signal?.addEventListener('abort', cancel); this.requests.set(id, finish);
      this.worker.postMessage({ type: 'query', id, query, deadline: Date.now() + 100 });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = 'closed';
    const pending = this.batch; this.batch = undefined; pending?.reject(new Error('向量组件已关闭'));
    for (const finish of [...this.requests.values()]) finish();
    if (this.exited) return Promise.resolve();
    // 不强杀仍在原生计算的线程；等当前块及在途批次让出后正常dispose。
    this.worker.ref();
    return this.closing = new Promise((resolve) => {
      this.worker.once('exit', () => resolve()); this.worker.postMessage({ type: 'stop' });
    });
  }
}

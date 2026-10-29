// 权威存档入口：启动 / 受控同步后全检，热读取逐项核对，自动后台巡检全链。
// 宿主须在已有灵魂 exclusive 内调用，避免与本机 Git 合并 / 发布交错。
import { AdaptiveStore, type MemoryJob } from './adaptive-store.ts';
import { AdaptiveGraph, type RetrievalCandidates } from './adaptive-graph.ts';
import { ARTIFACT_ID, type ArtifactInput } from './adaptive-artifact.ts';
import { type SemanticBatch, type SemanticRecord, type SourceReader } from './adaptive-evidence.ts';
import type { AdaptiveLookup } from './adaptive-lookup.ts';
import type { SemanticNeighbors } from './adaptive-query.ts';
import { archiveArtifacts, recordAuthority } from './adaptive-authority.ts';
import { integrityState, trustedIntegrity, trustIntegrity, soulEpoch } from './adaptive-integrity.ts';
import { auditIntegrity } from './adaptive-audit.ts';

export interface ArchiveCheckpoint { generation: number; artifact: string; digest: string }
export class AdaptiveArchive {
  private readonly graph: AdaptiveGraph;
  private readonly queue: AdaptiveStore;
  private readonly soul: string;
  private readonly minimum?: ArchiveCheckpoint;
  private check?: (record: SemanticRecord) => void;
  constructor(queue: AdaptiveStore, soul: string, minimum?: ArchiveCheckpoint) {
    this.queue = queue; this.soul = soul; this.minimum = minimum;
    this.graph = new AdaptiveGraph(queue, (record) => this.check?.(record));
    if (minimum && (!Number.isSafeInteger(minimum.generation) || minimum.generation < 1 || !ARTIFACT_ID.test(minimum.artifact) || !/^[a-f0-9]{64}$/.test(minimum.digest)))
      throw new Error('认识恢复检查点不合法');
  }

  /** 返回值可纳入完整备份清单；单凭一个没有尾部见证的文件子集无法检测尾部丢失。 */
  checkpoint(): ArchiveCheckpoint | null {
    this.refresh();
    const row = this.queue.db.prepare('SELECT generation,artifact,digest FROM adaptive_graph_batches ORDER BY generation DESC LIMIT 1').get();
    return row ? { generation: Number(row.generation), artifact: String(row.artifact), digest: String(row.digest) } : null;
  }

  refresh(): void {
    const soul = this.soul, queue = this.queue;
    const state = integrityState(queue.db, soul, queue.agent); state.token = undefined;
    try {
      new AdaptiveGraph(queue).rebuild(archiveArtifacts(queue.db, soul, queue.agent), this.minimum);
      trustIntegrity(queue.db, state);
    } catch (error) {
      state.status = 'failed'; state.epoch = soulEpoch(soul); state.retryAt = Date.now() + 10_000;
      throw error;
    }
  }

  private ensure() {
    const state = integrityState(this.queue.db, this.soul, this.queue.agent);
    if (!trustedIntegrity(this.queue.db, state)) this.refresh();
    if (this.minimum) {
      const row = this.queue.db.prepare('SELECT generation,digest FROM adaptive_graph_batches WHERE artifact=?').get(this.minimum.artifact);
      if (!row || row.generation !== this.minimum.generation || row.digest !== this.minimum.digest) throw new Error('认识存档未达到备份检查点');
    }
  }
  private read<T>(run: () => T): T {
    this.ensure();
    const previous = this.check;
    this.check = recordAuthority(this.queue.db, this.soul, this.queue.agent);
    try { return run(); } finally { this.check = previous; }
  }
  /** 在灵魂写锁内启动；返回后释放锁，巡检线程不写实时数据库。 */
  audit(force = false) {
    const state = integrityState(this.queue.db, this.soul, this.queue.agent);
    // 缺失权威不能让500ms宿主tick反复全检；明确读取仍可在文件恢复后立即重新核对。
    if (!force && state.status === 'failed' && state.epoch === soulEpoch(this.soul) && Date.now() < state.retryAt) return;
    this.ensure();
    return auditIntegrity(this.queue.db, integrityState(this.queue.db, this.soul, this.queue.agent), force);
  }
  integrity() {
    const state = integrityState(this.queue.db, this.soul, this.queue.agent);
    return { state: state.status, checkedAt: state.checkedAt || null };
  }

  generation(): number { this.ensure(); return this.graph.generation(); }
  current() { this.refresh(); return this.graph.current(); }
  readLocal<T>(read: (lookup: Pick<AdaptiveLookup, 'get' | 'page' | 'search' | 'recent' | 'sourceOwners' | 'references' | 'dependents' | 'matches' | 'neighbors' | 'objects' | 'reviewTargets'>, generation: number) => T): T {
    return this.read(() => this.graph.readLocal(read));
  }
  history(id: string) { return this.read(() => this.graph.history(id)); }
  assess(read?: SourceReader) { this.refresh(); return this.graph.assess(read); }
  supportedClaims(read?: SourceReader) { this.refresh(); return this.graph.supportedClaims(read); }
  retrievalState() { return this.read(() => this.graph.retrievalState()); }
  candidatePage(after = '', limit = 32, read?: SourceReader) { return this.read(() => this.graph.candidatePage(after, limit, read)); }
  candidateBatch(read?: SourceReader, restart = false, check?: () => void, limit = 16) { return this.read(() => this.graph.candidateBatch(read, restart, check, limit)); }
  acknowledgeCandidates(batch: RetrievalCandidates) { return this.read(() => this.graph.acknowledgeCandidates(batch)); }
  query(query: string, read?: SourceReader, neighbors?: SemanticNeighbors) { return this.read(() => this.graph.query(query, read, neighbors)); }
  readSources(ids: number[], read?: SourceReader) { return this.read(() => this.graph.readSources(ids, read)); }
  accept(job: MemoryJob, inputs: ArtifactInput[], batch: SemanticBatch, now = Date.now()): boolean {
    return this.read(() => this.graph.accept(job, inputs, batch, now));
  }
  complete(job: MemoryJob, inputs: ArtifactInput[], generation: number, now = Date.now()): boolean {
    return this.read(() => this.graph.complete(job, inputs, generation, now));
  }
}

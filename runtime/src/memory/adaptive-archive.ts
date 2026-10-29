// 权威存档入口：每次读取先核对文件和待交付发件箱，失败不退回 SQLite 旧投影。
// 宿主须在已有灵魂 exclusive 内调用，避免与本机 Git 合并 / 发布交错。
import fs from 'node:fs';
import path from 'node:path';
import { AdaptiveStore, type MemoryJob } from './adaptive-store.ts';
import { AdaptiveGraph } from './adaptive-graph.ts';
import { ARTIFACT_ID, artifactDigest, parseArtifact, type ArtifactInput, type MemoryArtifact } from './adaptive-artifact.ts';
import { publicationRoot, readPublication } from './adaptive-publication.ts';
import { semanticSchema, type SemanticBatch, type SourceReader } from './adaptive-evidence.ts';
import type { AdaptiveLookup } from './adaptive-lookup.ts';
import type { SemanticNeighbors } from './adaptive-query.ts';

export interface ArchiveCheckpoint { generation: number; artifact: string; digest: string }
export class AdaptiveArchive {
  private readonly graph: AdaptiveGraph;
  private readonly queue: AdaptiveStore;
  private readonly soul: string;
  private readonly minimum?: ArchiveCheckpoint;
  constructor(queue: AdaptiveStore, soul: string, minimum?: ArchiveCheckpoint) {
    this.queue = queue; this.soul = soul; this.minimum = minimum;
    this.graph = new AdaptiveGraph(queue);
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
    // 枚举与核验仍覆盖完整权威链，但不保留全体结果正文或全图的 JS Map。
    function* artifacts(): Generator<MemoryArtifact> {
      let exists = true;
      for (const dir of [soul, path.join(soul, 'notes'), path.join(soul, 'notes', 'QuetzalMemory'), publicationRoot(soul)]) {
        try { const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('认识存档目录不合法'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; break; }
      }
      if (exists) {
        let count = 0; const dir = fs.opendirSync(publicationRoot(soul));
        try {
          for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
            if (++count > 10000) throw new Error('认识存档枚举超过工作上限');
            if (entry.name.endsWith('.tmp')) continue;
            if (!entry.name.endsWith('.md')) throw new Error('认识存档包含未知文件');
            const id = entry.name.slice(0, -3);
            if (!ARTIFACT_ID.test(id)) throw new Error('认识存档包含未知文件');
            const artifact = readPublication(soul, id, queue.agent);
            if (semanticSchema(artifact.payload.schema)) yield artifact;
          }
        } finally { dir.closeSync(); }
      }
      let count = 0;
      for (const row of queue.db.prepare('SELECT id,document,digest,state,published,error FROM adaptive_publications').iterate()) {
        if (++count > 10000) throw new Error('认识发件箱核对超过工作上限');
        if (typeof row.document !== 'string' || typeof row.id !== 'string') throw new Error('认识发件箱格式不合法');
        const artifact = parseArtifact(row.document, queue.agent);
        if (!semanticSchema(artifact.payload.schema)) continue;
        if (artifact.id !== row.id || artifactDigest(row.document) !== row.digest) throw new Error('认识发件箱完整性不符');
        if (exists && fs.existsSync(path.join(publicationRoot(soul), `${row.id}.md`))) {
          if (artifactDigest(JSON.stringify(readPublication(soul, row.id, queue.agent))) !== row.digest)
            throw new Error('认识文件与已接受结果不同');
        } else {
          if (row.published !== null || row.state === 'published' || row.state === 'written' || row.error === 'conflict') throw new Error('已交付认识文件缺失');
          yield artifact;
        }
      }
    }
    this.graph.rebuild(artifacts(), this.minimum);
  }

  generation(): number { this.refresh(); return this.graph.generation(); }
  current() { this.refresh(); return this.graph.current(); }
  readLocal<T>(read: (lookup: Pick<AdaptiveLookup, 'get' | 'page' | 'search' | 'recent' | 'sourceOwners' | 'references' | 'dependents' | 'matches' | 'neighbors' | 'objects' | 'reviewTargets'>, generation: number) => T): T {
    this.refresh(); return this.graph.readLocal(read);
  }
  history(id: string) { this.refresh(); return this.graph.history(id); }
  assess(read?: SourceReader) { this.refresh(); return this.graph.assess(read); }
  supportedClaims(read?: SourceReader) { this.refresh(); return this.graph.supportedClaims(read); }
  candidates(read?: SourceReader) { this.refresh(); return this.graph.candidates(read); }
  query(query: string, read?: SourceReader, neighbors?: SemanticNeighbors) { this.refresh(); return this.graph.query(query, read, neighbors); }
  readSources(ids: number[], read?: SourceReader) { this.refresh(); return this.graph.readSources(ids, read); }
  accept(job: MemoryJob, inputs: ArtifactInput[], batch: SemanticBatch, now = Date.now()): boolean {
    this.refresh(); return this.graph.accept(job, inputs, batch, now);
  }
  complete(job: MemoryJob, inputs: ArtifactInput[], generation: number, now = Date.now()): boolean {
    this.refresh(); return this.graph.complete(job, inputs, generation, now);
  }
}

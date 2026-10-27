// 权威存档入口：每次读取先核对文件和待交付发件箱，失败不退回 SQLite 旧投影。
// 宿主须在已有灵魂 exclusive 内调用，避免与本机 Git 合并 / 发布交错。
import fs from 'node:fs';
import path from 'node:path';
import { AdaptiveStore, type MemoryJob } from './adaptive-store.ts';
import { AdaptiveGraph } from './adaptive-graph.ts';
import { ARTIFACT_ID, artifactDigest, parseArtifact, type ArtifactInput, type MemoryArtifact } from './adaptive-artifact.ts';
import { publicationRoot, readPublication } from './adaptive-publication.ts';
import { SEMANTIC_SCHEMA, type SemanticBatch, type SourceReader } from './adaptive-evidence.ts';

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
    const artifacts = new Map<string, MemoryArtifact>();
    let bytes = 0;
    const put = (artifact: MemoryArtifact) => {
      if (artifacts.has(artifact.id)) return;
      bytes += Buffer.byteLength(JSON.stringify(artifact));
      if (bytes > 64 * 1024 * 1024 || artifacts.size >= 10000) throw new Error('认识存档超过工作上限');
      artifacts.set(artifact.id, artifact);
    };
    let exists = true;
    for (const dir of [this.soul, path.join(this.soul, 'notes'), path.join(this.soul, 'notes', 'QuetzalMemory'), publicationRoot(this.soul)]) {
      try {
        const st = fs.lstatSync(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('认识存档目录不合法');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        exists = false; break;
      }
    }
    if (exists) {
      let count = 0;
      // opendir 逐项枚举，避免一次读入任意大的目录；临时文件不属于权威结果。
      const dir = fs.opendirSync(publicationRoot(this.soul));
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (++count > 10000) throw new Error('认识存档枚举超过工作上限');
          if (entry.name.endsWith('.tmp')) continue;
          const id = entry.name.endsWith('.md') ? entry.name.slice(0, -3) : '';
          if (!ARTIFACT_ID.test(id)) throw new Error('认识存档包含未知文件');
          const artifact = readPublication(this.soul, id, this.queue.agent);
          if (artifact.payload.schema === SEMANTIC_SCHEMA) put(artifact);
        }
      } finally { dir.closeSync(); }
    }
    const local = this.queue.db.prepare('SELECT id,document,digest,state,published,error FROM adaptive_publications').iterate();
    let localCount = 0;
    for (const row of local) {
      if (++localCount > 10000) throw new Error('认识发件箱核对超过工作上限');
      if (typeof row.document !== 'string' || typeof row.id !== 'string') throw new Error('认识发件箱格式不合法');
      const artifact = parseArtifact(row.document, this.queue.agent);
      if (artifact.payload.schema !== SEMANTIC_SCHEMA) continue;
      if (artifact.id !== row.id || artifactDigest(row.document) !== row.digest) throw new Error('认识发件箱完整性不符');
      const file = artifacts.get(row.id);
      if (file && artifactDigest(JSON.stringify(file)) !== row.digest) throw new Error('认识文件与已接受结果不同');
      if (!file) {
        if (row.published !== null || row.state === 'published' || row.state === 'written' || row.error === 'conflict') throw new Error('已交付认识文件缺失');
        // 尚未安装的结果仍由发件箱恢复。冲突失败不能借发件箱绕过现场文件。
        if (exists && fs.existsSync(path.join(publicationRoot(this.soul), `${row.id}.md`))) throw new Error('认识文件类型与已接受结果不同');
        put(artifact);
      }
    }
    if (this.minimum) {
      const head = artifacts.get(this.minimum.artifact);
      if (!head || artifactDigest(JSON.stringify(head)) !== this.minimum.digest ||
          (head.payload.data as SemanticBatch).baseGeneration + 1 !== this.minimum.generation) throw new Error('认识存档未达到备份检查点');
    }
    this.graph.rebuild([...artifacts.values()]);
  }

  generation(): number { this.refresh(); return this.graph.generation(); }
  current() { this.refresh(); return this.graph.current(); }
  history(id: string) { this.refresh(); return this.graph.history(id); }
  assess(read?: SourceReader) { this.refresh(); return this.graph.assess(read); }
  supportedClaims(read?: SourceReader) { this.refresh(); return this.graph.supportedClaims(read); }
  accept(job: MemoryJob, inputs: ArtifactInput[], batch: SemanticBatch, now = Date.now()): boolean {
    this.refresh(); return this.graph.accept(job, inputs, batch, now);
  }
  complete(job: MemoryJob, inputs: ArtifactInput[], generation: number, now = Date.now()): boolean {
    this.refresh(); return this.graph.complete(job, inputs, generation, now);
  }
}

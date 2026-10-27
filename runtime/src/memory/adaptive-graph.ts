// M2 语义投影：有版本记录与 M1 发件箱同事务接受；查询不相信持久化的 active 标记。
// 长期格式由 semantic-v1 payload 定义；本表是可重建的投影，不替代灵魂文件。
import { AdaptiveStore, type MemoryJob } from './adaptive-store.ts';
import { artifactDigest, type ArtifactInput, type MemoryArtifact } from './adaptive-artifact.ts';
import { SEMANTIC_SCHEMA, validateBatch, validateRecord, directSpans, recordRefs, spanCurrent, sameRealm,
  evaluateEvidence, type SemanticBatch, type SemanticRecord, type SourceReader, type ClaimRecord } from './adaptive-evidence.ts';

export class AdaptiveGraph {
  readonly queue: AdaptiveStore;
  constructor(queue: AdaptiveStore) {
    this.queue = queue;
    const db = queue.db;
    db.exec('SAVEPOINT adaptive_graph_schema');
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adaptive_graph_meta'").get()) {
        db.exec(`CREATE TABLE adaptive_graph_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,generation INTEGER NOT NULL);
          INSERT INTO adaptive_graph_meta VALUES(1,1,0)`);
      }
      const meta = db.prepare('SELECT version,generation FROM adaptive_graph_meta WHERE singleton=1').get();
      if (meta?.version !== 1 || !Number.isSafeInteger(meta.generation) || Number(meta.generation) < 0)
        throw new Error('认识投影版本或代次不支持');
      db.exec(`
        CREATE TABLE IF NOT EXISTS adaptive_graph_batches(artifact TEXT PRIMARY KEY,generation INTEGER NOT NULL UNIQUE,digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS adaptive_graph_records(id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL,artifact TEXT NOT NULL,
          PRIMARY KEY(id,revision),FOREIGN KEY(artifact) REFERENCES adaptive_publications(id));
        CREATE INDEX IF NOT EXISTS adaptive_graph_artifact ON adaptive_graph_records(artifact);
      `);
      db.exec('RELEASE adaptive_graph_schema');
    } catch (error) {
      db.exec('ROLLBACK TO adaptive_graph_schema'); db.exec('RELEASE adaptive_graph_schema'); throw error;
    }
  }

  generation(): number {
    return Number(this.queue.db.prepare('SELECT generation FROM adaptive_graph_meta WHERE singleton=1').get()!.generation);
  }

  current(): SemanticRecord[] {
    const rows = this.queue.db.prepare(`SELECT r.document FROM adaptive_graph_records r JOIN
      (SELECT id,MAX(revision) revision FROM adaptive_graph_records GROUP BY id) c ON r.id=c.id AND r.revision=c.revision ORDER BY r.id`)
      .all() as { document: string }[];
    return rows.map((row) => { const record: unknown = JSON.parse(row.document); validateRecord(record); return record; });
  }

  history(id: string): SemanticRecord[] {
    return (this.queue.db.prepare('SELECT document FROM adaptive_graph_records WHERE id=? ORDER BY revision').all(id) as { document: string }[])
      .map((r) => { const value: unknown = JSON.parse(r.document); validateRecord(value); return value; });
  }

  /** 宿主先把 LLM 提案规范化成带宿主 ID 的批次；不能把模型输出直接当批次使用。 */
  accept(job: MemoryJob, inputs: ArtifactInput[], batch: SemanticBatch, now = Date.now()): boolean {
    validateBatch(batch);
    return this.queue.acceptResult(job, inputs, { schema: SEMANTIC_SCHEMA, data: batch }, now, (artifact) => this.install(artifact));
  }

  private install(artifact: MemoryArtifact): boolean {
    const batch = artifact.payload.data; validateBatch(batch);
    if (artifact.payload.schema !== SEMANTIC_SCHEMA || artifact.agent !== this.queue.agent || batch.baseGeneration !== this.generation()) return false;
    const previous = new Map(this.current().map((r) => [r.id, r]));
    const next = new Map(previous);
    for (const r of batch.records) {
      const old = previous.get(r.id);
      if (r.revision !== (old?.revision ?? 0) + 1 || old && old.kind !== r.kind) return false;
      next.set(r.id, r);
    }
    const inputHashes = new Map(artifact.inputs.map((i) => [i.id, i.hash]));
    const source: SourceReader = (id) => this.queue.source(id);
    for (const r of batch.records) {
      for (const span of directSpans(r)) {
        if (inputHashes.get(span.source) !== span.hash || !spanCurrent(span, source)) return false;
      }
      for (const ref of recordRefs(r)) {
        const target = next.get(ref.id);
        if (!target || target.kind !== ref.kind) return false;
        if (r.state === 'withdrawn') {
          // 撤回记录可以保留旧依据供回查，但不能捏造不存在的版本。
          if (target.revision !== ref.revision && !this.queue.db.prepare('SELECT 1 FROM adaptive_graph_records WHERE id=? AND revision=? AND kind=?').get(ref.id, ref.revision, ref.kind)) return false;
        } else if (target.revision !== ref.revision || target.state !== 'present' || !sameRealm(r.realm, target.realm)) return false;
      }
    }
    // 所有被读取的递归来源必须被信封锁定；关联到旧记录不能绕开输入 hash 门禁。
    const visited = new Set<string>();
    const checkInputs = (r: SemanticRecord): boolean => {
      if (visited.has(r.id)) return true;
      visited.add(r.id);
      if (directSpans(r).some((s) => inputHashes.get(s.source) !== s.hash || !spanCurrent(s, source))) return false;
      return recordRefs(r).every((ref) => {
        const target = next.get(ref.id);
        // 撤回本身不依赖旧证明继续成立。
        return r.state === 'withdrawn' || !!target && checkInputs(target);
      });
    };
    if (!batch.records.every(checkInputs)) return false;
    const insert = this.queue.db.prepare('INSERT INTO adaptive_graph_records VALUES(?,?,?,?,?)');
    for (const r of batch.records) insert.run(r.id, r.revision, r.kind, JSON.stringify(r), artifact.id);
    this.queue.db.prepare('INSERT INTO adaptive_graph_batches VALUES(?,?,?)').run(artifact.id, batch.baseGeneration + 1, artifactDigest(JSON.stringify(artifact)));
    this.queue.db.prepare('UPDATE adaptive_graph_meta SET generation=generation+1 WHERE singleton=1').run();
    return true;
  }

  assess(read: SourceReader = (id) => this.queue.source(id)) {
    return this.snapshot(() => evaluateEvidence(this.current(), read));
  }

  private snapshot<T>(read: () => T): T {
    this.queue.db.exec('SAVEPOINT adaptive_graph_read');
    try { const value = read(); this.queue.db.exec('RELEASE adaptive_graph_read'); return value; }
    catch (error) { this.queue.db.exec('ROLLBACK TO adaptive_graph_read'); this.queue.db.exec('RELEASE adaptive_graph_read'); throw error; }
  }

  /** 返回有当前依据的认识；性质原样保留，不能据 supported 升成旧个人记忆的 active / verified。 */
  supportedClaims(read: SourceReader = (id) => this.queue.source(id)) {
    return this.snapshot(() => {
    const records = this.current(), states = evaluateEvidence(records, read);
    const global = evaluateEvidence(records, (id) => this.queue.source(id));
    return records.filter((r): r is ClaimRecord => r.kind === 'claim' && states.get(r.id)?.status === 'supported' && global.get(r.id)?.status === 'supported')
      .map((record) => ({ record: { id: record.id, revision: record.revision, realm: record.realm,
        text: record.text, nature: record.nature, occurred: record.occurred, valid: record.valid,
        participants: record.participants,
        supports: record.supports.filter((g) => states.get(record.id)!.groups.includes(g.id)) },
        evidence: states.get(record.id)! })); // 不返回已失效 / 无权来源的其他依据组、反证或审计正文
    });
  }
}

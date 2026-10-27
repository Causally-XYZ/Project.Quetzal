// M2 语义投影：有版本记录与 M1 发件箱同事务接受；查询不相信持久化的 active 标记。
// 长期格式由 semantic-v2 payload 定义，兼容 v1；本表是可重建的投影，不替代灵魂文件。
import { AdaptiveStore, type MemoryJob } from './adaptive-store.ts';
import { artifactDigest, artifactDocument, type ArtifactInput, type MemoryArtifact } from './adaptive-artifact.ts';
import { SEMANTIC_SCHEMA, LEGACY_SEMANTIC_SCHEMA, semanticSchema, realmBoundRefs, validateBatch, validateRecord, directSpans, recordRefs, spanCurrent, sameRealm,
  evaluateEvidence, type SemanticBatch, type SemanticRecord, type SourceReader, type ClaimRecord } from './adaptive-evidence.ts';
import { sourceReading } from './adaptive-reading.ts';
import { selectSemantic, semanticBasis, semanticCandidates, type SemanticNeighbors } from './adaptive-query.ts';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// 只缓存一次完整重放的见证，不缓存来源可见性或依据状态。连接释放后自动回收。
const verified = new WeakMap<DatabaseSync, { agent: string; artifacts: string; projection: string }>();

export class AdaptiveGraph {
  readonly queue: AdaptiveStore;
  constructor(queue: AdaptiveStore) {
    this.queue = queue;
    const db = queue.db;
    db.exec('SAVEPOINT adaptive_graph_schema');
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adaptive_graph_meta'").get()) {
        db.exec(`CREATE TABLE adaptive_graph_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,generation INTEGER NOT NULL);
          INSERT INTO adaptive_graph_meta VALUES(1,2,0)`);
      }
      const meta = db.prepare('SELECT version,generation FROM adaptive_graph_meta WHERE singleton=1').get();
      if (![1, 2].includes(Number(meta?.version)) || !meta || !Number.isSafeInteger(meta.generation) || Number(meta.generation) < 0)
        throw new Error('认识投影版本或代次不支持');
      db.exec(`
        CREATE TABLE IF NOT EXISTS adaptive_graph_batches(artifact TEXT PRIMARY KEY,generation INTEGER NOT NULL UNIQUE,digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS adaptive_graph_records(id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL,artifact TEXT NOT NULL,
          PRIMARY KEY(id,revision),FOREIGN KEY(artifact) REFERENCES adaptive_graph_batches(artifact));
        CREATE INDEX IF NOT EXISTS adaptive_graph_artifact ON adaptive_graph_records(artifact);
      `);
      if (meta.version === 1) {
        db.exec(`CREATE TABLE adaptive_graph_records_v2(id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL,artifact TEXT NOT NULL,
          PRIMARY KEY(id,revision),FOREIGN KEY(artifact) REFERENCES adaptive_graph_batches(artifact));
          INSERT INTO adaptive_graph_records_v2 SELECT * FROM adaptive_graph_records;
          DROP TABLE adaptive_graph_records;
          ALTER TABLE adaptive_graph_records_v2 RENAME TO adaptive_graph_records;
          CREATE INDEX adaptive_graph_artifact ON adaptive_graph_records(artifact);
          UPDATE adaptive_graph_meta SET version=2 WHERE singleton=1`);
      }
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

  readSources(ids: number[], read: SourceReader = (id) => this.queue.source(id)) {
    return this.snapshot(() => {
      const history: SemanticRecord[] = [];
      for (const row of this.queue.db.prepare('SELECT document FROM adaptive_graph_records ORDER BY id,revision').iterate()) {
        if (history.length >= 10000) throw new Error('认识历史读取超过工作上限');
        const r: unknown = JSON.parse(String(row.document)); validateRecord(r); history.push(r);
      }
      return sourceReading(history, ids, this.generation(), read, (id) => this.queue.source(id));
    });
  }

  /** 宿主先把 LLM 提案规范化成带宿主 ID 的批次；不能把模型输出直接当批次使用。 */
  accept(job: MemoryJob, inputs: ArtifactInput[], batch: SemanticBatch, now = Date.now()): boolean {
    validateBatch(batch);
    return this.queue.acceptResult(job, inputs, { schema: SEMANTIC_SCHEMA, data: batch }, now, (artifact) => this.install(artifact));
  }

  /** 模型判断无需修改也必须锁定读取快照，不能把过期的“无需处理”记为完成。 */
  complete(job: MemoryJob, inputs: ArtifactInput[], generation: number, now = Date.now()): boolean {
    return this.queue.complete(job, now, () => generation === this.generation() &&
      inputs.some((i) => i.id === job.source && i.revision === job.revision) &&
      inputs.every((i) => this.queue.source(i.id, i.revision)?.hash === i.hash));
  }

  private install(artifact: MemoryArtifact, replay = false, replayState?: Map<string, SemanticRecord>): boolean {
    const batch = artifact.payload.data; validateBatch(batch);
    if (artifact.payload.schema === LEGACY_SEMANTIC_SCHEMA && batch.records.some((r) => Object.hasOwn(r, 'references'))) return false;
    if (!semanticSchema(artifact.payload.schema) || artifact.agent !== this.queue.agent || batch.baseGeneration !== this.generation()) return false;
    const previous = replayState ?? new Map(this.current().map((r) => [r.id, r]));
    const patch = new Map<string, SemanticRecord>();
    const next = (id: string) => patch.get(id) ?? previous.get(id);
    for (const r of batch.records) {
      const old = previous.get(r.id);
      if (r.revision !== (old?.revision ?? 0) + 1 || old && (old.kind !== r.kind || r.kind === 'node' && !sameRealm(old.realm, r.realm))) return false;
      patch.set(r.id, r);
    }
    const inputHashes = new Map(artifact.inputs.map((i) => [i.id, i.hash]));
    const source: SourceReader = (id) => this.queue.source(id);
    for (const r of batch.records) {
      for (const span of directSpans(r)) {
        if (inputHashes.get(span.source) !== span.hash || (!replay && !spanCurrent(span, source))) return false;
      }
      for (const { ref, crossRealm } of [...realmBoundRefs(r).map((ref) => ({ ref, crossRealm: false })),
        ...(r.kind === 'claim' ? (r.references ?? []).map((p) => ({ ref: p.mention, crossRealm: true })) : [])]) {
        const target = next(ref.id);
        if (!target || target.kind !== ref.kind) return false;
        if (r.state === 'withdrawn') {
          // 撤回记录可以保留旧依据供回查，但不能捏造不存在的版本。
          if (target.revision !== ref.revision && !this.queue.db.prepare('SELECT 1 FROM adaptive_graph_records WHERE id=? AND revision=? AND kind=?').get(ref.id, ref.revision, ref.kind)) return false;
        } else if (target.revision !== ref.revision || target.state !== 'present' || !crossRealm && !sameRealm(r.realm, target.realm)) return false;
      }
    }
    // 所有被读取的递归来源必须被信封锁定；关联到旧记录不能绕开输入 hash 门禁。
    const visited = new Set<string>();
    const checkInputs = (r: SemanticRecord): boolean => {
      if (visited.has(r.id)) return true;
      visited.add(r.id);
      if (directSpans(r).some((s) => inputHashes.get(s.source) !== s.hash || (!replay && !spanCurrent(s, source)))) return false;
      return recordRefs(r).every((ref) => {
        const target = next(ref.id);
        // 撤回本身不依赖旧证明继续成立。
        return r.state === 'withdrawn' || !!target && checkInputs(target);
      });
    };
    if (!batch.records.every(checkInputs)) return false;
    this.queue.db.prepare('INSERT INTO adaptive_graph_batches VALUES(?,?,?)').run(artifact.id, batch.baseGeneration + 1, artifactDigest(JSON.stringify(artifact)));
    const insert = this.queue.db.prepare('INSERT INTO adaptive_graph_records VALUES(?,?,?,?,?)');
    for (const r of batch.records) insert.run(r.id, r.revision, r.kind, JSON.stringify(r), artifact.id);
    this.queue.db.prepare('UPDATE adaptive_graph_meta SET generation=generation+1 WHERE singleton=1').run();
    if (replayState) for (const r of batch.records) replayState.set(r.id, r);
    return true;
  }

  /** 对实际投影逐行核对，不能只信 generation / 文件 mtime / SQLite data_version。 */
  private projectionDigest(): string | undefined {
    const hash = crypto.createHash('sha256'); let rows = 0, bytes = 0;
    for (const sql of ['SELECT singleton,version,generation FROM adaptive_graph_meta ORDER BY singleton',
      'SELECT artifact,generation,digest FROM adaptive_graph_batches ORDER BY generation',
      'SELECT id,revision,kind,document,artifact FROM adaptive_graph_records ORDER BY id,revision']) {
      hash.update(sql);
      for (const row of this.queue.db.prepare(sql).iterate()) {
        const text = JSON.stringify(row); bytes += Buffer.byteLength(text);
        // 超出权威结果可能具有的投影规模则不走快路径，由完整重放修复。
        if (++rows > 1_010_001 || bytes > 128 * 1024 * 1024) return undefined;
        hash.update(text); hash.update('\n');
      }
    }
    return hash.digest('hex');
  }

  /** 从完整权威结果链重建；来源可能已改动 / 尚未复制，由读取时的 hash 门禁决定可用性。
   * 已见结果的缺失或修改不得静默回退到旧认识。调用者失败时必须停止使用旧投影。
   */
  rebuild(artifacts: MemoryArtifact[]): void {
    const candidates = new Map<string, MemoryArtifact>();
    let bytes = 0;
    if (artifacts.length > 10000) throw new Error('认识重建超过工作上限');
    for (const artifact of artifacts) {
      const document = artifactDocument(artifact);
      bytes += Buffer.byteLength(document);
      if (bytes > 64 * 1024 * 1024) throw new Error('认识重建超过工作上限');
      if (artifact.agent !== this.queue.agent || !semanticSchema(artifact.payload.schema) || candidates.has(artifact.id))
        throw new Error('认识重建结果身份或格式不合法');
      validateBatch(artifact.payload.data);
      candidates.set(artifact.id, artifact);
    }
    const ordered = [...candidates.values()].sort((a, b) =>
      (a.payload.data as SemanticBatch).baseGeneration - (b.payload.data as SemanticBatch).baseGeneration);
    const digest = crypto.createHash('sha256');
    for (const artifact of ordered) digest.update(artifactDigest(JSON.stringify(artifact)));
    const artifactsDigest = digest.digest('hex');
    this.queue.db.exec('SAVEPOINT adaptive_graph_rebuild');
    try {
      const cached = verified.get(this.queue.db);
      if (cached?.agent === this.queue.agent && cached.artifacts === artifactsDigest && cached.projection === this.projectionDigest()) {
        this.queue.db.exec('RELEASE adaptive_graph_rebuild'); return;
      }
      const known = this.queue.db.prepare('SELECT artifact,digest FROM adaptive_graph_batches').all() as { artifact: string; digest: string }[];
      for (const row of known) {
        const artifact = candidates.get(row.artifact);
        if (!artifact || artifactDigest(JSON.stringify(artifact)) !== row.digest) throw new Error('已知认识结果缺失或改变');
      }
      this.queue.db.exec('DELETE FROM adaptive_graph_records; DELETE FROM adaptive_graph_batches; UPDATE adaptive_graph_meta SET generation=0 WHERE singleton=1');
      const state = new Map<string, SemanticRecord>();
      for (const artifact of ordered) if (!this.install(artifact, true, state)) throw new Error('认识结果链不完整或版本冲突');
      const projection = this.projectionDigest();
      this.queue.db.exec('RELEASE adaptive_graph_rebuild');
      if (projection) verified.set(this.queue.db, { agent: this.queue.agent, artifacts: artifactsDigest, projection });
      else verified.delete(this.queue.db); // 缓存核对上限不能收紧原有存档格式的接受范围。
    } catch (error) {
      this.queue.db.exec('ROLLBACK TO adaptive_graph_rebuild'); this.queue.db.exec('RELEASE adaptive_graph_rebuild'); throw error;
    }
  }

  assess(read: SourceReader = (id) => this.queue.source(id)) {
    return this.snapshot(() => evaluateEvidence(this.current(), read));
  }

  candidates(read: SourceReader = (id) => this.queue.source(id)) {
    return this.snapshot(() => semanticCandidates(this.current(), read, (id) => this.queue.source(id)));
  }

  query(query: string, read: SourceReader = (id) => this.queue.source(id), neighbors?: SemanticNeighbors) {
    return this.snapshot(() => { const records = this.current(); return { ...selectSemantic(records, query, this.generation(), read, (id) => this.queue.source(id), neighbors), basis: semanticBasis(records, read) }; });
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
        participants: record.participants, ...(record.references ? { references: record.references } : {}),
        supports: record.supports.filter((g) => states.get(record.id)!.groups.includes(g.id)) },
        evidence: states.get(record.id)! })); // 不返回已失效 / 无权来源的其他依据组、反证或审计正文
    });
  }
}

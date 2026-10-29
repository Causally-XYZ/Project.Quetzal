// M2 语义投影：有版本记录与 M1 发件箱同事务接受；查询不相信持久化的 active 标记。
// 长期格式由 semantic-v2 payload 定义，兼容 v1；本表是可重建的投影，不替代灵魂文件。
import { AdaptiveStore, type MemoryJob } from './adaptive-store.ts';
import { artifactDigest, artifactDocument, type ArtifactInput, type MemoryArtifact } from './adaptive-artifact.ts';
import { SEMANTIC_SCHEMA, LEGACY_SEMANTIC_SCHEMA, semanticSchema, realmBoundRefs, validateBatch, validateRecord, directSpans, recordRefs, spanCurrent, sameRealm,
  evaluateEvidence, type SemanticBatch, type SemanticRecord, type SourceReader, type ClaimRecord } from './adaptive-evidence.ts';
import { sourceReading } from './adaptive-reading.ts';
import { selectSemantic, semanticBasis, semanticCandidates, semanticDigest, type SemanticNeighbors } from './adaptive-query.ts';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AdaptiveLookup } from './adaptive-lookup.ts';
import { LocalClosure, WorksetOverflow } from './adaptive-workset.ts';
import { tokens } from '../../../engine/src/retrieval.ts';

// 只缓存一次完整重放的见证，不缓存来源可见性或依据状态。连接释放后自动回收。
const verified = new WeakMap<DatabaseSync, { agent: string; artifacts: string; projection: string }>();

export class AdaptiveGraph {
  readonly queue: AdaptiveStore;
  readonly lookup: AdaptiveLookup;
  private readonly check?: (record: SemanticRecord) => void;
  constructor(queue: AdaptiveStore, privateCheck?: (record: SemanticRecord) => void) {
    this.check = privateCheck;
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
    db.exec('CREATE TABLE IF NOT EXISTS adaptive_graph_witness(singleton INTEGER PRIMARY KEY CHECK(singleton=1),token TEXT NOT NULL)');
    db.prepare('INSERT OR IGNORE INTO adaptive_graph_witness VALUES(1,?)').run(crypto.randomUUID());
    this.lookup = new AdaptiveLookup(db, privateCheck);
    db.exec('SAVEPOINT adaptive_lookup_schema');
    try { this.lookup.ensure(this.generation()); db.exec('RELEASE adaptive_lookup_schema'); }
    catch (error) { db.exec('ROLLBACK TO adaptive_lookup_schema'); db.exec('RELEASE adaptive_lookup_schema'); throw error; }
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
    const result: SemanticRecord[] = [];
    for (const row of this.queue.db.prepare('SELECT document FROM adaptive_graph_records WHERE id=? ORDER BY revision').iterate(id)) {
      if (result.length >= 1000) throw new Error('认识单目标历史超过工作上限');
      const value: unknown = JSON.parse(String(row.document)); validateRecord(value); this.check?.(value); result.push(value);
    }
    return result;
  }

  readSources(ids: number[], read: SourceReader = (id) => this.queue.source(id)) {
    return this.snapshot(() => {
      if (ids.length > 1000 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('原文修订读取超过范围');
      const affected = new Set<string>(), pending = [...new Set(ids.flatMap((id) => this.lookup.sourceOwners(id, 1001)))];
      for (let i = 0; i < pending.length; i++) {
        const id = pending[i]; if (affected.has(id)) continue;
        if (affected.size >= 1000) throw new Error('原文修订目标超过工作上限');
        affected.add(id); pending.push(...this.lookup.dependents(id, 1001).filter((next) => !affected.has(next)));
        if (pending.length > 10000) throw new Error('原文修订依赖超过工作上限');
      }
      // 先找到受影响的下游，再补其前提；不能从共同前提反向扩展到所有无关分支。
      const selected = new Set(affected), dependencies = [...affected];
      for (let i = 0; i < dependencies.length; i++) for (const next of this.lookup.references(dependencies[i], 1001)) {
        if (selected.has(next)) continue;
        if (selected.size >= 1000) throw new Error('原文修订依据超过工作上限');
        selected.add(next); dependencies.push(next);
      }
      const history: SemanticRecord[] = [];
      for (const id of selected) for (const r of this.history(id)) {
        if (history.length >= 10000) throw new Error('认识历史读取超过工作上限'); history.push(r);
      }
      return sourceReading(history, ids, this.generation(), read, (id) => this.queue.source(id));
    });
  }

  /** 宿主先把 LLM 提案规范化成带宿主 ID 的批次；不能把模型输出直接当批次使用。 */
  accept(job: MemoryJob, inputs: ArtifactInput[], batch: SemanticBatch, now = Date.now()): boolean {
    validateBatch(batch);
    const accepted = this.queue.acceptResult(job, inputs, { schema: SEMANTIC_SCHEMA, data: batch }, now, (artifact) => this.install(artifact));
    if (accepted) verified.delete(this.queue.db);
    return accepted;
  }

  /** 模型判断无需修改也必须锁定读取快照，不能把过期的“无需处理”记为完成。 */
  complete(job: MemoryJob, inputs: ArtifactInput[], generation: number, now = Date.now()): boolean {
    return this.queue.complete(job, now, () => generation === this.generation() &&
      inputs.some((i) => i.id === job.source && i.revision === job.revision) &&
      inputs.every((i) => this.queue.source(i.id, i.revision)?.hash === i.hash));
  }

  private install(artifact: MemoryArtifact, replay = false): boolean {
    const batch = artifact.payload.data; validateBatch(batch);
    if (artifact.payload.schema === LEGACY_SEMANTIC_SCHEMA && batch.records.some((r) => Object.hasOwn(r, 'references'))) return false;
    if (!semanticSchema(artifact.payload.schema) || artifact.agent !== this.queue.agent || batch.baseGeneration !== this.generation()) return false;
    const previous = new Map<string, SemanticRecord | undefined>();
    const oldRecord = (id: string) => {
      if (!previous.has(id)) {
        if (previous.size >= 1000) throw new Error('认识补丁依赖超过工作上限');
        previous.set(id, this.lookup.get(id));
      }
      return previous.get(id);
    };
    const patch = new Map<string, SemanticRecord>();
    const next = (id: string) => patch.get(id) ?? oldRecord(id);
    for (const r of batch.records) {
      const old = oldRecord(r.id);
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
    for (const r of batch.records) {
      insert.run(r.id, r.revision, r.kind, JSON.stringify(r), artifact.id);
      this.lookup.put(r, batch.baseGeneration + 1);
    }
    this.queue.db.prepare('UPDATE adaptive_graph_meta SET generation=generation+1 WHERE singleton=1').run();
    this.lookup.mark(batch.baseGeneration + 1);
    return true;
  }

  /** 对实际投影逐行核对，不能只信 generation / 文件 mtime / SQLite data_version。 */
  private projectionDigest(): string | undefined {
    return projectionDigest(this.queue.db);
  }

  /** 从完整权威结果链重建；来源可能已改动 / 尚未复制，由读取时的 hash 门禁决定可用性。
   * 已见结果的缺失或修改不得静默回退到旧认识。调用者失败时必须停止使用旧投影。
   */
  rebuild(artifacts: Iterable<MemoryArtifact>, minimum?: { artifact: string; generation: number; digest: string }): void {
    const db = this.queue.db;
    // 外部工作区交给 SQLite 的 B-tree / 排序器；JS 每次只持有一份结果。
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS adaptive_replay_stage(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,digest TEXT NOT NULL,document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS temp.adaptive_replay_order ON adaptive_replay_stage(generation,id);
      DELETE FROM adaptive_replay_stage`);
    let count = 0, bytes = 0;
    try {
      const insert = db.prepare('INSERT INTO adaptive_replay_stage VALUES(?,?,?,?)');
      for (const artifact of artifacts) {
        const document = artifactDocument(artifact); bytes += Buffer.byteLength(document);
        if (++count > 10000 || bytes > 64 * 1024 * 1024) throw new Error('认识重建超过工作上限');
        if (artifact.agent !== this.queue.agent || !semanticSchema(artifact.payload.schema) ||
            db.prepare('SELECT 1 FROM adaptive_replay_stage WHERE id=?').get(artifact.id)) throw new Error('认识重建结果身份或格式不合法');
        validateBatch(artifact.payload.data);
        insert.run(artifact.id, artifact.payload.data.baseGeneration, artifactDigest(document), document);
      }
      if (minimum) {
        const head = db.prepare('SELECT generation,digest FROM adaptive_replay_stage WHERE id=?').get(minimum.artifact);
        if (!head || Number(head.generation) + 1 !== minimum.generation || head.digest !== minimum.digest)
          throw new Error('认识存档未达到备份检查点');
      }
      const digest = crypto.createHash('sha256');
      for (const row of db.prepare('SELECT digest FROM adaptive_replay_stage ORDER BY generation,id').iterate()) digest.update(String(row.digest));
      const artifactsDigest = digest.digest('hex');
      db.exec('SAVEPOINT adaptive_graph_rebuild');
      try {
        const cached = verified.get(db);
        if (cached?.agent === this.queue.agent && cached.artifacts === artifactsDigest && cached.projection === this.projectionDigest()) {
          db.exec('RELEASE adaptive_graph_rebuild'); return;
        }
        if (db.prepare(`SELECT 1 FROM adaptive_graph_batches b LEFT JOIN adaptive_replay_stage s ON s.id=b.artifact
          WHERE s.id IS NULL OR s.digest<>b.digest LIMIT 1`).get()) throw new Error('已知认识结果缺失或改变');
        db.exec('DELETE FROM adaptive_graph_records; DELETE FROM adaptive_graph_batches; UPDATE adaptive_graph_meta SET generation=0 WHERE singleton=1');
        this.lookup.reset();
        for (const row of db.prepare('SELECT document FROM adaptive_replay_stage ORDER BY generation,id').iterate()) {
          const artifact = JSON.parse(String(row.document)) as MemoryArtifact;
          if (!this.install(artifact, true)) throw new Error('认识结果链不完整或版本冲突');
        }
        this.lookup.mark(this.generation());
        const projection = this.projectionDigest();
        db.prepare('UPDATE adaptive_graph_witness SET token=? WHERE singleton=1').run(crypto.randomUUID());
        db.exec('RELEASE adaptive_graph_rebuild');
        if (projection) verified.set(db, { agent: this.queue.agent, artifacts: artifactsDigest, projection });
        else verified.delete(db);
      } catch (error) {
        db.exec('ROLLBACK TO adaptive_graph_rebuild'); db.exec('RELEASE adaptive_graph_rebuild'); throw error;
      }
    } finally { db.exec('DELETE FROM adaptive_replay_stage'); }
  }

  assess(read: SourceReader = (id) => this.queue.source(id)) {
    return this.snapshot(() => evaluateEvidence(this.current(), read));
  }

  candidates(read: SourceReader = (id) => this.queue.source(id)) {
    return this.snapshot(() => {
      const result: ReturnType<typeof semanticCandidates> = [];
      let after = '';
      for (;;) {
        const page = this.lookup.page(after, 32); if (!page.length) break;
        for (const record of page) {
          const graph = new LocalClosure(this.lookup, read);
          try {
            const records = graph.collect([record.id], false, false);
            if (!records) continue;
            const own = semanticCandidates(records, read, (id) => this.queue.source(id)).find((c) => c.item.id === record.id);
            if (own) result.push(own);
          } catch (error) { if (!(error instanceof WorksetOverflow)) throw error; }
          if (result.length > 1000) throw new Error('向量候选超过工作上限');
        }
        after = page.at(-1)!.id;
      }
      this.lookup.remember(result);
      return result;
    });
  }

  query(query: string, read: SourceReader = (id) => this.queue.source(id), neighbors?: SemanticNeighbors) {
    return this.snapshot(() => {
      const dense = neighbors?.queryHash === semanticDigest(query) && neighbors.keys.length <= 1000 &&
        neighbors.keys.every((key) => /^[a-f0-9]{64}$/.test(key)) ? this.lookup.neighbors(neighbors.keys) : [];
      const queryTerms = new Set(tokens(query));
      const pending = [...dense, ...this.lookup.matches(query)];
      const seen = new Set<string>(), selected = new Map<string, SemanticRecord>(); let matched = 0, expanded = 0;
      for (let i = 0; i < pending.length && seen.size < 1000; i++) {
        const id = pending[i]; if (seen.has(id)) continue; seen.add(id);
        const graph = new LocalClosure(this.lookup, read);
        try {
          const records = graph.collect([id], false, false);
          if (!records) continue;
          const own = semanticCandidates(records, read, (source) => this.queue.source(source)).find((c) => c.item.id === id);
          const matches = own && (tokens(`${own.title}\n${own.text}`).some((term) => queryTerms.has(term)) ||
            neighbors?.queryHash === semanticDigest(query) && neighbors.keys.includes(own.key));
          if (own && matches) {
            matched++;
            // 有界候选进入最终重排；计数遍历不保留所有候选正文。
            if (matched <= 64) for (const r of records) selected.set(r.id, r);
          }
          if (expanded < 1000) {
            const next = this.lookup.dependents(id, Math.min(64, 1000 - expanded));
            expanded += next.length; pending.push(...next);
          }
        } catch (error) { if (!(error instanceof WorksetOverflow)) throw error; }
      }
      const initial = selectSemantic([...selected.values()], query, this.generation(), read, (id) => this.queue.source(id), neighbors);
      // 只从已选中、共同有效的根来源补一次候选，不沿“共用人物”或新候选递归扩张。
      // 索引枚举本身限界；当前版本可经审计来源找到修正后的正文，但旧词项 / 失效来源不能复活。
      const seeds = new Set(initial.items.map((item) => item.id)), roots = new Map<number, string>();
      for (const item of initial.items) for (const root of item.roots) if (roots.size < 64) roots.set(root.id, root.hash);
      const associated: string[] = [], examined = new Set<string>(); let visits = 0, extraBytes = 0;
      for (const [source, hash] of roots) {
        if (visits >= 64) break;
        for (const id of this.lookup.sourceOwners(source, 64 - visits)) {
          visits++;
          if (seeds.has(id) || examined.has(id)) continue;
          try {
            const records = new LocalClosure(this.lookup, read).collect([id], false, false);
            if (!records) continue;
            const own = semanticCandidates(records, read, (source) => this.queue.source(source)).find((c) => c.item.id === id);
            const record = records.find((r) => r.id === id)!;
            if (!own || !(own.item.roots.some((s) => s.id === source && s.hash === hash) ||
              directSpans(record).some((s) => s.source === source && s.hash === hash && spanCurrent(s, read) && spanCurrent(s, (id) => this.queue.source(id))))) continue;
            examined.add(id);
            const additions = records.filter((r) => !selected.has(r.id));
            const bytes = additions.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r)), 0);
            if (selected.size + additions.length > 1000 || extraBytes + bytes > 256 * 1024) continue;
            extraBytes += bytes; for (const r of additions) selected.set(r.id, r);
            associated.push(own.key);
          } catch (error) { if (!(error instanceof WorksetOverflow)) throw error; }
        }
      }
      const records = [...selected.values()];
      const result = selectSemantic(records, query, this.generation(), read, (id) => this.queue.source(id), neighbors,
        { queryHash: semanticDigest(query), keys: associated });
      const used = new LocalClosure(this.lookup, read).collect(result.items.map((item) => item.id), false, false) ?? [];
      return { ...result, matched: Math.max(result.matched, matched), basis: semanticBasis(used, read) };
    });
  }

  readLocal<T>(read: (lookup: Pick<AdaptiveLookup, 'get' | 'page' | 'search' | 'recent' | 'sourceOwners' | 'references' | 'dependents' | 'matches' | 'neighbors' | 'objects' | 'reviewTargets'>, generation: number) => T): T {
    return this.snapshot(() => read(this.lookup, this.generation()));
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

/** 只读摘要供后台巡检复用；不把排序临时数据装进 JS 全库 Map。 */
export function projectionDigest(db: DatabaseSync): string | undefined {
  const hash = crypto.createHash('sha256'); let rows = 0, bytes = 0;
  for (const sql of ['SELECT singleton,version,generation FROM adaptive_graph_meta ORDER BY singleton',
    'SELECT artifact,generation,digest FROM adaptive_graph_batches ORDER BY generation',
    'SELECT id,revision,kind,document,artifact FROM adaptive_graph_records ORDER BY id,revision',
    'SELECT singleton,generation FROM adaptive_lookup_meta ORDER BY singleton',
    'SELECT id,revision,generation,kind,world,realm,state FROM adaptive_lookup_heads ORDER BY id',
    'SELECT term,id,weight FROM adaptive_lookup_terms ORDER BY term,id',
    'SELECT owner,revision,source FROM adaptive_lookup_sources ORDER BY owner,revision,source',
    'SELECT owner,revision,target,kind FROM adaptive_lookup_refs ORDER BY owner,revision,target,kind']) {
    hash.update(sql);
    for (const row of db.prepare(sql).iterate()) {
      const text = JSON.stringify(row); bytes += Buffer.byteLength(text);
      // 超出权威结果可能具有的投影规模则不走快路径，由完整重放修复。
      if (++rows > 1_010_001 || bytes > 128 * 1024 * 1024) return undefined;
      hash.update(text); hash.update('\n');
    }
  }
  return hash.digest('hex');
}

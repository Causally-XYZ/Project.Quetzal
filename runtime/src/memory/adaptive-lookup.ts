// 可重建的外存检索索引：正文仍在版本表，词项、来源与邻接表只定位候选。
import type { DatabaseSync } from 'node:sqlite';
import { tokens, rank } from '../../../engine/src/retrieval.ts';
import { directSpans, recordRefs, validateRecord, type SemanticRecord } from './adaptive-evidence.ts';

/** 派生索引的送达票据，不是认识权威；只有 worker 确认后才消费。 */
export interface RetrievalPage {
  epoch: string; cursor: string; scanning: boolean; nextCursor: string; complete: boolean; limit: number;
  targets: { id: string; ticket: string | null }[];
}

export class AdaptiveLookup {
  private readonly db: DatabaseSync;
  private readonly check?: (record: SemanticRecord) => void;
  constructor(db: DatabaseSync, check?: (record: SemanticRecord) => void) {
    this.check = check;
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS adaptive_lookup_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL);
      INSERT OR IGNORE INTO adaptive_lookup_meta VALUES(1,-1);
      CREATE TABLE IF NOT EXISTS adaptive_lookup_heads(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,generation INTEGER NOT NULL,kind TEXT NOT NULL,world TEXT NOT NULL,realm TEXT NOT NULL,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS adaptive_lookup_recent ON adaptive_lookup_heads(generation DESC,id);
      CREATE INDEX IF NOT EXISTS adaptive_lookup_objects ON adaptive_lookup_heads(kind,world,realm,id);
      CREATE TABLE IF NOT EXISTS adaptive_lookup_terms(term TEXT NOT NULL,id TEXT NOT NULL,weight INTEGER NOT NULL,PRIMARY KEY(term,id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS adaptive_lookup_terms_record ON adaptive_lookup_terms(id);
      CREATE TABLE IF NOT EXISTS adaptive_lookup_sources(owner TEXT NOT NULL,revision INTEGER NOT NULL,source INTEGER NOT NULL,PRIMARY KEY(owner,revision,source)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS adaptive_lookup_source ON adaptive_lookup_sources(source,owner);
      CREATE TABLE IF NOT EXISTS adaptive_lookup_refs(owner TEXT NOT NULL,revision INTEGER NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(owner,revision,target,kind)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS adaptive_lookup_target ON adaptive_lookup_refs(target,owner);
      CREATE TABLE IF NOT EXISTS adaptive_lookup_rank_keys(key TEXT PRIMARY KEY,id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adaptive_lookup_dirty(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS adaptive_lookup_scan(singleton INTEGER PRIMARY KEY CHECK(singleton=1),cursor TEXT NOT NULL);
      INSERT OR IGNORE INTO adaptive_lookup_scan VALUES(1,'');
      CREATE TABLE IF NOT EXISTS adaptive_lookup_retrieval_dirty(id TEXT PRIMARY KEY,ticket INTEGER NOT NULL,cursor TEXT NOT NULL,queued INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS adaptive_lookup_retrieval_work ON adaptive_lookup_retrieval_dirty(queued,id);
      CREATE TABLE IF NOT EXISTS adaptive_lookup_retrieval_scan(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL,cursor TEXT NOT NULL,complete INTEGER NOT NULL,change INTEGER NOT NULL);
      INSERT OR IGNORE INTO adaptive_lookup_retrieval_scan VALUES(1,lower(hex(randomblob(16))),'',0,0);
      CREATE INDEX IF NOT EXISTS adaptive_lookup_rank_record ON adaptive_lookup_rank_keys(id);`);
    for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const row = event === 'DELETE' ? 'OLD' : 'NEW';
      const when = event === 'UPDATE' ? ` WHEN ${['ts','role','channel','text','session','body','via','mode','attachments'].map((f) => `OLD.${f} IS NOT NEW.${f}`).join(' OR ')}` : '';
      db.exec(`CREATE TRIGGER IF NOT EXISTS adaptive_lookup_message_${event.toLowerCase()} AFTER ${event} ON messages${when} BEGIN
        INSERT OR IGNORE INTO adaptive_lookup_dirty SELECT owner FROM adaptive_lookup_sources WHERE source=${row}.id;
      END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS adaptive_lookup_retrieval_message_${event.toLowerCase()} AFTER ${event} ON messages${when} BEGIN
        UPDATE adaptive_lookup_retrieval_scan SET change=change+1 WHERE singleton=1;
        INSERT OR REPLACE INTO adaptive_lookup_retrieval_dirty
          SELECT owner,(SELECT change FROM adaptive_lookup_retrieval_scan WHERE singleton=1),'',1
          FROM (SELECT DISTINCT owner FROM adaptive_lookup_sources WHERE source=${row}.id);
      END`);
    }
  }

  reset() {
    this.db.exec(`DELETE FROM adaptive_lookup_heads; DELETE FROM adaptive_lookup_terms;
      DELETE FROM adaptive_lookup_sources; DELETE FROM adaptive_lookup_refs; DELETE FROM adaptive_lookup_rank_keys; DELETE FROM adaptive_lookup_dirty;
      UPDATE adaptive_lookup_scan SET cursor='' WHERE singleton=1;
      DELETE FROM adaptive_lookup_retrieval_dirty;
      UPDATE adaptive_lookup_retrieval_scan SET epoch=lower(hex(randomblob(16))),cursor='',complete=0,change=0 WHERE singleton=1;
      UPDATE adaptive_lookup_meta SET generation=-1 WHERE singleton=1`);
  }

  mark(generation: number) { this.db.prepare('UPDATE adaptive_lookup_meta SET generation=? WHERE singleton=1').run(generation); }

  /** 升级旧投影时逐条补索引；不把全部记录和历史载入 JS。 */
  ensure(generation: number) {
    if (this.db.prepare('SELECT generation FROM adaptive_lookup_meta WHERE singleton=1').get()?.generation === generation) return;
    this.reset();
    for (const row of this.db.prepare(`SELECT r.document,b.generation FROM adaptive_graph_records r
      JOIN adaptive_graph_batches b ON b.artifact=r.artifact ORDER BY b.generation,r.id`).iterate()) {
      const record: unknown = JSON.parse(String(row.document)); validateRecord(record);
      this.put(record, Number(row.generation));
    }
    this.mark(generation);
  }

  /** 与版本记录在同一事务内更新；历史邻接保留，最新词项替换。 */
  put(record: SemanticRecord, generation: number) {
    this.db.prepare('INSERT OR IGNORE INTO adaptive_lookup_dirty SELECT owner FROM adaptive_lookup_refs WHERE target=? AND owner<>?').run(record.id, record.id);
    this.db.exec('UPDATE adaptive_lookup_retrieval_scan SET change=change+1 WHERE singleton=1');
    this.db.prepare(`INSERT OR REPLACE INTO adaptive_lookup_retrieval_dirty
      SELECT owner,(SELECT change FROM adaptive_lookup_retrieval_scan WHERE singleton=1),'',1
      FROM (SELECT DISTINCT owner FROM adaptive_lookup_refs WHERE target=?)`).run(record.id);
    this.db.prepare(`INSERT OR REPLACE INTO adaptive_lookup_retrieval_dirty
      VALUES(?,(SELECT change FROM adaptive_lookup_retrieval_scan WHERE singleton=1),'',1)`).run(record.id);
    const source = this.db.prepare('INSERT OR IGNORE INTO adaptive_lookup_sources VALUES(?,?,?)');
    for (const span of directSpans(record)) source.run(record.id, record.revision, span.source);
    const ref = this.db.prepare('INSERT OR IGNORE INTO adaptive_lookup_refs VALUES(?,?,?,?)');
    for (const r of recordRefs(record)) ref.run(record.id, record.revision, r.id, r.kind);
    this.db.prepare(`INSERT INTO adaptive_lookup_heads VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE
      SET revision=excluded.revision,generation=excluded.generation,kind=excluded.kind,world=excluded.world,realm=excluded.realm,state=excluded.state`)
      .run(record.id, record.revision, generation, record.kind, record.realm.world, record.realm.context, record.state);
    this.db.prepare('DELETE FROM adaptive_lookup_terms WHERE id=?').run(record.id);
    const title = record.kind === 'node' ? `${record.name} ${record.labels.join(' ')}` : '';
    const body = record.kind === 'claim' ? record.text : record.kind === 'mention' ? record.anchor.quote : '';
    const weights = new Map<string, number>();
    for (const t of tokens([body, ...directSpans(record).map((s) => s.quote)].join('\n'))) weights.set(t, 1);
    for (const t of tokens(title)) weights.set(t, 3);
    const insert = this.db.prepare('INSERT INTO adaptive_lookup_terms VALUES(?,?,?)');
    for (const [term, weight] of weights) insert.run(term, record.id, weight);
  }

  get(id: string): SemanticRecord | undefined {
    const row = this.db.prepare('SELECT document FROM adaptive_graph_records WHERE id=? ORDER BY revision DESC LIMIT 1').get(id);
    if (!row) return;
    const record: unknown = JSON.parse(String(row.document)); validateRecord(record); this.check?.(record); return record;
  }

  page(after = '', limit = 100): SemanticRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('认识分页范围不合法');
    return this.db.prepare(`SELECT r.document FROM adaptive_lookup_heads h JOIN adaptive_graph_records r
      ON r.id=h.id AND r.revision=h.revision WHERE h.id>? ORDER BY h.id LIMIT ?`).all(after, limit)
      .map((r) => { const value: unknown = JSON.parse(String(r.document)); validateRecord(value); this.check?.(value); return value; });
  }

  recent(limit = 32): string[] {
    return this.db.prepare('SELECT id FROM adaptive_lookup_heads ORDER BY generation DESC,id LIMIT ?').all(limit).map((r) => String(r.id));
  }

  sourceOwners(source: number, limit = 1000): string[] {
    return this.db.prepare('SELECT DISTINCT owner FROM adaptive_lookup_sources WHERE source=? ORDER BY owner LIMIT ?')
      .all(source, limit).map((r) => String(r.owner));
  }

  /** 历史分支只用于找到依赖的当前版本，不恢复旧证明。 */
  references(id: string, limit = 1000): string[] {
    return this.db.prepare('SELECT DISTINCT target FROM adaptive_lookup_refs WHERE owner=? ORDER BY target LIMIT ?')
      .all(id, limit).map((r) => String(r.target));
  }

  dependents(id: string, limit = 1000): string[] {
    return this.db.prepare('SELECT DISTINCT owner FROM adaptive_lookup_refs WHERE target=? ORDER BY owner LIMIT ?')
      .all(id, limit).map((r) => String(r.owner));
  }

  objects(realms: { world: string; context: string }[], limit = 100): SemanticRecord[] {
    const result: SemanticRecord[] = [], seen = new Set<string>();
    for (const realm of realms) for (const row of this.db.prepare(`SELECT id FROM adaptive_lookup_heads
      WHERE kind='node' AND world=? AND realm=? AND state='present' ORDER BY id LIMIT ?`).iterate(realm.world, realm.context, limit + 1)) {
      const id = String(row.id); if (seen.has(id)) continue; seen.add(id);
      if (result.length >= limit) throw new Error('重评对象候选超过工作上限');
      const record = this.get(id); if (record) result.push(record);
    }
    return result;
  }

  /** 增量变更先查脏目标，恢复兜底每轮只扫一页；游标不是认识权威。 */
  reviewTargets(limit = 32): string[] {
    const cursor = String(this.db.prepare('SELECT cursor FROM adaptive_lookup_scan WHERE singleton=1').get()!.cursor);
    const page = this.page(cursor, limit), dirty = this.db.prepare('SELECT id FROM adaptive_lookup_dirty ORDER BY id LIMIT ?').all(limit).map((r) => String(r.id));
    this.db.prepare('UPDATE adaptive_lookup_scan SET cursor=? WHERE singleton=1').run(page.length < limit ? '' : page.at(-1)!.id);
    const remove = this.db.prepare('DELETE FROM adaptive_lookup_dirty WHERE id=?'); for (const id of dirty) remove.run(id);
    return [...new Set([...dirty, ...page.map((r) => r.id)])];
  }

  retrievalState() {
    const row = this.db.prepare(`SELECT epoch,cursor,complete,
      EXISTS(SELECT 1 FROM adaptive_lookup_retrieval_dirty WHERE queued=1) AS dirty FROM adaptive_lookup_retrieval_scan WHERE singleton=1`).get()!;
    return { epoch: String(row.epoch), cursor: String(row.cursor), complete: row.complete === 1, dirty: row.dirty === 1 };
  }

  /** 每批固定留出全扫份额；旧记录不会被持续到来的 dirty 或近期记录挤走。 */
  retrievalPage(restart = false, limit = 16): RetrievalPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('检索索引分页范围不合法');
    if (restart) this.db.exec("UPDATE adaptive_lookup_retrieval_scan SET epoch=lower(hex(randomblob(16))),cursor='',complete=0 WHERE singleton=1");
    const state = this.retrievalState();
    const page = state.complete ? [] : this.db.prepare('SELECT id FROM adaptive_lookup_heads WHERE id>? ORDER BY id LIMIT ?').all(state.cursor, limit);
    const dirty = this.db.prepare('SELECT id FROM adaptive_lookup_retrieval_dirty WHERE queued=1 ORDER BY id LIMIT ?').all(limit);
    const ticket = this.db.prepare('SELECT ticket FROM adaptive_lookup_retrieval_dirty WHERE id=?');
    return { epoch: state.epoch, cursor: state.cursor, scanning: !state.complete, limit,
      nextCursor: page.length ? String(page.at(-1)!.id) : state.cursor,
      complete: state.complete || page.length < limit,
      targets: [...new Set([...dirty, ...page].map((r) => String(r.id)))].map((id) => {
        const row = ticket.get(id); return { id, ticket: row ? String(row.ticket) : null };
      }) };
  }

  /** 调用者须在事务中确认。新票据不被旧 ACK 删除；重建或另一次扫描使旧 ACK 整体失效。 */
  acknowledgeRetrieval(page: RetrievalPage, entries: { id: string; key: string | null }[]): boolean {
    const state = this.retrievalState();
    if (state.epoch !== page.epoch || state.cursor !== page.cursor || state.complete !== !page.scanning) return false;
    if (entries.length !== page.targets.length || entries.some((entry, i) => entry.id !== page.targets[i].id)) throw new Error('检索索引确认范围不一致');
    const ticket = this.db.prepare('SELECT ticket,cursor,queued FROM adaptive_lookup_retrieval_dirty WHERE id=?');
    const forget = this.db.prepare('DELETE FROM adaptive_lookup_rank_keys WHERE id=?');
    const remember = this.db.prepare('INSERT OR REPLACE INTO adaptive_lookup_rank_keys VALUES(?,?)');
    const dependents = this.db.prepare('SELECT DISTINCT owner FROM adaptive_lookup_refs WHERE target=? AND owner>? ORDER BY owner LIMIT 16');
    const enqueue = this.db.prepare(`INSERT INTO adaptive_lookup_retrieval_dirty VALUES(?,?,'',1)
      ON CONFLICT(id) DO UPDATE SET ticket=excluded.ticket,cursor='',queued=1 WHERE excluded.ticket>adaptive_lookup_retrieval_dirty.ticket`);
    const advance = this.db.prepare('UPDATE adaptive_lookup_retrieval_dirty SET cursor=?,queued=? WHERE id=? AND ticket=?');
    for (const [i, entry] of entries.entries()) {
      const expected = page.targets[i].ticket;
      const current = ticket.get(entry.id);
      if ((current ? String(current.ticket) : null) !== expected) continue;
      forget.run(entry.id); if (entry.key) remember.run(entry.key, entry.id);
      if (current?.queued === 1) {
        // 单调波次沿所有记录类型传播；保留已处理票据去环，不因无向量key的node/mention截断。
        const next = dependents.all(entry.id, current.cursor);
        for (const row of next) enqueue.run(row.owner, current.ticket);
        advance.run(next.length ? next.at(-1)!.owner : current.cursor, next.length === 16 ? 1 : 0, entry.id, expected);
      }
    }
    this.db.prepare('UPDATE adaptive_lookup_retrieval_scan SET cursor=?,complete=? WHERE singleton=1').run(page.nextCursor, Number(page.complete));
    return true;
  }

  /** 倒排表在 SQLite 内求交、排序；只有有界候选正文进入 JS 再排序。 */
  search(query: string, limit = 64): string[] {
    const ids = [...this.matches(query, limit)];
    const records = ids.flatMap((id) => { const r = this.get(id); return r ? [r] : []; });
    const docs = records.map((r) => ({ kind: 'memory' as const, source: r.id, mtime: 0,
      title: r.kind === 'node' ? `${r.name} ${r.labels.join(' ')}` : '',
      text: [r.kind === 'claim' ? r.text : r.kind === 'mention' ? r.anchor.quote : '', ...directSpans(r).map((s) => s.quote)].join('\n') }));
    return rank(query, docs, 0).map((r) => r.source);
  }

  *matches(query: string, limit = 1001): Generator<string> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1001) throw new Error('认识检索范围不合法');
    const terms = [...new Set(tokens(query))];
    if (!terms.length) return;
    // JSON参数避免SQLite变量数上限，也不因截掉句尾词项丢掉多主题输入。
    for (const row of this.db.prepare(`SELECT id,SUM(weight) score FROM adaptive_lookup_terms
      WHERE term IN (SELECT value FROM json_each(?)) GROUP BY id ORDER BY score DESC,id LIMIT ?`).iterate(JSON.stringify(terms), limit)) yield String(row.id);
  }

  // 近邻摘要键只作为检索建议；正文与依据仍重新点读核验，不纳入权威投影见证。
  neighbors(keys: string[]): string[] {
    if (keys.length > 1000) throw new Error('近邻建议超过工作上限');
    return keys.flatMap((key) => { const r = this.db.prepare('SELECT id FROM adaptive_lookup_rank_keys WHERE key=?').get(key); return r ? [String(r.id)] : []; });
  }
}

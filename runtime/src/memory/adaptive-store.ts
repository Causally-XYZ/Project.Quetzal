// 自适应记忆的本机持久任务。来源仍在 messages；这里只保存修订、租约和处理回执，不确认任何世界事实。
// SQLite 触发器与消息写入同事务，覆盖本机、复制、mode 修改和事件发出前崩溃；旧库通过反连接补齐。
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const SOURCE_PROCESSOR = 'source-v1';
export type JobState = 'queued' | 'running' | 'done' | 'cancelled' | 'failed' | 'stale';
export interface MemoryJob {
  id: string; source: number; revision: number; processor: string; state: JobState;
  attempts: number; available: number; token: string | null; lease: number; error: string | null;
}
export interface MemorySource {
  id: number; revision: number; hash: string; session: string; role: string; channel: string;
  text: string; ts: number; body: string | null; via: string | null;
}
const eligible = "m.role IN ('user','agent','ambient') AND COALESCE(m.mode,'') <> 'ignored' AND length(COALESCE(m.text,'')) > 0";
const jobColumns = 'id, source, revision, processor, state, attempts, available, token, lease, error';
const processorOk = (v: string) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v);

export class AdaptiveStore {
  readonly db: DatabaseSync;
  readonly agent: string;
  constructor(db: DatabaseSync, agent: string) {
    if (typeof agent !== 'string' || !agent || agent.length > 200) throw new Error('记忆 agent id 不合法');
    this.db = db; this.agent = agent;
    db.exec('CREATE TABLE IF NOT EXISTS adaptive_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, agent TEXT NOT NULL)');
    const meta = db.prepare('SELECT version, agent FROM adaptive_meta WHERE singleton=1').get() as { version: number; agent: string } | undefined;
    if (meta && (meta.version !== 1 || meta.agent !== agent)) throw new Error('记忆数据库版本或 agent 不匹配');
    this.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO adaptive_meta VALUES(1,1,?)').run(agent);
      const locked = db.prepare('SELECT version,agent FROM adaptive_meta WHERE singleton=1').get() as { version: number; agent: string };
      if (locked.version !== 1 || locked.agent !== agent) throw new Error('记忆数据库版本或 agent 不匹配');
      db.exec(`
        CREATE TABLE IF NOT EXISTS adaptive_sources(source INTEGER PRIMARY KEY, revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS adaptive_jobs(
          id TEXT PRIMARY KEY, source INTEGER NOT NULL, revision INTEGER NOT NULL, processor TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued','running','done','cancelled','failed','stale')),
          attempts INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL, token TEXT, lease INTEGER NOT NULL DEFAULT 0,
          error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
          UNIQUE(source,revision,processor)
        );
        CREATE INDEX IF NOT EXISTS adaptive_jobs_ready ON adaptive_jobs(processor,state,available,created);
        CREATE INDEX IF NOT EXISTS adaptive_jobs_source ON adaptive_jobs(source);
        CREATE TABLE IF NOT EXISTS adaptive_receipts(source INTEGER NOT NULL, processor TEXT NOT NULL, revision INTEGER NOT NULL, completed INTEGER NOT NULL, PRIMARY KEY(source,processor));
      `);
      // 同值更新不制造新修订；来源删除留墓碑，旧任务不能复活它。
      const fields = ['text', 'role', 'channel', 'session', 'ts', 'body', 'via', 'mode', 'attachments'];
      for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
        const row = event === 'DELETE' ? 'OLD' : 'NEW';
        const when = event === 'UPDATE' ? ` WHEN ${fields.map((f) => `OLD.${f} IS NOT NEW.${f}`).join(' OR ')}` : '';
        db.exec(`CREATE TRIGGER IF NOT EXISTS adaptive_message_${event.toLowerCase()} AFTER ${event} ON messages${when} BEGIN
          INSERT INTO adaptive_sources(source,revision,deleted) VALUES(${row}.id,1,${event === 'DELETE' ? 1 : 0})
            ON CONFLICT(source) DO UPDATE SET revision=revision+1, deleted=excluded.deleted;
          UPDATE adaptive_jobs SET state='stale', token=NULL, lease=0, error='source_changed'
            WHERE source=${row}.id AND state<>'cancelled';
          DELETE FROM adaptive_receipts WHERE source=${row}.id;
        END`);
      }
    });
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = run(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** 有界补扫，不使用时间高水位：晚到的旧消息和小编号身体不会漏掉。 */
  schedule(processor = SOURCE_PROCESSOR, now = Date.now(), batch = 100): number {
    if (!processorOk(processor) || !Number.isSafeInteger(batch) || batch < 1 || batch > 1000) throw new Error('记忆调度参数不合法');
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO adaptive_sources(source,revision)
        SELECT m.id,1 FROM messages m LEFT JOIN adaptive_sources s ON s.source=m.id WHERE s.source IS NULL LIMIT ?`).run(batch);
      const pending = this.db.prepare(`SELECT s.source,s.revision FROM adaptive_sources s JOIN messages m ON m.id=s.source
        WHERE s.deleted=0 AND ${eligible} AND NOT EXISTS(SELECT 1 FROM adaptive_jobs j WHERE j.source=s.source AND j.revision=s.revision AND j.processor=?)
        ORDER BY m.ts,m.id LIMIT ?`).all(processor, batch) as { source: number; revision: number }[];
      const insert = this.db.prepare("INSERT INTO adaptive_jobs(id,source,revision,processor,state,available,created,updated) VALUES(?,?,?,?,'queued',?,?,?)");
      for (const p of pending) insert.run(crypto.randomUUID(), p.source, p.revision, processor, now, now, now);
      return pending.length;
    });
  }

  claim(processor = SOURCE_PROCESSOR, now = Date.now(), leaseMs = 30_000): MemoryJob | undefined {
    if (!processorOk(processor) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error('记忆租约参数不合法');
    return this.transaction(() => {
      this.db.prepare(`UPDATE adaptive_jobs SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,
        token=NULL, lease=0, error='lease_expired', updated=? WHERE processor=? AND state='running' AND lease<=?`).run(now, processor, now);
      const job = this.db.prepare(`SELECT ${jobColumns} FROM adaptive_jobs WHERE processor=? AND state='queued' AND available<=?
        ORDER BY created,source LIMIT 1`).get(processor, now) as MemoryJob | undefined;
      if (!job) return;
      const token = crypto.randomUUID();
      this.db.prepare("UPDATE adaptive_jobs SET state='running',attempts=attempts+1,token=?,lease=?,updated=? WHERE id=?")
        .run(token, now + leaseMs, now, job.id);
      return { ...job, state: 'running', attempts: job.attempts + 1, token, lease: now + leaseMs };
    });
  }

  source(id: number, revision?: number): MemorySource | undefined {
    const r = this.db.prepare(`SELECT m.id,s.revision,m.session,m.role,m.channel,m.text,m.ts,m.body,m.via,m.mode,m.attachments
      FROM messages m JOIN adaptive_sources s ON s.source=m.id WHERE m.id=? AND s.deleted=0 AND ${eligible}`).get(id) as (MemorySource & { mode: string | null; attachments: string | null }) | undefined;
    if (!r || (revision !== undefined && r.revision !== revision)) return;
    const hash = crypto.createHash('sha256').update(JSON.stringify([this.agent, r.id, r.session, r.role, r.channel, r.text, r.ts, r.body, r.via, r.mode, r.attachments])).digest('hex');
    return { id: r.id, revision: r.revision, hash, session: r.session, role: r.role, channel: r.channel, text: r.text, ts: r.ts, body: r.body, via: r.via };
  }

  /** 回执只表示此来源版本已处理；不代表其正文或任何推论已被确认。 */
  complete(job: MemoryJob, now = Date.now()): boolean {
    return this.transaction(() => {
      if (!this.owns(job, now) || !this.source(job.source, job.revision)) return false;
      this.db.prepare(`INSERT INTO adaptive_receipts VALUES(?,?,?,?) ON CONFLICT(source,processor)
        DO UPDATE SET revision=excluded.revision,completed=excluded.completed`).run(job.source, job.processor, job.revision, now);
      this.db.prepare("UPDATE adaptive_jobs SET state='done',token=NULL,lease=0,error=NULL,updated=? WHERE id=?").run(now, job.id);
      return true;
    });
  }

  private owns(job: MemoryJob, now: number): boolean {
    return !!job.token && !!this.db.prepare(`SELECT 1 FROM adaptive_jobs j JOIN adaptive_sources s ON s.source=j.source
      WHERE j.id=? AND j.token=? AND j.source=? AND j.revision=? AND j.processor=? AND j.state='running' AND j.lease>? AND j.revision=s.revision AND s.deleted=0`)
      .get(job.id, job.token, job.source, job.revision, job.processor, now);
  }

  fail(job: MemoryJob, code: 'timeout' | 'processor_failed' | 'interrupted', now = Date.now()): boolean {
    if (!['timeout', 'processor_failed', 'interrupted'].includes(code)) throw new Error('记忆错误类型不合法');
    return this.transaction(() => {
      if (!this.owns(job, now)) return false;
      const available = now + Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6));
      return Number(this.db.prepare(`UPDATE adaptive_jobs SET state=?,available=?,token=NULL,lease=0,error=?,updated=? WHERE id=?`)
        .run(job.attempts >= 5 ? 'failed' : 'queued', available, code, now, job.id).changes) === 1;
    });
  }

  cancel(id: string, now = Date.now()): boolean {
    return Number(this.db.prepare("UPDATE adaptive_jobs SET state='cancelled',token=NULL,lease=0,error='cancelled',updated=? WHERE id=? AND state IN ('queued','running','failed')")
      .run(now, id).changes) === 1;
  }

  processed(id: number, processor = SOURCE_PROCESSOR): MemorySource | undefined {
    const receipt = this.db.prepare('SELECT revision FROM adaptive_receipts WHERE source=? AND processor=?').get(id, processor) as { revision: number } | undefined;
    return receipt ? this.source(id, receipt.revision) : undefined;
  }

  jobs(limit = 20): MemoryJob[] {
    return this.db.prepare(`SELECT ${jobColumns} FROM adaptive_jobs ORDER BY updated DESC,id LIMIT ?`).all(Math.max(1, Math.min(100, limit))) as unknown as MemoryJob[];
  }

  status(processor = SOURCE_PROCESSOR) {
    const counts: Record<JobState, number> = { queued: 0, running: 0, done: 0, cancelled: 0, failed: 0, stale: 0 };
    for (const row of this.db.prepare('SELECT state,COUNT(*) n FROM adaptive_jobs WHERE processor=? GROUP BY state').all(processor) as { state: JobState; n: number }[]) counts[row.state] = row.n;
    const last = this.db.prepare('SELECT MAX(completed) at FROM adaptive_receipts WHERE processor=?').get(processor) as { at: number | null };
    return { agent: this.agent, processor, counts, lastProcessedAt: last.at };
  }
}

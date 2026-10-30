// 自包含 worker 入口；由宿主序列化后启动，随 main.cjs 打包，不依赖额外的安装器复制脚本。
// 不读取灵魂 / 消息库；只处理宿主已经核查过的候选输入，缓存可删除重建。
export async function adaptiveVectorWorker() {
  const { parentPort, workerData } = await import('node:worker_threads');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { createHash } = await import('node:crypto');
  const { DatabaseSync } = await import('node:sqlite');
  if (!parentPort) throw new Error('worker required');
  const port = parentPort;
  const { root, cache, agent, space, pin, lock } = workerData;
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  let database: InstanceType<typeof DatabaseSync> | undefined;
  let extractor: any;
  let failureStage = 'component';
  try {
    const actual = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
    if (digest(JSON.stringify(actual)) !== digest(JSON.stringify(lock))) throw new Error('lock');
    for (const file of pin.files) {
      const bytes = await fs.readFile(path.join(root, 'model', file.path));
      const hash = file.sha256 ? createHash('sha256').update(bytes).digest('hex')
        : createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (bytes.length !== file.size || hash !== (file.sha256 ?? file.git)) throw new Error('model');
    }
    const packageFile = path.join(root, 'node_modules/@huggingface/transformers/package.json');
    const meta = JSON.parse(await fs.readFile(packageFile, 'utf8'));
    if (meta.version !== lock.packages['node_modules/@huggingface/transformers'].version) throw new Error('version');
    const { pipeline, env } = await import(pathToFileURL(path.join(path.dirname(packageFile), meta.exports.node.import.default)).href);
    env.allowRemoteModels = false; env.useBrowserCache = false;
    extractor = await pipeline('feature-extraction', path.join(root, 'model'), {
      dtype: 'q8', device: 'cpu', local_files_only: true,
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    });
    if (extractor.tokenizer.model_max_length !== 512) throw new Error('tokenizer');
    failureStage = 'cache';
    await fs.mkdir(path.dirname(cache), { recursive: true, mode: 0o700 });
    const file = await fs.open(cache, 'a', 0o600); await file.close();
    let cacheRecovered = false;
    for (let attempt = 0; ; attempt++) {
      try {
        database = new DatabaseSync(cache);
        if (database.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') throw new Error('cache_corrupt');
        database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS vectors (agent TEXT, space TEXT, key TEXT, value TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(agent,space,key))');
        const columns = database.prepare('PRAGMA table_info(vectors)').all().map((r) => [r.name, r.type, r.pk, r.notnull]);
        if (JSON.stringify(columns) !== JSON.stringify([['agent', 'TEXT', 1, 0], ['space', 'TEXT', 2, 0], ['key', 'TEXT', 3, 0], ['value', 'TEXT', 0, 1], ['digest', 'TEXT', 0, 1]])) throw new Error('cache_schema');
        // 清单与向量都是可重建派生数据；旧 vectors 空间不变，首次扫描结束前保留未遇到的缓存。
        database.exec(`CREATE TABLE IF NOT EXISTS vector_catalog (
      agent TEXT NOT NULL,space TEXT NOT NULL,id TEXT NOT NULL,key TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,
      seen TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(agent,space,id),UNIQUE(agent,space,key));
      CREATE TABLE IF NOT EXISTS vector_catalog_meta (
      agent TEXT NOT NULL,space TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,hash TEXT NOT NULL,complete INTEGER NOT NULL,
      PRIMARY KEY(agent,space));
      CREATE TABLE IF NOT EXISTS vector_catalog_counts (
      agent TEXT NOT NULL,space TEXT NOT NULL,total INTEGER NOT NULL,indexed_count INTEGER NOT NULL,retrying INTEGER NOT NULL,blocked INTEGER NOT NULL,
      PRIMARY KEY(agent,space));`);
        const shapes = {
          vector_catalog: [['agent','TEXT',1,1],['space','TEXT',2,1],['id','TEXT',3,1],['key','TEXT',0,1],['title','TEXT',0,1],['text','TEXT',0,1],
            ['seen','TEXT',0,1],['state','TEXT',0,1],['attempts','INTEGER',0,1],['available','INTEGER',0,1]],
          vector_catalog_counts: [['agent','TEXT',1,1],['space','TEXT',2,1],['total','INTEGER',0,1],['indexed_count','INTEGER',0,1],['retrying','INTEGER',0,1],['blocked','INTEGER',0,1]],
          vector_catalog_meta: [['agent','TEXT',1,1],['space','TEXT',2,1],['epoch','TEXT',0,1],['seq','INTEGER',0,1],['hash','TEXT',0,1],['complete','INTEGER',0,1]],
        };
        for (const [table, expected] of Object.entries(shapes)) {
          const actual = database.prepare('SELECT name,type,pk,"notnull" FROM pragma_table_info(?)').all(table)
            .map((r) => [r.name,r.type,r.pk,r.notnull]);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('cache_schema');
        }
        database.exec(`CREATE INDEX IF NOT EXISTS vector_catalog_work ON vector_catalog(agent,space,state,available,id);
          CREATE INDEX IF NOT EXISTS vector_catalog_seen ON vector_catalog(agent,space,seen,id);`);
        database.prepare('INSERT OR IGNORE INTO vector_catalog_meta VALUES(?,?,?,0,?,0)').run(agent, space, '', '');
        // 同一候选事务内维护计数；启动只校准一次，逐文档status不再全表扫描。
        for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
          const subtract = event === 'INSERT' ? '' : `UPDATE vector_catalog_counts SET total=total-1,
            indexed_count=indexed_count-(OLD.state='indexed'),retrying=retrying-(OLD.state='pending' AND OLD.attempts>0),
            blocked=blocked-(OLD.state='blocked') WHERE agent=OLD.agent AND space=OLD.space;`;
          const add = event === 'DELETE' ? '' : `INSERT INTO vector_catalog_counts VALUES(NEW.agent,NEW.space,1,
            NEW.state='indexed',NEW.state='pending' AND NEW.attempts>0,NEW.state='blocked')
            ON CONFLICT(agent,space) DO UPDATE SET total=total+1,indexed_count=indexed_count+excluded.indexed_count,
            retrying=retrying+excluded.retrying,blocked=blocked+excluded.blocked;`;
          database.exec(`CREATE TRIGGER IF NOT EXISTS vector_catalog_count_${event.toLowerCase()} AFTER ${event} ON vector_catalog
            BEGIN ${subtract} ${add} END`);
        }
        database.prepare(`INSERT OR REPLACE INTO vector_catalog_counts SELECT ?,?,count(*),
          COALESCE(SUM(state='indexed'),0),COALESCE(SUM(state='pending' AND attempts>0),0),COALESCE(SUM(state='blocked'),0)
          FROM vector_catalog WHERE agent=? AND space=?`).run(agent, space, agent, space);
        break;
      } catch (error) {
        try { database?.close(); } catch { /* 半打开连接 */ }
        database = undefined;
        const code = Number((error as { errcode?: number }).errcode) & 255;
        if (attempt || !([11, 26].includes(code) || error instanceof Error && ['cache_corrupt', 'cache_schema'].includes(error.message))) throw error;
        // 只处理派生缓存的确定损坏；busy / 权限 / 磁盘错误不能当损坏清空。保留现场便于核查。
        const quarantine = `${cache}.damaged-${Date.now()}`;
        for (const suffix of ['', '-wal', '-shm']) {
          try { await fs.rename(cache + suffix, quarantine + suffix); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        }
        const replacement = await fs.open(cache, 'a', 0o600); await replacement.close(); cacheRecovered = true;
      }
    }
    const db = database;
    type Candidate = { id: string; key: string; title: string; text: string };
    type Batch = { epoch: string; seq: number; begin?: boolean; complete?: boolean; upsert: Candidate[]; remove: { id: string; key?: string }[] };
    type Query = { id: number; query: string; deadline: number; cancelled?: boolean };
    let queries: Query[] = [], activeQuery: Query | undefined;
    let pumping = false, applying = false, reused = 0, computed = 0, closing = false, disposed = false;
    let retryTimer: NodeJS.Timeout | undefined;
    let retryAfter = 0;
    const busy = (error: unknown) => [5, 6].includes(Number((error as { errcode?: number }).errcode) & 255);
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    const catalogMeta = () => db.prepare('SELECT epoch,seq,hash,complete FROM vector_catalog_meta WHERE agent=? AND space=?').get(agent, space)!;
    const own = (id: string) => db.prepare('SELECT * FROM vector_catalog WHERE agent=? AND space=? AND id=?').get(agent, space, id);
    const current = (c: Candidate) => own(c.id)?.key === c.key;
    async function shutdown() {
      if (disposed || pumping || applying) return;
      disposed = true; clearTimeout(retryTimer);
      try { db.close(); await extractor.dispose(); } finally { port.close(); }
    }
    const valid = (v: unknown): v is number[] => Array.isArray(v) && v.length === 384 && v.every(Number.isFinite) && Math.abs(Math.hypot(...v) - 1) < 0.0001;
    const tokenCount = (text: string) => extractor.tokenizer(text, { padding: false, truncation: false }).input_ids.data.length;
    // 在原字符边界切分；文档块缩至128 token，让单次原生调用可在查询预算内结束。
    // 查询最多480 token；每块重新分词确认，重叠保留边界语境，不截断末尾。
    function* chunks(text: string, prefix: string): Generator<string> {
      const chars = Array.from(text); let count = 0;
      const passage = prefix === 'passage: ', tokenLimit = passage ? 128 : 480, window = passage ? 512 : 2048, overlap = passage ? 32 : 64;
      for (let start = 0; start < chars.length;) {
        let lo = 1, hi = Math.min(window, chars.length - start), length = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          if (tokenCount(prefix + chars.slice(start, start + mid).join('')) <= tokenLimit) { length = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        if (!length || count++ >= 128) throw new Error('chunk_limit');
        yield prefix + chars.slice(start, start + length).join('');
        if (start + length === chars.length) break;
        start += Math.max(1, length - overlap);
      }
    }
    async function embed(text: string) {
      // 双重核查，不让模型内部默认截断悄悄丢失尾部。
      if (tokenCount(text) > 512) throw new Error('truncated');
      const vector = Array.from((await extractor(text, { pooling: 'mean', normalize: true })).data) as number[];
      if (!valid(vector)) throw new Error('vector');
      return vector;
    }
    // 每次只解析一个文档，最多128块；拒绝异常缓存正文，避免单行无限分配。
    const parsedCache = new Map<string, { digest: string; raw: string; vectors: Float32Array[] }>();
    const rememberParsed = (key: string, expectedDigest: string, raw: string, vectors: Float32Array[]) => {
      parsedCache.delete(key); parsedCache.set(key, { digest: expectedDigest, raw, vectors });
      if (parsedCache.size > 16384) parsedCache.delete(parsedCache.keys().next().value!);
    };
    let lastDataVersion = -1;
    const syncParsedCache = (connection: InstanceType<typeof DatabaseSync>) => {
      const version = Number(connection.prepare('PRAGMA data_version').get()?.data_version ?? -1);
      if (version !== lastDataVersion) { parsedCache.clear(); lastDataVersion = version; }
    };
    const parseVectors = (key: string, raw: unknown, expectedDigest: unknown): Float32Array[] | undefined => {
      if (typeof expectedDigest !== 'string') return;
      const hit = parsedCache.get(key);
      if (hit && hit.digest === expectedDigest && raw === undefined) return hit.vectors;
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2097152) return;
      if (hit && hit.digest === expectedDigest && hit.raw === raw) return hit.vectors;
      if (digest(raw) !== expectedDigest) return;
      try {
        const value: unknown = JSON.parse(raw);
        if (Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every(valid)) {
          const vectors = value.map((v) => new Float32Array(v));
          rememberParsed(key, expectedDigest, raw, vectors);
          return vectors;
        }
      } catch { /* 损坏派生条目由后台重建。 */ }
    };
    const cached = (connection: InstanceType<typeof DatabaseSync>, key: string): Float32Array[] | undefined => {
      syncParsedCache(connection);
      const row = connection.prepare('SELECT value,digest FROM vectors WHERE agent=? AND space=? AND key=? AND length(CAST(value AS BLOB))<=2097152').get(agent, space, key);
      return row ? parseVectors(key, row.value, row.digest) : undefined;
    };
    const status = () => {
      const m = catalogMeta();
      const counts = db.prepare('SELECT total,indexed_count,retrying,blocked FROM vector_catalog_counts WHERE agent=? AND space=?').get(agent, space)!;
      const indexed = Number(counts.indexed_count ?? 0);
      port.postMessage({ type: 'status', snapshot: m.hash, epoch: m.epoch, seq: m.seq, scanComplete: !!m.complete,
        indexed, pending: Number(counts.total) - indexed, reused, computed, retrying: Number(counts.retrying ?? 0),
        blocked: Number(counts.blocked ?? 0), cacheRecovered });
    };
    function scheduleRetries() {
      clearTimeout(retryTimer);
      if (closing) return;
      try {
        const row = db.prepare("SELECT MIN(available) at FROM vector_catalog WHERE agent=? AND space=? AND state='pending'").get(agent, space);
        if (row?.at == null) return;
        retryTimer = setTimeout(() => { void pump(); }, Math.max(1, Number(row.at) - Date.now(), retryAfter - Date.now()));
      } catch (error) {
        if (!busy(error)) { closing = true; port.postMessage({ type: 'failed', stage: 'cache' }); void shutdown(); return; }
        retryTimer = setTimeout(() => { void pump(); }, 2000);
      }
    }
    async function answer() {
      while (queries.length && !closing) {
        const q = queries.shift()!; activeQuery = q;
        let reader: InstanceType<typeof DatabaseSync> | undefined;
        const check = () => { if (closing || q.cancelled || Date.now() >= q.deadline) throw new Error('timeout'); };
        try {
          check();
          const queryVectors: number[][] = [];
          for (const part of chunks(q.query, 'query: ')) { check(); queryVectors.push(await embed(part)); await tick(); }
          check();
          // 独立连接的短读事务固定本次已索引集合；不能跨异步页混合清单版本。
          syncParsedCache(db);
          reader = new DatabaseSync(cache, { readOnly: true }); reader.exec('BEGIN');
          reader.prepare('SELECT seq FROM vector_catalog_meta WHERE agent=? AND space=?').get(agent, space);
          type Hit = { key: string; score: number; order: number };
          const heap: Hit[] = [];
          const worse = (a: Hit, b: Hit) => a.score < b.score || a.score === b.score && a.order > b.order;
          const push = (hit: Hit) => {
            if (heap.length < 1000) {
              heap.push(hit); let i = heap.length - 1;
              while (i) { const p = (i - 1) >>> 1; if (!worse(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; }
            } else if (worse(heap[0], hit)) {
              heap[0] = hit; let i = 0;
              for (;;) { let j = i * 2 + 1; if (j >= heap.length) break;
                if (j + 1 < heap.length && worse(heap[j + 1], heap[j])) j++;
                if (!worse(heap[j], heap[i])) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j; }
            }
          };
          let after = '', order = 0, lastYield = performance.now();
          const selectFastPage = reader.prepare(`SELECT c.id,c.key,v.digest FROM vector_catalog c
            LEFT JOIN vectors v ON v.agent=c.agent AND v.space=c.space AND v.key=c.key
            WHERE c.agent=? AND c.space=? AND c.state='indexed' AND c.id>? ORDER BY c.id LIMIT 128`);
          const selectSingle = reader.prepare('SELECT value,digest FROM vectors WHERE agent=? AND space=? AND key=? AND length(CAST(value AS BLOB))<=2097152');
          for (;;) {
            check();
            const page = selectFastPage.all(agent, space, after);
            if (!page.length) break;
            for (const candidate of page) {
              check(); const key = String(candidate.key), expectedDigest = candidate.digest;
              const hit = typeof expectedDigest === 'string' ? parsedCache.get(key) : undefined;
              let list = hit && hit.digest === expectedDigest ? hit.vectors : undefined;
              if (!list) {
                const row = selectSingle.get(agent, space, key);
                list = row ? parseVectors(key, row.value, row.digest) : undefined;
              }
              if (!list) {
                parsedCache.delete(key);
                // 清单持久化后，缓存仍可能独立损坏；仅失效仍匹配的版本，后台重建。
                db.prepare("UPDATE vector_catalog SET state='pending',attempts=0,available=0 WHERE agent=? AND space=? AND id=? AND key=?")
                  .run(agent, space, candidate.id, candidate.key);
                port.postMessage({ type: 'index-error' }); status(); throw new Error('cache');
              }
              let score = -Infinity;
              for (const d of list) {
                check();
                for (const v of queryVectors) {
                  let dot = 0;
                  for (let i = 0; i < 384; i++) dot += v[i] * d[i];
                  if (dot > score) score = dot;
                }
                if (performance.now() - lastYield >= 4) { await tick(); lastYield = performance.now(); }
              }
              push({ key, score, order: order++ });
            }
            after = String(page.at(-1)!.id);
            if (performance.now() - lastYield >= 4) { await tick(); lastYield = performance.now(); }
          }
          check();
          const keys = heap.sort((a, b) => b.score - a.score || a.order - b.order).map((h) => h.key);
          check(); port.postMessage({ type: 'answer', id: q.id, keys });
        } catch { port.postMessage({ type: 'answer', id: q.id, keys: [] }); }
        finally { try { reader?.close(); } finally { activeQuery = undefined; } }
      }
    }
    async function pump() {
      if (pumping || applying || closing) return;
      pumping = true;
      try {
        await answer();
        while (!closing && !applying && Date.now() >= retryAfter) {
          const row = db.prepare("SELECT id,key,title,text,attempts FROM vector_catalog WHERE agent=? AND space=? AND state='pending' AND available<=? ORDER BY available,id LIMIT 1").get(agent, space, Date.now());
          if (!row) break;
          const candidate = row as unknown as Candidate;
          try {
            const list: number[][] = [];
            for (const part of chunks(`${candidate.title}\n${candidate.text}`, 'passage: ')) {
              list.push(await embed(part)); await tick(); await answer();
              if (!current(candidate) || closing) break;
            }
            if (closing || !current(candidate)) continue;
            const value = JSON.stringify(list), valueDigest = digest(value);
            db.exec('BEGIN');
            try {
              db.prepare('INSERT OR REPLACE INTO vectors VALUES (?,?,?,?,?)').run(agent, space, candidate.key, value, valueDigest);
              db.prepare("UPDATE vector_catalog SET state='indexed',attempts=0,available=0 WHERE agent=? AND space=? AND id=? AND key=?").run(agent, space, candidate.id, candidate.key);
              db.exec('COMMIT');
              lastDataVersion = Number(db.prepare('PRAGMA data_version').get()?.data_version ?? -1);
              rememberParsed(candidate.key, valueDigest, value, list.map((v) => new Float32Array(v)));
            } catch (error) { db.exec('ROLLBACK'); throw error; }
            computed++; status();
          } catch (error) {
            if (busy(error)) throw error;
            if (current(candidate) && !closing) {
              if ([11, 26].includes(Number((error as { errcode?: number }).errcode) & 255)) {
                closing = true; port.postMessage({ type: 'failed', stage: 'cache' }); continue;
              }
              const blocked = error instanceof Error && ['chunk_limit', 'truncated'].includes(error.message);
              const attempts = Number(row.attempts) + 1;
              db.prepare('UPDATE vector_catalog SET state=?,attempts=?,available=? WHERE agent=? AND space=? AND id=? AND key=?')
                .run(blocked ? 'blocked' : 'pending', attempts, Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(attempts - 1, 5)), agent, space, candidate.id, candidate.key);
              port.postMessage({ type: 'index-error' }); status();
            }
          }
        }
      } catch (error) {
        if (busy(error)) {
          // 写锁期间不能再写重试状态；只保留一个有界退避时刻，原pending行不丢失。
          retryAfter = Date.now() + 2000; port.postMessage({ type: 'index-error' });
        } else { closing = true; port.postMessage({ type: 'failed', stage: 'cache' }); }
      } finally { pumping = false; if (closing) await shutdown(); else if (!applying) scheduleRetries(); }
    }
    const keyValid = (key: unknown) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
    const idValid = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 512;
    async function apply(batch: Batch) {
      const { upsert, remove } = batch;
      if (!idValid(batch.epoch) || !Number.isSafeInteger(batch.seq) || batch.seq < 1 ||
          batch.begin !== undefined && typeof batch.begin !== 'boolean' || batch.complete !== undefined && typeof batch.complete !== 'boolean' ||
          !Array.isArray(upsert) || !Array.isArray(remove) || upsert.length > 1000 || remove.length > 1000 ||
          Buffer.byteLength(JSON.stringify(batch)) > 8 * 1024 * 1024 ||
          upsert.some((c) => !c || !idValid(c.id) || !keyValid(c.key) || typeof c.title !== 'string' || typeof c.text !== 'string') ||
          remove.some((r) => !r || !idValid(r.id) || r.key !== undefined && !keyValid(r.key)) ||
          new Set(upsert.map((c) => c.id)).size !== upsert.length || new Set(upsert.map((c) => c.key)).size !== upsert.length ||
          new Set(remove.map((r) => r.id)).size !== remove.length) throw new Error('batch');
      const hash = digest(JSON.stringify(batch)); let m = catalogMeta();
      if (m.epoch === batch.epoch && m.seq === batch.seq) {
        if (m.hash !== hash) throw new Error('batch');
        port.postMessage({ type: 'ack', epoch: m.epoch, seq: m.seq, scanComplete: !!m.complete }); return;
      }
      if (batch.begin && batch.seq === 1 && batch.epoch !== m.epoch) {
        db.prepare('UPDATE vector_catalog_meta SET epoch=?,seq=0,hash=?,complete=0 WHERE agent=? AND space=?').run(batch.epoch, '', agent, space); m = catalogMeta();
      }
      if (m.epoch !== batch.epoch || batch.seq !== Number(m.seq) + 1 || batch.begin && batch.seq !== 1) throw new Error('batch');
      // 每条事务可重放；只在整批（及完整扫描清扫）完成后记录序号并ACK。中断不丢最后未确认的变更。
      for (const removal of remove) {
        if (closing) return;
        const old = own(removal.id);
        if (old && (removal.key === undefined || removal.key === old.key)) {
          db.exec('BEGIN');
          try {
            db.prepare('DELETE FROM vector_catalog WHERE agent=? AND space=? AND id=?').run(agent, space, removal.id);
            db.prepare('DELETE FROM vectors WHERE agent=? AND space=? AND key=?').run(agent, space, old.key);
            db.exec('COMMIT');
            parsedCache.delete(String(old.key));
          } catch (error) { db.exec('ROLLBACK'); throw error; }
        }
        await tick();
      }
      for (const c of upsert) {
        if (closing) return;
        const old = own(c.id), sameKey = db.prepare('SELECT id,title,text FROM vector_catalog WHERE agent=? AND space=? AND key=?').get(agent, space, c.key);
        if (sameKey && (sameKey.id !== c.id || sameKey.title !== c.title || sameKey.text !== c.text)) throw new Error('key');
        const list = cached(db, c.key);
        db.exec('BEGIN');
        try {
          if (old && old.key !== c.key) { db.prepare('DELETE FROM vectors WHERE agent=? AND space=? AND key=?').run(agent, space, old.key); parsedCache.delete(String(old.key)); }
          if (!list) { db.prepare('DELETE FROM vectors WHERE agent=? AND space=? AND key=?').run(agent, space, c.key); parsedCache.delete(c.key); }
          db.prepare(`INSERT INTO vector_catalog(agent,space,id,key,title,text,seen,state) VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(agent,space,id) DO UPDATE SET key=excluded.key,title=excluded.title,text=excluded.text,seen=excluded.seen,
            state=excluded.state,attempts=CASE WHEN vector_catalog.key=excluded.key THEN vector_catalog.attempts ELSE 0 END,
            available=CASE WHEN vector_catalog.key=excluded.key THEN vector_catalog.available ELSE 0 END`)
            .run(agent, space, c.id, c.key, c.title, c.text, batch.epoch, list ? 'indexed' : old?.key === c.key && old.state === 'blocked' ? 'blocked' : 'pending');
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        if (list) reused++;
        await tick();
      }
      if (batch.complete) {
        for (;;) {
          if (closing) return;
          const page = db.prepare('SELECT id,key FROM vector_catalog WHERE agent=? AND space=? AND seen<>? LIMIT 32').all(agent, space, batch.epoch);
          if (!page.length) break;
          db.exec('BEGIN');
          try {
            for (const row of page) {
              db.prepare('DELETE FROM vector_catalog WHERE agent=? AND space=? AND id=?').run(agent, space, row.id);
              db.prepare('DELETE FROM vectors WHERE agent=? AND space=? AND key=?').run(agent, space, row.key);
              parsedCache.delete(String(row.key));
            }
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          await tick();
        }
        // 首次迁移时无清单的旧缓存也只在全扫结束后清理，每次仅保留有界key页。
        for (;;) {
          if (closing) return;
          const page = db.prepare(`SELECT key FROM vectors v WHERE agent=? AND space=? AND NOT EXISTS
            (SELECT 1 FROM vector_catalog c WHERE c.agent=v.agent AND c.space=v.space AND c.key=v.key) LIMIT 32`).all(agent, space);
          if (!page.length) break;
          for (const row of page) { db.prepare('DELETE FROM vectors WHERE agent=? AND space=? AND key=?').run(agent, space, row.key); parsedCache.delete(String(row.key)); }
          await tick();
        }
      }
      if (closing) return;
      db.prepare('UPDATE vector_catalog_meta SET seq=?,hash=?,complete=? WHERE agent=? AND space=?').run(batch.seq, hash, batch.complete || m.complete ? 1 : 0, agent, space);
      status(); port.postMessage({ type: 'ack', epoch: batch.epoch, seq: batch.seq, scanComplete: !!(batch.complete || m.complete) });
    }
    port.on('message', (message) => {
      if (message.type === 'stop') {
        closing = true; queries = []; if (activeQuery) activeQuery.cancelled = true; void shutdown(); return;
      }
      if (closing) return;
      if (message.type === 'batch') {
        if (applying) { closing = true; port.postMessage({ type: 'failed', stage: 'worker' }); void shutdown(); return; }
        applying = true;
        void apply(message.batch).catch((error) => {
          closing = true; port.postMessage({ type: 'failed', stage: Number.isInteger((error as { errcode?: number }).errcode) ? 'cache' : 'worker' });
        }).finally(() => { applying = false; if (closing) void shutdown(); else void pump(); });
      } else if (message.type === 'query') {
        if (typeof message.query !== 'string' || message.query.length > 8000 || !Number.isSafeInteger(message.id) || !Number.isFinite(message.deadline) || queries.length >= 16) {
          port.postMessage({ type: 'index-error' }); return;
        }
        queries.push(message); void pump();
      } else if (message.type === 'cancel') {
        queries = queries.filter((q) => q.id !== message.id);
        if (activeQuery && activeQuery.id === message.id) activeQuery.cancelled = true;
      }
    });
    status(); port.postMessage({ type: 'ready' }); void pump();
  } catch {
    try { database?.close(); await extractor?.dispose(); } catch { /* 失败信息不含私有输入 */ }
    port.postMessage({ type: 'failed', stage: failureStage }); port.close();
  }
}

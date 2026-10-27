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
    await fs.mkdir(path.dirname(cache), { recursive: true, mode: 0o700 });
    const file = await fs.open(cache, 'a', 0o600); await file.close();
    database = new DatabaseSync(cache);
    database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS vectors (agent TEXT, space TEXT, key TEXT, value TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(agent,space,key))');
    const db = database;
    type Candidate = { key: string; title: string; text: string };
    type Query = { id: number; query: string; deadline: number };
    const vectors = new Map<string, number[][]>();
    let desired = new Map<string, Candidate>(), remaining: Candidate[] = [], queries: Query[] = [];
    let pumping = false, epoch = 0, reused = 0, computed = 0, snapshot = '', closing = false, disposed = false;
    async function shutdown() {
      if (disposed) return;
      disposed = true;
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
    const status = () => port.postMessage({ type: 'status', snapshot, indexed: vectors.size, pending: desired.size - vectors.size, reused, computed });
    async function answer() {
      while (queries.length && !closing) {
        const q = queries.shift()!;
        if (Date.now() >= q.deadline) { port.postMessage({ type: 'answer', id: q.id, keys: [] }); continue; }
        try {
          const parts = chunks(q.query, 'query: '), scores = new Map<string, number>();
          for (const part of parts) {
            if (closing || Date.now() >= q.deadline) throw new Error('timeout');
            const v = await embed(part);
            for (const [key, list] of vectors) if (desired.has(key)) for (const d of list) {
              const score = v.reduce((sum, n, i) => sum + n * d[i], 0);
              scores.set(key, Math.max(scores.get(key) ?? -1, score));
            }
          }
          port.postMessage({ type: 'answer', id: q.id, keys: Date.now() < q.deadline ? [...scores].sort((a, b) => b[1] - a[1]).slice(0, 1000).map(([key]) => key) : [] });
        } catch { port.postMessage({ type: 'answer', id: q.id, keys: [] }); }
      }
    }
    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        await answer();
        while (remaining.length && !closing) {
          const candidate = remaining.shift()!, version = epoch;
          try {
            const parts = chunks(`${candidate.title}\n${candidate.text}`, 'passage: '), list: number[][] = [];
            for (const part of parts) {
              list.push(await embed(part));
              await new Promise<void>((resolve) => setImmediate(resolve));
              await answer(); // 每块之间让查询先走，避免排在整批历史后面。
              if (version !== epoch || closing) break;
            }
            if (closing || version !== epoch || !desired.has(candidate.key)) continue;
            const value = JSON.stringify(list);
            db.prepare('INSERT OR REPLACE INTO vectors VALUES (?,?,?,?,?)').run(agent, space, candidate.key, value, digest(value));
            vectors.set(candidate.key, list); computed++; status();
          } catch { port.postMessage({ type: 'index-error' }); }
        }
      } finally { pumping = false; if (closing) await shutdown(); }
    }
    port.on('message', (message) => {
      try {
        if (message.type === 'stop') {
          closing = true; remaining = []; queries = [];
          if (!pumping) void shutdown();
        } else if (closing) return;
        else if (message.type === 'replace') {
          const list: Candidate[] = message.candidates;
          if (!Array.isArray(list) || list.length > 1000 || Buffer.byteLength(JSON.stringify(list)) > 8 * 1024 * 1024 ||
              list.some((c) => !c || !/^[a-f0-9]{64}$/.test(c.key) || typeof c.title !== 'string' || typeof c.text !== 'string')) throw new Error('input');
          epoch++; snapshot = digest(JSON.stringify(list)); desired = new Map(list.map((c) => [c.key, c]));
          for (const key of vectors.keys()) if (!desired.has(key)) vectors.delete(key);
          // 当前快照未包含的旧记录删除；加载时校验空间、向量形状与内容摘要。
          for (const row of db.prepare('SELECT key,value,digest FROM vectors WHERE agent=? AND space=?').all(agent, space)) {
            const key = String(row.key); let stored: unknown;
            try { stored = JSON.parse(String(row.value)); } catch { /* 损坏缓存由当前输入重建 */ }
            if (!desired.has(key) || digest(String(row.value)) !== row.digest || !Array.isArray(stored) || !stored.length || stored.length > 128 || !stored.every(valid)) {
              db.prepare('DELETE FROM vectors WHERE agent=? AND space=? AND key=?').run(agent, space, key); vectors.delete(key);
            } else if (!vectors.has(key)) { vectors.set(key, stored); reused++; }
          }
          remaining = list.filter((c) => !vectors.has(c.key)); status(); void pump();
        } else if (message.type === 'query') {
          if (typeof message.query !== 'string' || message.query.length > 8000 || !Number.isSafeInteger(message.id) || !Number.isFinite(message.deadline) || queries.length >= 16) throw new Error('query');
          queries.push(message); void pump();
        } else if (message.type === 'cancel') queries = queries.filter((q) => q.id !== message.id);
      } catch { port.postMessage({ type: 'index-error' }); }
    });
    port.postMessage({ type: 'ready' });
  } catch {
    try { database?.close(); await extractor?.dispose(); } catch { /* 失败信息不含私有输入 */ }
    port.postMessage({ type: 'failed' }); port.close();
  }
}

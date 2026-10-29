// 开发取证：只预热摘要匹配的公开文件，旁路观察真实向量调用，不改候选或结果。
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AdaptiveArchive } from '../../src/memory/adaptive-archive.ts';
import { createHash } from 'node:crypto';
import { verifyComponentFile } from '../../src/memory/adaptive-component.ts';
import { AdaptiveVectorRetriever, VECTOR_SPACE } from '../../src/memory/adaptive-vector.ts';
import { semanticDigest } from '../../src/memory/adaptive-query.ts';
import pin from '../../components/adaptive-retrieval/model.json' with { type: 'json' };
import lock from '../../components/adaptive-retrieval/package-lock.json' with { type: 'json' };

export async function seedPublicRetrievalCache(home: string, source: string) {
  const target = path.join(home, 'data/adaptive-retrieval');
  let npmBlobs = 0, npmBytes = 0;
  for (const entry of Object.values(lock.packages)) {
    if (!('integrity' in entry) || !entry.integrity.startsWith('sha512-')) continue;
    const expected = entry.integrity.slice(7), hex = Buffer.from(expected, 'base64').toString('hex');
    const relative = path.join('npm-cache/_cacache/content-v2/sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    let bytes: Buffer;
    try { bytes = await fs.readFile(path.join(source, relative)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (createHash('sha512').update(bytes).digest('base64') !== expected) throw new Error('evaluation-public-cache-invalid');
    await fs.mkdir(path.dirname(path.join(target, relative)), { recursive: true });
    await fs.writeFile(path.join(target, relative), bytes); npmBlobs++; npmBytes += bytes.length;
  }
  for (const file of pin.files) {
    const from = path.join(source, 'component/model', file.path), to = path.join(target, 'component/model', file.path);
    if (!await verifyComponentFile(from, file)) throw new Error('evaluation-public-model-invalid');
    await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to);
  }
  return { modelSpace: VECTOR_SPACE, modelFiles: pin.files.length, npmBlobs, npmBytes,
    nodeModulesCopied: false, markersCopied: false, source: 'fixed-public-content-hashes' };
}

export function observeRetrieval() {
  const original = AdaptiveVectorRetriever.prototype.query;
  const calls: { id: number; queryHash: string; start: number; elapsedMs?: number; keys?: string[]; state: string }[] = [];
  AdaptiveVectorRetriever.prototype.query = async function(query, signal) {
    const call = { id: calls.length + 1, queryHash: semanticDigest(query), start: Date.now(), state: 'running' } as typeof calls[number];
    calls.push(call); const started = performance.now();
    try { const result = await original.call(this, query, signal); call.keys = result?.keys; call.state = result ? 'neighbors' : 'fallback'; return result; }
    catch (error) { call.state = 'failed'; throw error; }
    finally { call.elapsedMs = performance.now() - started; }
  };
  return { calls, close: () => { AdaptiveVectorRetriever.prototype.query = original; } };
}

// 只在开发检查点枚举清单；生产维护仍逐批推进，不用此取证函数驱动索引。
export function retrievalInventory(archive: AdaptiveArchive, cache: string, agent: string) {
  const expected: { id: string; key: string }[] = [];
  let after = '';
  for (;;) {
    const page = archive.candidatePage(after);
    for (const entry of page.entries) if (entry.candidate) expected.push({ id: entry.id, key: entry.candidate.key });
    if (expected.length > 10000) throw new Error('evaluation-inventory-too-large');
    if (page.done) break;
    after = page.next;
  }
  let database: DatabaseSync | undefined;
  let observed: { id: string; key: string }[] | null = null, meta: any = null;
  try {
    database = new DatabaseSync(cache, { readOnly: true }); database.exec('BEGIN');
    meta = database.prepare('SELECT epoch,seq,hash,complete FROM vector_catalog_meta WHERE agent=? AND space=?').get(agent, VECTOR_SPACE) ?? null;
    observed = database.prepare('SELECT id,key FROM vector_catalog WHERE agent=? AND space=? ORDER BY id LIMIT 10001')
      .all(agent, VECTOR_SPACE).map((r) => ({ id: String(r.id), key: String(r.key) }));
    database.exec('COMMIT');
  } catch { observed = null; meta = null; }
  finally { database?.close(); }
  return { schema: 'candidate-inventory-v1', expected, observed, meta };
}

/** 旧档案保留原快照口径；新档案逐项比对独立读取的已落盘清单和当时有效候选。 */
export function retrievalSnapshotReady(state: any): boolean {
  const r = state.status?.retrieval;
  if (!r || r.state !== 'ready' || !r.current || r.pending !== 0 || r.failure || r.errors || r.blocked) return false;
  if (!Object.hasOwn(state, 'retrievalInventory')) return r.snapshot === state.retrievalExpected;
  const inventory = state.retrievalInventory;
  const valid = (rows: any): rows is { id: string; key: string }[] => Array.isArray(rows) && rows.length <= 10000
    && rows.every((x, i) => typeof x?.id === 'string' && x.id.length > 0 && /^[a-f0-9]{64}$/.test(x.key)
      && (!i || rows[i - 1].id < x.id));
  return inventory?.schema === 'candidate-inventory-v1' && valid(inventory.expected) && valid(inventory.observed)
    && semanticDigest(inventory.expected) === state.retrievalExpected
    && semanticDigest(inventory.expected) === semanticDigest(inventory.observed)
    && r.scanComplete === true && inventory.meta?.complete === 1 && inventory.meta.epoch === r.epoch
    && inventory.meta.seq === r.seq && inventory.meta.hash === r.snapshot && r.indexed === inventory.expected.length;
}

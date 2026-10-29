// 权威结果枚举与逐项核查；不把 SQLite 投影当作可覆盖权威文件的副本。
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ARTIFACT_ID, artifactDigest, parseArtifact, type MemoryArtifact } from './adaptive-artifact.ts';
import { publicationRoot, readPublication } from './adaptive-publication.ts';
import { semanticSchema, type SemanticRecord } from './adaptive-evidence.ts';

export function* archiveArtifacts(db: DatabaseSync, soul: string, agent: string): Generator<MemoryArtifact> {
  const seen = new Set<string>();
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
        const artifact = readPublication(soul, id, agent);
        if (semanticSchema(artifact.payload.schema)) { seen.add(id); yield artifact; }
      }
    } finally { dir.closeSync(); }
  }
  let count = 0;
  for (const row of db.prepare('SELECT id,document,digest,state,published,error FROM adaptive_publications').iterate()) {
    if (++count > 10000) throw new Error('认识发件箱核对超过工作上限');
    if (typeof row.document !== 'string' || typeof row.id !== 'string') throw new Error('认识发件箱格式不合法');
    const artifact = parseArtifact(row.document, agent);
    if (!semanticSchema(artifact.payload.schema)) continue;
    if (artifact.id !== row.id || artifactDigest(row.document) !== row.digest) throw new Error('认识发件箱完整性不符');
    if (exists && fs.existsSync(path.join(publicationRoot(soul), `${row.id}.md`))) {
      if (artifactDigest(JSON.stringify(readPublication(soul, row.id, agent))) !== row.digest)
        throw new Error('认识文件与已接受结果不同');
      // 文件可在目录枚举之后、发件箱核查之前完成原子发布。
      if (!seen.has(String(row.id))) yield artifact;
    } else {
      if (row.published !== null || row.state === 'published' || row.state === 'written' || row.error === 'conflict') throw new Error('已交付认识文件缺失');
      yield artifact;
    }
  }
}

/** 只缓存一次同步读取内的小批文件；权限和来源状态仍由调用者即时核对。 */
export function recordAuthority(db: DatabaseSync, soul: string, agent: string) {
  const cache = new Map<string, MemoryArtifact>();
  return (record: SemanticRecord) => {
    const row = db.prepare(`SELECT r.document,r.artifact,b.digest FROM adaptive_graph_records r
      JOIN adaptive_graph_batches b ON b.artifact=r.artifact WHERE r.id=? AND r.revision=?`).get(record.id, record.revision);
    if (!row || row.document !== JSON.stringify(record)) throw new Error('认识记录与版本投影不符');
    const id = String(row.artifact);
    let artifact = cache.get(id);
    if (!artifact) {
      const outbox = db.prepare('SELECT document,digest,state,published,error FROM adaptive_publications WHERE id=?').get(id);
      if (outbox && (typeof outbox.document !== 'string' || artifactDigest(outbox.document) !== outbox.digest || outbox.digest !== row.digest))
        throw new Error('认识发件箱完整性不符');
      try { artifact = readPublication(soul, id, agent); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!outbox || outbox.published !== null || outbox.state === 'written' || outbox.state === 'published' || outbox.error === 'conflict')
          throw new Error('已交付认识文件缺失');
        artifact = parseArtifact(String(outbox.document), agent);
      }
      if (artifact.id !== id || artifactDigest(JSON.stringify(artifact)) !== row.digest || !semanticSchema(artifact.payload.schema))
        throw new Error('认识记录与权威结果不符');
      if (cache.size >= 16) cache.delete(cache.keys().next().value!);
      cache.set(id, artifact);
    }
    const records = (artifact.payload.data as { records: SemanticRecord[] }).records;
    if (!records.some((r) => r.id === record.id && r.revision === record.revision && JSON.stringify(r) === row.document))
      throw new Error('认识正文不属于权威结果');
  };
}

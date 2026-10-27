// 查询基准的公开合成负载；每个文件一条独立认识，不调用模型。
import crypto from 'node:crypto';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';
import { ARTIFACT_FORMAT, artifactDigest, type MemoryArtifact } from '../src/memory/adaptive-artifact.ts';
import { installPublication } from '../src/memory/adaptive-publication.ts';
import { SEMANTIC_SCHEMA, type ClaimRecord } from '../src/memory/adaptive-evidence.ts';

export function seedReadWorkload(queue: AdaptiveStore, soul: string, size: number) {
  let bytes = 0, firstFile = '';
  for (let i = 1; i <= size; i++) {
    const text = `港口采风合成线索 ${i}`;
    queue.db.prepare("INSERT INTO messages(id,ts,role,channel,text,session,body,via,mode,attachments) VALUES(?,?,'user','synthetic',?,'synthetic','reader',NULL,NULL,NULL)").run(i, i * 1000, text);
    const source = queue.source(i)!, span = { kind: 'source' as const, source: i, hash: source.hash, start: 0, end: text.length, quote: text };
    const claim: ClaimRecord = { id: crypto.randomUUID(), revision: 1, kind: 'claim', state: 'present', realm: { world: 'real', context: 'real' },
      reasons: [span], text, nature: 'reported', participants: [], occurred: { text: '', earliest: null, latest: null },
      valid: { text: '', earliest: null, latest: null }, supports: [{ id: 'direct', premises: [span], assumptions: [] }], counters: [] };
    const artifact: MemoryArtifact = { format: ARTIFACT_FORMAT, id: crypto.randomUUID(), agent: queue.agent, processor: 'synthetic-benchmark', createdAt: i,
      inputs: [{ id: i, revision: source.revision, hash: source.hash }], payload: { schema: SEMANTIC_SCHEMA, data: { baseGeneration: i - 1, records: [claim] } } };
    const document = JSON.stringify(artifact); bytes += Buffer.byteLength(document);
    const file = installPublication(soul, queue.agent, { id: artifact.id, document, digest: artifactDigest(document), attempts: 0 });
    if (i === 1) firstFile = file;
  }
  return { bytes, firstFile };
}

// 开发取证：只预热摘要匹配的公开文件，旁路观察真实向量调用，不改候选或结果。
import fs from 'node:fs/promises';
import path from 'node:path';
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

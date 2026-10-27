// 记忆读取工具的本机凭据：只记录来源标识与摘要，不把资料或凭据写进灵魂。
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import type { SourceReading } from './adaptive-reading.ts';

export const MEMORY_READ_TOOLS = new Set(['recall', 'note_read', 'memory_records', 'context_read']);
export const readDigest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
export interface ReadDocument { kind: 'note' | 'record' | 'document' | 'message' | 'tool' | 'context'; key: string; hash: string }
export interface ReadReceipt {
  version: 1; agent: string; body: string; conv: string; tool: string; resultHash: string; checked: boolean;
  sources: { id: number; hash: string | null }[]; documents: ReadDocument[];
}
interface Capture { checked: boolean; invalid: boolean; sources: Map<number, string | null>; documents: Map<string, ReadDocument> }
const captures = new AsyncLocalStorage<Capture>();
export function observeReadSources(view: SourceReading): void {
  const capture = captures.getStore(); if (!capture) return;
  capture.checked = true;
  for (const source of view.sources) {
    const hash = source.hash ?? null;
    if (capture.sources.has(source.id) && capture.sources.get(source.id) !== hash) capture.invalid = true;
    if (capture.sources.size >= 1000 && !capture.sources.has(source.id)) { capture.invalid = true; continue; }
    capture.sources.set(source.id, hash);
  }
}
export function observeReadDocument(kind: ReadDocument['kind'], key: string, value: unknown): void {
  const capture = captures.getStore(); if (!capture) return;
  const id = JSON.stringify([kind, key]), hash = readDigest(value), previous = capture.documents.get(id);
  if (previous && previous.hash !== hash) capture.invalid = true;
  if (capture.documents.size >= 200 && !previous) { capture.invalid = true; return; }
  capture.documents.set(id, { kind, key, hash });
}
export async function captureMemoryRead<T extends { text: string; status: string }>(
  scope: Pick<ReadReceipt, 'agent' | 'body' | 'conv' | 'tool'>, run: () => Promise<T>,
): Promise<T & { reading?: ReadReceipt }> {
  if (!MEMORY_READ_TOOLS.has(scope.tool)) return run();
  const capture: Capture = { checked: false, invalid: false, sources: new Map(), documents: new Map() };
  return captures.run(capture, async () => {
    const result = await run();
    if (result.status !== 'ok') return result;
    return { ...result, reading: { version: 1, ...scope, resultHash: readDigest(result.text), checked: capture.checked && !capture.invalid,
      sources: [...capture.sources].map(([id, hash]) => ({ id, hash })), documents: [...capture.documents.values()] } };
  });
}
export function parseReadReceipt(value: unknown): ReadReceipt {
  const r = value as ReadReceipt, hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const fail = () => { throw new Error('工具来源凭据损坏，不能使用缓存正文'); };
  if (!r || typeof r !== 'object' || r.version !== 1 || ![r.agent, r.body, r.conv, r.tool].every((v) => typeof v === 'string' && v.length <= 2000) ||
      !MEMORY_READ_TOOLS.has(r.tool) || !hash(r.resultHash) || typeof r.checked !== 'boolean' ||
      !Array.isArray(r.sources) || r.sources.length > 1000 || !Array.isArray(r.documents) || r.documents.length > 200) fail();
  if (r.sources.some((s) => !s || !Number.isSafeInteger(s.id) || s.id <= 0 || !(s.hash === null || hash(s.hash))) || new Set(r.sources.map((s) => s.id)).size !== r.sources.length) fail();
  if (r.documents.some((d) => !d || !['note', 'record', 'document', 'message', 'tool', 'context'].includes(d.kind) || typeof d.key !== 'string' || d.key.length > 2000 || !hash(d.hash))) fail();
  if (new Set(r.documents.map((d) => JSON.stringify([d.kind, d.key]))).size !== r.documents.length) fail();
  return r;
}

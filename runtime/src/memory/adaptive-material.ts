// 旧结构化记忆保留原审核与正文；当前读取状态单独计算，不能把 active/verified 当成新证据。
import fs from 'node:fs';
import { observeReadDocument } from './read-receipt.ts';
import path from 'node:path';
import { memoryKey, validateMemoryRecord, type MemoryRecord } from '../../../engine/src/memory.ts';
import { readStructuredRecords, readLegacyRecords } from './structured.ts';
import { withAdaptiveSources, adaptiveReadingRequired } from './adaptive.ts';
import { sourceReadingHeader, type SourceReading } from './adaptive-reading.ts';
import { readNote, notePath } from './memory.ts';
import { artifactFormat, parseArtifact, type MemoryArtifact } from './adaptive-artifact.ts';
import { readPublication } from './adaptive-publication.ts';
import { identity } from './identity.ts';
import { paths } from '../config.ts';

export const materialSources = (record: MemoryRecord): number[] => [...new Set(record.evidence.flatMap((e) => {
  const match = /^message:([1-9]\d*)$/.exec(e.ref), id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) ? [id] : [];
}))];

export interface MaterialView {
  key: string; kind: MemoryRecord['kind']; state: MemoryRecord['state']; scope: MemoryRecord['scope'];
  text?: string; evidence?: MemoryRecord['evidence']; validation: MemoryRecord['validation'];
  reading?: { status: 'historical' | 'unverifiable' | 'unavailable'; generation: number; freshness: 'local-snapshot';
    sources: SourceReading['sources']; explanation: string };
}

export function materialView(record: MemoryRecord, view: SourceReading | null): MaterialView {
  const base = { key: memoryKey(record), kind: record.kind, state: record.state, scope: record.scope, validation: record.validation };
  if (!view) return { ...base, text: record.text, evidence: record.evidence };
  const ids = materialSources(record), sources = ids.map((id) => view.sources.find((s) => s.id === id));
  const unavailable = sources.some((s) => !s?.hash);
  const reading: NonNullable<MaterialView['reading']> = {
    status: unavailable ? 'unavailable' : ids.length ? 'historical' : 'unverifiable', generation: view.generation, freshness: view.freshness,
    sources: sources.filter((s): s is SourceReading['sources'][number] => !!s),
    explanation: 'state/validation 是旧记忆当时的审核记录，不代表当前依据成立。旧格式未保存精确来源版本，不能据当前消息仍存在就恢复其结论；修订只针对指定认识，不机械撤回同段其他内容。',
  };
  // 没有逐句来源映射，不能证明正文哪一段独立于不可访问证据；保留管理元数据，不返回派生正文或旧引语。
  if (unavailable) return { ...base, reading };
  return { ...base, text: record.text, evidence: record.evidence, reading };
}

/** 候选在锁前取得，返回时重核文件；变化交给调用者重新选择，不沿用旧副本。 */
export function checkMaterialVersions(records: MemoryRecord[]): void {
  if (!records.length) return;
  const current = new Map(readStructuredRecords().map((r) => [memoryKey(r), r]));
  // 不能凭 legacy_ 名字跳过核查：受管 id 也允许这个前缀。
  if (records.some((r) => !current.has(memoryKey(r)))) for (const record of readLegacyRecords())
    if (!current.has(memoryKey(record))) current.set(memoryKey(record), record);
  for (const record of records) {
    if (JSON.stringify(current.get(memoryKey(record))) !== JSON.stringify(record)) throw new Error('旧记忆候选版本已改变，请重新读取');
    observeReadDocument('record', memoryKey(record), record);
  }
}

export function materialContext(record: MemoryRecord, view: SourceReading | null): string | undefined {
  const projected = materialView(record, view);
  if (!view) return record.text;
  if (projected.reading?.status === 'unavailable') return undefined;
  const headers = materialSources(record).map((id) => sourceReadingHeader(view, id)).join('') || sourceReadingHeader(view);
  return `【旧记忆档案；原审核状态不作当前事实确认】${projected.reading!.explanation}\n${headers}${record.text}`;
}

export async function readMaterialViews(records: MemoryRecord[], signal?: AbortSignal): Promise<MaterialView[]> {
  return withAdaptiveSources([...new Set(records.flatMap(materialSources))], (view) => {
    if (view) checkMaterialVersions(records);
    const result = records.map((record) => materialView(record, view));
    if (view && Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw new Error('旧记忆修订结果超过工作上限');
    return result;
  }, signal);
}

export class MaterialAccessDenied extends Error {}
export interface NoteReading {
  sources: number[];
  render(view: SourceReading, options?: { excerpt?: string; omitUnavailable?: boolean }): string | undefined;
}

/** 锁前只准备候选；render 必须在 withAdaptiveSources 的快照 / 灵魂锁中调用。 */
export function prepareNoteReading(name: string, allowed: (record: MemoryRecord) => boolean, expectedText?: string): NoteReading {
  const text = readNote(name);
  if (!text || expectedText !== undefined && text !== expectedText) throw new Error('笔记候选已改变或不存在，请重新读取');
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('笔记修订读取超过工作上限');
  const normalized = notePath(name), actual = fs.realpathSync.native(path.join(paths.soul, 'notes', `${normalized}.md`));
  const root = path.join(paths.soul, 'notes', 'QuetzalMemory');
  const realRoot = fs.existsSync(root) ? fs.realpathSync.native(root).toLowerCase() + path.sep : '';
  const managed = normalized.split('/')[0].toLowerCase() === 'quetzalmemory' || !!realRoot && actual.toLowerCase().startsWith(realRoot);
  let record: MemoryRecord | undefined, artifact: MemoryArtifact | undefined;
  const json = /\n```json\s*\n([\s\S]+?)\n```(?:\n|$)/.exec(text);
  let parsed: any;
  try { if (json) parsed = JSON.parse(json[1]); } catch { if (managed) throw new Error('受管笔记格式不合法，不能作为普通资料读取'); }
  if (parsed?.format === 'quetzal-memory-v1' && (managed || readStructuredRecords().some((r) => JSON.stringify(r) === JSON.stringify(parsed.record)))) {
    validateMemoryRecord(parsed.record); record = parsed.record;
    if (!allowed(record!)) throw new MaterialAccessDenied('记忆版本不属于当前Agent、用户或会话范围');
  } else if (artifactFormat(parsed?.format) && managed) artifact = parseArtifact(json![1], identity().id);
  else if (managed) throw new Error('受管笔记格式未知，不能作为普通资料读取');
  const ids = record ? materialSources(record) : artifact ? artifact.inputs.map((input) => input.id) : [];
  return { sources: ids, render(view, options = {}) {
    if (readNote(name) !== text) throw new Error('笔记在读取期间已改变，请重新读取');
    observeReadDocument('note', normalized, text);
    let result: string;
    if (record) {
      checkMaterialVersions([record]);
      const projected = materialView(record, view);
      if (options.omitUnavailable && projected.reading?.status === 'unavailable') return undefined;
      result = JSON.stringify(projected);
    } else if (artifact) {
      if (JSON.stringify(readPublication(paths.soul, artifact.id, identity().id)) !== JSON.stringify(artifact))
        throw new Error('笔记与权威记忆存档不一致');
      // 批次没有逐句访问映射，任一输入不可访问时不输出整个历史 payload。
      if (ids.some((id) => !view.sources.find((s) => s.id === id)?.hash))
        return options.omitUnavailable ? undefined : `【历史处理存档 ${artifact.id} 的来源不可访问；不返回旧 payload。本机快照 generation=${view.generation}，不保证中心最新。】`;
      result = ids.map((id) => sourceReadingHeader(view, id)).join('') + text;
    } else result = sourceReadingHeader(view) + (options.excerpt ?? text);
    if (Buffer.byteLength(result) > 512 * 1024) throw new Error('笔记修订结果超过工作上限');
    return result;
  } };
}

/** 读到受管记录时走同一来源门禁；普通 Markdown 不靠正文关键词伪造出处。 */
export async function readAdaptiveNote(name: string, allowed: (record: MemoryRecord) => boolean, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!adaptiveReadingRequired()) return readNote(name);
  if (!readNote(name)) return '';
  const prepared = prepareNoteReading(name, allowed);
  return withAdaptiveSources(prepared.sources, (view) => {
    if (!view) throw new Error('笔记修订状态在读取期间已改变');
    return prepared.render(view)!;
  }, signal);
}

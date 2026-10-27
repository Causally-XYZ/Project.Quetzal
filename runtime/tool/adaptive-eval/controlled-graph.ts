// AM-07 的受控输入适配器。通过正式存档接受版本；不把构图记为模型推理成绩。
import crypto from 'node:crypto';
import type { AdaptiveArchive } from '../../src/memory/adaptive-archive.ts';
import type { AdaptiveStore } from '../../src/memory/adaptive-store.ts';
import { directSpans, type ClaimRecord, type SourceSpan, type RecordRef } from '../../src/memory/adaptive-evidence.ts';
import { SEMANTIC_PROCESSOR } from '../../src/memory/adaptive-worker.ts';
import type { Step } from './spec.ts';

const labels = ['A', 'B', 'C', 'K', 'L'] as const;
type Label = typeof labels[number];
export class ControlledGraph {
  private ids?: Record<Label, string>;
  private withdrawn: ('A' | 'C')[] = [];
  readonly queue: AdaptiveStore;
  readonly archive: AdaptiveArchive;
  constructor(queue: AdaptiveStore, archive: AdaptiveArchive) { this.queue = queue; this.archive = archive; }

  snapshot() {
    if (!this.ids) return null;
    const records = this.archive.current(), states = this.archive.assess();
    return Object.fromEntries(labels.map((label) => { const id = this.ids![label];
      return [label, { id, record: records.find((r) => r.id === id), evidence: states.get(id), history: this.archive.history(id) }]; }));
  }

  /** 调用者必须先暂停空闲后台，并在灵魂 exclusive 内执行。每条控制消息仍有正常语义处理回执。 */
  apply(sourceId: number, operation?: Step['operation']) {
    if (!Number.isSafeInteger(sourceId) || sourceId < 1) throw new Error('受控来源不合法');
    const target = operation?.target;
    if (!this.ids ? operation !== undefined : !operation || operation.type !== 'withdraw-premise'
      || target !== (this.withdrawn.length === 0 ? 'A' : this.withdrawn.length === 1 ? 'C' : null)) throw new Error('受控步骤顺序不合法');
    if (!this.ids && this.archive.current().length) throw new Error('受控图必须从空存档开始');
    if (!this.queue.scheduleSource(SEMANTIC_PROCESSOR, sourceId)) throw new Error('受控来源已被处理');
    const job = this.queue.claim(SEMANTIC_PROCESSOR, Date.now(), 300000);
    if (!job || job.source !== sourceId) throw new Error('受控来源被其他工作抢占');
    const source = this.queue.source(sourceId, job.revision);
    if (!source || source.role !== 'user') throw new Error('受控输入必须为可读用户来源');
    const quote: SourceSpan = { kind: 'source', source: source.id, hash: source.hash, start: 0, end: source.text.length, quote: source.text };
    const before = this.snapshot();
    let records: ClaimRecord[], ids = this.ids;
    if (!ids) {
      const event = /K (?:表示|指)([^，。]+)/u.exec(source.text)?.[1];
      if (!event) throw new Error('受控声明缺少 K 的含义');
      ids = Object.fromEntries(labels.map((label) => [label, crypto.randomUUID()])) as Record<Label, string>;
      const ref = (label: Label): RecordRef => ({ kind: 'claim', id: ids![label], revision: 1 });
      const base = (label: Label, text: string): ClaimRecord => ({ id: ids![label], kind: 'claim', revision: 1, state: 'present',
        realm: { world: 'real', context: 'real' }, reasons: [quote], text, nature: 'reported', participants: [],
        occurred: { text: '', earliest: null, latest: null }, valid: { text: '', earliest: null, latest: null },
        supports: [{ id: 'direct', premises: [quote], assumptions: [] }], counters: [] });
      const a = base('A', '合成依据 A'), b = base('B', '合成依据 B'), c = base('C', '合成依据 C');
      const k = base('K', `受控结论 K：${event}`), l = base('L', '独立结论 L');
      a.supports.push({ id: 'cycle', premises: [ref('K')], assumptions: [] });
      k.nature = 'inferred';
      k.supports = [{ id: 'G1', premises: [ref('A'), ref('B')], assumptions: [] }, { id: 'G2', premises: [ref('C')], assumptions: [] }];
      records = [a, b, c, k, l];
    } else {
      const old = this.archive.current().find((r) => r.id === ids![target!]);
      if (old?.kind !== 'claim' || old.state !== 'present') throw new Error('受控依据已不在预期状态');
      records = [{ ...old, revision: old.revision + 1, state: 'withdrawn', reasons: [quote] }];
    }
    // 包含原版本直接引用的来源；撤回不改写原文、不重写 K / L、不产生新独立证明。
    const sourceIds = new Set([sourceId, ...records.flatMap(directSpans).map((s) => s.source)]);
    const inputs = [...sourceIds].map((id) => { const s = this.queue.source(id); if (!s) throw new Error('受控依据缺失');
      return { id, revision: s.revision, hash: s.hash }; });
    const batch = { baseGeneration: this.archive.generation(), records };
    if (!this.archive.accept(job, inputs, batch)) throw new Error('受控存档接受失败');
    this.ids = ids; if (target) this.withdrawn.push(target);
    return { kind: operation ? 'withdraw-claim-version' : 'seed-and-or-graph', source: sourceId, artifact: job.id, inputs, batch,
      before, after: this.snapshot(), modelGenerated: false };
  }
}

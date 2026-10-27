// 增量整合的内部后台处理器；现有消息任务、灵魂锁、来源 / 代次门禁和发件箱保持同一权威。
import { AdaptiveStore, type MemoryJob, type MemorySource } from './adaptive-store.ts';
import { AdaptiveArchive } from './adaptive-archive.ts';
import { directSpans, recordRefs } from './adaptive-evidence.ts';
import { normalizeProposal, proposalPrompt, type ProposalContext } from './adaptive-proposal.ts';
import { boundedProposal } from './adaptive-model.ts';

export const SEMANTIC_PROCESSOR = 'semantic-v1';
export type SemanticWorkResult = { status: 'idle' | 'deferred' | 'revised' | 'unchanged' | 'stale' | 'failed'; source?: number };
export async function processSemanticNext(options: {
  queue: AdaptiveStore; archive: AdaptiveArchive;
  generate: (prompt: ReturnType<typeof proposalPrompt>, signal: AbortSignal) => Promise<unknown>;
  exclusive: <T>(run: () => T) => Promise<T>; enabled: () => boolean;
  signal: AbortSignal; timeoutMs?: number; claimed?: (job: MemoryJob) => void;
}): Promise<SemanticWorkResult> {
  const { queue, archive, exclusive, enabled, signal } = options;
  if (!enabled() || signal.aborted) return { status: 'deferred' };
  const prepared = await exclusive(() => {
    if (!enabled() || signal.aborted) return { status: 'deferred' as const };
    queue.schedule(SEMANTIC_PROCESSOR);
    const job = queue.claim(SEMANTIC_PROCESSOR, Date.now(), 300_000);
    if (!job) return { status: 'idle' as const };
    try {
      const current = queue.source(job.source, job.revision);
      if (!current) { queue.fail(job, 'interrupted'); return { status: 'stale' as const }; }
      // 助手复述不作为新用户证据；来源观察仍由 M1 单独处理。
      if (current.role === 'agent') { queue.complete(job); return { status: 'unchanged' as const, source: job.source }; }
      const generation = archive.generation(), all = archive.current();
      if (all.length > 1000) throw new Error('认识整合上下文超过当前工作上限');
      const cache = new Map<number, MemorySource | undefined>();
      const read = (id: number) => { if (!cache.has(id)) cache.set(id, queue.source(id)); return cache.get(id); };
      // 不将已忽略 / 删除来源的派生文字重新送给模型；按 ID 传播，旧引用也不能绕开过滤。
      const known = new Set(all.map((r) => r.id)), hidden = new Set<string>(), parents = new Map<string, string[]>();
      let work = 0;
      for (const r of all) {
        for (const s of directSpans(r)) {
          if (++work > 100_000) throw new Error('认识整合上下文超过当前工作上限');
          if (!read(s.source) || read(s.source)!.role === 'agent') hidden.add(r.id);
        }
        for (const ref of recordRefs(r)) {
          if (++work > 100_000) throw new Error('认识整合上下文超过当前工作上限');
          if (!known.has(ref.id)) hidden.add(r.id);
          const dependents = parents.get(ref.id) ?? []; dependents.push(r.id); parents.set(ref.id, dependents);
        }
      }
      const pending = [...hidden];
      for (let i = 0; i < pending.length; i++) for (const id of parents.get(pending[i]) ?? []) {
        if (!hidden.has(id)) { hidden.add(id); pending.push(id); }
      }
      const records = all.filter((r) => !hidden.has(r.id));
      const spans = records.flatMap(directSpans), knownHashes = new Set(spans.map((s) => `${s.source}:${s.hash}`));
      const ids = new Set([job.source, ...spans.map((s) => s.source)]);
      if (ids.size > 100) throw new Error('认识整合上下文超过当前工作上限');
      // 只补入已经由本处理器完成的过去输入；不把未处理的未来检查点提前泄漏给模型。
      const previous = queue.db.prepare(`SELECT m.id FROM messages m JOIN adaptive_receipts r ON r.source=m.id
        JOIN adaptive_sources s ON s.source=m.id AND s.revision=r.revision
        WHERE r.processor=? ORDER BY r.completed DESC,m.id DESC LIMIT 100`).all(SEMANTIC_PROCESSOR);
      for (const r of previous) { if (ids.size >= 100) break; ids.add(Number(r.id)); }
      const processed = new Set(previous.map((r) => Number(r.id)));
      const sources = [...ids].sort((a, b) => a - b).flatMap((id) => {
        const s = read(id);
        // 别条消息尚未处理的新修订不能提前进入本检查点；旧引文由提案层标记 unavailable。
        return s && s.role !== 'agent' && (id === job.source || processed.has(id) || knownHashes.has(`${id}:${s.hash}`)) ? [s] : [];
      });
      const context: ProposalContext = { generation, records, sources, current: job.source };
      const prompt = proposalPrompt(context);
      if (Buffer.byteLength(JSON.stringify(prompt)) > 256 * 1024) throw new Error('认识整合上下文超过当前工作上限');
      return { job, context, prompt };
    } catch {
      queue.fail(job, 'processor_failed'); return { status: 'failed' as const, source: job.source };
    }
  });
  if ('status' in prepared) return { status: prepared.status!, source: prepared.source };
  const { job, context, prompt } = prepared;
  options.claimed?.(job);
  try {
    const proposal = await boundedProposal((timed) => {
      if (!enabled()) throw new Error('记忆整合停止');
      return options.generate(prompt, timed);
    }, signal, options.timeoutMs);
    const batch = normalizeProposal(proposal, context);
    return await exclusive(() => {
      if (!enabled() || signal.aborted) { queue.fail(job, 'interrupted'); return { status: 'deferred', source: job.source }; }
      const inputs = context.sources.map((s) => ({ id: s.id, revision: s.revision, hash: s.hash }));
      const ok = batch ? archive.accept(job, inputs, batch) : archive.complete(job, inputs, context.generation);
      if (!ok) queue.fail(job, 'interrupted');
      return { status: ok ? batch ? 'revised' : 'unchanged' : 'stale', source: job.source };
    });
  } catch {
    return await exclusive(() => {
      queue.fail(job, signal.aborted || !enabled() ? 'interrupted' : 'processor_failed');
      return { status: signal.aborted || !enabled() ? 'deferred' : 'failed', source: job.source };
    });
  }
}

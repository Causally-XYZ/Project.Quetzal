// 增量整合的内部后台处理器；现有消息任务、灵魂锁、来源 / 代次门禁和发件箱保持同一权威。
import { AdaptiveStore, type MemoryJob } from './adaptive-store.ts';
import { AdaptiveArchive } from './adaptive-archive.ts';
import { directSpans } from './adaptive-evidence.ts';
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
      const generation = archive.generation(), records = archive.current();
      const ids = new Set([job.source, ...records.flatMap((r) => directSpans(r).map((s) => s.source))]);
      if (records.length > 1000 || ids.size > 100) throw new Error('认识整合上下文超过当前工作上限');
      // 只补入已经由本处理器完成的过去输入；不把未处理的未来检查点提前泄漏给模型。
      const previous = queue.db.prepare(`SELECT m.id FROM messages m JOIN adaptive_receipts r ON r.source=m.id
        WHERE r.processor=? ORDER BY r.completed DESC,m.id DESC LIMIT 100`).all(SEMANTIC_PROCESSOR);
      for (const r of previous) { if (ids.size >= 100) break; ids.add(Number(r.id)); }
      const sources = [...ids].sort((a, b) => a - b).flatMap((id) => { const s = queue.source(id); return s ? [s] : []; });
      if (sources.length !== ids.size || records.some((r) => directSpans(r).some((s) => sources.find((x) => x.id === s.source)?.hash !== s.hash)))
        throw new Error('认识整合需要先处理失效来源');
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

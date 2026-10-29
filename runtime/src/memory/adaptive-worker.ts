// 增量整合的内部后台处理器；现有消息任务、灵魂锁、来源 / 代次门禁和发件箱保持同一权威。
import { AdaptiveStore, type MemoryJob, type MemorySource } from './adaptive-store.ts';
import { AdaptiveArchive } from './adaptive-archive.ts';
import { integrationWorkset } from './adaptive-workset.ts';
import { normalizeProposal, proposalPrompt } from './adaptive-proposal.ts';
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
      const cache = new Map<number, MemorySource | undefined>();
      const read = (id: number) => { if (!cache.has(id)) cache.set(id, queue.source(id)); return cache.get(id); };
      // 只查已处理历史的有限游标，不把尚未处理的新修订作为既有事实。
      const previous = queue.db.prepare(`SELECT m.id FROM messages m JOIN adaptive_receipts r ON r.source=m.id
        JOIN adaptive_sources s ON s.source=m.id AND s.revision=r.revision
        WHERE r.processor=? ORDER BY r.completed DESC,m.id DESC LIMIT 100`).all(SEMANTIC_PROCESSOR).map((r) => Number(r.id));
      const { context, prompt } = archive.readLocal((lookup, generation) => integrationWorkset({ lookup, generation, current, read, previous }));
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

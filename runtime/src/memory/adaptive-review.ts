// 从仍引用旧版本的记录重建待重评工作；队列是派生状态，认识和依据仍由存档负责。
import crypto from 'node:crypto';
import { AdaptiveStore, type MemoryJob } from './adaptive-store.ts';
import { AdaptiveArchive } from './adaptive-archive.ts';
import { directSpans, recordRefs, type SemanticRecord } from './adaptive-evidence.ts';
import { normalizeProposal, proposalPrompt, type ProposalContext } from './adaptive-proposal.ts';

export interface ReviewPlan {
  processor: string; target: string; context: ProposalContext; prompt: ReturnType<typeof proposalPrompt>;
}
export type ReviewResult = { status: 'idle' | 'deferred' | 'cancelled' | 'failed' | 'stale' | 'revised' | 'unchanged'; target?: string };

/** 当前版本依赖闭包足以重建任务键；不以整图 generation 生成新任务，避免无关发言触发反复重评。
 * 此原型至多扫描 1000 条当前记录、100 个闭包记录 / 来源；超限显式延后，不截掉必要前提。
 */
export function reviewPlans(archive: AdaptiveArchive, queue: AdaptiveStore): { plans: ReviewPlan[]; deferred: number } {
  const generation = archive.generation(), records = archive.current();
  if (records.length > 1000) return { plans: [], deferred: records.length };
  const current = new Map(records.map((r) => [r.id, r])), plans: ReviewPlan[] = [];
  let deferred = 0;
  for (const target of records) {
    if (target.state === 'withdrawn') continue;
    const stale = recordRefs(target).filter((ref) => {
      const r = current.get(ref.id);
      return !r || r.kind !== ref.kind || r.revision !== ref.revision || r.state === 'withdrawn';
    });
    if (!stale.length) continue;
    const closure = new Map<string, SemanticRecord>(), pending = [target];
    let missing = false;
    for (let i = 0; i < pending.length; i++) {
      const r = pending[i]; if (closure.has(r.id)) continue;
      closure.set(r.id, r);
      if (closure.size > 100) { missing = true; break; }
      for (const ref of recordRefs(r)) {
        const dependency = current.get(ref.id);
        if (!dependency || dependency.kind !== ref.kind) { missing = true; continue; }
        if (!closure.has(dependency.id)) pending.push(dependency);
      }
    }
    const selected = [...closure.values()].sort((a, b) => a.id.localeCompare(b.id));
    const sourceIds = [...new Set(selected.flatMap((r) => directSpans(r).map((s) => s.source)))].sort((a, b) => a - b);
    const sources = sourceIds.flatMap((id) => { const s = queue.source(id); return s ? [s] : []; });
    // 失效来源需要上游整合重新解释，不能给旧引文贴上新 hash 后交给模型修复。
    if (missing || sources.length !== sourceIds.length || sources.length > 100 || selected.some((r) => directSpans(r).some((s) =>
      sources.find((source) => source.id === s.source)?.hash !== s.hash))) { deferred++; continue; }
    const causeIds = new Set(stale.flatMap((ref) => current.get(ref.id)?.reasons.map((s) => s.source) ?? []));
    const cause = sources.filter((s) => causeIds.has(s.id)).sort((a, b) => b.ts - a.ts || b.id - a.id)[0];
    if (!cause) { deferred++; continue; }
    const context: ProposalContext = { generation, current: cause.id, records: selected, sources };
    const targetKey = `r${selected.findIndex((r) => r.id === target.id) + 1}`;
    const prompt = proposalPrompt(context);
    prompt.system += `\nThis is a DEPENDENCY REVIEW, overriding the current-message extraction task above.
Review only the specified target against original sources AND the newer dependency versions. The current source is a scheduling anchor, not a new message to extract.
The target is not automatically false: another independent support group may still suffice. Do not mechanically replace references or preserve a causal conclusion without fresh justification.
You may revise the target or introduce necessary new records. Do not revise other existing records. Never undo an accepted correction using its superseded source alone.
Return an empty patch if the evidence is insufficient to make a justified change; the target will retain its existing evidence status. Do not mark a record supported or verified yourself.
The host lists newer dependency handles as review candidates, not equivalent identities or proof. Withdrawn dependencies cannot be reused as current support.\n`;
    const data = JSON.parse(prompt.user);
    data.review = { target: targetKey, dependencies: stale.map((ref) => ({
      previous: { kind: ref.kind, revision: ref.revision },
      current: `r${selected.findIndex((r) => r.id === ref.id) + 1}`,
    })) };
    prompt.user = JSON.stringify(data);
    const digest = crypto.createHash('sha256').update(JSON.stringify({ target: target.id, records: selected,
      sources: sources.map((s) => [s.id, s.revision, s.hash]), cause: cause.id })).digest('hex');
    plans.push({ processor: `review-${digest.slice(0, 56)}`, target: target.id, context, prompt });
  }
  return { plans, deferred };
}

/** 调用者在与灵魂同步互斥的锁内提供 exclusive；模型调用期间释放锁。
 * 当前为内部开发入口，生产调度与模型路由接线另行验收。
 */
export async function reviewNext(options: {
  archive: AdaptiveArchive; queue: AdaptiveStore;
  generate: (prompt: ReturnType<typeof proposalPrompt>, signal: AbortSignal) => Promise<unknown>;
  exclusive: <T>(run: () => T) => Promise<T>;
  enabled: () => boolean;
  signal?: AbortSignal; timeoutMs?: number;
  claimed?: (job: MemoryJob) => void;
}): Promise<ReviewResult> {
  const { archive, queue, exclusive, enabled } = options;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 150_000) throw new Error('认识重评超时参数不合法');
  if (options.signal?.aborted) return { status: 'cancelled' };
  if (!enabled()) return { status: 'deferred' };
  const selected = await exclusive(() => {
    if (!enabled() || options.signal?.aborted) return { unavailable: 'deferred' as const };
    const discovered = reviewPlans(archive, queue);
    let unavailable: 'idle' | 'deferred' | 'failed' = discovered.deferred ? 'deferred' : 'idle';
    for (const plan of discovered.plans) {
      queue.scheduleSource(plan.processor, plan.context.current);
      const job = queue.claim(plan.processor, Date.now(), 300_000);
      if (job) return { plan, job, unavailable };
      const counts = queue.status(plan.processor).counts;
      if (counts.failed) unavailable = 'failed';
      else if (unavailable !== 'failed' && (counts.queued || counts.running)) unavailable = 'deferred';
    }
    return { unavailable };
  });
  if (!('plan' in selected) || !selected.plan || !selected.job) return { status: options.signal?.aborted ? 'cancelled' : selected.unavailable };
  const { plan, job } = selected, controller = new AbortController();
  options.claimed?.(job);
  let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined;
  try {
    // 即使供应商忽略 AbortSignal，超时 / 用户取消也不再等待或安装迟到响应。
    const interrupted = new Promise<never>((_, reject) => {
      const stop = (reason: string) => { controller.abort(); reject(new Error(reason)); };
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      cancel = () => stop('cancelled');
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
    });
    const proposal = await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      if (!enabled()) throw new Error('disabled');
      return options.generate(plan.prompt, controller.signal);
    }), interrupted]);
    const batch = normalizeProposal(proposal, plan.context);
    const existing = new Set(plan.context.records.map((r) => r.id));
    if (batch && (!batch.records.some((r) => r.id === plan.target) || batch.records.some((r) => existing.has(r.id) && r.id !== plan.target)))
      throw new Error('认识重评越出目标范围');
    return await exclusive(() => {
      if (options.signal?.aborted) { queue.cancel(job.id); return { status: 'cancelled', target: plan.target }; }
      if (!enabled()) { queue.fail(job, 'interrupted'); return { status: 'deferred', target: plan.target }; }
      const inputs = plan.context.sources.map((s) => ({ id: s.id, revision: s.revision, hash: s.hash }));
      const accepted = batch ? archive.accept(job, inputs, batch) : archive.complete(job, inputs, plan.context.generation);
      if (!accepted) { queue.fail(job, 'interrupted'); return { status: 'stale', target: plan.target }; }
      return { status: batch ? 'revised' : 'unchanged', target: plan.target };
    });
  } catch {
    return await exclusive(() => {
      if (options.signal?.aborted) { queue.cancel(job.id); return { status: 'cancelled', target: plan.target }; }
      if (!enabled()) { queue.fail(job, 'interrupted'); return { status: 'deferred', target: plan.target }; }
      queue.fail(job, controller.signal.aborted ? 'timeout' : 'processor_failed');
      return { status: 'failed', target: plan.target };
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener('abort', cancel);
  }
}

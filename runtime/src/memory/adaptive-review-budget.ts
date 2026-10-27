// 调度预算属于本机派生状态；调用前持久预扣，崩溃 / 重启不退款。
import { ARTIFACT_ID } from './adaptive-artifact.ts';

export interface ReviewBudget {
  version: 2; epoch: number; remaining: number; resumeAt: number; attempts: Record<string, number>;
}
export function reviewBudget(previous: unknown, epoch: number, now = Date.now()): ReviewBudget {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(now) || now < 0) throw new Error('重评预算时钟不合法');
  const old = previous as Partial<ReviewBudget> | null;
  // 从旧的整轮五次预算升级一次；之后版本不匹配 / 损坏不得反复重置限额。
  if (old && old.version !== undefined && old.version !== 2) throw new Error('重评预算版本不支持');
  if (old?.version === 2 && (!Number.isSafeInteger(old.epoch) || old.epoch! < 0 ||
      !Number.isSafeInteger(old.remaining) || old.remaining! < 0 || old.remaining! > 5 ||
      !Number.isSafeInteger(old.resumeAt) || old.resumeAt! < 0 || !old.attempts || Array.isArray(old.attempts) ||
      Object.keys(old.attempts).length > 1000 || Object.entries(old.attempts).some(([id, n]) =>
        !ARTIFACT_ID.test(id) || !Number.isSafeInteger(n) || n < 1 || n > 5))) throw new Error('重评预算损坏');
  const budget: ReviewBudget = old?.version === 2 && old.epoch === epoch
    ? { ...old as ReviewBudget, attempts: { ...old.attempts } }
    : { version: 2, epoch, remaining: 5, resumeAt: 0, attempts: {} };
  if (!budget.remaining && now >= budget.resumeAt) { budget.remaining = 5; budget.resumeAt = 0; }
  return budget;
}
export function canReview(budget: ReviewBudget, target: string): boolean {
  return ARTIFACT_ID.test(target) && budget.remaining > 0 && (budget.attempts[target] ?? 0) < 5 &&
    (Object.hasOwn(budget.attempts, target) || Object.keys(budget.attempts).length < 1000);
}
export function reserveReview(budget: ReviewBudget, target: string, now = Date.now()): void {
  if (!canReview(budget, target) || !Number.isSafeInteger(now) || now < 0) throw new Error('重评调用超过预算');
  budget.attempts[target] = (budget.attempts[target] ?? 0) + 1;
  budget.remaining--;
  if (!budget.remaining) budget.resumeAt = now + 60_000;
}

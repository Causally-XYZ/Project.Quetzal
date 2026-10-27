// 统计冻结断言的审核结果；验证证据定位，不用字符串命中或模型自评冒充语义判定。
import { families, metrics, digest, validateSuite, type Suite, type Surface, type Metric, type Case, type Check } from './spec.ts';

export interface Artifact { id: string; checkpoint: string; surface: Surface; sha256: string; data: unknown }
export interface Review {
  check: string; result: 'pass' | 'fail' | 'unassessed'; reviewer: 'agent' | 'human' | 'model'; reason: string;
  evidence: { artifact: string; pointer: string }[];
}
export interface Receipt {
  schema: 'quetzal-m2-receipt-v1'; suiteHash: string; planHash: string; caseId: string; repeat: number;
  kind: 'live' | 'stub'; status: 'complete' | 'failed' | 'interrupted'; artifacts: Artifact[]; reviews: Review[];
}
interface Count { expected: number; pass: number; fail: number; unassessed: number }
const zero = (): Count => ({ expected: 0, pass: 0, fail: 0, unassessed: 0 });
const emptyCounts = () => Object.fromEntries(metrics.map((m) => [m, zero()])) as Record<Metric, Count>;
const hash = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: unknown, keys: string[]) => { if (!object(v) || Object.keys(v).some((k) => !keys.includes(k))) throw new Error('receipt-shape'); };
const defined = (data: unknown, pointer: string) => {
  if (pointer === '') return true;
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return false;
  let value: any = data;
  for (const part of pointer.slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return false;
    value = value[part];
  }
  return true;
};
export function checkpoints(c: Case) { return c.tracks.flatMap((t) => t.steps.map((s) => ({ id: `${t.id}/${s.id}`, checks: s.checks }))); }

export function validateReceipt(value: unknown, c: Case, repeat: number, suiteHash: string, planHash: string): Receipt {
  fields(value, ['schema', 'suiteHash', 'planHash', 'caseId', 'repeat', 'kind', 'status', 'artifacts', 'reviews']);
  const r = value as Receipt;
  if (r.schema !== 'quetzal-m2-receipt-v1' || r.suiteHash !== suiteHash || r.planHash !== planHash || r.caseId !== c.id || r.repeat !== repeat
    || !['live', 'stub'].includes(r.kind) || !['complete', 'failed', 'interrupted'].includes(r.status)
    || !Array.isArray(r.artifacts) || r.artifacts.length > 300 || !Array.isArray(r.reviews) || r.reviews.length > 300) throw new Error('receipt-binding');
  const points = checkpoints(c), pointIds = new Set(points.map((p) => p.id));
  const assertions = new Map<string, { point: string; check: Check }>(
    points.flatMap((p) => p.checks.map((a) => [`${p.id}/${a.id}`, { point: p.id, check: a }])));
  const artifacts = new Map<string, Artifact>();
  for (const a of r.artifacts) {
    fields(a, ['id', 'checkpoint', 'surface', 'sha256', 'data']);
    if (typeof a.id !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(a.id) || artifacts.has(a.id) || !pointIds.has(a.checkpoint)
      || !['records', 'material', 'answer', 'sources', 'events'].includes(a.surface) || !hash(a.sha256)
      || !Object.hasOwn(a, 'data') || digest(a.data) !== a.sha256) throw new Error('artifact-binding');
    artifacts.set(a.id, a);
  }
  const seen = new Set<string>();
  for (const review of r.reviews) {
    fields(review, ['check', 'result', 'reviewer', 'reason', 'evidence']);
    const expected = assertions.get(review.check);
    if (!expected || seen.has(review.check) || !['pass', 'fail', 'unassessed'].includes(review.result) || !['agent', 'human', 'model'].includes(review.reviewer)
      || typeof review.reason !== 'string' || !review.reason.trim() || review.reason.length > 8000 || !Array.isArray(review.evidence) || review.evidence.length > 50) throw new Error('review-shape');
    seen.add(review.check); const surfaces = new Set<Surface>();
    for (const e of review.evidence) {
      fields(e, ['artifact', 'pointer']); const a = artifacts.get(e.artifact);
      if (!a || a.checkpoint !== expected.point || typeof e.pointer !== 'string' || e.pointer.length > 2000 || !defined(a.data, e.pointer)) throw new Error('review-evidence');
      surfaces.add(a.surface);
    }
    if (review.result === 'pass' && expected.check.surfaces.some((s) => !surfaces.has(s))
      || review.result === 'fail' && !expected.check.surfaces.some((s) => surfaces.has(s))) throw new Error('review-evidence-missing');
  }
  return r;
}

/** load 每次只读一个案例/重复的回执；缺失、损坏、stub 或纯模型评审均不得成为通过证据。 */
export function scoreSuite(suite: Suite, planHash: string, load: (caseId: string, repeat: number) => unknown | undefined) {
  validateSuite(suite); if (!hash(planHash)) throw new Error('运行计划摘要缺失');
  const suiteHash = digest(suite), total = emptyCounts();
  const byFamily = Object.fromEntries(families.map((f) => [f, emptyCounts()])) as Record<string, Record<Metric, Count>>;
  const execution = { expected: suite.cases.length * suite.repeats, complete: 0, failed: 0, interrupted: 0, missing: 0, invalid: 0, stub: 0 };
  const problems: { caseId: string; repeat: number; code: string }[] = [];
  for (const c of suite.cases) for (let repeat = 1; repeat <= suite.repeats; repeat++) {
    let receipt: Receipt | undefined;
    try {
      const raw = load(c.id, repeat);
      if (raw === undefined) execution.missing++;
      else receipt = validateReceipt(raw, c, repeat, suiteHash, planHash);
    } catch (error) { execution.invalid++; problems.push({ caseId: c.id, repeat, code: error instanceof Error && /^(receipt|artifact|review)-/.test(error.message) ? error.message : 'receipt-unreadable' }); }
    const points = checkpoints(c);
    if (receipt) {
      if (receipt.kind === 'stub') execution.stub++;
      else if (receipt.status === 'failed') execution.failed++;
      else if (receipt.status === 'interrupted') execution.interrupted++;
      else {
        const complete = points.every((p) => ['records', 'material', 'answer', 'sources', 'events'].every((surface) =>
          receipt!.artifacts.some((a) => a.checkpoint === p.id && a.surface === surface
            && (surface !== 'events' || object(a.data) && a.data.pipelineComplete === true))));
        if (complete) execution.complete++;
        else { execution.invalid++; problems.push({ caseId: c.id, repeat, code: 'checkpoint-incomplete' }); receipt = undefined; }
      }
    }
    const reviewed = new Map(receipt?.reviews.map((r) => [r.check, r]) ?? []);
    for (const p of points) for (const a of p.checks) {
      const r = reviewed.get(`${p.id}/${a.id}`);
      const state = receipt?.kind === 'live' && r && r.reviewer !== 'model' ? r.result : 'unassessed';
      for (const counts of [total, byFamily[c.family]]) { counts[a.metric].expected++; counts[a.metric][state]++; }
    }
  }
  const rate = (x: Count, target: number) => x.expected === 0 || x.pass / x.expected >= target;
  const safety = (['invariant', 'identitySafety', 'preservation', 'timeEvidenceSafety'] as const)
    .every((m) => total[m].fail === 0 && total[m].unassessed === 0);
  const positive = (['binding', 'correction'] as const).every((m) => rate(total[m], 0.95) && families.every((f) => rate(byFamily[f][m], 0.90)));
  const fieldsComplete = rate(total.requiredFields, 0.90);
  const executionComplete = execution.complete / execution.expected >= 0.95;
  return { schema: 'quetzal-m2-score-v1', suiteHash, planHash, semanticGate: safety && positive && fieldsComplete && executionComplete,
    gates: { safety, positive, fieldsComplete, executionComplete }, execution, total, byFamily, problems,
    limits: '仅统计已定位证据的审核结论，不自动判定语义真伪；model 自评和 stub 不计通过，也不代表 M2 全部门禁或真人反馈。' };
}

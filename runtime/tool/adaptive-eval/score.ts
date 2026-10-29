// 统计冻结断言的审核结果；验证证据定位，不用字符串命中或模型自评冒充语义判定。
import { families, metrics, reports, hardBoundaries, digest, validateSuite, type Suite, type Surface, type Metric, type Case, type Check } from './spec.ts';

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
export function evidenceRequirements(point: string, check: Check) {
  return check.metric === 'sequence' ? check.evidenceAt! : [{ checkpoint: point, surfaces: check.surfaces }];
}
export function requiredPassed(check: Check, reviews: Map<string, Review>, independent = false) {
  return (check.required ?? []).every((id) => {
    const review = reviews.get(id); return review?.result === 'pass' && (!independent || review.reviewer !== 'model');
  });
}

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
    seen.add(review.check); const covered = new Set<string>(), required = evidenceRequirements(expected.point, expected.check);
    for (const e of review.evidence) {
      fields(e, ['artifact', 'pointer']); const a = artifacts.get(e.artifact);
      if (!a || !required.some((point) => point.checkpoint === a.checkpoint
        && (expected.check.metric !== 'sequence' || point.surfaces.includes(a.surface)))
        || typeof e.pointer !== 'string' || e.pointer.length > 2000 || !defined(a.data, e.pointer)) throw new Error('review-evidence');
      covered.add(`${a.checkpoint}/${a.surface}`);
    }
    const pairs = required.flatMap((p) => p.surfaces.map((s) => `${p.checkpoint}/${s}`));
    if (review.result === 'pass' && pairs.some((pair) => !covered.has(pair))
      || review.result === 'fail' && !pairs.some((pair) => covered.has(pair))) throw new Error('review-evidence-missing');
  }
  return r;
}

/** 整体无效不恢复任何通过；只隔离复核仍可独立定位的硬失败，沿用同一严格校验器。 */
function isolatedHardFailures(raw: unknown, c: Case, repeat: number, suiteHash: string, planHash: string): Map<string, Review> {
  const failures = new Map<string, Review>();
  if (!object(raw) || !Array.isArray(raw.artifacts) || raw.artifacts.length > 300
    || !Array.isArray(raw.reviews) || raw.reviews.length > 300) return failures;
  try {
    const envelope = validateReceipt({ ...raw, artifacts: [], reviews: [] }, c, repeat, suiteHash, planHash);
    if (envelope.kind !== 'live') return failures;
  } catch { return failures; }
  const hard = new Set(checkpoints(c).flatMap((p) => p.checks.filter((a) => a.hardBoundary).map((a) => `${p.id}/${a.id}`)));
  for (const review of raw.reviews) {
    if (!object(review) || !hard.has(review.check) || review.result !== 'fail' || review.reviewer === 'model'
      || !Array.isArray(review.evidence) || review.evidence.length > 50
      || raw.reviews.filter((r) => object(r) && r.check === review.check).length !== 1) continue;
    const ids = new Set(review.evidence.map((e: unknown) => object(e) ? e.artifact : undefined));
    const matches = [...ids].map((id) => raw.artifacts.filter((a: unknown) => object(a) && a.id === id));
    // 不从重复 ID 中挑一个“好”版本，缺失或歧义均不可采信。
    if (matches.some((items) => items.length !== 1)) continue;
    try {
      const checked = validateReceipt({ ...raw, artifacts: matches.flat(), reviews: [review] }, c, repeat, suiteHash, planHash);
      failures.set(review.check, checked.reviews[0]);
    } catch { /* 硬失败自身的证据也必须通过完整校验。 */ }
  }
  return failures;
}

/** load 每次只读一个案例/重复的回执；缺失、损坏、stub 或纯模型评审均不得成为通过证据。 */
export function scoreSuite(suite: Suite, planHash: string, load: (caseId: string, repeat: number) => unknown | undefined) {
  validateSuite(suite); if (suite.schema !== 'quetzal-m2-eval-v1') throw new Error('请显式使用 v2 序列评分入口');
  if (!hash(planHash)) throw new Error('运行计划摘要缺失');
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
      if (a.metric === 'sequence') throw new Error('v1 不支持序列检查');
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

/** 仅 v2 序列评分，不替代独立工程回归或生成正式留出题库。 */
export function scoreSequenceSuite(suite: Suite, planHash: string, load: (caseId: string, repeat: number) => unknown | undefined) {
  validateSuite(suite);
  if (suite.schema !== 'quetzal-m5-eval-v2' || !hash(planHash)) throw new Error('v2 题库或运行计划摘要缺失');
  const suiteHash = digest(suite), total = emptyCounts(), sequences = zero();
  const tagged = <T extends string>(keys: readonly T[]) => Object.fromEntries(keys.map((key) => [key, zero()])) as Record<T, Count>;
  const breakdown = tagged(reports), boundaries = tagged(hardBoundaries);
  const byFamily = Object.fromEntries(families.map((f) => [f, { sequences: zero(), total: emptyCounts(), breakdown: tagged(reports) }]));
  const execution = { expected: 150, complete: 0, failed: 0, interrupted: 0, missing: 0, invalid: 0, stub: 0 };
  const problems: { caseId: string; repeat: number; code: string }[] = [];
  const violations: { caseId: string; repeat: number; check: string; boundary: NonNullable<Check['hardBoundary']> }[] = [];
  const consistency: { caseId: string; results: Review['result'][] }[] = [];
  const add = (count: Count, state: Review['result']) => { count.expected++; count[state]++; };
  for (const c of suite.cases) {
    const results: Review['result'][] = [];
    for (let repeat = 1; repeat <= suite.repeats; repeat++) {
      let receipt: Receipt | undefined, raw: unknown, complete = false, isolated = new Map<string, Review>();
      const problem = (code: string) => problems.push({ caseId: c.id, repeat, code });
      try {
        raw = load(c.id, repeat);
        if (raw === undefined) execution.missing++;
        else receipt = validateReceipt(raw, c, repeat, suiteHash, planHash);
      } catch (error) {
        execution.invalid++; problem(error instanceof Error && /^(receipt|artifact|review)-/.test(error.message) ? error.message : 'receipt-unreadable');
        isolated = isolatedHardFailures(raw, c, repeat, suiteHash, planHash);
      }
      const points = checkpoints(c);
      if (receipt) {
        if (receipt.kind === 'stub') execution.stub++;
        else if (receipt.status !== 'complete') execution[receipt.status]++;
        else {
          complete = points.every((p) => ['records', 'material', 'answer', 'sources', 'events'].every((surface) =>
            receipt!.artifacts.some((a) => a.checkpoint === p.id && a.surface === surface
              && (surface !== 'events' || object(a.data) && a.data.pipelineComplete === true))));
          if (complete) execution.complete++;
          else { execution.invalid++; problem('checkpoint-incomplete'); }
        }
      }
      // 已有效定位的局部硬违规即使出现在失败/未完成序列也保留；未覆盖项明确未评。
      const reviewed = new Map(receipt?.reviews.map((r) => [r.check, r]) ?? []);
      for (const p of points) for (const check of p.checks) {
        const id = `${p.id}/${check.id}`, review = reviewed.get(id);
        let state: Review['result'] = receipt?.kind === 'live' && review && review.reviewer !== 'model' ? review.result : 'unassessed';
        if (check.hardBoundary && isolated.has(id)) state = 'fail';
        if (check.metric === 'sequence') {
          if (state === 'pass' && !requiredPassed(check, reviewed, true)) { state = 'unassessed'; problem('sequence-required-not-passed'); }
          if (!complete && state === 'pass') state = 'unassessed';
          add(sequences, state); add(byFamily[c.family].sequences, state); results.push(state);
        } else {
          add(total[check.metric], state); add(byFamily[c.family].total[check.metric], state);
          if (check.report) { add(breakdown[check.report], state); add(byFamily[c.family].breakdown[check.report], state); }
          if (check.hardBoundary) {
            add(boundaries[check.hardBoundary], state);
            if (state === 'fail') violations.push({ caseId: c.id, repeat, check: id, boundary: check.hardBoundary });
          }
        }
      }
    }
    consistency.push({ caseId: c.id, results });
  }
  const overall = sequences.pass >= 143, everyFamily = families.every((f) => byFamily[f].sequences.pass >= 14);
  return { schema: 'quetzal-m5-score-v2', suiteHash, planHash, qualityGate: overall && everyFamily,
    gates: { overall, everyFamily, noKnownHardViolation: violations.length === 0 }, sequences, execution,
    total, byFamily, breakdown, boundaries, violations, consistency, problems,
    independentEngineering: { status: 'not-evaluated' as const },
    limits: 'qualityGate 仅为150固定序列票的质量门，多轨合一票；已证实硬违规另行否决，工程门禁未评。未完成、未评、缺证、stub、模型自评不加票。分项为冻结检查结论，非自动事件发生率；未登记/未评不代表安全。工程回归须另附独立证据，本结果不提供 M5 总放行或真人反馈结论。' };
}

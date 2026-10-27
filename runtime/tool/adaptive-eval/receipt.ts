// 只封装实际执行材料；不生成语义通过结论。原始文件保留，内联投影绑定其字节摘要。
import fs from 'node:fs';
import path from 'node:path';
import { digest, type Case, type Surface } from './spec.ts';
import type { Artifact, Receipt } from './score.ts';
import { readEvidence, type ExecutionPlan } from './plan.ts';

export function inputTrack(track: Case['tracks'][number]) {
  return { id: track.id, setup: track.setup, steps: track.steps.map(({ checks: _checks, ...step }) => structuredClone(step)) };
}
export function collectReceipt(root: string, c: Case, repeat: number, plan: ExecutionPlan): Receipt {
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new Error('案例重复编号不合法');
  const artifacts: Artifact[] = []; let complete = true;
  const add = (checkpoint: string, surface: Surface, data: unknown) => artifacts.push({
    id: `a${artifacts.length + 1}-${surface}`, checkpoint, surface, sha256: digest(data), data,
  });
  for (const track of c.tracks) {
    const directory = path.join(root, track.id), input = inputTrack(track);
    const actualInput = readEvidence(directory, 'input.json'), execution = readEvidence(directory, 'execution.json');
    if (digest(actualInput.data) !== digest(input) || execution.data.inputHash !== digest(input)
      || execution.data.kind !== plan.configuration.kind || execution.data.model !== plan.configuration.routes.main[0]
      || execution.data.maxCallsPerBody !== plan.configuration.budgets.maxCallsPerBody
      || execution.data.stepTimeoutMs !== plan.configuration.budgets.stepTimeoutMs || !execution.data.fullEvidence
      || execution.data.retrieval !== plan.configuration.retrieval || execution.data.disconnectStep !== null)
      throw new Error('轨迹执行与冻结计划不匹配');
    const result = readEvidence(directory, 'result.json');
    const completed = result.data.status === 'pipeline-completed-needs-review';
    if (result.data.kind !== plan.configuration.kind || !['pipeline-completed-needs-review', 'failed'].includes(result.data.status)
      || !Array.isArray(result.data.checkpoints) || result.data.checkpoints.length > track.steps.length
      || completed && (result.data.checkpoints.length !== track.steps.length || result.data.finalSnapshotMissing
        || result.data.shutdown?.length < 2 || result.data.shutdown.some((s: any) => s.forced || s.exitCode !== 0))) throw new Error('轨迹结果不完整');
    complete &&= completed;
    for (const [index, step] of track.steps.entries()) {
      const point = `${track.id}/${step.id}`, entry = result.data.checkpoints[index];
      if (!entry) {
        const terminal = (result.data.bodies ?? []).map((body: any, i: number) => {
          const file = `final-body-${i + 1}.json`;
          if (!fs.existsSync(path.join(directory, file))) return { body: body.name, missing: true };
          const raw = readEvidence(directory, file), state = raw.data;
          return { body: body.name, origin: { file: `${track.id}/${file}`, sha256: raw.sha256 },
            status: state.status, jobs: state.jobs, publications: state.publications,
            calls: state.calls.filter((call: any) => call.phase === point) };
        });
        add(point, 'events', { pipelineComplete: false, outcome: result.data.status, result, terminal,
          released: fs.existsSync(path.join(directory, `offline-${index + 1}.json`)) ? readEvidence(directory, `offline-${index + 1}.json`) : null });
        continue;
      }
      const filename = `checkpoint-${index + 1}.json`;
      if (entry.point !== point || entry.file !== filename) throw new Error('检查点顺序不匹配');
      const raw = readEvidence(directory, filename), cp = raw.data;
      if (entry.sha256 !== digest(cp) || cp.point !== point || cp.source !== entry.source
        || !cp.preAnswer?.center?.history || !cp.postAnswer?.center?.history || !cp.preAnswer?.center?.evidence
        || typeof cp.answer !== 'string' || !cp.plan) throw new Error('检查点证据缺失或摘要不匹配');
      const origin = { file: `${track.id}/${filename}`, sha256: raw.sha256 };
      const calls = ['center', 'satellite'].flatMap((body) => cp.postAnswer[body].calls
        .filter((x: any) => x.phase === point).map((x: any) => ({ ...x, body })));
      if (!calls.some((x: any) => x.purpose === 'conversation') || calls.some((x: any) => x.state !== 'returned' || x.result?.truncated
          || x.purpose === 'proposal' && digest(x.request.responseSchema ?? null) !== plan.configuration.prompt.schemaHash
          || x.purpose === 'conversation' && x.request.responseSchema !== undefined)
        || cp.answerBody !== (step.body === 'A' ? 'B' : 'A') || cp.isolation?.policy !== step.scope)
        throw new Error('检查点调用或输入范围不匹配');
      const sourceBodies = step.scope === 'other-agent' ? [cp.isolation.foreign] : [cp.preAnswer.center, cp.preAnswer.satellite];
      if (sourceBodies.some((body: any) => !body?.messages?.some((m: any) => m.id === cp.source && m.text === step.text
        && m.ts === Date.parse(step.at) && m.role === (step.role === 'assistant-summary' ? 'agent' : 'user')
        && (step.scope !== 'denied' || m.mode === 'ignored')))) throw new Error('原始来源或时间不匹配');
      if (plan.configuration.kind === 'live' && calls.some((x: any) => x.model !== plan.configuration.routes.main[0] || !x.transport?.length
        || x.transport.some((t: any) => t.state !== 'complete' || t.versions.length !== 1 || t.versions[0] !== x.model || !t.finish.includes('STOP'))))
        throw new Error('真实模型元数据不完整');
      add(point, 'records', { origin, before: { center: cp.preAnswer.center.records, satellite: cp.preAnswer.satellite.records },
        after: { center: cp.postAnswer.center.records, satellite: cp.postAnswer.satellite.records }, history: cp.postAnswer.center.history,
        evidence: cp.postAnswer.center.evidence, proposals: calls.filter((x: any) => x.purpose === 'proposal'), controlled: cp.control ?? null, reading: cp.reading });
      add(point, 'material', { origin, requests: calls.map((x: any) => ({ body: x.body, id: x.id, purpose: x.purpose, model: x.model, request: x.request })), plan: cp.plan });
      add(point, 'answer', { origin, body: cp.answerBody, text: cp.answer,
        calls: calls.filter((x: any) => x.purpose === 'conversation').map((x: any) => ({ body: x.body, id: x.id, result: x.result, failure: x.failure })) });
      add(point, 'sources', { origin, input: input.steps.slice(0, index + 1), source: cp.source, isolation: cp.isolation,
        center: cp.postAnswer.center.messages, satellite: cp.postAnswer.satellite.messages });
      add(point, 'events', { origin, pipelineComplete: true, elapsedMs: cp.elapsedMs, answerElapsedMs: cp.answerElapsedMs,
        readingElapsedMs: cp.readingElapsedMs ?? null, calls, retrieval: cp.retrievalReading ?? [],
        jobs: cp.postAnswer.center.jobs, receipts: cp.postAnswer.center.receipts, publications: cp.postAnswer.center.publications, result });
    }
  }
  return { schema: 'quetzal-m2-receipt-v1', suiteHash: plan.suiteHash, planHash: digest(plan), caseId: c.id, repeat,
    kind: plan.configuration.kind, status: complete ? 'complete' : 'failed', artifacts, reviews: [] };
}

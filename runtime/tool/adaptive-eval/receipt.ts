// 只封装实际执行材料；不生成语义通过结论。原始文件保留，内联投影绑定其字节摘要。
import fs from 'node:fs';
import path from 'node:path';
import { digest, sourceInputPath, type Case, type Surface } from './spec.ts';
import type { Artifact, Receipt } from './score.ts';
import { readEvidence, trackConfiguration, type ExecutionPlan } from './plan.ts';

function verifyV2Snapshot(directory: string, state: any, body: string, plan: ExecutionPlan, research: boolean) {
  const expectedConfig = { adaptiveMemory: { enabled: true, semantic: true, research, hostBody: 'center' },
    memorySemantic: false, memoryLearning: true, sentinel: false };
  if (digest(state.actualConfig) !== digest(expectedConfig) || !Array.isArray(state.calls)
    || state.calls.some((call: any, i: number) => call.id !== i + 1 || !['returned', 'failed'].includes(call.state))
    || state.status?.error || state.sync?.unpushed || state.publications?.some((p: any) => p.state !== 'published'))
    throw new Error('v2 实际配置或稳定快照不匹配');
  if (body === 'center') {
    if (state.status?.semantic?.state !== (research ? 'research-idle' : 'idle')
      || state.jobs.some((j: any) => ['running', 'queued'].includes(j.state))
      || [state.status.queue, state.status.semantic.queue, ...(research ? [state.status.semantic.research?.queue] : [])]
        .some((q: any) => !q?.counts || q.counts.running || q.counts.queued)
      || state.messages.some((m: any) => m.mode !== 'ignored' && !state.receipts.some((r: any) => r.source === m.id && r.processor === 'semantic-v1'))
      || research && state.messages.some((m: any) => m.mode !== 'ignored' && ['user', 'ambient'].includes(m.role)
        && !state.receipts.some((r: any) => r.source === m.id && r.processor === 'research-v1')))
      throw new Error('v2 后台尚未完成整合或研究');
    if (plan.configuration.kind === 'live' && (state.status.retrieval?.state !== 'ready' || !state.status.retrieval.current
      || state.status.retrieval.pending !== 0 || state.status.retrieval.snapshot !== state.retrievalExpected
      || state.status.retrieval.failure || state.status.retrieval.errors || state.status.retrieval.blocked))
      throw new Error('v2 向量快照未就绪');
  }
  for (const call of state.calls) {
    const start = readEvidence(directory, `${body}/eval-calls/${call.id}-start.json`), end = readEvidence(directory, `${body}/eval-calls/${call.id}-end.json`);
    const immutable = (x: any) => ({ id: x.id, phase: x.phase, purpose: x.purpose, model: x.model, start: x.start,
      thinkingLevel: x.thinkingLevel, backgroundJob: x.backgroundJob, request: x.request });
    if (start.data.state !== 'running' || digest(immutable(start.data)) !== digest(immutable(call)) || digest(end.data) !== digest(call))
      throw new Error('v2 调用尝试原件与快照不匹配');
    if (call.model !== plan.configuration.routes.main[0] || !['proposal', 'conversation'].includes(call.purpose)
      || call.result?.truncated || call.state === 'returned' && !call.result
      || (call.purpose === 'proposal' ? call.request.maxTokens !== 16384
        : !Number.isInteger(call.request.maxTokens) || call.request.maxTokens <= 0 || call.request.maxTokens > 4096 || call.request.responseSchema !== undefined))
      throw new Error('v2 调用类型或输出预算不匹配');
    let processor = 'semantic-v1';
    if (call.purpose === 'proposal') {
      const input = JSON.parse(call.request.messages.at(-1).content), info = input.research;
      const planning = !!info && Object.hasOwn(info, 'purpose');
      if (info && (!research || typeof info.question !== 'string'
        || (planning ? !['explore', 'bridge', 'counter'].includes(info.purpose) || !Array.isArray(info.steps) || Object.hasOwn(info, 'searches')
          : !Array.isArray(info.searches) || Object.hasOwn(info, 'steps')))) throw new Error('v2 研究调用用途不匹配');
      const schema = planning ? plan.configuration.prompt.researchPlanSchemaHash : plan.configuration.prompt.schemaHash;
      if (!schema || digest(call.request.responseSchema ?? null) !== schema) throw new Error('v2 提案或研究规划格式不匹配');
      processor = info ? 'research-v1' : input.review ? 'review-' : 'semantic-v1';
    }
    if (plan.configuration.kind === 'live' && (call.thinkingLevel !== 'LOW' || !Array.isArray(call.transport)
      || call.transport.some((t: any) => t.thinkingLevel !== 'LOW' || t.model !== call.model)
      || call.state === 'returned' && (!call.transport.length || call.transport.some((t: any) => t.state !== 'complete'
        || t.versions.length !== 1 || t.versions[0] !== call.model || !t.finish.includes('STOP')))))
      throw new Error('v2 真实模型思考或传输元数据不匹配');
    if (call.state === 'failed') {
      const job = call.backgroundJob, finished = state.backgroundJobs?.find((j: any) => j.id === job?.id);
      const sameJob = (j: any) => j && j.id === job.id && j.source === job.source && j.revision === job.revision && j.processor === job.processor;
      if (call.purpose !== 'proposal' || call.failure?.category === 'call-budget' || !call.failure || !job
        || !Number.isInteger(job.attempts) || job.attempts < 1
        || (processor === 'review-' ? !job.processor.startsWith(processor) : job.processor !== processor)
        || !sameJob(finished) || finished.state !== 'done' || finished.error || finished.attempts <= job.attempts
        || !state.receipts.some((r: any) => r.source === job.source && r.revision === job.revision && r.processor === job.processor)
        || !state.calls.some((later: any) => later.id > call.id && later.purpose === 'proposal' && later.state === 'returned'
          && sameJob(later.backgroundJob) && later.backgroundJob.attempts > job.attempts && later.backgroundJob.attempts <= finished.attempts))
        throw new Error('v2 后台失败缺少同一任务的完整恢复依据');
    }
  }
}

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
    const v2 = plan.schema === 'quetzal-m5-plan-v2', settings = trackConfiguration(plan, track.setup);
    const research = 'research' in settings && settings.research;
    const actualInput = readEvidence(directory, 'input.json'), execution = readEvidence(directory, 'execution.json');
    if (digest(actualInput.data) !== digest(input) || execution.data.inputHash !== digest(input)
      || execution.data.kind !== plan.configuration.kind || execution.data.model !== plan.configuration.routes.main[0]
      || execution.data.maxCallsPerBody !== plan.configuration.budgets.maxCallsPerBody
      || execution.data.stepTimeoutMs !== plan.configuration.budgets.stepTimeoutMs || !execution.data.fullEvidence
      || execution.data.retrieval !== plan.configuration.retrieval || execution.data.disconnectStep !== null)
      throw new Error('轨迹执行与冻结计划不匹配');
    if (v2 && (execution.data.inputMode !== 'normal-converse-eligible' || execution.data.inputPath !== 'normal-converse-eligible'
      || execution.data.baseline !== null || execution.data.research !== research || execution.data.backgroundRetries !== true
      || execution.data.thinkingLevel !== ('thinkingLevel' in settings ? settings.thinkingLevel : undefined)
      || digest(execution.data.stepInputPaths) !== digest(track.steps.map((step) => ({ id: step.id, path: sourceInputPath(step, track.setup, 'normal-converse-eligible') })))))
      throw new Error('v2 轨迹输入或模型配置不匹配');
    const result = readEvidence(directory, 'result.json');
    const completed = result.data.status === 'pipeline-completed-needs-review';
    if (result.data.kind !== plan.configuration.kind || !['pipeline-completed-needs-review', 'failed'].includes(result.data.status)
      || !Array.isArray(result.data.checkpoints) || result.data.checkpoints.length > track.steps.length
      || completed && (result.data.checkpoints.length !== track.steps.length || result.data.finalSnapshotMissing
        || result.data.shutdown?.length < 2 || result.data.shutdown.some((s: any) => s.forced || s.exitCode !== 0))) throw new Error('轨迹结果不完整');
    complete &&= completed;
    let previousMessages: any[] | undefined;
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
      const consumer = cp.answerBody === 'A' ? 'center' : 'satellite';
      const answerCalls = calls.filter((x: any) => x.purpose === 'conversation' && (!v2 || x.body === consumer
        && x.id > (cp.preAnswer[x.body].calls.at(-1)?.id ?? 0)));
      if (v2) for (const body of ['center', 'satellite']) {
        verifyV2Snapshot(directory, cp.preAnswer[body], body, plan, research);
        verifyV2Snapshot(directory, cp.postAnswer[body], body, plan, research);
        if (cp.preAnswer[body].calls.some((x: any, i: number) => digest(x) !== digest(cp.postAnswer[body].calls[i])))
          throw new Error('v2 检查点改写已有调用');
      }
      if (!answerCalls.length || !v2 && calls.some((x: any) => x.state !== 'returned' || x.result?.truncated
          || x.purpose === 'proposal' && digest(x.request.responseSchema ?? null) !== plan.configuration.prompt.schemaHash
          || x.purpose === 'conversation' && x.request.responseSchema !== undefined)
        || cp.answerBody !== (step.body === 'A' ? 'B' : 'A') || cp.isolation?.policy !== step.scope)
        throw new Error('检查点调用或输入范围不匹配');
      if (step.action === 'query-only') {
        if (!previousMessages || Object.hasOwn(step, 'text') || Object.hasOwn(step, 'operation') || step.role !== 'user' || step.scope !== 'accessible'
          || cp.action !== 'query-only' || cp.source !== null || cp.producer !== null || Object.hasOwn(cp, 'control')
          || fs.existsSync(path.join(directory, `controlled-${index + 1}.json`))) throw new Error('观察动作混入来源或受控操作');
        const before = new Map<number, string>();
        for (const message of previousMessages) {
          if (before.has(message.id) && before.get(message.id) !== digest(message)) throw new Error('观察前历史不一致');
          before.set(message.id, digest(message));
        }
        const conversation = calls.filter((call: any) => call.purpose === 'conversation' && call.body === (cp.answerBody === 'A' ? 'center' : 'satellite'));
        const tools = conversation.flatMap((call: any) => call.result?.toolCalls ?? []);
        for (const body of ['center', 'satellite']) {
          const prior = cp.preAnswer[body]?.messages, after = cp.postAnswer[body]?.messages;
          if (!Array.isArray(prior) || prior.length !== before.size || new Set(prior.map((m: any) => m.id)).size !== prior.length
            || prior.some((m: any) => before.get(m.id) !== digest(m)) || !Array.isArray(after)
            || new Set(after.map((m: any) => m.id)).size !== after.length
            || prior.some((m: any) => !after.some((a: any) => a.id === m.id && digest(a) === digest(m))))
            throw new Error('观察动作额外注入或改写历史');
          const added = after.filter((m: any) => !before.has(m.id)), session = `answer-${index + 1}`;
          const users = added.filter((m: any) => m.role === 'user'), answers = added.filter((m: any) => m.role === 'agent');
          if (prior.some((m: any) => m.session === session) || added.some((m: any) => m.session === `source-${index + 1}` || m.mode === 'ignored')
            || users.length !== 1 || users[0].session !== session || users[0].text !== step.query
            || answers.length !== 1 || answers[0].text !== cp.answer)
            throw new Error('观察问题或回答未真实留存');
          const home = answers[0].session, switches = tools.filter((tool: any) => tool.name === 'session_new');
          if (home !== session && (!switches.length || prior.some((m: any) => m.session === home))) throw new Error('观察答复迁移缺少调用证据');
          for (const message of added.filter((m: any) => !['user', 'agent'].includes(m.role))) {
            const summary = message.session === session && tools.some((tool: any) => tool.name === 'session_compact'
              && (typeof tool.args?.summary === 'string' && tool.args.summary.trim() ? tool.args.summary.trim() === message.text
                : conversation.some((call: any) => call.request.messages[0]?.content.startsWith('你在替一个 agent 压缩') && call.result?.text.trim() === message.text)));
            const handoff = home !== session && message.session === home
              && switches.some((tool: any) => typeof tool.args?.handoff === 'string' && tool.args.handoff.trim() === message.text);
            if (message.role !== 'ambient' || !summary && !handoff) throw new Error('观察附加历史缺少工具关联证据');
          }
        }
        if (digest(cp.preAnswer.center.messages) !== digest(cp.preAnswer.satellite.messages)
          || digest(cp.postAnswer.center.messages) !== digest(cp.postAnswer.satellite.messages)) throw new Error('观察历史未跨身体收敛');
      } else {
        const sourceBodies = step.scope === 'other-agent' ? [cp.isolation.foreign] : [cp.preAnswer.center, cp.preAnswer.satellite];
        if (cp.action !== undefined || sourceBodies.some((body: any) => !body?.messages?.some((m: any) => m.id === cp.source && m.text === step.text
          && m.ts === Date.parse(step.at) && m.role === (step.role === 'assistant-summary' ? 'agent' : 'user')
          && (step.scope !== 'denied' || m.mode === 'ignored')))) throw new Error('原始来源或时间不匹配');
        if (v2 && sourceInputPath(step, track.setup, 'normal-converse-eligible') === 'normal-converse-with-synchronous-record-clock') {
          const producer = step.body === 'A' ? 'center' : 'satellite';
          if (!cp.preAnswer[producer].calls.some((call: any) => call.phase === point && call.purpose === 'conversation' && call.state === 'returned')
            || !cp.preAnswer[producer].messages.some((m: any) => m.role === 'agent' && m.session === `source-${index + 1}`))
            throw new Error('v2 素材未经过真实对话回复');
        }
      }
      previousMessages = [...cp.postAnswer.center.messages, ...cp.postAnswer.satellite.messages];
      if (!v2 && plan.configuration.kind === 'live' && calls.some((x: any) => x.model !== plan.configuration.routes.main[0] || !x.transport?.length
        || x.transport.some((t: any) => t.state !== 'complete' || t.versions.length !== 1 || t.versions[0] !== x.model || !t.finish.includes('STOP'))))
        throw new Error('真实模型元数据不完整');
      add(point, 'records', { origin, before: { center: cp.preAnswer.center.records, satellite: cp.preAnswer.satellite.records },
        after: { center: cp.postAnswer.center.records, satellite: cp.postAnswer.satellite.records }, history: cp.postAnswer.center.history,
        evidence: cp.postAnswer.center.evidence, proposals: calls.filter((x: any) => x.purpose === 'proposal'), controlled: cp.control ?? null, reading: cp.reading });
      add(point, 'material', { origin, requests: calls.map((x: any) => ({ body: x.body, id: x.id, purpose: x.purpose, model: x.model, request: x.request })), plan: cp.plan });
      add(point, 'answer', { origin, body: cp.answerBody, text: cp.answer,
        calls: answerCalls.map((x: any) => ({ body: x.body, id: x.id, result: x.result, failure: x.failure })) });
      add(point, 'sources', { origin, input: input.steps.slice(0, index + 1), source: cp.source, isolation: cp.isolation,
        center: cp.postAnswer.center.messages, satellite: cp.postAnswer.satellite.messages });
      add(point, 'events', { origin, pipelineComplete: true, elapsedMs: cp.elapsedMs, answerElapsedMs: cp.answerElapsedMs,
        readingElapsedMs: cp.readingElapsedMs ?? null, calls, retrieval: cp.retrievalReading ?? [],
        ...(v2 ? { actualConfig: { center: cp.postAnswer.center.actualConfig, satellite: cp.postAnswer.satellite.actualConfig },
          backgroundJobs: { center: cp.postAnswer.center.backgroundJobs, satellite: cp.postAnswer.satellite.backgroundJobs } } : {}),
        jobs: cp.postAnswer.center.jobs, receipts: cp.postAnswer.center.receipts, publications: cp.postAnswer.center.publications, result });
    }
  }
  return { schema: 'quetzal-m2-receipt-v1', suiteHash: plan.suiteHash, planHash: digest(plan), caseId: c.id, repeat,
    kind: plan.configuration.kind, status: complete ? 'complete' : 'failed', artifacts, reviews: [] };
}

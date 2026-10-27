// 逐步输入 -> 真实复制/后台/灵魂发布 -> 对端网关回答。只收已释放操作，不收预期答案。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeSync } from '../../test/fixtures/fake-sync.ts';
import { loadNodeKey } from '../../src/mesh/identity.ts';
import { startBody, type BodyClient } from './process-client.ts';
import { digest, type Track } from './spec.ts';
import type { ObservedCall } from './model-observer.ts';
import { seedPublicRetrievalCache } from './retrieval-observer.ts';
export type InputTrack = Omit<Track, 'steps'> & { steps: Omit<Track['steps'][number], 'checks'>[] };
export interface TrackOptions { root: string; track: InputTrack; kind: 'live' | 'stub'; model: string; maxCalls?: number; stepTimeoutMs?: number; stubFailAt?: number; stubReviewDelayMs?: number;
  retrievalCache?: string; disconnectStep?: number }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
const write = (root: string, name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2), { flag: 'wx' });
export async function runTrack(options: TrackOptions) {
  const controlled = options.track.setup === 'and-or-graph';
  if (!['empty', 'and-or-graph'].includes(options.track.setup) || !options.track.steps.length || options.track.steps.length > (controlled ? 3 : 8)
    || options.track.steps.some((s, i) => !['accessible', 'denied', 'other-agent'].includes(s.scope) || Object.hasOwn(s, 'checks')
      || (controlled ? s.scope !== 'accessible' || s.role !== 'user' || (i === 0 ? !!s.operation || !/K (?:表示|指)[^，。]+/u.test(s.text)
        : !s.operation || s.operation.type !== 'withdraw-premise' || s.operation.target !== (i === 1 ? 'A' : 'C')) : !!s.operation)))
    throw new Error('evaluation-track-not-supported');
  const stepTimeoutMs = options.stepTimeoutMs ?? 180000, maxCalls = options.maxCalls ?? 36;
  if (!Number.isSafeInteger(stepTimeoutMs) || stepTimeoutMs < 1000 || stepTimeoutMs > 300000) throw new Error('evaluation-timeout-invalid');
  if (options.disconnectStep !== undefined && (!Number.isSafeInteger(options.disconnectStep) || options.disconnectStep < 1
    || options.disconnectStep > options.track.steps.length || options.track.steps[options.disconnectStep - 1].scope !== 'accessible'
    || options.track.steps[options.disconnectStep - 1].body !== 'B')) throw new Error('evaluation-disconnect-invalid');
  fs.mkdirSync(options.root); // 不复用旧目录，不覆盖失败证据。
  write(options.root, 'input.json', options.track);
  write(options.root, 'execution.json', { schema: 'quetzal-m2-track-development-v1', inputHash: digest(options.track), kind: options.kind,
    model: options.model, maxCallsPerBody: maxCalls, stepTimeoutMs, queryHistory: 'normal-persistent', inputPath: 'store-with-synchronous-record-clock',
    answerPath: 'authenticated-gateway-chat.send', signalDirectory: 'local-fixture', transport: options.kind === 'live' ? 'adc-google-adapter' : 'in-process-stub',
    deniedPolicy: 'ignored-at-insert', foreignPolicy: 'separate-agent-process-no-mesh-no-model',
    retrieval: options.retrievalCache ? 'real-vector-public-cache-prefilled' : 'lexical-only-component-preparation-disabled', disconnectStep: options.disconnectStep ?? null,
    controlledPolicy: controlled ? 'pause-idle-host-before-input; archive-accept-seed-or-withdrawal; resume-normal-publication-and-model-review' : null,
    limits: '开发链路；不等于冻结正式计划或语义通过。denied 检验既有 ignored 来源门禁，不代表新增会话 ACL；受控图输入不计为模型构图能力。' });
  const clients: BodyClient[] = [], bodyNames: string[] = [], keys: Record<string, string> = {};
  let sync: Awaited<ReturnType<typeof fakeSync>> | undefined;
  const report: any = { schema: 'quetzal-m2-track-development-result-v1', kind: options.kind, status: 'running', checkpoints: [], shutdown: [] };
  const started = Date.now();
  async function until<T>(check: () => Promise<T | undefined>, label: string, timeout = stepTimeoutMs): Promise<T> {
    const deadline = Date.now() + timeout;
    while (true) { const value = await check(); if (value !== undefined) return value;
      if (Date.now() >= deadline) throw new Error(`evaluation-${label}-timeout`);
      await new Promise((r) => setTimeout(r, 200)); }
  }
  const snapshot = (body: BodyClient) => body.call<any>('snapshot');
  const checkFailures = (state: any) => {
    if (state.calls.some((c: ObservedCall) => c.state === 'failed' || c.result?.truncated)
      || state.jobs.some((j: any) => j.error && j.error !== 'source_changed') || state.status.error)
      throw new Error('evaluation-background-or-model-failed');
    if (options.kind === 'live' && state.calls.some((c: ObservedCall) => c.state === 'returned' && (!c.transport.length
      || c.transport.some((t) => t.versions.length !== 1 || t.versions[0] !== options.model || !t.finish.includes('STOP')))))
      throw new Error('evaluation-model-metadata-incomplete');
  };
  async function settled(center: BodyClient, satellite: BodyClient) {
    return until(async () => {
      const state = await snapshot(center); checkFailures(state);
      const observed = new Set(state.receipts.filter((r: any) => r.processor === 'semantic-v1').map((r: any) => r.source));
      // 宿主在来源队列空闲后进入 review 时仍可暂报 idle；必须另核对调用 / 租约，不能提前释放下一步。
      if (state.calls.some((c: ObservedCall) => c.state === 'running') || state.jobs.some((j: any) => j.state === 'running' || j.state === 'queued')
        || state.messages.some((m: any) => m.mode !== 'ignored' && !observed.has(m.id))
        || state.publications.some((p: any) => p.state !== 'published') || state.status.semantic.state !== 'idle' || state.sync.unpushed) return;
      if (options.retrievalCache) {
        const r = state.status.retrieval;
        if (r.error || r.failure || r.errors || r.blocked) throw new Error('evaluation-vector-failed');
        if (r.state !== 'ready' || !r.current || r.pending !== 0 || r.snapshot !== state.retrievalExpected) return;
      }
      const remote = await snapshot(satellite); checkFailures(remote);
      if (remote.calls.some((c: ObservedCall) => c.state === 'running') || digest(state.records) !== digest(remote.records)
        || state.messages.some((m: any) => !remote.messages.some((r: any) => r.id === m.id))) return;
      return { center: state, satellite: remote };
    }, 'settle');
  }
  try {
    await import('node-datachannel');
    for (const body of ['center', 'satellite']) keys[body] = loadNodeKey(path.join(options.root, body, 'secrets/mesh_ed25519')).nodeKey;
    sync = await fakeSync(keys);
    const remote = path.join(options.root, 'soul.git'), seed = path.join(options.root, 'seed');
    const seedSoul = (remote: string, seed: string, agent: string) => {
      git(options.root, 'init', '--bare', '-b', 'main', remote); fs.mkdirSync(seed); git(seed, 'init', '-b', 'main');
      git(seed, 'config', 'user.name', '合成评测'); git(seed, 'config', 'user.email', 'synthetic@example.invalid');
      fs.writeFileSync(path.join(seed, 'agent.json'), JSON.stringify({ id: agent, name: 'synthetic', displayName: '合成评测' }));
      git(seed, 'add', 'agent.json'); git(seed, 'commit', '-m', '合成评测初始灵魂'); git(seed, 'push', remote, 'main');
    };
    seedSoul(remote, seed, 'x');
    if (options.retrievalCache) write(options.root, 'retrieval-cache.json', await seedPublicRetrievalCache(path.join(options.root, 'center'), options.retrievalCache));
    for (const body of ['center', 'satellite']) {
      clients.push(await startBody(path.join(options.root, body), {
        body, remote, sync: sync.url, keys, kind: options.kind, model: options.model, maxCalls, stubFailAt: options.stubFailAt,
        stubReviewDelayMs: options.stubReviewDelayMs, controlled, vector: !!options.retrievalCache,
      })); bodyNames.push(body);
    }
    let foreign: BodyClient | undefined;
    if (options.track.steps.some((s) => s.scope === 'other-agent')) {
      const remote = path.join(options.root, 'foreign.git');
      seedSoul(remote, path.join(options.root, 'foreign-seed'), 'isolated-evaluation');
      foreign = await startBody(path.join(options.root, 'foreign'), { body: 'foreign', agent: 'isolated-evaluation', storageOnly: true,
        remote, sync: sync.url, keys: {}, kind: options.kind, model: options.model, maxCalls });
      clients.push(foreign); bodyNames.push('foreign');
    }
    const [center, satellite] = clients;
    await until(async () => (await satellite.call<string[]>('connected')).includes('center') ? true : undefined, 'connection', 25000);
    report.bodies = clients.map((c, i) => ({ name: bodyNames[i], pid: c.pid, port: c.port }));
    for (const [index, step] of options.track.steps.entries()) {
      const point = `${options.track.id}/${step.id}`, before = Date.now();
      await Promise.all(clients.map((c) => c.call('phase', { value: point })));
      if (controlled) { await settled(center, satellite); await center.call('controlledHold'); }
      const disconnect = options.disconnectStep === index + 1;
      if (disconnect) {
        await satellite.call('connection', { online: false });
        await until(async () => (await center.call<string[]>('connected')).length === 0
          && (await satellite.call<string[]>('connected')).length === 0 ? true : undefined, 'disconnect');
      }
      const producer = step.scope === 'other-agent' ? foreign! : step.body === 'A' ? center : satellite;
      const consumer = step.body === 'A' ? satellite : center;
      const source = await producer.call<number>('source', { ...step, scope: step.scope === 'other-agent' ? 'accessible' : step.scope,
        query: undefined, operation: undefined, session: `source-${index + 1}` });
      let isolation: any = { policy: step.scope };
      if (disconnect) {
        const offline = { center: await snapshot(center), satellite: await snapshot(satellite),
          reading: await satellite.rpc('memory.adaptive.semantic.query', { query: step.query }) };
        write(options.root, `offline-${index + 1}.json`, offline);
        if (offline.center.messages.some((m: any) => m.id === source) || !offline.satellite.messages.some((m: any) => m.id === source)
          || offline.reading.status !== 'unavailable') throw new Error('evaluation-offline-invalid');
        await satellite.call('connection', { online: true });
        await until(async () => (await satellite.call<string[]>('connected')).includes('center') ? true : undefined, 'reconnection', 25000);
        isolation = { ...isolation, disconnected: true, offlineHash: digest(offline) };
      }
      if (step.scope === 'other-agent') {
        const state = await snapshot(foreign!);
        if (state.agent !== 'isolated-evaluation' || state.calls.length || !(state.messages.some((m: any) => m.id === source && m.text === step.text)))
          throw new Error('evaluation-foreign-input-failed');
        isolation = { ...isolation, foreign: state, probe: await satellite.call('probeScope', { foreignAgent: state.agent, query: step.query }) };
        if (!isolation.probe.rejected) throw new Error('evaluation-cross-agent-accepted');
      } else await until(async () => {
        const a = await snapshot(center), b = await snapshot(satellite); checkFailures(a);
        return [a, b].every((s) => s.messages.some((m: any) => m.id === source && m.text === step.text && m.ts === Date.parse(step.at)
          && (step.scope !== 'denied' || m.mode === 'ignored'))) ? true : undefined;
      }, 'replication');
      let control: unknown;
      if (controlled) {
        control = await center.call('controlledApply', { source, operation: step.operation });
        // 先落盘真实安装证据，再恢复后台；后续模型失败也不会丢失撤回现场。
        write(options.root, `controlled-${index + 1}.json`, control);
        await center.call('controlledResume');
      }
      const preAnswer = await settled(center, satellite);
      const lexical = options.retrievalCache ? await center.call('lexical', { query: step.query }) : undefined;
      const readingStarted = performance.now();
      const reading = await consumer.rpc('memory.adaptive.semantic.query', { query: step.query }, stepTimeoutMs);
      const readingElapsedMs = performance.now() - readingStarted;
      const afterReading = options.retrievalCache ? await snapshot(center) : undefined;
      const session = `answer-${index + 1}`, answerStarted = Date.now();
      const answer = await consumer.rpc('chat.send', { conv: session, text: step.query }, stepTimeoutMs);
      const answerElapsedMs = Date.now() - answerStarted, plan = await consumer.call('plan', { session });
      // 查询和回答按正常产品历史留存；等待它们的后台处理，再发布下一步骤。
      const postAnswer = await settled(center, satellite);
      if (step.scope === 'other-agent' && [preAnswer, postAnswer].some((states) => [states.center, states.satellite].some((s: any) =>
        s.messages.some((m: any) => m.body === 'foreign') || s.calls.some((c: ObservedCall) => JSON.stringify(c.request).includes(step.text)))))
        throw new Error('evaluation-foreign-source-leaked');
      const checkpoint = { point, source, producer: step.scope === 'other-agent' ? 'foreign' : step.body, answerBody: step.body === 'A' ? 'B' : 'A',
        isolation, ...(controlled ? { control } : {}), preAnswer, reading, postAnswer, answer, plan,
        ...(options.retrievalCache ? { lexical, readingElapsedMs, retrievalReading: afterReading.retrievalCalls.slice(preAnswer.center.retrievalCalls.length) } : {}),
        elapsedMs: Date.now() - before, answerElapsedMs };
      write(options.root, `checkpoint-${index + 1}.json`, checkpoint);
      report.checkpoints.push({ point, source, file: `checkpoint-${index + 1}.json`, sha256: digest(checkpoint), elapsedMs: checkpoint.elapsedMs, answerElapsedMs });
    }
    report.status = 'pipeline-completed-needs-review';
  } catch (error) {
    report.status = 'failed'; report.failure = error instanceof Error && /^evaluation-[a-z-]+$/.test(error.message) ? error.message : 'evaluation-run-failed';
  } finally {
    for (const [index, client] of clients.entries()) {
      try { write(options.root, `final-body-${index + 1}.json`, await snapshot(client)); } catch { report.finalSnapshotMissing = true; }
    }
    report.shutdown = await Promise.all(clients.map((c) => c.stop()));
    for (const [index, body] of bodyNames.entries()) if (clients[index]) {
      try {
        const evidence = JSON.parse(fs.readFileSync(path.join(options.root, body, 'shutdown-evidence.json'), 'utf8'));
        report.shutdown[index].evidenceHash = digest(evidence);
      } catch { report.finalSnapshotMissing = true; }
    }
    sync?.close();
    if (report.shutdown.some((s: any) => s.forced || s.exitCode !== 0) || report.finalSnapshotMissing) report.status = 'failed';
    report.elapsedMs = Date.now() - started; write(options.root, 'result.json', report);
  }
  return report;
}

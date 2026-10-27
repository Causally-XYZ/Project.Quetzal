// 真实多身体 / 原生向量工程验收；生成模型使用替身，不能当指代语义成绩。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { runTrack, type InputTrack } from '../adaptive-eval/run-track.ts';
import { semanticDigest } from '../../src/memory/adaptive-query.ts';

const retrievalCache = fs.realpathSync(process.argv[2]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-vector-multibody-'));
const step = (id: string, body: 'A' | 'B', text: string, query: string) => ({ id, at: `2026-0${id.slice(1)}-10T12:00:00Z`, body,
  role: 'user' as const, scope: 'accessible' as const, speaker: 'owner', text, query });
const tracks: InputTrack[] = [
  { id: 'vector-paraphrase-development', setup: 'empty', steps: [
    step('S1', 'A', '我在海边的蓝色船屋遇到一位修旧钟的老人，想把这段经历写进小说。', 'Who repairs antique clocks in the blue waterfront workshop?'),
    step('S2', 'B', '另一次散步经过了山上的紫色灯塔。', 'What do we know about the elderly clock repairer by the sea?'),
  ] },
  { id: 'vector-withdrawal-development', setup: 'and-or-graph', steps: [
    step('S1', 'B', '合成证据实验：K 表示渡口恢复通航，支持组 G1 同时需要 A 与 B，独立组 G2 只需 C；另有独立结论 L。A、B、C 都存在。循环 K→A 不提供新独立证据。', '当前 K 和 L 有哪些依据？'),
    { ...step('S2', 'A', '撤回依据 A。B、C 和独立结论 L 没有变化。', '撤回 A 后 K 和 L 有哪些依据？'), operation: { type: 'withdraw-premise', target: 'A' } },
    { ...step('S3', 'B', '再撤回依据 C。没有新的依据，也没有修改 L。', '现在 K 和 L 还有哪些依据？'), operation: { type: 'withdraw-premise', target: 'C' } },
  ] },
];
const report: any = { kind: 'real-vector-multibody-stub-generation', root, results: [], checks: [] };
console.log(JSON.stringify({ root, kind: report.kind }));
try {
  for (const track of tracks) {
    const directory = path.join(root, track.id);
    const result = await runTrack({ root: directory, track, kind: 'stub', model: 'gemini-3.8-flash', retrievalCache,
      disconnectStep: track.setup === 'and-or-graph' ? 3 : 2, stepTimeoutMs: 120000 });
    report.results.push(result); assert.equal(result.status, 'pipeline-completed-needs-review');
    const checkpoints = track.steps.map((_, i) => JSON.parse(fs.readFileSync(path.join(directory, `checkpoint-${i + 1}.json`), 'utf8')));
    for (const [i, cp] of checkpoints.entries()) {
      assert.equal(cp.preAnswer.center.status.retrieval.snapshot, cp.preAnswer.center.retrievalExpected);
      assert.equal(cp.preAnswer.center.status.retrieval.pending, 0);
      assert(cp.preAnswer.center.status.retrieval.indexed > 0);
      assert.equal(cp.preAnswer.satellite.status.retrieval.state, 'inactive');
      assert.equal(cp.preAnswer.satellite.retrievalCalls.length, 0);
      assert(!fs.existsSync(path.join(directory, 'satellite/data/adaptive-retrieval/component')));
      assert(cp.retrievalReading.some((c: any) => c.queryHash === semanticDigest(track.steps[i].query) && c.state === 'neighbors' && c.keys.length));
      assert.equal(cp.reading.status, 'ready'); assert(cp.readingElapsedMs < 500);
      const answering = cp.postAnswer[cp.answerBody === 'A' ? 'center' : 'satellite'];
      const actual = answering.calls.findLast((c: any) => c.purpose === 'conversation' && c.phase === cp.point);
      assert(actual); assert(cp.plan.selectedIds.some((id: string) => id.startsWith('memory:adaptive-semantic:')));
      assert(cp.reading.items.some((item: any) => actual.request.messages.some((m: any) => m.content.includes(JSON.stringify(item)))));
      if (track.setup === 'empty') {
        assert(cp.reading.items.some((r: any) => r.text.includes('修旧钟的老人')));
        if (i === 0) assert.equal(cp.lexical.items.length, 0, '中英改述由真实向量补回，不靠已有词面命中');
      } else {
        const graph = cp.preAnswer.center.controlled;
        assert.equal(cp.reading.items.some((r: any) => r.id === graph.K.id), i < 2);
        assert(cp.reading.items.some((r: any) => r.id === graph.L.id));
        assert.equal(graph.K.evidence.status, i < 2 ? 'supported' : 'unsupported');
        assert.deepEqual(graph.K.evidence.groups.sort(), i === 0 ? ['G1', 'G2'] : i === 1 ? ['G2'] : []);
      }
    }
    const final = checkpoints.at(-1); assert.equal(final.isolation.disconnected, true);
    const offline = JSON.parse(fs.readFileSync(path.join(directory, `offline-${track.steps.length}.json`), 'utf8'));
    assert.equal(offline.reading.status, 'unavailable');
    assert(!offline.center.messages.some((m: any) => m.id === final.source));
    assert.equal(final.postAnswer.center.messages.find((m: any) => m.id === final.source).text, track.steps.at(-1)!.text);
    assert(result.shutdown.every((s: any) => !s.forced && s.exitCode === 0 && s.evidenceHash));
    for (const stopped of result.shutdown) assert.throws(() => process.kill(stopped.pid, 0), { code: 'ESRCH' });
    report.checks.push({ track: track.id, checkpoints: checkpoints.length,
      readMs: checkpoints.map((c: any) => c.readingElapsedMs), centerOnly: true, offlineCatchup: true });
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error instanceof assert.AssertionError ? error.message : 'multibody-probe-failed'; process.exitCode = 1; }
finally { fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' }); console.log(JSON.stringify({ root, status: report.status, checks: report.checks, failure: report.failure })); }

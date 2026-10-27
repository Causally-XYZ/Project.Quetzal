// M2 评测数据与证据口径；独立于生产认识结构，禁止把预期答案送给被测模型。
import crypto from 'node:crypto';

export const families = ['AM-01', 'AM-02', 'AM-03', 'AM-04', 'AM-05', 'AM-06', 'AM-07', 'AM-09', 'AM-10', 'AM-16'] as const;
export const metrics = ['invariant', 'identitySafety', 'binding', 'correction', 'preservation', 'timeEvidenceSafety', 'requiredFields'] as const;
export type Metric = typeof metrics[number];
export type Surface = 'records' | 'material' | 'answer' | 'sources' | 'events';
export interface Check {
  id: string; metric: Metric; requirement: string; sources: string[]; surfaces: Surface[];
}
export interface Step {
  id: string; at: string; body: 'A' | 'B'; speaker: string;
  role: 'user' | 'assistant-summary'; scope: 'accessible' | 'denied' | 'other-agent';
  text: string; query: string; checks: Check[];
  operation?: { type: 'withdraw-premise'; target: 'A' | 'C' };
}
export interface Track { id: string; setup: 'empty' | 'and-or-graph'; steps: Step[] }
export interface Case { id: string; family: typeof families[number]; variant: number; tracks: Track[] }
export interface Suite {
  schema: 'quetzal-m2-eval-v1'; id: string; repeats: 3; cases: Case[];
}
export const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (): never => { throw new Error('评测数据形状、范围或检查点不合法'); };
const label = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(s);
const text = (s: unknown): s is string => typeof s === 'string' && !!s.trim() && s.length <= 8000;
const fields = (value: unknown, keys: string[]) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k))) fail(); };

export function validateSuite(value: unknown): asserts value is Suite {
  const s = value as Suite;
  fields(s, ['schema', 'id', 'repeats', 'cases']);
  if (!s || s.schema !== 'quetzal-m2-eval-v1' || !label(s.id) || s.repeats !== 3 || !Array.isArray(s.cases) || s.cases.length !== 50) fail();
  const ids = new Set<string>();
  for (const c of s.cases) {
    fields(c, ['id', 'family', 'variant', 'tracks']);
    if (!c || !families.includes(c.family) || !Number.isInteger(c.variant) || c.variant < 1 || c.variant > 5
      || c.id !== `${c.family}-H${c.variant}` || ids.has(c.id) || !Array.isArray(c.tracks) || !c.tracks.length || c.tracks.length > 3) fail();
    ids.add(c.id); const tracks = new Set<string>();
    for (const t of c.tracks) {
      fields(t, ['id', 'setup', 'steps']);
      if (!label(t.id) || tracks.has(t.id) || !['empty', 'and-or-graph'].includes(t.setup) || !Array.isArray(t.steps) || !t.steps.length || t.steps.length > 8) fail();
      tracks.add(t.id); const sources = new Set<string>();
      for (const p of t.steps) {
        fields(p, ['id', 'at', 'body', 'speaker', 'role', 'scope', 'text', 'query', 'checks', 'operation']);
        if (!label(p.id) || sources.has(p.id) || !text(p.text) || !text(p.query) || !text(p.speaker)
          || !['A', 'B'].includes(p.body) || !['user', 'assistant-summary'].includes(p.role)
          || !['accessible', 'denied', 'other-agent'].includes(p.scope)
          || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(p.at) || !Number.isFinite(Date.parse(p.at))
          || !Array.isArray(p.checks) || !p.checks.length) fail();
        if (new Date(p.at).toISOString().replace('.000Z', 'Z') !== p.at) fail();
        sources.add(p.id); const checks = new Set<string>();
        if (p.operation) {
          fields(p.operation, ['type', 'target']);
          if (t.setup !== 'and-or-graph' || p.operation.type !== 'withdraw-premise' || !['A', 'C'].includes(p.operation.target)) fail();
        }
        for (const a of p.checks) {
          fields(a, ['id', 'metric', 'requirement', 'sources', 'surfaces']);
          if (!label(a.id) || checks.has(a.id) || !metrics.includes(a.metric) || !text(a.requirement)
            || !Array.isArray(a.sources) || !a.sources.length || new Set(a.sources).size !== a.sources.length || a.sources.some((id) => !sources.has(id))
            || !Array.isArray(a.surfaces) || !a.surfaces.length || new Set(a.surfaces).size !== a.surfaces.length
            || a.surfaces.some((x) => !['records', 'material', 'answer', 'sources', 'events'].includes(x))) fail();
          checks.add(a.id);
        }
      }
    }
  }
  for (const family of families) if (s.cases.filter((c) => c.family === family).length !== 5) fail();
}

/** 到当前步骤为止的投递操作，不是模型输入；包含必须投到隔离库的负例。预期与未来步骤不返回。 */
export function releasedActions(suite: Suite, caseId: string, trackId: string, stepId: string): Omit<Step, 'checks' | 'query'>[] {
  const track = suite.cases.find((c) => c.id === caseId)?.tracks.find((t) => t.id === trackId);
  const index = track?.steps.findIndex((p) => p.id === stepId) ?? -1;
  if (!track || index < 0) throw new Error('评测检查点不存在');
  return track.steps.slice(0, index + 1).map(({ checks: _checks, query: _query, ...input }) => structuredClone(input));
}

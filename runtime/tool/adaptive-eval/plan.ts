// 正式执行的不可变绑定；只有干净、相同代码和完整配置才能继续同一计划。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { digest, validateSuite, type Suite } from './spec.ts';
import { proposalResponseSchema } from '../../src/memory/adaptive-proposal.ts';

export const sha256 = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
export function loadSuite(version: 'v1' | 'v2' = 'v1'): Suite {
  if (!['v1', 'v2'].includes(version)) throw new Error('冻结题库版本不支持');
  const file = new URL(`./holdout-${version}.json`, import.meta.url), manifestFile = new URL(`./manifest-${version}.json`, import.meta.url);
  if (!fs.existsSync(file) || !fs.existsSync(manifestFile)) throw new Error(`冻结题库 ${version} 尚未提供`);
  const bytes = fs.readFileSync(file), suite: unknown = JSON.parse(bytes.toString());
  validateSuite(suite);
  if (suite.schema !== (version === 'v1' ? 'quetzal-m2-eval-v1' : 'quetzal-m5-eval-v2')) throw new Error('冻结题库版本不匹配');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.fileSha256 !== sha256(bytes) || manifest.suiteHash !== digest(suite) || manifest.caseHashes?.length !== suite.cases.length
    || suite.cases.some((c, i) => manifest.caseHashes[i]?.id !== c.id || manifest.caseHashes[i]?.sha256 !== digest(c))) throw new Error('冻结案例摘要不匹配');
  return suite;
}
export function codeSnapshot(repo: string) {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('正式计划需要干净工作区');
  const files = git('ls-files').split('\n').filter((f) => /^(engine\/src\/|runtime\/src\/|runtime\/components\/|runtime\/tool\/adaptive-|runtime\/test\/fixtures\/fake-sync\.ts$|(?:engine|runtime)\/(?:package(?:-lock)?\.json|tsconfig\.json)$)/.test(f));
  const code = files.sort().map((file) => ({ file, sha256: sha256(fs.readFileSync(path.join(repo, file))) }));
  return { revision: git('rev-parse', 'HEAD'), codeHash: digest(code), code };
}
export function executionConfiguration(kind: 'live' | 'stub') {
  return {
    kind, routes: { main: ['gemini-3.8-flash'], strong: [], quick: [], fallback: 'none' },
    provider: { protocol: 'google-generative-ai', context: 131072, maxTokens: 16384, temperature: 'provider-default', thinking: 'provider-default',
      structuredOutput: 'proposal-only-native-schema', transport: kind === 'live' ? 'adc-google-adapter' : 'in-process-stub' },
    host: { adaptiveMemory: true, semantic: true, memorySemantic: false, memoryLearning: false, sentinel: false,
      otherHistory: 'normal', sourceProcessor: 'semantic-v1', bodyCount: 'two-plus-isolated-foreign-when-required' },
    input: { clock: 'store-with-synchronous-record-clock', queries: 'normal-persistent', denied: 'ignored-at-insert',
      foreign: 'separate-agent-process-no-mesh-no-model', assistantSummary: 'agent-role', future: 'stepwise',
      graph: 'archive-accept-initial-and-or-cycle;withdraw-A-then-C;resume-normal-review' },
    retrieval: kind === 'live' ? 'real-vector-public-cache-prefilled' : 'lexical-only-component-preparation-disabled',
    budgets: { maxCallsPerBody: 36, stepTimeoutMs: 180000, proposalMs: 150000, idleMs: 90000, contentIdleMs: 180000,
      retry: 'stop-track-on-first-observed-error;retain-all-observed-production-attempts', repeat: 3 },
    fullEvidence: true, disconnectStep: null,
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
  };
}
// 评测侧固定副本；测试捕获 researchNext 实际生成的 prompt.schema 核对，不改生产提示。
export function researchPlanSchema() {
  return { type: 'OBJECT', properties: { question: { type: 'STRING' }, query: { type: 'STRING' } },
    required: ['question', 'query'], propertyOrdering: ['question', 'query'] };
}
function executionConfigurationV2(kind: 'live' | 'stub') {
  const old = executionConfiguration(kind);
  return { ...old,
    provider: { ...old.provider, thinking: kind === 'live' ? 'LOW' : 'provider-default', structuredOutput: 'proposal-and-research-planning-native-schema' },
    host: { ...old.host, memoryLearning: true, research: { processor: 'research-v1', empty: true, 'and-or-graph': false } },
    baseline: null,
    input: { ...old.input, mode: 'normal-converse-eligible', clock: 'synchronous-source-record-clock;prompt-and-answer-clock-remain-real',
      converse: 'empty-accessible-user-only', graph: 'source-fixture-and-controlled-archive;research-disabled;resume-normal-review' },
    budgets: { ...old.budgets, maxCallsPerBody: 100, stepTimeoutMs: 300000,
      timeoutScope: 'each-operation-and-settle;not-whole-step', backgroundRetries: true,
      retry: 'retain-all-background-attempts;require-settled-and-final-task-completion;stop-on-foreground-failure-or-truncation',
      research: { taskMs: 150000, maxPlanningCalls: 3, maxProposalCalls: 1, sharedTaskDeadline: true,
        maxOutputTokensPerCall: 16384, maxSources: 100, maxRecords: 1000, maxContextBytes: 160 * 1024, maxNewClaims: 3,
        triggers: 'all-eligible-user-or-ambient-sources-including-persistent-queries' } },
  };
}
export function makePlan(suite: Suite, code: ReturnType<typeof codeSnapshot>, kind: 'live' | 'stub') {
  if (suite.schema === 'quetzal-m5-eval-v2') return {
    schema: 'quetzal-m5-plan-v2' as const, suiteHash: digest(suite), processorRevision: code.revision,
    configuration: { ...executionConfigurationV2(kind), prompt: { schemaHash: digest(proposalResponseSchema()), researchPlanSchemaHash: digest(researchPlanSchema()),
      templates: code.code.filter((entry) => /(?:adaptive-(?:proposal|graphiti|research|model|review)|mind\/(?:prompt|context))\.ts$/.test(entry.file)) } }, codeHash: code.codeHash,
  };
  if (suite.schema !== 'quetzal-m2-eval-v1') throw new Error('执行题库版本不支持');
  return { schema: 'quetzal-m2-plan-v1' as const, suiteHash: digest(suite), processorRevision: code.revision,
    configuration: { ...executionConfiguration(kind), prompt: { schemaHash: digest(proposalResponseSchema()),
      templates: code.code.filter((entry) => /(?:adaptive-proposal|adaptive-graphiti|mind\/prompt|mind\/context)\.ts$/.test(entry.file)) } }, codeHash: code.codeHash };
}
export type ExecutionPlan = ReturnType<typeof makePlan>;
/** 正式执行与证据核对共用同一配置投影；不向 v1 添加新字段。 */
export function trackConfiguration(plan: ExecutionPlan, setup: 'empty' | 'and-or-graph') {
  if (!['empty', 'and-or-graph'].includes(setup)) throw new Error('执行轨迹类型不支持');
  const base = { model: plan.configuration.routes.main[0], maxCalls: plan.configuration.budgets.maxCallsPerBody,
    stepTimeoutMs: plan.configuration.budgets.stepTimeoutMs, fullEvidence: true as const };
  return plan.schema === 'quetzal-m5-plan-v2' ? { ...base, inputMode: 'normal-converse-eligible' as const,
    ...(plan.configuration.kind === 'live' ? { thinkingLevel: 'LOW' as const } : {}),
    research: plan.configuration.host.research[setup], backgroundRetries: plan.configuration.budgets.backgroundRetries } : base;
}
export function verifyPlan(plan: unknown, suite: Suite, code: ReturnType<typeof codeSnapshot>, currentRuntime = true): ExecutionPlan {
  const kind = (plan as ExecutionPlan)?.configuration?.kind;
  if (!['live', 'stub'].includes(kind) || !code || !/^[a-f0-9]{40}$/.test(code.revision) || !Array.isArray(code.code) || !code.code.length
    || code.codeHash !== digest(code.code) || new Set(code.code.map((x) => x.file)).size !== code.code.length
    || code.code.some((x) => typeof x.file !== 'string' || !/^(engine|runtime)\//.test(x.file) || x.file.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(x.sha256)))
    throw new Error('执行计划代码清单不合法');
  const expected = makePlan(suite, code, kind);
  if ((plan as ExecutionPlan)?.schema !== expected.schema) throw new Error('执行计划与题库版本不匹配');
  if (!currentRuntime) {
    const runtime = (plan as ExecutionPlan)?.configuration?.runtime;
    if (!runtime || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(runtime.node) || !/^[a-z0-9]{1,20}$/.test(runtime.platform) || !/^[a-z0-9]{1,20}$/.test(runtime.arch))
      throw new Error('执行计划运行环境缺失');
    const schemaHash = (plan as ExecutionPlan)?.configuration?.prompt?.schemaHash;
    if (!/^[a-f0-9]{64}$/.test(schemaHash ?? '')) throw new Error('归档提案格式摘要缺失');
    // 历史评分绑定归档格式；不能因当前提案格式升级就无法审查旧失败。
    // 原始调用的实际 responseSchema 还会在 collectReceipt 中核对此摘要。
    expected.configuration.prompt.schemaHash = schemaHash;
    if (expected.schema === 'quetzal-m5-plan-v2') {
      const researchHash = (plan as ExecutionPlan).configuration.prompt.researchPlanSchemaHash;
      if (!/^[a-f0-9]{64}$/.test(researchHash ?? '')) throw new Error('归档研究规划格式摘要缺失');
      expected.configuration.prompt.researchPlanSchemaHash = researchHash!;
    }
    expected.configuration.runtime = runtime;
  }
  if (digest(plan) !== digest(expected)) throw new Error('执行计划、配置或代码不匹配');
  return plan as ExecutionPlan;
}
export function readEvidence(root: string, file: string, limit = 32 * 1024 * 1024) {
  const base = fs.realpathSync(root), full = fs.realpathSync(path.join(base, file));
  if (!full.startsWith(base + path.sep) || !fs.statSync(full).isFile() || fs.statSync(full).size > limit) throw new Error('执行证据路径或大小不合法');
  const bytes = fs.readFileSync(full); return { data: JSON.parse(bytes.toString()), sha256: sha256(bytes), file };
}
export const saveNew = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx' });

// 只读检查/评分入口，不启动模型、不生成审核结论、不覆盖冻结数据或旧成绩。
import fs from 'node:fs';
import path from 'node:path';
import { digest } from './spec.ts';
import { loadSuite, verifyPlan, type codeSnapshot } from './plan.ts';
import { scoreSuite, scoreSequenceSuite, checkpoints } from './score.ts';
import { selectedReceipt, validateSelection } from './review.ts';

const [mode = '--check', root, flag, selectionFile, ...extra] = process.argv.slice(2);
if (extra.length || !['--check', '--score'].includes(mode) || mode === '--check' && (root !== undefined && !['v1', 'v2'].includes(root) || flag || selectionFile)
  || mode === '--score' && (!root || (flag !== undefined || selectionFile !== undefined) && (flag !== '--reviews' || !selectionFile)))
  throw new Error('用法：--check [v1|v2] 或 --score <仓库外评测目录> [--reviews <相对审核清单路径>]');
if (mode === '--check') {
  const suite = loadSuite(root === 'v2' ? 'v2' : 'v1');
  const points = suite.cases.flatMap(checkpoints);
  console.log(JSON.stringify({ suite: suite.id, suiteHash: digest(suite), cases: suite.cases.length,
    tracks: suite.cases.reduce((n, c) => n + c.tracks.length, 0), checkpoints: points.length,
    checks: points.reduce((n, p) => n + p.checks.length, 0), plannedSequences: suite.cases.length * suite.repeats, modelCalls: 0 }, null, 2));
} else {
  const directory = fs.realpathSync(root!);
  const read = (file: string, limit: number): unknown => {
    const full = fs.realpathSync(path.join(directory, file));
    if (!full.startsWith(directory + path.sep) || !fs.statSync(full).isFile() || fs.statSync(full).size > limit) throw new Error('评测文件路径或大小不合法');
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  };
  const code = read('code.json', 1024 * 1024) as ReturnType<typeof codeSnapshot>;
  const archived = read('plan.json', 64 * 1024) as { schema?: string };
  if (!['quetzal-m2-plan-v1', 'quetzal-m5-plan-v2'].includes(archived.schema ?? '')) throw new Error('执行计划版本不支持');
  const suite = loadSuite(archived.schema === 'quetzal-m5-plan-v2' ? 'v2' : 'v1');
  const plan = verifyPlan(archived, suite, code, false);
  const selection = selectionFile ? validateSelection(read(selectionFile, 64 * 1024), suite, plan) : undefined;
  const score = suite.schema === 'quetzal-m5-eval-v2' ? scoreSequenceSuite : scoreSuite;
  const result = score(suite, digest(plan), (caseId, repeat) => selectedReceipt(directory, suite.cases.find((c) => c.id === caseId)!, repeat, plan, selection));
  console.log(JSON.stringify({ ...result, reviewSelectionHash: selection ? digest(selection) : null }, null, 2));
  // v2的0仅表示质量票数及已知硬违规检查通过，独立工程门仍在输出中明确未评。
  process.exitCode = ('qualityGate' in result ? result.qualityGate && result.gates.noKnownHardViolation : result.semanticGate) ? 0 : 1;
}

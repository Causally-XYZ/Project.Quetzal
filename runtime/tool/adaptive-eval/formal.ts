// 显式计划与单案例执行入口；不会自动开启150个序列或改写已有运行。缺审核不判语义通过。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeSnapshot, loadSuite, makePlan, verifyPlan, readEvidence, saveNew, trackConfiguration } from './plan.ts';
import { collectReceipt, inputTrack } from './receipt.ts';
import { digest } from './spec.ts';
import { runTrack } from './run-track.ts';

const [mode, target, one, two, cache, ...extra] = process.argv.slice(2);
if (!target || extra.length || !['--init', '--run'].includes(mode)
  || mode === '--init' && (!['stub', 'live'].includes(one) || two !== undefined && !['v1', 'v2'].includes(two) || cache)
  || mode === '--run' && (!/^AM-(01|02|03|04|05|06|07|09|10|16)-H[1-5]$/.test(one ?? '') || !/^[1-3]$/.test(two ?? '')))
  throw new Error('用法：--init <新外部目录> <stub|live> [v1|v2]，或 --run <目录> <案例ID> <重复1..3> [公开组件缓存]');
const repo = fs.realpathSync(fileURLToPath(new URL('../../..', import.meta.url))), code = codeSnapshot(repo);
const root = mode === '--init' ? path.join(fs.realpathSync(path.dirname(path.resolve(target))), path.basename(target)) : fs.realpathSync(target);
if (root === repo || root.startsWith(repo + path.sep)) throw new Error('评测数据必须在仓库外');
const archived = mode === '--run' ? readEvidence(root, 'plan.json', 64 * 1024).data : undefined;
if (archived && !['quetzal-m2-plan-v1', 'quetzal-m5-plan-v2'].includes(archived.schema)) throw new Error('执行计划版本不支持');
const suite = loadSuite(mode === '--init' ? two === 'v2' ? 'v2' : 'v1' : archived.schema === 'quetzal-m5-plan-v2' ? 'v2' : 'v1');
if (mode === '--init') {
  fs.mkdirSync(root); const plan = makePlan(suite, code, one as 'live' | 'stub');
  saveNew(path.join(root, 'code.json'), code); saveNew(path.join(root, 'plan.json'), plan);
  console.log(JSON.stringify({ planHash: digest(plan), kind: one, sequences: 150, modelCalls: 0 }));
} else {
  const plan = verifyPlan(archived, suite, code);
  if (digest(readEvidence(root, 'code.json').data) !== digest(code)) throw new Error('代码清单不匹配');
  if (plan.configuration.kind === 'live' ? !cache : !!cache) throw new Error('live 必须提供固定公开组件缓存，stub 不接受缓存');
  const c = suite.cases.find((item) => item.id === one)!;
  const caseDir = path.join(root, c.id); fs.mkdirSync(caseDir, { recursive: true });
  if (fs.realpathSync(caseDir) !== caseDir) throw new Error('案例目录不能通过符号链接离开计划目录');
  const runRoot = path.join(caseDir, `run-${two}`); fs.mkdirSync(runRoot); // 已启动即占用；崩溃或失败不可覆盖重跑。
  saveNew(path.join(runRoot, 'started.json'), { planHash: digest(plan), caseId: c.id, repeat: Number(two), at: Date.now() });
  let failed = false;
  try {
    // 各轨迹为独立新库；一个轨迹失败仍运行该案例的其他独立轨迹，不向失败轨迹释放未来输入。
    for (const track of c.tracks) await runTrack({ root: path.join(runRoot, track.id), track: inputTrack(track), kind: plan.configuration.kind,
      ...trackConfiguration(plan, track.setup), retrievalCache: cache });
    const receipt = collectReceipt(runRoot, c, Number(two), plan);
    if (Buffer.byteLength(JSON.stringify(receipt)) > 32 * 1024 * 1024) throw new Error('审核回执超过读取上限');
    saveNew(path.join(caseDir, `repeat-${two}.json`), receipt); failed = receipt.status !== 'complete';
    saveNew(path.join(runRoot, 'finished.json'), { status: receipt.status, receiptHash: digest(receipt), reviews: 0 });
    console.log(JSON.stringify({ caseId: c.id, repeat: Number(two), status: receipt.status, reviews: 0, semanticPassed: false }));
  } catch {
    failed = true; saveNew(path.join(runRoot, 'interrupted.json'), { status: 'interrupted', reason: 'execution-or-evidence-incomplete' });
    const receiptFile = path.join(caseDir, `repeat-${two}.json`);
    if (!fs.existsSync(receiptFile)) saveNew(receiptFile, { schema: 'quetzal-m2-receipt-v1', suiteHash: plan.suiteHash,
      planHash: digest(plan), caseId: c.id, repeat: Number(two), kind: plan.configuration.kind, status: 'interrupted', artifacts: [], reviews: [] });
    console.log(JSON.stringify({ caseId: c.id, repeat: Number(two), status: 'interrupted', semanticPassed: false }));
  }
  process.exitCode = failed ? 1 : 0;
}

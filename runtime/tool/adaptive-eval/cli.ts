// 只读检查/评分入口，不启动模型、不生成审核结论、不覆盖冻结数据或旧成绩。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { digest, validateSuite } from './spec.ts';
import { scoreSuite, checkpoints } from './score.ts';

const bytes = fs.readFileSync(new URL('./holdout-v1.json', import.meta.url));
const suite: unknown = JSON.parse(bytes.toString('utf8')); validateSuite(suite);
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest-v1.json', import.meta.url), 'utf8'));
if (manifest.suiteHash !== digest(suite) || manifest.fileSha256 !== crypto.createHash('sha256').update(bytes).digest('hex')
  || manifest.caseHashes?.length !== 50 || suite.cases.some((c, i) => manifest.caseHashes[i]?.id !== c.id || manifest.caseHashes[i]?.sha256 !== digest(c)))
  throw new Error('冻结数据摘要不匹配，不能在原版本上改答案后继续评分');
const [mode = '--check', root, ...extra] = process.argv.slice(2);
if (extra.length || !['--check', '--score'].includes(mode) || mode === '--check' && root || mode === '--score' && !root)
  throw new Error('用法：--check 或 --score <仓库外评测目录>');
if (mode === '--check') {
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
  const plan = read('plan.json', 64 * 1024) as Record<string, unknown>;
  if (!plan || plan.schema !== 'quetzal-m2-plan-v1' || plan.suiteHash !== digest(suite)
    || typeof plan.processorRevision !== 'string' || !/^[a-f0-9]{40}$/.test(plan.processorRevision)
    || !plan.configuration || typeof plan.configuration !== 'object' || Array.isArray(plan.configuration)) throw new Error('评测计划未绑定数据或实现版本');
  const result = scoreSuite(suite, digest(plan), (caseId, repeat) => {
    const name = path.join(caseId, `repeat-${repeat}.json`);
    if (!fs.existsSync(path.join(directory, name))) return undefined;
    return read(name, 32 * 1024 * 1024);
  });
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.semanticGate ? 0 : 1;
}

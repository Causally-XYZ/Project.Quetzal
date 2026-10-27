// 只读检查/评分入口，不启动模型、不生成审核结论、不覆盖冻结数据或旧成绩。
import fs from 'node:fs';
import path from 'node:path';
import { digest } from './spec.ts';
import { loadSuite, verifyPlan, type codeSnapshot } from './plan.ts';
import { scoreSuite, checkpoints } from './score.ts';

const suite = loadSuite();
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
  const code = read('code.json', 1024 * 1024) as ReturnType<typeof codeSnapshot>;
  const plan = verifyPlan(read('plan.json', 64 * 1024), suite, code, false);
  const result = scoreSuite(suite, digest(plan), (caseId, repeat) => {
    const name = path.join(caseId, `repeat-${repeat}.json`);
    if (!fs.existsSync(path.join(directory, name))) return undefined;
    return read(name, 32 * 1024 * 1024);
  });
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.semanticGate ? 0 : 1;
}

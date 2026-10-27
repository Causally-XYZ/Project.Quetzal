// 公开开发资料，沿用已公开的现实人物别名案例；不导入或释放正式留出数据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTrack, type InputTrack } from './run-track.ts';
import { digest } from './spec.ts';
import { vertexModels } from '../adaptive-vertex-transport.ts';

const args = process.argv.slice(2);
if (args.some((a) => !/^--(kind|model|steps)=/.test(a)) || new Set(args.map((a) => a.split('=')[0])).size !== args.length) throw new Error('开发试跑参数不合法');
const value = (key: string, fallback: string) => args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const kind = value('kind', 'stub'), model = value('model', vertexModels[1]), count = Number(value('steps', '3'));
if (!['stub', 'live'].includes(kind) || !vertexModels.includes(model) || ![1, 2, 3].includes(count)) throw new Error('开发模型或步骤不合法');
const source = [
  ['2026-01-10T12:00:00Z', '我的编辑叫周宁，工作室里叫他阿舟。我的弟弟叫周宇，家里也叫他阿舟。', '我的编辑和弟弟分别叫什么？他们的昵称相同，能当成一个人吗？请简短回答，不执行其他操作。'],
  ['2026-04-10T12:00:00Z', '昨晚和阿舟吃饭，他说别急着下结论。我决定周末再去港口采风。', '四月饭友与引语说话人现在能确定吗？采风决定是什么？请简短回答，不执行其他操作。'],
  ['2026-06-10T12:00:00Z', '更正：四月那顿饭的阿舟是我弟弟周宇，不是编辑周宁。另外“别急着下结论”其实是我说的，我上次说反了。周末去港口采风的决定没有变。', '四月饭友是谁，“别急着下结论”是谁说的？编辑叫什么，采风决定变了吗？请简短回答，不执行其他操作。'],
];
const track: InputTrack = { id: 'AM-02-multibody-development-v1', setup: 'empty', steps: source.slice(0, count).map(([at, text, query], i) => ({
  id: `S${i + 1}`, at, text, query, body: i % 2 ? 'A' : 'B', role: 'user', scope: 'accessible', speaker: 'owner',
})) };
const repo = fileURLToPath(new URL('../../..', import.meta.url));
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
// 开发期间也绑定未提交代码的实际字节；这份指纹不是正式计划或干净提交的替代。
const files = git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter((f) =>
  /^(engine\/src\/|runtime\/src\/|runtime\/tool\/adaptive-|runtime\/test\/fixtures\/fake-sync\.ts$|(?:engine|runtime)\/package(?:-lock)?\.json$)/.test(f));
const code = [...new Set(files)].sort().map((file) => ({ file, sha256: digest(fs.readFileSync(path.join(repo, file)).toString('base64')) }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-multibody-development-'));
fs.writeFileSync(path.join(root, 'development-plan.json'), JSON.stringify({ schema: 'quetzal-multibody-development-plan-v1',
  revision: git('rev-parse', 'HEAD'), dirty: !!git('status', '--porcelain'), code, codeHash: digest(code), inputHash: digest(track),
  model, kind, steps: count, maxCallsPerBody: 36, stepTimeoutMs: 180000,
  limits: '公开开发资料；非正式留出、性能基线或真人试用。各次失败保留独立目录。' }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ root, kind, model, steps: count }));
const result = await runTrack({ root: path.join(root, 'track'), track, kind: kind as 'live' | 'stub', model });
console.log(JSON.stringify({ root, status: result.status, checkpoints: result.checkpoints.length, elapsedMs: result.elapsedMs }));
process.exitCode = result.status === 'pipeline-completed-needs-review' ? 0 : 1;

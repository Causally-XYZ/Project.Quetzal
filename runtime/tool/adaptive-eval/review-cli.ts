// 独立于被测模型执行；审核者身份由调用者明确指定，不采纳评语中的自报身份。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './spec.ts';
import type { Review } from './score.ts';
import { loadSuite, readEvidence, verifyPlan, saveNew, type codeSnapshot } from './plan.ts';
import { originalReceipt, reviewPacket, buildReview, saveReview, loadReview, validateSelection } from './review.ts';

const [mode, target, ...args] = process.argv.slice(2);
if (!target || !['--packet', '--record', '--select'].includes(mode)) throw new Error('用法：--packet root case repeat；--record root case repeat agent|human|model draft [previousHash]；--select root name reviewHash...');
const root = fs.realpathSync(target), repo = fs.realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
if (root === repo || root.startsWith(repo + path.sep)) throw new Error('审核资料必须在仓库外');
const suite = loadSuite(), code = readEvidence(root, 'code.json', 1024 * 1024).data as ReturnType<typeof codeSnapshot>;
const plan = verifyPlan(readEvidence(root, 'plan.json', 64 * 1024).data, suite, code, false);
const directory = (name: string) => {
  const full = path.join(root, name); fs.mkdirSync(full, { recursive: true });
  if (fs.realpathSync(full) !== full) throw new Error('审核目录不能使用符号链接'); return full;
};
if (mode === '--select') {
  const [name, ...hashes] = args;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name ?? '') || !hashes.length || hashes.length > 150) throw new Error('审核清单名称或数量不合法');
  const entries = hashes.map((hash) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('审核摘要不合法');
    const metadata = readEvidence(root, `reviews/${hash}.json`, 4 * 1024 * 1024).data;
    const c = suite.cases.find((item) => item.id === metadata.caseId);
    if (!c || !Number.isInteger(metadata.repeat) || metadata.repeat < 1 || metadata.repeat > 3) throw new Error('审核案例不存在');
    const original = originalReceipt(root, c, metadata.repeat, plan);
    loadReview(root, hash, original, c); return { caseId: c.id, repeat: metadata.repeat, reviewHash: hash };
  });
  const selection = validateSelection({ schema: 'quetzal-m2-review-selection-v1', suiteHash: digest(suite), planHash: digest(plan), entries }, suite, plan);
  saveNew(path.join(directory('review-selections'), `${name}.json`), selection);
  console.log(JSON.stringify({ selection: `review-selections/${name}.json`, selectionHash: digest(selection), cases: entries.length }));
} else {
  const [caseId, number, reviewer, draftFile, previous] = args;
  const c = suite.cases.find((item) => item.id === caseId);
  if (!c || !/^[1-3]$/.test(number ?? '') || mode === '--packet' && args.length !== 2
    || mode === '--record' && (args.length < 4 || args.length > 5 || !['agent', 'human', 'model'].includes(reviewer))) throw new Error('审核参数不合法');
  const receipt = originalReceipt(root, c, Number(number), plan), packet = reviewPacket(receipt, c);
  if (mode === '--packet') {
    const hash = digest(packet); saveNew(path.join(directory('review-packets'), `${hash}.json`), packet);
    console.log(JSON.stringify({ packet: `review-packets/${hash}.json`, packetHash: hash, checks: packet.checks.length, kind: receipt.kind }));
  } else {
    const full = fs.realpathSync(draftFile);
    if (!fs.statSync(full).isFile() || fs.statSync(full).size > 4 * 1024 * 1024) throw new Error('审核草稿大小不合法');
    if (previous) loadReview(root, previous, receipt, c);
    const revision = buildReview(receipt, c, JSON.parse(fs.readFileSync(full, 'utf8')), reviewer as Review['reviewer'], previous ?? null);
    const hash = saveReview(root, revision);
    console.log(JSON.stringify({ reviewHash: hash, reviewer, previous: revision.previous, checks: revision.reviews.length, selected: false }));
  }
}

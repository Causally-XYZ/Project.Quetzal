// 真实模型开发案例：顺序释放 AM-01；不是留出集、端到端回答或阶段验收。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveStore } from '../src/memory/adaptive-store.ts';
import { AdaptiveArchive } from '../src/memory/adaptive-archive.ts';
import { normalizeProposal, proposalPrompt } from '../src/memory/adaptive-proposal.ts';
import { publishPending } from '../src/memory/adaptive-publication.ts';
import { dependentRecords } from '../src/memory/adaptive-evidence.ts';

const model = process.argv[2], home = process.argv[3], resume = process.argv[4] === '--resume';
if (!['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'].includes(model) || !home || !path.isAbsolute(home)) throw new Error('请提供指定模型及仓库外绝对输出目录');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const destination = path.resolve(home);
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
const real = fs.realpathSync(destination), repository = fs.realpathSync(repo);
if (real === repository || real.startsWith(`${repository}${path.sep}`)) throw new Error('评测数据必须位于仓库外');
const dbFile = path.join(real, 'pilot.db');
if (fs.existsSync(dbFile) !== resume) throw new Error('新评测需空目录；仅传输失败可用 --resume 继续原目录');
const soul = path.join(real, 'soul'); fs.mkdirSync(soul, { mode: 0o700, recursive: true });
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)');
const queue = new AdaptiveStore(db, 'synthetic-pilot-agent'), archive = new AdaptiveArchive(queue, soul);
const episodes = [
  ['2026-01-10T12:00:00Z', '我的编辑叫周宁，我们工作室都叫他阿舟。我最近采风听到一个故事：父亲总修旧物，却从不肯谈过去。'],
  ['2026-03-10T12:00:00Z', '我弟弟周宇，家里也叫他阿舟。他总觉得我把小说里的父亲写得太坏。'],
  ['2026-04-10T12:00:00Z', '昨晚和阿舟吃饭，他说别急着替父亲下结论。我决定再补几段父亲年轻时的事。'],
  ['2026-06-10T12:00:00Z', '四月那次阿舟是我弟，不是编辑。另外“别急着下结论”其实是我说的，我上次说反了。他当时反而想让我把父亲写得更坏。'],
];
const previous = resume ? JSON.parse(fs.readFileSync(path.join(real, 'report.json'), 'utf8')) : null;
if (resume && (previous.dataset !== 'AM-01-development-v1' || previous.model !== model || previous.results.at(-1)?.apiOk !== false || previous.results.at(-1)?.error !== 'transport-or-timeout'))
  throw new Error('只可继续同模型、同开发集的传输失败；语义 / 格式失败请新建实验');
const results: any[] = previous?.results ?? [];
const retryStep = resume ? results.at(-1).step : 0;
try {
  for (const [index, [at, text]] of episodes.entries()) {
    const id = index + 1;
    if (resume && id < retryStep) continue;
    if (!(resume && id === retryStep)) db.prepare("INSERT INTO messages VALUES(?,?,'user','synthetic',?,?,?,NULL,NULL,NULL)").run(id, Date.parse(at), text, `conversation-${id}`, id % 2 ? 'alpha' : 'beta');
    queue.schedule('semantic-pilot-v1'); const job = queue.claim('semantic-pilot-v1', Date.now(), 300000);
    if (!job || job.source !== id) throw new Error('预期任务未能领取，保持原有队列状态');
    const context = { generation: archive.generation(), current: id, records: archive.current(), sources: Array.from({ length: id }, (_, n) => queue.source(n + 1)!) };
    const prompt = proposalPrompt(context), request = { ...prompt, model, config: { maxOutputTokens: 16384, responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: model === 'gemini-4-argon' ? 'MEDIUM' : model === 'gemini-3.5-flash-lite' ? 'MINIMAL' : 'LOW' } } };
    const promptHash = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
    if (resume && id === retryStep && results.at(-1).promptHash !== promptHash) throw new Error('重试输入快照或提案提示已经改变');
    const attempt = results.filter((r) => r.step === id).length + 1, suffix = attempt > 1 ? `-attempt${attempt}` : '';
    fs.writeFileSync(path.join(real, `request-${id}${suffix}.json`), JSON.stringify(request), { mode: 0o600 });
    let response: any;
    try {
      const raw = execFileSync('python3', ['-B', fileURLToPath(new URL('./adaptive-vertex-proposal.py', import.meta.url))],
        { input: JSON.stringify(request), encoding: 'utf8', timeout: 150000, maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
      response = JSON.parse(raw);
    } catch (error: any) {
      try { response = JSON.parse(String(error.stdout)); } catch { response = { ok: false, error: 'runner-failed', usage: null }; }
    }
    fs.writeFileSync(path.join(real, `response-${id}${suffix}.json`), JSON.stringify(response), { mode: 0o600 });
    const report: any = { step: id, attempt, model, promptHash, apiOk: response.ok, modelVersion: response.modelVersion, latencyMs: response.latencyMs, usage: response.usage, config: response.config };
    try {
      if (!response.ok) throw new Error(response.error);
      const batch = normalizeProposal(response.proposal, context);
      const revised = new Set(batch?.records.map((r) => r.id) ?? []);
      report.reviewCandidates = dependentRecords(context.records, context.records.filter((r) => revised.has(r.id)))
        .filter((r) => !revised.has(r.id));
      const inputs = context.sources.map((s) => ({ id: s.id, revision: s.revision, hash: s.hash }));
      report.accepted = batch ? archive.accept(job, inputs, batch) : archive.complete(job, inputs, context.generation);
      if (!report.accepted) throw new Error('宿主拒绝安装');
      publishPending(queue, soul, () => true);
      fs.writeFileSync(path.join(real, `state-${id}${suffix}.json`), JSON.stringify({ records: archive.current(), evidence: [...archive.assess()] }), { mode: 0o600 });
      report.recordCount = archive.current().length;
    } catch (error: any) {
      report.accepted = false; report.error = String(error.message).slice(0, 120);
      queue.fail(job, 'processor_failed');
    }
    results.push(report); console.log(JSON.stringify(report));
    if (!report.accepted) break; // 保留首个失败，不手工修好模型输出后冒充端到端成功。
  }
  fs.writeFileSync(path.join(real, 'report.json'), JSON.stringify({ dataset: 'AM-01-development-v1', model, results }, null, 2), { mode: 0o600 });
  const latest = new Map(results.map((r) => [r.step, r]));
  if (latest.size !== episodes.length || [...latest.values()].some((r) => !r.accepted)) process.exitCode = 1;
} finally { db.close(); }

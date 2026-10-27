// SQLite 是尚未交付结果的持久发件箱；完整灵魂文件是已发布结果的权威副本。
// 文件按任务 UUID 不可变，重试只补回执；不覆盖同名不同内容，不依赖 SQLite / 文件共同事务。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ARTIFACT_BYTES, ARTIFACT_ID, artifactDigest, parseArtifact, type MemoryArtifact } from './adaptive-artifact.ts';
import type { AdaptiveStore, Publication } from './adaptive-store.ts';

export class PublicationConflict extends Error {}
export const publicationRoot = (soul: string) => path.join(soul, 'notes', 'QuetzalMemory', 'Adaptive');

function safeDirectory(soul: string) {
  for (const dir of [soul, path.join(soul, 'notes'), path.join(soul, 'notes', 'QuetzalMemory'), publicationRoot(soul)]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new PublicationConflict('记忆发布目录不是普通目录');
  }
}
export function publicationMarkdown(document: string, id: string) {
  return `# 自适应记忆结果 · ${id}\n\n> 受管处理存档；发布不代表内容为已确认事实，不作为普通笔记召回。\n\n\`\`\`json\n${document}\n\`\`\`\n`;
}
function readPlain(file: string): string {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > ARTIFACT_BYTES + 1024) throw new PublicationConflict('记忆发布目标不合法');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
}
function syncDirectory(dir: string) {
  // Windows 不支持打开目录作 fsync；文件自身已 flush，掉电持久性不冒充跨平台验收。
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** 原子安装完整文件，目标已存在只核对相同内容。调用方持有灵魂写锁，避免与 Git 合并交错。 */
export function installPublication(soul: string, agent: string, row: Publication, hooks: { prepared?(): void; installed?(): void } = {}): string {
  const artifact = parseArtifact(row.document, agent);
  if (!ARTIFACT_ID.test(row.id) || artifact.id !== row.id || artifactDigest(row.document) !== row.digest) throw new PublicationConflict('记忆发布标识或摘要不匹配');
  safeDirectory(soul);
  const file = path.join(publicationRoot(soul), `${row.id}.md`), text = publicationMarkdown(row.document, row.id);
  if (fs.existsSync(file)) {
    if (readPlain(file) !== text) throw new PublicationConflict('已有记忆结果内容不同，保留原文件');
    syncDirectory(path.dirname(file));
    return file;
  }
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    hooks.prepared?.(); // 故障注入：临时文件已 flush，但尚未安装。
    try { fs.linkSync(tmp, file); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (readPlain(file) !== text) throw new PublicationConflict('并发写入内容不同，保留原文件');
    }
    fs.unlinkSync(tmp); syncDirectory(path.dirname(file));
    hooks.installed?.(); // 故障注入：完整文件已经安装，但 SQLite 还未记录回执。
    return file;
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** 仅解析传输信封；调用者仍必须识别 payload.schema、核对来源与语义状态。 */
export function readPublication(soul: string, id: string, agent: string): MemoryArtifact {
  if (!ARTIFACT_ID.test(id)) throw new Error('记忆发布编号不合法');
  // 读取不创建目录；拒绝父目录链接，不能从另一个灵魂目录借入文件。
  for (const dir of [soul, path.join(soul, 'notes'), path.join(soul, 'notes', 'QuetzalMemory'), publicationRoot(soul)]) {
    const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw new PublicationConflict('记忆发布目录不合法');
  }
  const text = readPlain(path.join(publicationRoot(soul), `${id}.md`));
  const m = /^# 自适应记忆结果 · ([a-f0-9-]+)\n\n> [^\n]+\n\n```json\n([^\n]+)\n```\n$/.exec(text);
  if (!m || m[1] !== id) throw new Error('记忆发布文件不完整或格式未知');
  const artifact = parseArtifact(m[2], agent);
  if (artifact.id !== id) throw new Error('记忆发布编号不匹配');
  return artifact;
}

/** 在宿主锁内调用。失败只保存错误代码；取消 / 急停由每次发布前的宿主门禁检查。 */
export function publishPending(store: AdaptiveStore, soul: string, canPublish: () => boolean, now = Date.now()): number {
  let written = 0;
  for (const row of store.pendingPublications(now)) {
    if (!canPublish()) break;
    try {
      installPublication(soul, store.agent, row);
      if (store.publicationWritten(row.id, row.digest, now)) written++;
    } catch (e) { store.publicationFailed(row.id, e instanceof PublicationConflict ? 'conflict' : 'io', now); }
  }
  return written;
}

/** Git 提交是独立的可恢复阶段；回调必须核对 HEAD 中的完整内容，不能只看命令未抛异常。 */
export async function commitPending(store: AdaptiveStore, canPublish: () => boolean,
  record: (files: { path: string; content: string }[]) => Promise<void>, now = Date.now()): Promise<number> {
  const rows = store.uncommittedPublications(now);
  if (!rows.length || !canPublish()) return 0;
  try {
    await record(rows.map((row) => ({ path: `notes/QuetzalMemory/Adaptive/${row.id}.md`, content: publicationMarkdown(row.document, row.id) })));
    for (const row of rows) store.publicationCommitted(row.id, row.digest);
    return rows.length;
  } catch {
    for (const row of rows) store.publicationCommitFailed(row.id, now);
    return 0;
  }
}

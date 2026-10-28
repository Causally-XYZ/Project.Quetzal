// 管理入口的本机记忆快照。不是全设备镜像，不复制配置、密钥或检索组件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, paths } from '../config.ts';
import { db } from '../store.ts';
import { VERSION } from '../version.ts';
import { restrictToOwner } from '../platform.ts';
import { snapshotSoul } from './soul-sync.ts';
import { ID, copiedRoots, directory, filesIn, digest, syncFile, syncDirectory, manifest, verifyBackupDirectory, type MemoryBackup } from './backup-files.ts';
export type { MemoryBackup } from './backup-files.ts';

const root = () => path.join(paths.data, 'memory-backups');
function backupDir(id: string) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('备份编号不合法');
  directory(paths.data); directory(root());
  const dir = path.join(root(), id); directory(dir); return dir;
}
function summary(m: MemoryBackup) {
  return { id: m.id, createdAt: m.createdAt, agent: m.agent, body: m.body, runtime: m.runtime,
    files: m.files.length, bytes: m.files.reduce((n, f) => n + f.bytes, 0), captureMs: m.captureMs,
    directory: path.join(root(), m.id) };
}

export function verifyMemoryBackup(id: string) {
  const m = verifyBackupDirectory(backupDir(id));
  if (m.id !== id) throw new Error('备份编号与清单不匹配');
  return { ...summary(m), verified: true as const };
}

export function listMemoryBackups() {
  directory(paths.data);
  if (!fs.existsSync(root())) return [];
  directory(root());
  return fs.readdirSync(root()).filter((id) => ID.test(id)).sort().map((id) => {
    try {
      const m = manifest(backupDir(id));
      if (m.id !== id) throw new Error('备份编号与清单不匹配');
      return { ...summary(m), readable: true };
    }
    catch { return { id, readable: false }; }
  }).sort((a, b) => String('createdAt' in a ? a.createdAt : '').localeCompare(String('createdAt' in b ? b.createdAt : '')) || a.id.localeCompare(b.id));
}

let creating = false;
export async function createMemoryBackup() {
  if (creating) throw new Error('正在创建记忆备份');
  creating = true;
  try {
    return await snapshotSoul(() => {
      const start = Date.now(), id = crypto.randomUUID();
      directory(paths.home); directory(paths.data); directory(paths.soul); directory(path.join(paths.soul, '.git'));
      if (!fs.existsSync(root())) fs.mkdirSync(root(), { mode: 0o700 });
      directory(root()); restrictToOwner(root(), 0o700);
      const tmp = fs.mkdtempSync(path.join(root(), '.partial-')), target = path.join(root(), id);
      try {
        // 回调不让出事件循环；正常 runtime 的消息、整合和复制不能在快照中途写入。
        // 额外比较 data_version 和源文件摘要，拒绝观察到的外部写入；不支持多个 runtime 共用家目录。
        const dataVersion = db.prepare('PRAGMA data_version').get()?.data_version;
        const sourceFiles = () => copiedRoots.flatMap((rel) => fs.existsSync(path.join(paths.home, rel)) ? filesIn(paths.home, rel) : []).sort();
        const before = sourceFiles();
        fs.mkdirSync(path.join(tmp, 'data'), { mode: 0o700 });
        db.prepare('VACUUM INTO ?').run(path.join(tmp, 'data/quetzal.db'));
        fs.chmodSync(path.join(tmp, 'data/quetzal.db'), 0o600);
        for (const rel of before) {
          const to = path.join(tmp, rel); fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
          fs.copyFileSync(path.join(paths.home, rel), to, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(to, fs.statSync(path.join(paths.home, rel)).mode & 0o111 ? 0o700 : 0o600);
        }
        const copied = before.map((rel) => digest(tmp, rel));
        if (JSON.stringify(sourceFiles().map((rel) => digest(paths.home, rel))) !== JSON.stringify(copied)
          || db.prepare('PRAGMA data_version').get()?.data_version !== dataVersion) throw new Error('备份期间有外部写入，请稍后重试');
        const agent = JSON.parse(fs.readFileSync(path.join(tmp, 'soul/agent.json'), 'utf8')).id;
        if (typeof agent !== 'string' || !agent) throw new Error('灵魂身份缺失');
        const files = filesIn(tmp).map((rel) => digest(tmp, rel));
        const m: MemoryBackup = { format: 'quetzal-memory-backup-v1', id, createdAt: new Date(start).toISOString(),
          runtime: VERSION, agent, body: config.body, captureMs: Date.now() - start, files };
        fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(m, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        for (const rel of [...files.map((f) => f.path), 'manifest.json']) syncFile(path.join(tmp, rel));
        const dirs = new Set(files.flatMap((f) => {
          const out: string[] = []; let dir = path.dirname(f.path);
          while (dir !== '.') { out.push(dir); dir = path.dirname(dir); } return out;
        }));
        for (const dir of [...dirs].sort((a, b) => b.length - a.length)) syncDirectory(path.join(tmp, dir));
        syncDirectory(tmp); fs.renameSync(tmp, target); syncDirectory(root());
        try { return verifyMemoryBackup(id); }
        catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  } finally { creating = false; }
}

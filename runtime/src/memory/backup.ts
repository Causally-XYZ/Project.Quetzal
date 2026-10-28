// 管理入口的本机记忆快照。不是全设备镜像，不复制配置、密钥或检索组件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config, paths } from '../config.ts';
import { db } from '../store.ts';
import { VERSION } from '../version.ts';
import { restrictToOwner } from '../platform.ts';
import { snapshotSoul } from './soul-sync.ts';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const root = () => path.join(paths.data, 'memory-backups');
const copiedRoots = ['soul', 'data/uploads', 'data/media', 'data/from-bodies', 'data/canvas-runs'];
type Entry = { path: string; bytes: number; sha256: string };
export interface MemoryBackup {
  format: 'quetzal-memory-backup-v1'; id: string; createdAt: string; runtime: string;
  agent: string; body: string; captureMs: number; files: Entry[];
}

function directory(p: string) {
  if (!fs.lstatSync(p).isDirectory()) throw new Error('备份目录不能是链接或普通文件');
}
function filesIn(base: string, rel = ''): string[] {
  directory(path.join(base, rel));
  return fs.readdirSync(path.join(base, rel)).sort().flatMap((name) => {
    const file = rel ? `${rel}/${name}` : name, st = fs.lstatSync(path.join(base, file));
    if (st.isDirectory()) return filesIn(base, file);
    if (!st.isFile() || st.nlink > 1) throw new Error('备份只接受普通文件，不能包含符号链接、硬链接或特殊文件');
    if (file.startsWith('soul/.git/') && file.endsWith('.lock')) throw new Error('灵魂仓库仍有 Git 锁，请待同步完成后重试');
    return [file];
  });
}
function digest(base: string, rel: string): Entry {
  const file = path.join(base, rel), fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024); let bytes = 0;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('备份文件类型改变');
    for (;;) { const n = fs.readSync(fd, buffer); if (!n) break; hash.update(buffer.subarray(0, n)); bytes += n; }
  } finally { fs.closeSync(fd); }
  return { path: rel, bytes, sha256: hash.digest('hex') };
}
function syncFile(file: string) { const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function syncDirectory(dir: string) {
  if (process.platform === 'win32') return; // Windows 不能以普通文件描述符 fsync 目录。
  const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function backupDir(id: string) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('备份编号不合法');
  directory(paths.data); directory(root());
  const dir = path.join(root(), id); directory(dir); return dir;
}
function manifest(dir: string): MemoryBackup {
  const p = path.join(dir, 'manifest.json'), st = fs.lstatSync(p);
  if (!st.isFile() || st.size > 16 * 1024 * 1024) throw new Error('备份清单不合法');
  const value = JSON.parse(fs.readFileSync(p, 'utf8')) as MemoryBackup;
  if (value.format !== 'quetzal-memory-backup-v1' || !ID.test(value.id) || path.basename(dir) !== value.id
    || typeof value.agent !== 'string' || typeof value.body !== 'string' || !Array.isArray(value.files)) throw new Error('备份清单格式不支持');
  return value;
}
function summary(m: MemoryBackup) {
  return { id: m.id, createdAt: m.createdAt, agent: m.agent, body: m.body, runtime: m.runtime,
    files: m.files.length, bytes: m.files.reduce((n, f) => n + f.bytes, 0), captureMs: m.captureMs,
    directory: path.join(root(), m.id) };
}

/** 完整校验，不执行备份中的 Git、钩子或脚本，也不安装到当前家目录。 */
export function verifyMemoryBackup(id: string) {
  const dir = backupDir(id), m = manifest(dir);
  const actual = filesIn(dir).filter((f) => f !== 'manifest.json').map((f) => digest(dir, f));
  if (JSON.stringify(actual) !== JSON.stringify(m.files)) throw new Error('备份文件缺失、增加或内容损坏');
  const saved = new DatabaseSync(path.join(dir, 'data/quetzal.db'), { readOnly: true });
  try {
    if (saved.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('备份数据库完整性检查失败');
    const agent = JSON.parse(fs.readFileSync(path.join(dir, 'soul/agent.json'), 'utf8')).id;
    if (agent !== m.agent) throw new Error('备份身份不匹配');
    if (saved.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adaptive_meta'").get()
      && saved.prepare('SELECT agent FROM adaptive_meta WHERE singleton=1').get()?.agent !== agent) throw new Error('备份认识与灵魂身份不匹配');
  } finally { saved.close(); }
  return { ...summary(m), verified: true as const };
}

export function listMemoryBackups() {
  directory(paths.data);
  if (!fs.existsSync(root())) return [];
  directory(root());
  return fs.readdirSync(root()).filter((id) => ID.test(id)).sort().map((id) => {
    try { return { ...summary(manifest(backupDir(id))), readable: true }; }
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

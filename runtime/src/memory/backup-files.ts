// 备份文件协议：离线校验不加载配置、不执行 Git 或备份内代码。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const copiedRoots = ['soul', 'data/uploads', 'data/media', 'data/from-bodies', 'data/canvas-runs', 'data/restorations'];
type Entry = { path: string; bytes: number; sha256: string };
export interface MemoryBackup {
  format: 'quetzal-memory-backup-v1'; id: string; createdAt: string; runtime: string;
  agent: string; body: string; captureMs: number; files: Entry[];
}

export function directory(p: string) {
  if (!fs.lstatSync(p).isDirectory()) throw new Error('备份目录不能是链接或普通文件');
}
export function filesIn(base: string, rel = ''): string[] {
  directory(path.join(base, rel));
  return fs.readdirSync(path.join(base, rel)).sort().flatMap((name) => {
    const file = rel ? `${rel}/${name}` : name, st = fs.lstatSync(path.join(base, file));
    if (st.isDirectory()) return filesIn(base, file);
    if (!st.isFile() || st.nlink > 1) throw new Error('备份只接受普通文件，不能包含符号链接、硬链接或特殊文件');
    if (file.startsWith('soul/.git/') && file.endsWith('.lock')) throw new Error('灵魂仓库仍有 Git 锁，请待同步完成后重试');
    return [file];
  });
}
export function digest(base: string, rel: string): Entry {
  const file = path.join(base, rel), fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024); let bytes = 0;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('备份文件类型改变');
    for (;;) { const n = fs.readSync(fd, buffer); if (!n) break; hash.update(buffer.subarray(0, n)); bytes += n; }
  } finally { fs.closeSync(fd); }
  return { path: rel, bytes, sha256: hash.digest('hex') };
}
export function syncFile(file: string) { const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
export function syncDirectory(dir: string) {
  if (process.platform === 'win32') return; // Windows 不能以普通文件描述符 fsync 目录。
  const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function manifest(dir: string): MemoryBackup {
  const p = path.join(dir, 'manifest.json'), st = fs.lstatSync(p);
  if (!st.isFile() || st.size > 16 * 1024 * 1024) throw new Error('备份清单不合法');
  const value = JSON.parse(fs.readFileSync(p, 'utf8')) as MemoryBackup;
  if (value.format !== 'quetzal-memory-backup-v1' || !ID.test(value.id)
    || typeof value.agent !== 'string' || typeof value.body !== 'string' || !Array.isArray(value.files)) throw new Error('备份清单格式不支持');
  return value;
}
/** 完整校验，不执行备份中的 Git、钩子或脚本，也不安装到当前家目录。 */
export function verifyBackupDirectory(dir: string): MemoryBackup {
  directory(dir);
  const m = manifest(dir);
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
  return m;
}

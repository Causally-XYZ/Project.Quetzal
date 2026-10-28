// 离线恢复到全新家目录。历史不改号，不把旧身体的执行状态当成新身体的待办。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ID_RANGE, idPrefixOf } from '../store.ts';
import { AdaptiveStore } from './adaptive-store.ts';
import { AdaptiveArchive } from './adaptive-archive.ts';
import { copiedRoots, verifyBackupDirectory, digest, filesIn, syncFile, syncDirectory } from './backup-files.ts';

export const RESTORE_PENDING = '.restore-incomplete';
const retainedKeys = ['store.ids', 'store.message-modes', 'projects', 'personality', 'memory.uses', 'prime.episodes', 'prime.origins', 'prime.learned'];

export function restoreMemoryBackup(from: string, home: string) {
  const source = fs.realpathSync(from), target = path.join(fs.realpathSync(path.dirname(path.resolve(home))), path.basename(path.resolve(home)));
  if (target === source || target.startsWith(source + path.sep)) throw new Error('恢复目标不能位于备份内');
  const manifest = verifyBackupDirectory(source);
  for (const entry of manifest.files) {
    if (entry.path !== 'data/quetzal.db' && !copiedRoots.some((r) => entry.path.startsWith(r + '/'))) throw new Error('备份包含不支持的恢复路径');
  }
  // mkdir 本身拒绝已存在目标，包括空目录与链接，绝不覆盖已运行的家目录。
  fs.mkdirSync(target, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(target, RESTORE_PENDING), manifest.id, { mode: 0o600, flag: 'wx' });
    for (const entry of manifest.files) {
      const dest = path.join(target, entry.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(source, entry.path), dest, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dest, fs.statSync(path.join(source, entry.path)).mode & 0o111 ? 0o700 : 0o600);
    }
    // 逐项复核刚复制的文件，发现复制期间源变化时不继续；标记不属于备份清单。
    if (JSON.stringify(manifest.files.map((f) => digest(target, f.path))) !== JSON.stringify(manifest.files)) throw new Error('复制期间备份发生变化');
    const saved = new DatabaseSync(path.join(target, 'data/quetzal.db'));
    let body: string;
    try {
      if (!saved.prepare("SELECT 1 FROM kv WHERE k='store.ids'").get()) throw new Error('来源编号格式不支持，请先离线迁移备份副本');
      const hasAdaptive = !!saved.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adaptive_meta'").get();
      if (hasAdaptive && saved.prepare('SELECT version FROM adaptive_meta WHERE singleton=1').get()?.version !== 2) throw new Error('认识数据格式不支持，请先离线迁移备份副本');
      const occupied = new Set<number>();
      for (const table of ['messages', 'timeline']) {
        for (const row of saved.prepare(`SELECT DISTINCT CAST(id / ${ID_RANGE} AS INTEGER) AS prefix FROM ${table}`).iterate()) occupied.add(Number(row.prefix));
        for (const row of saved.prepare(`SELECT DISTINCT body FROM ${table} WHERE body IS NOT NULL`).iterate()) occupied.add(idPrefixOf(String(row.body)));
      }
      occupied.add(idPrefixOf(manifest.body));
      const bodyDir = path.join(target, 'soul/bodies');
      if (fs.existsSync(bodyDir)) for (const file of fs.readdirSync(bodyDir)) if (file.endsWith('.json')) occupied.add(idPrefixOf(file.slice(0, -5)));
      for (let attempt = 0;; attempt++) {
        if (attempt === 100) throw new Error('无法分配新的身体编号段');
        body = `restored-${crypto.randomUUID().slice(0, 12)}`;
        if (!occupied.has(idPrefixOf(body))) break;
      }
      const oldState = saved.prepare('SELECT k,v FROM kv ORDER BY k').all();
      const archiveDir = path.join(target, 'data/restorations');
      fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
      // 每次恢复独立存档；再次备份时也会携带，旧提醒和操作状态可查而不参与执行。
      fs.writeFileSync(path.join(archiveDir, `${crypto.randomUUID()}.json`), JSON.stringify({ backup: manifest.id, restoredAt: new Date().toISOString(), fromBody: manifest.body, body, state: oldState }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      saved.prepare(`DELETE FROM kv WHERE k NOT IN (${retainedKeys.map(() => '?').join(',')})`).run(...retainedKeys);
      if (hasAdaptive) {
        // 已接受结果继续存在；只释放原进程占有的租约，取消 / 失败状态不自动复活。
        saved.exec("UPDATE adaptive_jobs SET state='queued',token=NULL,lease=0 WHERE state='running'");
        new AdaptiveArchive(new AdaptiveStore(saved, manifest.agent), path.join(target, 'soul')).checkpoint();
      }
    } finally { saved.close(); }
    for (const dir of ['config', 'state']) fs.mkdirSync(path.join(target, dir), { mode: 0o700 });
    const uuid = crypto.randomUUID();
    fs.writeFileSync(path.join(target, 'state/body-uuid'), JSON.stringify({ uuid, source: 'manual' }) + '\n', { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(target, 'config/quetzal.json'), JSON.stringify({ body, heart: { paused: true }, mesh: { lan: false }, soul: { remote: '' }, adaptiveMemory: { enabled: false, hostBody: '', semantic: false, research: false } }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const files = filesIn(target);
    for (const file of files) syncFile(path.join(target, file));
    const dirs = new Set<string>();
    for (const file of files) for (let dir = path.dirname(file); dir !== '.'; dir = path.dirname(dir)) dirs.add(dir);
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) syncDirectory(path.join(target, dir));
    fs.unlinkSync(path.join(target, RESTORE_PENDING)); syncDirectory(target);
    return { home: target, agent: manifest.agent, body, uuid, backup: manifest.id };
  } catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
}

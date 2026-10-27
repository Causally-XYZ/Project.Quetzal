// 灵魂推送提示只触发真实 Git 拉取；认识文件仍由灵魂仓库校验和合并。
import { bus } from '../bus.ts';
import type { Mesh } from './mesh.ts';

export function installSoulSync(mesh: Mesh) {
  let pulling: NodeJS.Timeout | undefined, stopped = false;
  const pushed = (e: { files: string[] }) => mesh.broadcast('soul.pushed', { files: e.files.slice(0, 50) });
  const event = (e: { name: string }) => {
    if (e.name !== 'soul.pushed') return;
    clearTimeout(pulling);
    pulling = setTimeout(() => {
      void import('../memory/soul-sync.ts').then((s) => stopped ? undefined : s.pull())
        .then(() => { if (!stopped) mesh.reverify(); }).catch(() => {});
    }, 500);
  };
  const sense = (kind: string) => { if (kind === 'soul_synced') mesh.reverify(); };
  bus.on('soul.pushed', pushed); bus.on('sense', sense); mesh.on('event', event);
  return () => {
    stopped = true; clearTimeout(pulling);
    bus.off('soul.pushed', pushed); bus.off('sense', sense); mesh.off('event', event);
  };
}

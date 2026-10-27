// 在仓库外隔离数据目录真实强杀；重新启动只能投递已接受结果，不能再次生成。
import fs from 'node:fs';
import path from 'node:path';
const cfg = await import('../../src/config.ts'); cfg.loadConfig();
const store = await import('../../src/store.ts'); store.openStore();
const { identity } = await import('../../src/memory/identity.ts');
const { AdaptiveStore } = await import('../../src/memory/adaptive-store.ts');
const { installPublication, publicationRoot, publishPending, readPublication, commitPending } = await import('../../src/memory/adaptive-publication.ts');
const { ensureSoul, touched, verifyRecordedFiles } = await import('../../src/memory/soul-sync.ts');
await ensureSoul();
const queue = new AdaptiveStore(store.db, identity().id), point = process.argv[2];
if (!store.kv.get('generated', 0)) {
  const id = store.addMessage('user', '合成', '进程恢复来源'); queue.schedule('crash-test-v1');
  const job = queue.claim('crash-test-v1')!, source = queue.source(id)!;
  queue.acceptResult(job, [{ id, revision: source.revision, hash: source.hash }], { schema: 'synthetic-v1', data: { note: '已经生成的结果' } });
  store.kv.set('generated', 1);
}
if (point === 'accepted') process.kill(process.pid, 'SIGKILL');
const row = queue.pendingPublications()[0];
if (point !== 'recover' && row) installPublication(cfg.paths.soul, identity().id, row, {
  prepared() { if (point === 'prepared') process.kill(process.pid, 'SIGKILL'); },
  installed() { if (point === 'installed') process.kill(process.pid, 'SIGKILL'); },
});
publishPending(queue, cfg.paths.soul, () => true);
await commitPending(queue, () => true, async (files) => {
  await touched({ tool: '合成进程恢复发布' }); await verifyRecordedFiles(files);
  if (point === 'committed') process.kill(process.pid, 'SIGKILL');
});
const files = fs.readdirSync(publicationRoot(cfg.paths.soul)).filter((f) => f.endsWith('.md'));
for (const file of files) readPublication(cfg.paths.soul, path.basename(file, '.md'), identity().id);
process.stdout.write(JSON.stringify({ generated: store.kv.get('generated', 0), files: files.length, pending: queue.pendingPublications().length, written: queue.status().publications.written, published: queue.status().publications.published }));
store.db.close();

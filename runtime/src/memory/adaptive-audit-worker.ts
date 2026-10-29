// 仅打开实时库的只读快照；重用正式重建算法在临时磁盘库核对，不修改权威或实时投影。
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { AdaptiveStore } from './adaptive-store.ts';
import { AdaptiveGraph, projectionDigest } from './adaptive-graph.ts';
import { archiveArtifacts } from './adaptive-authority.ts';
import { graphToken } from './adaptive-integrity.ts';

const { file, scratch, soul, agent, token } = workerData as {
  file: string; scratch: string; soul: string; agent: string; token: string;
};
let live: DatabaseSync | undefined, copy: DatabaseSync | undefined;
try {
  live = new DatabaseSync(file, { readOnly: true }); live.exec('BEGIN');
  const generation = Number(live.prepare('SELECT generation FROM adaptive_graph_meta WHERE singleton=1').get()!.generation);
  if (graphToken(live) !== token) {
    parentPort!.postMessage({ status: 'changed', generation });
  } else {
    copy = new DatabaseSync(path.join(scratch, 'projection.db'));
    copy.exec(`PRAGMA foreign_keys=ON; CREATE TABLE messages(id INTEGER PRIMARY KEY,ts INTEGER,role TEXT,channel TEXT,text TEXT,session TEXT,body TEXT,via TEXT,mode TEXT,attachments TEXT)`);
    const graph = new AdaptiveGraph(new AdaptiveStore(copy, agent));
    let extra = false;
    const snapshot = live;
    function* prefix() {
      for (const artifact of archiveArtifacts(snapshot, soul, agent)) {
        // 文件可能已包含快照之后正常发布的增量；只重放本次快照的有界前缀。
        if ((artifact.payload.data as { baseGeneration: number }).baseGeneration >= generation) { extra = true; continue; }
        yield artifact;
      }
    }
    graph.rebuild(prefix());
    const expected = projectionDigest(copy), actual = projectionDigest(live);
    parentPort!.postMessage({ status: expected && actual === expected ? 'ready' : 'failed', generation, extra });
  }
} catch { parentPort!.postMessage({ status: 'failed', generation: -1 }); }
finally { copy?.close(); if (live) { try { live.exec('ROLLBACK'); } finally { live.close(); } } }

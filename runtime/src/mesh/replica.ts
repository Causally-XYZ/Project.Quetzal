// 复制：同一个 agent 的所有身体共用一份对话、会话与时间线（一个心智）。
//   - 连上一具身体时互相补齐：按版本向量（每个编号段里见过的最大 id）优先取新行，再分页核对较小编号缺口；会话列表整体合并（标题与归档以较新的修改为准）。
//   - 平时本机每写一条（store 发出的 replica 事件），实时广播给连着的身体。
//   - 收到的行幂等写入（applyRemote），不再转发；新的时间线条目照常推给本机的控制台。
//   - 收到的行先检查（store.ts 的 applyRemote）：字段类型与长度、时间、编号段与作者；实时收到的只能是发来的身体自己写的。
//     补齐时不合格的行跳过（版本向量里记下已经看过的位置，不再要）；补齐每批最多 20 万行 / 512 MB，达到后让出一秒再继续；每页让出事件循环。
// 新身体入网时就这样从其他身体补齐全部历史；对话不进 git（DISTRIBUTED.md C5）。
import { setTimeout as pause, setImmediate as yieldTurn } from "node:timers/promises";
import type { Mesh, PeerStatus } from "./mesh.ts";
import { bus } from "../bus.ts";
import { idVector, rowsAfter, allSessions, messageModesAfter, applyRemote, ID_RANGE, type ReplicaTable } from "../store.ts";
import { log } from "../log.ts";

const PAGE_BYTES = 4 << 20;
const TABLES = ["messages", "timeline"] as const;
const REALTIME = new Set<string>(["messages", "timeline", "sessions", "message.mode"]);
const CATCHUP_ROWS = 200_000, CATCHUP_BYTES = 512 << 20; // 连续一批的预算，达到后让出一秒继续

/** 取对方缺的行，按字节数截断（单条消息不会超过 32 MB 的传输上限）。 */
function page(table: "messages" | "timeline", vector: Record<string, number>) {
  const rows = rowsAfter(table, vector, 500);
  const out: any[] = [];
  let bytes = 0;
  for (const r of rows) {
    const n = JSON.stringify(r).length;
    if (out.length && bytes + n > PAGE_BYTES) break;
    out.push(r); bytes += n;
  }
  return out;
}

/** 对方发来的版本向量：只留编号段号 → 有限的整数。 */
function cleanVector(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v).slice(0, 10_000)) if (/^\d{1,7}$/.test(k) && Number.isSafeInteger(n)) out[k] = n as number;
  return out;
}

function apply(table: ReplicaTable, rows: unknown, from: string, catchUp = false) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const { changed, rejected } = applyRemote(table, rows, { from, catchUp });
  if (rejected) log("mesh", `丢弃了 ${from} 发来的 ${rejected} 行不合格的${table}`);
  if (!changed.length) return 0;
  if (table === "timeline") for (const r of changed) { let detail: unknown = null; try { detail = JSON.parse(r.detail); } catch {} bus.emit("timeline", { id: r.id, ts: r.ts, kind: r.kind, title: r.title, detail, body: r.body }); }
  bus.emit("replica.applied", { table, rows: changed, from });
  return changed.length;
}

/** 先按高水位取新行，再以从零游标核对缺口；每页有界，批间让出执行时间。 */
async function pullTable(mesh: Mesh, peer: string, table: typeof TABLES[number], live: () => boolean, reconcile = false) {
  let total = 0, rows = 0, bytes = 0;
  const seen: Record<string, number> = {};
  while (live()) {
    if (rows >= CATCHUP_ROWS || bytes >= CATCHUP_BYTES) {
      await pause(1000, undefined, { ref: false }); rows = 0; bytes = 0;
      if (!live()) break;
    }
    const vector = reconcile ? {} : idVector(table);
    for (const [k, v] of Object.entries(seen)) vector[k] = Math.max(vector[k] ?? 0, v);
    const got = await mesh.request<unknown>(peer, "replica.pull", { table, vector }, 60_000);
    if (!live()) break;
    if (!Array.isArray(got) || got.length > 500) throw new Error('来源分页形状错误');
    if (!got.length) break;
    rows += got.length; bytes += Buffer.byteLength(JSON.stringify(got));
    total += apply(table, got, peer, true);
    let advanced = false;
    for (const r of got) {
      const id = (r as { id?: unknown })?.id;
      if (!Number.isSafeInteger(id)) continue;
      const k = String(Math.floor((id as number) / ID_RANGE));
      if ((id as number) > (vector[k] ?? 0)) { advanced = true; seen[k] = Math.max(seen[k] ?? 0, id as number); }
    }
    if (!advanced) break;
    await yieldTurn();
  }
  return total;
}

/** 从一具刚连上的身体补齐。 */
async function catchUp(mesh: Mesh, peer: string, live: () => boolean) {
  let total = 0;
  try {
    for (const table of TABLES) total += await pullTable(mesh, peer, table, live);
    if (!live()) return;
    const sessions = await mesh.request<unknown>(peer, "replica.sessions", {}, 30_000);
    if (!live()) return;
    total += apply("sessions", sessions, peer, true);
    // 标记独立于新增消息高水位；持续连接时分批续扫，重连从头核对早期消息的新修订。
    // 每页让出事件循环；20 万条后休息一秒再继续，不能永远截掉尾部。
    let after = 0, pages = 0, failures = 0;
    while (live()) {
      let modes: unknown;
      try { modes = await mesh.request<unknown>(peer, 'replica.modes', { after }, 30_000); }
      catch (e) {
        if (!live()) return;
        if (/没有这个方法/.test((e as Error).message)) break;
        if (++failures >= 5) throw e;
        await pause(Math.min(30_000, 1000 * 2 ** (failures - 1)), undefined, { ref: false });
        continue; // 临时传输错误保留游标；没有应用结果时不前进。
      }
      if (!live()) return;
      if (!Array.isArray(modes) || modes.length > 500) throw new Error('消息标记分页形状错误');
      if (!modes.length) break;
      let cursor = after;
      for (const row of modes) {
        if (!row || !Number.isSafeInteger(row.id) || row.id <= cursor) throw new Error('消息标记分页没有递增');
        cursor = row.id;
      }
      total += apply('message.mode', modes, peer, true);
      after = cursor; failures = 0;
      if (++pages % 400 === 0) await pause(1000, undefined, { ref: false });
      else await yieldTurn();
    }
    // 已知最大 ID 不证明更小的行全部存在（断线 / 转发可能留下洞）。
    // 先完成可变标记再核对历史，避免大历史延迟 ignored 等状态的补齐。
    for (const table of TABLES) total += await pullTable(mesh, peer, table, live, true);
    if (total && live()) log("mesh", `从 ${peer} 补齐了 ${total} 条对话、时间线与会话`);
  } catch (e) { if (live()) log("mesh", `从 ${peer} 补齐失败：${(e as Error).message}`); }
}

/** 给一个 Mesh 装上复制。返回卸载函数。 */
export function installReplica(mesh: Mesh): () => void {
  mesh.handle("replica.pull", (p: { table: string; vector: unknown }) => {
    if (!TABLES.includes(p?.table as any)) throw new Error("不支持的表");
    return page(p.table as "messages" | "timeline", cleanVector(p.vector));
  });
  mesh.handle("replica.sessions", () => allSessions());
  mesh.handle('replica.modes', (p: { after: number }) => messageModesAfter(p?.after));

  const open = new Map<string, symbol>();
  const onPeer = (s: PeerStatus) => {
    if (s.link === "open" && !open.has(s.body)) {
      const generation = Symbol(s.body); open.set(s.body, generation);
      void catchUp(mesh, s.body, () => open.get(s.body) === generation);
    }
    else if (s.link !== "open") open.delete(s.body);
  };
  const onLocal = (e: { table: ReplicaTable; rows: any[] }) => mesh.broadcast("replica", e);
  const onEvent = (e: { from: string; name: string; data: any }) => {
    if (e.name === "replica" && e.data && REALTIME.has(e.data.table)) apply(e.data.table, e.data.rows, e.from);
  };
  mesh.on("peer", onPeer);
  mesh.on("event", onEvent);
  bus.on("replica", onLocal);
  return () => { open.clear(); mesh.off("peer", onPeer); mesh.off("event", onEvent); bus.off("replica", onLocal as any); };
}

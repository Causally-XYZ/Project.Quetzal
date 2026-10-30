// 运维脚本：换身份服务时，把老账户的 sub 改成新身份服务里对应账号的 sub，账户下的 agent、身体、灵魂仓库登记原样保留。
// 只在两边「已验证的邮箱」相同时才对应（users.email 本来就只存身份服务确认过的邮箱）；不在登录路径里自动合并。
// 用法：node src/migrate-sub.ts <数据目录> <对应表.json> [--apply]    对应表：[{"email": "已验证的邮箱", "sub": "新身份服务里的 sub"}, …]
// 不加 --apply 只列出会改什么（干跑）；加了先把库备份到 sync.db.bak-<时刻>，再在一个事务里改。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface Mapping { email: string; sub: string }
export interface Plan { change: { id: number; from: string; to: string }[]; skipped: { email: string; why: string }[] }

/** 算出要改什么：邮箱在两边都唯一对应才改；新的 sub 已经有账户（这个人已经用新账号登录过）的不动，交给人处理，不合并。 */
export function plan(users: { id: number; sub: string; email: string }[], map: Mapping[]): Plan {
  const out: Plan = { change: [], skipped: [] };
  const norm = (e: string) => e.trim().toLowerCase();
  const bySub = new Set(users.map((u) => u.sub));
  const mapCount = new Map<string, number>(), userCount = new Map<string, number>();
  for (const m of map) mapCount.set(norm(m.email), (mapCount.get(norm(m.email)) ?? 0) + 1);
  for (const u of users) if (u.email) userCount.set(norm(u.email), (userCount.get(norm(u.email)) ?? 0) + 1);
  const used = new Set<string>();
  for (const m of map) {
    const email = norm(m.email), u = users.find((x) => x.email && norm(x.email) === email);
    if (!u) { out.skipped.push({ email, why: "同步服务里没有这个邮箱的账户" }); continue; }
    if (mapCount.get(email)! > 1 || userCount.get(email)! > 1) out.skipped.push({ email, why: "邮箱不唯一" });
    else if (u.sub === m.sub) out.skipped.push({ email, why: "已经是新的 sub" });
    else if (bySub.has(m.sub) || used.has(m.sub)) out.skipped.push({ email, why: "新的 sub 已有账户或被重复使用，需要人工处理" });
    else { used.add(m.sub); out.change.push({ id: u.id, from: u.sub, to: m.sub }); }
  }
  return out;
}

export function migrate(dataDir: string, map: Mapping[], apply: boolean): Plan {
  const file = path.join(dataDir, "sync.db");
  const db = new DatabaseSync(file);
  try {
    const p = plan(db.prepare("SELECT id, sub, email FROM users").all() as { id: number; sub: string; email: string }[], map);
    if (apply && p.change.length) {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}.bak-${Date.now()}'`);
      db.exec("BEGIN");
      try {
        const set = db.prepare("UPDATE users SET sub = ? WHERE id = ?");
        for (const c of p.change) set.run(c.to, c.id);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    }
    return p;
  } finally { db.close(); }
}

if (import.meta.main) {
  const [dir, mapFile, flag] = process.argv.slice(2);
  if (!dir || !mapFile || (flag && flag !== "--apply")) { console.error("用法：node src/migrate-sub.ts <数据目录> <对应表.json> [--apply]"); process.exit(2); }
  const map = JSON.parse(fs.readFileSync(mapFile, "utf8")) as Mapping[];
  const p = migrate(dir, map, flag === "--apply");
  console.log(`${flag ? "已改" : "会改"} ${p.change.length} 个账户，跳过 ${p.skipped.length} 个${flag ? "" : "（干跑，加 --apply 才写入）"}`);
  for (const s of p.skipped) console.log(`  跳过 ${s.email}：${s.why}`);
}

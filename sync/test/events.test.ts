// 账号删除事件（POST /auth/events）与换身份服务时的 sub 迁移（migrate-sub）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as jose from "jose";
import { loadConfig } from "../src/config.ts";
import { createSyncServer } from "../src/server.ts";
import { openDb } from "../src/db.ts";
import { migrate, plan } from "../src/migrate-sub.ts";

const PUBLIC = "https://sync.example";
const ISS = "https://id.example/";
const JWKS = "https://id.example/security-events/jwks.json";
const EVENT = "https://schemas.openid.net/secevent/risc/event-type/account-purged";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-sync-events-"));

const { privateKey, publicKey } = await jose.generateKeyPair("ES256");
const other = await jose.generateKeyPair("ES256");
let jwksCalls = 0, jwksDown = false;
const fetcher = (async (url: string) => {
  assert.equal(String(url), JWKS);
  jwksCalls++;
  if (jwksDown) return new Response("no", { status: 503 });
  return new Response(JSON.stringify({ keys: [{ ...(await jose.exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" }] }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const env = { SYNC_PUBLIC_URL: PUBLIC, OIDC_ISSUER: "https://id.example", OIDC_CLIENT_ID: "quetzal-sync", OIDC_CLIENT_SECRET: "s", TURN_SECRET: "s".repeat(40) };
const s = createSyncServer(loadConfig({ ...env, SYNC_DATA_DIR: tmp(), OIDC_EVENTS_JWKS: JWKS }), { login: null, fetcher });
const off = createSyncServer(loadConfig({ ...env, SYNC_DATA_DIR: tmp() }), { login: null });
after(async () => { await s.close(); await off.close(); });

const event = (sub: string, o: { key?: jose.CryptoKey; kid?: string; aud?: string; iss?: string; iat?: number; typ?: string; type?: string } = {}) =>
  new jose.SignJWT({ events: { [o.type ?? EVENT]: { subject: { subject_type: "iss-sub", iss: ISS, sub } } } })
    .setProtectedHeader({ alg: "ES256", typ: o.typ ?? "secevent+jwt", kid: o.kid ?? "k1" })
    .setIssuer(o.iss ?? ISS).setAudience(o.aud ?? "quetzal-sync").setIssuedAt(o.iat ?? Math.floor(Date.now() / 1000)).setJti("j" + Math.random())
    .sign(o.key ?? privateKey);
const post = (app: typeof s.app, body: string) => app.request(PUBLIC + "/auth/events", { method: "POST", body, headers: { "content-type": "application/secevent+jwt" } });

test("删除事件：签名通过就删掉这个 sub 的账户与全部数据，重复与不存在的 sub 回 202 且什么都不做", async () => {
  const u = s.db.upsertUser({ sub: "gone", login: "gone", name: "", email: "" });
  const keep = s.db.upsertUser({ sub: "stay", login: "stay", name: "", email: "" });
  assert.equal((await post(s.app, await event("gone"))).status, 202);
  assert.equal(s.db.user(u.id), undefined);
  assert.ok(s.db.user(keep.id), "别的账户不受影响");
  assert.equal((await post(s.app, await event("gone"))).status, 202, "重复的事件");
  assert.equal((await post(s.app, await event("nobody"))).status, 202, "不存在的 sub");
  assert.equal(s.db.userBySub("nobody"), undefined, "不为不存在的 sub 写任何记录");
});

test("删除事件：签名、aud、iss、过期、类型、kid 任何一项不对都回 400 且不删除", async () => {
  const u = s.db.upsertUser({ sub: "victim", login: "victim", name: "", email: "" });
  const bad = [
    await event("victim", { key: other.privateKey }),
    await event("victim", { aud: "someone-else" }),
    await event("victim", { iss: "https://evil.example/" }),
    await event("victim", { iat: Math.floor(Date.now() / 1000) - 8 * 86400 }),
    await event("victim", { iat: Math.floor(Date.now() / 1000) + 3600 }),
    await event("victim", { typ: "JWT" }),
    await event("victim", { type: "https://schemas.openid.net/secevent/risc/event-type/account-disabled" }),
    await event("victim", { kid: "unknown" }),
    "not-a-jwt", "a.b.c", "",
  ];
  for (const t of bad) assert.equal((await post(s.app, t)).status, 400, t.slice(0, 40));
  assert.ok(s.db.user(u.id), "伪造的事件不删任何东西");
});

test("删除事件：取不到公钥回 500（身份服务会重试），恢复后能处理；没配置 OIDC_EVENTS_JWKS 时接口不存在", async () => {
  const fresh = createSyncServer(loadConfig({ ...env, SYNC_DATA_DIR: tmp(), OIDC_EVENTS_JWKS: JWKS }), { login: null, fetcher });
  try {
    const u = fresh.db.upsertUser({ sub: "late", login: "late", name: "", email: "" });
    jwksDown = true;
    assert.equal((await post(fresh.app, await event("late"))).status, 500);
    assert.ok(fresh.db.user(u.id));
    jwksDown = false;
    assert.equal((await post(fresh.app, await event("late"))).status, 202);
    assert.equal(fresh.db.user(u.id), undefined);
  } finally { await fresh.close(); }
  assert.equal((await post(off.app, await event("x"))).status, 404);
});

test("迁移：邮箱在两边都唯一对应才改 sub；新 sub 已有账户、邮箱重复、没有账户的都跳过并说明", () => {
  const users = [
    { id: 1, sub: "old-a", email: "a@example.com" },
    { id: 2, sub: "old-b", email: "b@example.com" },
    { id: 3, sub: "old-c", email: "c@example.com" },
    { id: 4, sub: "old-d", email: "" },
    { id: 5, sub: "new-e", email: "e@example.com" },
  ];
  const p = plan(users, [
    { email: "A@Example.com", sub: "new-a" },
    { email: "b@example.com", sub: "new-e" },   // 新 sub 已有账户
    { email: "nobody@example.com", sub: "new-n" },
    { email: "c@example.com", sub: "new-c" }, { email: "c@example.com", sub: "new-c2" }, // 对应表里重复
  ]);
  assert.deepEqual(p.change, [{ id: 1, from: "old-a", to: "new-a" }]);
  assert.deepEqual(p.skipped.map((x) => x.email).sort(), ["b@example.com", "c@example.com", "c@example.com", "nobody@example.com"]);
});

test("迁移：干跑不写库；--apply 先备份再改，账户下的 agent 原样保留", () => {
  const dir = tmp();
  const db = openDb(dir);
  const u = db.upsertUser({ sub: "old-a", login: "a", name: "", email: "a@example.com" });
  db.raw.prepare("INSERT INTO agents (user_id, agent_id, name, created) VALUES (?, 'ag', 'Ag', 1)").run(u.id);
  db.close();
  const map = [{ email: "a@example.com", sub: "new-a" }];
  assert.equal(migrate(dir, map, false).change.length, 1);
  const check = () => { const d = openDb(dir); try { return d.userBySub("new-a"); } finally { d.close(); } };
  assert.equal(check(), undefined, "干跑不改");
  assert.equal(migrate(dir, map, true).change.length, 1);
  const moved = check()!;
  assert.equal(moved.id, u.id);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("sync.db.bak-")), "改之前备份了");
  const d = openDb(dir);
  assert.equal(d.agentsOf(moved.id).length, 1);
  d.close();
});

// 账号删除事件：身份服务在用户彻底删除账号时推送一个签名事件（SET，RISC 的 account-purged，Content-Type: application/secevent+jwt），
// 同步服务据此删掉该账户的全部数据。签名用身份服务发布的公钥校验（ES256，Node 内置 crypto，不加依赖）；只在配置了 OIDC_EVENTS_JWKS 时启用。
import crypto from "node:crypto";
import type { Config } from "./config.ts";

const EVENT = "https://schemas.openid.net/secevent/risc/event-type/account-purged";
const JWKS_TTL = 10 * 60_000, JWKS_REFETCH = 60_000; // 公钥缓存 10 分钟；遇到不认识的 kid 最多每分钟重取一次（防被人用乱编的 kid 逼着反复请求身份服务）
const MAX_AGE = 7 * 86_400_000, SKEW = 5 * 60_000;   // 重试最长 72 小时，留余量；iat 不能在未来

/** transient 为真：我们这边暂时办不了（取不到公钥），回 500 让身份服务稍后重试；否则是事件本身不对，回 400，不删任何东西。 */
export class EventError extends Error {
  transient: boolean;
  constructor(m: string, transient = false) { super(m); this.transient = transient; }
}

const trim = (s: string) => s.replace(/\/+$/, "");
const part = (s: string) => { try { return JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>; } catch { throw new EventError("格式不对"); } };

/** 校验一个删除事件，返回被删除账号的 sub。fetcher 供测试注入。 */
export function deletionEvents(cfg: Config, fetcher: typeof fetch = fetch): (token: string) => Promise<string> {
  const o = cfg.oidc!;
  let keys = new Map<string, crypto.KeyObject>(), fetched = 0;
  const load = async () => {
    try {
      const r = await fetcher(o.eventsJwks!, { headers: { accept: "application/json", "user-agent": "quetzal-sync" }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`返回 ${r.status}`);
      const next = new Map<string, crypto.KeyObject>();
      for (const k of ((await r.json()) as { keys?: (crypto.JsonWebKey & { kid?: string })[] }).keys ?? []) {
        if (k.kid && k.kty === "EC" && k.crv === "P-256") next.set(k.kid, crypto.createPublicKey({ key: k, format: "jwk" }));
      }
      keys = next; fetched = Date.now();
    } catch (e) { throw new EventError(`取不到事件公钥（${(e as Error).message}）`, true); }
  };
  const key = async (kid: string) => {
    if (!fetched || Date.now() - fetched > JWKS_TTL) await load();
    else if (!keys.has(kid) && Date.now() - fetched > JWKS_REFETCH) await load();
    const k = keys.get(kid);
    if (!k) throw new EventError("不认识的 kid");
    return k;
  };
  return async (token) => {
    const p = token.trim().split(".");
    if (p.length !== 3 || token.length > 8192) throw new EventError("格式不对");
    const h = part(p[0]);
    if (h.alg !== "ES256" || h.typ !== "secevent+jwt" || typeof h.kid !== "string") throw new EventError("头部不对");
    const sig = Buffer.from(p[2], "base64url");
    if (sig.length !== 64 || !crypto.verify("sha256", Buffer.from(`${p[0]}.${p[1]}`), { key: await key(h.kid), dsaEncoding: "ieee-p1363" }, sig)) throw new EventError("签名不对");
    const c = part(p[1]);
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (typeof c.iss !== "string" || trim(c.iss) !== trim(o.issuer)) throw new EventError("iss 不对");
    if (!aud.includes(o.clientId)) throw new EventError("aud 不对");
    const iat = typeof c.iat === "number" ? c.iat * 1000 : NaN;
    if (!(iat <= Date.now() + SKEW && iat >= Date.now() - MAX_AGE)) throw new EventError("iat 不对");
    const ev = (c.events as Record<string, { subject?: { subject_type?: unknown; iss?: unknown; sub?: unknown } }> | undefined)?.[EVENT]?.subject;
    if (ev?.subject_type !== "iss-sub" || typeof ev.iss !== "string" || trim(ev.iss) !== trim(o.issuer) || typeof ev.sub !== "string" || !ev.sub || ev.sub.length > 200) throw new EventError("事件内容不对");
    return ev.sub;
  };
}

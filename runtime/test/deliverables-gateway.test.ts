// 交付物经网关交给控制台（#18）：她生成的文件作为附件下载（文档按下载处理）、轻量预览（xlsx 的前几行、文档开头的文字）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import WebSocket from "ws";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-deliv-gw-"));
const { loadConfig, saveConfig, paths } = await import("../src/config.ts");
loadConfig();
saveConfig({ body: "gwbox", gateway: { port: 0, host: "127.0.0.1", lan: false } } as never);
const store = await import("../src/store.ts");
store.openStore();
const { startGateway } = await import("../src/gateway.ts");
const { render } = await import("../src/mind/deliverables.ts");
const { saveUpload } = await import("../src/mind/attachments.ts");

const gw = startGateway(false);
await gw.ready;
after(async () => { await gw.close(); store.db.close(); fs.rmSync(paths.home, { recursive: true, force: true }); });
const port = (gw.plain.address() as any).port as number;
const token = fs.readFileSync(path.join(paths.secrets, "gateway.token"), "utf8").trim();

function get(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { "X-Quetzal-Token": token } }, (res) => { const c: Buffer[] = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(c) })); }).on("error", reject);
  });
}
function rpc(method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
    ws.on("open", () => ws.send(JSON.stringify({ auth: token })));
    ws.on("message", (m) => {
      const j = JSON.parse(String(m));
      if (j.event === "hello") ws.send(JSON.stringify({ id: 1, method, params }));
      else if (j.id === 1) { ws.close(); j.error ? reject(new Error(j.error.message)) : resolve(j.result); }
    });
    ws.on("error", reject);
  });
}

test("她生成的 xlsx：下载时按附件给出（带文件名），预览给出各工作表的前几行", async () => {
  const buf = await render({ format: "xlsx", sheets: [{ name: "预算", columns: ["项目", "金额"], rows: [["房租", 3000], ["水电", 200]] }] }, { baseDir: os.tmpdir(), warnings: [], images: 0 });
  const a = saveUpload("预算表.xlsx", buf);
  const r = await get(`http://127.0.0.1:${port}/uploads/${a.rel.split("/").map(encodeURIComponent).join("/")}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, buf.length);
  assert.equal(r.headers["content-disposition"], `attachment; filename*=UTF-8''${encodeURIComponent("预算表.xlsx")}`);
  const p = await rpc("uploads.preview", { rel: a.rel });
  assert.equal(p.name, "预算表.xlsx");
  assert.equal(p.kind, "Excel");
  assert.match(p.text, /工作表：预算[\s\S]*项目\t金额\n房租\t3000\n水电\t200/);
  await assert.rejects(rpc("uploads.preview", { rel: "../secrets/gateway.token" }), /不在这具身体上/);
});

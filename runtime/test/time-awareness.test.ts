// 时间感（#40）：一小时以前的消息带相对时间；工作状态记一条带时间的时间线，每一步交给模型。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-time-"));
process.env.QUETZAL_HOME = path.join(tmp, "home");
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const { ago } = await import("../src/time/zone.ts");
const { history } = await import("../src/mind/brain.ts");
const taskStates = await import("../src/mind/task-states.ts");
const { createTurnContext, taskState } = await import("../src/mind/context.ts");

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("相对时间：刚才、分钟、小时、天、周、月、年", () => {
  const now = Date.UTC(2026, 9, 18, 12);
  assert.equal(ago(now - 30_000, now), "刚才");
  assert.equal(ago(now - 5 * 60_000, now), "5 分钟前");
  assert.equal(ago(now - 3 * 3_600_000, now), "3 小时前");
  assert.equal(ago(now - 3 * 86_400_000, now), "3 天前");
  assert.equal(ago(now - 20 * 86_400_000, now), "2 周前");
  assert.equal(ago(now - 90 * 86_400_000, now), "3 个月前");
  assert.equal(ago(now - 800 * 86_400_000, now), "2 年前");
});

test("对话历史：一小时以前的消息另写相对时间，刚说的不写", () => {
  store.ensureSession("t1", "时间");
  const old = store.addMessage("user", "控制台", "三天前说的事", { session: "t1" });
  store.db.prepare("UPDATE messages SET ts=? WHERE id=?").run(Date.now() - 3 * 86_400_000 - 60_000, old);
  store.addMessage("user", "控制台", "刚才说的", { session: "t1" });
  const self = store.addMessage("user", "控制台", "现在这句", { session: "t1" });
  const h = history("t1", self).map((m) => String(m.content));
  assert.match(h.find((t) => t.includes("三天前说的事"))!, /^\[\d\d\/\d\d \d\d:\d\d，3 天前\] 三天前说的事/);
  assert.match(h.find((t) => t.includes("刚才说的"))!, /^\[\d\d\/\d\d \d\d:\d\d\] 刚才说的/);
});

test("工作状态的时间线：记下定下目标、约束、问题的出现与解决、阶段变化；交给模型时带相对时间", async () => {
  const t0 = Date.now() - 2 * 3_600_000;
  taskStates.save("t2", { goal: "整理发布说明", constraints: ["只写中文"], openQuestions: ["要不要写英文版"], phase: "exploration" }, t0);
  taskStates.save("t2", { goal: "整理发布说明", constraints: ["只写中文", "不超过一页"], openQuestions: [], phase: "verification" }, t0 + 3_600_000);
  const notes = taskStates.get("t2")!.timeline!.map((e) => e.note);
  assert.deepEqual(notes, ["定下目标：整理发布说明", "加了约束：只写中文", "新的未决问题：要不要写英文版", "加了约束：不超过一页", "解决了 / 放下了问题：要不要写英文版", "阶段：探索 → 核实"]);
  const text = taskStates.timelineText("t2");
  assert.match(text[0], /^2 小时前（\d\d\/\d\d \d\d:\d\d）定下目标：整理发布说明$/);
  assert.match(text.at(-1)!, /^1 小时前（[^）]+）阶段：探索 → 核实$/);

  // 每一步交给模型的工作状态里带上时间线
  const ctx = createTurnContext("turn-t2", "t2", [{ role: "user", content: "接着整理" }]);
  await ctx.prepare({ messages: [{ role: "system", content: "系统" }, { role: "user", content: "接着整理" }], tools: [] } as any);
  assert.match(ctx.snapshot().state.timeline![0], /^2 小时前（/, "工作状态（上下文管理器以「当前任务工作状态」交给模型）带上时间线");
  // 这一轮再改：时间线接着记
  taskState("turn-t2", { openQuestions: ["发布日期定了吗"] });
  assert.ok(taskStates.get("t2")!.timeline!.some((e) => e.note === "新的未决问题：发布日期定了吗"));
  ctx.close();
});

test("别处来的时间线逐条检查：时刻在未来的、不是文字的丢弃，最多 30 条", () => {
  const now = Date.now();
  const r = taskStates.sanitize({ conv: "t3", updatedAt: now, goal: "x", constraints: [], openQuestions: [], phase: "exploration", tags: [], body: "pc",
    timeline: [{ ts: now - 1000, note: "定下目标：x" }, { ts: now + 3_600_000, note: "未来" }, { ts: now, note: 5 }, ...Array.from({ length: 40 }, (_, i) => ({ ts: now - 1, note: `第${i}条` }))] }, now)!;
  assert.equal(r.timeline!.length, 30);
  assert.ok(!r.timeline!.some((e) => e.note === "未来"));
});

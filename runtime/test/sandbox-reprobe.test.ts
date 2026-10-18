// 沙箱探测结果会缓存：启动器在基座运行中被删掉（卸载、重装）时要重新探测，不能一直去启动一个不存在的程序（spawn ENOENT、退出码 127）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-sandbox-reprobe-"));
const landrun = path.join(home, "fake-landrun");
process.env.QUETZAL_HOME = home;
process.env.QUETZAL_SANDBOX = "landlock"; // 跳过 bwrap，只看 landrun
process.env.QUETZAL_LANDRUN = landrun;
const cfg = await import("../src/config.ts"); cfg.loadConfig();
const sandbox = await import("../src/sandbox.ts");
const skip = (process.platform !== "linux" || cfg.isAndroid) && "只用于 Linux（bwrap / Landlock 的启动器）";
after(() => fs.rmSync(home, { recursive: true, force: true }));

test("沙箱启动器在运行中消失：下一次用到时重新探测，而不是一直启动不存在的程序", { skip }, () => {
  fs.writeFileSync(landrun, "#!/bin/sh\nexit 0\n", { mode: 0o755 }); // 假的启动器：探测时一律通过
  sandbox.resetSandbox();
  assert.equal(sandbox.sandboxStatus().kind, "landlock");
  assert.equal(sandbox.wrap("true", []).cmd, landrun);
  fs.rmSync(landrun);
  const kind = sandbox.sandboxStatus().kind;
  assert.notEqual(kind, "landlock", "启动器没了还按 Landlock 报告");
  if (kind === "none") assert.throws(() => sandbox.wrap("true", []), sandbox.SandboxUnavailable);
  else assert.notEqual(sandbox.wrap("true", []).cmd, landrun);
});

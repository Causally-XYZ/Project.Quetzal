// 灵魂目录里的目录链接：找出来（不跟随、指回上层成环也不会一直走下去），写进 .git/info/exclude 的基座维护段，git 就不进入它们。
// Windows 上的 git（core.symlinks=false）会把 junction 当目录走进去，成环时 status / add 要走到闲置超时，灵魂同步的队列一直被占着。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirLinks, excludeWithLinks } from "../src/memory/soul-repo.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-soul-dirlinks-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const dirLink = (target: string, link: string) => fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

test("找出目录链接：指回上层成环的、指到别处的都算，不进入它们；普通目录照常往下找，文件链接与 .git 不算", () => {
  const soul = path.join(tmp, "soul");
  fs.mkdirSync(path.join(soul, "notes", "QuetzalMemory"), { recursive: true });
  fs.mkdirSync(path.join(soul, ".git", "x"), { recursive: true });
  fs.writeFileSync(path.join(soul, "notes", "a.md"), "a");
  dirLink(soul, path.join(soul, "notes", "parent-alias"));   // 指回灵魂根目录：成环
  dirLink(soul, path.join(soul, "notes", "ancestor.md"));    // 名字像笔记的目录链接
  dirLink(path.join(soul, "notes", "QuetzalMemory"), path.join(soul, "notes", "managed-alias"));
  dirLink(path.join(soul, ".git", "x"), path.join(soul, ".git", "loop"));
  try { fs.symlinkSync(path.join(soul, "notes", "a.md"), path.join(soul, "notes", "file-link.md"), "file"); } catch { /* 建不了文件链接（Windows 没有权限）：不影响 */ }
  assert.deepEqual(dirLinks(soul), ["notes/ancestor.md", "notes/managed-alias", "notes/parent-alias"]);
  assert.deepEqual(dirLinks(path.join(tmp, "missing")), [], "目录不存在");
});

test("exclude：基座维护段按链接重写，别的行原样保留；没有链接时去掉这一段", () => {
  const base = "# git ls-files --others --exclude-from=.git/info/exclude\n*.tmp\n";
  const one = excludeWithLinks(base, ["notes/parent-alias", "notes/a b ", "notes/#x[1]"]);
  assert.equal(one, `${base}# quetzal: 目录链接，不进入（基座自动维护）\n/notes/parent-alias\n/notes/a b\\ \n/notes/\\#x\\[1\\]\n# quetzal: 目录链接结束\n`);
  assert.equal(excludeWithLinks(one, ["notes/parent-alias", "notes/a b ", "notes/#x[1]"]), one, "不变时内容相同（不重写文件）");
  const two = excludeWithLinks(one, ["skills/s"]);
  assert.equal(two, `${base}# quetzal: 目录链接，不进入（基座自动维护）\n/skills/s\n# quetzal: 目录链接结束\n`);
  assert.equal(excludeWithLinks(two, []), base);
  assert.equal(excludeWithLinks("", []), "");
});

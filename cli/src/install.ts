// 安装与升级：把包里内置的运行基座放进 releases/<版本>/ → 切换 current → 写入缺省配置 → 守护者（Linux：systemd 用户服务；macOS：launchd 用户代理）→ 健康检查，失败切回上一版。
// 步骤与 Android 安装器（console/assets/install/install.sh）一一对应，只是守护者从 runit 换成 systemd / launchd。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Layout, layout, versionOf, putRelease, switchTo, rollback, prune, readConfig, patchConfig, defaultBody, needsMigration, migrateHome } from "./layout.ts";
import { svc, isMac } from "./supervisor.ts";
import { waitHealthy } from "./health.ts";
import { installMeshModules } from "./mesh.ts";
import { lanEnabled } from "./lan.ts";

export type Say = (line: string) => void;
export interface Options { home: string; lan?: boolean; force?: boolean }

/** 包里必有的文件，与有就带上的文件（macOS 的身体适配器 macos.mjs 与命令沙箱库 srt.mjs）。 */
export const RELEASE_FILES = ["main.cjs", "linux.mjs", "mermaid.mjs"], OPTIONAL_FILES = ["macos.mjs", "srt.mjs"];

/** 包里内置的运行基座与网页控制台（tool/bundle-runtime.sh 放进 dist/runtime/）。 */
export function bundled(dir = fileURLToPath(new URL("./runtime/", import.meta.url))) {
  const version = fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim();
  const web = path.join(dir, "web");
  return {
    dir, version,
    files: [...RELEASE_FILES, ...OPTIONAL_FILES.filter((name) => fs.existsSync(path.join(dir, name)))].map((name) => ({ name, from: path.join(dir, name) })),
    dirs: fs.existsSync(path.join(web, "index.html")) ? [{ name: "web", from: web }] : [],
  };
}

export const gatewayPort = (l: Layout) => Number(readConfig(l).gateway?.port) || 7788;
export const gatewayHost = (l: Layout) => String(readConfig(l).gateway?.host || "127.0.0.1");
/** 网页控制台在这台机器上的地址（网关托管）。 */
export const consoleUrl = (l: Layout) => `http://127.0.0.1:${gatewayPort(l)}/`;
/** 这台机器上有没有网页控制台（当前版本目录里有 web/index.html）。 */
export const hasConsole = (l: Layout) => fs.existsSync(path.join(l.current, "web", "index.html"));

/** 把内置版本放进家目录并切换 current（服务不动）。返回 {version, changed, before}。 */
export function placeRelease(l: Layout, force = false) {
  const b = bundled();
  const before = versionOf(l.current);
  if (before === b.version && !force) return { version: b.version, changed: false, before };
  const dir = putRelease(l, b.version, b.files, b.dirs);
  const size = fs.statSync(path.join(dir, "main.cjs")).size;
  if (size < 100_000) throw new Error("运行基座文件不完整");
  switchTo(l, dir);
  return { version: b.version, changed: true, before };
}

/** 缺省配置：身体名字（主机名）只在没有时写入；gateway.host 与 gateway.lan 按 --lan / --no-lan 设置（局域网走 HTTPS，见 lan.ts）；其余由控制台管理。 */
export function writeDefaults(l: Layout, lan?: boolean) {
  return patchConfig(l, (c) => {
    if (!c.body || c.body === "default") c.body = defaultBody();
    if (lan != null) c.gateway = { ...(c.gateway ?? {}), host: lan ? "0.0.0.0" : "127.0.0.1", lan };
  });
}

export async function install(o: Options, say: Say): Promise<void> {
  const l = layout(o.home);
  if (needsMigration(o.home)) { // 老安装在 ~/quetzal：先停服务，整目录搬到 ~/.quetzal，下面重写单元文件时路径就是新的
    if (svc.isInstalled()) await svc.stop();
    const old = migrateHome(o.home);
    say(`家目录从 ${old} 搬到了 ${o.home}（配置、记忆、对话原样保留；要用别的位置请设 QUETZAL_HOME 或 --home）`);
  }
  fs.mkdirSync(l.releases, { recursive: true });
  const { version, changed, before } = placeRelease(l, o.force);
  say(!changed ? `运行基座 ${version} 已是内置版本` : before === version ? `重新安装 ${version}` : before ? `升级：${before} → ${version}` : `安装运行基座 ${version}`);
  let h: Awaited<ReturnType<typeof waitHealthy>>, linger = false;
  try {
    if (!fs.existsSync(path.join(l.current, "node_modules", "node-datachannel"))) await installMeshModules(l, bundled().dir, fs.realpathSync(l.current), say);
    writeDefaults(l, o.lan);

    if (!(await svc.available())) {
      say(isMac ? "这台 Mac 上用不了 launchctl：已放好文件，请用 `quetzal run` 前台运行，并交给你自己的进程守护者。"
        : "没有可用的 systemd 用户实例（容器或未开启 systemd 的 WSL）：已放好文件，请用 `quetzal run` 前台运行，并交给你自己的进程守护者。");
      return;
    }
    await svc.install({ home: l.home, node: process.execPath });
    linger = await svc.enableLinger();
    await svc.restart();
    say("服务已启动，等待运行基座响应…");
    h = await waitHealthy(gatewayPort(l), version);
    if (!h) throw new Error("运行基座 40 秒内没有响应");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // 只回退本次真正切换的版本；重复安装不能误退到更早版本，同版本覆盖也不是旧字节快照。
    if (!changed || !before || before === version) throw new Error(`安装未完成：${reason}。本次没有可恢复的版本切换。日志：quetzal logs`, { cause: error });
    let back: string | undefined;
    try { back = rollback(l); }
    catch { throw new Error(`安装未完成：${reason}。版本指针回切失败。日志：quetzal logs`, { cause: error }); }
    if (!back) throw new Error(`安装未完成：${reason}。没有找到可切回的版本。日志：quetzal logs`, { cause: error });
    // 注册也可能只完成一部分；恢复原程序后重新注册，再用健康结果判断是否真正恢复。
    try { await svc.install({ home: l.home, node: process.execPath }); await svc.restart(); } catch { /* 仍核对实际健康，不能把重启命令返回等同服务状态。 */ }
    const recovered = await waitHealthy(gatewayPort(l), back);
    throw new Error(`安装未完成：${reason}。已切回 ${back}，${recovered ? "并已确认服务恢复健康" : "但尚未恢复健康，请检查服务日志"}。日志：quetzal logs`, { cause: error });
  }
  say(`运行基座 ${h.version} 正常${h.safeMode ? "（安全模式：反复崩溃，请看日志）" : ""}。`);
  if (hasConsole(l)) say(`网页控制台：${consoleUrl(l)}（这台机器上的浏览器打开即登录；别的设备用 Quetzal App 加配对码）`);
  if (lanEnabled(l)) say("局域网走加密连接（地址与证书指纹见下）：手机上的 Quetzal App 填这台机器的地址配对，核对 App 显示的指纹与配对通知里的一致；浏览器打开会提示证书不受信任，核对指纹后再继续。");
  const removed = prune(l);
  if (removed.length) say(`清理旧版本：${removed.join("、")}`);
  if (isMac) say(`提示：launchd 用户代理在你登录这台 Mac 后运行。要让 ta 看屏幕、点击和输入，在 系统设置 › 隐私与安全性 › 辅助功能 与 屏幕与系统录音 里加入 ${process.execPath}，再 quetzal restart。`);
  if (!linger) say("提示：loginctl enable-linger 未成功，这个用户没有登录会话时服务不会运行；服务器上可手动执行 `sudo loginctl enable-linger $USER`。");
}

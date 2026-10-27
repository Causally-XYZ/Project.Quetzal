# runtime · 运行基座

TypeScript / Node.js 22+。核心存储用内置 `node:sqlite`，无需额外 SQLite 原生扩展，打包为单文件 `dist/main.cjs`。平台级身体适配器：`adapters/android/`（任意安卓手机，身体能力经 Quetzal App 的本机身体接口提供，操作屏幕靠 App 的无障碍服务）打包为 `dist/android.mjs`，随 Quetzal App 内置（App 只装一个，运行环境也在里面，见 `../console/tool/android-runtime/`）；`adapters/termux/`（旧的 Termux 安装：安卓手机 + Termux:API）打包为 `dist/termux.mjs`，保留以兼容；`adapters/linux/`（任意 Linux 电脑或服务器：电池与温度读 `/sys`，通知、播放、剪贴板、相机、录音，以及看屏幕与操作应用（xdotool / ydotool / wtype、AT-SPI、截图程序）按可用程序探测）打包为 `dist/linux.mjs`，随 npm 包 `@plutokeating/quetzal`（`../cli`）内置；`adapters/macos/`（任意 Mac：电量读 pmset、电池温度与设备标识读 ioreg，通知、截图、剪贴板、打开、播放用系统自带的程序，拍照录音按可用程序探测；hands 用 JXA 经 System Events 读无障碍树与窗口、按键输入，鼠标用 cliclick 或 CoreGraphics 的 CGEvent）打包为 `dist/macos.mjs`，同样随 npm 包内置；`adapters/windows/`（任意 Windows 10 1809 起 / 11 电脑：电源、温度、Toast、截图与操作屏幕（UI Automation + SendInput）、剪贴板、打开、播放、拍照、录音，常驻一个 PowerShell 5.1 进程执行）打包为 `dist/windows.mjs`，另有用户桌面里的身体助手 `dist/windows-body.mjs` 与守护进程 `dist/windows-supervise.mjs`，随 Windows 安装包（`../cli/windows`）分发。Windows 与 macOS 的命令沙箱库单独打包为 `dist/srt.mjs`（Windows 的 srt-win.exe 由安装包放进 `srt-win\`；macOS 用系统自带的 sandbox-exec，srt.mjs 随 npm 包放进版本目录），Mermaid 兜底渲染器为 `dist/mermaid.mjs`（桌面用，按需加载）。

| 命令 | 作用 |
|---|---|
| `npm test` | 单元与集成测试（心脏、记忆与 FTS5 检索、上下文、会话与子 agent、灵魂 git 合并、模型路由、安全、听觉、网关、网状层与平台适配器；具体范围见 `test/*.test.ts` 及 `../engine/test/*.test.ts`） |
| `npm run build` | engine 独立类型检查 + runtime 类型检查 + esbuild 打包：`dist/main.cjs`、`android.mjs`、`linux.mjs`、`macos.mjs`、`termux.mjs`、`windows.mjs`、`windows-body.mjs`、`windows-supervise.mjs`、`mermaid.mjs`；最后由 `tool/build-srt.mjs` 打包 `dist/srt.mjs` |
| `npm run dev` | 以 `./.dev` 为家目录直接运行源码 |

测试夹具清理临时 `QUETZAL_HOME` 前，须先结束模型服务 / MCP 连接并关闭 SQLite `store.db`，再删除目录。Windows 不允许删除仍由数据库打开的文件；清理失败同样属于测试失败，不能以忽略 EPERM 或跳过用例替代释放资源。

运行时依赖 `@modelcontextprotocol/client`（锁定 2.3.1，Apache-2.0）：官方 MCP 协议实现，stdio、Streamable HTTP、旧版 SSE 传输与 OAuth 客户端（`auth()`）都来自它，支持现代 / legacy 协商；远程与插件没有新增依赖（出站检查用 Node 内置 http / https，git 仓库用系统的 git）；没有引入服务端框架或将 SDK 放进 engine。

运行时依赖：`ws`（网关）、`@larksuiteoapi/node-sdk`（飞书长连接、交互卡片、一键创建机器人）、`jpeg-js`（纯 JS 的 JPEG 编解码：手机上没有 ffmpeg / ImageMagick 时也能把大照片缩小后交给模型）、`microsoft-cognitiveservices-speech-sdk`（听觉的流式识别：裸 WebSocket 协议的社区实现都已弃用，官方 SDK 是 Node 下的标准做法，打包后约 1 MB），以及 `@peculiar/asn1-x509` + `@peculiar/asn1-schema`（锁定精确版本，MIT，纯 JS）：网关局域网 HTTPS 的自签名证书（`src/tls.ts`）。Node 有 TLS 却没有生成 X.509 证书的接口，证书的 DER 编码不自己写，用 PeculiarVentures 维护的 ASN.1 结构定义（`@peculiar/x509` 的底层），签名用 `node:crypto`。没用更上层的 `@peculiar/x509`：它依赖 `tsyringe`，要求进程里装全局的 `reflect-metadata` 补丁；`selfsigned` 新版本建立在 `@peculiar/x509` 之上，旧版本基于 `node-forge` 只能生成 RSA。打包后 `main.cjs` 约多 0.4 MB，Node 22+ 与 Termux 的 Node 都只用到 `node:crypto` 的标准 EC 能力。

交付物（`deliverable_create`，[ARCHITECTURE §5.8](../../docs/ARCHITECTURE.md)）的五个库，都是 MIT、纯 JS、锁定精确版本：`marked` 18.0.14（Markdown 解析，GFM）、`docx` 9.8.1（Word）、`exceljs` 4.4.0（Excel）、`pptxgenjs` 4.0.1（PowerPoint）、`pdfkit` 0.19.1（PDF；开发依赖 `@types/pdfkit` 0.17.6 只给类型检查）。依据：这几种格式都是各自领域里使用最广、维护最久的开源实现，自己写 OOXML / PDF 只会更差；间接依赖也都是宽松许可（MIT、ISC、Apache-2.0、BSD、0BSD、BlueOak、Unlicense；`jszip` 为 MIT 或 GPLv3 双许可，按 MIT 使用）。pdfkit 留在 0.19：0.20 起 Node 入口改用 `import.meta.url` 与 `createRequire` 读数据文件，打进 CommonJS 的 `main.cjs` 后加载即报错；它的 14 种标准字体从自己的目录读 AFM 文件，打包后读不到，所以生成 PDF 时一律嵌入探测到的系统字体（中文字体的探测见 §5.8），从不用标准字体。打包后 `main.cjs` 从约 10.1 MB 增加到约 16.4 MB（gzip 后约 1.3 MB → 2.4 MB），只在第一次生成文件时加载（动态 `import`）。

可选依赖一个：`node-datachannel`（libdatachannel 的 Node 绑定，MPL-2.0，原生模块）——网状层的 WebRTC：ICE 穿透、DTLS 加密、SCTP 可靠传输都是安全敏感、久经考验的标准实现，不自己写。它不打进 `main.cjs`（esbuild `--external`），由安装器按 `tool/mesh-modules.lock.json` 的版本与 sha512 下载核对（`tool/install-mesh-modules.mjs`，安卓、Linux 与 macOS 共用；平台 android-arm64、linux-<x64|arm64>-<gnu|musl>、darwin-<x64|arm64>、win32-<x64|arm64>）；加载不了时网状层关闭，身体之间仍用 git 同步。升级它时同步修改 `package.json` 的 `optionalDependencies` 与锁定文件（哈希取自 registry.npmjs.org 的 `dist.integrity`）。

`package.json` 还声明了 `croner`（提醒的 cron 时刻计算）、`beautiful-mermaid`（`dist/mermaid.mjs` 的 SVG 兜底渲染）与 `@anthropic-ai/sandbox-runtime`（Windows 与 macOS 的命令沙箱，单独打包为 `dist/srt.mjs`，核心只在这两个平台上加载）。可选 WebRTC 与 Windows 沙箱的原生组件由安装 / 发布流程提供。依赖与构建产物以 `package.json` 和 `tool/build-srt.mjs` 为准。

执行核心是独立 `../engine/` 的真实循环、动态上下文与结构化记忆/PRIME 规则，由 `src/mind/brain.ts` 注入宿主能力。`mind/context.ts` 每步选择记忆并按实际候选模型窗口重新准备，包含Schema、输出与图片开销的UTF-8字节保守估计；不是真实tokenizer。旧历史与完整行动来源保留，摘要/工具节选可经context_read分页回查。结构化版本存在私有灵魂notes/QuetzalMemory，实际语义选择/后台学习在memory/semantic.ts与prime.ts；个人事实与偏好默认候选，只有可信确认后准入，经验演化需独立结果及基线。每日自主预算仍只减少醒来，子agent maxSteps由宿主强制计数（最后一步提醒写报告，再多2步停下）。

`src/mcp/` 提供 MCP 工具来源（本机 stdio、远程 Streamable HTTP / SSE、OAuth 2.1、tools / resources / prompts），`src/plugins/` 提供插件包（Claude Code 插件格式、Agent Skills）、插件目录与推荐目录；官方客户端 SDK 仅在宿主使用，没有 MCP 服务端。交互通过控制台、飞书与CLI本机chat/tui。专项见 [动态上下文](../../docs/engine/DYNAMIC_CONTEXT.md)、[结构化记忆](../../docs/engine/STRUCTURED_MEMORY.md)、[PRIME内核](../../docs/engine/PRIME_CORE.md)、[MCP](../../docs/engine/MCP.md)。

环境变量：`QUETZAL_HOME`（家目录，默认 Termux `~/quetzal`、其他机器 `~/.quetzal`；Quetzal App 内置时由 App 设为它数据目录下的 `files/home/quetzal`）、`QUETZAL_ADAPTER`（身体适配器模块路径）、`QUETZAL_WEB_DIR`（网页控制台的静态文件目录，缺省为 `main.cjs` 旁边的 `web/`；`src/web.ts` 托管它并提供本机浏览器免配对码登录 `GET /auth/local`）、`QUETZAL_DEV_ORIGINS`（开发时允许领取本机登录令牌的额外页面源，逗号分隔）、`QUETZAL_GATEWAY_HOSTS`（局域网模式下配对接口额外接受的 Host 名，逗号分隔；局域网监听只走 HTTPS，见 [API §1](../../docs/API.md)）、`QUETZAL_SANDBOX=none`（强制不用沙箱，只供排查问题）、`QUETZAL_HIDE_PATHS`（proot 沙箱额外遮住的目录，冒号分隔；Quetzal App 用它遮住自己的私有数据）。

agent 的命令在沙箱里运行（`src/sandbox.ts`）：Linux 用 `bwrap`（bubblewrap）或 Landlock，安卓用 `proot`（Quetzal App 内置；旧的 Termux 安装由安装脚本装），Windows 用 sandbox-runtime 的沙箱用户，macOS 用 sandbox-runtime 生成的 Seatbelt 配置经系统自带的 `sandbox-exec` 运行（边界见 `src/sandbox-macos.ts`）；一种都没有时缺省不执行她的命令，`status.sandbox.kind` 为 `none`。这些程序不是 npm 依赖。对方批准或自己打开「真实环境」（`src/host-mode.ts`）的那个会话里，她的命令不经沙箱，见 [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §8.2。

架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，接口见 [../../docs/API.md](../../docs/API.md)。内核专项开发与实现现状见 [../../docs/engine/README.md](../../docs/engine/README.md)，包含上下文、记忆、执行循环、工具接口和基线验证。

自适应记忆按 [M0–M5 计划](../../docs/engine/ADAPTIVE_MEMORY_PLAN.md)推进，M1 已放行、M2 尚未放行。`adaptiveMemory.enabled` 和固定 `hostBody` 管来源处理，新增 `semantic` 默认 false：显式开启后，同一 runtime 后台运行 `adaptive-worker.ts` 增量整合与 `adaptive-review.ts` 依赖重评，使用控制台已配置的供应商主顺序。状态 / 开关仍经既有 `memory.adaptive.*` 管理接口；UI 与真人试用尚未验收。

`adaptive-model.ts` 复用模型路由、出站脱敏、实际用量和取消信号；完整输入装不进候选模型窗口时不发请求，不截掉必要依据。它严格拒绝截断、工具调用和非 JSON 输出。当前 ADC 仅由 `tool/adaptive-vertex-smoke.py` / `adaptive-vertex-proposal.py` 用于开发，不被后台读取或复制到其他身体。

认识的版本与支持 / 反证规则在 `adaptive-evidence.ts`、`adaptive-graph.ts`；`adaptive-archive.ts` 在灵魂 exclusive 内核对权威文件和发件箱再重建。接受结果后沿用[文件 / Git 自动发布](../../docs/engine/ADAPTIVE_MEMORY_STORAGE.md)。增量处理目前最多 1000 条记录 / 100 个来源且提示不超过 256 KiB，原文失效或超限进入有界失败重试；尚缺大历史候选选择和失效原文的自动重新整合。每次新整合回执最多资助五次重评，预算在本机 KV 保留；没有可用模型时显示 unconfigured。本机忙碌时等待空闲，连续等待 30 秒后允许处理，模型时间墙 150 秒；性能尚未验收。

**semantic 开关目前只用于后台接线试验**：前台语义读取 / 纠正覆盖尚未完成，开启时新增的 adaptive 来源查询返回 unavailable、不注入旧观察。关闭 semantic 恢复 M1 来源路径。旧记忆路径保持既有行为，这不是全局纠正一致性验收通过。多身体与控制台完整试用仍待后续门禁，不能据本机合成 HTTP 测试宣称产品完成。

真实开发工具 `adaptive-semantic-pilot.ts` 与 `adaptive-review-pilot.ts` 使用仓库外隔离数据，见[评测登记](../../docs/engine/ADAPTIVE_MEMORY_EVAL.md)。开源探针与边界见[组件实验](../../docs/engine/ADAPTIVE_MEMORY_COMPONENTS.md)。Graphiti 提示适配副本的许可证与修改说明位于 `third_party/graphiti/`；`tool/build-main.mjs` 将完整许可和说明嵌入所有平台共用的 main.cjs。未新增运行依赖、独立服务或环境变量；已有 TypeScript / 测试模式覆盖实现，构建入口已同步更新。

发布前真实模型验收可在显式隔离的 `QUETZAL_HOME` 中运行 `node --experimental-strip-types tool/verify-memory-real.ts`。须先建立 `.release-verification` 标记并配置模型；只用合成资料，结果写本机，不复制真实人格或记忆。此检查会产生真实API费用，推理quick模型验收使用2400选择输出tokens、30秒语义选择与4096摘要生成tokens／60秒摘要预算，并为学习使用4096输出tokens与120秒模型会话预算；不是默认5秒延迟通过或长期收益证明。

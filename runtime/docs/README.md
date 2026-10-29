# runtime · 运行基座

TypeScript / Node.js 22.13+，使用内置 `node:sqlite`，主入口打包为 `dist/main.cjs`。runtime 装配身体、心脏、对话、模型、记忆、权限、网关和 mesh；纯模型—工具循环由独立 engine 提供。先读[项目原则](../../docs/PRINCIPLES.md)与[全局架构](../../docs/ARCHITECTURE.md)，文件职责见[模块地图](ARCHITECTURE.md)。

## 构建与运行

以下命令在 `runtime/` 执行：

```sh
npm ci
npm run build
npm test
```

build 包含 engine / runtime 类型检查、主入口、平台适配器与辅助产物构建；完整命令以 [package.json](../package.json) 和 `tool/build-main.mjs` 为准。测试覆盖 `test/*.test.ts` 和 `engine/test/*.test.ts`，执行过的历史结果不等于本轮重新通过。开发合成数据可用 `npm run dev`（固定 `./.dev`，已忽略）；真实试用使用仓库外独立家目录。当前分支构建、控制台和两身体接入步骤见[试用版运行说明](../../docs/engine/ADAPTIVE_MEMORY_RELEASE.md)。

平台适配器位于 `adapters/android/`、`termux/`、`linux/`、`macos/`、`windows/`，构建为同名 `.mjs`。安卓 App 内置身体与运行环境，桌面适配器探测平台能力；Windows 另有桌面身体助手 / 守护产物，macOS / Windows 沙箱库单独打包为 `srt.mjs`。这些平台设计见[全局部署契约](../../docs/ARCHITECTURE.md#10-进程与部署契约)，不能以本机验证代替跨平台验证。

## 配置与宿主边界

| 项目 | 说明 |
|---|---|
| `QUETZAL_HOME` | 配置、秘密、SQLite、灵魂、派生组件和运行数据根目录；Termux 默认 `~/quetzal`，Windows 为 `%LOCALAPPDATA%\Quetzal\home`，其他桌面系统为 `~/.quetzal`；安卓 App 自行注入 |
| `QUETZAL_ADAPTER` | 平台身体适配器模块路径；具体设备不进入核心实现 |
| `QUETZAL_WEB_DIR` | 网关托管的控制台 Web 目录 |
| `QUETZAL_DEV_ORIGINS` | 开发浏览器额外允许的 Origin，精确匹配；不默认信任本机任意端口 |
| `QUETZAL_GATEWAY_HOSTS` | 局域网配对接口额外接受的 Host 名，逗号分隔；不是允许任意浏览器 Origin |
| `QUETZAL_SANDBOX=none` | 部署排障时强制不用沙箱；不是正常运行的建议默认值 |
| `QUETZAL_HIDE_PATHS` | proot 额外遮住的绝对目录，冒号分隔；安卓 App 用于保护自身私有数据 |
| `config/quetzal.json` | 运行配置，日常通过控制台 / ops 修改；完整默认值与接口见[API](../../docs/API.md) |
| `config/providers.json` | 模型路由与加密 Key；生产后台沿用控制台配置，不自动读取开发 ADC |

控制台、CLI 与飞书通过统一操作层进入宿主；工具经过权限与审计。`src/mcp/` 管理 stdio、Streamable HTTP / SSE 与 OAuth 客户端，`src/plugins/` 管理插件及技能；无 MCP 服务端。身体命令由平台沙箱执行，沙箱边界与不可用行为见全局架构，不能把整个 runtime 进程称为沙箱内执行。

## 记忆与运维

当前分支提供[自适应记忆试用版](../../docs/engine/ADAPTIVE_MEMORY_RELEASE.md)。固定中心使用 SQLite 图 / 检索投影、版本化私有存档和后台 LLM；不部署独立 Python 记忆服务或图数据库。开启 `enabled` 后统一事实写入，`semantic` 控制整理，`research` 控制研究，三者默认 false。行为与旧 PRIME 的关系见[实现总览](../../docs/engine/ADAPTIVE_MEMORY.md)。

中心自动安装固定检索组件到 `QUETZAL_HOME/data/adaptive-retrieval/`；需要现有 Node 配套 npm、固定 npm registry 与模型下载网络。组件未就绪时退回词面检索，下载、索引与可恢复故障在后台推进，状态经管理接口显示；运行数据不提交 Git。组件依赖使用独立锁，与主运行依赖分开，详见[组件说明](../../docs/engine/ADAPTIVE_MEMORY_COMPONENTS.md)。

增量整合先取有界候选并补必要依据；向量全局目录分页维护。前台读取核查来源 / 版本，完整性另有后台巡检；不把索引状态当作语义质量。备份通过控制台创建 / 核查，恢复经 `quetzal restore` 写入新家目录和新身体身份，再正常配置 / 配对，不重放旧行动。范围见[存储协议](../../docs/engine/ADAPTIVE_MEMORY_STORAGE.md)。

## 依赖与构建理由

运行时依赖 `@modelcontextprotocol/client`（锁定 2.3.1，Apache-2.0）：官方 MCP 协议实现，stdio、Streamable HTTP、旧版 SSE 传输与 OAuth 客户端（`auth()`）都来自它，支持现代 / legacy 协商；远程与插件没有新增依赖（出站检查用 Node 内置 http / https，git 仓库用系统的 git）；没有引入服务端框架或将 SDK 放进 engine。

运行时依赖：`ws`（网关）、`@larksuiteoapi/node-sdk`（飞书长连接、交互卡片、一键创建机器人）、`jpeg-js`（纯 JS 的 JPEG 编解码：手机上没有 ffmpeg / ImageMagick 时也能把大照片缩小后交给模型）、`microsoft-cognitiveservices-speech-sdk`（听觉的流式识别：裸 WebSocket 协议的社区实现都已弃用，官方 SDK 是 Node 下的标准做法，打包后约 1 MB），以及 `@peculiar/asn1-x509` + `@peculiar/asn1-schema`（锁定精确版本，MIT，纯 JS）：网关局域网 HTTPS 的自签名证书（`src/tls.ts`）。Node 有 TLS 却没有生成 X.509 证书的接口，证书的 DER 编码不自己写，用 PeculiarVentures 维护的 ASN.1 结构定义（`@peculiar/x509` 的底层），签名用 `node:crypto`。没用更上层的 `@peculiar/x509`：它依赖 `tsyringe`，要求进程里装全局的 `reflect-metadata` 补丁；`selfsigned` 新版本建立在 `@peculiar/x509` 之上，旧版本基于 `node-forge` 只能生成 RSA。证书签名只使用 `node:crypto` 的标准 EC 能力。

交付物（`deliverable_create`，[ARCHITECTURE §5.8](../../docs/ARCHITECTURE.md)）的五个库，都是 MIT、纯 JS、锁定精确版本：`marked` 18.0.14（Markdown 解析，GFM）、`docx` 9.8.1（Word）、`exceljs` 4.4.0（Excel）、`pptxgenjs` 4.0.1（PowerPoint）、`pdfkit` 0.19.1（PDF；开发依赖 `@types/pdfkit` 0.17.6 只给类型检查）。依据：这几种格式都是各自领域里使用最广、维护最久的开源实现，自己写 OOXML / PDF 只会更差；间接依赖也都是宽松许可（MIT、ISC、Apache-2.0、BSD、0BSD、BlueOak、Unlicense；`jszip` 为 MIT 或 GPLv3 双许可，按 MIT 使用）。pdfkit 留在 0.19：0.20 起 Node 入口改用 `import.meta.url` 与 `createRequire` 读数据文件，打进 CommonJS 的 `main.cjs` 后加载即报错；它的 14 种标准字体从自己的目录读 AFM 文件，打包后读不到，所以生成 PDF 时一律嵌入探测到的系统字体（中文字体的探测见 §5.8），从不用标准字体。这些库在第一次生成文件时加载（动态 `import`）；实际产物大小以当前构建为准。

可选依赖一个：`node-datachannel`（libdatachannel 的 Node 绑定，MPL-2.0，原生模块）——网状层的 WebRTC：ICE 穿透、DTLS 加密、SCTP 可靠传输都是安全敏感、久经考验的标准实现，不自己写。它不打进 `main.cjs`（esbuild `--external`），由安装器按 `tool/mesh-modules.lock.json` 的版本与 sha512 下载核对（`tool/install-mesh-modules.mjs`，安卓、Linux 与 macOS 共用；平台 android-arm64、linux-<x64|arm64>-<gnu|musl>、darwin-<x64|arm64>、win32-<x64|arm64>）；加载不了时网状层关闭，身体之间仍用 git 同步。升级它时同步修改 `package.json` 的 `optionalDependencies` 与锁定文件（哈希取自 registry.npmjs.org 的 `dist.integrity`）。

`package.json` 还声明了 `croner`（提醒的 cron 时刻计算）、`beautiful-mermaid`（`dist/mermaid.mjs` 的 SVG 兜底渲染）与 `@anthropic-ai/sandbox-runtime`（Windows 与 macOS 的命令沙箱，单独打包为 `dist/srt.mjs`，核心只在这两个平台上加载）。可选 WebRTC 与 Windows 沙箱的原生组件由安装 / 发布流程提供。依赖与构建产物以 `package.json` 和 `tool/build-srt.mjs` 为准。

## 开发验证入口

| 命令（runtime 目录） | 用途 |
|---|---|
| `npm run bench:adaptive-read -- 100 100,500,1000` | 合成读取工程基准，不调用生成模型 |
| `npm run eval:adaptive -- --check` | 校验冻结案例；评分读取已审核回执，不代替运行和语义审核 |
| `npm run pilot:adaptive-multibody -- --kind=stub` | 独立本机身体、网关与复制的开发流程；替身不是模型语义成绩 |
| `npm run pilot:adaptive-live -- --model=gemini-3.8-flash` | 显式授权的 ADC 真实模型开发试跑，会产生费用，不用于生产配置 |
| `npm run run:adaptive-eval` / `npm run review:adaptive-eval` | 正式计划、执行与审核入口；使用前核对[运行器说明](../tool/adaptive-eval/README.md)的实际参数 |

真实评测材料放在仓库外隔离家目录。保留原失败、实际模型版本、返回状态和缺失用量；模型评语不能冒充产品通过。关闭 SQLite、连接和子进程后再清理夹具，避免 Windows 文件占用；大批运行先核对容量，公共缓存与证据分开管理。

各阶段实测保留在[验证记录](../../docs/engine/ADAPTIVE_MEMORY_PROGRESS.md)，当前未完成项集中在[交付 backlog](../../docs/engine/ADAPTIVE_MEMORY_RELEASE.md)。本入口不重复维护阶段进度或逐次修复日志。

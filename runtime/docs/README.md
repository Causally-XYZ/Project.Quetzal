# runtime · 运行基座

TypeScript / Node.js 22+。核心存储用内置 `node:sqlite`，无需额外 SQLite 原生扩展，打包为单文件 `dist/main.cjs`。平台级身体适配器：`adapters/android/`（任意安卓手机，身体能力经 Quetzal App 的本机身体接口提供，操作屏幕靠 App 的无障碍服务）打包为 `dist/android.mjs`，随 Quetzal App 内置（App 只装一个，运行环境也在里面，见 `../console/tool/android-runtime/`）；`adapters/termux/`（旧的 Termux 安装：安卓手机 + Termux:API）打包为 `dist/termux.mjs`，保留以兼容；`adapters/linux/`（任意 Linux 电脑或服务器：电池与温度读 `/sys`，通知、播放、剪贴板、相机、录音，以及看屏幕与操作应用（xdotool / ydotool / wtype、AT-SPI、截图程序）按可用程序探测）打包为 `dist/linux.mjs`，随 npm 包 `@plutokeating/quetzal`（`../cli`）内置；`adapters/macos/`（任意 Mac：电量读 pmset、电池温度与设备标识读 ioreg，通知、截图、剪贴板、打开、播放用系统自带的程序，拍照录音按可用程序探测；hands 用 JXA 经 System Events 读无障碍树与窗口、按键输入，鼠标用 cliclick 或 CoreGraphics 的 CGEvent）打包为 `dist/macos.mjs`，同样随 npm 包内置；`adapters/windows/`（任意 Windows 10 1809 起 / 11 电脑：电源、温度、Toast、截图与操作屏幕（UI Automation + SendInput）、剪贴板、打开、播放、拍照、录音，常驻一个 PowerShell 5.1 进程执行）打包为 `dist/windows.mjs`，另有用户桌面里的身体助手 `dist/windows-body.mjs` 与守护进程 `dist/windows-supervise.mjs`，随 Windows 安装包（`../cli/windows`）分发。Windows 与 macOS 的命令沙箱库单独打包为 `dist/srt.mjs`（Windows 的 srt-win.exe 由安装包放进 `srt-win\`；macOS 用系统自带的 sandbox-exec，srt.mjs 随 npm 包放进版本目录），Mermaid 兜底渲染器为 `dist/mermaid.mjs`（桌面用，按需加载）。

| 命令 | 作用 |
|---|---|
| `npm run bench:adaptive-read -- 100 100,500,1000` | 合成认识读取基准；样本数与规模可指定，临时 SQLite / 灵魂文件自动清理，不调用模型 |
| `npm run eval:adaptive -- --check` | 校验 M2 冻结数据；`--score <仓库外评测目录>` 只读汇总已有审核回执，不调用模型；不是完整运行器 |
| `npm run pilot:adaptive-multibody -- --kind=stub` | 公开开发案例的真实双身体链路；`--kind=live --model=gemini-3.8-flash` 显式使用 ADC 真实模型；不是正式留出验收 |
| `npm test` | 单元与集成测试（心脏、记忆与 FTS5 检索、上下文、会话与子 agent、灵魂 git 合并、模型路由、安全、听觉、网关、网状层与平台适配器；具体范围见 `test/*.test.ts` 及 `../engine/test/*.test.ts`） |
| `npm run build` | engine 独立类型检查 + runtime 类型检查 + esbuild 打包：`dist/main.cjs`、`android.mjs`、`linux.mjs`、`macos.mjs`、`termux.mjs`、`windows.mjs`、`windows-body.mjs`、`windows-supervise.mjs`、`mermaid.mjs`；最后由 `tool/build-srt.mjs` 打包 `dist/srt.mjs` |
| `npm run dev` | 以 `./.dev` 为家目录直接运行源码 |

测试夹具清理临时 `QUETZAL_HOME` 前，须先结束模型服务 / MCP 连接并关闭 SQLite `store.db`，再删除目录。Windows 不允许删除仍由数据库打开的文件；清理失败同样属于测试失败，不能以忽略 EPERM 或跳过用例替代释放资源。

前台来源材料保留原消息 recordedAt；语义正文的根 hash 与本机可见原文一致时附上时间，缺失或排除来源不补日期。跨会话近况区分会话更新与消息记录时间；后台 / 对话均要求保留未陈述角色的不确定性。公开 `--case=time-roles` 用三次跨月消息检查同名歧义、原始时间和后续说话人纠正；真实效果与失败记录见阶段记录 §4.42。没有新增依赖、环境变量、生产脚本或数据迁移，现有 TypeScript / 构建和测试入口覆盖这些文件。

多身体开发入口可加 `--retrieval-cache` 启用真实中心向量路径、`--disconnect-step` 模拟卫星断线期间的输入。公开缓存只按固定摘要复制，准备、索引、查询、自动发布仍走生产链路。另有 `tool/adaptive-retrieval-probe/multibody.ts` 执行改述 / 撤回工程断言，生成模型为替身；具体参数、证据和边界见[运行器说明](../tool/adaptive-eval/README.md#显式真实向量与断线补做)。这些开发工具不进入 main，不新增生产依赖或配置。

自适应读取启用时，新对话回答自动保存消息来源凭据并随消息复制。来源被纠正 / 编辑 / 排除后，默认历史、跨会话近况、context_read、recall 不再沿用旧回答正文；原始历史保留。SQLite 可空列自动迁移，无需人工操作，旧身体丢失的字段可由新版补齐，缺失时明确未核查。凭据只表示消息依赖一致性，不证明回答正确或覆盖文件与外部工具。工程测试为 answer-basis / answer-basis-store / adaptive-query-host，以及独立身体运行器的真实网关 / 复制断言；无新依赖或启动配置，现有 package / tsconfig 已覆盖。

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

M2 留出数据已冻结50案例 / 60独立轨迹，三次重复计150案例序列；尚未向模型释放。`tool/adaptive-eval/` 保存输入、逐检查点断言、摘要及只读评分器，真实多身体运行器和执行计划冻结仍待完成。评分器拒绝缺失 / 错版本材料，替身和纯模型自评不记为通过；定位有效不等于语义真实，须核查原始执行证据。命令、审核信任边界见[工具说明](../tool/adaptive-eval/README.md)。package.json / tsconfig 已包含开发入口，测试由既有 glob 发现；无需新依赖、环境变量、迁移或部署服务，不打入 main.cjs。

公开多身体开发入口已接入独立进程、真实网关 / WebRTC / 自动灵魂发布和现有模型适配器；历史输入在同步写入时固定合成时间，问题经对端网关回答。每步保留实际输入 / 输出、版本、来源、发布与退出证据，后续问题 / 回答按正常历史继续处理。首次观察到错误保留失败，不开启正式留出；当前支持既有 ignored 来源门禁、独立 agent 的范围负例，以及 --case=graph 的受控 AND/OR 图；受控安装不计为模型构图能力，未实现完整正式回执生成。缺省 stub；显式 live 才调用 ADC 模型。开发预算、源码指纹、数据位置与限制见[工具说明](../tool/adaptive-eval/README.md#公开多身体开发试跑)。新增入口 / 子进程纳入 tsconfig，复用 ws、node-datachannel 及 Node 内置模块，无新依赖或生产部署配置。

`adaptive-model.ts` 复用模型路由、出站脱敏、实际用量和取消信号；完整输入装不进候选模型窗口时不发请求，不截掉必要依据。它严格拒绝截断、工具调用和非 JSON 输出。ADC 只用于显式启动的开发探针 / 试跑，生产后台不自行读取它，也不复制到其他身体。

前台认识匹配保留模型改写正文及共同有效支持链的原文表达；原文被译成另一种语言时不丢弃已有检索词，但仍不是完整多语言语义召回。只返回可见 / 全局共同证明成立的当前版本，不从隐藏 / 失效分支借词。新增索引工作预算超限时空降级；无额外 LLM 调用、依赖、服务或配置，具体边界见[语义查询](../../docs/engine/ADAPTIVE_MEMORY_SEMANTICS.md#前台认识查询)。

`npm run pilot:adaptive-live -- --model=gemini-3.8-flash` 运行公开的现实人物别名开发案例。它自动创建仓库外隔离家目录，逐次写入合成消息，让正常后台定时器、模型路由、Google 适配器和灵魂发布处理，再调用正常 converse 回答纠正后的问题。`tool/adaptive-vertex-transport.ts` 只为该试验进程中的保留域名注入本机已有 ADC；沿用探针的 `GCLOUD_BIN` / `GOOGLE_CLOUD_PROJECT` 约定，不保存认证、不改真实家目录、不代表生产 ADC 部署支持。试验会产生真实 API 费用，最多12次适配器请求，8分钟时发出中止；报告在输出的临时目录，含输入视图、模型结果、用量、认识快照和上下文选择。首个后台失败即保留失败退出，不把自动重试后的成功当首次成功。收尾时等待调用结束，仅额外新问题的后台取消可标 cancelled-at-shutdown，仍保留未知用量。pipeline completed 只表示流程完成，语义仍须逐项核查；其他历史召回未关闭，不能用最终答对单独证明新图的增益。真实运行与检索缺口见[阶段记录 §4.26](../../docs/engine/ADAPTIVE_MEMORY_PROGRESS.md#426-m2-真实宿主adc-传输与纠正后回答开发试验2026-10-27)。

开发提案探针默认 urllib，可显式设置 `QUETZAL_VERTEX_TRANSPORT=curl` 对照传输；该变量不影响生产。失败只记录安全类别 / 阶段，缺失用量为 null，SIGTERM 会清理 curl 子进程。边界测试需另跑 `python3 -B tool/test_adaptive_vertex_smoke.py`。开源检查点探针的独立清单 / 完整锁在 `tool/adaptive-checkpoint-probe/`，不进入 runtime 生产依赖，复现方法见[组件实验](../../docs/engine/ADAPTIVE_MEMORY_COMPONENTS.md)。

Google 适配器将已报告的思考 token 计入 output，每日用量与配置单价估算同步受益；后台 lastModel 还保留可选 reasoning / total。reasoning 是输出子集，不能再次相加，total 不用分项之和覆盖。`test/google-usage.test.ts` 用本机合成 HTTP 验证累计流、JSON、路由 / SQLite 汇总与提案回调；不代替真实语义质量评测。

认识的版本与支持 / 反证规则在 `adaptive-evidence.ts`、`adaptive-graph.ts`；`adaptive-archive.ts` 在灵魂 exclusive 内核对权威文件和发件箱再重建。接受结果后沿用[文件 / Git 自动发布](../../docs/engine/ADAPTIVE_MEMORY_STORAGE.md)。增量处理目前最多 1000 条记录 / 100 个来源且提示不超过 256 KiB，超限进入有界失败重试。原文编辑可重新整合，旧引文显式失效；忽略 / 删除 / 改成助手来源的派生记录及显式下游从增量提示排除，存档历史保留。另一条尚未处理的编辑不提前进入当前检查点。

重评除旧版本依赖外也发现原文 hash 变化，带入同语境已有对象及其定义；对象只是候选，仍由模型提议绑定。当前至多 100 条闭包 / 候选记录和 100 个来源、256 KiB 提示，超限或目标依赖来源不可读则延后。空提案不恢复旧依据；大历史候选选择与完整语义质量仍未验收。重评沿实际引用优先上游；上游退避时独立分支仍可推进。每五次调用触发 60 秒冷却，到期自动续做；同一输入轮次每个目标至多五次，最多登记 1000 个目标，计数在本机 KV 保留；没有可用模型时显示 unconfigured。本机忙碌时等待空闲，连续等待 30 秒后允许处理，模型时间墙 150 秒；性能尚未验收。

`adaptive-reading.ts` 提供按来源 / 精确历史版本的修订覆盖层，已接入实际 `context_read` / `recall`。两者在本机认识状态存在时核对权威存档和 SQLite 快照，关闭后台仍保留门禁；原文不修改，每页 / 每个命中与邻句附状态，不可访问来源不输出。默认历史也带本机已知修订，编辑 / 忽略来源不会沿用旧正文或图像；持久摘要只在全部压缩条目有来源版本且版本一致时继承，压缩期间变化最多重建一次。手动摘要仅存档，不截断可用原文。新测试在 `test/adaptive-reading.test.ts`、`test/adaptive-context-read.test.ts` 与 `test/adaptive-history.test.ts`；无新依赖 / 环境配置，现有测试和构建模式自动包含。

`adaptive-material.ts` 核对旧结构化候选 / 缓存的消息出处和当前文件，主模型发送前附局部修订；memory_records 保留原审核记录并另给 reading 状态，来源不可访问时不返回正文与旧引语。note_read 对受管记录及实际文件别名执行同一门禁，处理存档先核对权威文件 / 输入；普通无出处 Markdown 不猜语义来源，保留原文并标明未核实。recall 的文档命中复用同一来源 / 范围核查，在有界200项候选内过滤后再取条数；返回前核对文件，不能使用变动前的搜索片段。旧语义选择模型输入另附完整 reading 字段，不发送不可访问正文；缓存覆盖全部参与选择的候选来源，模型返回后再核对，词面降级也过滤失效访问。新测试为 `test/adaptive-material.test.ts`、`test/adaptive-recall.test.ts` 和 `test/adaptive-selection.test.ts`，现有测试 / 构建 glob 自动包含；没有新增依赖、环境变量、服务、数据库表或灵魂格式。

`mind/prompt.ts` 的生产 systemMessage 保留来源绑定，不能在交给上下文宿主前将对象序列化或展开成另一个对象。跨会话近况仍最多取五个会话各四条消息，在灵魂锁 / SQLite 快照内附当前修订；无绑定的实时发言和草稿只显示运行状态，旧手动摘要不作当前依据。原文节选仍最多160字符，修订完整，4000字符局部预算下整项省略并提示回查。模型准备前后核对跨会话变化，quick 内省的每个候选 / 故障转移也刷新。`test/adaptive-prompt.test.ts` 覆盖实际 converse / wake、HTTP 模型替身、竞态、预算、取消与存档异常。没有新增依赖、配置、服务或格式，现有类型检查 / 测试 glob / 构建入口直接覆盖。

`memory/read-receipt.ts` 捕获四类本机记忆读取的消息 / 文档摘要；`mind/tool-reading.ts` 在模型准备和 context_read 中核查历史工具结果，不重放工具。凭据通过引擎不透明 reading 字段与完整结果一起保存至 tool_calls.reading，启动自动补列，旧记录不伪造来源，记录淘汰同时删除凭据。原始结果不改；修订视图标为 atomic，不能头尾节选。测试见 `test/read-receipt.test.ts`、`test/adaptive-tool-reading.test.ts` 与 engine 的 loop / context-manager 测试。使用 Node 内置 AsyncLocalStorage / crypto，无新增依赖、环境变量或服务；现有类型检查、测试 glob 和部署打包包含新模块。仅本机数据库增加可空列，不改变灵魂格式或复制协议，旧程序仍可读取原有列。

`mind/process-reading.ts` 为历史过程生成执行索引；history 原始生成和 context 发送前都排除无独立凭据的展示副本。messageRef 回查同样投影 process，完整本机工具另经来源核查；缺失 / 其他身体旧副本不猜关联。摘要核查值包含读取政策版本，升级后旧摘要失效。新增路径复用原 context 缓存，无新表、依赖、配置或服务；既有 TypeScript / 测试 glob / 构建入口包含。专项用例见 adaptive-tool-reading 与 adaptive-history，原管理界面不改。

**semantic 生成与默认上下文仍处于受控试验**：集中主机本机现通过 `adaptive-query.ts` / queryAdaptiveSemantic 注入带版本、性质、时间、参与者和来源的认识，发送前后核对。查询不调用 LLM，复用现有词面排序和证据计算；原 M1 网络查询在 semantic=true 时仍 unavailable。关闭 semantic 恢复 M1 来源路径，全局纠正一致性仍未验收。新测试见 adaptive-query / adaptive-query-host；没有新增依赖、配置、表或服务，现有测试 glob / 类型检查 / 打包包含新模块。跨身体语义传输已通过独立进程工程测试，同步扫描成本、真实语义与控制台完整试用仍待后续门禁，不能据本机合成 HTTP 测试宣称产品完成。

真实开发工具 `adaptive-semantic-pilot.ts` 与 `adaptive-review-pilot.ts` 使用仓库外隔离数据，见[评测登记](../../docs/engine/ADAPTIVE_MEMORY_EVAL.md)。开源探针与边界见[组件实验](../../docs/engine/ADAPTIVE_MEMORY_COMPONENTS.md)。Graphiti 提示适配副本的许可证与修改说明位于 `third_party/graphiti/`；`tool/build-main.mjs` 将完整许可和说明嵌入所有平台共用的 main.cjs。未新增生产运行依赖、独立服务或生产环境变量；已有 TypeScript / 测试模式覆盖实现，构建入口已同步更新。

发布前真实模型验收可在显式隔离的 `QUETZAL_HOME` 中运行 `node --experimental-strip-types tool/verify-memory-real.ts`。须先建立 `.release-verification` 标记并配置模型；只用合成资料，结果写本机，不复制真实人格或记忆。此检查会产生真实API费用，推理quick模型验收使用2400选择输出tokens、30秒语义选择与4096摘要生成tokens／60秒摘要预算，并为学习使用4096输出tokens与120秒模型会话预算；不是默认5秒延迟通过或长期收益证明。


`adaptive-query-packet.ts` 校验独立语义信封，`mesh/adaptive-memory.ts` 注册仅正式身体可调用的 memory.adaptive.semantic.query；ops 提供同名管理查询。接收端核对本机权威记录版本和已复制来源，冲突 / 缺失时不使用旧结果。版本摘要各限1000项，信封512 KiB，网络与核查共用500毫秒截止。新增 adaptive-query-packet / adaptive-semantic-mesh 测试使用临时隔离身体和只读桥进程；认识为合成安装。没有新包、环境配置或部署服务，既有 TypeScript / 测试 glob / main 打包包含新模块；灵魂与网状认证格式不变。

认识传播专项 `test/adaptive-semantic-sync.test.ts` 使用两个独立身体、临时裸 Git 远端和真实网状传输。仅提案为合成，后续由后台发件箱自动提交 / 推送、网状提示自动拉取；离线期间错过提示的身体通过正常 converse 拉取恢复，测试不手工安装或同步认识文件。`SOUL_ALLOW_LOCAL_REMOTE=1` 仅沿用既有测试例外，`TEST_SOUL_REMOTE` 仅测试夹具读取；生产仍要求 SSH。无新增依赖、生产配置或服务；既有测试 glob / 类型检查 / 构建入口覆盖。

`adaptive-semantic-pilot.ts` 缺省运行 aliases 开发案例，可用 `--case=time` 检查模糊时间、后续纠正与无关偏好保留。`tool/adaptive-pilot-cases.ts` 保存公开输入 / 检查点，新目录先写案例摘要；开发报告不含凭据且不计作自动语义评分。新工具模块由现有 pilot import 纳入类型检查，无新依赖、生产环境项、部署入口或 schema 变更。

读取优化的依据和边界见[阶段记录 §4.25](../../docs/engine/ADAPTIVE_MEMORY_PROGRESS.md#425-m2-权威核对下的投影复用与读取规模测试2026-10-27)。基准每次新建 Archive 包装对象，并分别记录首次投影恢复、查询和原文修订读取；首次恢复不表示磁盘冷缓存。开发脚本已加入 package.json / tsconfig，复用 Node 内置模块，无依赖锁、部署配置或数据格式变更。

重评上下文现在保留已从当前分支移除的历史依赖所对应的当前修订与来源，避免省略先前撤回、只向模型提供最初规则。原始历史不会重新安装为当前记录；不可读或超过预算则延后。此改动只补齐实际材料，是否正确理解和不新建同义错误仍需真实语义验收；不代表自动修复已接受的所有错误图。沿用现有构建 / 测试入口、配置、任务队列与灵魂格式，无新依赖或迁移。

跨语境关系由 claim.references 表示，角色可开放描述，目标提及保留自己的语境和身份；participants、支持与反证不能跨语境借用事实。引用目标的歧义 / 修订也影响关系可用性。内部存档和语义查询已升版，新读取器兼容旧认识；旧程序读取新结果会拒绝，不能静默使用旧投影。详见[语义格式](../../docs/engine/ADAPTIVE_MEMORY_SEMANTICS.md)。公开 `pilot:adaptive-multibody -- --case=realm` 可运行现实亲属 / 同名小说角色 / 后续纠正开发案例，不修改冻结留出集，默认仍为 stub。

Google 记忆提案通过原生结构化输出发送 schema；其他协议继续提示格式并严格解析。故障转移会按新候选重新准备 schema 和窗口；供应商约束不替代宿主形状 / 来源 / 版本校验。普通对话不变，无新增依赖、配置或部署步骤。`adaptive-structured-output.test.ts` 检查实际 HTTP 请求 / 跨协议故障转移，`provider-failure-reason.test.ts` 检查固定失败分类及既有超时边界；开发记录保留实际 schema，缺失用量不填零。


`tool/adaptive-retrieval-probe/` 为独立开源改述召回实验：完整开发锁、固定模型摘要、公开夹具、实际词面函数与上游 RRF。词面、真实嵌入、混合与生产宿主对照均已运行，开发成绩不等于正式语义验收。准备工具仅下载固定公开文件，支持中断续传；模型推理前再次核对全部文件，禁止远程自动取模型。所有安装依赖、模型和结果放仓库外；固定组件清单已由生产适配共用，探针本身不进入 main，无新生产配置。复跑与边界见[探针说明](../tool/adaptive-retrieval-probe/README.md)。


adaptive-vector / adaptive-vector-worker 已将固定 E5 的实际近邻接到宿主查询：中心自动准备并加载 QUETZAL_HOME/data/adaptive-retrieval/component 中的固定组件，空闲时增量索引，100ms内无近邻则词面降级；最终仍核对当前来源和认识摘要。SQLite 缓存按 agent / 模型空间隔离，组件关闭时等待原生调用释放。独立组件清单位于 components/adaptive-retrieval，固定版本不加入所有身体的 npm 主依赖；tsconfig 开启 JSON 导入，worker 与固定元数据由既有 main 构建纳入。首次安装、模型续传、停止取消、依赖重装、派生库损坏重建和暂时索引失败重试均已接线；使用者不需要执行开发准备脚本。缓存预热下的真实部署已验证，全冷网络及跨平台仍待验收。RRF 副本许可继续随 main 分发。检索探针的 --fusion-only 可不安装模型就对照固定上游；vertex.py 的 --live 仅用公开夹具做独立 ADC 参考，不表示可接受其前台网络延迟。

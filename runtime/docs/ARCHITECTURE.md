# runtime 模块地图

整体原理见仓库根目录的 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。本文列出每个文件的职责与约定。

`memory/answer-basis.ts` 管回答消息来源凭据的严格形状、摘要、跨调用合并与失效判断。`mind/context.ts` 在实际准备成功后累计消息读取快照，`brain.ts` 注册当前输入 / 插话来源并随正常最终回答保存；`store.ts` 自动迁移 messages.answerBasis 及其非空部分索引，并在既有复制中校验、保存及补齐空凭据。`adaptive.ts` 在同一快照展开派生回答的消息来源，history / prompt 近况 / context_read / recall 使用统一状态，changed 时不沿用旧正文。仅保证这些已记录消息依赖，不能替代回答语义评测或其他派生材料的完整来源，详见[读取语义](../../docs/engine/ADAPTIVE_MEMORY_SEMANTICS.md#4-纠正事务和读取)。无新依赖、环境配置、服务、RPC 或灵魂格式；现有构建 / 测试 glob 纳入新模块。

`mind/prompt.ts` 的公共政策区分资料缺失与有依据的否定，不依赖认识是否命中；故障转移的每个候选继续携带。`memory/adaptive-proposal.ts` 对后台提出同样约束，明确过去否定与后来状态变化可并存。没有增加语义判真模块或额外前台模型调用；工程材料测试与真实语义结果分开记录，见[证据边界试验](../../docs/engine/ADAPTIVE_MEMORY_PROGRESS.md#435-m2-未知与否定的证据边界2026-10-27)。

内核专项现状与维护入口见 [docs/engine/README.md](../../docs/engine/README.md)；按调用链阅读可从 [模块地图](../../docs/engine/MODULE_MAP.md) 开始。源码变动涉及执行、上下文、记忆或工具边界时，应同步核对对应主题与基线记录。

开发中的自适应记忆见[实施计划](../../docs/engine/ADAPTIVE_MEMORY_PLAN.md)，M1 工程验收情况以阶段验证记录为准，语义认识仍待 M2。`memory/adaptive-store.ts` 管来源修订、持久任务、租约与处理回执；`memory/adaptive.ts` 管固定身体后台处理和有界读取；`mesh/adaptive-memory.ts` 复用正式成员认证；`mind/context.ts` 在模型准备阶段注入原文观察。`main.ts` 在非安全模式初始化灵魂后启动宿主，退出时停止，默认配置关闭。发布协议见[存储与恢复](../../docs/engine/ADAPTIVE_MEMORY_STORAGE.md)：结果接受与任务完成同事务，文件安装和本地 Git 确认分别可恢复；受管存档不进入普通笔记召回。SQLite 数据与任务均在 `QUETZAL_HOME/data/quetzal.db`，没有新增守护进程或依赖。多身体验收使用本机独立进程与网关，不能以两个浏览器标签替代两具身体；桌面 / 移动视口交互留待对应阶段。

M2 的 `memory/adaptive-evidence.ts` 校验 node / mention / claim 版本和原文引用，计算带反证的依赖状态；`memory/adaptive-graph.ts` 将版本投影与任务 / 发件箱同事务安装。见[语义格式与边界](../../docs/engine/ADAPTIVE_MEMORY_SEMANTICS.md)。默认仍用 source-v1；显式开启 adaptiveMemory.semantic 后后台整合与重评会调用这些库。集中主机本机前台经 `adaptive-query.ts` 选择当前 supported 陈述与 ambiguous 提及，其他正式身体经独立语义查询协议接入，接收前检查本机更高版本 / 同版分叉和来源冲突。`adaptive-review.ts` 沿真实依赖优先上游；重评上下文从当前及历史版本发现依赖身份，给出其当前修订和来源，历史分支不作为恢复支持或调度顺序的依据；`adaptive-review-budget.ts` 实现五次调用后的自动冷却续做和跨重启目标计数，由 adaptive.ts 在模型调用前写本机 KV。无需新增服务或 npm 依赖，现有 TypeScript 构建自动包含该模块。

`memory/adaptive-archive.ts` 包装投影访问：先核对权威文件与发件箱，再核对实际投影摘要；内容均未变时复用，变化时原子重建；后台访问已持灵魂 exclusive。投影 schema 2 支持无本机发件箱的文件恢复，并从 schema 1 原子迁移；读取失败不能退回旧缓存。

`memory/adaptive-reading.ts` 从精确历史版本生成来源修订覆盖层；`adaptive.ts` 的 withAdaptiveSources 在灵魂锁 / SQLite 快照内执行原文读取，searchAdaptiveHistory 核对召回命中和邻句。实际 context_read / recall 接入；存在本机认识状态时，关闭生成也不丢弃修订。只承诺本机快照。默认历史由 `mind/context.ts` 在模型准备前重建；来源或认识版本变化会清摘要缓存，发送前复核，至多重建一次。无来源版本的持久摘要不继承；`adaptive-material.ts` 在发送前核对旧候选文件及消息来源，工具 memory_records / note_read 同样附当前读取状态；原审核不能充当新证据，不可访问来源的派生正文不输出。recall 文档命中与笔记读取共用准备 / 快照呈现逻辑，旧语义选择器在模型调用前、返回后和缓存命中时核查来源；`mind/prompt.ts` 的 systemMessage 通过对象来源绑定保留跨会话读取能力，context 在同一快照核对近况并纳入准备前后摘要值，quick 内省在每个候选上重新读取；未绑定来源的其他派生资料和远端语义读取仍待接入。

`memory/read-receipt.ts` 用 AsyncLocalStorage 记录记忆工具实际读取的来源 hash / 文档摘要，拒绝混合或超限的可用凭据；`mind/tool-reading.ts` 核查作用域、原结果和当前来源，生成当前投影。store 启动自动为 tool_calls 补 reading 可空列；engine 仅原样把不透明凭据交给 recordTool。context 准备和 context_read 工具回查共用投影，atomic 标记防止修订被头尾节选裁掉。无新依赖 / 服务，既有构建自动包含；灵魂格式不变。

`mind/process-reading.ts` 为历史过程生成执行索引；history 原始生成和 context 发送前都排除无独立凭据的展示副本。messageRef 回查同样投影 process，完整本机工具另经来源核查；缺失 / 其他身体旧副本不猜关联。摘要核查值包含读取政策版本，升级后旧摘要失效。新增路径复用原 context 缓存，无新表、依赖、配置或服务；既有 TypeScript / 测试 glob / 构建入口包含。专项用例见 adaptive-tool-reading 与 adaptive-history，原管理界面不改。

`memory/adaptive-proposal.ts` 提供开发用提示 / responseSchema 和提案规范化；`memory/prompts/adaptive-graphiti.ts` 复用经过适配的上游规则，许可见 `runtime/third_party/graphiti/`。开发工具保留独立 ADC 评测；宿主通过 adaptive-model.ts 调用控制台供应商，不复制 ADC。tool/build-main.mjs 将完整 Graphiti 许可嵌入 main.cjs。

开发评测在 `tool/adaptive-vertex-*.py` 保留安全失败分类和可选 curl 传输，未报告用量为 null；取消会结束 HTTP 子进程。`tool/adaptive-checkpoint-probe/` 单独锁定开源探针的开发依赖，实际执行真实 MemorySaver 契约，不加入生产依赖 / 打包路径；范围和复现命令见[组件实验](../../docs/engine/ADAPTIVE_MEMORY_COMPONENTS.md)。

`tool/adaptive-eval/` 是独立的 M2 留出资料与评分工具：spec 校验50案例的逐步输入 / 权限 / 轨迹，cases 为冻结构造器，holdout / manifest 保存正式数据及摘要，score 核查回执证据定位并按固定分母统计，cli 提供只读检查和评分。这些数据 / 评分模块不启动宿主、不生成语义审核、不改变生产提示；完整正式运行器尚未完成。测试夹具的 live 标记只测试算术，不能当真实成绩；运行计划和审阅身份仍需受信流程核对。见[工具说明](../tool/adaptive-eval/README.md)。

同目录新增 development / run-track 只运行公开开发案例；body 独立启动实际宿主、网关、复制与灵魂同步，process-client 管有界 IPC / 认证 RPC / 退出，model-observer 在适配器边界保存证据并以既有 ADC 传输调用真实模型或明确替身。历史来源同步注入记录时钟，正常后台安装后等待对端当前版本；每步对端网关回答及其后台处理完成后才释放下一步。它支持 ignored 来源门禁与第三个独立 agent 存储进程 / RPC 范围对照，仍拒绝受控图操作，不生成正式评分或修改生产提示；完整正式运行器仍待完成。

执行核心入口为 `main.ts` → `mind/brain.ts`（宿主适配）→ 根级 `engine/src/loop.ts`；上下文由 `mind/prompt.ts` 政策快照、`mind/context.ts` 每步工作状态/动态记忆、完整 history 与本轮工具消息组成；根级 context-manager 为实际候选窗口准备克隆视图。UTF-8字节保守估计（不是真tokenizer）、稳定摘要与原文回查、下一轮生效的手动会话压缩、共享工具的子 agent，以及预算 / 步数的实际约束见全局架构 §3.2、§5、§5.4。MCP 客户端（stdio 与远程）与插件经宿主工具链接入，本机 TUI 经现有网关接入；网关、身体间 RPC 与 Agent Skills 是各自独立的接口 / 文档机制。

```
src/
├── main.ts               装配各模块（打开数据库后做一次权限缺省档位的迁移，见 guard/sentinel.ts）；主动消息（say）入库到它带的会话（带着她醒来时生成的文件作附件），没带的进「主动消息」会话，并发系统通知；熔断（安全模式）；没人接住的同步异常记下后以非零退出（由守护者拉起）
├── config.ts             家目录布局（Windows 为 %LOCALAPPDATA%\Quetzal\home）、配置读写、密钥文件（改名遇到占用时重试）；密钥目录与保密库：POSIX 0700，Windows 用 ACL 只留本用户与 SYSTEM
├── platform.ts           平台差异（isWindows / isMac）：命令查找（Windows 按 PATHEXT）、结束整棵进程树（POSIX 进程组 / Windows taskkill /T）、只给本用户的目录权限（chmod / icacls）、遇到占用时重试的改名
├── ssh-key.ts            OpenSSH 格式的 ed25519 部署密钥（Node 内置 crypto 生成，不依赖 ssh-keygen）
├── mermaid.ts            Mermaid 的兜底渲染（网关 mermaid.render，单独打包为 mermaid.mjs）：beautiful-mermaid 画 SVG，整理成 flutter_svg 能显示的静态 SVG
├── bus.ts                进程内事件总线（sense / message / timeline / state / approval / say / notice / activity / secret / soul.alert / soul.pushed / mesh / mesh.event / reminders.changed / claims.changed / goals.changed / taskStates.changed / agents.changed / turns.changed / canvas.changed / canvas.replica 等）
├── store.ts              SQLite：kv、timeline、sessions、tool_calls（每次工具调用的完整参数与完整结果，只在本机，不复制；控制台点开卡片时经 tool.detail 取）、messages（会话、执行过程、附件、插话方式、写入它的身体 body、对方的话经哪具身体进来 via；role 为 user / agent / ambient）、audit、usage；消息与时间线按身体编号段编号、按时间排序；复制用的版本向量、补齐分页与幂等写入（applyRemote：编号段与作者、实时只收对方自己的行、字段类型与长度、时间范围；段尾 2^24 不收，本机的下一个编号不会越段）；用量只收对方自己的行；1.0 前编号的一次性迁移；会话的置顶与项目归属（migrateSessionOrganize 给旧库补列，listSessions 的筛选与排序，复制时逐字段较新为准，#30）
├── log.ts                日志（stdout，写出前脱敏）
├── sh.ts                 外部命令执行（超时按「多久没有任何输出」计、输出上限，子进程不弹窗口；前台命令自成进程组，超时或停止时整组结束，脱离进程组的进程占着输出时 5 秒后不再等）；agent 的命令与后台任务经沙箱执行（Windows 上是 PowerShell，输出的 CRLF 统一成 LF）、工作目录为用户主目录（Windows 为工作区 %USERPROFILE%\Quetzal）；后台任务可随时停止整棵进程树；真实环境里的命令不经沙箱（hostScript），前台命令自成进程组，超时或退出真实环境时整棵结束
├── host-mode.ts          真实环境模式：某个对话会话里她的 shell 不经沙箱、以基座的系统用户直接在主机上执行。她用 host_mode 带理由请求（不看能力类别的档位：缺省交给审核模型 guard/sentinel.ts 的 approveHost，guard.sentinel.hostMode 为 ask 时每次生成审批；都发系统通知）或对方在控制台打开（ops host.enter）；按会话、只在这具身体上、只在内存里（重启即回到沙箱）；30 分钟没有真实环境命令、急停、退出（她自己、控制台、飞书 /sandbox）时结束进行中的真实环境命令与后台任务；进出写审计与时间线（kind host），每条命令的审计参数带 realEnv
├── sandbox-macos.ts      macOS 命令沙箱的边界（纯函数）：sandbox-runtime 的 filesystem 配置——密钥与浏览器配置拒读，QUETZAL_HOME 与启动项（含 ~/Library/LaunchAgents）拒写，主目录与临时目录可写
├── sandbox.ts            agent 命令的沙箱（macOS：sandbox-runtime 的 Seatbelt 后端，探针验证、fail-closed）：Linux 用 bwrap（密钥目录为空 tmpfs、QUETZAL_HOME 整体只读（含 data / soul，阻止伪造记忆元数据与 SQLite 来源）、浏览器配置与用户启动文件保护、独立 pid 命名空间）或 Landlock，安卓用 proot（遮住密钥、配置、data / soul、版本目录、runit 与开机脚本，以及 `QUETZAL_HIDE_PATHS` 指定的目录），Windows 用 sandbox-runtime 的 srt-win（沙箱用户 srt-sandbox、按会话授权的 ACL、WFP 拦直连、代理拒绝连回本机；库单独打包为 srt.mjs），都没有时 kind=none 并提醒一次；包装接口 wrapScript / wrapArgv（异步）；真实环境用的 hostScript / hostEnv（不经沙箱；基座自己的 QUETZAL_* 不传，其余原样传）；读文件工具的真实路径检查（protectedPath：Windows 上取系统的真实路径、不分大小写，不收 UNC、设备路径与流名）
├── idle-fetch.ts         按「无进展」计时的 HTTP 请求：多久没收到任何东西才放弃（合成语音、模型目录的下载）
├── secret-values.ts      基座自己的密钥值，按结构认定、不按长短猜（私钥整段与正文每一行、JSON 文件只认凭据字段 token、其余文件整个内容、模型供应商的 Key；公钥与证书不算），按修改时间缓存：给脱敏用
├── voice/
│   ├── azure.ts          语音：Azure 文本转语音（SSML、合成、音色列表、配置与密钥）与语音识别（官方 SDK 推流的连续流式识别 recognizeStream，各段拼成一段话；短语音 REST 的 recognize 兜底，长音频分段）
│   ├── player.ts         她的声音从哪里出来：耳朵开着时交给控制台 App 经通话路径播放（speak 事件 / player.done 回报，回声消除的参考），否则交给身体适配器；/media 文件下发；插嘴标记
│   └── hearing.ts        听觉：/hear 送来的一句话（流式 PCM 或整句 WAV）→ 识别（中间结果经 hearing 事件推送；没识别出文字的不打扰她，不按字数、时长丢弃）→ 挑会话（windowMin 窗口）→ 以环境声音交给 brain.converse，她的取舍（kept / ignored）推给控制台；她自己说话期间丢弃；听觉状态（开关、急停、电量、温度）
├── crypto.ts             供应商 Key 的 AES-256-GCM 加密（主密钥存在却损坏时报错，不重新生成）
├── tls.ts                网关的自签名证书（ECDSA P-256，10 年，secrets/gateway-tls.key|crt；@peculiar/asn1-x509 编码、node:crypto 签名；损坏或过期重新生成）、指纹（SHA-256 DER）与短格式、配对证明（PBKDF2-HMAC-SHA256）
├── version.ts            版本号
├── ops.ts                统一操作层：网关与飞书共用，修改类操作全部审计
├── gateway.ts            网关：明文 HTTP 只监听本机回环（127.0.0.1 与 ::1），对局域网开放时另开 HTTPS / WSS（lanPort，同一套处理）；/health、/pair/info（证书指纹）、配对（8 位码、冷却、失败锁定与退避、Host 检查、请求体 16 KB 上限；HTTPS 上只收与证书指纹绑定的配对证明）、本机登录、令牌（Bearer / X-Quetzal-Token / WebSocket 第一条消息 / 旧的 ?token=）、gateway.rotateToken、附件上传与下载（文档带 content-disposition）与 uploads.preview（附件的轻量预览）、WebSocket RPC 与推送、静态文件
├── web.ts                网页控制台：托管 current/web/（QUETZAL_WEB_DIR 可覆盖，单页回退、ETag）；判定「同一台机器上打开着网页控制台的浏览器」（回环地址 + 本机 Host + Origin 正好是网关自己的源 / QUETZAL_DEV_ORIGINS）与「发起连接的是不是运行基座的子孙进程」（Linux 读 /proc，Windows 用 netstat 与 Win32_Process 的父进程表，macOS 用 lsof 与 ps，查不出按拒绝）给 GET /auth/local；配对接口的 Host 检查
├── body/
│   ├── adapter.ts        身体适配器接口（与设备仓库的唯一边界）+ 通用适配器
│   ├── twin.ts           身体数字孪生：采样、身体感受、sense 事件、感官循环；「身体」段落含她自己的进程 pid；加载适配器后定下身体 uuid
│   └── uuid.ts           身体的 uuid：绑定到设备（适配器的 deviceId() 经 sha256 派生为 RFC 9562 v8，原始标识不外露），存在 state/body-uuid（{uuid, source}），设备派生的不再变；取不到设备标识时先用随机 v4，之后每次启动与启动后隔一会儿再试（twin.ts 的 settleBodyUuid），取到就换成设备派生的值
├── heart/
│   ├── model.ts          纯数学：驱动力、双过程生物钟、醒来率、指数抽样（无副作用）
│   └── heart.ts          状态机与稀疏化抽样调度；抑制；有界的性格修改；跟随模式（不抽样，操作转给协调者）与状态的导出 / 采用
├── time/
│   ├── zone.ts           Intl 时区换算、当地日期 / 时刻与时长解析；系统提示日历、检索时间范围与提醒共用
│   └── reminders.ts      一次性 / cron / 软提醒，kv 持久化与墓碑合并；由持心跳的身体触发，不经模型直接发送
├── mind/
│   ├── prompt.ts         政策、人格与处境提示；生产dynamic模式不固定注入常驻全文，兼容入口仍可用旧字符视图
│   ├── context.ts        每轮工作状态/标签（真正的会话的经 task-states.ts 记下、全网同步）、动态记忆选择、实际模型窗口计划、稳定摘要与SQLite原文/历史过程/完整工具引用回查
│   ├── fetch-guard.ts    web_fetch 的出站检查（远程 MCP 的 net.ts 复用它的地址检查与 guardedLookup）：每一跳解析 DNS、拒绝回环 / 私有 / 链路本地 / CGNAT / 元数据地址，连接时再查（防 DNS 重绑定），手动跟随重定向
│   ├── tools.ts          内置工具（含 send_message：醒来时发到她选的已有会话或新开的会话，不指定则一次醒来一个新会话；recent_actions 查审计、view_image 同一轮不重复发图、edit_identity、tool_write / tool_read / tool_delete、hearing_config）+ 适配器工具 + hands 工具（mind/hands.ts）+ 她自己造的工具；经闸门调用（sentinel.ts 的 gate；一个工具可属于几个类别，按最严的检查：自造工具加 shell，tool_write 加 tool_write；审核结论附在结果末尾，未通过的理由作为 denied 结果交给她）；参数脱敏后才进审核、审批与审计；read_document / view_image 的真实路径检查；多具身体时读文件的工具（view_image、read_document、shell）多一个 body 参数，交给 body-files.ts；不按命令文字拦截，边界是 sandbox.ts；工具返回 ToolFailure（failed()）或抛错就是失败（命令非零退出、参数不对、那边出错），卡片红叉、上下文里写明失败；shell 的命令里有 ‹secret:…› 占位符就不执行；这一轮被停止时 shell 的命令随之结束；每次调用结束后触发灵魂目录的触碰即同步
│   ├── claims.ts         认领（claim 工具）：几个会话避免同时做同一件对外的事；按名字字面比较、带说明与期限；存 kv；多具身体时由协调者决定（setClaimRouter），记录按条目合并；系统提示「其他会话」里列出
│   ├── projects.ts       项目（#30）：名字、简介、项目说明（注入这个项目下会话的系统提示）、颜色与图标、归档；存 kv，删除留墓碑、只解除会话归属；多具身体时按条目合并（mesh/shared.ts 的 projects 分区）；project 工具与控制台共用
│   ├── session-search.ts 会话列表的搜索（#30）：标题与内容（复用 memory/index.ts 的对话全文索引，没有 FTS5 时逐条匹配），每个会话一条最好的命中，片段与高亮位置
│   ├── bodies.ts         其他身体的登记（多具身体时由 mesh/ 填入，带灵魂仓库登记的 uuid 与对方自报的 uuid）：工具表的 body_call / move_to 与系统提示的「其他身体」一节读它；可跨身体调用的内置工具名单
│   ├── body-files.ts     身体参数：解析 body（uuid → 登记里的身体名 → 认证过的连接，核对自报一致、拒绝一个 uuid 对多具身体）；file.read 的两端（那边 lendFile：闸门、真实路径挡密钥目录与保密库、只交普通文件、64 MB、分段；这边 fetchFile：闸门、核对大小与 sha256、文件名清洗、落到 data/from-bodies/<身体>/）；两边记审计
│   ├── agents.ts         子 agent：她派出的后台工作者（自己的系统提示、独立工具循环、进展广播、对话、停止、报告送回派出它的会话；系统提示里带它的工作区，dir 记在记录上、续做时在原身体上重新绑定）；记录带所在身体、epoch 与每 15 秒的检查点，按条目合并（sanitize / merge：先比 epoch 再比修改时刻），被别处接手或停止时这里那一份停下；从检查点续做（resume，步数上限只计剩下的）；查看、说话、停止在别的身体上跑的（含经工作区在别处派出的）经 setAgentRemote 转过去（status / message / stop）
│   ├── workspace.ts      工作区跟着任务走（#38）：会话 / 子 agent 的工作区 {身体, 目录}（workspaces 表、复制来的行的检查与后写胜合并、墓碑）、从命令自动登记（git clone / init、cd）、对话的路由目标（routeBody）、shell / shell_jobs 放到工作区所在的身体（routeTool）与本机的工作区目录（localCwd）、读文件工具的路径（workspaceFiles）、子 agent 在哪里做（agentPlace、runAgentOn；派出后的记录与转发见 agents.ts）、系统提示的「工作区」一节、workspace 工具、网关的 workspace.*
│   ├── repos.ts          身体的工作区概况（#37）：直接读 .git 列出工作目录下深度 2 以内的 git 仓库（路径、去掉凭据的远端、当前分支），上限 30 个、扫描时限、缓存；别处发来的概况的检查
│   ├── canvas.ts         Canvas（ARCHITECTURE §5.5）：canvas_docs / canvas_versions / canvas_comments / canvas_runs（第一次用到时建表）；不可变的版本、按片段查找替换（找不到或有歧义不改）、恢复；评论的锚点（原文 + 前后文）与重新定位（exact / moved / stale）、回复、解决、编辑建议的采纳；运行代码（runCanvas：写进工作区的运行目录，经 sh.ts 的 shell 在沙箱里执行，不经沙箱的路径没有；无输出超时 + 15 分钟总时长、输出上限；解释器不存在时说明不执行；图片只收普通文件、核对文件头，复制到 data/canvas-runs/）；系统提示的 Canvas 一节（canvasBlock：小的全文、大的概要，对方改过的地方、未解决的评论、最近一次运行）；复制来的行的检查（applyCanvasRemote）、补齐摘要与按 id 取行
│   ├── canvas-tools.ts   她的 Canvas 工具：canvas_create / canvas_read / canvas_edit / canvas_list / canvas_comment（会话类别）与 canvas_run（执行命令类别），挂进 tools.ts 的工具表与内置名单
│   ├── deliverables.ts   交付物（ARCHITECTURE §5.8）：Markdown → 块（marked）、Word（docx）、Excel（exceljs：多工作表、公式、日期、列宽与格式、CSV）、PowerPoint（pptxgenjs：结构化幻灯片或按 --- 分页的 Markdown）、HTML / Markdown / CSV / JSON；本地图片的读取与核对
│   ├── deliverable-pdf.ts PDF（pdfkit）：探测这具身体上的中文字体（QUETZAL_PDF_FONT、QUETZAL_HOME/fonts、各平台常见位置、fontconfig），读 ttc 的 PostScript 名挑简体中文；排版标题、列表、表格（跨页重画表头）、代码块、图片与页码
│   ├── deliverable-tools.ts 她的 deliverable_create（生成文件类别）：文件名与放置（只写进工作区或交付目录、不覆盖、符号链接不跟出去）、工作区在别的身体上时放过去生成再取回、另存到 uploads 作为附件放进这一轮的 outbox
│   ├── canvas-ops.ts     控制台的 Canvas 操作（网关 canvas.*，经 ops.ts）：编辑基于旧版本时返回冲突、运行按「执行命令」过闸门并写审计、运行图片（base64）、评论缺省作为对方的话经 converse 发给她
│   ├── goals.ts          长期目标（#23）：goal 工具（add / update / step_done / close / list）、步骤与进度、最近推进的时刻、关联的会话；一变就按进行中的数目更新心脏的牵挂；旧 open_loop 与 kv openLoops 的迁移；按条目合并（关闭的留 30 天作墓碑）；系统提示的「进行中的目标」、控制台视图
│   ├── task-states.ts    每个会话的工作状态（task_state 的目标、约束、未决问题、阶段、标签）：一个会话一条，按会话后写胜合并，旧的 context.state.<会话> 照旧读
│   ├── continuity.ts     续做（#11）：本机进展折叠成轮次检查点（turns），基座重启后从检查点续做本机没做完的轮次与子 agent（对话以「续做」的交接在原会话里接着做），谁续做的决定（decideTake / take，多具身体时经协调者），续做次数与时限
│   ├── custom-tools.ts   自造工具：QUETZAL_HOME/tools/<名>/（tool.json + tool.sh | tool.mjs）的校验、热加载、执行（一律在子进程里、经沙箱：stdin JSON + ARG_ 环境变量 / 子进程里加载 ES 模块，超时整组杀掉）、依赖检查；技能文档（灵魂仓库 skills/<名>/SKILL.md，Agent Skills 规范）的读写
│   ├── activity.ts       一轮的进展广播（activity 事件）与快照（liveTurns）、按标识找本机开着的会话（sessionById）、被别处接手的停止原因（HandedOver）、会话时间墙（120 秒无进展）、心跳、插话收件箱与打断、本轮已在上下文里的图片（seen）
│   ├── images.ts         图片：识别类型、较大图片缩小（ffmpeg / ImageMagick / 内置 jpeg-js，长边可指定），供附件、view_image 与截图使用
│   ├── hands.ts          手（计算机使用）：把适配器的 Hands 包装成 screen_read / screen_capture / screen_click / screen_drag / screen_scroll / screen_type / screen_key / app_open / window_list / window_focus；读屏结果过滤、编号、排版，视图坐标（截图缩到长边 1280）与屏幕像素换算，按编号取元素中心与 ref，键名规范；全部归 hands 类别（缺省交给审核模型；sentinel 的 hands 风险类别只算动作，读屏、截图、列窗口不算）
│   ├── attachments.ts    附件：分类、保存（data/uploads）、组装带附件的消息（图片 / 文本内联 / 路径）；agentFiles：她随回复交出的文件（飞书据此另发）
│   ├── processes.ts      进程列表：直接读 /proc（不依赖 ps，也不读 Android 上被拒的 /proc/stat），标出她自己、父进程与后台任务；Windows 读 Win32_Process，macOS 用系统自带的 /bin/ps
│   ├── search.ts         网页搜索：真实浏览器请求头；360 搜索 / 百度 / 必应结果页解析，固定顺序、拿到结果即止（相不相关由她判断）；没有结果时照实说明，被转到别的网站就写出是哪里
│   ├── documents.ts      文档抽取：内置 zip 读取，docx / pptx / xlsx（日期格式、只有公式的单元格）/ ODF / EPUB / HTML / RTF，PDF 优先 pdftotext、没有时内置简易解析（按 ToUnicode 还原中文），旧版 Office 调用外部命令
│   ├── secrets.ts        保密传递（pass_secret）：保密输入协议（结束口令、截走对话里的保密值）、保密库（QUETZAL_HOME/vault；每项多端同步或仅本机，exportVault / mergeVault 供 mesh/shared.ts 按条目同步）、工具输出与参数里的保密值替换（连同基座自己的密钥，见 secret-values.ts）
│   └── brain.ts          注入宿主模型、工具、Session、脱敏与记录，调用独立 engine.runTurn；醒来（内省 → 多具身体时选在哪里做 → 工具循环 → finish）、做梦、对话（含环境输入：ambient 消息、「沉默」不入库）；会话历史带时间与每轮的过程记录（describeProcess；放在回复前一条单独的「基座附注」里，她的回复只留原文；主动消息的附注写明是她醒来时主动发的）；回复只取结束这一轮的那一步的文字，普通模式从 session_compact 摘要继续，修订读取模式不以无来源版本的摘要截断原文；session_new 把回复放进新会话；子 agent 的循环与报告送回；对话中模型空回的一步不算结束（提醒后重试最多两次，仍空则说明没能回复）；工具失败时上下文里写明失败，同样的调用第二次失败起提醒她不要原样重试；对方停止这一轮（stopTurn，网关 chat.stop）时中止模型输出、不再等工具，以一句说明结束；快速模型代写摘要；灵魂同步的提醒（soul.alert）：插话进碰过记忆的那一轮，已结束则在原会话 / 主动消息里开新的一轮（「基座提醒」的口吻，可回复沉默）
├── memory/
│   ├── identity.ts       agent.json 的种子身份、读取与字段更新；称呼、颜色与语言来自数据
│   ├── entries.ts        § 条目解析、序列化、条目级三方合并与文本合并；运行基座和灵魂桥共用的纯函数
│   ├── memory.ts         灵魂目录：人格、§ 条目记忆、日记、笔记目录树、未完成念头的旧接口（交给 mind/goals.ts）；写灵魂目录的进程内写锁（exclusive，与合并互斥）
│   ├── index.ts          SQLite FTS5 本地检索索引：对话增量补齐，笔记 / 日记 / 常驻条目按来源与哈希更新，时间过滤、BM25 排序与对话前后文
│   ├── retrieval.ts      记忆检索宿主：收集文件、FTS5 / 降级路径及时间；纯分词、打分、摘录与字符预算选择调用根级 engine
│   ├── structured.ts     notes/QuetzalMemory版本读写、来源/状态校验、scope与条件门禁、旧材料标注映射、归档回滚，原私有正文不脱敏
│   ├── adaptive-store.ts 来源修订、持久任务、租约与回执；与 messages 同事务失效
│   ├── adaptive-evidence.ts  M2 记录格式、精确出处、证据状态与纠正影响范围计算（受控后台试验）
│   ├── adaptive-worker.ts    持久增量 / 编辑来源重整合、不可读来源依赖过滤、完整输入与代次门禁，当前有工作量上限
│   ├── adaptive-model.ts     现有供应商路由、脱敏、窗口校验、严格 JSON 与时间墙
│   ├── adaptive-proposal.ts  M2 提案提示 / schema、宿主身份与引文规范化（开发试跑）
│   ├── adaptive-review.ts    M2 失效来源 / 旧引用工作发现、同语境对象候选、持久队列复用与有界模型重评（后台与开发共用）
│   ├── prompts/adaptive-graphiti.ts 固定上游抽取 / 时间规则的许可副本与适配
│   ├── adaptive-archive.ts   M2 权威文件核对、重建与备份检查点（受控后台试验）
│   ├── adaptive-reading.ts   原文按历史精确版本附上当前修订状态，不将旧原文覆盖为新事实
│   ├── adaptive-graph.ts     M2 有版本 SQLite 投影、事务安装和快照读取（受控后台试验）
│   ├── adaptive-artifact.ts  有版本结果信封与来源引用，不确认语义
│   ├── adaptive-publication.ts SQLite 发件箱到私有 Markdown，原子安装与 Git 回执恢复
│   ├── adaptive.ts       固定中心来源处理与认证读取；候选 LIMIT 前排除未处理 / 失效来源；对照本机状态 / hash 过滤中心过期快照，semantic 开关控制后台试验；前台覆盖未完成时不返回原文观察
│   ├── semantic.ts       合格有界候选的quick语义选择，缓存/每日预留预算/取消/超时，失败退回词面检索
│   ├── prime.ts          真实轨迹与用户来源、候选蒸馏/个人确认/独立结果评价/经验演化/反馈，预算与自动灵魂同步
│   ├── portable-path.ts  灵魂仓库里的路径在每一种身体上都放得下（规范 v13 §3.13）：Windows 的保留名、结尾的点与空格、非法字符、只差大小写的路径
│   ├── soul-repo.ts      灵魂仓库协议（与桥接共用，规范 v14）：克隆 / 补齐、提交、拉取合并（条目级三方合并、字段合并、冲突副本；改动工作区的那一段在调用方给的 exclusive 里执行）、推送结果（只按事实分：--porcelain 报告的被拒、基座自己拒绝同步 status.refused、配置不对、其余照 git 原文）、身份守卫、git 执行安全（不执行钩子、地址只来自配置、清理 .git/config、不收符号链接）、整理租约、历史与撤销；v11 起不再检查提交内容中的密钥
│   └── soul-sync.ts      运行基座一侧的同步：触碰即同步（工具调用后 git status → 立即提交，3 秒去抖推送）、git 失败静默重试（不按报错文字分类）、推送失败（附 git 原文）、冲突副本与跳过路径的提醒（soul.alert 事件）、待裁决的副本
├── mesh/                 网状层：同一个 agent 的在线身体两两直连（设计见 docs/ARCHITECTURE.md §6.2、docs/DISTRIBUTED.md）
│   ├── identity.ts       节点密钥（secrets/mesh_ed25519）、指纹、规范化 JSON、签名信封与验证（协议版本 MESH_PROTOCOL = 2 与 agent id、收件人、时间窗、防重放——含签于本次启动一分钟以前的一律不收、只认灵魂仓库登记的公钥）
│   ├── directory.ts      同步服务客户端（协议见 sync/docs/PROTOCOL.md）：只接受 HTTPS、设备码绑定、信令 WebSocket（在场、转发、TURN 凭据刷新、指数退避重连；网络变了且这条连接已经走不通时立即重连）；服务端每条消息按严格形状检查（身体名、长度、数量），不合格的丢弃
│   ├── binding.ts        设备码申请 / 轮询批准 / 解绑、同步服务地址校验；返回身体令牌及可选灵魂仓库链接、控制台令牌
│   ├── link.ts           一条 WebRTC 连接（node-datachannel）：发起方由名字决定（应答方请对方发起，没回应按退避再请）、签名信令、DTLS 指纹（连同 agent id）的挑战应答、心跳与重连、网络变了时探一次（probe）、中转凭据到期前重建、大消息分块、连不上的诊断（失败次数、双方的候选类型）；对方违反协议（不是对象、认证前发分块、分块超限）就断开，原生回调里的异常一律接住
│   ├── netwatch.ts       网络变化：平台通知（适配器的 onNetworkChange）+ 每 5 秒比较本机地址与去往同步服务的路由用哪个本机地址（不发包），合并后通知网状层
│   ├── lan.ts            局域网信令：同步服务连不上时，签名信封经 UDP4 直接发给记得的私有IPv4地址（端口同网关；地址表 data/mesh-lan.json；只收私有IPv4来源、限大小与频率；选中IPv6路径不建立该地址记录）
│   ├── route.ts          经其他身体中转：签名的拓扑（rt，链路状态洪泛、30 秒刷新、90 秒作废）、最短路的下一跳、发出者签名的转发信封（fwd，最多 8 跳，收件人验签与防重放）；只读成员不参与
│   ├── mesh.ts           全连接管理：按在场建立 / 停止连接（同步服务说下线但直连通着就留着；停下的连接收到验过签名的连接请求就恢复；重新连上同步服务时没连上的立即重来）、网络变了时检查各条连接、直连不通时经中转收发、验签、请求 / 应答（回应只认被请求的身体；调用方可取消，cancel 只认发起请求的那具身体）、事件、状态（不含地址）；只读成员（灵魂桥）只能调用可读的方法；钉住各身体的公钥与类型（TOFU，acceptPin 确认变更）、灵魂仓库更新后核对现有连接（reverify）；由对方触发的回调都接住异常
│   ├── canvas.ts         Canvas 的复制：连上时要对方的摘要（canvas.digest）再按 id 分批取行（canvas.rows），平时实时广播（事件 canvas）；收到的行经 mind/canvas.ts 的 applyCanvasRemote 检查，实时只收发来的身体自己写的
│   ├── adaptive-memory.ts 固定记忆主机的查询接线，只对正式成员开放
│   ├── replica.ts        message_modes 的可变状态独立分页补齐，清空保留版本；一份对话：对话、会话与时间线在身体之间复制（连上时按版本向量补齐、分页续传，有总量上限；平时实时广播；收到的先经 store.applyRemote 逐字段检查再幂等写入）
│   ├── presence.ts       在场：进展事件转发给其他身体（控制台看得到别处进行中的一轮）、刚连上时取回对方的进行中轮次、断开时清掉；发给别处进行中会话的话（含附件）转过去，没有进行中的一轮而会话的工作区在另一具在线的身体上时也把这一轮转过去（mind/workspace.ts 的 routeBody）（接收方只取白名单字段、就地处理，via 记为发来的那具身体；子 agent 报告、灵魂同步提醒转过去仍是提醒）；给灵魂桥的近况（单行、截断、标明谁说的）
│   ├── coordinator.ts    协调者：交换候选条件（优先级、电源、启动时刻）选出持有心跳的身体；跟随者的心脏操作转给它，它异步广播心脏状态（最快2秒一次，接班沿用已收到快照，未广播更新不保证复制）；分区重连时合并
│   ├── placement.ts      运行位置：各身体的概况（body.overview）、打分推荐、她在内省时选 where；在选中的身体上执行醒来（mind.wake）
│   ├── limbs.ts          肢体：可被调用的工具清单（tool.list）、在这里执行别处调来的工具（tool.call；调用方取消时经网状层的 cancel 中止：命令结束、审批撤销；带 cwd 时在那个工作区目录里执行，命令看出的工作目录以 workdir 交回）、把这里的文件交给别处带 body 的工具（file.read，经 mind/body-files.ts 的 lendFile；灵魂桥调用不到）、灵魂仓库身体登记里的 uuid（soulRegistry）、接手换过来的对话（chat.continue）；填入 mind/bodies.ts
│   ├── shared.ts         全网共用：设置分区（较新的修改生效，修改时刻不能在未来、只留认得的键；guard 分区按 sanitizeSentinel 校验）、模型供应商连同 Key（接收方逐个校验、重新加密）、语音密钥、全网急停（停优先）、审批（在哪里批准都行，按「身体/编号」区分）、每日用量合计、提醒与认领（按条目合并；认领与放下经 claims.op 由协调者决定）、想分享的一句话（按写下的时刻后写胜）、保密库与多端同步的 MCP 来源（mcp 分区，按条目合并，不含凭据与令牌）；项目（projects 分区，按条目合并、删除留墓碑）；进行中的工作：长期目标、会话的工作状态、子 agent 的记录、轮次的检查点（goals / taskStates / agents / turns 分区，按条目合并）
│   ├── workspace.ts      工作区在网状层上：工作区复制（workspace.pull 补齐、workspace 事件实时）、body.workspace（工作区概况；带 dir 时核对目录）、agent.run（子 agent 在这具身体上执行，回传它的记录；查看、说话、停止走 mesh/continuity.ts 的 agent.status / message / stop）；连上时取回其他身体的概况、5 分钟刷新
│   ├── continuity.ts     协调层的续做：work.take（谁续做由协调者决定，记录的身体还连着就不给别人）、离线交接（离线超过宽限的身体手上没做完的事由协调者接着做）、agent.status / agent.message / agent.stop 转给子 agent 所在的身体（唯一的一套，含经工作区在别处派出的）
│   ├── channels.ts       通道：飞书只由指定的身体持有（其他身体的主动消息转过去）；几只耳朵同时听到同一句话只留一只（起止时间重叠且识别出同样的字才算同一句，不按相似度猜）；记下哪只耳朵听到的（voice_speak 从那里说）
│   ├── node-key.ts       这具身体的节点密钥（灵魂同步写身体登记时用，不依赖整个网状层）
│   ├── account.ts        账户：控制台登录（身体令牌申请码 → 人在官网批准 → 账户令牌存 secrets/sync-account.json）与账户接口的代理；网关的 account.* 方法
│   └── runtime.ts        绑定到运行时：配置、绑定令牌（secrets/sync.json）、钉住记录（data/mesh-pins.json）、局域网地址表（data/mesh-lan.json）、原生组件的按需加载、身体登记的公钥、soul.pushed → 其他身体立即拉取、拉取灵魂仓库后核对连接；网关的 mesh.* 方法（含 acceptPin）
├── guard/
│   ├── guard.ts          能力授权（allow / review / ask / deny）、审批队列（ask：不看档位、直接生成审批，真实环境配置为人工时用它）、急停、审计；review 档位交给登记的审核者（setReviewer）
│   └── sentinel.ts       安全审核：独立的审核模型（固定的审核系统提示，只送这一次操作：工具、类别、脱敏参数、她这一步的说明、对方最近一两句话、身体与是否真实环境；结论 allow / revise / block + 风险 + 理由）；按能力类别与工具语义的风险分类（classify，不看命令文字；hands 类别里只读的 screen_read / screen_capture / window_list 不算风险类别；deliverable_create 带 overwrite 归 destructive）；工具调用的闸门 gate；超时 / 失败策略；进入真实环境的审核 approveHost；审计 sentinel.review；控制台配置 sentinelView / setSentinel；旧缺省「询问」的一次性迁移 migrateReviewDefaults
├── mcp/                  MCP 宿主工具来源（配置、权限、隔离与同步见 docs/engine/MCP.md）
│   ├── client.ts         官方 SDK：stdio / Streamable HTTP / 旧版 SSE 传输、协商、工具发现与稳定别名（带来源声明的只读 / 破坏性注解，供审核分类；资源与提示词工具标为只读）、资源与提示词（以基座加的工具交给她）、schema 校验、输出边界与调用取消
│   ├── runtime.ts        config/mcp.json 的校验与读写、启动授权（mcp_start.<id>）、沙箱环境与凭据引用、即时启停（reconcile）、来源状态、控制台管理（增删改、登录）、多端同步的导出与按条目合并（exportMcp / mergeMcp）
│   ├── oauth.ts          MCP 授权规范的 OAuth 2.1：OAuthClientProvider（令牌存 secrets/mcp-oauth-<来源>.json）、开始登录、回调（state 一次有效，PKCE 校验值只在内存）
│   └── net.ts            远程来源的出站检查：只收 HTTPS（回环例外，且只在来源本身是回环时）、DNS 检查与连接时再查，给 SDK 的 fetch
├── plugins/              插件（见 docs/engine/MCP.md §6–8）
│   ├── package.ts        插件包解析：Claude Code 插件（plugin.json、skills/、.mcp.json、commands/、agents/，hooks 不执行）、Agent Skills 目录、插件市场 marketplace.json；只读文件，不跟随符号链接
│   ├── index.ts          取来源（本地目录复制、git 浅克隆）、预览与安装（技能写进灵魂仓库 skills/、MCP 来源加入配置、凭据进 secrets/）、更新与卸载、插件目录、她的推荐（plugins/installed.json）
│   ├── catalog.ts        推荐目录：精选的知名 MCP 服务器（名称、用途关键词、安装方式、维护者、许可与来源）与按关键词查找
│   ├── tools.ts          她的工具 plugin_search / plugin_recommend / plugin_prompt 与系统提示的「插件」一节
│   └── ops.ts            网关方法 mcp.* 与 plugins.*（并入 ops.ts）
├── providers/
│   ├── types.ts          统一消息/工具/结果类型
│   ├── adapters.ts       四种协议的 HTTP 适配（流式 SSE；Google 输出包含思考用量、可选 reasoning / total 保留供应商报告；模型调用时间墙：90 秒无数据、180 秒无内容，没有绝对上限）
│   ├── catalog.ts        models.dev 公共目录
│   ├── quick.ts          快速接入供应商：保存 Key、按目录筛选工具模型、试通与排序；没有通的模型时恢复原配置
│   ├── registry.ts       草稿保存、版本号、Key 加密；从其他身体导入（逐个校验，API 地址只收 HTTPS 与本机回环，不合格的保留本机原来的，全部整理完才替换）
│   ├── router.ts         全局顺序路由（quick 把快速模型排前，prefer 把指定模型排前，例如审核模型）、Key轮换、按实际候选context重准备；HTTP故障或窗口不足时换候选，窗口不足不重复换Key、连通性测试；能否看图只认手动设置与公共目录，查不到就当不能
│   └── compat/           供应商兼容层（仅对匹配的供应商自动生效）：index.ts 登记，opencode-go.ts
└── channels/
    ├── feishu.ts         飞书长连接、消息（处理函数立即返回以支持插话；/new 开启新会话；保密输入期间只回不含内容的回执）、她生成的文件（回复与主动消息之后另发，经消息资源的上传接口）、主动消息（注明所在会话）、菜单与单聊事件、卡片回调、一键接入
    ├── feishu-progress.ts 执行过程卡片：按插话分段——插话那一刻上面的卡片定格，新的一段回复插话消息在下面重新开出；发送 / 更新经注入的 sender，可测试
    └── feishu-cards.ts   卡片 JSON 2.0：此刻 / 心流 / 记忆 / 控制 / 模型 / 权限（审核 / 允许 / 询问 / 禁止） / 预算 / 审批 / 保密输入
```

平台级适配器（`adapters/`，与 `src/` 平级，只 `import type` 接口）里「手」的实现：

```
adapters/
├── android/index.ts      经 App 身体接口的 /v1/hands/…（App 的无障碍服务 HandsService）；控件类名 → 通用角色、键 → 全局动作 / 输入框编辑
├── linux/hands.ts        桌面会话环境探测；xdotool（X11）/ ydotool、wtype（Wayland）的命令拼装；AT-SPI 脚本（python3 + gi Atspi）与解析；wmctrl；.desktop 查找；截图命令
├── macos/hands.ts        JXA 脚本（权限预检、主显示器几何、CGEvent 鼠标、System Events 读元素 / 窗口 / 按键）；cliclick 参数；像素与点的换算；AX 角色映射；权限说明与系统设置链接；createHands
└── windows/hands.ts      常驻 PowerShell 里的 C# 帮手（SendInput、DPI、虚拟屏幕偏移）；UI Automation 读屏与窗口列表脚本及解析；开始菜单应用；hands.* 操作表（身体助手 body.ts 共用）
```

约定：

- 设备相关逻辑一律不进入本目录，只能通过 `body/adapter.ts` 的接口。
- 所有通道的消息都经 `brain.ts` 的 `converse` 进入：保密输入的截取（`secrets.intake`）在那里，新通道不需要也不应该自己处理保密值，只需订阅 `secret` 事件提醒对方、把回执发回去。
- 新增的控制能力先加到 `ops.ts`，控制台与飞书再各自接入。
- 纯数学与状态转换放在无副作用的函数里（如 `heart/model.ts`），便于测试。
- TypeScript 只使用可擦除语法（`erasableSyntaxOnly`），测试直接用 Node 运行源码。


`memory/adaptive-query-packet.ts` 处理语义信封形状、请求绑定、版本及来源引用核查；`adaptive-query.ts` 生成当前图的版本摘要并判断与本机状态兼容性。`mesh/adaptive-memory.ts` 为 memory.adaptive.semantic.query 注册默认非 readable 方法（只读桥拒绝），`ops.ts` 同名网关入口调用宿主查询。旧 M1 方法保持原格式。无依赖、配置、数据库迁移或独立服务变更，现有构建入口覆盖；详细协议和保守冲突策略见全局 API 与语义文档。

`mesh/soul-sync.ts` 的 installSoulSync 由 startMesh 和多身体夹具共用，监听真实 mesh event 与本机 soul.pushed / sense；停止时清理监听和去抖计时器。替代 main.ts 启动时的全局 wireMesh 绑定。Git 排队、锁、身份守卫与错误重试仍由 memory/soul-sync.ts / soul-repo.ts 管理，协议与灵魂格式不变。

多身体开发运行器的显式向量模式复用中心默认准备器，不注入近邻。retrieval-observer 只预热摘要绑定的公开文件、观察真实 query；检查点核对 worker.snapshot 与 archive 当前候选摘要。卫星 mesh 停止 / 重连由测试 IPC 控制，离线来源与 unavailable 查询先落盘，再等待实际复制、处理和发布。生产 API、配置和灵魂格式均不改变；正式语义评分与浏览器验收仍单独进行。

`adaptive-reading.ts` 对 supported claim 的修订 current 同时保留正文、性质、occurred / valid 和来源；只改时间时也能在旧原文各页看见纠正。模型提案对合法但无引用的语境声明不生成记录，仍检查声明出处与实际引用。开发案例 / 预期由 tool/adaptive-pilot-cases.ts 提供，不能作为生产本体或预设主题。

`adaptive-graph.ts` 以连接 WeakMap 保存完整重放见证；重放中传递当前记录映射，避免逐批读取全部旧 JSON。source/evidence 状态不缓存，外层回滚由下次投影摘要核对发现。`tool/adaptive-read-benchmark.ts` / `adaptive-read-workload.ts` 提供仓库外合成负载；`test/adaptive-query-scale.test.ts` 测真实宿主100次读取与损坏降级，未使用模型或浏览器。

`tool/adaptive-live-pilot.ts` 用公开合成消息驱动实际后台及 converse，记录每轮图状态、前台输入和回答；开发 ADC 传输包装器只替换保留域名的认证与端点，流和请求正文保持现有适配器格式。该入口加入 package.json / tsconfig，复用 Node 和 Python 标准库及已有 gcloud，无新增生产依赖、服务、配置、RPC 或存储格式。生产后台仍读取控制台供应商配置。

`adaptive-query.ts` 对可见 / 全局共同有效的支持记录再调用既有 evaluateEvidence，取得一致的支持组与根来源。以这些组中的精确原文引文补充词面匹配，沿 claim / mention 当前版本有界遍历，不索引审计原因、反证或整条消息。无新依赖 / 持久索引 / 配置，现有构建自动纳入；工作量和支持链测试见 adaptive-query.test.ts，实际发送上下文与规模读取由 query-host / query-scale 测试验证。

`tool/adaptive-eval/controlled-graph.ts` 仅用于 AM-07 受控输入：先暂停空闲中心，复制当前控制消息，用正式 archive.accept 完成 semantic-v1 任务及受控初始图 / 撤回版本，然后恢复正常发布与依赖重评。控制消息不再次抽取，查询 / 回答仍按正常历史处理；后台模型结果不由运行器改写。control 文件先于后台恢复保存，快照包含五条受控认识的当前状态与版本历史，另保存实际网关语义查询。只在声明受控模式的测试子进程开放内部 IPC，不新增产品 RPC、配置、依赖或灵魂格式；现有 tsconfig import 链和测试 glob 已包含。

认识 v2 的 claim.references 区分跨语境对象指向与事实前提；recordRefs 包含指向依赖，realmBoundRefs 保留身份 / participants / 支持 / 反证的同语境约束。evaluateEvidence 要求引用提及当前可解歧，但不能靠引用单独支持结论；graph 安装拒绝 node 改 realm。query / packet 保留引用角色、语境与版本，reading 的修订提示带当前引用角色、语境与名称。提案 schema 新增 references，重评对象候选覆盖目标及其明确引用语境。新写 result-v2 / semantic-v2，archive / material 读取兼容旧 v1，旧语义不能携带新字段；查询发送 v2、接收兼容无新字段的 v1。没有新增表、配置、依赖或构建入口，现有 import 链与测试 glob 覆盖；灵魂规范 v14 的 Markdown 目录不变，完整混合版本部署仍待后续验收。

`adaptive-model.ts` 按 router.prepareForModel 提供的 structuredOutput 能力准备提案：Google 的 schema 通过 generationConfig 发送，其他协议继续完整提示协议；两者均预算全部 schema，普通对话不设置 responseSchema。既有严格 JSON、截断 / 工具输出拒绝及宿主认识校验保留。ProviderError 新增可选固定原因码；开发 model-observer 保存实际 responseSchema 与白名单原因，不保存供应商错误正文。没有新增依赖、配置、迁移或构建入口，现有类型检查 / 测试 glob 覆盖。


`tool/adaptive-retrieval-probe/prepare.py` 取得固定公开权重并核对文件摘要；`run.mjs` 调实际 engine 词面排序和隔离安装的 Transformers.js，`fuse.py` 核对固定 Graphiti 源码后执行原始 RRF 函数。package / lock / model 元数据已移至 components/adaptive-retrieval，由实验和生产适配共用。锁使用标准 node_modules 相对路径，安装须在目标目录内运行 npm ci；运行前核对根版本、来源 / 摘要和模型文件。真实本机模型和宿主读取已运行，结果与失败记录见进度 §4.39。


`adaptive-query.ts` 的 semanticCandidates 为派生索引提供与当前查询相同门禁的输入及摘要；selectSemantic 的可选近邻只允许匹配当前候选 / 查询，失效摘要不能参与结果。`adaptive-ranking.ts` 移植固定 Graphiti RRF，由既有 main 构建自动纳入，许可已加入随包 NOTICE。adaptive-vector.ts 管理独立 worker、候选快照确认和有界请求；adaptive-vector-worker.ts 使用固定 E5，文档块128 token、查询块480 token，最多128块，按最大分块相似度推荐候选。派生 SQLite 缓存按 agent / 模型空间 / 候选摘要绑定，逐候选原子提交，更新移除旧 key；查询只收 key，仍在权威快照复核。中心既有 semantic 开关开启时，adaptive-component 自动在后台准备固定组件再加载；空闲快照刷新间隔至少2秒，单块间优先查询，停止时等待原生调用结束并 dispose。准备过程由持久完成标记、可续传文件和 npm 缓存恢复；故障退避、关闭取消 npm 进程树。依赖加载故障会废弃依赖完成标记并重装；SQLite 确定损坏隔离后重建，busy 不删库。候选暂时失败2至60秒重试，分块超限 blocked；错误码和进度经既有状态接口提供。未准备时仍用词面查询，无新配置或 RPC。开发探针另有显式 ADC 嵌入对照，复用既有认证 / 传输，不进入生产模型路由。


`withAdaptiveSources` 在已有 SQLite / 灵魂读取边界内为可见来源附加 recordedAt（有效消息毫秒时间转换为 UTC，否则 null）。`historyReading` 将已核对 sources 送入 `adaptiveSemanticContext`，逐根比对 hash 后生成来源时间材料；不改 RPC v2 或认识正文。近况逐条标注记录时间，session.updated 只作为会话更新信息。`sourceRecordedAt` 不把缺失 / 损坏值补成当前时间；记录时间不填入事件时间。模型准备的既有复核覆盖该材料与时间变化。提案提示要求每个 reported 角色有来源，允许缺少未知参与角色，必要推断另建 inferred / hypothesis；提示约束仍须真实语义评测。


开发专用 `adcFetch` 在 credentials / headers / body 阶段记录终态回执，取消监听只报告一次并清理；流异常保留已收到的白名单计量，认证值与错误正文继续隔离。成功状态仅描述传输结束，模型版本 / STOP 仍需上层核查。宿主既有失败任务最多五次尝试、持久退避不变；新增双身体恢复测试验证首次失败后无需控制端干预即可重试、发布和读取。公开语义试跑仍遇首次失败立即收尾；恢复测试是独立工程证据。

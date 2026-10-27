# 自适应记忆：开源组件契约实验与测试模型

状态：M2 原型采用范围已确定如下；全量质量、跨平台与组件消融移至 M5，不能据此宣称最终工业化选型完成。关联：[计划](ADAPTIVE_MEMORY_PLAN.md)、[契约](ADAPTIVE_MEMORY_CONTRACT.md)、[验收](ADAPTIVE_MEMORY_ACCEPTANCE.md)、[验证记录](ADAPTIVE_MEMORY_PROGRESS.md)。

## 当前原型采用范围

- 采用固定 Graphiti 抽取 / 时间提示与 RRF 的许可适配副本，分别接入提案与检索排序；不采用其默认同名归并或整套图数据库。依据是已复现的身份 / 修订边界差异和真实后台接线，不是声称自行实现优于完整 Graphiti。
- 采用固定 Transformers.js 3.8.1 与 multilingual-e5-small 本机量化权重，元数据和摘要见 `runtime/components/adaptive-retrieval/`。中心自动准备并维护可重建向量缓存，查询仍经过现有来源 / 版本门禁；词面路径作为降级。真实缓存预热、多身体和损坏恢复已有原始证据，全冷 / 跨平台能力仍待 M4，收益与规模待 M5。
- 目前不引入 LangGraph 完整执行器或 A-MEM 自动链接写入。已有持久队列、源记录和版本存档承担恢复与修正；这两者的契约探针保留。M3 若需要邻居演化，先借鉴具体实现，再检验是否比现有最小路径更合适，不预设必须引入或永久弃用整套框架。

这是可运行原型的积木选择；最终去留取决于完整用户价值、基线和消融，不能把已有投入作为保留理由。

## 1. 固定候选与验证边界

2026-10-27 从官方仓库取得以下源码，检查实际实现与许可证；上游后续升级必须重新跑契约实验。实验不使用真人记忆，不向上游项目的服务发送资料。

| 候选 | 固定源码 / 包 | 许可证 | 本批执行范围 |
|---|---|---|---|
| Graphiti | [2b5db9e](https://github.com/getzep/graphiti/tree/2b5db9e139b2627c3ba18ff55f9181569b0d8224)，pyproject 0.31.2 | Apache-2.0 | 原样执行标准库去重辅助模块；后续增加 RRF 函数对照与 TypeScript 适配（§7），未运行完整 Graphiti 服务 |
| A-MEM | [ceffb860](https://github.com/agiresearch/A-mem/tree/ceffb860f0712bbae97b184d440df62bc910ca8d)，agentic-memory 0.0.1 | MIT | 原样执行 MemoryNote 和指定 update / delete / process_memory 方法 AST；检索器与 LLM 用明确的故障注入替身 |
| LangGraphJS | [7ab1b8d8](https://github.com/langchain-ai/langgraphjs/tree/7ab1b8d840c068c2593fea4683899508d93e6b33)；checkpoint 1.2.1、checkpoint-sqlite 1.1.0 | MIT | 已审读检查点与 SQLite saver；可执行探针针对 npm checkpoint 1.2.1 的真实 MemorySaver，执行结果单独记录 |

Graphiti 的默认依赖包括 Neo4j 驱动、Pydantic、模型 SDK、NumPy、重试与遥测组件，另有 FalkorDB / 嵌入式数据库选项；A-MEM 默认依赖 Chroma、sentence-transformers、LiteLLM、scikit-learn 等。LangGraph 的 SQLite saver 另需 better-sqlite3 原生依赖。**本批没有把这些依赖加入 runtime**，也没有借包名声称其完整服务可部署。后续已有提示词 / RRF 适配副本和独立检索组件探针（§7），没有启动图数据库。

后续选型仍需补齐：真实语义质量、完整依赖锁、取消与超时传播、索引 / 导出 / 重建、运行成本及自动部署恢复。若复用上游代码或提示词，必须随副本保留许可证、版权、固定源链接和修改说明；最初批次只提交实验工具；后续 M2 开发批次已将抽取 / 时间提示规则改编到 `runtime/src/memory/prompts/adaptive-graphiti.ts`，并附 Apache-2.0 LICENSE、版权和修改说明，详见[提示词副本说明](../../runtime/third_party/graphiti/NOTICE.md)。后续 RRF 适配同样附在该说明内；这不是完整 Graphiti 服务集成。

## 2. 已复现的契约差异

[Python 探针](../../runtime/tool/adaptive-oss-probe.py)先核对上游 HEAD 和待执行文件与对应 Git blob 完全相同，再运行以下六组断言。断言通过表示**成功复现所述行为**，不等于该行为满足 Quetzal 契约。

1. Graphiti 候选里恰好一个同名“阿舟”时，确定性路径把新对象归到旧对象，并用新对象的非空属性覆盖旧属性。这个路径不经过后面的 LLM 消歧；不能将名称匹配直接作为 C03 身份合并依据。
2. 候选里已有两个同名对象时，确定性路径把提及留给后续 LLM；本实验没有执行 LLM。其 NodeDuplicate 输出最终选择一个候选或新对象，不直接表达 Mention 的多候选分布。
3. 名称模糊归一化仅保留 ASCII，中文进入 unresolved 路径。这个结论只覆盖该辅助函数，**不表示 Graphiti 整体不支持中文或语义检索**。
4. A-MEM 的 update 修改现有笔记；调用后 evolution_history 不自动追加旧版本。不能以字段名存在推断其已有完整修订历史。
5. A-MEM 的 update 先删检索记录再重建；在 add_document 注入异常后，内存内容已经改变，检索记录已删。实验验证的是该方法的调用顺序，不声称实际 Chroma 服务发生过崩溃。
6. A-MEM 的 process_memory 直接采用假 LLM 给出的标签、邻居上下文和连接；连接可以指向不存在的笔记。删除原笔记后，另一笔记里的引用仍保留。C01 / C05 / C06 的引用、版本和依赖校验不能委托给这一默认路径。

可核查源码：[Graphiti dedup_helpers.py](https://github.com/getzep/graphiti/blob/2b5db9e139b2627c3ba18ff55f9181569b0d8224/graphiti_core/utils/maintenance/dedup_helpers.py)、[node_operations.py](https://github.com/getzep/graphiti/blob/2b5db9e139b2627c3ba18ff55f9181569b0d8224/graphiti_core/utils/maintenance/node_operations.py)、[A-MEM memory_system.py](https://github.com/agiresearch/A-mem/blob/ceffb860f0712bbae97b184d440df62bc910ca8d/agentic_memory/memory_system.py)。

检查点探针已实际执行 **5 组契约断言**：同 task/index 的普通写入幂等、父检查点与旧版本保留、thread 隔离、旧来源结果仍可 put、内存 saver 生命周期及 deleteThread。初次安装长期缺 js-tiktoken 的失败保留于阶段记录；后续从官方 npm 下载完整包并核对 SHA-512，补齐依赖后通过。现已保存独立开发清单和 13 个包的完整锁，在新的仓库外目录完成 `npm ci --offline --ignore-scripts`，再次运行真实探针通过。`npm ls --all` 退出 0；LangSmith 的可选 OpenTelemetry / OpenAI / ws peers 未装，本探针不使用这些集成。**未运行完整 LangGraph 图、SQLite saver 或跨进程恢复**；检查点本身不负责 Quetzal 的来源修订门禁，MemorySaver 也不能成为长期记忆的持久后端。

## 3. 适配方向与未决项

这些实验支持原契约中的职责划分，无需更改已对齐的产品目标：

- 借用抽取、时态判断、候选检索和邻居关联方法，先输出**提案**。名称归并、上下文改写不能直接修改权威记忆。Graphiti 默认实体抽取还排除代词与抽象主题，需要分别保留 Mention 层与开放主题层，不能靠改一个实体类型列表解决全部需求。
- Quetzal 持有 Source / Mention / Claim / Support 的稳定标识、版本与依据；用 M1 的持久任务、结果发件箱与发布协议约束安装，避免另建一套互相竞争的任务权威。
- A-MEM 的邻居演化适合作为关联提案的候选实现；Graphiti 的时态抽取与检索适合作为候选材料处理器。具体复用范围须用真实模型与 C03 / C04 / C06 案例确定，当前不提前宣布采用或弃用整套框架。
- LangGraph 如能改善 M3 多步研究的暂停 / 续做，可放在单个 Quetzal Job 内部；它的检查点不能代替宿主租约、来源版本与取消门禁。是否引入须与现有任务机制做实际对照。

后续工程批次已有[语义 payload、指代版本、支持 / 反证依赖与存档重建库](ADAPTIVE_MEMORY_SEMANTICS.md)，目前通过合成记录测试。真实模型抽取、语义反证理解和开源组件完整接入仍未完成；不能用这些底层库替代组件适配或模型质量证据。

## 4. 复跑组件探针

在仓库外准备 clone 父目录，目录名分别为 `graphiti`、`a-mem`、`langgraphjs`，checkout 表中的完整提交。以下命令只展示可复现方式；应用部署后不要求使用者执行它们。

```bash
python3 runtime/tool/adaptive-oss-probe.py "$OSS_ROOT"

# 独立临时目录；完整锁定开发依赖，不执行安装脚本；不修改 runtime/package-lock.json
mkdir -p "$CHECKPOINT_PROBE"
cp runtime/tool/adaptive-checkpoint-probe/package*.json "$CHECKPOINT_PROBE/"
(cd "$CHECKPOINT_PROBE" && npm ci --ignore-scripts --no-audit --no-fund)
node runtime/tool/adaptive-oss-checkpoint.mjs "$CHECKPOINT_PROBE"
```

Python 探针用标准库，实际验证 Python 3.14；构造 AST 使用 3.12+ 的 type_params 字段。JS 探针实际环境 Node 24，使用 [开发清单](../../runtime/tool/adaptive-checkpoint-probe/package.json)与[完整锁](../../runtime/tool/adaptive-checkpoint-probe/package-lock.json)，运行时核对锁中官方 registry / SHA-512 信息和实际安装版本。该清单只用于开源契约实验，不被生产构建或部署加载；正式采用完整执行器或持久 saver 时仍须单独集成和验收。

## 5. 已授权的真实测试模型

部署者指定本机已有 GCP ADC，2026-10-27 已实际调用三档模型。测试分工如下，模型名只作为评测配置，不与通用 agent 的人格或身份绑定：

| 档位 | 模型 ID | 计划职责 |
|---|---|---|
| 强模型 | `gemini-4-argon` | 困难歧义、多步研究与复杂纠正的候选处理 |
| 主力模型 | `gemini-3.8-flash` | 常规增量抽取、候选关联与语义任务 |
| 轻量快模型 | `gemini-3.5-flash-lite` | 简单分类、筛选等可独立评测的小任务 |

这是用户指定分工，不是已验证哪档足以完成某项任务。正式质量评测必须记录实际模型版本、调用配置和完整 token 用量（含思考），不把强模型的自评当独立真值。不因失败悄悄换模型并仍记原模型成绩。

已核对官方 [Argon 指南](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon)、[Flash 模型页](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash)、[Flash-Lite 模型页](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite)与 [ADC](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/gcp-auth)。本次用 global GenerateContent 接口，仅请求短回复，不涉及 Argon 长输出 continuation。

[连通性脚本](../../runtime/tool/adaptive-vertex-smoke.py)调用已有 gcloud 取得 ADC 访问令牌，只留在进程内存；不会把短期 bearer 写成固定 API Key、复制 ADC 到其他身体或写入仓库。`GCLOUD_BIN` 指向已有工具，`GOOGLE_CLOUD_PROJECT` 可指定项目，否则只读 gcloud 管理的 ADC quota project（尊重 `CLOUDSDK_CONFIG`）。本探针拒绝 `GOOGLE_APPLICATION_CREDENTIALS` 文件覆盖，避免将另一份文件的项目与 gcloud 令牌混用；完整 SDK ADC 接入另行实现。不改变现有账号或执行登录。报告只有模型、版本、结果、延迟和用量，不含项目名、账号或凭据。

```bash
python3 runtime/tool/adaptive-vertex-smoke.py
# 失败边界检查：不联网、不读凭据，不属于 npm test 的 TypeScript 文件模式
python3 -B runtime/tool/test_adaptive_vertex_smoke.py
```

真实请求有费用。最初每款仅一次短请求不构成性能分布；失败报告保留逐模型状态，模型或版本不符返回非零。HTTP 分块中断按传输失败记录，failure 只给阶段、白名单类别和已收字节数，不打印异常消息 / 正文。未报告的用量分项保留 null；旧开发报告曾将缺失分项补 0，不能据旧 thoughts=0 证明供应商显式报告零。当前 runtime 供应商入口仍为 API Key 机制，**本探针没有把 ADC 接入生产路由**；自动刷新、宿主接入与多身体凭据边界须在真实语义处理接线时实现和测试。

提案探针可通过 `QUETZAL_VERTEX_TRANSPORT=curl` 做显式 HTTP/1.1 传输对照（默认 urllib，连通性 smoke 仍使用 urllib）。curl 须由测试环境提供；URL / ADC 令牌只经子进程 stdin，响应至多 1 MiB，curl 90 秒、子进程 100 秒上限；调用方仍有 150 秒时间墙。SIGTERM 经过清理路径结束 curl，真实子进程取消测试已执行。报告记录实际 transport，不自动换传输或模型；更换传输需新建试验，不能用同配置 resume 掩盖变化。该选项不是生产配置，也不证明某传输长期稳定。


## 6. 首批真实语义开发试跑

提案格式、主机校验和正式评测口径见[语义评测登记](ADAPTIVE_MEMORY_EVAL.md)。AM-01 开发集已经通过三档模型实际执行；每轮先生成提案，再进入同一 AdaptiveStore / Archive 的事务、文件和证据计算。它不包含最终回答、真实多身体传输、UI 或后台调度，不替代 M2 门禁。

开发阶段的错误包括：缺必填 replace、引用形状与句柄不符、思考耗尽输出预算、HTTP 传输中断、跨语境合法关系被过严规则拦截，以及结构合法但语义语境混同。已修正接口描述、增加 responseSchema、显式设定思考档，保留所有失败，未手动修改输出。真实配置与完整结果见阶段记录；不同开发版本不能当成公平模型排行榜。

目前的选型证据支持继续使用 Flash 作为主力候选；轻量模型不直接负责复杂身份 / 语境修订。Argon 的失败中有宿主表达力问题，不能将拒绝安装简单归因为模型理解错误。仍需完成跨语境引用边界、纠正后受影响认识重评、所有场景留出集，以及完整后台接线再决定最终组合。

后续后台接线已通过 `adaptive-model.ts` 复用控制台供应商主顺序与故障转移，记录实际返回模型，不使用 quick 优先标志；故障转移仍可能落到配置中靠后的轻量模型，因此正式留出前仍须固定并验证实际路由。ADC 探针保持独立。Graphiti 提示规则随 main 入口引入，`tool/build-main.mjs` 将完整 LICENSE 与修改说明嵌入 main.cjs，所有复制该入口的平台分发都会携带许可；完整 Graphiti / LangGraph 服务仍未接入。


## 7. 多语言改述召回组件实验（进行中）

新增独立[检索探针](../../runtime/tool/adaptive-retrieval-probe/README.md)：锁定 Transformers.js 3.8.1 及78个包、multilingual-e5-small 的固定 ONNX 提交与文件摘要，调用实际 Quetzal 词面函数，并原样执行固定 Graphiti 的 RRF 函数。数据是公开开发用30段材料 / 15个问题，包含5类词面漏召回及同名、跨语境、时间先后和无关问题；不改冻结留出或生产提示。

初次试验只完成词面基线和固定上游融合函数核对（后续完成情况见 §7.2）：14个有相关材料问题中，hit@1=7/14、hit@3=9/14、hit@6=9/14；另一个无关问题为零词面命中。正文引用 / 版本门禁的10项既有测试通过。下载期间出现连接中断与600秒传输超时，原失败保留，准备脚本增加有摘要核验的部分文件续传；当时完整 npm 安装和权重尚未核验完成，尚无向量 / 混合排名、延迟与内存成绩。不能据模型说明或词面缺陷宣称向量方案已经修复问题。

初始清单、锁和脚本只用于开发探针；后续共享组件清单与生产适配见 §7.2。即使组件对照改善，仍须实现并验证：后台分块索引与来源版本绑定、中心自动安装 / 加载 / 恢复、前台有界查询与同门禁降级、长输入和无关候选处理、纠正后失效及真实双身体接线；完整 M2 门禁保持不变。


### 7.1 候选版本边界、RRF 副本与云端质量参考

后续生产选择函数已拆出同门禁的 semanticCandidates；摘要绑定当前正文、时间、语境、可见对象、支持和根来源。可选近邻必须匹配本次问题和当前候选摘要，先核对 / 去重再融合；失效索引不恢复旧认识。该阶段宿主尚未提供真实近邻；后续接线见 §7.2。RRF TypeScript 副本与上游203组输入、常数1和60逐项一致；完整 Apache 许可及修改说明随 main.cjs 分发。

独立云端对照使用官方 [gemini-embedding-001 predict API](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/text-embeddings-api)、已有 ADC、768维、文档 / 查询任务类型及显式归一化。它不是本机开源模型成绩，也没有改变正式模型配置。最初 urllib 批次12次请求中11次成功、1次响应中断，失败保留；新的 HTTP/1.1 批次完整75次成功，未自动重试或覆盖前批。

| 方法 | hit@1 | hit@3 | hit@6 |
|---|---:|---:|---:|
| 现有词面 | 7/14 | 9/14 | 9/14 |
| Gemini 嵌入 | 14/14 | 14/14 | 14/14 |
| RRF 常数1 | 11/14 | 14/14 | 14/14 |
| RRF 常数60 | 11/14 | 14/14 | 14/14 |

这只是14个有目标问题的公开短材料开发对照，时间变化问题有两个相关候选，因此嵌入 recall@1 为0.9643、@3为1。另一个无关问题同样得到向量近邻（最高相似度约0.513），不能把所有近邻都解释成相关事实。词面噪声与稳定并列次序还使3个问题的融合首位差于纯向量；不据这个小样本直接确定最终排序或相关性阈值。

45次查询的网络往返 P50 **3492ms**、P95 **4455ms**，采样期间存在组件下载，不是纯模型推理耗时或隔离性能试验；但本次实际请求显然不能满足当前500ms前台读取预算。故这条云端路线仅作为质量参考，**没有同步接入前台**。完整批次报告1171 token、1804计费字符；缺失实际模型版本保留 null。11次成功的失败批次另报告281 token / 412字符，失败请求用量未知；连通性单次另为11 token / 17字符。

该阶段本机五个模型文件已经核对，独立 npm 安装仍在进行。后续推理、分块与宿主结果如下；不同模型的向量空间始终不能混用。

### 7.2 本机模型、持久向量与真实宿主接线

固定 E5 和 Transformers.js 已实际安装并推理。首次依赖安装约37分钟；随后发现 npm --prefix 生成的旧锁含临时目录前缀，严格校验拒绝运行。改为在组件目录内生成可移植锁；78个包的版本、来源、摘要和依赖元数据完全相同，离线干净安装54个适用包耗时约1秒。共享清单迁至 `runtime/components/adaptive-retrieval/`，根版本和标准 node_modules 路径也纳入检查。

独立短材料对照仍使用30段带公开标题的材料、14个有目标问题及1个无关问题：

| 方法 | hit@1 | hit@3 | hit@6 |
|---|---:|---:|---:|
| 词面 | 7/14 | 9/14 | 9/14 |
| 本机 E5 | 13/14 | 13/14 | 14/14 |
| RRF 常数1 / 60 | 10/14 | 13/14 | 14/14 |

英文采风问题的目标在纯向量第5位，不隐去这一弱项。45次查询 P50 **3.16ms**、P95 **4.14ms**，模型加载 **313.65ms**（不含下载，也不是磁盘冷缓存），进程峰值 RSS **964214784字节**，最大事件循环延迟 **14.94ms**。这些只是本机短材料观测，不是全平台性能、长查询或端到端对话承诺；无关问题仍有近邻，融合首位可能退步，相关性阈值尚未校准。

生产适配使用独立 worker 和 Node 内置 SQLite，不引入独立图服务。候选由当前权威存档生成；向量缓存以 agent、完整模型空间与候选摘要为键。中心自动加载已准备组件，空闲时获取候选快照；文档按128 token / 最多512字符、32字符重叠分块，查询按480 token / 最多2048字符、64字符重叠分块，最多128块。每块重新分词确认；候选全部块成功才提交，当前快照变化会废弃在途旧结果。缓存只保存向量，正文随 worker 当前候选存在内存；磁盘损坏行拒绝复用并重算，该阶段尚未实现整库损坏恢复，后续见 §7.3。

`host.ts` 使用真实 archive.accept、queryAdaptiveSemantic、来源核查和上述 worker。它把同样正文安装成受控认识，不沿用公开标题，故词面 hit@6 为 **8/14**，实际混合查询为 **14/14**；不能与上一表拼成同一实验。最终45次查询 P50 **9.23ms**、P95 **19.43ms**；长文增量期间查询 **53.69ms**。通过纠正后旧索引拒绝、增量新版本、来源忽略、重启复用30项、损坏行仅重建1项、长文末尾线索、自动加载 / 停止，以及中途关闭后重启补做11项检查。认识为受控输入，没有证明真实模型会正确抽取或回答。

失败证据保留：旧完成计数曾被误认为新快照完成，现用快照摘要确认；一次性分块及480 token原生调用曾导致100ms查询预算耗尽，改为逐块生成和128 token文档块；强制 terminate 原生推理曾造成 Napi 异常并使进程退出134，现等待当前调用结束、dispose 后关闭。实际进行中关闭耗时 **68.80ms**，重启补做未提交候选通过，不以放宽前台截止掩盖失败。

本节记录初次宿主接线；随后自动准备与故障恢复已按 §7.3 完成。跨平台与许可分发、完整多身体、正式留出、大历史和其余 C07 仍待完成，不将开发案例召回当作 M2 放行。

### 7.3 自动准备、取消与故障恢复

`adaptive-component.ts` 使用现有 Node / npm 自动准备固定组件。仅集中身体且 enabled / semantic 开启时执行，不新增使用者需要选择的模型或配置。安装使用完整锁、固定公开 registry、禁用安装脚本及空 npm 用户 / 全局配置；不继承 npm token 或 NODE_OPTIONS。依赖完成与整个组件完成分别记录，绑定固定组件摘要、平台、架构和 Node ABI；模型传输失败不会重装已经完成的依赖。Range、总大小和 SHA256 / Git blob 均核查；部分文件保留，坏的完整文件拒绝安装。取消会终止 npm 进程树并等待退出，仍存活的安装 PID 会使新安装延后。

准备或组件加载失败以30秒至10分钟退避；依赖加载损坏会废弃依赖标记并重装。worker 打开派生库时检查 SQLite 完整性及表结构，只对确定损坏保留 `.damaged-*` 现场再重建，busy / 权限 / 磁盘故障不能被解释成损坏。单候选暂时失败以2至60秒重试，无需新消息；分块超限计为 blocked，不循环计算。状态区分准备进度、固定失败码、重试时间、retrying / blocked 数量和 cacheRecovered，不能据模型 ready 宣称所有候选已经完成。

实际准备函数先做一次固定端点续传；真实 npm ci 与校验共 **2.71秒**。随后 `deploy.ts` 经正常中心生命周期完成五项实际检查：

- 新建隔离家目录，预热公开 npm 内容缓存和模型部分文件，不复制 node_modules / 完成标记。中心自行安装并从固定公开端点续传最后1024字节；就绪 **5.89秒**，准备中的前台读取 **3.85ms**。
- 删除隔离组件的库入口；中心自动识别、退避重装，约 **32.75秒**恢复，期间词面读取继续可用。
- 损坏派生 SQLite 文件；重启保留原坏文件并重建两项认识向量。复用组件未发出模型下载请求，依赖完成标记没有重写。
- 用独立 SQLite 连接持有写锁，实际 worker 安装候选失败；解锁后约 **2.01秒**自动补做。没有新输入或人工 replace，没有把 busy 当作损坏删库。
- 取消正在执行的真实 npm 安装，核查 PID 已不存在且未写组件完成标记；再次准备无需手工清理即可成功。

这些数据明确为 **cachePrefilled** 的本机工程实验，不是全冷网络下载速度、跨平台安装或真实语义质量。旧宿主11项真实向量检查复跑通过，召回仍8/14→14/14、查询 P95 **11.20ms**。旧模型 / 多身体开发夹具显式禁用组件准备并在报告标注词面模式，避免测试意外联网，也不能据旧报告声称向量已经覆盖多身体。下一步仍须在完整多身体轨迹接通真实中心组件，并完成正式语义门禁。

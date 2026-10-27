# 自适应记忆：开源组件契约实验与测试模型

状态：M2 进行中。本页记录已执行的边界实验和下一步适配方向，**不是完整组件选型或 M2 放行**。关联：[计划](ADAPTIVE_MEMORY_PLAN.md)、[契约](ADAPTIVE_MEMORY_CONTRACT.md)、[验收](ADAPTIVE_MEMORY_ACCEPTANCE.md)、[验证记录](ADAPTIVE_MEMORY_PROGRESS.md)。

## 1. 固定候选与验证边界

2026-10-27 从官方仓库取得以下源码，检查实际实现与许可证；上游后续升级必须重新跑契约实验。实验不使用真人记忆，不向上游项目的服务发送资料。

| 候选 | 固定源码 / 包 | 许可证 | 本批执行范围 |
|---|---|---|---|
| Graphiti | [2b5db9e](https://github.com/getzep/graphiti/tree/2b5db9e139b2627c3ba18ff55f9181569b0d8224)，pyproject 0.31.2 | Apache-2.0 | 原样执行标准库去重辅助模块；合成人物对象，无数据库 / 向量 / LLM |
| A-MEM | [ceffb860](https://github.com/agiresearch/A-mem/tree/ceffb860f0712bbae97b184d440df62bc910ca8d)，agentic-memory 0.0.1 | MIT | 原样执行 MemoryNote 和指定 update / delete / process_memory 方法 AST；检索器与 LLM 用明确的故障注入替身 |
| LangGraphJS | [7ab1b8d8](https://github.com/langchain-ai/langgraphjs/tree/7ab1b8d840c068c2593fea4683899508d93e6b33)；checkpoint 1.2.1、checkpoint-sqlite 1.1.0 | MIT | 已审读检查点与 SQLite saver；可执行探针针对 npm checkpoint 1.2.1 的真实 MemorySaver，执行结果单独记录 |

Graphiti 的默认依赖包括 Neo4j 驱动、Pydantic、模型 SDK、NumPy、重试与遥测组件，另有 FalkorDB / 嵌入式数据库选项；A-MEM 默认依赖 Chroma、sentence-transformers、LiteLLM、scikit-learn 等。LangGraph 的 SQLite saver 另需 better-sqlite3 原生依赖。**本批没有把这些依赖加入 runtime**，也没有借包名声称其完整服务可部署。除源码 clone 和检查点临时 npm 安装外，后续已有提示词规则副本；没有启动图数据库。

后续选型仍需补齐：真实语义质量、完整依赖锁、取消与超时传播、索引 / 导出 / 重建、运行成本及自动部署恢复。若复用上游代码或提示词，必须随副本保留许可证、版权、固定源链接和修改说明；最初批次只提交实验工具；后续 M2 开发批次已将抽取 / 时间提示规则改编到 `runtime/src/memory/prompts/adaptive-graphiti.ts`，并附 Apache-2.0 LICENSE、版权和修改说明，详见[提示词副本说明](../../runtime/third_party/graphiti/NOTICE.md)。这不是完整 Graphiti 服务集成。

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

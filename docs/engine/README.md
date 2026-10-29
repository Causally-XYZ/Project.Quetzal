# Agent 内核引擎开发文档

这里专门维护 Quetzal Agent 运行时内核的实现事实、接口边界、验证证据与后续开发记录。2026-10-13 的初始快照记录既有实现；2026-10-14 起在保持兼容的前提下逐步提取独立引擎。

## 当前结论

Quetzal 的独立 engine 负责模型—工具循环、通用协议、动态上下文和纯策略；runtime 负责身体、来源、存储、模型适配、权限、调度与多身体。MCP 客户端已支持 stdio、Streamable HTTP / SSE 和 OAuth；CLI 已有本机终端聊天。MCP 服务端、远程 TUI 与未完成研究方向不能因接口存在被视为已交付。

记忆需区分两条路径：原有结构化记忆 / PRIME，以及默认关闭的自适应记忆。开启新记忆后，对话事实由它统一整理，旧学习不再并行写入；动态上下文和原文回查继续共用。新系统的关系图、证据、任务与版本机制在 runtime，不能把 engine 的 PRIME 算法当作新认识图的实现。

当前记忆交付为完整入口的可运行试用版，未完成质量 / 规模工作进入 backlog；原 M5 失败和评分标准保留。按以下现行文档开始阅读，再查历史，而不是从阶段追加记录倒推当前设计。

## 自适应记忆：现行说明

| 文档 | 负责回答的问题 |
|---|---|
| [目的与原则](../PRINCIPLES.md) | 为什么做、长期价值、容错和工程取舍 |
| [设计与实现总览](ADAPTIVE_MEMORY.md) | 当前数据结构、数据流、开关、纠正及多身体边界 |
| [交付与 backlog](ADAPTIVE_MEMORY_RELEASE.md) | 本次交付了什么、哪些证据成立、哪些尚未验证 |
| [行为契约](ADAPTIVE_MEMORY_CONTRACT.md) | 目标行为；不是所有条目已经完整通过 |
| [语义协议](ADAPTIVE_MEMORY_SEMANTICS.md) | 认识、引用、证据计算、局部读取与修订 |
| [发布与恢复协议](ADAPTIVE_MEMORY_STORAGE.md) | SQLite / 文件 / Git 的职责、任务与恢复 |
| [验收案例](ADAPTIVE_MEMORY_ACCEPTANCE.md) / [评测登记](ADAPTIVE_MEMORY_EVAL.md) | 合成轨迹、正式评分与证据要求 |

## 现有执行与旧记忆专题

| 文档 | 范围 |
|---|---|
| [engine 模块](../../engine/docs/README.md) / [模块地图](MODULE_MAP.md) | 独立引擎边界与宿主调用链 |
| [执行与调度](EXECUTION.md) | 对话、醒来、做梦、并发、子 agent、停止 |
| [动态上下文](DYNAMIC_CONTEXT.md) / [上下文管理](CONTEXT.md) | 模型窗口、预算、摘要、工具节选、回查与来源核对 |
| [记忆分层](MEMORY.md) | 身份、文件、原文与旧检索路径；新图另见上表 |
| [结构化记忆](STRUCTURED_MEMORY.md) / [PRIME 内核](PRIME_CORE.md) | 原有记录、资格、确认、学习与演化；新记忆启用时的写入限制另述 |
| [MCP](MCP.md) / [交互接口](INTERFACES.md) | 工具来源与客户端，权限和生命周期 |
| [受限研究运行器](RESEARCH_RUNNER.md) | 独立环境、运行轨迹与评分；不是生产记忆研究器 |

## 计划、决策与历史证据

| 文档 | 如何使用 |
|---|---|
| [M0–M5 计划](ADAPTIVE_MEMORY_PLAN.md) | 已批准的目标及范围变更；当前交付以后置 backlog 覆盖旧 M5 前置条件 |
| [阶段记录](ADAPTIVE_MEMORY_PROGRESS.md) | 按日期保留执行、失败、复跑和推送证据；旧段落中的“待完成”不是现行状态 |
| [第一性原理复审](ADAPTIVE_MEMORY_FIRST_PRINCIPLES_REVIEW.md) | 多轮模型讨论、代码核对和未决方向；讨论不等于测试 |
| [组件实验](ADAPTIVE_MEMORY_COMPONENTS.md) | 开源版本、探针、选择理由与局限 |
| [引擎设计](DESIGN.md) / [路线图](ROADMAP.md) / [适配计划](ADAPTERS_PLAN.md) | 早期拆分和适配设计，按各文档日期解读；当前接口以源码 / API 为准 |
| [初始基线](BASELINE.md) / [提取验证](EXTRACTION.md) / [策略提取](CONTEXT_EXTRACTION.md) / [后续验证](FOLLOWUP.md) | 历史验证快照，不能据旧缺项判定当前功能不存在 |
| [上下文与 PRIME 交付](MEMORY_REPLACEMENT.md) | 新自适应记忆之前的接线与验证记录，保留历史，不是全项目最新状态 |

## 维护约定

1. 总览负责设计和导航，协议文档负责精确行为，阶段记录负责实验；同一条修复不重复追加到每份 README。
2. 源码路径、配置默认值、接口形状应核对实际实现。来源 / 版本正确不等于自然语言正确，测试存在不等于本轮通过。
3. 修改执行、上下文、记忆、工具或模型层时维护对应主题及全局接口；灵魂格式只由[仓库规范](../SOUL_REPO_SPEC.md)定义。
4. 原失败、未执行和未审核保留；新方案、未来目标、当前实现和历史证据必须明确区分。
5. 仅用架构描述和合成案例。私人材料、凭据与运行数据不进入公开仓库。

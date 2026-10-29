# 项目文档导航

本目录面向当前工作分支的开发与审查。官网、发布包和当前分支可能处于不同版本；自适应记忆的交付范围以[可运行试用版](engine/ADAPTIVE_MEMORY_RELEASE.md)为准，不能用公开安装命令假定取得尚未发布的分支功能。

## 推荐阅读路径

1. [项目介绍](../README.md) → [目的与原则](PRINCIPLES.md)：产品要解决什么问题，哪些价值和边界需要保留。
2. [运行架构](ARCHITECTURE.md) → [API](API.md)：模块如何配合，现有接口和配置是什么。
3. [快速开始](QUICK_START.md) → 下面的模块文档：按实际平台构建、配置和运行。
4. 记忆专项读[实现总览](engine/ADAPTIVE_MEMORY.md) → [行为契约](engine/ADAPTIVE_MEMORY_CONTRACT.md) → [语义协议](engine/ADAPTIVE_MEMORY_SEMANTICS.md) / [持久化协议](engine/ADAPTIVE_MEMORY_STORAGE.md)。

## 模块边界与入口

| 模块 | 职责与文档 |
|---|---|
| engine | 不依赖身体和存储的模型—工具循环、上下文和通用策略；[开发入口](../engine/docs/README.md)、[依赖边界](../engine/docs/ARCHITECTURE.md) |
| runtime | 装配引擎、模型、心脏、工具、权限、记忆、数据库和多身体；[运行说明](../runtime/docs/README.md)、[源码地图](../runtime/docs/ARCHITECTURE.md) |
| console | Flutter 管理和聊天客户端；安卓还承载身体与基座，桌面提供平台能力；[构建说明](../console/docs/README.md)、[架构](../console/docs/ARCHITECTURE.md)、[用户旅程](../console/docs/USER_JOURNEY.md) |
| cli | 安装、升级、守护、终端聊天与离线恢复；[说明](../cli/docs/README.md)、[架构](../cli/docs/ARCHITECTURE.md) |
| bridge | 把外部框架的记忆映射到灵魂仓库，不接管其执行循环；[说明](../bridge/docs/README.md)、[同步协议](SOUL_SYNC.md) |
| sync | 独立部署的账户、绑定、信令与中转服务；不是私人记忆推理中心；[入口](../sync/README.md)、[开发文档](../sync/docs/README.md)、[协议](../sync/docs/PROTOCOL.md) |
| website | 官网、用户文档和下载入口；[说明](../website/docs/README.md)、[架构](../website/docs/ARCHITECTURE.md)、[部署](../website/docs/DEVOPS.md) |

## 按问题查找

| 问题 | 文档 |
|---|---|
| 灵魂保存什么、什么绝不能入库 | [灵魂仓库规范](SOUL_REPO_SPEC.md)（当前格式 v14） |
| 如何同步、多身体分区后怎样继续 | [灵魂同步](SOUL_SYNC.md)、[分布式设计](DISTRIBUTED.md) |
| 上下文、旧记忆、MCP 与执行调度 | [内核专题索引](engine/README.md) |
| 自适应记忆现在能做什么、有什么缺口 | [实现总览](engine/ADAPTIVE_MEMORY.md)、[交付与 backlog](engine/ADAPTIVE_MEMORY_RELEASE.md) |
| 为什么这样设计、讨论过哪些替代方向 | [原则](PRINCIPLES.md)、[第一性原理复审](engine/ADAPTIVE_MEMORY_FIRST_PRINCIPLES_REVIEW.md)、[组件实验](engine/ADAPTIVE_MEMORY_COMPONENTS.md) |
| 原 M0–M5 计划、评分与真实证据 | [计划](engine/ADAPTIVE_MEMORY_PLAN.md)、[验收案例](engine/ADAPTIVE_MEMORY_ACCEPTANCE.md)、[评测登记](engine/ADAPTIVE_MEMORY_EVAL.md)、[阶段记录](engine/ADAPTIVE_MEMORY_PROGRESS.md) |
| 平台决策、接入和研究 | [Windows 决策](WINDOWS_DECISIONS.md)、[上手流程](ONBOARDING.md)、[研究工作区](research/README.md) |

## 文档权威与维护方式

- **目的与契约**说明期望行为；**现行协议和源码**说明实际机制；**验证记录**说明在哪个候选、条件和日期验证到什么程度。三者不能互相代替。
- 实现事实以当前源码为准；出现与契约的差距应写成缺口，不能悄悄修改目标来迁就实现。最新明确批准的范围变更优先于旧计划。
- 每个主题只维护一个详细主文档：总览给边界与导航，API 给接口，模块架构给代码位置，实验记录给证据。不要把每次修复日志重复追加到所有 README。
- `ADAPTIVE_MEMORY_PROGRESS.md`、复审、组件实验、早期引擎提取与平台决策文档保留时间线和原失败；其中“当前”“待完成”按该段记录日期理解。开始下一轮工作先读交付说明，再回查具体历史。
- 本次整理未改变评分门槛、产品配置、数据格式或依赖。未执行的全量质量、规模和真人试用仍是未验证；文档核对不产生新的产品测试成绩。
- 公共文档只使用通用设计和合成示例；运行材料留在仓库外 `QUETZAL_HOME`，不提交私人记忆、凭据、真实设备标识或个人路径。

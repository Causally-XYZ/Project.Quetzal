# M2 留出数据与审核回执

当前只实现数据冻结、校验和只读评分，**没有正式运行器或真实留出成绩**。本目录不被生产模型提示导入，不进入 main.cjs。全部是合成材料，真实运行的家目录、请求、结果和审核回执必须留在仓库外。无新增依赖、环境变量、部署服务或灵魂格式。

## 文件与命令

- `cases.ts`：确定性构造器，用于核对冻结内容，不按模型结果重写答案。
- `holdout-v1.json`：50案例、60独立轨迹、160检查点、800条断言；每案例重复3次，计150案例序列 / 180轨迹运行。
- `manifest-v1.json`：文件字节摘要、按 JSON.stringify 得到的整体摘要及逐案例摘要。对象字段顺序也受摘要约束。
- `spec.ts`：数据形状与已释放来源引用校验。`releasedActions` 仅返回至当前步骤的投递操作，去掉检查预期和查询；**它不是可直接发送给模型的输入**，其中还包含必须送到隔离库的权限负例。
- `score.ts`：审核证据定位、固定分母与门槛计算；不使用关键词命中或模型自评自动判断语义。
- `cli.ts`：只读入口，核对冻结文件后检查或评分。

从仓库根目录执行：

```bash
npm run eval:adaptive --prefix runtime -- --check
npm run eval:adaptive --prefix runtime -- --score "$EVAL_ROOT"
node --experimental-strip-types --test runtime/test/adaptive-eval.test.ts
```

`EVAL_ROOT` 指向仓库外已完成执行与审核的目录。命令不调用模型、不创建回执、不覆盖原成绩；检查正常退出0，评分仅 semanticGate 为真时退出0，否则退出1，参数 / 数据 / 计划错误为失败。退出0也不代表 M2 全部门禁通过。

## 后续运行器必须兑现的契约

1. 首次调用前保存不可覆盖的 `plan.json`：`schema=quetzal-m2-plan-v1`、suiteHash、完整40位 processorRevision、configuration。完整 configuration 还须固定主力 / 强 / 快模型及实际路由、提示 / schema 摘要、处理器、候选检索、输出 / 时间 / 重试预算、传输、代码是否干净、输入权限和后台设置。当前 CLI 仅验证基础绑定与摘要，**尚不能验证这些配置完整或执行过程遵守计划**。
2. 每案例 / 重复 / 轨迹独立新建隔离状态。AM-03 的真实变化与历史纠正、AM-10 的歧义与冲突分别重置，不能共享认识。每个完整案例的全部轨迹均需完成，不能把60轨迹错当50案例。
3. A / B 是本机不同 runtime 进程与 QUETZAL_HOME，由集中主机处理。按步骤经真实输入 / 复制 / 后台流程释放；只允许已释放输入进入候选库。查询可作为当前检查点问题，但预期断言、未来消息、评分规则不能给被测模型。保留查询及生成回答是否进入后续历史的固定政策，避免未登记的额外证据。
4. AM-16 的 denied / other-agent 输入必须投递到相应隔离数据区，并检验实际拒绝；不能先把负例拼到主模型上下文再要求模型忽略。保留可验证隔离的事件证据。AM-09 的 assistant-summary 保持助手角色，不能当作用户发言投递。
5. AM-07 明确为受控依赖图，不测试 LLM 自行发明正确图。用真实存档 / 图接口建立 G1={A,B}、G2={C}、K、独立L及 K→A 环，记录初始图与来源；撤回操作通过实际失效机制执行，检查 G1 / G2 状态及查询 / 回答。不能用自然语言声称已撤回来替代实际失效。图设置、来源和撤回方式须在首次运行前固定。
6. 每检查点保存 records（提案、版本、安装 / 支持状态）、material（实际发送视图）、answer（实际回答）、sources（已释放原文 / 时间及权限）、events（真实调用、用量、延迟、发布和完成状态）。缺失用量明确 unknown / null，包含失败、重试及取消，不隐式切模型。事件的 pipelineComplete 只能在相应后台 / 查询 / 回答链全部完成后为真。
7. 先保存真实执行证据，再逐条核查断言。审核人检查来源和实际材料，登记理由与位置；model 只能给辅助建议，不能给自己赋 agent / human 身份。开发 Agent 审核不等于真人反馈。失败后保留原运行，不覆盖或删除失败、调整预期或缩小分母；修复后使用另行冻结且未用于修复的新变体。

上述工作未完成前不启动正式留出；现有 live-pilot 仅公开开发案例，不能代替本运行器。跨语境引用边界仍待用户对齐，当前不放宽生产校验。全阶段门槛见[评测登记](../../../docs/engine/ADAPTIVE_MEMORY_EVAL.md)。

## 回执与评分

每组案例 / 重复使用 `<caseId>/repeat-<1..3>.json`。类型定义见 `score.ts` 的 Receipt：绑定 suiteHash、整个 plan.json 的 planHash、caseId、repeat，标记 live / stub 和 complete / failed / interrupted，包含 artifacts 与 reviews。

Artifact 的 checkpoint 为 `<track>/<step>`，包含五类 surface 之一、内联 data 和 data 的 SHA-256。Review 的 check 为 `<track>/<step>/<check>`，包含结果 pass / fail / unassessed、reviewer、reason、evidence。evidence 指向同检查点 Artifact 和能解析的 JSON Pointer：通过须覆盖断言要求的每种 surface；失败至少指向一种要求的 surface，一处实证错误已经足够失败。来源预期约束仍需审核者检查，不靠指针存在推定内容正确。

评分遍历冻结的全部150组，缺失、损坏、替身和未审核不会减少分母。模型自评记 unassessed；关键不变量、身份安全、无关认识保留和时间 / 证据安全必须零失败且无未审核项。绑定 / 纠正整体至少95%、各适用族至少90%；必需字段至少90%；完整运行至少95%。某族某指标没有断言时为不适用，不伪造分母。安全审核完整性可能比单独的执行完成率更严格，不能用完成率门槛跳过未观测的安全检查。

complete 声明需要每检查点五类材料及 pipelineComplete 事件，否则整份回执无效；failed / interrupted 已取得的有效审核仍可统计，未取得的检查保留分母。CLI 对单个计划限制64 KiB、回执32 MiB，解析文件须为评测目录内的普通文件。汇总只打印分数和安全错误码，不打印原始材料。

**信任边界**：哈希不是签名，JSON Pointer 不是语义证明，live / reviewer / pipelineComplete 是受信运行与审核流程写下的声明。评分器不能阻止伪造整套回执；必须核查原始运行日志和审核 provenance，不能让被测模型生成整份回执后直接作为成绩。测试文件有意构造标 live 的占位回执来测试算术，明确不是正式执行证据或已审核语义。

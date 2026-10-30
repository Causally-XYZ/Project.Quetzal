# 自适应记忆原型、留出数据与审核回执

当前实现数据冻结、严格执行计划、独立轨迹执行、实际证据导出、独立审核修订与显式选择评分；**已执行一个真实正式案例 AM-02-H1，第三步输出截断失败；独立审核10项通过、6项未评，整体门禁未通过**。本目录不被生产模型提示导入，不进入 main.cjs。全部是合成材料，真实运行的家目录、请求、结果和审核回执必须留在仓库外。无新增生产依赖、环境变量、部署服务或灵魂格式。

开发身体快照的 messages 另保留实际持久化的 answerBasis JSON（可空），用于核查正常网关生成的回答凭据与对端副本一致。此字段不是预期答案或语义评分，也不改变冻结数据；两身体测试另核查撤回后实际模型请求中的历史回答来源变化标记。

需求方已批准原型优先：M2 复用本目录公开运行器核验代表性完整过程；150序列及严格评分移至 M5。原文件名、回执 schema、失败结果与评分器保持不变，semanticGate 仍代表完整语义评分，不能拿它代替或伪造 M2 原型判定。现行门禁见[实施计划](../../../docs/engine/ADAPTIVE_MEMORY_PLAN.md)。

2026-10-29复核：旧v1计划采用默认思考且声明memoryLearning=false，与后来身体实际true存在漂移；旧档案保留此事实。旧正式目录重评分仍0完成、1失败、149缺失。需求方随后已确认[新轨迹评分](../../../docs/engine/ADAPTIVE_MEMORY_EVAL.md#m5-轨迹评分2026-10-29需求方已确认)，评分、计划与正式 / 审核CLI已增加显式v2分支，旧结果保留；v2题库及曝光清单已冻结。2026-10-30在清洁提交 `04bf28e`（计划摘要 `6869befc92cfb98e8539cc125f32ff575821ec5fe53440e10486a9ecd9b29e3d`）上完成全量150序列v2真实执行与逐条独立审核：整体 146/150 合格（`gates.overall=true`）、2失败、2因前台网络 `idle_timeout` 记 `unassessed`，零硬违规（`gates.noKnownHardViolation=true`）；9个族 ≥14/15，仅 AM-02 为 13/15（`gates.everyFamily=false`），故 `qualityGate=false`。原首批10条广度核读记录一并保留。

`scoreSequenceSuite`仅接受`quetzal-m5-eval-v2`：每案例最后检查点恰好一个sequence检查，`evidenceAt`预登记跨点所需材料，`required`引用必须通过的普通检查，内部多轨合一票。固定150票、整体143、各族14；原七类明细和预登记report分项分别统计。首次 / 再次复用等标记本身不证明真实顺序，正式数据和执行证据仍须核读。query-only观察动作只经正常chat.send提问，跳过素材摄入；冻结输入另见holdout-v2.json。

v2复用原只增审核链。整体无效回执不加票；若无关材料损坏，仍以同一严格校验器隔离保留能独立核实的硬失败，总绑定或硬失败自身证据坏则不采信，重复ID不挑选。`qualityGate`只表示质量票数，`gates.noKnownHardViolation`仅表示已核查证据未发现硬违规，`independentEngineering`固定为`not-evaluated`，不提供M5总放行。未登记 / 未评不等于零事件；通过仍需逐条独立审核。v1评分、数据、缺省CLI及归档输出保留；没有新依赖、生产配置、部署或构建入口。

## 文件与命令

v2正式入口如下（已冻结`holdout-v2.json`及`manifest-v2.json`，不会回退v1）：

```bash
npm run eval:adaptive --prefix runtime -- --check v2
npm run run:adaptive-eval --prefix runtime -- --init "$EVAL_ROOT" live v2
```

初始化缺省仍v1。后续run、score、review从归档plan.schema选择题库，再核计划与manifest，不能在同一次运行中换版本。v2评分的退出0只表示质量票数与已核实硬违规检查通过，独立工程门仍未评，绝不代表M5总放行。

v2配置采用Flash3.8 LOW（stub明确默认思考）、每身体100调用、每操作 / 等待300秒而非整步总墙、fullEvidence、实际memoryLearning=true及sentinel=false实验设置。empty开启研究、受控图关闭；已恢复的后台失败须有同任务 / 版本 / 处理器的后续成功尝试、最终done与回执，原失败保留。前台失败和截断仍停止，不能只把失败标志忽略。提案最大16384输出，普通对话按实际请求至多4096；研究规划格式单独绑定，研究最终提案沿用认识格式。

`inputMode:normal-converse-eligible`独立于baseline。empty中的可访问user素材经普通converse；拒绝来源保持ignored，其他agent只入隔离库，assistant-summary保留agent角色，受控图保持工程fixture。`query-only`不提供text、不注入source；AM-07仍先种图、撤回A、撤回C，再允许无关输入和观察。问题 / 回答自然留存、参与后续后台处理；合成at只用于素材同步记录时钟，问题、答复和提示中的当前时间仍真实，不假称推进虚拟日历。

完成检查点的回执区分素材回复与对端正式回答，核实际配置、逐步输入路径、完整调用start/end及当前快照；未完成终态只归档可用材料，不贡献通过票，也不声称完成同等逐项核验。观察前历史不变，新增外部user只能是登记问题；正常摘要 / 交接须有对应工具调用依据。模型观察器复制适配器返回值，避免router增加显示名前缀后倒改已存证据；后台job关联只记录合成任务身份 / 版本 / attempt，不含租约token，不进入模型请求。材料核查不证明语义正确；合成工具效果夹具不等于真实模型执行过这些工具。

- `cases.ts`：确定性构造器，用于核对冻结内容，不按模型结果重写答案。
- `holdout-v1.json`：50案例、60独立轨迹、160检查点、800条断言；每案例重复3次，计150案例序列 / 180轨迹运行。
- `holdout-v2.json` / `manifest-v2.json` / `exposure-v2.json`：50案例、60轨、265检查点、1860检查；三次150票。160素材及105个query-only，35动态轨预登记U/R1/R2；required包含R2关键复用，不要求R1全过。十例更换题材和具体事件，其余保留原素材；曝光与机制复用明确记录，非盲测。每个分项是检查结果，不能直接当修复耗时或复发事件率。
- `manifest-v1.json`：文件字节摘要、按 JSON.stringify 得到的整体摘要及逐案例摘要。对象字段顺序也受摘要约束。
- `spec.ts`：数据形状与已释放来源引用校验。`releasedActions` 仅返回至当前步骤的投递操作，去掉检查预期和查询；**它不是可直接发送给模型的输入**，其中还包含必须送到隔离库的权限负例。
- `score.ts`：审核证据定位、固定分母与门槛计算；不使用关键词命中或模型自评自动判断语义。
- `cli.ts`：只读入口，核对冻结文件、原始执行及显式审核清单后评分。
- `review.ts` / `review-cli.ts`：导出审核包、只增审核修订和显式选择清单，不自动判断语义。
- `development.ts` / `run-track.ts`：公开案例入口与逐步轨迹执行；不加载正式留出数据；支持 ignored 来源、另一 agent 隔离负例与受控依赖图，拒绝含 checks 预期的步骤。
- `controlled-graph.ts`：仅用于受控图设置 / 撤回的正式存档适配器，不生成模型成绩。
- `body.ts` / `process-client.ts`：隔离进程中的实际存储、后台、网关、WebRTC 和灵魂同步，以及有界 IPC / 网关请求与退出检查。只在测试信令目录和本机裸 Git 远端复用既有测试例外。
- `model-observer.ts`：完整适配器输入 / 输出、实际模型、用量与错误的旁路记录；live 使用既有 ADC 传输，stub 明确为工程替身。
- `retrieval-observer.ts`：显式向量模式的公开缓存预热与真实调用旁路；不替换推理、候选、查询结果或生产准备器。
- `recovery-development.json`：M4公开恢复开发材料，工作协作 / 家庭维修信息 / 志愿活动三个题材，包含备份前输入、备份后新信息、首次查询、无关穿插、再次相关使用及人工核读要点。不是正式留出，也不是 `development.ts` 新增的 `--case` 选项；编排复用 BodyClient、管理 RPC 与正式恢复 CLI，观察证据见阶段记录。checks 和未来输入不得发送给模型，文件不进入生产 bundle。

从仓库根目录执行：

```bash
npm run eval:adaptive --prefix runtime -- --check
npm run eval:adaptive --prefix runtime -- --score "$EVAL_ROOT"
node --experimental-strip-types --test runtime/test/adaptive-eval.test.ts
```

`EVAL_ROOT` 指向仓库外已完成执行与审核的目录。命令不调用模型、不创建回执、不覆盖原成绩；检查正常退出0，评分仅 semanticGate 为真时退出0，否则退出1，参数 / 数据 / 计划错误为失败。退出0也不代表 M2 全部门禁通过。

## 公开多身体开发试跑

```bash
npm run pilot:adaptive-multibody --prefix runtime -- --kind=stub
GCLOUD_BIN="$(command -v gcloud)" npm run pilot:adaptive-multibody --prefix runtime -- --kind=live --model=gemini-3.8-flash --steps=3
# 仅公开开发对照；主力模型显式 LOW，与默认结果分开保存
GCLOUD_BIN="$(command -v gcloud)" npm run pilot:adaptive-multibody --prefix runtime -- --kind=live --model=gemini-3.8-flash --case=realm --steps=3 --thinking=low
```

`--thinking=default|low` 缺省 default，保持供应商默认设置。low 只允许 live 主力模型；由隔离家目录的正常模型配置保存 `thinkingLevel: LOW`，再经正式路由和 Google 适配器生成 `thinkingConfig.thinkingLevel=LOW`，所有提案和回答均适用。ADC 只观察该字段并逐字透传正文。开发计划、轨迹配置、每次调用及传输回执都记录此差异；原 messages / schema / token 上限不变。不得与默认结果混合评分，正式 fullEvidence 轨迹拒绝此实验覆盖。该字段也是控制台可设置的生产模型配置，但开发参数不改使用者的真实配置，也不表示低思考质量合格。既有脚本、类型检查和打包边界不变，无新依赖。

`--case=realm-status` 是独立公开变体：同名现实 / 小说母亲、表妹评价对象纠正，以及现实搬家状态从未知到明确尚未发生、再到后来发生。三步交替身体，原状态的时间范围应保留；期望判断不进入模型请求。它与 realm 原开发案例分开，不改冻结留出数据。

`--case=correction-detail` 检验原评价对象纠正时保留评价内容，随后明确撤回评价；独立展品价格与明确 UTC 开展时间应保持。另含相对月末和后来到货，不能将未知时区补成精确 UTC，也不能把有明确时区的时间一律清空。该案例同样是公开开发材料，不改正式数据或门槛。

缺省 stub，不触网调用模型；live 会产生真实模型费用，模型仅允许已授权的 Flash / Argon / Lite，缺省 Flash。steps 可为1～3，截短的开发运行不能当成完整纠正通过。缺省使用公开的周宁 / 周宇 / 阿舟开发案例，新增每步查询；--case=scope 选择独立公开的余晨 / 恶意引文 / 来源隔离案例，不读取正式留出集；不同于旧 live-pilot 的仅末步查询，不能直接比较调用量或质量。ADC 只在开发子进程内存认证，沿用现有 GCLOUD_BIN / GOOGLE_CLOUD_PROJECT，不代表生产配置支持。QUETZAL_EVAL_BODY 是父子进程内部启动参数，不是产品配置，含测试信令与本机路径，不提交其实际值。

入口自动建立仓库外独立目录，先保存开发输入摘要、当前提交、dirty 状态、相关源码 / 依赖清单字节指纹及预算，再启动两具身体。源码指纹用于记录工作区实况，不代替正式计划冻结。每身体最多36次调用；连接25秒、普通 IPC 15秒、每次处理等待 / 网关回答各180秒。它们是分别计时的操作上限，不能冒充整个步骤180秒总墙。首次观察到后台 / 模型错误就结束本轨迹，不自动重跑；生产后台可能已在观察前重试，全部调用仍留存，不能筛掉失败。

历史输入由子进程 store.addMessage 写入，只在同步写入 / 广播期间注入合成记录时钟，异步调度、传输和模型计时保持真实时间；原文不是经浏览器输入，也没有模拟历史当时的助手回复。先核对两端来源正文 / 时间，再等待实际后台模型提案、正常校验安装、自动发布与对端读取；普通来源认识不能由运行器手工安装；明确声明 and-or-graph 的受控案例按下文输入操作安装。查询经另一身体认证后的 chat.send 网关、converse 与真实上下文。问题及回答按正常历史保留，并等待其后台处理后再释放下一步，避免未登记额外输入的竞态。

每步保存回答前 / 后的记录、来源、任务、自动发布、调用材料、实际回答和 context.plan；调用开始 / 结束各写独立只增文件。真实调用还检查实际 modelVersion 与 STOP，未知用量不填零。完成状态仅表示流程完成，未做自动语义审核，也未生成正式评分回执。其他历史召回仍可用，因此回答正确不证明新图是唯一原因。退出先中止请求、等待后台 / 模型、关闭网关 / mesh / 数据库并写 shutdown-evidence；父进程核对实际退出，必要时强制终止并将试跑判失败。旧运行目录不可覆盖。

stub 模型只按当前来源输出简单带引文认识；依赖重评返回空补丁，不伪造语义纠正，回答明确为工程替身；它不模拟别名推理或纠正。相关测试验证真实独立进程、复制时间、未来输入不泄漏、自动 Git 发布、网关材料与失败收尾，不能据此放行语义目标。

### 显式真实向量与断线补做

缺省明确停用组件准备，保留原词面工程夹具。指定 `--retrieval-cache="$PREPARED_PUBLIC_ROOT"` 后，中心按生产路径自动准备和加载固定向量组件；该外部目录须为公开组件实验的父目录，含 component/model 与 npm-cache。只复制锁中 SHA512 匹配的公开 npm 内容块及摘要核验后的五个模型文件，不复制 node_modules、完成标记、npm 配置或用户资料。真实 npm ci 仍由中心运行，允许访问固定公开下载端点；这些结果不代表全冷下载速度。其他身体也保留正常生产开关判断，必须没有本机组件目录或向量调用。

此模式每个检查点除了等待生成 / 发布 / 复制，还等待中心索引摘要与当前权威候选完全一致且 pending=0；记录实际向量 queryHash、候选 key、耗时和降级状态，保存同快照词面对照及真实网关读取。旁路只观察原方法，不把查询或预期结果塞进向量。最终仍要检查认识是否进入真实模型材料；向量命中不等于语义正确。

可加 `--disconnect-step=3`（只能指向存在的 B 身体 accessible 输入）：停止卫星真实 mesh，确认两端断开，再写该条来源。保存 offline-N.json，核查中心尚无此来源、卫星查询明确 unavailable；恢复 mesh 后由正常消息补齐、中心后台、自动发布和索引继续处理。该操作是测试注入，不增加产品 RPC，也不是整个身体进程崩溃或磁盘恢复验收。

```bash
# 公开别名案例：显式真实模型 + 真实向量，第三次输入在卫星断线时写入
GCLOUD_BIN="$(command -v gcloud)" npm run pilot:adaptive-multibody --prefix runtime -- --kind=live --case=aliases --retrieval-cache="$PREPARED_PUBLIC_ROOT" --disconnect-step=3
# 生成模型替身，真实向量 / 网关 / 复制：改述召回、依据撤回、断线补做及正常退出断言
node runtime/tool/adaptive-retrieval-probe/multibody.ts "$PREPARED_PUBLIC_ROOT"
```

范围开发案例可用 `--case=scope --kind=stub`，显式改为 live 才调用模型。`denied` 从首次写入就设置现有 `mode=ignored`，原文仍实际存在并复制到两端，排除发生在正常来源 / 查询门禁；不先发送给模型再要求它忽略。它只检验既有“不可用于当前认识”的排除规则，不等同新增逐会话 ACL 或物理删除。审计快照可以保留该原文，用于证明负例确实存在，但不能拼入模型材料。

`other-agent` 写入第三个独立 runtime 存储进程，身份为另一个合成 agent，使用独立 SQLite、灵魂远端、密钥与网关；不加入主 agent 的 mesh，也不配置 / 调用模型。当前 agent 的两具身体不得取得该来源。卫星另经真实已认证 mesh RPC 做正反对照：本 agent 参数必须得到 ready，再用错误 agent 参数请求同一入口，只接受明确的范围错误为拒绝证据，断线 / 超时不能算通过。检查点 isolation 保存第三进程快照和 RPC 结果；同名不改变授权。此隔离是运行数据和服务命名空间隔离，不宣称操作系统沙箱能抵御任意文件工具跨目录读取，相关安全范围仍须按生产门禁验证。

这两类负例可在运行器中执行，不代表真实模型的提示注入语义、所有读取工具 / 缓存或正式 AM-16 已通过。每次仍需核查实际提案、材料和回答；工程替身只能验证传输、过滤、拒绝与收尾。第三进程也进入最终退出检查，不留后台服务。所有变动仅在开发工具 / 测试内，现有 package.json、tsconfig 和测试 glob 已覆盖，无新依赖或生产配置。

## 跨语境开发案例

`--case=realm` 为独立公开的现实亲属 / 小说同名角色案例：先声明两个语境，再记录现实弟弟评价小说父亲，最后纠正为评价小说叔叔。检查身份分别保留、评价关系能表达、故事情节不作为现实事实、引用目标纠正不改变其他情节与亲属。仍逐步释放并经两具真实身体处理，默认 stub 不证明语义能力；不导入或改写冻结留出。

`--case=evidence` 为独立公开的证据边界对照：同事讨论辞职的小说角色，随后明确说截至四月底本人未辞职，最后补充五月六日辞职。分别检查未知不能变成否定、明确否定有来源与时间、后来的状态变化保留过去事实。仍使用正常查询 / 回答历史和逐步后台处理；没有注入预期答案或更改正式留出。流程完成不等于语义通过，公开失败及实际结果见阶段记录 §4.35。

## 记录时间与未陈述角色开发案例

`--case=time-roles` 使用独立公开的林墨 / 林青 / 阿林案例：二月声明同昵称的合作者与同事，五月记录整理录音、引语与“下月”走访决定，八月明确同伴为同事、引语说话人为用户本人。每步从对端真实网关提问，核查原始记录月份、当时相对时间、未陈述的听话对象保持未知，独立关系与决定不被纠正抹去。可结合 `--retrieval-cache` 和 `--disconnect-step=3` 检验真实向量和离线纠正补齐；其余执行及失败保留规则不变。该公开开发案例不读取或改写正式冻结留出，流程完成仍须逐项核查实际认识、请求材料和回答。

## 受控 AND/OR 图开发案例

`--case=graph` 使用公开的渡口恢复通航案例；默认 stub，显式 live 才调用所选模型。setup=and-or-graph 明确声明这是一张测试提供的图，不考察 LLM 发明图结构。步骤固定为初始设置、撤回 A、撤回 C；允许公开开发运行截短，但不能当完整验收。普通轨迹不能夹带撤回操作，受控轨迹必须为可读用户来源且顺序合法。

每步先等前一步完全处理且中心空闲（同时核对没有运行中的模型调用或 queued / running 任务，不能只信暂报 idle），暂停中心记忆调度，再在 A / B 指定身体写入控制消息并等待原文复制。中心在灵魂锁内通过 `archive.accept` 安装初始五条 claim 或目标的新 withdrawn 版本，完成这条消息的 semantic-v1 回执，防止普通抽取器重复解释测试设置。初始图为 K 的 G1={A,B} 与 G2={C}、A 的直接来源及 K→A 依赖、独立 B / C / L；所有直接依据来自同一条合成规则声明，逻辑分支独立不等于多个独立证人。时间不根据操作时钟补造。

撤回是 A / C 认识的版本撤回，不删除 / 忽略原消息，不机械改写 K / L，也不只移除 A 的一个来源（否则仍有效的 C→K→A 可能再支持 A）。存档接受后立即写只增 controlled-N.json，含实际 batch、输入 hash、artifact、前后状态与 modelGenerated=false，再恢复正常后台：文件发布、Git 传播、失效依赖模型重评均照常进行。live 重评可以改变记录，运行器保留真实变化或失败，不强制覆盖成预期答案。

每检查点另保存实际 `memory.adaptive.semantic.query` 网关读取，以及控制记录的当前状态 / 完整历史；随后仍经对端 chat.send 回答，问题 / 回复继续参与正常历史处理。语义查询结果与实际对话请求分别保存，不能以单独查询正确替代模型实际使用正确。模型失败时已接受的控制操作仍保留独立证据，后续步骤不得继续。受控 IPC 仅在测试子进程启用，不加入产品操作流程；它不是使用者需要手动维护图的设计。

## 正式执行与待完成审核契约

1. 首次调用前保存不可覆盖的 `plan.json`：`schema=quetzal-m2-plan-v1`、suiteHash、完整40位 processorRevision、configuration。完整 configuration 还须固定主力 / 强 / 快模型及实际路由、提示 / schema 摘要、处理器、候选检索、输出 / 时间 / 重试预算、传输、代码是否干净、输入权限和后台设置。formal 入口现严格核对完整固定配置、干净提交、相关源码 / 锁文件字节与 Node / 平台 / 架构；code.json 留存文件清单，plan.json 另含提案 schema 与提示模板摘要。仍须核查真实调用材料，摘要不代替行为验证。
2. 每案例 / 重复 / 轨迹独立新建隔离状态。AM-03 的真实变化与历史纠正、AM-10 的歧义与冲突分别重置，不能共享认识。每个完整案例的全部轨迹均需完成，不能把60轨迹错当50案例。
3. A / B 是本机不同 runtime 进程与 QUETZAL_HOME，由集中主机处理。按步骤经真实输入 / 复制 / 后台流程释放；只允许已释放输入进入候选库。查询可作为当前检查点问题，但预期断言、未来消息、评分规则不能给被测模型。保留查询及生成回答是否进入后续历史的固定政策，避免未登记的额外证据。
4. AM-16 的 denied / other-agent 输入必须投递到相应隔离数据区，并检验实际拒绝；不能先把负例拼到主模型上下文再要求模型忽略。保留可验证隔离的事件证据。AM-09 的 assistant-summary 保持助手角色，不能当作用户发言投递。
5. AM-07 明确为受控依赖图，不测试 LLM 自行发明正确图。用真实存档 / 图接口建立 G1={A,B}、G2={C}、K、独立L及 K→A 环，记录初始图与来源；撤回操作通过实际失效机制执行，检查 G1 / G2 状态及查询 / 回答。不能用自然语言声称已撤回来替代实际失效。图设置、来源和撤回方式须在首次运行前固定。
6. 每检查点保存 records（提案、版本、安装 / 支持状态）、material（实际发送视图）、answer（实际回答）、sources（已释放原文 / 时间及权限）、events（真实调用、用量、延迟、发布和完成状态）。缺失用量明确 unknown / null，包含失败、重试及取消，不隐式切模型。事件的 pipelineComplete 只能在相应后台 / 查询 / 回答链全部完成后为真。
7. 先保存真实执行证据，再逐条核查断言。审核人检查来源和实际材料，登记理由与位置；model 只能给辅助建议，不能给自己赋 agent / human 身份。开发 Agent 审核不等于真人反馈。失败后保留原运行，不覆盖或删除失败、调整预期或缩小分母；修复后使用另行冻结且未用于修复的新变体。

独立审核存档与选择已接线，真实评测准备及完整门禁未就绪前不启动真实正式留出；现有 live-pilot 和本目录 development 都只运行公开开发案例。formal 的 stub 模式只测试执行与证据，不产生语义成绩。跨语境引用边界已获用户确认：允许明确、有来源的关系，身份与事实依据仍隔离；已通过 references 区分对象指向与事实前提，完整真实语义门禁仍待验收。全阶段门槛见[评测登记](../../../docs/engine/ADAPTIVE_MEMORY_EVAL.md)。

## 回执与评分

每组案例 / 重复使用 `<caseId>/repeat-<1..3>.json`。类型定义见 `score.ts` 的 Receipt：绑定 suiteHash、整个 plan.json 的 planHash、caseId、repeat，标记 live / stub 和 complete / failed / interrupted，包含 artifacts 与 reviews。

Artifact 的 checkpoint 为 `<track>/<step>`，包含五类 surface 之一、内联 data 和 data 的 SHA-256。Review 的 check 为 `<track>/<step>/<check>`，包含结果 pass / fail / unassessed、reviewer、reason、evidence。evidence 指向同检查点 Artifact 和能解析的 JSON Pointer：通过须覆盖断言要求的每种 surface；失败至少指向一种要求的 surface，一处实证错误已经足够失败。来源预期约束仍需审核者检查，不靠指针存在推定内容正确。

评分遍历冻结的全部150组，缺失、损坏、替身和未审核不会减少分母。模型自评记 unassessed；关键不变量、身份安全、无关认识保留和时间 / 证据安全必须零失败且无未审核项。绑定 / 纠正整体至少95%、各适用族至少90%；必需字段至少90%；完整运行至少95%。某族某指标没有断言时为不适用，不伪造分母。安全审核完整性可能比单独的执行完成率更严格，不能用完成率门槛跳过未观测的安全检查。

complete 声明需要每检查点五类材料及 pipelineComplete 事件，否则整份回执无效；failed / interrupted 已取得的有效审核仍可统计，未取得的检查保留分母。CLI 对单个计划限制64 KiB、回执32 MiB，解析文件须为评测目录内的普通文件。汇总只打印分数和安全错误码，不打印原始材料。

**信任边界**：哈希不是签名，JSON Pointer 不是语义证明，live / reviewer / pipelineComplete 是受信运行与审核流程写下的声明。评分器不能阻止伪造整套回执；必须核查原始运行日志和审核 provenance，不能让被测模型生成整份回执后直接作为成绩。测试文件有意构造标 live 的占位回执来测试算术，明确不是正式执行证据或已审核语义。

模型旁路记录现包含实际 ChatRequest.responseSchema（如果有），不能只保存 messages 后漏掉供应商原生约束。Google 提案原生发送 schema，普通对话不启用；其他协议按宿主现有路由准备提示。失败只新增白名单 reason（idle_timeout / content_timeout / cancelled / network / http / protocol），不保存任意异常正文、端点或凭据。旧记录没有 reason 时保持缺失，不追溯猜填；原因分类不改变时限、重试或语义评分。


### 传输失败定位与后台恢复

ADC 回执回调绑定请求发起时的异步上下文。真实旧记忆选择取消曾从另一上下文触发回执，导致模型观察器找不到调用并崩溃；现在外部取消和流结束仍归属原调用，不改变原时限、失败判定或重试。回归使用合成传输，不读取凭据或发起网络请求。

ADC 开发传输现对成功、HTTP 拒绝、异常和取消都生成一次终态回执。除模型版本 / finish / 已收到用量外，记录固定 state、phase（credentials / headers / body）、HTTP status 或 null、凭据完成 / 响应头 / 首字节的相对毫秒数和已收字节数。等待响应头只表示 fetch 尚未返回，不能据此区分 DNS、TLS、网络传输或服务端排队。`complete` 仅表示流结束，实际模型版本与 STOP 仍由运行器独立检查。无计量仍 unknown；部分流的已收到计量只作原始证据，不能冒充完整账单。回执不含 URL、项目、账号、凭据、响应头、异常正文或供应商错误正文；旧回执缺少阶段时不追溯猜填。

`runtime/test/adaptive-background-recovery.test.ts` 单独检验生产后台的持久重试：真实双身体与自动 Git 发布，第一次模型生成由替身注入失败；观察 queued / 退避到期、无提前认识或回执，然后自行第二次生成、一次发布及对端可读。它不修改队列时钟、不手工重排任务、不调用真实模型，不表示外部服务已恢复。公开语义运行器仍在首次失败时停止，本测试不把带失败的语义轨迹改判通过。新测试由既有 test glob 和 tsconfig 包含，传输文件已在开发入口依赖图中，无新增依赖或生产部署配置。


## 严格计划与实际证据入口

```bash
# 必须在干净提交上，创建全新的仓库外目录；不会发起模型调用。
npm run run:adaptive-eval --prefix runtime -- --init "$EVAL_ROOT" stub
# 单个案例 / 重复；各内部轨迹独立新建两具身体，不共享状态。
npm run run:adaptive-eval --prefix runtime -- --run "$EVAL_ROOT" AM-03-H1 1
npm run eval:adaptive --prefix runtime -- --score "$EVAL_ROOT"
```

live 初始化显式将末参数改为 live，执行时必须额外提供 `$PREPARED_PUBLIC_ROOT`，由生产准备器核验固定公开组件；stub 固定词面且不接受该参数。live 固定 Flash 主路由、无强 / 快模型回退，温度和思考均为当前 TypeScript 适配器的供应商默认，不能与 Python 探针的显式思考档混同。其他设置均在 plan.ts 的完整 configuration 中：窗口 / 输出预算、180秒步骤等待、150秒提案墙、90 / 180秒供应商空闲墙、每身体36次调用、首次观察到错误即终止该轨迹、查询历史正常持久化、既有范围隔离、原生结构化提案、后台与检索模式。该默认配置已在 AM-02-H1 首次真实运行，第三步输出截断；不代表此路由已满足质量与延迟要求。

代码清单绑定 engine / runtime 源码、开发执行器、固定组件、依赖锁与配置；开始每个案例前再次核对当前代码、提交和运行环境。历史只读评分允许不同 Node 与归档提案格式摘要，但仍校验归档代码清单及完整计划形状，并核对实际提案请求的 responseSchema 摘要；旧的只有任意 configuration 对象的草稿计划不再被评分入口接受。没有真实旧正式成绩需要迁移。

每个案例的目录为 `<caseId>/run-<重复>/`，只增 started、各轨迹 input / execution / checkpoints / result、finished 或 interrupted；同一运行目录存在时拒绝重跑。一个轨迹失败仍可运行该案例其他独立轨迹，但不向失败轨迹释放后续输入。案例回执 `<caseId>/repeat-N.json` 绑定实际检查点，包含五类内联材料、原始文件字节摘要和空 reviews：records 含前后版本、完整历史、当前支持状态、实际提案及查询；material 是实际发送请求 / context.plan；answer 是真实答复；sources 含已释放输入与实际消息 / 隔离；events 含调用、用量、耗时、队列及发布。失败步骤保留终态快照定位、实际调用和 pipelineComplete=false；无法可靠导出则写 interrupted，不伪造完成材料。只读统计仍保持全部150组分母。

`formal` 退出0只表示本案例工程链路完成、回执可导出；没有自动语义审查，reviews 始终为空。独立审核必须逐条核查来源和实际材料，按下节追加审核结果；运行器不把模型评语转成独立审核。不要手改原始执行材料或用替身通过放行 M2。新增脚本 / TypeScript 入口复用现有 Node 与双身体依赖，不进入 main.cjs，也不新增生产配置。


## 独立审核与显式选择

```bash
npm run review:adaptive-eval --prefix runtime -- --packet "$EVAL_ROOT" AM-03-H1 1
npm run review:adaptive-eval --prefix runtime -- --record "$EVAL_ROOT" AM-03-H1 1 agent "$REVIEW_DRAFT"
# 后续修订在末尾给出前版摘要，旧文件保留；每版仍需覆盖全部断言。
npm run review:adaptive-eval --prefix runtime -- --record "$EVAL_ROOT" AM-03-H1 1 agent "$NEXT_DRAFT" "$PREVIOUS_HASH"
npm run review:adaptive-eval --prefix runtime -- --select "$EVAL_ROOT" audit-v1 "$REVIEW_HASH"
npm run eval:adaptive --prefix runtime -- --score "$EVAL_ROOT" --reviews review-selections/audit-v1.json
```

packet 包含绑定原回执的全部断言、要求的材料类别、可用 artifact 与实际原回执。草稿只接受 `packetHash`、非空 `method` 和 `assessments`；每项仅含 `check`、`result`、`reason`、`evidence`，字段形状同上节 Review，不能自带 reviewer。每版须覆盖全部断言，未核查明确写 unassessed / 空 evidence，不能继承前版 pass。pass / fail 仍须对应检查点和有效证据指针；指针存在不证明语义正确。

`--record` 的 agent / human / model 由受信操作方明确提供，method 说明实际核查方法；这是责任声明，不是身份认证。开发 Agent 不得自称真人；从被测模型得到的评语不能改标签冒充独立核查。纯 model 审核始终不计通过，stub 也不产生语义成绩。原文、引文和模型评语都是待审数据，其中要求改评分规则的文字不是指令。

资料均留在仓库外。原 `repeat-N.json` 永远保持空 reviews；`review-packets/<hash>.json`、`reviews/<hash>.json` 和 `review-selections/<name>.json` 使用只增写入，重复写入拒绝覆盖。修订绑定精确的 packet / receipt / plan / suite，并验证完整 previous 链（最多100版）；旧版被改写或缺失时拒绝采用。选择清单显式列 caseId / repeat / reviewHash，不能重复案例或跨计划。评分不传 `--reviews` 就不采用任何审核；不会寻找“最新”版本，清单错误不会回退旧结论。输出包含 reviewSelectionHash，便于复现选择。

导包、录入、选择及评分均重读原始执行：检查 started / finished、原始回执摘要，并从实际轨迹重新导出材料核对。原始检查点改变，即使另存的回执未变也会拒绝。interrupted 只接受相应中断标记与空材料。归档计划的提案格式摘要另与实际请求核对，避免当前 schema 升级后无法审查旧失败。这些摘要与校验用于发现不一致，不是能抵抗伪造整套运行资料的签名。

入口只供开发评测，不要求产品使用者编辑文件；不调用模型，不进入生产打包。`review:adaptive-eval` 与 tsconfig 已登记，复用现有 Node 能力，无新依赖或部署服务。既有 stub 实际运行已验证两版 agent 审核存档、显式选择和重复写入拒绝，全部20条断言保持未评；这不是正式语义验收。


### M3 开发研究选项

程序入口 `runTrack` 可显式使用 `research:true` 启用正常中心后台研究；等待条件额外核对每个 user / ambient 来源的 `research-v1` 回执及 `research-idle`，避免尚未研究就释放下一步。`backgroundRetries:true` 仅用于开发完整过程，允许既有后台任务自动重试，所有失败调用及尝试数原样保存；包括 queued / running 的 processor_failed 和 interrupted，允许原队列继续处理，后者可能来自版本过期或任务中断。终局 failed / cancelled、截断、前台失败、后台重试耗尽仍停止。旧入口仍禁止两个选项与fullEvidence组合；显式v2输入策略允许fullEvidence与后台恢复，研究仅在empty轨迹开启，受控图仍关闭研究。缺省均关闭，已归档v1行为不改判。

### M3 三基线开发对照

公开八步输入为 [story-development.json](story-development.json)：昵称歧义 → 引语纠正 → 小说素材关联 → 重复提问 → 无关任务 → 新证据修正解释。只含逐步素材和查询，不含预期答案；使用程序入口 `runTrack({track, baseline, ...})`，现有 CLI 的其他三步案例保持不变。真实执行前的判定与配置见[验收文档](../../../docs/engine/ADAPTIVE_MEMORY_ACCEPTANCE.md#m3-小型三基线对照输入与执行边界)。未运行不记为覆盖通过。

`runTrack` 的可选 `baseline` 只支持公开、空库、accessible user 轨迹，不能用于正式证据或受控图。三种模式都将素材经正常 `converse` 摄入，生成回复并保留历史；仅在同步写入时使用合成发言时钟，异步模型与后台等待恢复真实时钟。素材回复及检查点回复的全部调用都计入成本。未设置该参数时保持原有历史导入路径，不能把导入路径关闭学习后的结果称为正常旧 Quetzal。

| baseline | 模型与记忆配置 | 完成检查 |
|---|---|---|
| `legacy` | 新记忆关闭；旧语义选择与 PRIME 学习开启，沿用原预算与超时 | 两身体学习 pending（含100ms启动窗）归零、模型结束、结构化记录及灵魂同步完成；不调用新语义查询作为答案材料 |
| `raw-fts` | M1 来源处理开启；semantic / research 关闭，旧语义选择关闭；保留旧学习配置默认值，由生产 enabled 门禁阻止旧写入 | source-v1 回执齐备；通过既有原文查询 / FTS 读取，不新增检索器 |
| `adaptive` | 现行语义记忆；research 与真实向量按显式参数选择；旧语义选择关闭；保留旧学习配置默认值，由生产 enabled 门禁阻止旧写入 | 保持现有语义处理、研究、向量与发布等待 |

三臂使用独立空灵魂、同输入顺序及主模型，近期历史保持相同规则，工具与学习开关遵循各模式的生产行为：新模式自动接管事实写入，旧模式保留原工具。原文臂不接受向量缓存参数；它是原文＋FTS，不冒充原文向量基线。初始快照及每个检查点保留实际配置、旧结构化记录和普通记忆文档；原文 / 新记忆臂若经工具额外写入旧记忆则停止，不能把混入的能力归功于所选方案。旧方案的选择 / 学习调用单列 purpose，正常超时、截断或失败降级保留记录，不自动判整个对话失败；实际模型身份、用量缺失和最终回答错误仍须核查。调用总预算耗尽仍停止。

legacy 指同一代码版本中关闭新记忆、启用原有记忆路径，不是检出历史发行版；公共对话政策仍相同。新记忆的 research 开关和向量配置必须随结果明确报告，不能把 research=false 的成绩归为研究收益。三种路径已有真实八步运行与独立核读；新记忆初次提前停止、等待修复后单独重跑，失败及版本差异保留。已有收益与语义失败并存，没有逐项零错误或统计优越性成绩；结合后续纵向纠正完成 M3 原型验收，见阶段记录 §5.20。不替代研究开 / 关实验或请求材料的局部消融。复用原 Node、进程与测试入口，无新依赖、服务、生产配置或灵魂格式。


M5新增公开六步输入[m5-contrast-development.json](m5-contrast-development.json)，用于完整候选 / 关闭研究 / 关闭向量 / 原文FTS / 旧记忆五臂开发对照；参数和预登记观察点见[评测登记](../../../docs/engine/ADAPTIVE_MEMORY_EVAL.md#m5-五臂开发对照声音素材设备代指与排期2026-10-29登记)。直接复用runTrack，不新增评分平台、生产配置、依赖或构建入口；数据不含checks，也不进入生产bundle。未运行不能算通过。

后续[m5-temporary-access-development.json](m5-temporary-access-development.json)使用书屋临时入口与两次活动，比较完整候选和原文FTS的实际使用；含两个无关话题，核对窗口内 / 外及再次复用。仍沿用runTrack与既有预算；输入只含发言和问题，不含预期或图种子。配置、观察点和时间局限见同一[评测登记](../../../docs/engine/ADAPTIVE_MEMORY_EVAL.md#m5-临时入口规则的完整使用对照2026-10-29登记)，不是新增正式门槛。

分页向量索引的开发检查点不再把最后批次摘要当作全库摘要。身体用只读candidatePage枚举当时有效的id/key，并在独立SQLite只读事务取得worker的清单与epoch/seq；结果保存为retrievalInventory。等待与回执验证要求两侧逐项一致、扫描完成、宿主current及pending为零，未就绪不能计完成。旧无该字段的档案仍按原snapshot口径重算，不改旧成绩。此枚举仅用于有界开发取证，不进入生产全局索引维护或模型提示；原case计数/审核规则不变。

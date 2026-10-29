# 集中记忆的本机检索组件

固定清单与锁由 `src/memory/adaptive-vector.ts`、开发探针共同读取。Transformers.js 3.8.1 提供 E5 的本机 ONNX 推理，避免每次查询经过远端嵌入请求；不将该原生依赖安装到所有身体。模型来源、固定提交、MIT 许可与实验说明见[组件记录](../../../docs/engine/ADAPTIVE_MEMORY_COMPONENTS.md#72-本机模型持久向量与真实宿主接线)。npm 安装保留依赖包自带许可，模型权重不随仓库或 main.cjs 分发。

`package-lock.json` 是标准相对路径的完整78包锁。必须在目标组件目录中运行 `npm ci --ignore-scripts`，不能生成带临时目录前缀的锁；不得将依赖目录、模型或 SQLite 缓存提交。`model.json` 固定五个文件的大小和 SHA256 / Git blob。

中心通过 `adaptive-component.ts` 自动在 `QUETZAL_HOME/data/adaptive-retrieval/component` 中准备组件；worker 每次启动核对锁、实际库版本及所有模型文件，禁止推理时自动联网取模型。派生缓存位于同级 agent 摘要命名的 SQLite 文件，由 worker 独占，不是灵魂权威。空间摘要包含锁、模型提交、输入格式、维数、归一化和分块策略。

准备过程复用现有 Node / npm，以空用户与全局 npm 配置、固定 registry / 锁和禁用安装脚本执行 npm ci；不继承 npm 凭据或 NODE_OPTIONS。npm 缓存位于同级 npm-cache，dependencies.json 绑定组件版本、平台 / 架构及 Node ABI；prepared.json 只在所有模型校验通过后原子写入。下载保留 .part，严格核对 Range / 总大小与摘要；已完成依赖不会因模型下载失败被重复安装。准备 / 依赖加载失败以30秒至10分钟退避，停止会取消下载及 npm 子进程树；记录仍存活的 npm.pid 时不启动第二个安装。

SQLite quick_check / 表结构确认损坏时保留 .damaged-* 现场再重建，不把 busy、权限或磁盘故障当成损坏。索引暂时失败按2至60秒退避；分块超限明确 blocked，不循环计算。正常关闭仍等待原生推理结束。真实中心部署、取消补做与上述恢复路径已实测；全冷网络与跨平台分发 / 许可打包、完整多身体验收仍需完成。开发命令仅用于工程验证，使用者不需要手动准备组件。


## 增量维护与工程验证

宿主按页递交upsert / remove，每批最多16个变更项加16个扫描项、4MiB；超出字节或500ms读取预算时缩页重试，不消费失败页。最小页仍可能包含两个通道各一项，若仍超时保留错误，不能承诺所有闭包都能处理。来源变更沿依赖分批传播，保留单调票据去环；即使node / mention本身没有向量候选，也继续传播。扫描保留独立份额，完整扫过后才清退本轮未遇到的旧条目，不默认淘汰历史。

worker将清单、进度、待嵌入状态保存在同一派生SQLite，按epoch / seq确认已提交批次；ACK丢失重发相同批次，新来源票据不被旧ACK消费。current表示已确认已知变更及完整扫描，pending / blocked仍分别查看。snapshot是最后批次摘要，不是全库摘要。新增vector_catalog / meta / counts表与事务内计数触发器，不改模型空间及既有向量格式；表损坏按原规则保留现场并重建，正常重启复用已持久向量。

查询在独立只读SQLite快照逐页扫描已索引向量，内存只保留当前文档、查询向量和最多1000个TopK候选；扫描未结束或超时返回降级，不把局部结果冒充全局近邻。100ms向量等待和500ms宿主预算不变，词面退路与最终来源 / 版本核查继续生效。这解除全局1000候选限制，但仍是线性扫描，并不证明任意规模延迟；未完成嵌入也不代表全历史已覆盖。嵌入提交遇暂时写锁保留pending并退避；批次清单写入遇锁仍走失败后自动重建组件路径，不声称所有故障均原地重试。

`runtime/test/adaptive-vector.test.ts`使用实际固定E5和正式worker。无组件路径时显式skip，不能计为真实模型验证；有路径时验证分页确认、缓存保留 / 损坏重算、写锁重试、连续更新下长材料完成、在途撤回与重启。`adaptive-retrieval-capacity.test.ts`另覆盖宿主跨过1000条、来源变更及ACK丢失恢复。容量部分预种合成单位向量以隔离缓存维护，查询和新增材料使用实际E5；不是语义质量或全量真实文档建索引评测。

```bash
# 开发验证；指向仓库外已由正式准备器安装的固定组件，不在测试中下载。
QUETZAL_TEST_VECTOR_COMPONENT="$COMPONENT_ROOT" node --experimental-strip-types --test runtime/test/adaptive-vector.test.ts
```

此环境变量只由测试文件读取，不是产品配置；现有测试glob / TypeScript include覆盖，依赖锁与构建入口不变，使用者不需要执行这些命令。

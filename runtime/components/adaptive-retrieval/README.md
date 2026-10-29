# 集中记忆的本机检索组件

固定清单与锁由 `src/memory/adaptive-vector.ts`、开发探针共同读取。Transformers.js 3.8.1 提供 E5 的本机 ONNX 推理，避免每次查询经过远端嵌入请求；不将该原生依赖安装到所有身体。模型来源、固定提交、MIT 许可与实验说明见[组件记录](../../../docs/engine/ADAPTIVE_MEMORY_COMPONENTS.md#72-本机模型持久向量与真实宿主接线)。npm 安装保留依赖包自带许可，模型权重不随仓库或 main.cjs 分发。

`package-lock.json` 是标准相对路径的完整78包锁。必须在目标组件目录中运行 `npm ci --ignore-scripts`，不能生成带临时目录前缀的锁；不得将依赖目录、模型或 SQLite 缓存提交。`model.json` 固定五个文件的大小和 SHA256 / Git blob。

中心通过 `adaptive-component.ts` 自动在 `QUETZAL_HOME/data/adaptive-retrieval/component` 中准备组件；worker 每次启动核对锁、实际库版本及所有模型文件，禁止推理时自动联网取模型。派生缓存位于同级 agent 摘要命名的 SQLite 文件，由 worker 独占，不是灵魂权威。空间摘要包含锁、模型提交、输入格式、维数、归一化和分块策略。

准备过程复用现有 Node / npm，以空用户与全局 npm 配置、固定 registry / 锁和禁用安装脚本执行 npm ci；不继承 npm 凭据或 NODE_OPTIONS。npm 缓存位于同级 npm-cache，dependencies.json 绑定组件版本、平台 / 架构及 Node ABI；prepared.json 只在所有模型校验通过后原子写入。下载保留 .part，严格核对 Range / 总大小与摘要；已完成依赖不会因模型下载失败被重复安装。准备 / 依赖加载失败以30秒至10分钟退避，停止会取消下载及 npm 子进程树；记录仍存活的 npm.pid 时不启动第二个安装。

SQLite quick_check / 表结构确认损坏时保留 .damaged-* 现场再重建，不把 busy、权限或磁盘故障当成损坏。索引暂时失败按2至60秒退避；分块超限明确 blocked，不循环计算。正常关闭仍等待原生推理结束。真实中心部署、取消补做与上述恢复路径已实测；全冷网络与跨平台分发 / 许可打包、完整多身体验收仍需完成。开发命令仅用于工程验证，使用者不需要手动准备组件。


## 增量维护与工程验证

宿主候选接口仍接收完整列表，当前最多1000条 / 8MiB；AdaptiveVectorRetriever按内容摘要生成内部update的upsert / remove，以base与snapshot串行确认，同一时刻一批在途，未确认时合并后续列表。首份候选未到达前不把“尚未知道”当空快照清除缓存；明确空列表仍删除当前条目。current仅表示worker已接受该候选快照，pending / blocked须分别查看，不代表所有嵌入完成。

worker启动时流式枚举已有key并删除非当前缓存；正常增量只点读新增key，核查向量形状和摘要，删除撤回key。缓存仍按agent / 模型空间隔离，无新表或空间迁移。每个在途文档绑定自身候选对象，无关更新不从头计算；移除再加入时旧计算不能写回。失败沿用现有退避与blocked规则；重启由已持久向量恢复，未完成文档从头分块。查询算法本轮不改，依旧全内存向量与全扫描排序；宿主候选生成也未改分页，规模工作继续。

`runtime/test/adaptive-vector.test.ts`使用实际固定E5和正式worker。无组件路径时显式skip，不能计为真实模型验证；有路径时验证增量消息、缓存保留 / 损坏重算、连续更新下长材料完成、在途撤回与重启。仅用少量合成单位向量隔离缓存维护成本，其余新增材料调用真实E5；这不是语义质量评测。

```bash
# 开发验证；指向仓库外已由正式准备器安装的固定组件，不在测试中下载。
QUETZAL_TEST_VECTOR_COMPONENT="$COMPONENT_ROOT" node --experimental-strip-types --test runtime/test/adaptive-vector.test.ts
```

此环境变量只由测试文件读取，不是产品配置；现有测试glob / TypeScript include覆盖，依赖锁与构建入口不变，使用者不需要执行这些命令。

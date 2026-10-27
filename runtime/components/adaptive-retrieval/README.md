# 集中记忆的本机检索组件

固定清单与锁由 `src/memory/adaptive-vector.ts`、开发探针共同读取。Transformers.js 3.8.1 提供 E5 的本机 ONNX 推理，避免每次查询经过远端嵌入请求；不将该原生依赖安装到所有身体。模型来源、固定提交、MIT 许可与实验说明见[组件记录](../../../docs/engine/ADAPTIVE_MEMORY_COMPONENTS.md#72-本机模型持久向量与真实宿主接线)。npm 安装保留依赖包自带许可，模型权重不随仓库或 main.cjs 分发。

`package-lock.json` 是标准相对路径的完整78包锁。必须在目标组件目录中运行 `npm ci --ignore-scripts`，不能生成带临时目录前缀的锁；不得将依赖目录、模型或 SQLite 缓存提交。`model.json` 固定五个文件的大小和 SHA256 / Git blob。

中心通过 `adaptive-component.ts` 自动在 `QUETZAL_HOME/data/adaptive-retrieval/component` 中准备组件；worker 每次启动核对锁、实际库版本及所有模型文件，禁止推理时自动联网取模型。派生缓存位于同级 agent 摘要命名的 SQLite 文件，由 worker 独占，不是灵魂权威。空间摘要包含锁、模型提交、输入格式、维数、归一化和分块策略。

准备过程复用现有 Node / npm，以空用户与全局 npm 配置、固定 registry / 锁和禁用安装脚本执行 npm ci；不继承 npm 凭据或 NODE_OPTIONS。npm 缓存位于同级 npm-cache，dependencies.json 绑定组件版本、平台 / 架构及 Node ABI；prepared.json 只在所有模型校验通过后原子写入。下载保留 .part，严格核对 Range / 总大小与摘要；已完成依赖不会因模型下载失败被重复安装。准备 / 依赖加载失败以30秒至10分钟退避，停止会取消下载及 npm 子进程树；记录仍存活的 npm.pid 时不启动第二个安装。

SQLite quick_check / 表结构确认损坏时保留 .damaged-* 现场再重建，不把 busy、权限或磁盘故障当成损坏。索引暂时失败按2至60秒退避；分块超限明确 blocked，不循环计算。正常关闭仍等待原生推理结束。真实中心部署、取消补做与上述恢复路径已实测；全冷网络与跨平台分发 / 许可打包、完整多身体验收仍需完成。开发命令仅用于工程验证，使用者不需要手动准备组件。

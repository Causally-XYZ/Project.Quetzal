# 集中记忆的本机检索组件

固定清单与锁由 `src/memory/adaptive-vector.ts`、开发探针共同读取。Transformers.js 3.8.1 提供 E5 的本机 ONNX 推理，避免每次查询经过远端嵌入请求；不将该原生依赖安装到所有身体。模型来源、固定提交、MIT 许可与实验说明见[组件记录](../../../docs/engine/ADAPTIVE_MEMORY_COMPONENTS.md#72-本机模型持久向量与真实宿主接线)。npm 安装保留依赖包自带许可，模型权重不随仓库或 main.cjs 分发。

`package-lock.json` 是标准相对路径的完整78包锁。必须在目标组件目录中运行 `npm ci --ignore-scripts`，不能生成带临时目录前缀的锁；不得将依赖目录、模型或 SQLite 缓存提交。`model.json` 固定五个文件的大小和 SHA256 / Git blob。

中心读取 `QUETZAL_HOME/data/adaptive-retrieval/component` 中已准备的组件；worker 每次启动核对锁、实际库版本及所有模型文件，禁止推理时自动联网取模型。派生缓存位于同级 agent 摘要命名的 SQLite 文件，由 worker 独占，不是灵魂权威。空间摘要包含锁、模型提交、输入格式、维数、归一化和分块策略。

目前自动加载、后台增量索引、关闭与重启路径已实现；**首次自动安装 / 下载仍待接线**。开发准备命令仅供工程验证，不能当作产品使用步骤。整库损坏恢复、跨平台分发 / 许可打包以及完整多身体验收仍需完成。

# 多语言候选召回开发实验

用途：对照 Quetzal 的实际 `engine/src/retrieval.ts` 词面排序、本机多语言嵌入与固定 Graphiti 的 RRF 融合。仅使用本目录公开合成的30段材料 / 15个问题，不读取真实灵魂、数据库、ADC 或冻结留出集，不调用生成式 LLM。

这是组件实验，**没有接入生产认识查询**。目标是先测清改述召回及代价，再决定生产适配；不是使用者需要操作的安装步骤，不代表产品部署已完成。

## 固定组件

- `@huggingface/transformers` 3.8.1：独立 package / lock，不加入 runtime 生产依赖。ONNX Runtime 由该包依赖提供，CPU、量化 q8、单线程；不执行 npm 安装脚本。只验证本机环境，不推断所有平台均可直接部署。
- [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78)：固定提交 `761b726dd34fb83930e26aab4e9ac3899aa1fa78`，权重118308185字节；`model.json` 记录配置 / 词表 Git blob 或 LFS SHA256，下载和推理前均核对。
- 原始模型 [intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small)：MIT；依官方检索用法，查询加 `query: `，文档加 `passage: `，mean pooling 并归一化，384维。固定词表配置最多512 token，FeatureExtractionPipeline 内部自动截断；脚本另外验证长输入截断，不误称完整读取。
- [Graphiti RRF](https://github.com/getzep/graphiti/blob/2b5db9e139b2627c3ba18ff55f9181569b0d8224/graphiti_core/search/search_utils.py)：Apache-2.0，`fuse.py` 复用既有探针先核对 HEAD 与源文件 Git blob，再原样执行该函数 AST，不复制整个检索器。分别测默认常数1和显式常数60，未按案例结果调参；各通路先取6个候选再融合。实际排名使用 runtime 的 TypeScript 适配副本，并逐项与原始 Python 结果核对。

依赖、下载权重与结果全部放仓库外；没有把模型文件或上游服务加入 main.cjs。包与权重的生产分发、许可打包仍须在采用时单独接线。

## 复跑

先准备上游固定 clone（见全局[组件记录](../../../docs/engine/ADAPTIVE_MEMORY_COMPONENTS.md)），`OSS_ROOT` 下有 `graphiti/`，不要求安装 Graphiti 本身。

```bash
# 从仓库根运行；Node 24、Python 3.12+、curl
PROBE_ROOT=$(mktemp -d)
cp runtime/tool/adaptive-retrieval-probe/package*.json "$PROBE_ROOT/"
npm ci --prefix "$PROBE_ROOT" --ignore-scripts --no-audit --no-fund
python3 -B runtime/tool/adaptive-retrieval-probe/prepare.py "$PROBE_ROOT"
node runtime/tool/adaptive-retrieval-probe/run.mjs "$PROBE_ROOT" "$OSS_ROOT"

# 不安装依赖 / 不下载模型也可先保存真实词面基线
node runtime/tool/adaptive-retrieval-probe/run.mjs "$PROBE_ROOT" --lexical-only

# 无模型的203组固定输入：对照上游 RRF 与实际 TypeScript 副本
node runtime/tool/adaptive-retrieval-probe/run.mjs "$PROBE_ROOT" "$OSS_ROOT" --fusion-only
```

准备阶段仅下载固定公开文件；传输中断、超长或摘要不符均失败，中断的部分文件保留供续传，摘要不符的部分文件清除；已经核对的完整文件可复用。推理阶段禁止 Transformers.js 远程模型加载，核对工作目录与版本锁；重复运行会新建报告，不覆盖旧证据。网络不可用时不会自动改换模型。

## 测量与解释

- 14个有相关材料问题，另有1个无关问题。主题包括改述、跨语言、指代歧义、纠正引语、现实对虚构的讨论、先后变化、关系结束、家庭冲突和证词矛盾。
- 报告保留全部排名 / 分数、输入和源码摘要、完整45次查询耗时（每题3次），并报告 hit@1/3/6 与按问题平均的 recall。`relevant` 只表示应找回的候选，不是正确答案；例如四月在职与五月离职均需找回后按时间解释。
- 名称与语境相近的材料是干扰项；相似度不能消歧、证明事实或替代来源权限。尚无经过校准的零命中阈值，无关问题也会有向量近邻，必须保留该反例。
- 本机读取权重的耗时不含下载，也不是磁盘冷缓存。查询 P95 只有45个短合成样本，不是端到端首字延迟 / 多身体性能门禁。另记事件循环最大延迟和进程峰值 RSS，帮助判断是否需要独立 worker。
- 文档标题为公开夹具标签，正文为短材料；调用的是实际词面函数，但不是生产候选构造、支持链和RPC的完整路径。没有验证生产索引增量更新、删除 / 修正失效、长文分块、备份重建和自动安装。

生产适配必须保留：仅将当前可访问、共同支持链成立的认识作为候选；每个分块绑定内容与版本；查询等待和计算不占灵魂写锁；模型未就绪 / 超时退回现有同门禁词面路径；返回前再核对来源；向量索引可删除重建，不成为记忆权威。不通过组件和宿主验收，不能宣称已修复 M2 改述召回。


## 独立的 GCP 嵌入对照

`vertex.py` 复用既有 ADC 凭据读取和可选 HTTP/1.1 传输，仅在 `--live` 时调用 [gemini-embedding-001 的 predict 接口](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/text-embeddings-api)。每个请求一个输入，768维，分别指定 RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY，关闭自动截断；宿主再显式 L2 归一化。固定 us-central1，实际响应未给模型版本时报告 null，不伪造已锁定后端版本。

```bash
# GCLOUD_BIN 如有需要指向已有 gcloud；不执行登录，不把凭据写入文件
python3 -B runtime/tool/adaptive-retrieval-probe/vertex.py "$PROBE_ROOT" --live
# 独立传输对照：新结果文件，不覆盖或自动重试原失败
QUETZAL_VERTEX_TRANSPORT=curl python3 -B runtime/tool/adaptive-retrieval-probe/vertex.py "$PROBE_ROOT" --live
# 完整报告路径来自上一条命令；只读评分，不再联网
node runtime/tool/adaptive-retrieval-probe/run.mjs "$PROBE_ROOT" "$OSS_ROOT" --vertex "$VERTEX_REPORT"
```

最多75次请求：30个文档最多4路并行，15个问题逐个运行三遍；首次失败取消尚未开始的请求，等待并记录已在运行的请求，无自动重试。每次结束保存结果，失败也保留；缺失用量为 null。只有完整报告、夹具 / 生产脚本摘要一致、完整逐项成功且无截断才计算对照。报告保存公开合成向量、白名单用量 / 失败信息，不保存凭据、项目标识、请求 URL 或供应商错误正文。

该路线与本机开源模型分开评测，不是默认替换。本机 E5 和 Gemini 的向量空间不同，不能将一方文档向量与另一方查询向量混用；未来索引必须绑定模型空间、输入格式和候选版本。网络查询延迟超过前台预算时，不能用降低门槛或隐藏额外等待来宣称接入成功。

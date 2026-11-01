# 开发仓库与上游同步

Quetzal 当前采用“探索开发仓库 + 最终上游仓库”的协作方式。工作分支上的实验、验证和收敛在探索仓库中进行；形成可合并成果后，再汇总到上游仓库。

## 远程角色

| 远程 | 地址 | 作用 |
|---|---|---|
| `origin` | [`Causally-XYZ/Project.Quetzal`](https://github.com/Causally-XYZ/Project.Quetzal) | 当前探索开发仓库，保存工作分支和阶段性成果 |
| `upstream` | [`PlutoKeating/Project.Quetzal`](https://github.com/PlutoKeating/Project.Quetzal) | Quetzal 的最终上游仓库，收敛后的成果汇总到这里 |

不要把 `origin` 的探索分支当成已经进入上游的正式版本，也不要把上游仓库误解成另一个独立来源项目。检查来源更新时，以 `upstream` 为准；检查当前探索成果时，同时查看 `origin` 的对应分支。

## 分支工作流

1. 在 `origin` 上创建或继续 `feature/<name>` 探索分支。
2. 定期拉取并合并 `upstream/main`，让探索分支吸收上游已经收敛的公共变更。
3. 在探索分支完成实现、验证和文档整理。
4. 方案收敛后，由维护者审查并把成果汇总到 `upstream/main`；是否推送、采用何种合并方式以及目标分支，遵循仓库的人工授权规则。

`feature/adaptive-memory` 的提交 `4030282` 是这一流程的实例：它以自适应记忆探索提交为一条父线，同时合并了 `upstream/main` 的 `05f7ab7`，保留探索成果并吸收上游更新。

## 检查远程状态

```bash
git fetch upstream
git status -sb
git log --graph --decorate --oneline --all
git log HEAD..upstream/main --oneline
```

`HEAD..upstream/main` 没有输出表示当前工作分支已经包含上游 `main` 的提交；这不代表探索分支已经汇总回上游。汇总前仍需完成代码、测试、文档和变更范围检查。

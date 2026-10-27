# Graphiti 提示词适配声明

Copyright 2024, Zep Software, Inc.

来源：[Graphiti 2b5db9e139b2627c3ba18ff55f9181569b0d8224](https://github.com/getzep/graphiti/tree/2b5db9e139b2627c3ba18ff55f9181569b0d8224)，Apache-2.0，许可证见同目录 LICENSE。

`runtime/src/memory/prompts/adaptive-graphiti.ts` 改编自 `graphiti_core/prompts/extract_nodes.py` 的对象限定 / 命名规则和 `graphiti_core/prompts/extract_edges.py` 的事实抽取 / 时间规则。修改：输出改为 Quetzal 提案；保留 mention 歧义和独立陈述；不用名称直接归并；日期不补虚假精度；区分事件发生时间与状态有效期；增加版本纠正、语境和引用约束。

本副本只复用抽取提示词规则，不包含 Graphiti 数据库、检索器、归并器或完整运行服务，不宣称具有整个项目的能力。原源码文件包含版权与许可证声明；固定提交根目录未提供单独 NOTICE 文件。

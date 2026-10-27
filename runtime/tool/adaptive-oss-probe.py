"""固定上游源码的边界实验；只运行纯函数 / 指定方法，不安装或冒充完整服务。

用法：python3 runtime/tool/adaptive-oss-probe.py <仓库外的 clone 父目录>
父目录须包含 graphiti 与 a-mem，提交见 PIN。仅合成资料，无网络 / 模型调用。
"""
from __future__ import annotations

import ast
import json
import logging
import subprocess
import sys
import types
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PIN = {
    "graphiti": "2b5db9e139b2627c3ba18ff55f9181569b0d8224",
    "a-mem": "ceffb860f0712bbae97b184d440df62bc910ca8d",
}


def checked_source(root: Path, project: str, relative: str) -> str:
    repo = root / project
    def git(*args: str) -> bytes:
        return subprocess.check_output(["git", "-C", str(repo), *args])
    if git("rev-parse", "HEAD").decode().strip() != PIN[project]:
        raise ValueError(f"{project}: 上游提交不符")
    original = git("show", f"HEAD:{relative}")
    if (repo / relative).read_bytes() != original:
        raise ValueError(f"{project}: 待执行源码被修改")
    return original.decode()


def graphiti_probe(root: Path) -> list[dict]:
    # 这个模块运行时只依赖标准库；EntityNode 仅为 TYPE_CHECKING 注解。
    rel = "graphiti_core/utils/maintenance/dedup_helpers.py"
    source = checked_source(root, "graphiti", rel)
    mod = types.ModuleType("quetzal_graphiti_dedup_probe")
    sys.modules[mod.__name__] = mod  # dataclass 需要模块登记
    exec(compile(source, rel, "exec"), mod.__dict__)

    def node(uid: str, name: str, **attributes: Any) -> types.SimpleNamespace:
        return types.SimpleNamespace(uuid=uid, name=name, labels=["Entity", "Person"],
                                     attributes=attributes, created_at=datetime(2026, 1, 1))

    def resolve(extracted: Any, candidates: list) -> Any:
        state = mod.DedupResolutionState([None], {}, [])
        mod._resolve_with_similarity([extracted], mod._build_candidate_indexes(candidates), state)
        return state

    # 新人和旧人同昵称：只要候选里恰好一个同名，默认确定性路径会归并。
    editor = node("editor", "阿舟", occupation="编辑")
    brother = node("brother", "阿舟", occupation="工程师")
    result = resolve(brother, [editor])
    assert result.uuid_map == {"brother": "editor"}
    assert editor.attributes["occupation"] == "工程师"

    # 候选里已经有两个同名人时，确定性路径保留待 LLM 处理。
    result = resolve(node("mention", "阿舟"), [node("editor", "阿舟"), node("brother", "阿舟")])
    assert result.unresolved_indices == [0] and result.uuid_map == {}

    # ASCII 模糊归一化不保留中文；不等于 Graphiti 的向量检索也不支持中文。
    assert mod._normalize_name_for_fuzzy("周泽") == ""
    assert mod._normalize_name_for_fuzzy("周宇") == ""
    result = resolve(node("mention", "小周"), [node("editor", "周泽")])
    assert result.unresolved_indices == [0]
    return [
        {"case": "graphiti-single-name", "observed": "同昵称单候选被归并，非空属性覆盖"},
        {"case": "graphiti-multiple-names", "observed": "多候选交给后续 LLM；本实验未运行该调用"},
        {"case": "graphiti-chinese-fuzzy", "observed": "中文不进入 ASCII 模糊名称路径，保留 unresolved"},
    ]


def amem_probe(root: Path) -> list[dict]:
    rel = "agentic_memory/memory_system.py"
    tree = ast.parse(checked_source(root, "a-mem", rel), rel)
    classes = {x.name: x for x in tree.body if isinstance(x, ast.ClassDef)}
    # 保留上游方法 AST 原样，仅去掉重量级 import、初始化与其他未执行方法。
    # 检索器 / LLM 是明确的故障注入替身；不代表 Chroma 的事务或模型质量。
    selected = [classes["MemoryNote"]]
    methods = [x for x in classes["AgenticMemorySystem"].body
               if isinstance(x, ast.FunctionDef) and x.name in {"update", "delete", "process_memory"}]
    selected.append(ast.ClassDef(name="AgenticMemorySystem", bases=[], keywords=[], body=methods,
                                 decorator_list=[], type_params=[]))
    module = ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[]))
    scope = dict(globals(), logger=logging.getLogger("amem-probe"))
    exec(compile(module, rel, "exec"), scope)
    Note, System = scope["MemoryNote"], scope["AgenticMemorySystem"]

    class Retriever:
        def __init__(self):
            self.documents = {"dinner": "阿舟说不想回家"}
            self.fail_add = False
        def delete_document(self, doc_id):
            self.documents.pop(doc_id, None)
        def add_document(self, *, document, metadata, doc_id):
            if self.fail_add:
                raise RuntimeError("injected-add-failure")
            self.documents[doc_id] = document

    system = System()
    note = Note("阿舟说不想回家", id="dinner", context="编辑的近况")
    system.memories = {"dinner": note}
    system.retriever = Retriever()
    assert system.update("dinner", context="弟弟的近况")
    assert note.context == "弟弟的近况" and note.evolution_history == []

    system.retriever.fail_add = True
    try:
        system.update("dinner", content="那次是我弟弟说的")
    except RuntimeError as error:
        assert str(error) == "injected-add-failure"
    else:
        raise AssertionError("故障注入未到达上游 add_document")
    assert note.content == "那次是我弟弟说的"
    assert "dinner" not in system.retriever.documents

    # 后台 evolution 的上下文与连接由 LLM 建议；原方法直接应用，无来源依赖门禁。
    response = {"should_evolve": True, "actions": ["strengthen", "update_neighbor"],
                "suggested_connections": ["dinner", "missing-note"], "tags_to_update": ["家庭"],
                "new_context_neighborhood": ["弟弟的近况"], "new_tags_neighborhood": [["家庭"]]}
    system._evolution_system_prompt = "{content} {nearest_neighbors_memories}"
    system.find_related_memories = lambda content, k: ("合成邻居", [0])
    system.llm_controller = types.SimpleNamespace(llm=types.SimpleNamespace(
        get_completion=lambda *a, **kw: json.dumps(response)))
    incoming = Note("后来纠正那次指代", id="correction")
    evolved, returned = system.process_memory(incoming)
    assert evolved and returned is incoming
    assert incoming.links == ["dinner", "missing-note"] and incoming.tags == ["家庭"]
    assert note.context == "弟弟的近况" and note.tags == ["家庭"]
    assert note.evolution_history == []
    assert system.delete("dinner") and incoming.links == ["dinner", "missing-note"]
    return [
        {"case": "amem-update-history", "observed": "update 原地更新，没有自动追加演变历史"},
        {"case": "amem-update-failure", "observed": "删除索引后写入失败，内存已修改且索引未恢复"},
        {"case": "amem-evolution", "observed": "原方法应用建议标签、邻居上下文及不存在的连接"},
    ]


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    root = Path(sys.argv[1]).resolve()
    results = graphiti_probe(root) + amem_probe(root)
    print(json.dumps({"schema": "quetzal-oss-probe-v1", "commits": PIN,
                      "scope": "纯函数/原方法执行；假检索器、假 LLM；非完整服务验收",
                      "checks": len(results), "results": results}, ensure_ascii=False, indent=2))

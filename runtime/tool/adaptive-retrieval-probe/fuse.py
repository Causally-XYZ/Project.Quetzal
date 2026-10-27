"""执行固定上游原始 RRF 函数；不是完整 Graphiti 检索服务。"""
import ast
from collections import defaultdict
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('oss_probe', Path(__file__).resolve().parents[1] / 'adaptive-oss-probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
source = probe.checked_source(Path(sys.argv[1]), 'graphiti', 'graphiti_core/search/search_utils.py')
function = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'rrf')
module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
namespace = {'defaultdict': defaultdict}
exec(compile(module, 'graphiti/search_utils.py:rrf', 'exec'), namespace)
rows = json.load(sys.stdin)
print(json.dumps([{str(k): namespace['rrf'](row, rank_const=k) for k in [1, 60]} for row in rows]))

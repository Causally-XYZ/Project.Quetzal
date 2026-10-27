// 改编自 Graphiti 2b5db9e 的 search_utils.py:rrf；Apache-2.0，版权和修改说明见 third_party/graphiti/NOTICE.md。
// 仅合并候选次序；不做来源准入、身份绑定或事实判断。
export function reciprocalRankFusion(rankings: readonly (readonly string[])[], rankConstant = 1): { key: string; score: number }[] {
  if (!Number.isFinite(rankConstant) || rankConstant < 1) throw new Error('排序融合常数不合法');
  const scores = new Map<string, number>();
  for (const ranking of rankings) ranking.forEach((key, index) => {
    scores.set(key, (scores.get(key) ?? 0) + 1 / (index + rankConstant));
  });
  return [...scores].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score);
}

// Copyright 2024, Zep Software, Inc. Licensed under Apache-2.0.
// 改编自 Graphiti extract_nodes.py / extract_edges.py，固定来源、修改说明和许可证见 ../../../third_party/graphiti/。
// Quetzal 修改：保留歧义、单对象陈述和时间不确定性，不沿用默认名称归并或补零时刻。
export const GRAPHITI_EXTRACTION_RULES = `
Extract entities and relationships explicitly mentioned in the CURRENT MESSAGE.
You may use PREVIOUS MESSAGES only to disambiguate references or support continuity.
Only extract facts clearly stated or unambiguously implied in the CURRENT MESSAGE.
Be explicit and unambiguous in naming entities; use full names when available.
When a named person refers to a relative, pet, or associate, qualify the entity with the possessor.
Preserve all specific details: proper nouns, quantities, colors, materials, physical descriptions,
items and named activities. Paraphrase sentence structure but never generalize away specific details.
Do not emit semantically redundant facts. A later statement adding specific details is not just a duplicate.
Use each episode's timestamp to resolve temporal references within that episode.
Do not hallucinate or infer temporal bounds from unrelated events.
Future occurrence dates and deadlines belong in the event description, not automatically in a state's end time.
Use a future date as a state's end only if the state is said to end then.
Leave temporal fields null when no explicit or resolvable time is stated.

Quetzal adaptations take precedence:
- Preserve each meaningful pronoun, nickname, abbreviation and description as a mention, including unresolved ones.
- Names are labels, not identity keys. Do not merge people merely because names match.
- A claim may involve one or several participants. Open labels and topics are allowed; do not require a fixed ontology.
- A story, a hypothetical situation and reality have separate realms. Narrated first person need not mean the real user.
- Hearing a story does not establish whether its events are real or fictional. Preserve an unknown narrative realm unless the source identifies its status. Later using material in a novel does not retroactively make the original story fictional or its characters identical to novel characters.
- Do not manufacture midnight or January 1 from a partial date. Preserve original time wording; uncertain UTC bounds stay null.
- Distinguish an actual change over time from a correction of an earlier report; the latest sentence does not overwrite all history.
- Repetition or a model's own summary is not independent confirmation. Preserve reported / inferred / hypothesis nature.
`;

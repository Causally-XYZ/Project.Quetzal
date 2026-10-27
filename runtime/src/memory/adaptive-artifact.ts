// 持久结果的传输信封；不判断 payload 的语义，更不把发布等同于事实确认。
import crypto from 'node:crypto';
export const ARTIFACT_FORMAT = 'quetzal-adaptive-result-v2';
export const LEGACY_ARTIFACT_FORMAT = 'quetzal-adaptive-result-v1';
export const artifactFormat = (value: unknown) => value === ARTIFACT_FORMAT || value === LEGACY_ARTIFACT_FORMAT;
export const ARTIFACT_BYTES = 256 * 1024;
export const ARTIFACT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface ArtifactInput { id: number; revision: number; hash: string }
export interface ArtifactPayload { schema: string; data: unknown }
export interface MemoryArtifact {
  format: typeof ARTIFACT_FORMAT | typeof LEGACY_ARTIFACT_FORMAT; id: string; agent: string; processor: string; createdAt: number;
  inputs: ArtifactInput[]; payload: ArtifactPayload;
}
export function validateArtifact(value: unknown): asserts value is MemoryArtifact {
  if (!value || typeof value !== 'object') throw new Error('记忆结果信封不合法');
  const a = value as MemoryArtifact;
  if (!artifactFormat(a.format) || typeof a.id !== 'string' || !ARTIFACT_ID.test(a.id) || typeof a.agent !== 'string' || !a.agent || a.agent.length > 200 ||
      typeof a.processor !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(a.processor) ||
      !Number.isSafeInteger(a.createdAt) || a.createdAt < 0 || !Array.isArray(a.inputs) || !a.inputs.length || a.inputs.length > 100 ||
      !a.payload || typeof a.payload.schema !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(a.payload.schema) || a.payload.data === undefined) throw new Error('记忆结果信封版本或字段不合法');
  // 新语义不能藏在旧外层信封内，否则旧宿主会跳过不认识的 payload 后继续使用旧图。
  if (a.format === LEGACY_ARTIFACT_FORMAT && a.payload.schema.startsWith('quetzal-adaptive-semantic-') &&
      a.payload.schema !== 'quetzal-adaptive-semantic-v1') throw new Error('新认识必须使用新版结果信封');
  const ids = new Set<number>();
  for (const i of a.inputs) {
    if (!i || !Number.isSafeInteger(i.id) || i.id < 1 || !Number.isSafeInteger(i.revision) || i.revision < 1 ||
        typeof i.hash !== 'string' || !/^[a-f0-9]{64}$/.test(i.hash) || ids.has(i.id)) throw new Error('记忆结果来源不合法');
    ids.add(i.id);
  }
}
export function artifactDocument(artifact: MemoryArtifact): string {
  validateArtifact(artifact);
  const document = JSON.stringify(artifact);
  if (Buffer.byteLength(document) > ARTIFACT_BYTES) throw new Error('记忆结果超过大小上限');
  return document;
}
export const artifactDigest = (document: string) => crypto.createHash('sha256').update(document).digest('hex');
export function parseArtifact(document: string, agent: string): MemoryArtifact {
  if (Buffer.byteLength(document) > ARTIFACT_BYTES) throw new Error('记忆结果超过大小上限');
  const value: unknown = JSON.parse(document); validateArtifact(value);
  if (value.agent !== agent) throw new Error('记忆结果不属于当前 agent');
  return value;
}

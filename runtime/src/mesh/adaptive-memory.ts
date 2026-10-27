// 新记忆服务复用同一 agent 的正式身体认证；只读灵魂桥不获此方法。
import type { Mesh } from './mesh.ts';
import { queryAdaptiveLocal, queryAdaptiveSemanticLocal, setAdaptiveTransport } from '../memory/adaptive.ts';

export function installAdaptiveMemory(mesh: Mesh) {
  mesh.handle('memory.adaptive.query', (params: { agent: string; query: string }) => queryAdaptiveLocal(params));
  mesh.handle('memory.adaptive.semantic.query', (params: { agent: string; query: string }) => queryAdaptiveSemanticLocal(params));
  return setAdaptiveTransport({ request: (host, params, signal) => mesh.request(host, 'memory.adaptive.query', params, 500, signal),
    semantic: (host, params, signal) => mesh.request(host, 'memory.adaptive.semantic.query', params, 500, signal) });
}

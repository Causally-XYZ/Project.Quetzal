// 新记忆服务复用同一 agent 的正式身体认证；只读灵魂桥不获此方法。
import type { Mesh } from './mesh.ts';
import { queryAdaptiveLocal, setAdaptiveTransport } from '../memory/adaptive.ts';

export function installAdaptiveMemory(mesh: Mesh) {
  mesh.handle('memory.adaptive.query', (params: { agent: string; query: string }) => queryAdaptiveLocal(params));
  return setAdaptiveTransport({ request: (host, params, signal) => mesh.request(host, 'memory.adaptive.query', params, 500, signal) });
}

// 运行期核查见证；受控灵魂变更在写锁内使其失效，事务重建令牌可检测外层回滚。
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export interface IntegrityState {
  soul: string; agent: string; epoch: number; token: string | undefined;
  checkedAt: number; retryAt: number; status: 'unchecked' | 'ready' | 'checking' | 'changed' | 'failed';
  task?: Promise<void>;
}
const states = new WeakMap<DatabaseSync, IntegrityState>();
const epochs = new Map<string, number>();
export const soulEpoch = (soul: string) => epochs.get(path.resolve(soul)) ?? 0;
export function invalidateAdaptiveArchives(soul: string) { const key = path.resolve(soul); epochs.set(key, soulEpoch(key) + 1); }
export function integrityState(db: DatabaseSync, soul: string, agent: string): IntegrityState {
  const key = path.resolve(soul); let state = states.get(db);
  if (!state || state.soul !== key || state.agent !== agent) {
    state = { soul: key, agent, epoch: -1, token: undefined, checkedAt: 0, retryAt: 0, status: 'unchecked' };
    states.set(db, state);
  }
  return state;
}
export const graphToken = (db: DatabaseSync) => String(db.prepare('SELECT token FROM adaptive_graph_witness WHERE singleton=1').get()?.token ?? '');
export function trustedIntegrity(db: DatabaseSync, state: IntegrityState) {
  return !!state.token && state.token === graphToken(db) && state.epoch === soulEpoch(state.soul);
}
export function trustIntegrity(db: DatabaseSync, state: IntegrityState) {
  state.token = graphToken(db); state.epoch = soulEpoch(state.soul); state.checkedAt = Date.now(); state.status = 'ready';
}

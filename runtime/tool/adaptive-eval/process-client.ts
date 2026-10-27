// 有界 IPC / 网关客户端；观察超时会失败并由上层收尾，不重启原进程或丢掉原证据。
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout; channel: 'ipc' | 'rpc' };
export async function startBody(home: string, settings: Record<string, unknown>) {
  fs.mkdirSync(home, { recursive: true });
  const log = fs.openSync(path.join(home, 'process.log'), 'wx');
  const child = fork(new URL('./body.ts', import.meta.url), [], { execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
    env: { ...process.env, QUETZAL_HOME: home, QUETZAL_EVAL_BODY: JSON.stringify(settings), SOUL_ALLOW_LOCAL_REMOTE: '1' },
    stdio: ['ignore', log, log, 'ipc'] });
  fs.closeSync(log);
  const pending = new Map<number, Pending>(); let seq = 0, socket: WebSocket | undefined;
  const rejectAll = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('evaluation-body-disconnected')); } pending.clear(); };
  const rejectRpc = () => { for (const [id, p] of pending) if (p.channel === 'rpc') {
    clearTimeout(p.timer); p.reject(new Error('evaluation-gateway-disconnected')); pending.delete(id);
  } };
  const receive = (m: any) => {
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error('evaluation-request-failed')) : p.resolve(m.result);
  };
  child.on('message', receive); child.on('exit', rejectAll); child.on('error', rejectAll);
  const alive = () => child.exitCode === null && child.signalCode === null;
  const request = <T = any>(channel: Pending['channel'], send: (value: unknown) => void, value: object, timeout: number) => new Promise<T>((resolve, reject) => {
    if (!alive()) { reject(new Error('evaluation-body-exited')); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('evaluation-request-timeout')); }, timeout);
    pending.set(id, { resolve, reject, timer, channel });
    try { send({ ...value, id }); } catch { clearTimeout(timer); pending.delete(id); reject(new Error('evaluation-send-failed')); }
  });
  const call = <T = any>(cmd: string, args?: unknown, timeout = 15000) => request<T>('ipc', (m) => child.send(m as object), { cmd, args }, timeout);
  async function stop() {
    socket?.terminate(); let forced = false;
    const done = alive() ? once(child, 'exit') : Promise.resolve();
    if (alive()) { try { await call('stop', undefined, 15000); } catch { forced = true; } }
    if (forced && alive()) child.kill('SIGKILL');
    // stop 应答后进程也必须退出；不能留下原生线程或后台定时器。
    const timer = setTimeout(() => { if (alive()) { forced = true; child.kill('SIGKILL'); } }, 5000);
    try { await done; } finally { clearTimeout(timer); rejectAll(); }
    return { pid: child.pid, forced, exitCode: child.exitCode, signal: child.signalCode };
  }
  try {
    const ready = await new Promise<{ port: number; pid: number }>((resolve, reject) => {
      const timer = setTimeout(() => end(new Error('evaluation-start-timeout')), 25000);
      const exit = () => end(new Error('evaluation-start-exited'));
      const message = (m: any) => { if (m.ready && Number.isInteger(m.port)) end(undefined, m); };
      function end(error?: Error, result?: any) { clearTimeout(timer); child.off('exit', exit); child.off('error', exit); child.off('message', message); error ? reject(error) : resolve(result); }
      child.once('exit', exit); child.once('error', exit); child.on('message', message);
    });
    socket = new WebSocket(`ws://127.0.0.1:${ready.port}/rpc`);
    const ws = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => end(new Error('evaluation-auth-timeout')), 10000);
      const failed = () => end(new Error('evaluation-auth-failed'));
      const message = (raw: WebSocket.RawData) => { try { if (JSON.parse(String(raw)).event === 'hello') end(); } catch { failed(); } };
      function end(error?: Error) { clearTimeout(timer); ws.off('error', failed); ws.off('close', failed); ws.off('message', message); error ? reject(error) : resolve(); }
      ws.once('error', failed); ws.once('close', failed); ws.on('message', message);
      ws.once('open', () => ws.send(JSON.stringify({ auth: fs.readFileSync(path.join(home, 'secrets/gateway.token'), 'utf8').trim() })));
    });
    ws.on('message', (raw) => { try { receive(JSON.parse(String(raw))); } catch { rejectRpc(); } });
    ws.on('error', rejectRpc); ws.on('close', rejectRpc);
    return { child, pid: ready.pid, port: ready.port, call, stop,
      rpc: <T = any>(method: string, params?: unknown, timeout = 180000) => request<T>('rpc', (m) => ws.send(JSON.stringify(m)), { method, params }, timeout) };
  } catch (error) { await stop(); throw error; }
}
export type BodyClient = Awaited<ReturnType<typeof startBody>>;

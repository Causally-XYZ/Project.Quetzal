// 中心后台准备固定公开组件；不读模型凭据，不进入灵魂锁，失败保留可继续下载的部分文件。
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { which, killTree, restrictToOwner } from '../platform.ts';
import manifest from '../../components/adaptive-retrieval/package.json' with { type: 'json' };
import lock from '../../components/adaptive-retrieval/package-lock.json' with { type: 'json' };
import pin from '../../components/adaptive-retrieval/model.json' with { type: 'json' };

export interface ComponentFile { path: string; size: number; sha256?: string; git?: string }
export interface ComponentProgress { phase: 'checking' | 'dependencies' | 'model' | 'ready'; file?: string; bytes?: number; total?: number }
export interface ComponentIO {
  fetch: typeof fetch;
  install(root: string, signal: AbortSignal): Promise<void>;
}
export const COMPONENT_VERSION = createHash('sha256').update(JSON.stringify({ manifest, lock, pin })).digest('hex');
const inflight = new Map<string, Promise<void>>();
const exists = async (file: string) => fs.stat(file).then(() => true, (e) => { if (e.code === 'ENOENT') return false; throw e; });

export async function verifyComponentFile(file: string, spec: ComponentFile): Promise<boolean> {
  try {
    const stat = await fs.stat(file); if (!stat.isFile() || stat.size !== spec.size) return false;
    const hash = createHash(spec.sha256 ? 'sha256' : 'sha1');
    if (!spec.sha256) hash.update(`blob ${stat.size}\0`);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === (spec.sha256 ?? spec.git);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Range 响应必须与已写长度及固定总长度一致；服务器不支持续传时从零重新写，不拼接两份完整文件。 */
export async function downloadComponentFile(file: string, spec: ComponentFile, url: string, signal: AbortSignal,
  progress: (bytes: number) => void, request: typeof fetch = fetch): Promise<void> {
  signal.throwIfAborted();
  if (await verifyComponentFile(file, spec)) { progress(spec.size); return; }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const part = file + '.part';
  if (await verifyComponentFile(part, spec)) { await fs.rename(part, file); progress(spec.size); return; }
  let offset = await fs.stat(part).then((s) => s.size, () => 0);
  if (offset >= spec.size) { await fs.rm(part, { force: true }); offset = 0; }
  const response = await request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
    headers: { 'accept-encoding': 'identity', ...(offset ? { range: `bytes=${offset}-` } : {}) }, redirect: 'follow' });
  if (!response.ok || !response.body || response.url && new URL(response.url).protocol !== 'https:') { await response.body?.cancel(); throw new Error('component_download_failed'); }
  if (response.status === 206) {
    const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (!range || Number(range[1]) !== offset || Number(range[2]) !== spec.size - 1 || Number(range[3]) !== spec.size) {
      await response.body.cancel(); throw new Error('component_range_invalid');
    }
  } else if (response.status === 200) offset = 0;
  else { await response.body.cancel(); throw new Error('component_download_failed'); }
  const output = await fs.open(part, offset ? 'a' : 'w', 0o600);
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      if (offset + chunk.byteLength > spec.size) throw new Error('component_size_invalid');
      await output.writeFile(chunk); offset += chunk.byteLength; progress(offset);
    }
    await output.sync();
  } finally { await output.close(); }
  if (!await verifyComponentFile(part, spec)) {
    if (offset === spec.size) await fs.rm(part, { force: true });
    throw new Error('component_digest_invalid');
  }
  signal.throwIfAborted(); await fs.rename(part, file);
}

async function installDependencies(root: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const npm = which('npm');
  const candidates = [npm ? await fs.realpath(npm) : '', path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  let cli: string | undefined;
  for (const item of candidates) if (item.endsWith('npm-cli.js') && await exists(item)) { cli = item; break; }
  if (!cli) throw new Error('component_npm_unavailable');
  const pidFile = path.join(root, 'npm.pid');
  if (await exists(pidFile)) {
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); throw new Error('component_install_busy'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('component_install_busy'); }
    }
    await fs.rm(pidFile);
  }
  const userConfig = path.join(root, 'empty-user.npmrc'), globalConfig = path.join(root, 'empty-global.npmrc');
  await fs.writeFile(userConfig, '', { mode: 0o600 }); await fs.writeFile(globalConfig, '', { mode: 0o600 });
  // 不继承 npm 用户配置、token 或 NODE_OPTIONS；官方固定 resolved URL 和 SHA512 由 npm 校验。
  const env = Object.fromEntries(['PATH', 'Path', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP'].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
  const child = spawn(process.execPath, [cli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org/', `--cache=${path.join(path.dirname(root), 'npm-cache')}`,
    `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`, '--fetch-retries=1'],
  { cwd: root, env, stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
  let force: NodeJS.Timeout | undefined;
  const cancel = () => { killTree(child.pid); force ??= setTimeout(() => killTree(child.pid, 'SIGKILL'), 1000); };
  const timeout = setTimeout(cancel, 60 * 60_000);
  const ended = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  try {
    if (child.pid) await fs.writeFile(pidFile, String(child.pid), { mode: 0o600 });
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
    const code = await ended; signal.throwIfAborted(); if (code !== 0) throw new Error('component_install_failed');
  } catch (error) { cancel(); await ended.catch(() => {}); throw error; }
  finally { clearTimeout(timeout); clearTimeout(force); signal.removeEventListener('abort', cancel); await fs.rm(pidFile, { force: true }); }
}

/** 成功标记只在 npm 锁、实际库版本及每个模型文件核验后写入；启动仍由 worker 再次核查。 */
export function prepareAdaptiveComponent(root: string, signal: AbortSignal, progress: (state: ComponentProgress) => void = () => {},
  io: ComponentIO = { fetch, install: installDependencies }): Promise<void> {
  root = path.resolve(root);
  if (inflight.has(root)) return inflight.get(root)!;
  const operation = (async () => {
    signal.throwIfAborted(); progress({ phase: 'checking' });
    await fs.mkdir(root, { recursive: true, mode: 0o700 }); restrictToOwner(path.dirname(root), 0o700);
    const descriptor = { version: COMPONENT_VERSION, platform: process.platform, arch: process.arch, abi: process.versions.modules };
    const marker = path.join(root, 'prepared.json');
    const dependencyMarker = path.join(root, 'dependencies.json');
    const expectedLock = JSON.stringify(lock), packageFile = path.join(root, 'node_modules/@huggingface/transformers/package.json');
    let dependencies = false;
    try {
      dependencies = JSON.stringify(JSON.parse(await fs.readFile(dependencyMarker, 'utf8'))) === JSON.stringify(descriptor) &&
        JSON.stringify(JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'))) === expectedLock &&
        JSON.parse(await fs.readFile(packageFile, 'utf8')).version === manifest.dependencies['@huggingface/transformers'];
    } catch { /* 首次或不完整安装自动重做；不会启动半份组件。 */ }
    await fs.rm(marker, { force: true });
    if (!dependencies) {
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
      await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
      progress({ phase: 'dependencies' }); await io.install(root, signal);
      if (JSON.stringify(JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'))) !== expectedLock ||
          JSON.parse(await fs.readFile(packageFile, 'utf8')).version !== manifest.dependencies['@huggingface/transformers']) throw new Error('component_install_invalid');
      await fs.writeFile(dependencyMarker + '.tmp', JSON.stringify(descriptor), { mode: 0o600 });
      await fs.rename(dependencyMarker + '.tmp', dependencyMarker);
    }
    for (const file of pin.files) {
      signal.throwIfAborted();
      await downloadComponentFile(path.join(root, 'model', file.path), file,
        `https://huggingface.co/${pin.id}/resolve/${pin.revision}/${file.path}`, signal,
        (bytes) => progress({ phase: 'model', file: file.path, bytes, total: file.size }), io.fetch);
    }
    signal.throwIfAborted();
    await fs.writeFile(marker + '.tmp', JSON.stringify(descriptor), { mode: 0o600 }); await fs.rename(marker + '.tmp', marker);
    progress({ phase: 'ready' });
  })();
  inflight.set(root, operation);
  void operation.finally(() => inflight.delete(root)).catch(() => {});
  return operation;
}

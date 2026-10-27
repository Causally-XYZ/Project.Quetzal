// main 在所有平台共用；将实际复用的第三方许可直接随可执行文件分发，避免安装器漏复制附属文件。
import fs from 'node:fs';
import { build } from 'esbuild';
const notice = fs.readFileSync(new URL('../third_party/graphiti/NOTICE.md', import.meta.url), 'utf8');
const license = fs.readFileSync(new URL('../third_party/graphiti/LICENSE', import.meta.url), 'utf8');
if (notice.includes('*/') || license.includes('*/')) throw new Error('第三方许可不能安全嵌入注释');
await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true,
  external: ['node-datachannel', '@anthropic-ai/sandbox-runtime'], outfile: 'dist/main.cjs',
  banner: { js: `/*!\n${notice}\n${license}\n*/` } });

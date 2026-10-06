// 冒烟测试 runner：把 fire-test.ts 打包成 CJS（注入 window.localStorage 的 shim）后执行。
import { build } from 'esbuild'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const result = await build({
  entryPoints: ['scripts/fire-test.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
  alias: { '@': process.cwd() + '/src' },
})

const dir = mkdtempSync(join(tmpdir(), 'fire-test-'))
const file = join(dir, 'test.mjs')

const shim = `
const __store = {};
globalThis.window = {
  localStorage: {
    getItem: (k) => (k in __store ? __store[k] : null),
    setItem: (k, v) => { __store[k] = String(v); },
  },
};
`
writeFileSync(file, shim + result.outputFiles[0].text)

await import(pathToFileURL(file).href)

/* 领域链路端到端验证：esbuild 打包后在 node 里跑，localStorage 用内存版模拟。 */
const assert = require('node:assert')

// ---- 内存版 localStorage（记录写入次数，便于验证"一次落库"）----
const mem = new Map()
let dataWrites = 0
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => {
      if (k === 'urban-utility-tunnel:entries') dataWrites++
      mem.set(k, String(v))
    },
    removeItem: (k) => mem.delete(k),
  },
}

require('esbuild')
  .build({
    entryPoints: ['scripts/fire-flow-check.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'scripts/.tmp-fire-flow.cjs',
    plugins: [
      {
        name: 'alias',
        setup(b) {
          b.onResolve({ filter: /^@\// }, (args) => {
            const fs = require('node:fs')
            const base = require('node:path').resolve(__dirname, '..', 'src', args.path.slice(2))
            const candidates = [base, `${base}.ts`, `${base}.vue`, require('node:path').join(base, 'index.ts')]
            const found = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile())
            return { path: found ?? base }
          })
        },
      },
    ],
    logLevel: 'silent',
  })
  .then(() => {
    const mod = require('./.tmp-fire-flow.cjs')
    mod.run({ assert })
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

/**
 * 跨平台、跨 Node 版本地跑测试。
 *
 * 为什么不直接写 `node --test "test/*.test.mjs"`：
 *   - `node --test` 的 **glob 展开** 是 Node 21 才有的能力；Node 20 会把 `test/*.test.mjs`
 *     当成一个字面路径，报 `Could not find '.../test/*.test.mjs'`（CI 上 Node 20 就是这么红的）。
 *   - 去掉引号让 shell 展开也不行：npm scripts 在 Windows 走 cmd（不展开 glob）、
 *     在 POSIX 走 sh（展开），两边行为不一致。
 *
 * 所以这里自己列出测试文件，把**显式路径**交给 `--test`——Node 18+ 都支持，
 * Windows / Linux 行为一致。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, 'test')

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(testDir, name))

if (files.length === 0) {
  console.error(`没有在 ${testDir} 找到 *.test.mjs`)
  process.exit(1)
}

// stdio: 'inherit' —— 让 node:test 的 reporter 直接写终端（管道捕获会丢颜色与进度）。
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: root,
})

if (result.error) {
  console.error(`启动测试进程失败：${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)

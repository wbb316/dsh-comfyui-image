/**
 * 测试公用工具。
 *
 * 两条原则：
 *   1. **绝不碰用户真实的数据**：插件配置文件位置用 `DSH_COMFYUI_IMAGE_CONFIG`
 *      指到临时目录，输出目录也用临时目录。
 *   2. **配置值必须落在合法区间**：`resolveConfig` 里的 `pickNumber(100, 10000, ...)`
 *      会把越界值丢掉退回默认值，所以测试给的 `pollIntervalMs` 不能低于 100，
 *      `timeoutMs` 不能低于 1000——否则测出来的等待时间是假的。
 */
// 必须排在最前面：它把插件配置文件位置指到临时目录，而 lib 是在加载时固定这个路径的。
import { CONFIG_PATH } from './env-setup.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makePng } from './mock-comfyui.mjs'
import { resolveConfig } from '../lib/index.js'

let counter = 0

/** 造一个临时目录（不自动删，方便失败后进去看现场）。 */
export function tempDir(tag = 'dsh-cii') {
  counter += 1
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-${process.pid}-${counter}-`))
}

/**
 * 返回本次测试进程使用的插件配置文件路径。
 *
 * 注意：**它不会「顺便」生效**——lib 加载时已经把 `CONFIG_FILE` 固定成
 * `env-setup.mjs` 里那个临时路径了。这个函数只是把那同一个路径交给你，
 * 避免测试里出现「设了个新路径却根本没被读取」这种假隔离。
 */
export function isolatePluginConfig() {
  return CONFIG_PATH
}

/**
 * 造一份测试用配置。
 * `baseUrl` 默认指向一个必然连不上的端口，只有真的需要连服务时才覆盖它——
 * 这样「意外发起网络请求」会立刻失败，而不是悄悄连到本机 8188 上的真 ComfyUI。
 */
export function testConfig(overrides = {}) {
  isolatePluginConfig()
  return resolveConfig({
    baseUrl: 'http://127.0.0.1:1',
    pollIntervalMs: 100,
    timeoutMs: 5000,
    requestTimeoutMs: 3000,
    ...overrides
  })
}

/** 写一张真 PNG 到指定路径，返回路径。 */
export function writePng(file, width = 64, height = 64) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, makePng(width, height))
  return file
}

/** 造一个假的「执行上下文」，把 cwd 挂在 agent.meta.cwd 上（宿主真实形态之一）。 */
export function fakeExec(cwd, signal) {
  return {
    agent: { meta: { cwd } },
    ...(signal ? { signal } : {})
  }
}

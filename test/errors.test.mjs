/**
 * 错误路径测试：需求书第七节「错误处理」与验收标准里的「明确报错」。
 *
 * 这里专门验证「坏了的时候说的话有没有用」——每条都必须能回答
 * 「为什么坏」+「我该怎么办」，而不是一个裸的 fetch failed。
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { ImagePluginError, runGeneration } from '../lib/index.js'
import { createMockComfyUI } from './mock-comfyui.mjs'
import { tempDir, testConfig, writePng } from './helpers.mjs'

const running = []

async function startMock(options = {}) {
  const mock = createMockComfyUI(options)
  const baseUrl = await mock.listen()
  running.push(mock)
  return { mock, baseUrl }
}

after(async () => {
  for (const mock of running) await mock.close()
})

/** 抓住错误；没报错就返回 undefined。 */
async function captureError(fn) {
  try {
    await fn()
    return undefined
  } catch (error) {
    return error
  }
}

function assertUsefulError(error, pattern, label) {
  assert.ok(error, `${label}：本应报错，却成功了`)
  assert.ok(
    error instanceof ImagePluginError,
    `${label}：应是 ImagePluginError，实际是 ${error?.constructor?.name}: ${error?.message}`
  )
  const text = `${error.message}\n${error.hint ?? ''}`
  assert.match(text, pattern, `${label}：报错文案没说到点子上 → ${text}`)
  assert.ok(
    typeof error.hint === 'string' && error.hint.trim().length > 0,
    `${label}：必须带一句「该怎么办」（hint），实际没有`
  )
}

test('ComfyUI 没启动 → 明确说连不上、并指出地址', async () => {
  const cwd = tempDir('err-down')
  const config = testConfig({ baseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 2000 })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assertUsefulError(error, /127\.0\.0\.1:1/, '连不上')
  assert.match(`${error.message}${error.hint}`, /ComfyUI/, '应点名是 ComfyUI 的问题')
})

test('地址指向的不是 ComfyUI（返回 HTML）→ 说清「这不是 ComfyUI」', async () => {
  const http = await import('node:http')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>我是一个普通网页</html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const cwd = tempDir('err-notcomfy')
    const config = testConfig({ baseUrl: `http://127.0.0.1:${port}` })
    const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
    assertUsefulError(error, /JSON|ComfyUI/, '不是 ComfyUI')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('工作流执行失败 → 把 ComfyUI 的原始报错带出来', async () => {
  const { baseUrl } = await startMock({ failMode: 'execution_error' })
  const cwd = tempDir('err-exec')
  const config = testConfig({ baseUrl, pollIntervalMs: 100 })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assertUsefulError(error, /CUDA out of memory/, '执行失败')
})

test('跑完了却没有图 → 明确说「没产出图片」，而不是静默成功', async () => {
  const { baseUrl } = await startMock({ failMode: 'no_images' })
  const cwd = tempDir('err-noimg')
  const config = testConfig({ baseUrl, pollIntervalMs: 100 })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assertUsefulError(error, /图/, '没有产出图片')
})

test('工作流被 ComfyUI 拒绝（400 + node_errors）→ 指出是哪个节点错', async () => {
  const { baseUrl } = await startMock({ failMode: 'reject' })
  const cwd = tempDir('err-reject')
  const config = testConfig({ baseUrl, pollIntervalMs: 100 })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assertUsefulError(error, /value_not_in_list|拒绝/, '工作流被拒绝')
})

test('超时 → 报超时，并且尽力让 ComfyUI 别再占着显卡', async () => {
  const { mock, baseUrl } = await startMock({ failMode: 'hang' })
  const cwd = tempDir('err-timeout')
  const config = testConfig({ baseUrl, timeoutMs: 1200, pollIntervalMs: 100 })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assertUsefulError(error, /超时/i, '超时')
  assert.ok(mock.state.stats.interrupt >= 1, '超时后应调用 /interrupt 取消任务')
})

test('调用方取消 → 报「已取消」，不冒充成功', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('err-abort')
  const config = testConfig({ baseUrl, pollIntervalMs: 100 })

  const controller = new AbortController()
  controller.abort()

  const error = await captureError(() =>
    runGeneration({ args: { prompt: 'x' }, cwd, config, signal: controller.signal })
  )
  assert.ok(error instanceof ImagePluginError, `应报错，实际 ${error}`)
  assert.match(`${error.message}${error.hint}`, /取消/)
})

test('ComfyUI 的报告里没有任何底模 → 告诉用户往哪放模型', async () => {
  const { baseUrl } = await startMock({ checkpoints: [] })
  const cwd = tempDir('err-nockpt')
  const config = testConfig({ baseUrl })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assertUsefulError(error, /底模/, '没有底模')
  assert.match(error.hint, /models\/checkpoints/, '要说清模型目录')
})

test('指定的底模不存在 → 报错并列出可选项（而不是偷偷换一个）', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('err-badckpt')
  const config = testConfig({ baseUrl })

  const error = await captureError(() =>
    runGeneration({ args: { prompt: 'x', model: '我不是一个真模型.safetensors' }, cwd, config })
  )
  assertUsefulError(error, /我不是一个真模型/, '底模不存在')
  assert.match(error.hint, /sd_xl_base_1\.0\.safetensors/, '要列出本机可用底模')
})

test('显式指定的采样器不存在 → 报错；只是配置默认值过期 → 悄悄换掉并说明', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('err-sampler')

  const explicit = await captureError(() =>
    runGeneration({
      args: { prompt: 'x', sampler_name: '不存在的采样器' },
      cwd,
      config: testConfig({ baseUrl })
    })
  )
  assertUsefulError(explicit, /采样器不存在/, '采样器不存在')
  assert.match(explicit.hint, /euler/, '要列出可用采样器')

  const run = await runGeneration({
    args: { prompt: 'x' },
    cwd,
    config: testConfig({ baseUrl, samplerName: '过期的采样器名字' })
  })
  assert.ok(
    run.notes.some((note) => note.includes('采样器')),
    '默认采样器在本机不存在时应换掉并留下说明'
  )
})

test('取图失败（/view 500）→ 报错而不是写出一个空文件', async () => {
  const { baseUrl } = await startMock({ failMode: 'view_500' })
  const cwd = tempDir('err-view')
  const config = testConfig({ baseUrl, pollIntervalMs: 100 })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assert.ok(error instanceof ImagePluginError, `应报错，实际：${error}`)
  assert.match(`${error.message}${error.hint}`, /500|取图|HTTP/)
})

test('输入图是空文件 → 也要有明确说法', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('err-emptyinput')
  const config = testConfig({ baseUrl })
  const emptyish = path.join(cwd, 'empty.png')
  const fs = await import('node:fs')
  fs.writeFileSync(emptyish, Buffer.alloc(0))

  const error = await captureError(() =>
    runGeneration({ args: { mode: 'img2img', prompt: 'x', input_image: emptyish }, cwd, config })
  )
  assert.ok(error, '空图片文件不应被当成正常输入')
})

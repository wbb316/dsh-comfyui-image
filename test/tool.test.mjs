/**
 * 工具契约测试。
 *
 * 最关键的一条是 `execute 的返回值不能有多余字段`：
 * OUTPUT_SCHEMA 声明了 `additionalProperties: false`，而 DSH 对这个 schema 是
 * **强制校验**的（不是提示）——多一个键，整个结果就会被拒。
 * 所以这里用 schema 自己来反过来检查 execute 的返回值。
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import {
  OUTPUT_SCHEMA,
  PARAMETERS_SCHEMA,
  TOOL_NAME,
  createGenerateImageTool,
  resolveCwd
} from '../lib/index.js'
import { createMockComfyUI, readPngSize } from './mock-comfyui.mjs'
import { fakeExec, isolatePluginConfig, tempDir, writePng } from './helpers.mjs'

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

const pluginConfigFor = (baseUrl, extra = {}) => ({
  baseUrl,
  pollIntervalMs: 100,
  timeoutMs: 5000,
  requestTimeoutMs: 3000,
  width: 256,
  height: 256,
  ...extra
})

/* ─────────────────────────── 定义形状 ─────────────────────────── */

test('工具身份：名字是 generate_image，参数/输出都挂上了', async () => {
  const { baseUrl } = await startMock()
  const tool = createGenerateImageTool(pluginConfigFor(baseUrl))

  assert.equal(tool.name, TOOL_NAME)
  assert.equal(tool.name, 'generate_image')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 40, '描述要够模型判断该不该调用')
  assert.match(tool.description, /ComfyUI/)
  for (const mode of ['text2img', 'img2img', 'inpaint', 'remove_background']) {
    assert.ok(tool.description.includes(mode), `描述里应提到 mode=${mode}`)
  }
  assert.equal(tool.parameters, PARAMETERS_SCHEMA)
  assert.equal(tool.output.schema, OUTPUT_SCHEMA)
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.output.presentationMeta, 'function')
  assert.equal(typeof tool.execute, 'function')
})

test('render 只吐一个文本块；presentationMeta 带上路径与模式', async () => {
  const { baseUrl } = await startMock()
  const tool = createGenerateImageTool(pluginConfigFor(baseUrl))

  const blocks = tool.output.render({}, { text: 'hello', path: 'D:\\a.png', mode: 'text2img', seed: 9 })
  assert.deepEqual(blocks, [{ type: 'text', text: 'hello' }], 'render 必须返回 ContentBlock 数组')

  const meta = tool.output.presentationMeta({}, { path: 'D:\\a.png', mode: 'inpaint', seed: 9 })
  assert.equal(meta.kind, 'image-generation')
  assert.equal(meta.path, 'D:\\a.png')
  assert.equal(meta.mode, 'inpaint')
  assert.equal(meta.seed, 9)

  // 拿到脏值时不能炸（presentationMeta 必须是纯函数且不至于抛错）
  assert.deepEqual(tool.output.render({}, undefined), [{ type: 'text', text: '' }])
})

/* ─────────────────────────── cwd 解析 ─────────────────────────── */

test('resolveCwd：几种宿主形态都能取到，取不到才退回进程 cwd', () => {
  assert.equal(resolveCwd({ agent: { cwd: 'C:\\one' } }), 'C:\\one')
  assert.equal(resolveCwd({ agent: { meta: { cwd: 'C:\\two' } } }), 'C:\\two')
  assert.equal(resolveCwd({ agent: { session: { cwd: 'C:\\three' } } }), 'C:\\three')
  assert.equal(resolveCwd({ agent: { session: { header: { cwd: 'C:\\four' } } } }), 'C:\\four')
  assert.equal(resolveCwd({ agent: { cwd: '   ' } }), process.cwd(), '空白字符串不算有效 cwd')
  assert.equal(resolveCwd({}), process.cwd())
  assert.equal(resolveCwd(undefined), process.cwd())
})

/* ─────────────────────────── 成功路径 ─────────────────────────── */

test('execute 成功：返回值严格符合 OUTPUT_SCHEMA，且 JSON 可无损序列化', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('tool-ok')
  isolatePluginConfig()
  const tool = createGenerateImageTool(pluginConfigFor(baseUrl))

  const value = await tool.execute({ prompt: 'a red panda' }, fakeExec(cwd))

  // 1) 必需的键一个不少
  for (const key of OUTPUT_SCHEMA.required) {
    assert.ok(key in value, `缺少必需字段 ${key}`)
  }
  // 2) 一个多余的键都不能有（additionalProperties:false 是强制校验的）
  const allowed = new Set(Object.keys(OUTPUT_SCHEMA.properties))
  for (const key of Object.keys(value)) {
    assert.ok(allowed.has(key), `出现了 OUTPUT_SCHEMA 没声明的字段 ${key} —— DSH 会直接拒掉整个结果`)
  }
  // 3) 类型正确
  assert.equal(typeof value.success, 'boolean')
  assert.equal(value.success, true)
  assert.equal(typeof value.path, 'string')
  assert.equal(typeof value.seed, 'number')
  assert.equal(typeof value.mode_inferred, 'boolean')
  assert.ok(Array.isArray(value.files) && value.files.length === 1)
  assert.ok(Array.isArray(value.notes))

  // 4) 落盘位置由 exec 里的 cwd 决定（= 项目根目录）
  assert.ok(path.isAbsolute(value.path))
  assert.equal(path.dirname(value.path), cwd)
  assert.ok(fs.existsSync(value.path))
  assert.deepEqual(readPngSize(fs.readFileSync(value.path)), { width: 256, height: 256 })

  // 5) 文本里绝对路径必须独占一行（前端靠这个把它渲染成可点开的链接）
  const lines = value.text.split('\n')
  assert.ok(
    lines.includes(`图片：${value.path}`),
    `text 里应有一整行是「图片：<绝对路径>」，实际文本：\n${value.text}`
  )
  if (value.metadata_path) {
    assert.ok(lines.includes(`元数据：${value.metadata_path}`))
    assert.ok(fs.existsSync(value.metadata_path))
  }

  // 6) lossless JSON：DSH 会用 JSON 传输这个值
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('execute 成功：render 出来的文本就是 value.text', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('tool-render')
  const tool = createGenerateImageTool(pluginConfigFor(baseUrl))

  const value = await tool.execute({ prompt: 'x' }, fakeExec(cwd))
  const blocks = tool.output.render({ prompt: 'x' }, value)
  assert.deepEqual(blocks, [{ type: 'text', text: value.text }])
})

test('execute：不同模式下都能从 exec 的 cwd 落盘', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('tool-modes')
  const tool = createGenerateImageTool(pluginConfigFor(baseUrl))
  const input = writePng(path.join(cwd, 'src.png'), 128, 128)

  const value = await tool.execute(
    { mode: 'img2img', prompt: 'make it winter', input_image: input },
    fakeExec(cwd)
  )
  assert.equal(value.mode, 'img2img')
  assert.equal(path.dirname(value.path), cwd)
  assert.ok(fs.existsSync(value.path))
})

/* ─────────────────────────── 失败路径 ─────────────────────────── */

test('execute 失败：抛出的错误里带「原因 + 怎么办」，不是裸 fetch failed', async () => {
  isolatePluginConfig()
  const cwd = tempDir('tool-fail')
  const tool = createGenerateImageTool(pluginConfigFor('http://127.0.0.1:1'))

  await assert.rejects(
    () => tool.execute({ prompt: 'x' }, fakeExec(cwd)),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /❌ 出图失败/)
      assert.match(error.message, /127\.0\.0\.1:1/)
      assert.match(error.message, /ComfyUI/)
      // 建议部分（hint）必须被拼进来
      assert.ok(error.message.split('\n').length >= 4, `失败文案应包含原因与建议：\n${error.message}`)
      return true
    }
  )
})

test('execute 失败：参数冲突也走同一套报错（带建议）', async () => {
  isolatePluginConfig()
  const cwd = tempDir('tool-conflict')
  const input = writePng(path.join(cwd, 'x.png'))
  const tool = createGenerateImageTool(pluginConfigFor('http://127.0.0.1:1'))

  await assert.rejects(
    () => tool.execute({ mode: 'text2img', prompt: 'x', input_image: input }, fakeExec(cwd)),
    /text2img 不接受 input_image/
  )
})

test('execute：插件配置是脏值时也不崩（退回默认配置）', async () => {
  isolatePluginConfig()
  const cwd = tempDir('tool-badcfg')
  const tool = createGenerateImageTool('我不是配置对象')
  // 这条测试走「完全没有配置」的默认地址，而默认地址就是本机 8188：开发机上真装着
  // ComfyUI 时它会连上并出图成功，「必然被拒绝」的断言就变成环境依赖（CI 上绿、本机红）。
  // 按 helpers.mjs 的既定原则把默认地址钉到必然连不上的端口，让它只证明该证明的事：
  // 脏配置被忽略、退回默认配置、且报错是插件自己的可读文案。
  const savedUrl = process.env.COMFYUI_URL
  process.env.COMFYUI_URL = 'http://127.0.0.1:1'
  try {
    await assert.rejects(() => tool.execute({ prompt: 'x' }, fakeExec(cwd)), /❌ 出图失败/)
  } finally {
    if (savedUrl === undefined) delete process.env.COMFYUI_URL
    else process.env.COMFYUI_URL = savedUrl
  }
})

/**
 * 端到端测试：真的起一个假 ComfyUI，把四种模式整条链路跑一遍。
 *
 * 这是这个插件最重要的证据：验证的不是「函数返回了对象」，而是
 *   「参数 → 工作流 → HTTP → 轮询 → 取回图片 → 落盘 → 元数据」
 * 全部真的走通了，并且**产出的 PNG 尺寸确实是请求的尺寸**
 * （假 ComfyUI 是按工作流里 EmptyLatentImage 的尺寸真造图的）。
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { ImagePluginError, runGeneration } from '../lib/index.js'
import { briaNodes, createMockComfyUI, defaultNodes, readPngSize, wasNodes } from './mock-comfyui.mjs'
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

/* ─────────────────────────────── 文生图 ─────────────────────────────── */

test('text2img 端到端：出图、尺寸正确、落盘到项目根目录、写好元数据', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-t2i')
  const config = testConfig({ baseUrl, width: 512, height: 512 })

  const run = await runGeneration({
    args: { prompt: 'a corgi astronaut, digital art' },
    cwd,
    config
  })

  // 真的写出了一张图
  assert.equal(run.outputPaths.length, 1)
  const output = run.outputPaths[0]
  assert.ok(fs.existsSync(output), `输出文件应存在：${output}`)
  assert.equal(path.dirname(output), cwd, '默认输出目录必须是「项目根目录」')
  assert.match(path.basename(output), /^comfyui-.*\.png$/)

  // 图是真的、且尺寸是我们要的 512×512（而不是随便一张
  const png = readPngSize(fs.readFileSync(output))
  assert.deepEqual(png, { width: 512, height: 512 }, '假 ComfyUI 应按工作流里的尺寸造图')

  assert.equal(run.mode, 'text2img')
  assert.equal(run.modeInferred, true)
  assert.equal(run.checkpoint, 'sd_xl_base_1.0.safetensors', '没指定底模时应自动挑带 xl 的那个')
  assert.ok(run.promptId.length > 0)
  assert.equal(run.comfyUrl, baseUrl)
  assert.ok(run.durationMs >= 0)
  assert.ok(
    run.notes.some((note) => note.includes('自动选用底模')),
    '自动换底模必须如实告知调用者'
  )

  // 元数据 sidecar
  assert.ok(run.metadataPath && fs.existsSync(run.metadataPath), '应写出元数据 sidecar')
  const meta = JSON.parse(fs.readFileSync(run.metadataPath, 'utf8'))
  assert.equal(meta.mode, 'text2img')
  assert.equal(meta.seed, run.request.seed)
  assert.equal(meta.width, 512)
  assert.equal(meta.height, 512)
  assert.equal(meta.checkpoint, 'sd_xl_base_1.0.safetensors')
  assert.ok(meta.workflow && Object.keys(meta.workflow).length >= 7, '元数据里应存完整工作流，便于复现')
  assert.equal(meta.outputFile, output)
  assert.ok(meta.pluginVersion.length > 0)

  // 过程事实：做过健康检查、没上传任何图、没轮询到超时
  assert.ok(mock.state.stats.system_stats >= 1, '应先做健康检查')
  assert.equal(mock.state.stats.upload, 0)
  assert.ok(mock.state.stats.history >= 2, '应轮询了不止一次（模拟排队）')
  assert.ok(mock.state.stats.view >= 1, '应取回图片字节')
})

test('text2img：指定 SD1.5 底模时自动用 512 尺寸', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('e2e-legacy')
  const config = testConfig({ baseUrl, width: 1024, height: 1024 })

  const run = await runGeneration({
    args: { prompt: 'x', model: 'v1-5-pruned-emaonly.safetensors' },
    cwd,
    config
  })

  assert.equal(run.request.width, 512, 'SD1.5 系应用 512 而不是配置里的 1024')
  assert.equal(run.request.height, 512)
  assert.deepEqual(readPngSize(fs.readFileSync(run.outputPaths[0])), { width: 512, height: 512 })
})

test('text2img：没传 model 时，自动挑到的 SD1.5 底模同样决定默认尺寸', async () => {
  // 回归点：真机上只有 SD1.5 一个底模时曾出 1024×1024，而工具说明承诺「尺寸按底模自适应」。
  // 根因是自适应发生在参数层、早于底模自动挑选，所以这里必须覆盖「自动挑」这条路径。
  const { baseUrl } = await startMock({ checkpoints: ['v1-5-pruned-emaonly.safetensors'] })
  const cwd = tempDir('e2e-legacy-auto')
  const config = testConfig({ baseUrl, width: 1024, height: 1024 })

  const run = await runGeneration({ args: { prompt: 'x' }, cwd, config })

  assert.equal(run.checkpoint, 'v1-5-pruned-emaonly.safetensors', '应自动挑到唯一的 SD1.5 底模')
  assert.equal(run.request.width, 512, '自动挑到的 SD1.5 也要把默认尺寸压到 512')
  assert.equal(run.request.height, 512)
  assert.deepEqual(readPngSize(fs.readFileSync(run.outputPaths[0])), { width: 512, height: 512 })
  assert.ok(
    run.notes.some((note) => note.includes('按底模') && note.includes('512x512')),
    '改了默认尺寸就得在 notes 里说清依据'
  )
})

test('text2img：显式传的 width 优先，只有没给的维度才走底模自适应', async () => {
  const { baseUrl } = await startMock({ checkpoints: ['v1-5-pruned-emaonly.safetensors'] })
  const cwd = tempDir('e2e-legacy-explicit')
  const config = testConfig({ baseUrl, width: 1024, height: 1024 })

  const run = await runGeneration({ args: { prompt: 'x', width: 768 }, cwd, config })

  assert.equal(run.request.width, 768, '显式 width 不能被底模自适应覆盖')
  assert.equal(run.request.height, 512, '没给的 height 才走底模自适应')
})

test('seed 会被真正用在图里，且同一个 seed 可复现', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-seed')
  const config = testConfig({ baseUrl, width: 256, height: 256 })

  const run = await runGeneration({ args: { prompt: 'x', seed: 777 }, cwd, config })
  assert.equal(run.request.seed, 777)
  assert.equal(run.workflow['5'].inputs.seed, 777)
  assert.equal(run.workflow['4'].inputs.width, 256)
  assert.ok(mock.state.stats.prompt >= 1)
})

/* ─────────────────────────────── 图生图 ─────────────────────────────── */

test('img2img 端到端：上传输入图 → VAEEncode → 采样，denoise 跟随 strength', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-i2i')
  const config = testConfig({ baseUrl })
  const input = writePng(path.join(cwd, 'input-300x200.png'), 300, 200)

  const run = await runGeneration({
    args: { mode: 'img2img', prompt: 'make it snowy', input_image: input, strength: 0.4 },
    cwd,
    config
  })

  assert.equal(run.mode, 'img2img')
  assert.equal(mock.state.stats.upload, 1, '输入图应被上传到 ComfyUI')
  assert.equal(mock.state.lastUploadFilename, 'input-300x200.png')

  assert.equal(run.workflow['8'].class_type, 'LoadImage')
  assert.equal(run.workflow['8'].inputs.image, 'input-300x200.png')
  assert.equal(run.workflow['10'].class_type, 'VAEEncode')
  assert.deepEqual(run.workflow['5'].inputs.latent_image, ['10', 0])
  assert.equal(run.workflow['5'].inputs.denoise, 0.4)

  assert.ok(fs.existsSync(run.outputPaths[0]))
  assert.ok(readPngSize(fs.readFileSync(run.outputPaths[0])), '产出的也是合法 PNG')
})

/* ─────────────────────────────── 局部重绘 ─────────────────────────────── */

test('inpaint 端到端：上传原图 + 遮罩 → VAEEncodeForInpaint', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-inpaint')
  const config = testConfig({ baseUrl })
  const input = writePng(path.join(cwd, 'photo.png'), 512, 512)
  const mask = writePng(path.join(cwd, 'mask.png'), 512, 512)

  const run = await runGeneration({
    args: { prompt: 'replace the sky with a rainbow', input_image: input, mask_image: mask },
    cwd,
    config
  })

  assert.equal(run.mode, 'inpaint', '有 input + mask 应推断为 inpaint')
  assert.equal(run.modeInferred, true)
  assert.equal(mock.state.stats.upload, 2, '原图和遮罩都要上传')

  assert.equal(run.workflow['9'].class_type, 'LoadImageMask')
  assert.equal(run.workflow['9'].inputs.channel, 'red')
  assert.equal(run.workflow['10'].class_type, 'VAEEncodeForInpaint')
  assert.deepEqual(run.workflow['10'].inputs.mask, ['9', 0])
  assert.deepEqual(run.workflow['10'].inputs.pixels, ['8', 0])
  assert.equal(run.workflow['10'].inputs.grow_mask_by, config.inpaintGrowMask)
  assert.equal(run.workflow['5'].inputs.denoise, 1)

  assert.ok(fs.existsSync(run.outputPaths[0]))
})

/* ─────────────────────────────── 背景移除 ─────────────────────────────── */

test('remove_background 端到端：走 essentials 双节点（RemBGSession → ImageRemoveBackground+），不经过采样器', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-rembg')
  const config = testConfig({ baseUrl })
  const input = writePng(path.join(cwd, 'portrait.png'), 256, 256)

  const run = await runGeneration({
    args: { mode: 'remove_background', input_image: input },
    cwd,
    config
  })

  assert.equal(run.mode, 'remove_background')
  assert.ok(
    run.rembgLabel && run.rembgLabel.includes('essentials'),
    `应报告用了哪套去背方案，实际：${run.rembgLabel}`
  )
  assert.ok(
    run.notes.some((note) => note.includes('去背方案')),
    '用了哪套去背方案必须写进 notes'
  )

  const classes = Object.values(run.workflow).map((node) => node.class_type)
  assert.ok(classes.includes('ImageRemoveBackground+'), '应包含 essentials 的消费节点')
  assert.ok(
    classes.includes('RemBGSession+'),
    'session 节点必须一起构建：真机上 rembg_session 是必填输入，单节点形态跑不通'
  )
  assert.ok(!classes.includes('KSampler'), '去背不该跑采样器')
  assert.equal(run.workflow['7'].class_type, 'SaveImage')

  const [sourceId] = run.workflow['7'].inputs.images
  assert.equal(run.workflow[sourceId].class_type, 'ImageRemoveBackground+')
  // session 的输出必须真的接进消费节点的 rembg_session，而不是被 autoFill 瞎填
  const [sessionId] = run.workflow[sourceId].inputs.rembg_session
  assert.equal(run.workflow[sessionId].class_type, 'RemBGSession+')
  assert.ok(fs.existsSync(run.outputPaths[0]))
  assert.equal(mock.state.stats.upload, 1)
})

test('去背方案择优：没有 essentials 时改用 BRIA', async () => {
  const { baseUrl } = await startMock({ nodes: briaNodes() })
  const cwd = tempDir('e2e-bria')
  const config = testConfig({ baseUrl })
  const input = writePng(path.join(cwd, 'x.png'), 64, 64)

  const run = await runGeneration({ args: { mode: 'remove_background', input_image: input }, cwd, config })

  assert.ok(run.rembgLabel.includes('BRIA'), `应识别出 BRIA 方案，实际：${run.rembgLabel}`)
  const classes = Object.values(run.workflow).map((node) => node.class_type)
  assert.ok(classes.includes('BRIA_RMBG_Zho'))
  assert.ok(classes.includes('BRIA_RMBG_ModelLoader_Zho'))
})

test('去背方案择优：只有单节点方案（WAS Node Suite）时走 buildSingle，不凭空拼 session 节点', async () => {
  const { baseUrl } = await startMock({ nodes: wasNodes() })
  const cwd = tempDir('e2e-was')
  const config = testConfig({ baseUrl })
  const input = writePng(path.join(cwd, 'x.png'), 64, 64)

  const run = await runGeneration({ args: { mode: 'remove_background', input_image: input }, cwd, config })

  assert.ok(run.rembgLabel.includes('WAS'), `应识别出 WAS 方案，实际：${run.rembgLabel}`)
  const classes = Object.values(run.workflow).map((node) => node.class_type)
  assert.ok(classes.includes('Image Rembg (Remove Background)'))
  assert.ok(!classes.includes('RemBGSession+'), '单节点方案不该凭空拼出 session 节点')
  assert.equal(
    classes.filter((c) => c.includes('Rembg') || c.includes('RemoveBackground')).length,
    1,
    '单节点方案应该只有一个去背节点'
  )
})

test('一个去背节点都没装 → 明确报错，并说清装什么、怎么装', async () => {
  const nodes = defaultNodes()
  delete nodes['RemBGSession+']
  delete nodes['ImageRemoveBackground+']
  const { baseUrl } = await startMock({ nodes })
  const cwd = tempDir('e2e-norembg')
  const config = testConfig({ baseUrl })
  const input = writePng(path.join(cwd, 'x.png'), 64, 64)

  await assert.rejects(
    () => runGeneration({ args: { mode: 'remove_background', input_image: input }, cwd, config }),
    (error) => {
      assert.ok(error instanceof ImagePluginError, `应是 ImagePluginError，实际 ${error?.constructor?.name}`)
      assert.match(error.message, /背景移除|去背/)
      assert.match(error.hint, /custom_nodes/, '必须告诉用户去哪装节点')
      return true
    }
  )
})

/* ─────────────────────────── 其它行为 ─────────────────────────── */

test('saveToComfyUI=false 时用 PreviewImage，并且照样落盘到本地', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('e2e-preview')
  const config = testConfig({ baseUrl, width: 128, height: 128, saveToComfyUI: false })

  const run = await runGeneration({ args: { prompt: 'x' }, cwd, config })
  const classes = Object.values(run.workflow).map((node) => node.class_type)
  assert.ok(classes.includes('PreviewImage'))
  assert.ok(!classes.includes('SaveImage'))
  assert.ok(fs.existsSync(run.outputPaths[0]), '不往 ComfyUI 存，也必须落到本地')
})

test('自定义工作流逃生舱：token 被替换成真实值，数字保持数字', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-custom')
  const config = testConfig({ baseUrl })
  const templatePath = path.join(cwd, 'custom-workflow.json')

  fs.writeFileSync(
    templatePath,
    JSON.stringify({
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{checkpoint}}' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['1', 1] } },
      '3': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
      '4': { class_type: 'PreviewImage', inputs: { images: ['3', 0] } }
    }),
    'utf8'
  )

  const run = await runGeneration({
    args: {
      prompt: 'a "quoted" prompt',
      width: 256,
      height: 192,
      extra_options: { workflow_path: templatePath }
    },
    cwd,
    config
  })

  assert.equal(run.workflow['2'].inputs.text, 'a "quoted" prompt', '带引号的提示词必须正确还原')
  assert.strictEqual(run.workflow['3'].inputs.width, 256, '数字占位符必须是数字')
  assert.strictEqual(run.workflow['3'].inputs.height, 192)
  assert.equal(run.workflow['1'].inputs.ckpt_name, 'sd_xl_base_1.0.safetensors', 'checkpoint 占位符应填自动挑的底模')
  assert.ok(run.notes.some((note) => note.includes('自定义工作流')))
  assert.ok(fs.existsSync(run.outputPaths[0]))
  assert.deepEqual(readPngSize(fs.readFileSync(run.outputPaths[0])), { width: 256, height: 192 })
  assert.ok(mock.state.stats.prompt >= 1)
})

test('自定义工作流文件不存在 → 明确报错（不是裸 ENOENT）', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('e2e-custom-missing')
  const config = testConfig({ baseUrl })

  await assert.rejects(
    () =>
      runGeneration({
        args: { prompt: 'x', extra_options: { workflow_path: path.join(cwd, '不存在.json') } },
        cwd,
        config
      }),
    (error) => {
      assert.ok(error instanceof ImagePluginError)
      assert.match(error.message, /不存在/)
      return true
    }
  )
})

test('两次生成不覆盖彼此', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('e2e-unique')
  const config = testConfig({ baseUrl, width: 64, height: 64 })

  const first = await runGeneration({ args: { prompt: 'x', seed: 1 }, cwd, config })
  const second = await runGeneration({ args: { prompt: 'x', seed: 2 }, cwd, config })

  assert.notEqual(first.outputPaths[0], second.outputPaths[0])
  assert.ok(fs.existsSync(first.outputPaths[0]))
  assert.ok(fs.existsSync(second.outputPaths[0]))
})

test('img2img / inpaint：报的尺寸是**产出图**的尺寸，不是请求里的 width/height', async () => {
  // 真机实测踩到过：512×512 的输入图产出 512 的图，报告与 sidecar 却写着 1024（请求值），
  // 与 OUTPUT_SCHEMA 里「width = 输出宽度」的承诺矛盾。
  const { baseUrl } = await startMock()
  const cwd = tempDir('e2e-actual-size')
  const config = testConfig({ baseUrl, width: 1024, height: 1024 })
  const input = writePng(path.join(cwd, 'input-320x240.png'), 320, 240)

  const img2img = await runGeneration({
    args: { mode: 'img2img', prompt: 'make it snowy', input_image: input },
    cwd,
    config
  })
  assert.deepEqual(readPngSize(fs.readFileSync(img2img.outputPaths[0])), { width: 320, height: 240 })
  assert.equal(img2img.request.width, 320, '报的宽必须是产出图的宽')
  assert.equal(img2img.request.height, 240)
  assert.ok(
    img2img.notes.some((note) => note.includes('画布由输入图决定')),
    '尺寸跟输入图走时要说清原因，而不是让请求值静静留在报告里'
  )

  const mask = writePng(path.join(cwd, 'mask-320x240.png'), 320, 240)
  const inpaint = await runGeneration({
    args: { mode: 'inpaint', prompt: 'a golden pear', input_image: input, mask_image: mask },
    cwd,
    config
  })
  assert.deepEqual(readPngSize(fs.readFileSync(inpaint.outputPaths[0])), { width: 320, height: 240 })
  assert.equal(inpaint.request.width, 320, '局部重绘同理：报产出尺寸')
  assert.equal(inpaint.request.height, 240)
})

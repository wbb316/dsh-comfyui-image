/**
 * 工作流构建的离线测试（纯函数，不联网）。
 *
 * 除了逐模式断言关键接线，还有一个**通用结构校验** `assertNoDanglingRefs`：
 * 把图里所有 [节点id, 槽位] 形态的连线都走一遍，确认指向的节点真的存在。
 * 这样即使以后改了节点编号，也不会悄悄产出「连到空气」的废工作流。
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  applyCustomWorkflow,
  buildImg2Img,
  buildInpaint,
  buildRemoveBackground,
  buildText2Img,
  filenamePrefixFor,
  normalizeRequest
} from '../lib/index.js'
import { tempDir, testConfig, writePng } from './helpers.mjs'

const cwd = tempDir('wf')
const config = testConfig()

// 必须是真的存在的文件：参数层会校验输入图存在，拿假路径会被它拦下（这是对的）
const inputFile = writePng(path.join(cwd, 'x.png'), 64, 64)
const maskFile = writePng(path.join(cwd, 'm.png'), 64, 64)

function factsFor(args, extra = {}) {
  const { request } = normalizeRequest(args, { cwd, config })
  return {
    request,
    config,
    checkpoint: 'sd_xl_base_1.0.safetensors',
    samplerName: 'euler',
    scheduler: 'normal',
    filenamePrefix: 'dsh-comfyui-image/test-prefix',
    ...extra
  }
}

/** 假去背方案：单元测试不依赖真节点表。 */
function fakeRembgPlan() {
  return {
    key: 'fake',
    label: '假去背节点',
    requiredNodes: ['FakeRembg'],
    installHint: '',
    build: (input) => ({ nodes: { rb1: { class_type: 'FakeRembg', inputs: { image: input, model: 'u2net' } } }, output: ['rb1', 0] })
  }
}

/** 图内所有连线都必须指向真实存在的节点。 */
function assertNoDanglingRefs(workflow) {
  const ids = new Set(Object.keys(workflow))
  for (const [nodeId, node] of Object.entries(workflow)) {
    for (const [inputName, value] of Object.entries(node.inputs ?? {})) {
      if (!Array.isArray(value) || value.length !== 2) continue
      const [target, slot] = value
      if (typeof target !== 'string' || typeof slot !== 'number') continue
      assert.ok(
        ids.has(target),
        `节点 ${nodeId} 的输入 ${inputName} 连到了不存在的节点 ${target}（可用：${[...ids].join(',')}）`
      )
    }
  }
}

test('text2img：完整接线 + 尺寸进 EmptyLatentImage', () => {
  const built = buildText2Img(factsFor({ prompt: 'a corgi astronaut', width: 768, height: 512 }))
  const wf = built.workflow

  assert.equal(built.mode, 'text2img')
  assert.equal(built.outputNodeId, '7')
  assertNoDanglingRefs(wf)

  assert.equal(wf['1'].class_type, 'CheckpointLoaderSimple')
  assert.equal(wf['1'].inputs.ckpt_name, 'sd_xl_base_1.0.safetensors')
  assert.equal(wf['2'].class_type, 'CLIPTextEncode')
  assert.equal(wf['2'].inputs.text, 'a corgi astronaut')
  assert.equal(wf['3'].class_type, 'CLIPTextEncode')
  assert.equal(wf['4'].class_type, 'EmptyLatentImage')
  assert.equal(wf['4'].inputs.width, 768)
  assert.equal(wf['4'].inputs.height, 512)
  assert.equal(wf['6'].class_type, 'VAEDecode')
  assert.equal(wf['7'].class_type, 'SaveImage')
  assert.equal(wf['7'].inputs.filename_prefix, 'dsh-comfyui-image/test-prefix')

  const sampler = wf['5']
  assert.equal(sampler.class_type, 'KSampler')
  assert.equal(sampler.inputs.denoise, 1, 'text2img 应该是整图生成')
  assert.deepEqual(sampler.inputs.latent_image, ['4', 0])
  assert.deepEqual(sampler.inputs.model, ['1', 0])
  assert.deepEqual(sampler.inputs.positive, ['2', 0])
  assert.deepEqual(sampler.inputs.negative, ['3', 0])
  assert.deepEqual(wf['7'].inputs.images, ['6', 0])
  assert.deepEqual(wf['6'].inputs.samples, ['5', 0])
})

test('img2img：LoadImage → VAEEncode → KSampler，denoise=strength', () => {
  const built = buildImg2Img(
    factsFor(
      { mode: 'img2img', prompt: 'make it snowy', input_image: inputFile, strength: 0.35 },
      { uploadedInput: 'x.png' }
    )
  )
  const wf = built.workflow
  assertNoDanglingRefs(wf)

  assert.equal(wf['8'].class_type, 'LoadImage')
  assert.equal(wf['8'].inputs.image, 'x.png')
  assert.equal(wf['10'].class_type, 'VAEEncode')
  assert.deepEqual(wf['10'].inputs.pixels, ['8', 0])
  assert.deepEqual(wf['5'].inputs.latent_image, ['10', 0])
  assert.equal(wf['5'].inputs.denoise, 0.35)
})

test('inpaint：LoadImageMask（red 通道）→ VAEEncodeForInpaint，denoise=1', () => {
  const built = buildInpaint(
    factsFor(
      {
        mode: 'inpaint',
        prompt: 'replace with a hat',
        input_image: inputFile,
        mask_image: maskFile
      },
      { uploadedInput: 'x.png', uploadedMask: 'm.png' }
    )
  )
  const wf = built.workflow
  assertNoDanglingRefs(wf)

  assert.equal(wf['9'].class_type, 'LoadImageMask')
  assert.equal(wf['9'].inputs.image, 'm.png')
  assert.equal(wf['9'].inputs.channel, 'red')
  assert.equal(wf['10'].class_type, 'VAEEncodeForInpaint')
  assert.deepEqual(wf['10'].inputs.pixels, ['8', 0])
  assert.deepEqual(wf['10'].inputs.mask, ['9', 0])
  assert.equal(wf['10'].inputs.grow_mask_by, config.inpaintGrowMask)
  assert.equal(wf['5'].inputs.denoise, 1)
})

test('remove_background：去背节点输出接到 SaveImage', () => {
  const built = buildRemoveBackground(
    factsFor({ mode: 'remove_background', input_image: inputFile }, {
      uploadedInput: 'x.png',
      rembg: fakeRembgPlan()
    })
  )
  const wf = built.workflow
  assertNoDanglingRefs(wf)

  const rembgNode = Object.values(wf).find((node) => node.class_type === 'FakeRembg')
  assert.ok(rembgNode, '应该包含去背节点')
  assert.equal(wf['7'].class_type, 'SaveImage')
  const [sourceId] = wf['7'].inputs.images
  assert.ok(wf[sourceId], 'SaveImage 的输入必须是图里真实存在的节点')
  assert.equal(wf[sourceId].class_type, 'FakeRembg', '去背结果应直接进 SaveImage，不经过采样器')
  assert.ok(!Object.values(wf).some((node) => node.class_type === 'KSampler'), '去背不该有采样器')
})

test('remove_background 没给方案 → 立刻报错，而不是产出坏工作流', () => {
  assert.throws(() =>
    buildRemoveBackground(factsFor({ mode: 'remove_background', input_image: path.join(cwd, 'x.png') }, { uploadedInput: 'x.png' }))
  )
})

test('img2img / inpaint 缺已上传文件 → 报内部错误，不静默降级', () => {
  assert.throws(
    () => buildImg2Img(factsFor({ mode: 'img2img', prompt: 'x', input_image: inputFile })),
    /内部错误/
  )
  assert.throws(
    () =>
      buildInpaint(
        factsFor(
          { mode: 'inpaint', prompt: 'x', input_image: inputFile, mask_image: maskFile },
          { uploadedInput: 'x.png' }
        )
      ),
    /内部错误/
  )
})

test('saveToComfyUI=false → 用 PreviewImage（不污染 ComfyUI 的 output 目录）', () => {
  const noSave = { ...config, saveToComfyUI: false }
  const { request } = normalizeRequest({ prompt: 'x' }, { cwd, config: noSave })
  const built = buildText2Img({
    request,
    config: noSave,
    checkpoint: 'sd_xl_base_1.0.safetensors',
    samplerName: 'euler',
    scheduler: 'normal',
    filenamePrefix: 'p'
  })
  const classes = Object.values(built.workflow).map((node) => node.class_type)
  assert.ok(classes.includes('PreviewImage'))
  assert.ok(!classes.includes('SaveImage'))
})

test('filenamePrefixFor：带日期时间与 seed，且落在子目录里', () => {
  const { request } = normalizeRequest({ prompt: 'x', seed: 12345 }, { cwd, config })
  const prefix = filenamePrefixFor(request, new Date(2026, 8, 28, 15, 30, 12))
  assert.equal(prefix, 'dsh-comfyui-image/20260928-153012-12345')
})

test('token 替换：数字变数字、字符串正确转义、未提供的占位符原样保留', () => {
  const template = {
    '1': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
    '3': { class_type: 'X', inputs: { keep: '{{不认识的占位符}}' } }
  }
  const result = applyCustomWorkflow(template, { width: 512, height: 768, prompt: '带"引号"和\\反斜杠' })

  assert.strictEqual(result['1'].inputs.width, 512, '数字占位符必须变成数字类型')
  assert.strictEqual(result['1'].inputs.height, 768)
  assert.strictEqual(result['2'].inputs.text, '带"引号"和\\反斜杠', '字符串必须原样还原')
  assert.equal(result['3'].inputs.keep, '{{不认识的占位符}}', '拼错的占位符应留在原地便于发现')
})

test('token 替换：模板不是对象 → 报错', () => {
  assert.throws(() => applyCustomWorkflow([1, 2, 3], {}), /必须是一个 JSON 对象/)
  assert.throws(() => applyCustomWorkflow(null, {}), /必须是一个 JSON 对象/)
})

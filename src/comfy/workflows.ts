/**
 * 工作流构建：把 `NormalizedRequest`（+ 探测到的事实）变成 ComfyUI 的 **API 格式**工作流。
 *
 * 这一层是**纯函数**：不碰网络、不碰文件系统，所以能离线单测
 * （test/test-workflows.mjs 会逐一断言连线关系）。
 *
 * 节点 id 用固定字符串，连线写作 `[上游节点id, 输出索引]`——这就是 ComfyUI API 格式的约定。
 * 每个模式的最小图：
 *
 *   text2img:  CheckpointLoaderSimple → CLIPTextEncode×2 ┐
 *                                     EmptyLatentImage ─┴→ KSampler → VAEDecode → SaveImage
 *   img2img:   LoadImage → VAEEncode ─┐
 *              上面那套 prompt/clip ──┴→ KSampler(denoise=strength) → VAEDecode → SaveImage
 *   inpaint:   LoadImage ─┐
 *              LoadImageMask ─┴→ VAEEncodeForInpaint → KSampler → VAEDecode → SaveImage
 *   rm_bg:     LoadImage → 去背节点（第三方） → SaveImage
 */
import type { ComfyNode, ComfyWorkflow, GenerateMode, NormalizedRequest, ResolvedConfig } from '../types.js'
import type { RembgPlan } from './nodes.js'

/** 固定节点 id，方便调试时对照。 */
export const NODE_IDS = {
  checkpoint: '1',
  positive: '2',
  negative: '3',
  emptyLatent: '4',
  sampler: '5',
  decode: '6',
  save: '7',
  loadImage: '8',
  loadMask: '9',
  vaeEncode: '10',
  inpaintEncode: '10'
} as const

/** 构建工作流所需要的全部输入（都已在别的层解析完毕）。 */
export interface WorkflowFacts {
  request: NormalizedRequest
  config: ResolvedConfig
  /** 已确定的底模文件名。 */
  checkpoint: string
  /** 已校验过的采样器 / 调度器。 */
  samplerName: string
  scheduler: string
  /** 已上传到 ComfyUI 的输入图文件名（img2img / inpaint / remove_background 用）。 */
  uploadedInput?: string
  /** 已上传的遮罩文件名（inpaint 用）。 */
  uploadedMask?: string
  /** ComfyUI 侧的输出文件名前缀，例如 `dsh-comfyui-image/20260928-153012-1234`。 */
  filenamePrefix: string
  /** 去背方案（mode=remove_background 时必须给）。 */
  rembg?: RembgPlan
  /** LoadImageMask 的通道，默认 red。 */
  maskChannel?: string
}

export interface BuiltWorkflow {
  workflow: ComfyWorkflow
  /** 模式，便于调用方记录/校验。 */
  mode: GenerateMode
  /** 产出图片的节点 id。 */
  outputNodeId: string
}

function checkpointLoader(checkpoint: string): ComfyNode {
  return {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: checkpoint },
    _meta: { title: '底模' }
  }
}

function clipEncode(text: string, clipFrom: [string, number], title: string): ComfyNode {
  return { class_type: 'CLIPTextEncode', inputs: { text, clip: clipFrom }, _meta: { title } }
}

function ksampler(facts: WorkflowFacts, latentImage: [string, number], denoise: number): ComfyNode {
  return {
    class_type: 'KSampler',
    inputs: {
      seed: facts.request.seed,
      steps: facts.request.steps,
      cfg: facts.request.cfgScale,
      sampler_name: facts.samplerName,
      scheduler: facts.scheduler,
      denoise,
      model: [NODE_IDS.checkpoint, 0],
      positive: [NODE_IDS.positive, 0],
      negative: [NODE_IDS.negative, 0],
      latent_image: latentImage
    },
    _meta: { title: '采样器' }
  }
}

function saveNode(facts: WorkflowFacts): ComfyNode {
  if (facts.config.saveToComfyUI) {
    return {
      class_type: 'SaveImage',
      inputs: { filename_prefix: facts.filenamePrefix, images: [NODE_IDS.decode, 0] },
      _meta: { title: '保存图片' }
    }
  }
  // PreviewImage 落在 ComfyUI 的 temp 目录，不会污染它的 output 目录
  return {
    class_type: 'PreviewImage',
    inputs: { images: [NODE_IDS.decode, 0] },
    _meta: { title: '预览图片' }
  }
}

function assertUploaded(value: string | undefined, what: string, mode: GenerateMode): string {
  if (!value) {
    throw new Error(`内部错误：mode=${mode} 需要已上传的${what}，但构建工作流时没有拿到。`)
  }
  return value
}

/** 构建 text2img 工作流。 */
export function buildText2Img(facts: WorkflowFacts): BuiltWorkflow {
  const workflow: ComfyWorkflow = {
    [NODE_IDS.checkpoint]: checkpointLoader(facts.checkpoint),
    [NODE_IDS.positive]: clipEncode(facts.request.prompt, [NODE_IDS.checkpoint, 1], '正向提示词'),
    [NODE_IDS.negative]: clipEncode(facts.request.negativePrompt, [NODE_IDS.checkpoint, 1], '负向提示词'),
    [NODE_IDS.emptyLatent]: {
      class_type: 'EmptyLatentImage',
      inputs: { width: facts.request.width, height: facts.request.height, batch_size: 1 },
      _meta: { title: '空潜空间' }
    },
    [NODE_IDS.sampler]: ksampler(facts, [NODE_IDS.emptyLatent, 0], 1.0),
    [NODE_IDS.decode]: {
      class_type: 'VAEDecode',
      inputs: { samples: [NODE_IDS.sampler, 0], vae: [NODE_IDS.checkpoint, 2] },
      _meta: { title: 'VAE 解码' }
    },
    [NODE_IDS.save]: saveNode(facts)
  }
  return { workflow, mode: 'text2img', outputNodeId: NODE_IDS.save }
}

/** 构建 img2img 工作流（denoise = strength）。 */
export function buildImg2Img(facts: WorkflowFacts): BuiltWorkflow {
  const imageName = assertUploaded(facts.uploadedInput, '输入图', 'img2img')
  const workflow: ComfyWorkflow = {
    [NODE_IDS.checkpoint]: checkpointLoader(facts.checkpoint),
    [NODE_IDS.positive]: clipEncode(facts.request.prompt, [NODE_IDS.checkpoint, 1], '正向提示词'),
    [NODE_IDS.negative]: clipEncode(facts.request.negativePrompt, [NODE_IDS.checkpoint, 1], '负向提示词'),
    [NODE_IDS.loadImage]: {
      class_type: 'LoadImage',
      inputs: { image: imageName },
      _meta: { title: '输入图' }
    },
    [NODE_IDS.vaeEncode]: {
      class_type: 'VAEEncode',
      inputs: { pixels: [NODE_IDS.loadImage, 0], vae: [NODE_IDS.checkpoint, 2] },
      _meta: { title: 'VAE 编码' }
    },
    [NODE_IDS.sampler]: ksampler(facts, [NODE_IDS.vaeEncode, 0], facts.request.strength),
    [NODE_IDS.decode]: {
      class_type: 'VAEDecode',
      inputs: { samples: [NODE_IDS.sampler, 0], vae: [NODE_IDS.checkpoint, 2] },
      _meta: { title: 'VAE 解码' }
    },
    [NODE_IDS.save]: saveNode(facts)
  }
  return { workflow, mode: 'img2img', outputNodeId: NODE_IDS.save }
}

/** 构建 inpaint 工作流（LoadImage + LoadImageMask → VAEEncodeForInpaint）。 */
export function buildInpaint(facts: WorkflowFacts): BuiltWorkflow {
  const imageName = assertUploaded(facts.uploadedInput, '输入图', 'inpaint')
  const maskName = assertUploaded(facts.uploadedMask, '遮罩图', 'inpaint')
  const workflow: ComfyWorkflow = {
    [NODE_IDS.checkpoint]: checkpointLoader(facts.checkpoint),
    [NODE_IDS.positive]: clipEncode(facts.request.prompt, [NODE_IDS.checkpoint, 1], '正向提示词'),
    [NODE_IDS.negative]: clipEncode(facts.request.negativePrompt, [NODE_IDS.checkpoint, 1], '负向提示词'),
    [NODE_IDS.loadImage]: {
      class_type: 'LoadImage',
      inputs: { image: imageName },
      _meta: { title: '原图' }
    },
    [NODE_IDS.loadMask]: {
      class_type: 'LoadImageMask',
      inputs: { image: maskName, channel: facts.maskChannel ?? 'red' },
      _meta: { title: '遮罩（白=重绘区）' }
    },
    [NODE_IDS.inpaintEncode]: {
      class_type: 'VAEEncodeForInpaint',
      inputs: {
        pixels: [NODE_IDS.loadImage, 0],
        vae: [NODE_IDS.checkpoint, 2],
        mask: [NODE_IDS.loadMask, 0],
        grow_mask_by: facts.config.inpaintGrowMask
      },
      _meta: { title: '内补编码' }
    },
    [NODE_IDS.sampler]: ksampler(facts, [NODE_IDS.inpaintEncode, 0], facts.request.strength),
    [NODE_IDS.decode]: {
      class_type: 'VAEDecode',
      inputs: { samples: [NODE_IDS.sampler, 0], vae: [NODE_IDS.checkpoint, 2] },
      _meta: { title: 'VAE 解码' }
    },
    [NODE_IDS.save]: saveNode(facts)
  }
  return { workflow, mode: 'inpaint', outputNodeId: NODE_IDS.save }
}

/** 构建背景移除工作流（LoadImage → 第三方去背节点 → SaveImage）。 */
export function buildRemoveBackground(facts: WorkflowFacts): BuiltWorkflow {
  const imageName = assertUploaded(facts.uploadedInput, '输入图', 'remove_background')
  if (!facts.rembg) {
    throw new Error('内部错误：mode=remove_background 需要 rembg 方案，但构建工作流时没有拿到。')
  }
  const loadImage: ComfyNode = {
    class_type: 'LoadImage',
    inputs: { image: imageName },
    _meta: { title: '输入图' }
  }
  const built = facts.rembg.build([NODE_IDS.loadImage, 0])

  // 去背结果直接进保存节点
  const saver: ComfyNode = facts.config.saveToComfyUI
    ? {
        class_type: 'SaveImage',
        inputs: { filename_prefix: facts.filenamePrefix, images: built.output },
        _meta: { title: '保存图片（已去背）' }
      }
    : {
        class_type: 'PreviewImage',
        inputs: { images: built.output },
        _meta: { title: '预览图片（已去背）' }
      }

  const workflow: ComfyWorkflow = {
    [NODE_IDS.loadImage]: loadImage,
    ...built.nodes,
    [NODE_IDS.save]: saver
  }
  return { workflow, mode: 'remove_background', outputNodeId: NODE_IDS.save }
}

/** 按模式分派。 */
export function buildWorkflow(facts: WorkflowFacts): BuiltWorkflow {
  switch (facts.request.mode) {
    case 'text2img':
      return buildText2Img(facts)
    case 'img2img':
      return buildImg2Img(facts)
    case 'inpaint':
      return buildInpaint(facts)
    case 'remove_background':
      return buildRemoveBackground(facts)
    default: {
      const exhaustive: never = facts.request.mode
      throw new Error(`内部错误：未知模式 ${String(exhaustive)}`)
    }
  }
}

/** ComfyUI 侧的输出文件名前缀（放在一个子目录里，保持 ComfyUI output 整洁）。 */
export function filenamePrefixFor(request: NormalizedRequest, now: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `dsh-comfyui-image/${stamp}-${request.seed}`
}

/**
 * 用户自定义工作流的 **token 替换**逃生舱（需求书：为 outpaint / upscale 等预留空间）。
 *
 * 用法：`extra_options.workflow_path` 指向一个 API 格式工作流 JSON，里面用
 * `{{prompt}}`、`{{negative_prompt}}`、`{{width}}`、`{{height}}`、`{{seed}}`、
 * `{{steps}}`、`{{cfg_scale}}`、`{{strength}}`、`{{checkpoint}}`、`{{input_image}}`、
 * `{{mask_image}}` 这些占位符，插件在提交前替换成真实值。
 *
 * 这样任何本插件 V1 没覆盖的能力（扩图、超分、批量、特殊节点），
 * 用户都能自己接进来，不用等我发新版。
 */
export function applyCustomWorkflow(
  template: unknown,
  values: Record<string, string | number>
): ComfyWorkflow {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new Error('自定义工作流必须是一个 JSON 对象（API 格式）。')
  }

  /**
   * 递归替换。
   *
   * ⚠️ 这里**不能**用「先 `JSON.stringify` 再字符串替换」的写法（我第一版就是那么写的，
   * 被测试抓出来了）：那样模板里的 `"{{width}}"` 会整体变成带引号的 `"256"`，
   * 数字就悄悄退化成了字符串，ComfyUI 会因为类型不对直接拒掉整个工作流。
   * 按值替换才能保住类型：整个字符串就是一个占位符时，原样返回该值（数字仍是数字）。
   */
  const substitute = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const exact = /^\{\{(\w+)\}\}$/.exec(value)
      if (exact) {
        const replacement = values[exact[1] as string]
        // 没提供的占位符原样留着，便于用户发现自己拼错了
        return replacement === undefined ? value : replacement
      }
      // 占位符嵌在句子中间 → 只能当字符串拼进去
      return value.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
        const replacement = values[key]
        return replacement === undefined ? match : String(replacement)
      })
    }
    if (Array.isArray(value)) return value.map(substitute)
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) result[key] = substitute(child)
      return result
    }
    return value
  }

  return substitute(template) as ComfyWorkflow
}

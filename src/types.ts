/**
 * 全插件共享的类型定义。
 *
 * 设计原则（对应需求书第五节「统一抽象参数层」）：
 *   - `GenerateImageArgs`   = **对外**契约，就是 Agent 看到的那些参数，尽量少、尽量好懂。
 *   - `NormalizedRequest`   = **对内**契约，默认值全部填好、模式已确定、路径已解析，
 *                            后面所有模块（工作流构建 / 执行 / 落盘）只认它。
 *   两层分开的好处：以后要改 ComfyUI 细节，只动工作流模块；要加对外参数，只动 args + params。
 */

/** V1 对 Agent 暴露的四种操作模式。 */
export type GenerateMode = 'text2img' | 'img2img' | 'inpaint' | 'remove_background'

/** 顺序即「模式推断」的判定顺序，别随意改。 */
export const GENERATE_MODES: readonly GenerateMode[] = [
  'text2img',
  'img2img',
  'inpaint',
  'remove_background'
]

export function isGenerateMode(value: unknown): value is GenerateMode {
  return typeof value === 'string' && (GENERATE_MODES as readonly string[]).includes(value)
}

/**
 * 统一的对外参数层。
 *
 * 刻意**不**把 ComfyUI 的底层参数原样倒出来；只保留真正需要调的旋钮，
 * 其余（batch_size、vae、clip skip、节点 id……）由插件自己决定。
 *
 * `style_reference` / `character_reference` / `extra_options` 属于**预留位**：
 * V1 会接收并存进元数据，但不会真的改变生成结果（详见 README 的「一致性」一节）。
 */
export interface GenerateImageArgs {
  /** 操作模式。不传则按 input_image / mask_image 自动推断（推断规则见 README）。 */
  mode?: GenerateMode
  /** 正向提示词。text2img / img2img / inpaint 必填；remove_background 忽略。 */
  prompt?: string
  /** 负向提示词。可选，不传用插件默认值。 */
  negative_prompt?: string
  /** 输入图片的本地路径（img2img / inpaint / remove_background 必填）。 */
  input_image?: string
  /** 遮罩图片的本地路径（inpaint 必填）。白/亮区 = 要重绘的区域。 */
  mask_image?: string
  /** 输出宽度。仅对 text2img 生效（其余模式由输入图决定，见 README）。 */
  width?: number
  /** 输出高度。仅对 text2img 生效。 */
  height?: number
  /** 随机种子。不传则自动生成；同 seed + 同 prompt 可复现同一张图。 */
  seed?: number
  /** 输出目录或输出文件路径。不传则落到当前项目根目录。 */
  output_path?: string
  /** 【预留】风格参考图路径。 */
  style_reference?: string
  /** 【预留】角色参考图路径。 */
  character_reference?: string
  /** 图生图强度 / 重绘幅度（0~1）。img2img 默认 0.6，inpaint 默认 1.0。 */
  strength?: number
  /** 采样步数。默认 20。 */
  steps?: number
  /** CFG scale。默认 7。 */
  cfg_scale?: number
  /** 底模文件名（ComfyUI 里 models/checkpoints 下的名字）。不传则自动挑一个可用的。 */
  model?: string
  /** 采样器名字（可选）。不传用插件默认值。 */
  sampler_name?: string
  /** 调度器名字（可选）。不传用插件默认值。 */
  scheduler?: string
  /** 【预留】扩展字段。`workflow_path` 可指定自定义 API 格式工作流来接管本次生成。 */
  extra_options?: Record<string, unknown>
}

/**
 * 归一化后的请求：默认值已填、模式已定、路径已解析。
 * 所有下游模块只依赖这个结构。
 */
export interface NormalizedRequest {
  mode: GenerateMode
  prompt: string
  negativePrompt: string
  /** 已 resolve 成绝对路径；仅在需要输入图的模式下存在。 */
  inputImage?: string
  maskImage?: string
  styleReference?: string
  characterReference?: string
  /** text2img 使用；其余模式忽略。 */
  width: number
  height: number
  /**
   * 该维度是否由调用方**显式**给出（width / height 参数）。
   * false 表示「还没定」——底模最终选定后可以按底模自适应，见 applyModelAwareSize。
   */
  widthFromArgs: boolean
  heightFromArgs: boolean
  seed: number
  strength: number
  steps: number
  cfgScale: number
  /** 未指定时为空串，表示「让工作流模块自动挑一个」。 */
  checkpoint: string
  samplerName: string
  scheduler: string
  /** 已 resolve 成绝对路径的最终输出文件。 */
  outputPath: string
  /** 本次请求的用户可读提醒（例如「width/height 在 inpaint 下被忽略」）。 */
  notes: string[]
  /** 原样保留的扩展字段。 */
  extra: Record<string, unknown>
}

/** ComfyUI API 格式工作流中的一个节点。 */
export interface ComfyNode {
  class_type: string
  /** 键值对：字面量，或 `[上游节点id, 输出索引]` 形式的连线。 */
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}

/** ComfyUI API 格式工作流：节点 id → 节点。 */
export type ComfyWorkflow = Record<string, ComfyNode>

/** ComfyUI `/history` 里描述一张产出图片的结构。 */
export interface ComfyImageRef {
  filename: string
  subfolder: string
  type: string
}

/** 一次生成的成功结果。 */
export interface GenerationOutcome {
  /** 已写入磁盘的输出文件绝对路径（当前固定 1 张）。 */
  outputPaths: string[]
  /** 元数据 sidecar 的路径（写元数据时才存在）。 */
  metadataPath?: string
  /** ComfyUI 内部的图片引用，便于用户自己去 ComfyUI 里找。 */
  comfyImage: ComfyImageRef
  /** ComfyUI 返回的 prompt_id。 */
  promptId: string
  /** 实际使用的 ComfyUI 地址。 */
  comfyUrl: string
  /** 从提交到取回图片的耗时（毫秒）。 */
  durationMs: number
  /** 本次生成用的实际参数（元数据用）。 */
  request: NormalizedRequest
}

/** 插件配置：全部可选，来源见 config.ts。 */
export interface PluginConfigInput {
  baseUrl?: string
  outputDir?: string
  checkpoint?: string
  negativePrompt?: string
  steps?: number
  cfgScale?: number
  samplerName?: string
  scheduler?: string
  width?: number
  height?: number
  strength?: number
  inpaintGrowMask?: number
  timeoutMs?: number
  pollIntervalMs?: number
  requestTimeoutMs?: number
  rembgNode?: string
  saveToComfyUI?: boolean
  writeMetadata?: boolean
}

/**
 * 解析完毕、可以放心使用的配置。
 *
 * 刻意**显式**列出每个键，而不是写 `Required<Omit<PluginConfigInput, ...>>`：
 * 那种映射类型一旦源接口带索引签名，TS 会把所有具名属性塌进索引签名，
 * 于是 `config.width` 就变成 `unknown` 了（踩过，编译器会直接报出来）。
 */
export interface ResolvedConfig {
  baseUrl: string
  outputDir?: string
  checkpoint?: string
  negativePrompt: string
  steps: number
  cfgScale: number
  samplerName: string
  scheduler: string
  width: number
  height: number
  strength: number
  inpaintGrowMask: number
  timeoutMs: number
  pollIntervalMs: number
  requestTimeoutMs: number
  rembgNode?: string
  saveToComfyUI: boolean
  writeMetadata: boolean
}

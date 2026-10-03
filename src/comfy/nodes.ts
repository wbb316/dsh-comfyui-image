/**
 * 能力探测层：把「本机 ComfyUI 到底有什么」问清楚，并把结果翻译成工作流能直接用的**事实**。
 *
 * 为什么单独一层：所有网络访问都集中在这里，`workflows.ts` 因此是纯函数、
 * 可以离线单测（见 test/test-workflows.mjs）。这个分界是刻意的。
 *
 * 探测三件事：
 *   1. 底模      —— 没指定就自动挑一个，并告诉用户有哪些可选
 *   2. 采样器    —— 校验 sampler_name / scheduler 是否真的存在，不存在就退默认并说明
 *   3. 背景移除  —— 纯核心 ComfyUI 没有去背节点，所以要按可用性挑一套第三方方案
 */
import type { ResolvedConfig } from '../types.js'
import { ImagePluginError } from '../errors.js'
import { logDebug } from '../log.js'
import type { ComfyNodeInfo, ComfyUIClient } from './client.js'
import type { ComfyNode, ComfyWorkflow } from '../types.js'

/* ────────────────────────── /object_info 的小工具 ────────────────────────── */

/**
 * ComfyUI 的输入项格式（实测于 /object_info）：
 *   ["INT",   { default: 20, min: 1, max: 10000 }]
 *   ["FLOAT", { default: 7.0, min: 0, max: 100 }]
 *   [["euler","dpmpp_2m"], { default: "euler" }]      ← 枚举：第一项是字符串数组
 *   ["IMAGE"], ["MASK"], ["MODEL"]                    ← 连线类
 */
export function declaredInputs(info: ComfyNodeInfo | undefined): Record<string, unknown> {
  return { ...(info?.input?.required ?? {}), ...(info?.input?.optional ?? {}) }
}

export function requiredInputs(info: ComfyNodeInfo | undefined): Record<string, unknown> {
  return { ...(info?.input?.required ?? {}) }
}

/** 枚举输入的可选值；不是枚举就返回 undefined。 */
export function enumChoices(spec: unknown): string[] | undefined {
  if (!Array.isArray(spec)) return undefined
  const first = spec[0]
  if (Array.isArray(first) && first.length > 0 && first.every((v) => typeof v === 'string')) {
    return first as string[]
  }
  return undefined
}

/** 输入项声明的类型名（"INT" / "STRING" / "IMAGE" / ...）。 */
export function inputTypeName(spec: unknown): string | undefined {
  if (Array.isArray(spec) && typeof spec[0] === 'string') return spec[0]
  return undefined
}

/** 输入项声明的默认值。 */
export function specDefault(spec: unknown): unknown {
  if (!Array.isArray(spec)) return undefined
  const meta = spec[1]
  if (meta && typeof meta === 'object' && 'default' in (meta as Record<string, unknown>)) {
    return (meta as Record<string, unknown>).default
  }
  return undefined
}

/** 在一组已声明的键名里，挑第一个命中候选名单的。 */
export function pickDeclaredKey(
  declared: Record<string, unknown>,
  candidates: readonly string[]
): string | undefined {
  for (const candidate of candidates) {
    if (candidate in declared) return candidate
  }
  return undefined
}

/** 只填「节点确实声明过」的键，避免把不存在的输入塞进去导致 /prompt 拒收。 */
export function fillInputs(
  info: ComfyNodeInfo | undefined,
  wanted: Record<string, unknown>
): Record<string, unknown> {
  const declared = declaredInputs(info)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(wanted)) {
    if (value !== undefined && key in declared) out[key] = value
  }
  return out
}

/**
 * 在 `fillInputs` 的基础上，把**我们没提供、但节点要求必填的枚举类输入**用它的默认值补上。
 *
 * 这是应对第三方节点参数名各异的关键一招：例如某个去背节点多出一个必填的 `model`，
 * 我们不需要知道它叫什么，只要它是个枚举，就能用节点自己的默认值填进去。
 * 只补枚举（不会误填 IMAGE 这类连线输入）。
 */
export function autoFillRequired(
  info: ComfyNodeInfo | undefined,
  wanted: Record<string, unknown>
): Record<string, unknown> {
  const out = fillInputs(info, wanted)
  const required = requiredInputs(info)
  for (const [key, spec] of Object.entries(required)) {
    if (key in out) continue
    const choices = enumChoices(spec)
    const fallback = specDefault(spec) ?? choices?.[0]
    if (fallback !== undefined) out[key] = fallback
  }
  return out
}

/* ────────────────────────────── 底模选择 ────────────────────────────── */

export interface CheckpointChoice {
  checkpoint: string
  available: string[]
}

/**
 * 挑底模：
 *   1. 用户/配置指定了，且确实存在 → 用它
 *   2. 没指定 → 优先带 "xl" 的（更通用），否则第一个
 *   3. 指定了但不存在 → **报错并列出可选项**（比默默换一个更可预测）
 */
export async function chooseCheckpoint(
  client: ComfyUIClient,
  preferred: string,
  signal?: AbortSignal
): Promise<CheckpointChoice> {
  const info = await client.nodeInfo('CheckpointLoaderSimple', signal)
  if (!info) {
    throw new ImagePluginError(
      'ComfyUI 里没有 CheckpointLoaderSimple 节点。',
      '这个节点是 ComfyUI 核心自带的。请确认 baseUrl 指向的是真的 ComfyUI，且版本不过旧。'
    )
  }
  const spec = requiredInputs(info).ckpt_name
  const available = enumChoices(spec) ?? []

  if (available.length === 0) {
    throw new ImagePluginError(
      'ComfyUI 报告没有任何可用的底模（models/checkpoints 是空的）。',
      '请往 ComfyUI 的 models/checkpoints 目录放一个 .safetensors / .ckpt 底模（例如 SDXL 或 SD1.5），' +
        '然后在 ComfyUI 界面里刷新一下。'
    )
  }

  if (preferred) {
    if (available.includes(preferred)) return { checkpoint: preferred, available }
    throw new ImagePluginError(
      `指定的底模不存在：${preferred}`,
      `本机可用的底模有：${available.slice(0, 12).join('、')}${available.length > 12 ? ` 等 ${available.length} 个` : ''}。` +
        '请把 model 改成其中之一，或清空该配置让插件自动挑。'
    )
  }

  const preferredDefault = available.find((name) => /xl/i.test(name)) ?? available[0]
  if (!preferredDefault) {
    throw new ImagePluginError('ComfyUI 返回的底模列表为空。', '请往 models/checkpoints 放一个底模。')
  }
  logDebug(`自动选用底模：${preferredDefault}（可选 ${available.length} 个）`)
  return { checkpoint: preferredDefault, available }
}

/* ────────────────────────────── 采样器校验 ────────────────────────────── */

export interface SamplerChoice {
  samplerName: string
  scheduler: string
  notes: string[]
}

/** 校验采样器/调度器：用户显式给的错了就报错；只是配置默认值错了就退回可用的并说明。 */
export async function chooseSampler(
  client: ComfyUIClient,
  request: { samplerName: string; scheduler: string },
  config: ResolvedConfig,
  signal?: AbortSignal
): Promise<SamplerChoice> {
  const info = await client.nodeInfo('KSampler', signal)
  const notes: string[] = []
  if (!info) {
    throw new ImagePluginError(
      'ComfyUI 里没有 KSampler 节点。',
      'KSampler 是 ComfyUI 核心节点，缺它说明地址可能不是 ComfyUI 服务。'
    )
  }
  const required = requiredInputs(info)
  const samplerOptions = enumChoices(required.sampler_name) ?? []
  const schedulerOptions = enumChoices(required.scheduler) ?? []

  const userPickedSampler = request.samplerName !== config.samplerName
  const userPickedScheduler = request.scheduler !== config.scheduler

  let samplerName = request.samplerName
  if (samplerOptions.length > 0 && !samplerOptions.includes(samplerName)) {
    const fallback = samplerOptions.includes(config.samplerName) ? config.samplerName : (samplerOptions[0] as string)
    if (userPickedSampler) {
      throw new ImagePluginError(
        `采样器不存在：${samplerName}`,
        `本机可用：${samplerOptions.join('、')}`
      )
    }
    notes.push(`采样器 ${samplerName} 在本机不存在，已改用 ${fallback}。`)
    samplerName = fallback
  }

  let scheduler = request.scheduler
  if (schedulerOptions.length > 0 && !schedulerOptions.includes(scheduler)) {
    const fallback = schedulerOptions.includes(config.scheduler) ? config.scheduler : (schedulerOptions[0] as string)
    if (userPickedScheduler) {
      throw new ImagePluginError(
        `调度器不存在：${scheduler}`,
        `本机可用：${schedulerOptions.join('、')}`
      )
    }
    notes.push(`调度器 ${scheduler} 在本机不存在，已改用 ${fallback}。`)
    scheduler = fallback
  }

  return { samplerName, scheduler, notes }
}

/* ────────────────────────── 背景移除策略探测 ────────────────────────── */

/** 一套去背方案的构建结果：节点表 + 最终 IMAGE 输出在哪里。 */
export interface RembgBuildResult {
  nodes: ComfyWorkflow
  output: [string, number]
}

/** 一套去背方案。`build` 在探测阶段就把节点定义闭包住了，之后是纯函数。 */
export interface RembgPlan {
  key: string
  label: string
  requiredNodes: string[]
  installHint: string
  build: (input: [string, number]) => RembgBuildResult
}

/** 图像输入键的候选名（不同作者的节点叫法不一）。 */
const IMAGE_KEY_CANDIDATES = ['image', 'images', 'input_image', 'img', 'pixels', 'image_in'] as const
/** 模型输入键的候选名。 */
const MODEL_KEY_CANDIDATES = [
  'model',
  'bria_rmbg_model',
  'rmbg_model',
  'bria_model',
  'session',
  'rembg_session'
] as const

interface RembgPreset {
  key: string
  label: string
  /** 依次尝试的节点组合；全部存在才算可用。 */
  chains: string[][]
  installHint: string
  /** 单节点方案：直接把输入图接进这个节点。 */
  single?: string
  /** 双节点方案：[加载器, 消费者]。 */
  pair?: [string, string]
}

/**
 * 已核实的第三方去背方案（precedence 从高到低）。
 * 纯核心 ComfyUI **没有**去背节点，所以这一节必然依赖 custom_nodes——
 * 缺依赖时给的是「装什么、怎么装」，而不是一句干巴巴的报错。
 *
 * 仓库与类名的对应关系取自 ComfyUI-Manager 的 extension-node-map.json（权威索引），
 * **不要凭记忆改**：索引里根本不存在叫 `RemBG` 的节点，也不存在
 * `Limbicnation/ComfyUI_RemBG-U2Net` 这个仓库——这类「听起来很合理」的名字是本文件
 * 早期版本的错误来源。改这里之前请先查索引，或直接看目标仓库的 NODE_CLASS_MAPPINGS。
 */
const REMBG_PRESETS: RembgPreset[] = [
  {
    key: 'essentials',
    label: 'ComfyUI_essentials（RemBGSession+ → ImageRemoveBackground+）',
    chains: [['RemBGSession+', 'ImageRemoveBackground+']],
    pair: ['RemBGSession+', 'ImageRemoveBackground+'],
    installHint:
      '装去背节点：git clone https://github.com/cubiq/ComfyUI_essentials 到 ComfyUI/custom_nodes/，' +
      '再用 ComfyUI 自己的 Python 执行 pip install "rembg[cpu]"（少了 [cpu] 就没有 onnxruntime 后端，' +
      'import rembg 会直接报错），然后重启 ComfyUI。首次去背会自动下载 u2net 权重（约 176MB）。'
  },
  {
    key: 'bria',
    label: 'ComfyUI-BRIA_AI-RMBG（BRIA_RMBG_ModelLoader_Zho → BRIA_RMBG_Zho）',
    chains: [['BRIA_RMBG_ModelLoader_Zho', 'BRIA_RMBG_Zho']],
    pair: ['BRIA_RMBG_ModelLoader_Zho', 'BRIA_RMBG_Zho'],
    installHint:
      '装去背节点：git clone https://github.com/ZHO-ZHO-ZHO/ComfyUI-BRIA_AI-RMBG 到 ComfyUI/custom_nodes/，' +
      '重启 ComfyUI；首次使用会自动下载 BRIA 权重。'
  },
  {
    key: 'layerstyle',
    label: 'ComfyUI-LayerStyle（LayerMask: RemBgUltra 节点）',
    chains: [['LayerMask: RemBgUltra']],
    single: 'LayerMask: RemBgUltra',
    installHint:
      '装去背节点：git clone https://github.com/chflame163/ComfyUI_LayerStyle 到 ComfyUI/custom_nodes/，' +
      '按它的 README 装依赖（rembg / onnxruntime），重启 ComfyUI。'
  },
  {
    key: 'was',
    label: 'WAS Node Suite（Image Rembg (Remove Background) 节点）',
    chains: [['Image Rembg (Remove Background)']],
    single: 'Image Rembg (Remove Background)',
    installHint:
      '装去背节点：git clone https://github.com/ltdrdata/was-node-suite-comfyui 到 ComfyUI/custom_nodes/，' +
      '按它的 requirements 装依赖（含 rembg / onnxruntime），重启 ComfyUI。'
  }
]

function buildSingle(className: string, info: ComfyNodeInfo | undefined, input: [string, number]): RembgBuildResult {
  const declared = declaredInputs(info)
  const imageKey = pickDeclaredKey(declared, IMAGE_KEY_CANDIDATES)
  if (!imageKey) {
    throw new ImagePluginError(
      `节点 ${className} 没有可识别的图像输入。`,
      `它声明的输入是：${Object.keys(declared).join('、') || '(空)'}。请把该节点的输入名告诉我，或改用别的去背节点。`
    )
  }
  const inputs = autoFillRequired(info, { [imageKey]: input })
  const node: ComfyNode = { class_type: className, inputs }
  return { nodes: { rb1: node }, output: ['rb1', 0] }
}

function buildPair(
  loader: string,
  consumer: string,
  loaderInfo: ComfyNodeInfo | undefined,
  consumerInfo: ComfyNodeInfo | undefined,
  input: [string, number]
): RembgBuildResult {
  const declared = declaredInputs(consumerInfo)
  const imageKey = pickDeclaredKey(declared, IMAGE_KEY_CANDIDATES)
  const modelKey = pickDeclaredKey(declared, MODEL_KEY_CANDIDATES)
  if (!imageKey) {
    throw new ImagePluginError(
      `节点 ${consumer} 没有可识别的图像输入。`,
      `它声明的输入是：${Object.keys(declared).join('、') || '(空)'}。`
    )
  }
  const wanted: Record<string, unknown> = { [imageKey]: input }
  if (modelKey) wanted[modelKey] = ['rb1', 0]
  const nodes: ComfyWorkflow = {
    rb1: { class_type: loader, inputs: autoFillRequired(loaderInfo, {}) },
    rb2: { class_type: consumer, inputs: autoFillRequired(consumerInfo, wanted) }
  }
  if (!modelKey) {
    throw new ImagePluginError(
      `节点 ${consumer} 没有可识别的模型输入。`,
      `它声明的输入是：${Object.keys(declared).join('、') || '(空)'}。`
    )
  }
  return { nodes, output: ['rb2', 0] }
}

/**
 * 挑一套可用的去背方案。
 *
 * @param forced 配置里 `rembgNode` 指定的方案 key 或节点类名；给了就只用它（不存在则明确报错）
 * @throws ImagePluginError 一套都不可用时，列出全部方案与安装方法
 */
export async function chooseRembgPlan(
  client: ComfyUIClient,
  forced: string | undefined,
  signal?: AbortSignal
): Promise<RembgPlan> {
  const all = await client.objectInfo(signal)
  const missing: RembgPreset[] = []

  const candidates = forced
    ? REMBG_PRESETS.filter(
        (preset) =>
          preset.key === forced ||
          preset.single === forced ||
          preset.chains.some((chain) => chain.includes(forced))
      )
    : REMBG_PRESETS

  if (forced && candidates.length === 0) {
    throw new ImagePluginError(
      `配置里的 rembgNode=${forced} 不在已知方案里。`,
      `已知：${REMBG_PRESETS.map((p) => `${p.key}（${p.label}）`).join('；')}`
    )
  }

  for (const preset of candidates) {
    const chain = preset.chains.find((nodes) => nodes.every((node) => node in all))
    if (!chain) {
      missing.push(preset)
      continue
    }
    logDebug(`去背方案选用：${preset.key}（${chain.join(' → ')}）`)
    const snapshot = all
    return {
      key: preset.key,
      label: preset.label,
      requiredNodes: chain,
      installHint: preset.installHint,
      build: (input: [string, number]): RembgBuildResult => {
        if (preset.single) return buildSingle(preset.single, snapshot[preset.single], input)
        const [loaderName, consumerName] = preset.pair as [string, string]
        return buildPair(loaderName, consumerName, snapshot[loaderName], snapshot[consumerName], input)
      }
    }
  }

  const tried = (forced ? candidates : missing).map((p) => `${p.label} → 需要节点 ${p.chains[0]?.join(' + ')}`).join('\n  ')
  throw new ImagePluginError(
    `本机 ComfyUI 里没有任何可用的背景移除节点。`,
    'remove_background 依赖第三方自定义节点（核心 ComfyUI 0.3x 起自带的 RemoveBackground 输出的是遮罩、' +
      '且需自备 models/background_removal 模型，本插件暂未接入）。已尝试：\n  ' +
      tried +
      `\n任选一套安装即可：\n  ${missing.map((p) => p.installHint).join('\n  ')}`
  )
}

/** 某个模式在这台 ComfyUI 上到底能不能跑——用于给出「为什么不行」的明确回答。 */
export async function checkModeSupport(
  client: ComfyUIClient,
  mode: string,
  signal?: AbortSignal
): Promise<{ supported: boolean; detail: string }> {
  if (mode !== 'remove_background') return { supported: true, detail: '核心节点，无需额外安装。' }
  try {
    const plan = await chooseRembgPlan(client, undefined, signal)
    return { supported: true, detail: `可用方案：${plan.label}` }
  } catch (error) {
    return {
      supported: false,
      detail: error instanceof ImagePluginError ? `${error.message}\n${error.hint ?? ''}`.trim() : String(error)
    }
  }
}

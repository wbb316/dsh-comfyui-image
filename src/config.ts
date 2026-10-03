/**
 * 配置解析。
 *
 * 优先级（**高的赢**）：
 *   1. 插件配置   —— profile 的 cordis.patch.yml 里那条 entry 的 `config:`（宿主注入的 `apply(ctx, config)`）
 *   2. 配置文件   —— `~/.dsh-comfyui-image/config.json`（不用重启 DSH、不用改 profile，最方便）
 *   3. 环境变量   —— `COMFYUI_URL` 等（适合容器 / 临时覆盖）
 *   4. 内置默认值 —— 本文件 DEFAULTS
 *
 * 为什么把「插件配置」放最高：DSH 的配置树是运维/宿主的权威来源，
 * 摆了 config 就该它说了算；配置文件是给「只想改个地址、不想动 YAML」的用户准备的便利层。
 *
 * 不依赖任何第三方 schema 库：Cordis 在插件没有导出 `Config` schema 时
 * 会把原始配置对象**原样**交给 `apply`（见 @deepseek-ai/cordis 的 resolveConfig 文档），
 * 所以这里手写校验就够了，也避免了 link 安装下的依赖解析问题。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PluginConfigInput, ResolvedConfig } from './types.js'
import { logDebug, logWarn } from './log.js'

/** 插件 id，同时用作配置目录名。 */
export const PLUGIN_ID = 'dsh-comfyui-image'

/** ComfyUI 默认地址。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8188'

/** 配置文件位置；测试可以用 `DSH_COMFYUI_IMAGE_CONFIG` 指到临时目录。 */
export const CONFIG_FILE =
  process.env.DSH_COMFYUI_IMAGE_CONFIG || path.join(os.homedir(), `.${PLUGIN_ID}`, 'config.json')

/** 内置默认值。 */
export const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  negativePrompt:
    'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry',
  steps: 20,
  cfgScale: 7,
  samplerName: 'euler',
  scheduler: 'normal',
  width: 1024,
  height: 1024,
  strength: 0.6,
  inpaintGrowMask: 6,
  timeoutMs: 300_000,
  pollIntervalMs: 700,
  requestTimeoutMs: 30_000,
  saveToComfyUI: true,
  writeMetadata: true
} as const

/** 环境变量名 → 插件配置键。 */
const ENV_KEYS: Record<string, keyof PluginConfigInput> = {
  COMFYUI_URL: 'baseUrl',
  COMFYUI_BASE_URL: 'baseUrl',
  COMFYUI_CHECKPOINT: 'checkpoint',
  COMFYUI_STEPS: 'steps',
  COMFYUI_CFG_SCALE: 'cfgScale',
  COMFYUI_SAMPLER: 'samplerName',
  COMFYUI_SCHEDULER: 'scheduler',
  COMFYUI_TIMEOUT_MS: 'timeoutMs',
  COMFYUI_REMBG_NODE: 'rembgNode',
  DSH_COMFYUI_IMAGE_OUTPUT: 'outputDir'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读配置文件；坏了就当没有，绝不因为这个把插件搞挂。 */
export function readConfigFile(): PluginConfigInput {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {}
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')
    const parsed: unknown = JSON.parse(raw)
    return isPlainObject(parsed) ? (parsed as PluginConfigInput) : {}
  } catch (error) {
    logWarn(`配置文件读不了，已忽略：${CONFIG_FILE}（${error instanceof Error ? error.message : String(error)}）`)
    return {}
  }
}

/** 把一份补丁合并进配置文件（留给以后的面板/CLI 用）。 */
export function writeConfigFile(patch: PluginConfigInput): void {
  const next = { ...readConfigFile(), ...patch }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

/** 从环境变量里抽配置。 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PluginConfigInput {
  const out: PluginConfigInput = {}
  for (const [envKey, configKey] of Object.entries(ENV_KEYS)) {
    const value = env[envKey]
    if (value !== undefined && value !== '') out[configKey] = value as never
  }
  return out
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

function pickNumber(min: number, max: number, ...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? Number(candidate) : candidate
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
      return value
    }
  }
  return undefined
}

function pickBoolean(...candidates: unknown[]): boolean | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'string') {
      if (candidate === '1' || candidate.toLowerCase() === 'true') return true
      if (candidate === '0' || candidate.toLowerCase() === 'false') return false
    }
  }
  return undefined
}

/**
 * 合并四层来源，产出可直接使用的配置。
 * 非法值（负数步数、非数字超时…）会被**丢掉并退回默认**，同时 debug 日志里留痕。
 */
export function resolveConfig(pluginConfig?: unknown, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const fromPlugin = isPlainObject(pluginConfig) ? (pluginConfig as PluginConfigInput) : {}
  const fromFile = readConfigFile()
  const fromEnv = configFromEnv(env)

  if (pluginConfig !== undefined && !isPlainObject(pluginConfig)) {
    logWarn('插件配置不是对象，已忽略（只认 JSON 对象）。')
  }

  const s = (...keys: (keyof PluginConfigInput)[]): unknown[] => [
    ...keys.map((key) => fromPlugin[key]),
    ...keys.map((key) => fromFile[key]),
    ...keys.map((key) => fromEnv[key])
  ]

  const baseUrl = pickString(...s('baseUrl')) ?? DEFAULTS.baseUrl
  const resolved: ResolvedConfig = {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    negativePrompt: pickString(...s('negativePrompt')) ?? DEFAULTS.negativePrompt,
    steps: Math.round(pickNumber(1, 500, ...s('steps')) ?? DEFAULTS.steps),
    cfgScale: pickNumber(0, 100, ...s('cfgScale')) ?? DEFAULTS.cfgScale,
    samplerName: pickString(...s('samplerName')) ?? DEFAULTS.samplerName,
    scheduler: pickString(...s('scheduler')) ?? DEFAULTS.scheduler,
    width: Math.round(pickNumber(64, 8192, ...s('width')) ?? DEFAULTS.width),
    height: Math.round(pickNumber(64, 8192, ...s('height')) ?? DEFAULTS.height),
    strength: pickNumber(0, 1, ...s('strength')) ?? DEFAULTS.strength,
    inpaintGrowMask: Math.round(pickNumber(0, 256, ...s('inpaintGrowMask')) ?? DEFAULTS.inpaintGrowMask),
    timeoutMs: Math.round(pickNumber(1_000, 3_600_000, ...s('timeoutMs')) ?? DEFAULTS.timeoutMs),
    pollIntervalMs: Math.round(pickNumber(100, 10_000, ...s('pollIntervalMs')) ?? DEFAULTS.pollIntervalMs),
    requestTimeoutMs: Math.round(
      pickNumber(1_000, 600_000, ...s('requestTimeoutMs')) ?? DEFAULTS.requestTimeoutMs
    ),
    saveToComfyUI: pickBoolean(...s('saveToComfyUI')) ?? DEFAULTS.saveToComfyUI,
    writeMetadata: pickBoolean(...s('writeMetadata')) ?? DEFAULTS.writeMetadata
  }

  const outputDir = pickString(...s('outputDir'))
  if (outputDir !== undefined) resolved.outputDir = outputDir
  const checkpoint = pickString(...s('checkpoint'))
  if (checkpoint !== undefined) resolved.checkpoint = checkpoint
  const rembgNode = pickString(...s('rembgNode'))
  if (rembgNode !== undefined) resolved.rembgNode = rembgNode

  logDebug('配置已解析', {
    baseUrl: resolved.baseUrl,
    configFile: CONFIG_FILE,
    fileExists: fs.existsSync(CONFIG_FILE),
    sources: { plugin: Object.keys(fromPlugin), file: Object.keys(fromFile), env: Object.keys(fromEnv) }
  })
  return resolved
}

/**
 * SD1.5 系底模最舒服的尺寸是 512，SDXL 系是 1024。
 * 用户没指定 width/height 时，按底模名字**轻量**挑一个默认值——
 * 规则很直白、写在这里，不做任何更深的猜测。
 */
export function suggestSizeForCheckpoint(checkpoint: string, config: ResolvedConfig): { width: number; height: number } {
  const name = checkpoint.toLowerCase()
  const looksLikeLegacy = /(^|[^a-z0-9])(sd[_ ]?1[._-]?5|sd15|v1-5|sd_v1)/.test(name) && !name.includes('xl')
  if (looksLikeLegacy) return { width: 512, height: 512 }
  return { width: config.width, height: config.height }
}

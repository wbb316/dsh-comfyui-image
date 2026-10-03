#!/usr/bin/env node
/**
 * dsh-comfyui-image 自检脚本（doctor）——「本机到底能不能出图」的体检报告。
 *
 * 用法：
 *   npm run doctor                      # 按当前配置体检
 *   npm run doctor -- --base-url http://192.168.1.9:8188
 *   npm run doctor -- --json            # 机器可读输出（给脚本/CI 用）
 *
 * 它做四件事：
 *   1. 打印**生效配置**（四层来源合并后的结果）与配置文件位置
 *   2. 探活 ComfyUI（/system_stats），打出它的版本与设备
 *   3. 列出底模 / 采样器 / 调度器的**真实可选值**（不是猜的，来自 /object_info）
 *   4. 逐模式判定 text2img / img2img / inpaint / remove_background 能不能跑，并给出缺什么
 *
 * 退出码：0 = 四种模式都可用；1 = 连不上 ComfyUI；2 = 连上了但有模式跑不了。
 * 刻意不抛异常堆栈：这是给人看的体检报告，不是测试。
 */
import process from 'node:process'
import { ComfyUIClient } from '../lib/comfy/client.js'
import { checkModeSupport, chooseCheckpoint, chooseRembgPlan, chooseSampler } from '../lib/comfy/nodes.js'
import { CONFIG_FILE, resolveConfig } from '../lib/config.js'
import { PLUGIN_VERSION } from '../lib/runner.js'
import { GENERATE_MODES } from '../lib/types.js'

/** 内置工作流用到的**核心**节点（核心 ComfyUI 自带，缺了说明地址不对或版本太旧）。 */
const CORE_NODES = [
  'CheckpointLoaderSimple',
  'CLIPTextEncode',
  'KSampler',
  'EmptyLatentImage',
  'VAEDecode',
  'VAEEncode',
  'VAEEncodeForInpaint',
  'LoadImage',
  'LoadImageMask',
  'SaveImage',
  'PreviewImage'
]

const MODE_LABELS = {
  text2img: '文生图 text2img',
  img2img: '图生图 img2img',
  inpaint: '局部重绘 inpaint',
  remove_background: '背景移除 remove_background'
}

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const baseUrlFlagIndex = argv.indexOf('--base-url')
const baseUrlFlag = baseUrlFlagIndex >= 0 ? argv[baseUrlFlagIndex + 1] : undefined
if (baseUrlFlag) process.env.COMFYUI_URL = baseUrlFlag

const report = {
  pluginVersion: PLUGIN_VERSION,
  configFile: CONFIG_FILE,
  reachable: false,
  comfyui: null,
  config: null,
  nodeCount: 0,
  missingCoreNodes: [],
  checkpoints: { available: [], chosen: null, error: null },
  sampler: { samplerName: null, scheduler: null, notes: [], error: null },
  rembg: { available: false, label: null, detail: null },
  modes: {},
  exitCode: 0
}

const lines = []
const say = (text = '') => {
  lines.push(text)
  if (!asJson) process.stdout.write(`${text}\n`)
}
const ok = (text) => say(`  \u2713 ${text}`)
const bad = (text) => say(`  \u2717 ${text}`)
const warn = (text) => say(`  ! ${text}`)

function fail(message, hint) {
  bad(message)
  if (hint) say(`    \u2192 ${hint}`)
}

async function main() {
  const config = resolveConfig()
  report.config = config

  say(`dsh-comfyui-image v${PLUGIN_VERSION} \u81ea\u68c0\uff08doctor\uff09`)
  say('')

  /* ── 1. 生效配置 ─────────────────────────────────────────── */
  say('\u3010\u914d\u7f6e\u3011')
  say(`  \u914d\u7f6e\u6587\u4ef6\uff1a${CONFIG_FILE}`)
  say(`  ComfyUI \u5730\u5740\uff1a${config.baseUrl}`)
  say(`  \u5e95\u6a21\uff1a${config.checkpoint ?? '(\u672a\u6307\u5b9a\uff0c\u81ea\u52a8\u6311\u4e00\u4e2a)'}`)
  say(`  \u9ed8\u8ba4\u91c7\u6837\uff1a${config.samplerName} / ${config.scheduler}\uff0csteps=${config.steps}\uff0ccfg=${config.cfgScale}`)
  say(`  \u9ed8\u8ba4\u5c3a\u5bf8\uff1a${config.width}x${config.height}\uff08SD1.5 \u7cfb\u4f1a\u81ea\u52a8\u964d\u5230 512\uff09`)
  say(`  \u8f93\u51fa\u76ee\u5f55\uff1a${config.outputDir ?? '(\u672a\u8bbe\uff0c\u9ed8\u8ba4\u5f53\u524d\u9879\u76ee\u6839\u76ee\u5f55)'}`)

  /* ── 2. 探活 ─────────────────────────────────────────────── */
  say('')
  say('\u3010\u8fde\u63a5\u3011')
  const client = new ComfyUIClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs })
  let stats
  try {
    stats = await client.systemStats()
    report.reachable = true
  } catch (error) {
    fail(`\u8fde\u4e0d\u4e0a ComfyUI\uff1a${config.baseUrl}`, error instanceof Error ? error.message : String(error))
    say('')
    say('  \u8bf7\u5148\u542f\u52a8\u672c\u5730 ComfyUI\uff08\u9ed8\u8ba4 127.0.0.1:8188\uff09\uff0c\u6216\u628a\u5730\u5740\u6539\u5bf9\uff1a')
    say(`    \u6539 ${CONFIG_FILE} \u91cc\u7684 baseUrl\uff0c\u6216\u8bbe\u73af\u5883\u53d8\u91cf COMFYUI_URL`)
    report.exitCode = 1
    return
  }

  const system = stats.system ?? {}
  const devices = Array.isArray(stats.devices) ? stats.devices : []
  report.comfyui = {
    version: system.comfyui_version ?? null,
    python: system.python_version ?? null,
    devices: devices.map((device) => ({
      name: device?.name ?? 'unknown',
      type: device?.type ?? 'unknown',
      vramFreeGb: typeof device?.vram_free === 'number' ? +(device.vram_free / 1024 ** 3).toFixed(2) : null
    }))
  }
  ok(`ComfyUI \u5728\u4f4d\uff1a${config.baseUrl}`)
  if (system.comfyui_version) ok(`\u7248\u672c\uff1a${system.comfyui_version}\uff08Python ${system.python_version ?? '?'}\uff09`)
  if (devices.length === 0) {
    warn('\u6ca1\u770b\u5230\u4efb\u4f55\u8bbe\u5907\uff08\u53ef\u80fd\u662f CPU-only \u6a21\u5f0f\uff0c\u51fa\u56fe\u4f1a\u5f88\u6162\uff09\u3002')
  } else {
    for (const device of report.comfyui.devices) {
      const vram = device.vramFreeGb === null ? '' : `\uff0c\u5269\u4f59\u663e\u5b58 ${device.vramFreeGb} GB`
      ok(`\u8bbe\u5907\uff1a${device.name}\uff08${device.type}${vram}\uff09`)
    }
  }

  /* ── 3. 节点能力 ─────────────────────────────────────────── */
  say('')
  say('\u3010\u80fd\u529b\u63a2\u6d4b\u3011')
  let all
  try {
    all = await client.objectInfo()
    report.nodeCount = Object.keys(all).length
    ok(`\u5171\u62a5\u544a ${report.nodeCount} \u4e2a\u8282\u70b9`)
  } catch (error) {
    fail(`\u8bfb /object_info \u5931\u8d25\uff1a${error instanceof Error ? error.message : String(error)}`)
    report.exitCode = 2
    return
  }

  report.missingCoreNodes = CORE_NODES.filter((name) => !(name in all))
  if (report.missingCoreNodes.length === 0) {
    ok('\u5185\u7f6e\u5de5\u4f5c\u6d41\u9700\u8981\u7684\u6838\u5fc3\u8282\u70b9\u5168\u5728')
  } else {
    fail(`\u7f3a\u6838\u5fc3\u8282\u70b9\uff1a${report.missingCoreNodes.join('\u3001')}`, '\u8fd9\u4e9b\u662f ComfyUI \u81ea\u5e26\u8282\u70b9\uff1a\u8bf7\u786e\u8ba4\u5730\u5740\u6307\u5411\u7684\u771f\u662f ComfyUI\uff0c\u4e14\u7248\u672c\u4e0d\u8fc7\u65e7\u3002')
  }

  try {
    const choice = await chooseCheckpoint(client, config.checkpoint ?? '')
    report.checkpoints.available = choice.available
    report.checkpoints.chosen = choice.checkpoint
    ok(`\u5e95\u6a21\uff1a\u5171 ${choice.available.length} \u4e2a\uff0c\u672c\u6b21\u4f1a\u7528\u300c${choice.checkpoint}\u300d`)
    const preview = choice.available.slice(0, 5).join('\u3001')
    say(`    ${preview}${choice.available.length > 5 ? ` \u2026\u7b49 ${choice.available.length} \u4e2a` : ''}`)
  } catch (error) {
    report.checkpoints.error = error instanceof Error ? error.message : String(error)
    fail(report.checkpoints.error, error?.hint)
  }

  try {
    const sampler = await chooseSampler(client, { samplerName: config.samplerName, scheduler: config.scheduler }, config)
    report.sampler.samplerName = sampler.samplerName
    report.sampler.scheduler = sampler.scheduler
    report.sampler.notes = sampler.notes
    ok(`\u91c7\u6837\uff1a${sampler.samplerName} / ${sampler.scheduler}`)
    for (const note of sampler.notes) warn(note)
  } catch (error) {
    report.sampler.error = error instanceof Error ? error.message : String(error)
    fail(report.sampler.error, error?.hint)
  }

  try {
    const plan = await chooseRembgPlan(client, config.rembgNode)
    report.rembg.available = true
    report.rembg.label = plan.label
    ok(`\u53bb\u80cc\u65b9\u6848\uff1a${plan.label}\uff08\u8282\u70b9 ${plan.requiredNodes.join(' \u2192 ')}\uff09`)
  } catch (error) {
    report.rembg.detail = error instanceof Error ? error.message : String(error)
    warn('remove_background \u4e0d\u53ef\u7528\uff08\u7eaf\u6838\u5fc3 ComfyUI \u6ca1\u6709\u53bb\u80cc\u80fd\u529b\uff0c\u9700\u88c5\u7b2c\u4e09\u65b9\u8282\u70b9\uff09\uff1a')
    for (const hint of String(error?.hint ?? report.rembg.detail).split('\n')) say(`    ${hint}`)
  }

  /* ── 4. 逐模式判定 ───────────────────────────────────────── */
  say('')
  say('\u3010\u6a21\u5f0f\u53ef\u7528\u6027\u3011')
  let unavailable = 0
  for (const mode of GENERATE_MODES) {
    const support = await checkModeSupport(client, mode)
    // 前三种模式还要有底模才算真能跑
    const hasCheckpoint = report.checkpoints.available.length > 0
    const usable = support.supported && (mode === 'remove_background' || hasCheckpoint)
    report.modes[mode] = { usable, detail: support.detail }
    if (usable) {
      ok(`${MODE_LABELS[mode]}\uff1a\u53ef\u7528`)
    } else {
      unavailable += 1
      fail(`${MODE_LABELS[mode]}\uff1a\u4e0d\u53ef\u7528`, hasCheckpoint ? support.detail : '\u6ca1\u6709\u4efb\u4f55\u5e95\u6a21\uff0c\u8bf7\u5148\u5f80 ComfyUI \u7684 models/checkpoints \u653e\u4e00\u4e2a\u3002')
    }
  }

  say('')
  if (unavailable === 0) {
    say('\u7ed3\u8bba\uff1a\u56db\u79cd\u6a21\u5f0f\u5168\u90e8\u53ef\u7528\uff0c\u53ef\u4ee5\u76f4\u63a5\u8ba9 Agent \u8c03 generate_image \u4e86\u3002')
  } else {
    say(`\u7ed3\u8bba\uff1a\u6709 ${unavailable} \u79cd\u6a21\u5f0f\u4e0d\u53ef\u7528\uff08\u8be6\u60c5\u89c1\u4e0a\uff09\uff1b\u5176\u4f59\u6a21\u5f0f\u4e0d\u53d7\u5f71\u54cd\u3002`)
    report.exitCode = 2
  }
}

try {
  await main()
} catch (error) {
  report.exitCode = report.exitCode || 1
  if (!asJson) {
    process.stderr.write(`\u81ea\u68c0\u672c\u8eab\u51fa\u9519\u4e86\uff1a${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  }
}

if (asJson) {
  report.text = lines.join('\n')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
process.exit(report.exitCode)

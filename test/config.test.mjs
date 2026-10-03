/**
 * 配置解析的测试：四层优先级 + 越界值兜底 + 默认输出目录语义。
 *
 * 所有用例都显式传 `env`，完全不读进程环境，避免受机器上真实
 * `COMFYUI_URL` 之类变量的影响。
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { DEFAULTS, resolveConfig } from '../lib/index.js'
import { isolatePluginConfig, tempDir } from './helpers.mjs'

const configFile = isolatePluginConfig()

function clean() {
  try {
    fs.rmSync(configFile, { force: true })
  } catch {
    /* 忽略 */
  }
}

test('什么都没配 → 用内置默认值', () => {
  clean()
  const config = resolveConfig(undefined, {})
  assert.equal(config.baseUrl, DEFAULTS.baseUrl)
  assert.equal(config.steps, DEFAULTS.steps)
  assert.equal(config.cfgScale, DEFAULTS.cfgScale)
  assert.equal(config.samplerName, DEFAULTS.samplerName)
  assert.equal(config.scheduler, DEFAULTS.scheduler)
})

test('默认不设 outputDir —— 这样默认输出才会落在「项目根目录」而不是 DSH 进程目录', () => {
  clean()
  const config = resolveConfig(undefined, {})
  assert.equal(config.outputDir, undefined)
})

test('环境变量能生效', () => {
  clean()
  const config = resolveConfig(undefined, {
    COMFYUI_URL: 'http://10.0.0.5:8188/',
    COMFYUI_CHECKPOINT: 'env-model.safetensors',
    COMFYUI_STEPS: '30',
    DSH_COMFYUI_IMAGE_OUTPUT: 'D:\\env-out'
  })
  assert.equal(config.baseUrl, 'http://10.0.0.5:8188', '结尾斜杠应被去掉')
  assert.equal(config.checkpoint, 'env-model.safetensors')
  assert.equal(config.steps, 30)
  assert.equal(config.outputDir, 'D:\\env-out')
})

test('优先级：插件配置 > 配置文件 > 环境变量', () => {
  clean()
  const env = { COMFYUI_URL: 'http://from-env:8188' }

  // 只有环境变量
  assert.equal(resolveConfig(undefined, env).baseUrl, 'http://from-env:8188')

  // 配置文件压过环境变量
  fs.writeFileSync(configFile, JSON.stringify({ baseUrl: 'http://from-file:8188' }), 'utf8')
  assert.equal(resolveConfig(undefined, env).baseUrl, 'http://from-file:8188')

  // 插件配置（cordis.patch.yml 里的 config）压过一切
  assert.equal(resolveConfig({ baseUrl: 'http://from-plugin:8188' }, env).baseUrl, 'http://from-plugin:8188')

  clean()
})

test('越界值被丢弃并退回默认（而不是把非法值传进 ComfyUI）', () => {
  clean()
  const config = resolveConfig(
    { steps: 9999, cfgScale: -5, pollIntervalMs: 5, timeoutMs: 10, width: 1, height: 999999 },
    {}
  )
  assert.equal(config.steps, DEFAULTS.steps)
  assert.equal(config.cfgScale, DEFAULTS.cfgScale)
  assert.equal(config.pollIntervalMs, DEFAULTS.pollIntervalMs)
  assert.equal(config.timeoutMs, DEFAULTS.timeoutMs)
  assert.equal(config.width, DEFAULTS.width)
  assert.equal(config.height, DEFAULTS.height)
})

test('插件配置不是对象 → 忽略并退回默认值，不抛异常', () => {
  clean()
  const config = resolveConfig('这不是配置', {})
  assert.equal(config.baseUrl, DEFAULTS.baseUrl)
})

test('配置文件损坏（非法 JSON）→ 当成没有，不拖垮插件', () => {
  clean()
  fs.writeFileSync(configFile, '{ 这不是合法 json', 'utf8')
  try {
    const config = resolveConfig(undefined, {})
    assert.equal(config.baseUrl, DEFAULTS.baseUrl, '坏配置应被忽略并退回默认值')
  } finally {
    clean()
  }
})

/**
 * Schema 守卫测试。
 *
 * 依据：`@deepseek-ai/dsh-tools/lib/types/json-schema.d.ts` 明载 ——
 *   "The subset accepts ... one scalar `type`, object `properties`/`required`/boolean
 *    `additionalProperties`, array `items`, type-correct scalar `enum`/`const`,
 *    and exact-one `oneOf`. **Unsupported or misplaced keywords reject rather than
 *    being accepted without enforcement.**"
 *
 * 也就是说 minimum / maximum / format / pattern 这类看着无害的关键字会让整个
 * 工具注册失败。所以这里把允许的关键字固化成白名单，把参数与输出 schema
 * 整棵树走一遍——以后谁手滑写个 `format` 会立刻红。
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { OUTPUT_SCHEMA, PARAMETERS_SCHEMA, TOOL_DESCRIPTION } from '../lib/index.js'

/** json-schema.d.ts 里逐字列出的允许字段。 */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples'
])

const SCALAR_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function walk(node, where, visit) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  visit(node, where)
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(node.properties)) {
      walk(child, `${where}.properties.${key}`, visit)
    }
  }
  if (node.items) walk(node.items, `${where}.items`, visit)
  if (Array.isArray(node.oneOf)) {
    node.oneOf.forEach((child, index) => walk(child, `${where}.oneOf[${index}]`, visit))
  }
}

function collect(node, where) {
  const problems = []
  walk(node, where, (current, at) => {
    for (const key of Object.keys(current)) {
      if (!ALLOWED_KEYWORDS.has(key)) {
        problems.push(`${at} 用了不被支持的 JSON Schema 关键字 "${key}"（DSH 会直接拒绝整个 schema）`)
      }
    }
    if (current.type !== undefined && !SCALAR_TYPES.has(current.type)) {
      problems.push(`${at}.type 不是合法标量类型：${JSON.stringify(current.type)}`)
    }
    if (current.enum !== undefined) {
      if (!Array.isArray(current.enum) || current.enum.length === 0) {
        problems.push(`${at}.enum 必须是非空数组`)
      } else {
        for (const value of current.enum) {
          const type = typeof value
          if (value !== null && type !== 'string' && type !== 'number' && type !== 'boolean') {
            problems.push(`${at}.enum 只能是标量，收到 ${type}`)
          }
        }
      }
    }
    if (current.const !== undefined) {
      const type = typeof current.const
      if (current.const !== null && type !== 'string' && type !== 'number' && type !== 'boolean') {
        problems.push(`${at}.const 只能是标量，收到 ${type}`)
      }
    }
    if (current.oneOf !== undefined && (!Array.isArray(current.oneOf) || current.oneOf.length < 2)) {
      problems.push(`${at}.oneOf 至少要有两个分支`)
    }
    if (current.required !== undefined) {
      if (!Array.isArray(current.required)) {
        problems.push(`${at}.required 必须是字符串数组（不是 required: true 这种写法）`)
      } else {
        const declared = Object.keys(current.properties ?? {})
        for (const name of current.required) {
          if (!declared.includes(name)) {
            problems.push(`${at}.required 里的 "${name}" 没有在 properties 里声明`)
          }
        }
      }
    }
    if (current.additionalProperties !== undefined && typeof current.additionalProperties !== 'boolean') {
      problems.push(`${at}.additionalProperties 只能是布尔值`)
    }
  })
  return problems
}

test('参数 schema：整棵树只用了 DSH 支持的 JSON Schema 子集', () => {
  const problems = collect(PARAMETERS_SCHEMA, 'parameters')
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('输出 schema：整棵树只用了 DSH 支持的 JSON Schema 子集', () => {
  const problems = collect(OUTPUT_SCHEMA, 'output.schema')
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('参数 schema：对象根 + 关闭多余字段（Agent 传错键会被明确拒绝）', () => {
  assert.equal(PARAMETERS_SCHEMA.type, 'object')
  assert.equal(PARAMETERS_SCHEMA.additionalProperties, false)
  assert.ok(Array.isArray(PARAMETERS_SCHEMA.required))
  assert.deepEqual(PARAMETERS_SCHEMA.required, [], 'V1 允许只传一个 prompt，所以不设必填项')
})

test('参数 schema：需求书第五节列的参数一个都不能少', () => {
  const expected = [
    'mode',
    'prompt',
    'negative_prompt',
    'input_image',
    'mask_image',
    'width',
    'height',
    'seed',
    'output_path',
    'style_reference',
    'character_reference',
    'strength',
    'steps',
    'cfg_scale',
    'extra_options'
  ]
  const declared = Object.keys(PARAMETERS_SCHEMA.properties)
  for (const name of expected) {
    assert.ok(declared.includes(name), `参数 schema 缺少需求书要求的 ${name}`)
  }
  // V1 为了「对 Agent 友好」额外提供的两个可选项
  assert.ok(declared.includes('model'), '应能指定底模')
  assert.ok(declared.includes('sampler_name'), '应能指定采样器')
})

test('参数 schema：mode 是枚举，且枚举值与运行时一致', () => {
  const mode = PARAMETERS_SCHEMA.properties.mode
  assert.deepEqual([...mode.enum].sort(), ['img2img', 'inpaint', 'remove_background', 'text2img'])
})

test('参数 schema：每个参数都写了 description（模型靠它决定怎么传）', () => {
  for (const [name, spec] of Object.entries(PARAMETERS_SCHEMA.properties)) {
    assert.equal(typeof spec.description, 'string', `参数 ${name} 缺少 description`)
    assert.ok(spec.description.length > 4, `参数 ${name} 的 description 太短，模型看不懂`)
  }
})

test('输出 schema：声明了验收要求的四类字段（路径/是否成功/说明/元数据）', () => {
  const required = OUTPUT_SCHEMA.required
  for (const key of ['text', 'path', 'files', 'success', 'mode', 'seed', 'width', 'height', 'model']) {
    assert.ok(required.includes(key), `输出 schema 应把 ${key} 列为必需`)
  }
  assert.equal(OUTPUT_SCHEMA.additionalProperties, false)
})

test('输出 schema：notes 与 files 是字符串数组', () => {
  assert.equal(OUTPUT_SCHEMA.properties.notes.type, 'array')
  assert.equal(OUTPUT_SCHEMA.properties.notes.items.type, 'string')
  assert.equal(OUTPUT_SCHEMA.properties.files.type, 'array')
  assert.equal(OUTPUT_SCHEMA.properties.files.items.type, 'string')
})

test('工具描述：说清后端是 ComfyUI、四种模式、以及「不传什么会自动补」', () => {
  assert.match(TOOL_DESCRIPTION, /ComfyUI/)
  for (const mode of ['text2img', 'img2img', 'inpaint', 'remove_background']) {
    assert.ok(TOOL_DESCRIPTION.includes(mode), `描述里应提到 ${mode}`)
  }
  assert.match(TOOL_DESCRIPTION, /mode/, '描述要让模型知道有 mode 参数')
})

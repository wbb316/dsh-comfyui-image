/**
 * 参数层（统一抽象参数层 + 智能默认值 + 模式推断）的离线测试。
 * 不联网、不起服务，纯函数验证。
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { inferMode, normalizeRequest, ImagePluginError } from '../lib/index.js'
import { tempDir, testConfig, writePng } from './helpers.mjs'

const cwd = tempDir('params')
const config = testConfig()

function normalize(args, overrides = {}) {
  return normalizeRequest(args, { cwd, config: overrides.config ?? config })
}

/* ─────────────────────────── 模式推断（三条规则） ─────────────────────────── */

test('推断：只有 prompt → text2img', () => {
  assert.equal(inferMode({ prompt: 'a cat' }), 'text2img')
  const { request, modeInferred } = normalize({ prompt: 'a cat' })
  assert.equal(request.mode, 'text2img')
  assert.equal(modeInferred, true)
})

test('推断：有 input_image → img2img', () => {
  const input = writePng(path.join(cwd, 'in.png'))
  assert.equal(inferMode({ prompt: 'x', input_image: input }), 'img2img')
  const { request, modeInferred } = normalize({ prompt: 'x', input_image: input })
  assert.equal(request.mode, 'img2img')
  assert.equal(modeInferred, true)
})

test('推断：input_image + mask_image → inpaint', () => {
  const input = writePng(path.join(cwd, 'in2.png'))
  const mask = writePng(path.join(cwd, 'mask2.png'))
  assert.equal(inferMode({ prompt: 'x', input_image: input, mask_image: mask }), 'inpaint')
  const { request } = normalize({ prompt: 'x', input_image: input, mask_image: mask })
  assert.equal(request.mode, 'inpaint')
})

test('显式 mode 优先于推断', () => {
  const input = writePng(path.join(cwd, 'in3.png'))
  const { request, modeInferred } = normalize({ mode: 'img2img', prompt: 'x', input_image: input })
  assert.equal(request.mode, 'img2img')
  assert.equal(modeInferred, false)
})

/* ───────────────────────── 冲突：明确报错，不猜 ───────────────────────── */

test('冲突：mode=text2img 却传了 input_image → 报错并给出改法', () => {
  const input = writePng(path.join(cwd, 'c1.png'))
  assert.throws(
    () => normalize({ mode: 'text2img', prompt: 'x', input_image: input }),
    (error) => {
      assert.ok(error instanceof ImagePluginError)
      assert.match(error.message, /text2img 不接受 input_image/)
      assert.match(error.hint, /img2img/)
      return true
    }
  )
})

test('冲突：mode=img2img 没给 input_image → 报错', () => {
  assert.throws(() => normalize({ mode: 'img2img', prompt: 'x' }), /img2img 需要 input_image/)
})

test('冲突：mode=inpaint 缺 mask_image → 报错', () => {
  const input = writePng(path.join(cwd, 'c2.png'))
  assert.throws(
    () => normalize({ mode: 'inpaint', prompt: 'x', input_image: input }),
    /inpaint 需要 mask_image/
  )
})

test('冲突：给了 mask 却没给 input → 报错', () => {
  const mask = writePng(path.join(cwd, 'c3.png'))
  assert.throws(() => normalize({ prompt: 'x', mask_image: mask }), /没有 input_image/)
})

test('冲突：mode=remove_background 缺 input_image → 报错', () => {
  assert.throws(
    () => normalize({ mode: 'remove_background' }),
    /remove_background 需要 input_image/
  )
})

test('冲突：不认识的 mode → 报错并列出支持的四种', () => {
  assert.throws(
    () => normalize({ mode: 'outpaint', prompt: 'x' }),
    (error) => {
      assert.match(error.message, /不认识的 mode/)
      assert.match(error.hint, /text2img \/ img2img \/ inpaint \/ remove_background/)
      return true
    }
  )
})

test('冲突：text2img 缺 prompt → 报错', () => {
  assert.throws(() => normalize({}), /text2img 需要 prompt/)
})

/* ─────────────────────────── 输入文件必须存在 ─────────────────────────── */

test('input_image 不存在 → 报错（不等到提交工作流才发现）', () => {
  assert.throws(
    () => normalize({ prompt: 'x', input_image: path.join(cwd, '查无此图.png') }),
    /input_image 指向的文件不存在/
  )
})

test('mask_image 不存在 → 报错', () => {
  const input = writePng(path.join(cwd, 'c4.png'))
  assert.throws(
    () => normalize({ prompt: 'x', input_image: input, mask_image: path.join(cwd, 'nope.png') }),
    /mask_image 指向的文件不存在/
  )
})

/* ─────────────────────────── 默认值与取值校验 ─────────────────────────── */

test('默认值：不传宽度/高度/种子/步数/CFG 全部有合理默认', () => {
  const { request } = normalize({ prompt: 'a cat' })
  assert.equal(request.width, config.width)
  assert.equal(request.height, config.height)
  assert.equal(request.steps, config.steps)
  assert.equal(request.cfgScale, config.cfgScale)
  assert.equal(request.samplerName, config.samplerName)
  assert.equal(request.scheduler, config.scheduler)
  assert.ok(Number.isInteger(request.seed) && request.seed >= 0 && request.seed <= 4294967295)
  assert.ok(request.negativePrompt.length > 0, '负向提示词应有默认值')
})

test('默认输出：落在 cwd（项目根目录）且文件名不重复', () => {
  const a = normalize({ prompt: 'a cat' }).request
  const b = normalize({ prompt: 'a cat' }).request
  assert.equal(path.dirname(a.outputPath), cwd)
  assert.match(path.basename(a.outputPath), /^comfyui-.*\.png$/)
  assert.notEqual(a.outputPath, b.outputPath, '两次调用不应撞同一个文件名')
})

test('默认输出从不覆盖：指定的文件已存在时自动改名', () => {
  const target = path.join(cwd, 'guarded.png')
  writePng(target)
  const { request } = normalize({ prompt: 'a cat', output_path: target })
  assert.equal(request.outputPath, path.join(cwd, 'guarded-1.png'))
})

test('seed=0 必须被当成有效值（不能被 ?? 兜底掉）', () => {
  const { request } = normalize({ prompt: 'a cat', seed: 0 })
  assert.equal(request.seed, 0)
})

test('尺寸对齐到 8 的倍数，并留下说明', () => {
  const { request } = normalize({ prompt: 'a cat', width: 513, height: 500 })
  assert.equal(request.width, 512)
  assert.equal(request.height, 504)
  assert.ok(request.notes.some((note) => note.includes('8 的倍数')))
})

test('width/height 超出范围 → 明确报错', () => {
  assert.throws(() => normalize({ prompt: 'x', width: 9000 }), /width 超出允许范围/)
  assert.throws(() => normalize({ prompt: 'x', steps: 0 }), /steps 超出允许范围/)
  assert.throws(() => normalize({ prompt: 'x', cfg_scale: 200 }), /cfg_scale 超出允许范围/)
  assert.throws(() => normalize({ prompt: 'x', strength: 2 }), /strength 超出允许范围/)
})

test('width 传字符串 → 报错（而不是悄悄 NaN）', () => {
  assert.throws(() => normalize({ prompt: 'x', width: '512' }), /width 必须是数字/)
})

test('img2img 传 width/height → 忽略并说明（画布由输入图决定）', () => {
  const input = writePng(path.join(cwd, 'c5.png'))
  const { request } = normalize({ prompt: 'x', input_image: input, width: 768, height: 768 })
  assert.ok(request.notes.some((note) => note.includes('由输入图决定')))
})

test('inpaint 默认 strength=1.0，img2img 用配置默认值', () => {
  const input = writePng(path.join(cwd, 'c6.png'))
  const mask = writePng(path.join(cwd, 'c7.png'))
  assert.equal(normalize({ prompt: 'x', input_image: input, mask_image: mask }).request.strength, 1)
  assert.equal(normalize({ prompt: 'x', input_image: input }).request.strength, config.strength)
})

test('remove_background 忽略 prompt 并留下说明', () => {
  const input = writePng(path.join(cwd, 'c8.png'))
  const { request } = normalize({ mode: 'remove_background', prompt: '不要提示词', input_image: input })
  assert.equal(request.prompt, '')
  assert.ok(request.notes.some((note) => note.includes('不使用 prompt')))
})

test('style_reference / character_reference 在 V1 只记录不参与生成', () => {
  const style = writePng(path.join(cwd, 'style.png'))
  const character = writePng(path.join(cwd, 'char.png'))
  const { request } = normalize({
    prompt: 'x',
    style_reference: style,
    character_reference: character
  })
  assert.equal(request.styleReference, style)
  assert.equal(request.characterReference, character)
  assert.ok(request.notes.some((note) => note.includes('style_reference')))
})

test('extra_options 非对象 → 安全降级为空对象', () => {
  assert.deepEqual(normalize({ prompt: 'x', extra_options: 'nope' }).request.extra, {})
  assert.deepEqual(normalize({ prompt: 'x', extra_options: { a: 1 } }).request.extra, { a: 1 })
})

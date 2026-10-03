/**
 * 文件与路径工具。
 *
 * 需求第七节要求：默认存到「项目根目录」、文件名自动生成绝不覆盖、
 * 输入文件不存在要报明确错误。这些小工具就是干这个的。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileMissing, ImagePluginError } from './errors.js'

/** 用户主目录（Windows 上优先 USERPROFILE）。 */
export function homeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || process.cwd()
}

/** 展开开头的 `~` / `~/`（Windows 用户也会这么写）。 */
export function expandHome(input: string): string {
  if (input === '~') return homeDir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homeDir(), input.slice(2))
  }
  return input
}

/** 相对路径按 `cwd` 解析成绝对路径；已经是绝对路径就原样规范化。 */
export function resolveUserPath(input: string, cwd: string): string {
  const expanded = expandHome(input)
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded))
}

/** 确保目录存在。 */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** 读取图片字节；不存在就抛带建议的错。 */
export function readImageBytes(filePath: string, kind: string): Buffer {
  if (!fs.existsSync(filePath)) throw fileMissing(kind, filePath)
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    throw new ImagePluginError(`${kind}不是一个文件：${filePath}`, '请给具体的图片文件路径，不要给目录。')
  }
  // 空文件早点拦下来：传给 ComfyUI 只会得到一句更难懂的报错
  if (stat.size === 0) {
    throw new ImagePluginError(
      `${kind}是一个空文件（0 字节）：${filePath}`,
      '这个文件里没有任何图像数据。常见原因是下载没下完、文件被清空，或者路径其实指向了一个占位文件。'
    )
  }
  return fs.readFileSync(filePath)
}

/** 文件是否存在且是文件。 */
export function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff'])

/** 看扩展名猜个 MIME，用于上传给 ComfyUI。 */
export function guessImageMime(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    case '.gif':
      return 'image/gif'
    case '.tiff':
      return 'image/tiff'
    default:
      return 'image/png'
  }
}

/** 从 ComfyUI 返回的 filename 里取扩展名（拿不到就用 .png）。 */
export function extensionOf(filename: string, fallback = '.png'): string {
  const ext = path.extname(filename).toLowerCase()
  return IMAGE_EXTS.has(ext) ? ext : fallback
}

/** 时间戳片段：20260928-153012。 */
export function timestampSlug(now: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/** 随机种子（0 ~ 2^32-1，ComfyUI 的 seed 是 int）。 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 4_294_967_295)
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6)
}

/**
 * 决定最终往哪个文件写。
 *
 * 规则（对应需求「默认保存位置」「避免覆盖」）：
 *   - `outputPath` 带图片扩展名 → 当成文件路径；已存在就插 `-1` / `-2` 后缀，**绝不覆盖**
 *   - 其余情况（没传 / 传的是目录 / 以分隔符结尾）→ 当成目录，
 *     文件名用 `comfyui-<时间戳>-<随机4位><扩展名>`
 */
export function planOutputFile(
  outputPath: string | undefined,
  cwd: string,
  extension = '.png'
): { filePath: string; directory: string } {
  const ext = extension.startsWith('.') ? extension : `.${extension}`
  const fallbackName = `comfyui-${timestampSlug()}-${randomSuffix()}${ext}`

  if (!outputPath || outputPath.trim() === '') {
    const directory = cwd
    ensureDir(directory)
    return { filePath: path.join(directory, fallbackName), directory }
  }

  const resolved = resolveUserPath(outputPath, cwd)
  const treatAsFile =
    IMAGE_EXTS.has(path.extname(resolved).toLowerCase()) && !/[/\\]$/.test(outputPath)

  if (!treatAsFile) {
    ensureDir(resolved)
    return { filePath: path.join(resolved, fallbackName), directory: resolved }
  }

  const directory = path.dirname(resolved)
  ensureDir(directory)
  if (!fs.existsSync(resolved)) return { filePath: resolved, directory }

  // 目标文件已存在：插 -1、-2…… 到第一个空位
  const base = path.basename(resolved, path.extname(resolved))
  const dir = path.dirname(resolved)
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base}-${i}${path.extname(resolved)}`)
    if (!fs.existsSync(candidate)) return { filePath: candidate, directory }
  }
  throw new ImagePluginError(
    `输出路径已被占满，找不到空位：${resolved}`,
    '换一个输出目录，或先清掉同名文件。'
  )
}

/** 人类可读的体积。 */
/**
 * 从图片字节里读出**真实**像素尺寸。
 *
 * 为什么需要它：img2img / inpaint / remove_background 的画布由输入图决定，请求里的
 * width/height 并不生效。报告里若照抄请求值，就会出现「元数据说 1024×1024、拿到的图
 * 其实是 512×512」这种自相矛盾（真机实测踩到过）。所以对外报的尺寸一律以产出字节为准。
 *
 * 只认 ComfyUI 会吐出来的两种：PNG（SaveImage 默认）与 JPEG（自定义工作流可能用）。
 * 认不出来就返回 undefined，由调用方兜底成请求值。
 */
export function imageSizeOf(bytes: Buffer): { width: number; height: number } | undefined {
  // PNG：签名 89 50 4E 47 0D 0A 1A 0A，IHDR 的宽/高在偏移 16 / 20（大端 4 字节）。
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  // JPEG：FF D8 之后扫段找 SOF（FFC0~FFCF，但要跳过 FFC4/FFC8/FFCC 这几个非 SOF 标记）。
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1] ?? 0
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const segmentSize = bytes.readUInt16BE(offset + 2)
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isStartOfFrame) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
      }
      if (segmentSize < 2) return undefined
      offset += 2 + segmentSize
    }
  }
  return undefined
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

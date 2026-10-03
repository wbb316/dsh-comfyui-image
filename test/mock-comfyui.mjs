/**
 * 假的 ComfyUI 服务，用于在「没装 ComfyUI」的机器上端到端验证本插件。
 *
 * 只实现插件真正用到的接口，但**行为尽量贴近真的 ComfyUI**：
 *   GET  /system_stats          健康检查
 *   GET  /object_info           节点清单（决定底模/采样器/去背方案怎么挑）
 *   GET  /object_info/{node}    单节点定义（插件优先走这个）
 *   POST /upload/image          multipart 上传输入图/遮罩
 *   POST /prompt                提交工作流
 *   GET  /history/{prompt_id}   轮询结果（前 N 次返回 {} 以模拟排队）
 *   GET  /view                  取回产出图片
 *   POST /interrupt             超时时插件会尽力取消
 *
 * 关键在于它**不是固定返回**：产出 PNG 的尺寸是从提交上来的
 * EmptyLatentImage 节点里读出来的。所以测试能断言「请求参数真的变成了图」，
 * 而不是只断言「有个文件被创建了」。
 */
import http from 'node:http'
import zlib from 'node:zlib'

/* ─────────────────────── 真·PNG 编码（不依赖任何库） ─────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/** 生成一张纯色 PNG（真图，带合法 IHDR/IDAT/IEND 与 CRC）。 */
export function makePng(width, height, rgb = [90, 140, 255]) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const stride = 1 + width * 3
  const row = Buffer.alloc(stride)
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0]
    row[2 + x * 3] = rgb[1]
    row[3 + x * 3] = rgb[2]
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** 读 PNG 的宽高（测试用来断言尺寸），非法就返回 null。 */
export function readPngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/* ─────────────────────────── /object_info 节点表 ─────────────────────────── */

function node(required, output, category = 'test') {
  return {
    input: { required, optional: {} },
    output,
    output_name: output.map((_, i) => `out${i}`),
    name: category,
    display_name: category,
    description: '',
    category,
    output_node: output.length === 0
  }
}

/**
 * 默认节点表 = 「一台装好了核心节点 + ComfyUI_essentials 去背节点对」的 ComfyUI。
 * inject 到 node.name 只是为了可读性，插件不读这个字段。
 */
export function defaultNodes(checkpoints = ['v1-5-pruned-emaonly.safetensors', 'sd_xl_base_1.0.safetensors']) {
  return {
    CheckpointLoaderSimple: node(
      { ckpt_name: [checkpoints, {}] },
      ['MODEL', 'CLIP', 'VAE'],
      'CheckpointLoaderSimple'
    ),
    CLIPTextEncode: node(
      { text: ['STRING', { multiline: true }], clip: ['CLIP'] },
      ['CONDITIONING'],
      'CLIPTextEncode'
    ),
    EmptyLatentImage: node(
      { width: ['INT', { default: 512 }], height: ['INT', { default: 512 }], batch_size: ['INT', { default: 1 }] },
      ['LATENT'],
      'EmptyLatentImage'
    ),
    KSampler: node(
      {
        model: ['MODEL'],
        seed: ['INT', { default: 0 }],
        steps: ['INT', { default: 20 }],
        cfg: ['FLOAT', { default: 8 }],
        sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m', 'ddim'], {}],
        scheduler: [['normal', 'karras', 'exponential'], {}],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', { default: 1 }]
      },
      ['LATENT'],
      'KSampler'
    ),
    VAEDecode: node({ samples: ['LATENT'], vae: ['VAE'] }, ['IMAGE'], 'VAEDecode'),
    VAEEncode: node({ pixels: ['IMAGE'], vae: ['VAE'] }, ['LATENT'], 'VAEEncode'),
    VAEEncodeForInpaint: node(
      { pixels: ['IMAGE'], vae: ['VAE'], mask: ['MASK'], grow_mask_by: ['INT', { default: 6 }] },
      ['LATENT'],
      'VAEEncodeForInpaint'
    ),
    SaveImage: node({ images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] }, [], 'SaveImage'),
    PreviewImage: node({ images: ['IMAGE'] }, [], 'PreviewImage'),
    LoadImage: node({ image: [[], { image_upload: true }] }, ['IMAGE', 'MASK'], 'LoadImage'),
    LoadImageMask: node(
      { image: [[], { image_upload: true }], channel: [['red', 'green', 'blue', 'alpha'], {}] },
      ['MASK'],
      'LoadImageMask'
    ),
    // 去背用 ComfyUI_essentials 的真实形态：session 节点（REMBG_SESSION）→ 消费节点。
    // 这正是插件第一优先级方案，单节点形态（只有 ImageRemoveBackground+）在真机上跑不通。
    // 类名**必须与真机注册键逐字一致**：essentials 的注册键是「RemBGSession+」（带加号，
    // 那个不加加号的 RemBGSession 只是 Python 类名，/object_info 里根本没有它）。
    'RemBGSession+': node(
      {
        model: [['u2net: general purpose', 'u2netp: lightweight general purpose', 'isnet-general-use: general purpose'], {}],
        providers: [['CPU', 'CUDA', 'DirectML'], {}]
      },
      ['REMBG_SESSION'],
      'RemBGSession+'
    ),
    'ImageRemoveBackground+': node(
      { rembg_session: ['REMBG_SESSION'], image: ['IMAGE'] },
      ['IMAGE', 'MASK'],
      'ImageRemoveBackground+'
    )
  }
}

/** 一个装了 BRIA 去背方案的 ComfyUI（用于测试方案择优顺序）。 */
export function briaNodes(checkpoints) {
  const base = defaultNodes(checkpoints)
  delete base['RemBGSession+']
  delete base['ImageRemoveBackground+']
  base.BRIA_RMBG_ModelLoader_Zho = node({ model: [['briaai/RMBG-1.4'], {}] }, ['RMBG_MODEL'], 'BRIA')
  base.BRIA_RMBG_Zho = node(
    { rmbg_model: ['RMBG_MODEL'], image: ['IMAGE'] },
    ['IMAGE', 'MASK'],
    'BRIA'
  )
  return base
}

/**
 * 一台只装了 WAS Node Suite 去背节点（**单节点**形态）的 ComfyUI。
 * 用来覆盖 buildSingle 分支——essentials 走的是双节点，单节点路径否则就没有真机形态的测试。
 */
export function wasNodes(checkpoints) {
  const base = defaultNodes(checkpoints)
  delete base['RemBGSession+']
  delete base['ImageRemoveBackground+']
  base['Image Rembg (Remove Background)'] = node({ images: ['IMAGE'] }, ['IMAGE', 'MASK'], 'WAS')
  return base
}

/* ─────────────────────────────── 假 ComfyUI ─────────────────────────────── */

/**
 * @param {object} [options]
 * @param {Record<string, unknown>} [options.nodes]            节点表
 * @param {number}  [options.pollsBeforeDone=2]               轮询几次后才出结果
 * @param {string}  [options.failMode]                        null | 'execution_error' | 'no_images' | 'hang' | 'reject'
 * @param {number}  [options.pngWidth], [options.pngHeight]   强制产出尺寸（默认从工作流读）
 */
export function createMockComfyUI(options = {}) {
  const state = {
    checkpoints: options.checkpoints ?? ['v1-5-pruned-emaonly.safetensors', 'sd_xl_base_1.0.safetensors'],
    nodes: options.nodes ?? defaultNodes(options.checkpoints),
    pollsBeforeDone: options.pollsBeforeDone ?? 2,
    failMode: options.failMode ?? null,
    stats: { system_stats: 0, object_info: 0, object_info_one: 0, upload: 0, prompt: 0, history: 0, view: 0, interrupt: 0 },
    prompts: new Map(),
    uploads: new Map(),
    lastPrompt: null,
    lastClientId: null,
    lastUploadFilename: null
  }

  function findNodeIdByClass(prompt, classTypes) {
    for (const [nodeId, nodeDef] of Object.entries(prompt ?? {})) {
      if (nodeDef && typeof nodeDef === 'object' && classTypes.includes(nodeDef.class_type)) return nodeId
    }
    return undefined
  }

  function outputSize() {
    if (options.pngWidth && options.pngHeight) return { width: options.pngWidth, height: options.pngHeight }
    const prompt = state.lastPrompt ?? {}
    const latentId = findNodeIdByClass(prompt, ['EmptyLatentImage'])
    const latent = latentId ? prompt[latentId] : undefined
    const width = Number(latent?.inputs?.width)
    const height = Number(latent?.inputs?.height)
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height }
    }
    // img2img / inpaint / 去背没有 EmptyLatentImage：真实 ComfyUI 的画布**跟输入图走**
    // （真机实测：512×512 的输入图产出 512 的图）。所以从 LoadImage 上传的那张图里读尺寸，
    // 而不是像以前那样一律回 64×64 —— 那样 mock 会谎报产出尺寸，把真实的不一致盖掉。
    const loadImageId = findNodeIdByClass(prompt, ['LoadImage'])
    const uploadedName = loadImageId ? prompt[loadImageId]?.inputs?.image : undefined
    const uploaded = typeof uploadedName === 'string' ? state.uploads.get(uploadedName) : undefined
    if (uploaded) {
      // 注意：state.uploads 里存的是**整个 multipart 报文**（PNG 之前还有边界与头），
      // 所以得先找到 PNG 签名，再从签名后 16 / 20 字节处读宽高，不能按偏移 0 直接读。
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const at = uploaded.indexOf(signature)
      if (at >= 0 && uploaded.length >= at + 24) {
        return { width: uploaded.readUInt32BE(at + 16), height: uploaded.readUInt32BE(at + 20) }
      }
    }
    return { width: 64, height: 64 }
  }

  function buildHistoryEntry(promptId) {
    const record = state.prompts.get(promptId)
    const prompt = record?.prompt ?? {}
    const entry = {
      prompt: [0, promptId, prompt, { client_id: state.lastClientId }, []],
      outputs: {},
      status: { status_str: 'success', completed: true, messages: [] }
    }

    if (state.failMode === 'execution_error') {
      entry.status = {
        status_str: 'error',
        completed: false,
        messages: [
          ['execution_start', { prompt_id: promptId }],
          [
            'execution_error',
            {
              prompt_id: promptId,
              node_id: findNodeIdByClass(prompt, ['KSampler']) ?? '5',
              node_type: 'KSampler',
              exception_message: 'CUDA out of memory（这是 mock 故意造的失败）',
              exception_type: 'RuntimeError'
            }
          ]
        ]
      }
      return entry
    }

    if (state.failMode === 'no_images') {
      // 跑完了，但没有任何图片产出（例如工作流末端没接 SaveImage）
      return entry
    }

    const saveId = findNodeIdByClass(prompt, ['SaveImage', 'PreviewImage'])
    const { width, height } = outputSize()
    if (saveId) {
      entry.outputs[saveId] = {
        images: [{ filename: `dsh-mock-${promptId}.png`, subfolder: '', type: 'output' }]
      }
    }
    entry.__mockPngSize = { width, height }
    return entry
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)

      const sendJson = (status, payload) => {
        const text = JSON.stringify(payload)
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
        res.end(text)
      }

      // ── 健康检查 ──
      if (url.pathname === '/system_stats') {
        state.stats.system_stats += 1
        return sendJson(200, {
          system: { os: 'mock', comfyui_version: '0.0.0-mock', python_version: '3.11.0', ram_total: 1 },
          devices: [{ name: 'mock-cpu', type: 'cpu', vram_total: 1, vram_free: 1 }]
        })
      }

      // ── 节点清单 ──
      if (url.pathname === '/object_info') {
        state.stats.object_info += 1
        return sendJson(200, state.nodes)
      }
      if (url.pathname.startsWith('/object_info/')) {
        state.stats.object_info_one += 1
        const classType = decodeURIComponent(url.pathname.slice('/object_info/'.length))
        const found = state.nodes[classType]
        // 真的 ComfyUI 对不存在的节点返回 {}，不是 404
        return sendJson(200, found ? { [classType]: found } : {})
      }

      // ── 上传 ──
      if (url.pathname === '/upload/image' && req.method === 'POST') {
        state.stats.upload += 1
        // 从 multipart 里抠出文件名（二进制用 latin1 读，文件名是 ASCII）
        const raw = body.toString('latin1')
        const match = /filename="([^"]*)"/.exec(raw)
        const name = match ? match[1] : `upload-${Date.now()}.png`
        state.uploads.set(name, body)
        state.lastUploadFilename = name
        return sendJson(200, { name, subfolder: '', type: 'input' })
      }

      // ── 提交工作流 ──
      if (url.pathname === '/prompt' && req.method === 'POST') {
        state.stats.prompt += 1
        let parsed
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          return sendJson(400, { error: { type: 'invalid_json', message: '请求体不是 JSON' } })
        }
        if (state.failMode === 'reject') {
          return sendJson(400, {
            error: { type: 'prompt_outputs_failed_validation', message: 'mock 拒绝' },
            node_errors: {
              '1': { errors: [{ type: 'value_not_in_list', message: 'ckpt_name 不在可用列表里' }] }
            }
          })
        }
        if (!parsed?.prompt || Object.keys(parsed.prompt).length === 0) {
          return sendJson(400, { error: { type: 'prompt_empty', message: '工作流是空的' } })
        }
        const promptId = `mock-${state.prompts.size + 1}-${Math.random().toString(36).slice(2, 8)}`
        state.prompts.set(promptId, { prompt: parsed.prompt, polls: 0 })
        state.lastPrompt = parsed.prompt
        state.lastClientId = parsed.client_id
        return sendJson(200, { prompt_id: promptId, number: state.prompts.size, node_errors: {} })
      }

      // ── 轮询历史 ──
      if (url.pathname.startsWith('/history/')) {
        state.stats.history += 1
        const promptId = decodeURIComponent(url.pathname.slice('/history/'.length))
        const record = state.prompts.get(promptId)
        if (!record) return sendJson(200, {})
        if (state.failMode === 'hang') return sendJson(200, {}) // 永远不出结果 → 测超时
        record.polls += 1
        if (record.polls < state.pollsBeforeDone) return sendJson(200, {})
        const entry = buildHistoryEntry(promptId)
        // 把 mock 造图的尺寸藏进 server 上，供 /view 使用
        server.__mockPngSize = entry.__mockPngSize
        delete entry.__mockPngSize
        return sendJson(200, { [promptId]: entry })
      }

      // ── 取图 ──
      if (url.pathname === '/view') {
        state.stats.view += 1
        if (state.failMode === 'view_500') {
          res.writeHead(500, { 'content-type': 'text/plain' })
          return res.end('mock: 取图失败')
        }
        const size = server.__mockPngSize ?? { width: 64, height: 64 }
        const png = makePng(size.width, size.height)
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length })
        return res.end(png)
      }

      // ── 取消 ──
      if (url.pathname === '/interrupt' && req.method === 'POST') {
        state.stats.interrupt += 1
        return sendJson(200, {})
      }

      return sendJson(404, { error: `mock 没有实现 ${req.method} ${url.pathname}` })
    })
  })

  return {
    state,
    server,
    /** 起服务并返回 baseUrl。 */
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      return `http://127.0.0.1:${port}`
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

/**
 * ComfyUI HTTP 客户端（只依赖 Node 内置 fetch / FormData / Blob，零第三方依赖）。
 *
 * 覆盖 V1 需要的全部接口：
 *   GET  /system_stats          健康检查
 *   GET  /object_info           节点清单（用来做能力探测与底模自动发现）
 *   POST /upload/image          把本地图传进 ComfyUI 的 input 目录
 *   POST /prompt                提交工作流
 *   GET  /history/{prompt_id}   轮询执行结果
 *   GET  /view                  取回产出的图片字节
 *   POST /interrupt             取消执行
 *
 * 所有网络错误都翻译成「看得懂 + 知道怎么办」的 ImagePluginError。
 */
import type { ComfyImageRef, ComfyWorkflow } from '../types.js'
import { comfyUnreachable, executionFailed, ImagePluginError } from '../errors.js'
import { logDebug } from '../log.js'

/** `/object_info` 里单个节点的描述（只声明我们会用到的字段）。 */
export interface ComfyNodeInfo {
  name?: string
  display_name?: string
  category?: string
  output?: unknown[]
  output_name?: unknown[]
  input?: {
    required?: Record<string, unknown>
    optional?: Record<string, unknown>
  }
}

/** `/history/{id}` 里一条记录（只声明我们会用到的字段）。 */
export interface ComfyHistoryEntry {
  outputs?: Record<string, { images?: ComfyImageRef[]; [key: string]: unknown }>
  status?: {
    status_str?: string
    completed?: boolean
    messages?: unknown[]
  }
}

export interface ComfyClientOptions {
  baseUrl: string
  requestTimeoutMs: number
}

export interface UploadResult {
  name: string
  subfolder: string
  type: string
}

/** 把外部 AbortSignal 和超时合成一个 signal，并保留「谁触发的」信息。 */
function linkSignal(
  external: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = (): void => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onAbort)
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    },
    timedOut: () => timedOut
  }
}

export class ComfyUIClient {
  private readonly baseUrl: string
  private readonly requestTimeoutMs: number
  /** `/object_info` 缓存：这个响应可能好几 MB，同一进程里没必要反复拉。 */
  private objectInfoCache?: { fetchedAt: number; data: Record<string, ComfyNodeInfo> }

  constructor(options: ComfyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.requestTimeoutMs = options.requestTimeoutMs
  }

  get url(): string {
    return this.baseUrl
  }

  private async request(
    pathname: string,
    init: RequestInit,
    external?: AbortSignal,
    timeoutMs = this.requestTimeoutMs
  ): Promise<Response> {
    const linked = linkSignal(external, timeoutMs)
    const target = `${this.baseUrl}${pathname}`
    try {
      logDebug(`HTTP ${init.method ?? 'GET'} ${target}`)
      const response = await fetch(target, { ...init, signal: linked.signal })
      return response
    } catch (error) {
      if (linked.timedOut()) {
        throw new ImagePluginError(
          `请求 ComfyUI 超时：${target}（超过 ${timeoutMs} ms）`,
          'ComfyUI 可能在忙或卡住了，稍后重试；也可以在配置里调大 requestTimeoutMs。'
        )
      }
      if (external?.aborted) {
        throw new ImagePluginError('已取消：调用方中止了本次生成。')
      }
      throw comfyUnreachable(this.baseUrl, error)
    } finally {
      linked.dispose()
    }
  }

  private async json<T>(pathname: string, init: RequestInit, external?: AbortSignal, timeoutMs?: number): Promise<T> {
    const response = await this.request(pathname, init, external, timeoutMs)
    const text = await response.text()
    if (!response.ok) {
      throw this.httpError(pathname, response.status, text)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ImagePluginError(
        `ComfyUI 返回的不是合法 JSON（${pathname}）：${text.slice(0, 300)}`,
        '这通常意味着地址指向了别的服务（比如一个普通网页服务器）。请确认 baseUrl 真的是 ComfyUI。'
      )
    }
  }

  private httpError(pathname: string, status: number, body: string): ImagePluginError {
    const snippet = body.slice(0, 500).replace(/\s+/g, ' ').trim()
    if (status === 404) {
      return new ImagePluginError(
        `ComfyUI 上找不到接口 ${pathname}（404）。`,
        '请确认这个地址真的是 ComfyUI 服务，且版本不太旧（/prompt、/history 都是标准接口）。'
      )
    }
    return new ImagePluginError(
      `ComfyUI 返回 HTTP ${status}（${pathname}）：${snippet || '(空响应)'}`,
      '去看一眼 ComfyUI 的控制台输出，那里通常有更具体的报错。'
    )
  }

  /** 健康检查：真的连着 ComfyUI 吗？ */
  async systemStats(external?: AbortSignal): Promise<Record<string, unknown>> {
    return this.json<Record<string, unknown>>('/system_stats', { method: 'GET' }, external, 8_000)
  }

  /** 拿节点清单（带缓存）。 */
  async objectInfo(external?: AbortSignal, maxAgeMs = 60_000): Promise<Record<string, ComfyNodeInfo>> {
    const now = Date.now()
    if (this.objectInfoCache && now - this.objectInfoCache.fetchedAt < maxAgeMs) {
      return this.objectInfoCache.data
    }
    const data = await this.json<Record<string, ComfyNodeInfo>>(
      '/object_info',
      { method: 'GET' },
      external,
      30_000
    )
    this.objectInfoCache = { fetchedAt: now, data }
    logDebug(`已获取 /object_info，共 ${Object.keys(data).length} 个节点`)
    return data
  }

  /** 单个节点的定义（优先走 /object_info/{node}，失败则回退到整表）。 */
  async nodeInfo(classType: string, external?: AbortSignal): Promise<ComfyNodeInfo | undefined> {
    try {
      const single = await this.json<Record<string, ComfyNodeInfo>>(
        `/object_info/${encodeURIComponent(classType)}`,
        { method: 'GET' },
        external,
        20_000
      )
      if (single && typeof single === 'object' && single[classType]) return single[classType]
      if (single && typeof single === 'object' && Object.keys(single).length > 0) {
        return Object.values(single)[0]
      }
    } catch (error) {
      logDebug(`/object_info/${classType} 不可用，回退整表`, String(error))
    }
    const all = await this.objectInfo(external)
    return all[classType]
  }

  /** 判断节点在不在（做能力探测用）。 */
  async hasNode(classType: string, external?: AbortSignal): Promise<boolean> {
    return (await this.nodeInfo(classType, external)) !== undefined
  }

  /** 把本地图片上传进 ComfyUI 的 input 目录。 */
  async uploadImage(
    input: { filename: string; bytes: Buffer; mime: string; subfolder?: string; overwrite?: boolean },
    external?: AbortSignal
  ): Promise<UploadResult> {
    const form = new FormData()
    // 不依赖全局 File，用 Blob + 第三个参数给文件名（Node 20+ 的 undici 支持）
    const blob = new Blob([new Uint8Array(input.bytes)], { type: input.mime })
    form.append('image', blob, input.filename)
    form.append('overwrite', input.overwrite === false ? 'false' : 'true')
    if (input.subfolder) form.append('subfolder', input.subfolder)
    form.append('type', 'input')

    const result = await this.json<UploadResult>(
      '/upload/image',
      { method: 'POST', body: form },
      external,
      60_000
    )
    logDebug('上传图片成功', result)
    return result
  }

  /**
   * 提交工作流。
   * ComfyUI 在节点校验失败时会返回 400 + `node_errors`，这里把它翻译成人能看的错误。
   */
  async queuePrompt(
    workflow: ComfyWorkflow,
    clientId: string,
    external?: AbortSignal
  ): Promise<{ promptId: string }> {
    const response = await this.request(
      '/prompt',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: clientId })
      },
      external,
      60_000
    )
    const text = await response.text()
    let parsed: { prompt_id?: string; node_errors?: Record<string, unknown>; error?: unknown }
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch {
      throw new ImagePluginError(
        `提交工作流失败：ComfyUI 返回的不是 JSON（HTTP ${response.status}）。`,
        text.slice(0, 300)
      )
    }

    const nodeErrors = parsed.node_errors && Object.keys(parsed.node_errors).length > 0 ? parsed.node_errors : undefined
    if (!response.ok || nodeErrors || !parsed.prompt_id) {
      const detail = nodeErrors
        ? Object.entries(nodeErrors)
            .map(([nodeId, value]) => {
              const errors =
                value && typeof value === 'object' && 'errors' in value
                  ? JSON.stringify((value as { errors: unknown }).errors)
                  : JSON.stringify(value)
              return `节点 ${nodeId}: ${errors}`
            })
            .join('；')
        : JSON.stringify(parsed.error ?? text.slice(0, 400))
      throw new ImagePluginError(
        `工作流被 ComfyUI 拒绝（HTTP ${response.status}）：${detail}`,
        '最常见的原因是工作流引用的模型/节点在本机不存在，或者某个参数类型不对。' +
          '检查 generate_image 传的 model（底模文件名）是否与 ComfyUI 的 models/checkpoints 下的一致。'
      )
    }
    logDebug(`已提交工作流，prompt_id=${parsed.prompt_id}`)
    return { promptId: parsed.prompt_id }
  }

  /** 查一条历史记录；还没跑完就是 undefined。 */
  async historyEntry(promptId: string, external?: AbortSignal): Promise<ComfyHistoryEntry | undefined> {
    const data = await this.json<Record<string, ComfyHistoryEntry>>(
      `/history/${encodeURIComponent(promptId)}`,
      { method: 'GET' },
      external
    )
    return data[promptId]
  }

  /** 取回产出图片的字节。 */
  async viewImage(ref: ComfyImageRef, external?: AbortSignal): Promise<Buffer> {
    const params = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder ?? '',
      type: ref.type || 'output'
    })
    const response = await this.request(`/view?${params.toString()}`, { method: 'GET' }, external, 120_000)
    if (!response.ok) {
      const body = await response.text()
      throw this.httpError(`/view?${params.toString()}`, response.status, body)
    }
    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }

  /** 取消当前正在跑的任务（尽力而为，失败不影响主流程）。 */
  async interrupt(external?: AbortSignal): Promise<void> {
    try {
      await this.json<unknown>('/interrupt', { method: 'POST' }, external, 10_000)
    } catch (error) {
      logDebug('interrupt 失败（忽略）', String(error))
    }
  }
}

/**
 * 从历史记录的 status 里抽出「到底哪儿错了」，拼成一句能读懂的话。
 * ComfyUI 把错误塞在 `status.messages` 的数组里，形如：
 *   [["execution_start", {...}], ["execution_error", { node_id, node_type, exception_message, ... }]]
 */
export function describeHistoryError(entry: ComfyHistoryEntry, promptId: string): ImagePluginError {
  const messages = entry.status?.messages ?? []
  for (const message of messages) {
    if (!Array.isArray(message) || message.length < 2) continue
    const [kind, payload] = message as [unknown, unknown]
    if (kind === 'execution_error' && payload && typeof payload === 'object') {
      const info = payload as Record<string, unknown>
      const parts = [
        info.node_type ? `节点类型 ${String(info.node_type)}` : '',
        info.node_id ? `(id=${String(info.node_id)})` : '',
        info.exception_type ? `异常 ${String(info.exception_type)}` : '',
        info.exception_message ? `: ${String(info.exception_message)}` : ''
      ].filter(Boolean)
      return executionFailed(parts.join(' ') || '未知执行错误', promptId)
    }
    if (kind === 'execution_interrupted') {
      return new ImagePluginError(
        `ComfyUI 执行被中断（prompt_id=${promptId}）。`,
        '可能是有人在 ComfyUI 界面里点了 Cancel，或插件取消了任务。重试一次即可。'
      )
    }
  }
  return executionFailed(`状态为 ${String(entry.status?.status_str ?? 'error')}，但没有更多细节`, promptId)
}

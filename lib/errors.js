/**
 * 插件自己的错误类型。
 *
 * 为什么要专门定义：DSH 会把我抛出的 `message` 直接给模型看，
 * 所以报错信息必须**能指导下一步动作**（去启动 ComfyUI / 检查路径 / 装节点），
 * 而不是甩一句 `fetch failed`。`hint` 用来放「怎么办」。
 */
/** 所有本插件主动抛出的错误的基类。 */
export class ImagePluginError extends Error {
    /** 给用户/模型看的下一步建议。 */
    hint;
    constructor(message, hint) {
        super(message);
        this.name = 'ImagePluginError';
        if (hint)
            this.hint = hint;
    }
}
/** 拼一句完整的报错：主信息 + 可选的下一步建议。 */
export function formatError(error) {
    if (error instanceof ImagePluginError) {
        return error.hint ? `${error.message}\n下一步：${error.hint}` : error.message;
    }
    if (error instanceof Error)
        return error.message;
    return String(error);
}
/** ComfyUI 连不上（没启动 / 地址写错 / 端口不对）。 */
export function comfyUnreachable(baseUrl, cause) {
    const detail = cause instanceof Error ? `（${cause.message}）` : '';
    return new ImagePluginError(`连不上 ComfyUI：${baseUrl}${detail}`, '请先启动本地 ComfyUI 服务（默认监听 127.0.0.1:8188），或把地址改对——' +
        '改 ~/.dsh-comfyui-image/config.json 里的 baseUrl，或设环境变量 COMFYUI_URL=http://主机:端口。');
}
/** 输入/输出文件不存在。 */
export function fileMissing(kind, path) {
    return new ImagePluginError(`${kind}不存在：${path}`, '请确认路径写对了、且用的是绝对路径或相对于当前工作目录的路径。');
}
/** 参数互相冲突（刻意不做黑盒猜测，冲突就报错）。 */
export function argConflict(message, hint) {
    return new ImagePluginError(message, hint);
}
/** 需要的 ComfyUI 节点不存在。 */
export function nodeMissing(classType, hint) {
    return new ImagePluginError(`ComfyUI 里没有节点 \`${classType}\``, hint);
}
/** 工作流在 ComfyUI 里执行失败。 */
export function executionFailed(detail, promptId) {
    return new ImagePluginError(`ComfyUI 执行工作流失败（prompt_id=${promptId}）：${detail}`, '常见的两个原因：工作流里用到的节点/模型在本机不存在（去 ComfyUI 控制台看红色报错），或者显存不足。' +
        '也可以用模型参数覆盖：generate_image 的 model / steps / width / height 调小一点重试。');
}
/** 超时。 */
export function timedOut(waitedMs, promptId, baseUrl) {
    return new ImagePluginError(`等待 ComfyUI 出图超时（等了 ${Math.round(waitedMs / 1000)} 秒，prompt_id=${promptId}）`, `确认 ${baseUrl} 那边的 ComfyUI 是不是卡住了、或正在跑别的任务（可看它的队列）。` +
        '也可以在配置里把 timeoutMs 调大。');
}

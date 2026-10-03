/**
 * 极简日志：只输出带 `[dsh-comfyui-image]` 前缀的行，且只在需要时才啰嗦。
 *
 * 默认是**安静**的：正常出图只在 debug 下打日志，避免污染 DSH 会话输出。
 * 打开方式：环境变量 `DSH_COMFYUI_IMAGE_DEBUG=1`。
 */
const PREFIX = '[dsh-comfyui-image]';
const debugEnabled = () => {
    const raw = process.env.DSH_COMFYUI_IMAGE_DEBUG;
    return raw === '1' || raw === 'true' || raw === 'yes';
};
/** 重要的生命周期信息（插件加载、工具注册、配置异常）——总是打。 */
export function logInfo(message) {
    console.log(`${PREFIX} ${message}`);
}
/** 警告——总是打，但只用于「能用，但你要知道」的情况。 */
export function logWarn(message) {
    console.warn(`${PREFIX} ${message}`);
}
/** 调试细节（HTTP 请求、节点探测、工作流）——需要 DSH_COMFYUI_IMAGE_DEBUG=1。 */
export function logDebug(message, detail) {
    if (!debugEnabled())
        return;
    if (detail === undefined) {
        console.log(`${PREFIX} ${message}`);
        return;
    }
    let rendered;
    try {
        rendered = typeof detail === 'string' ? detail : JSON.stringify(detail);
    }
    catch {
        rendered = String(detail);
    }
    console.log(`${PREFIX} ${message} ${rendered}`);
}

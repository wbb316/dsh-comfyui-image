/**
 * 插件入口（宿主侧）。
 *
 * 挂载方式：DSH 的 Loader 读到本包后调用 `apply(ctx, config)`；
 * `inject = ['tools']` 保证 `ctx.reflect.get('tools')` 拿得到工具注册表。
 *
 * ⚠️ 血泪经验（跟 dsh-novel 一致，踩过）：插件里**不要 import 任何 `@deepseek-ai/*` 宿主包**。
 * link 安装时 Node 从物理路径往上找 node_modules，必然 ERR_MODULE_NOT_FOUND。
 * `tools.register()` 接受普通对象，所以完全不需要类型导入。
 */
import { resolveConfig } from './config.js';
import { logInfo, logWarn } from './log.js';
import { PLUGIN_VERSION } from './runner.js';
import { createGenerateImageTool, TOOL_NAME } from './tool.js';
/** 插件名（同时是 loader entry 的默认 id）。 */
export const name = 'dsh-comfyui-image';
/** 依赖的工具注册表服务。 */
export const inject = ['tools'];
/** 取工具注册表；拿不到返回 undefined（插件不该因此把 DSH 拖垮）。 */
function getToolRegistry(ctx) {
    const candidates = [];
    if (typeof ctx.reflect?.get === 'function') {
        candidates.push(ctx.reflect.get('tools', false));
        candidates.push(ctx.reflect.get('tools'));
    }
    if (typeof ctx.get === 'function')
        candidates.push(ctx.get('tools'));
    for (const candidate of candidates) {
        if (candidate && typeof candidate.register === 'function') {
            return candidate;
        }
    }
    return undefined;
}
/**
 * 插件主体。
 *
 * @param ctx    宿主上下文
 * @param config 插件配置（cordis.patch.yml 里 `config:` 的内容，可为空）
 */
export function apply(ctx, config) {
    const tools = getToolRegistry(ctx);
    if (!tools) {
        logWarn('拿不到 tools 服务，generate_image 未注册（请在 profile 里确认插件依赖正常）。');
        return;
    }
    tools.register(createGenerateImageTool(config));
    // 启动时只打一行摘要：**不**在加载阶段发网络请求，避免拖慢 DSH 启动。
    const resolved = resolveConfig(config);
    logInfo(`v${PLUGIN_VERSION} 已就绪，注册工具 ${TOOL_NAME}（四种模式）。ComfyUI 地址：${resolved.baseUrl}` +
        (resolved.checkpoint ? `，底模：${resolved.checkpoint}` : '，底模：自动选择'));
    if (resolved.baseUrl.includes('0.0.0.0')) {
        logWarn('baseUrl 里是 0.0.0.0，浏览器地址栏能用，但作为请求目标请改成 127.0.0.1。');
    }
}
/* ─────────────── 给本地测试用的再导出（不启动 DSH 也能单测） ─────────────── */
export { ComfyUIClient } from './comfy/client.js';
export { chooseCheckpoint, chooseRembgPlan, chooseSampler, declaredInputs, enumChoices, pickDeclaredKey } from './comfy/nodes.js';
export { buildWorkflow, buildText2Img, buildImg2Img, buildInpaint, buildRemoveBackground, filenamePrefixFor, applyCustomWorkflow } from './comfy/workflows.js';
export { DEFAULTS, CONFIG_FILE, readConfigFile, resolveConfig, suggestSizeForCheckpoint, writeConfigFile } from './config.js';
export { formatError, ImagePluginError } from './errors.js';
export { guessImageMime, planOutputFile, randomSeed, timestampSlug } from './files.js';
export { inferMode, normalizeRequest } from './params.js';
export { formatResult, renderResultText } from './result.js';
export { runGeneration, pickImageRef, PLUGIN_VERSION } from './runner.js';
export { createGenerateImageTool, PARAMETERS_SCHEMA, OUTPUT_SCHEMA, TOOL_DESCRIPTION, TOOL_NAME, resolveCwd } from './tool.js';

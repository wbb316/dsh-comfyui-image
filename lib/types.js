/**
 * 全插件共享的类型定义。
 *
 * 设计原则（对应需求书第五节「统一抽象参数层」）：
 *   - `GenerateImageArgs`   = **对外**契约，就是 Agent 看到的那些参数，尽量少、尽量好懂。
 *   - `NormalizedRequest`   = **对内**契约，默认值全部填好、模式已确定、路径已解析，
 *                            后面所有模块（工作流构建 / 执行 / 落盘）只认它。
 *   两层分开的好处：以后要改 ComfyUI 细节，只动工作流模块；要加对外参数，只动 args + params。
 */
/** 顺序即「模式推断」的判定顺序，别随意改。 */
export const GENERATE_MODES = [
    'text2img',
    'img2img',
    'inpaint',
    'remove_background'
];
export function isGenerateMode(value) {
    return typeof value === 'string' && GENERATE_MODES.includes(value);
}

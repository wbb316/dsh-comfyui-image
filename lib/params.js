import { isGenerateMode } from './types.js';
import { argConflict } from './errors.js';
import { suggestSizeForCheckpoint } from './config.js';
import { isFile, planOutputFile, randomSeed, resolveUserPath } from './files.js';
/** 需要提示词的模式。 */
const NEEDS_PROMPT = ['text2img', 'img2img', 'inpaint'];
/** 需要输入图的模式。 */
const NEEDS_INPUT = ['img2img', 'inpaint', 'remove_background'];
/**
 * 模式推断——规则只有三条，写死在下面，README 里也原样抄了一份。
 * 推断不出来时默认 text2img。
 */
export function inferMode(args) {
    const hasInput = typeof args.input_image === 'string' && args.input_image.trim() !== '';
    const hasMask = typeof args.mask_image === 'string' && args.mask_image.trim() !== '';
    if (hasInput && hasMask)
        return 'inpaint';
    if (hasInput)
        return 'img2img';
    return 'text2img';
}
function requirePositiveInt(value, name, min, max) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw argConflict(`${name} 必须是数字，收到的是 ${JSON.stringify(value)}。`);
    }
    const rounded = Math.round(value);
    if (rounded < min || rounded > max) {
        throw argConflict(`${name} 超出允许范围 ${min}~${max}，收到 ${value}。`);
    }
    return rounded;
}
function requireRangeNumber(value, name, min, max) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw argConflict(`${name} 必须是数字，收到的是 ${JSON.stringify(value)}。`);
    }
    if (value < min || value > max) {
        throw argConflict(`${name} 超出允许范围 ${min}~${max}，收到 ${value}。`);
    }
    return value;
}
/** 尺寸对齐到 8 的倍数（ComfyUI 的硬要求），并如实说明改了没有。 */
function alignTo8(value, notes, label) {
    const aligned = Math.max(64, Math.round(value / 8) * 8);
    if (aligned !== value)
        notes.push(`${label} 已从 ${value} 对齐到 8 的倍数：${aligned}（ComfyUI 要求）`);
    return aligned;
}
/**
 * 主入口：把 Agent 给的松散参数，变成严格、可执行、有默认值的请求。
 *
 * @throws ImagePluginError 参数冲突、取值范围不对、输入文件不存在时抛出。
 */
export function normalizeRequest(args, options) {
    const { cwd, config } = options;
    const notes = [];
    // ── 1. 定模式 ────────────────────────────────────────────────
    const explicit = args.mode;
    if (explicit !== undefined && !isGenerateMode(explicit)) {
        throw argConflict(`不认识的 mode：${JSON.stringify(explicit)}`, 'V1 支持 text2img / img2img / inpaint / remove_background 四种。');
    }
    const modeInferred = explicit === undefined;
    const mode = explicit ?? inferMode(args);
    // ── 2. 输入文件：先 resolve，再查存在性（早点报错，别等跑完工作流才发现）──
    const trimOrUndefined = (value) => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    const rawInput = trimOrUndefined(args.input_image);
    const rawMask = trimOrUndefined(args.mask_image);
    const rawStyle = trimOrUndefined(args.style_reference);
    const rawCharacter = trimOrUndefined(args.character_reference);
    const inputImage = rawInput ? resolveUserPath(rawInput, cwd) : undefined;
    const maskImage = rawMask ? resolveUserPath(rawMask, cwd) : undefined;
    const styleReference = rawStyle ? resolveUserPath(rawStyle, cwd) : undefined;
    const characterReference = rawCharacter ? resolveUserPath(rawCharacter, cwd) : undefined;
    // ── 3. 冲突检查：宁可报错，也不猜 ────────────────────────────
    if (maskImage !== undefined && inputImage === undefined) {
        throw argConflict('给了 mask_image 却没有 input_image。', '局部重绘需要「原图 + 遮罩」两张图：请同时传 input_image 和 mask_image。');
    }
    if (mode === 'text2img' && inputImage !== undefined) {
        throw argConflict(`mode=text2img 不接受 input_image（收到 ${inputImage}）。`, '想基于这张图改，请显式传 mode="img2img"（要局部改就再带上 mask_image 并传 mode="inpaint"）。');
    }
    if (mode === 'text2img' && maskImage !== undefined) {
        throw argConflict('mode=text2img 不接受 mask_image。', '请显式传 mode="inpaint"。');
    }
    if (mode === 'img2img' && maskImage !== undefined) {
        throw argConflict('mode=img2img 不接受 mask_image（有遮罩属于局部重绘）。', '请改传 mode="inpaint"；如果你确实只想整体重绘，就不要再传 mask_image。');
    }
    if (NEEDS_INPUT.includes(mode) && inputImage === undefined) {
        throw argConflict(`mode=${mode} 需要 input_image，但没收到。`, '请传 input_image="图片路径"（绝对路径或相对当前工作目录）。');
    }
    if (mode === 'inpaint' && maskImage === undefined) {
        throw argConflict('mode=inpaint 需要 mask_image，但没收到。', 'V1 要求显式提供遮罩：白色/亮色区域 = 要重绘的区域，尺寸需与 input_image 一致。');
    }
    if (inputImage !== undefined && !isFile(inputImage)) {
        throw argConflict(`input_image 指向的文件不存在：${inputImage}`, '请检查路径是否正确。');
    }
    if (maskImage !== undefined && !isFile(maskImage)) {
        throw argConflict(`mask_image 指向的文件不存在：${maskImage}`, '请检查路径是否正确。');
    }
    if (styleReference !== undefined && !isFile(styleReference)) {
        throw argConflict(`style_reference 指向的文件不存在：${styleReference}`, '请检查路径是否正确。');
    }
    if (characterReference !== undefined && !isFile(characterReference)) {
        throw argConflict(`character_reference 指向的文件不存在：${characterReference}`, '请检查路径是否正确。');
    }
    if (styleReference !== undefined || characterReference !== undefined) {
        notes.push('style_reference / character_reference 在 V1 只做记录（写入元数据），暂不参与生成。');
    }
    // ── 4. 提示词 ────────────────────────────────────────────────
    const promptRaw = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (NEEDS_PROMPT.includes(mode) && promptRaw === '') {
        throw argConflict(`mode=${mode} 需要 prompt，但没收到。`, mode === 'text2img'
            ? '请用英文或中文描述你想要的画面，例如 prompt="a corgi astronaut, digital art"。'
            : '图生图 / 局部重绘也要提示词来描述「改成什么样」。');
    }
    if (mode === 'remove_background' && promptRaw !== '') {
        notes.push('remove_background 不使用 prompt，已忽略。');
    }
    const prompt = NEEDS_PROMPT.includes(mode) ? promptRaw : '';
    const negativePrompt = typeof args.negative_prompt === 'string' && args.negative_prompt.trim() !== ''
        ? args.negative_prompt.trim()
        : config.negativePrompt;
    // ── 5. 底模：没指定就让工作流模块去自动挑；挑了才能定默认尺寸 ──
    const checkpoint = typeof args.model === 'string' && args.model.trim() !== ''
        ? args.model.trim()
        : (config.checkpoint ?? '');
    const sizeHint = suggestSizeForCheckpoint(checkpoint, config);
    // 这两个标记是给 runner 用的：此处底模可能还没定（用户没传 model、配置也没写 checkpoint 时
    // 要靠 chooseCheckpoint 自动挑），所以「没显式给」的维度得等底模选定后再自适应一次。
    const widthFromArgs = args.width !== undefined && args.width !== null;
    const heightFromArgs = args.height !== undefined && args.height !== null;
    let width = Math.round(requirePositiveInt(args.width, 'width', 64, 8192) ?? sizeHint.width);
    let height = Math.round(requirePositiveInt(args.height, 'height', 64, 8192) ?? sizeHint.height);
    // 只有 text2img 的尺寸是「我说了算」；另外三种模式的画布由输入图决定
    if (mode !== 'text2img' && (args.width !== undefined || args.height !== undefined)) {
        notes.push(`${mode} 的输出尺寸由输入图决定，width/height 已忽略` +
            `（你传的是 ${args.width ?? '-'}x${args.height ?? '-'}）。`);
    }
    const seed = requirePositiveInt(args.seed, 'seed', 0, 4_294_967_295) ?? randomSeed();
    const steps = requirePositiveInt(args.steps, 'steps', 1, 500) ?? config.steps;
    const cfgScale = requireRangeNumber(args.cfg_scale, 'cfg_scale', 0, 100) ?? config.cfgScale;
    const defaultStrength = mode === 'inpaint' ? 1.0 : config.strength;
    const strength = requireRangeNumber(args.strength, 'strength', 0, 1) ?? defaultStrength;
    if (mode === 'remove_background' && args.strength !== undefined) {
        notes.push('remove_background 不使用 strength，已忽略。');
    }
    const samplerName = typeof args.sampler_name === 'string' && args.sampler_name.trim() !== ''
        ? args.sampler_name.trim()
        : config.samplerName;
    const scheduler = typeof args.scheduler === 'string' && args.scheduler.trim() !== ''
        ? args.scheduler.trim()
        : config.scheduler;
    // 尺寸只对 text2img 有意义，另外对齐 8 的倍数
    if (mode === 'text2img') {
        width = alignTo8(width, notes, 'width');
        height = alignTo8(height, notes, 'height');
    }
    // ── 6. 输出位置 ──────────────────────────────────────────────
    const outputHint = typeof args.output_path === 'string' && args.output_path.trim() !== ''
        ? args.output_path.trim()
        : config.outputDir;
    const planned = planOutputFile(outputHint, cwd);
    const extra = args.extra_options && typeof args.extra_options === 'object' && !Array.isArray(args.extra_options)
        ? args.extra_options
        : {};
    const request = {
        mode,
        prompt,
        negativePrompt,
        width,
        height,
        widthFromArgs,
        heightFromArgs,
        seed,
        strength,
        steps,
        cfgScale,
        checkpoint,
        samplerName,
        scheduler,
        outputPath: planned.filePath,
        notes,
        extra
    };
    if (inputImage !== undefined)
        request.inputImage = inputImage;
    if (maskImage !== undefined)
        request.maskImage = maskImage;
    if (styleReference !== undefined)
        request.styleReference = styleReference;
    if (characterReference !== undefined)
        request.characterReference = characterReference;
    return { request, modeInferred };
}
/**
 * 底模最终选定后，补上「按底模自适应」的默认尺寸。
 *
 * 为什么不在参数层一次定完：解析参数时，用户可能既没传 model、配置里也没写 checkpoint，
 * 此时底模要等 runner 里的 `chooseCheckpoint` 从 ComfyUI 自动挑（更晚），参数层只能先落配置默认值。
 * 少了这一步，工具说明里的「尺寸按底模自动（SDXL 系 1024，SD1.5 系 512）」
 * 在最常见的默认路径上就是一句空话——本机实测正是如此：只有 SD1.5 底模时仍出 1024×1024。
 *
 * 只影响 text2img：另外三种模式的画布由输入图决定。
 */
export function applyModelAwareSize(request, checkpoint, config, notes) {
    if (request.mode !== 'text2img')
        return;
    if (request.widthFromArgs && request.heightFromArgs)
        return;
    const hint = suggestSizeForCheckpoint(checkpoint, config);
    const before = `${request.width}x${request.height}`;
    if (!request.widthFromArgs)
        request.width = alignTo8(hint.width, notes, 'width');
    if (!request.heightFromArgs)
        request.height = alignTo8(hint.height, notes, 'height');
    const after = `${request.width}x${request.height}`;
    if (before !== after) {
        notes.push(`未指定尺寸：按底模 ${checkpoint} 自适应为 ${after}（自适应前为 ${before}，可用 width/height 覆盖）。`);
    }
}

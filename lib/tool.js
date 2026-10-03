/**
 * 对外工具契约：**唯一**暴露给 Agent 的工具 `generate_image`（需求书第四节「单工具风格」）。
 *
 * 这个文件只干三件事：工具名/描述、参数 JSON Schema、输出契约。真正的执行在 runner.ts。
 * 之所以把契约单独拿出来，是为了让「对外接口稳定」——以后换后端、加模式，这里尽量不动。
 *
 * ⚠️ 两条硬约束（基于对 @deepseek-ai/dsh-tools 类型定义的实际核对，不是猜的）：
 *   1. `parameters` 必须是**原始 JSON Schema**，不是那种 `required: true` 的 DSL 写法。
 *   2. DSH 的 JSON Schema 子集是**强制**的：`minimum` / `maximum` / `format` 之类
 *      不支持的键会被**直接拒绝**（见 json-schema.d.ts 的 assertSupportedJsonSchema）。
 *      所以范围只写在 description 里，靠运行时校验兜底。
 */
import { resolveConfig } from './config.js';
import { formatError } from './errors.js';
import { logDebug } from './log.js';
import { GENERATE_MODES } from './types.js';
import { runGeneration } from './runner.js';
import { formatResult, renderFailureText } from './result.js';
/** 工具名。需求书建议的就是它。 */
export const TOOL_NAME = 'generate_image';
/** 给模型看的工具说明。写得啰嗦一点是刻意的：Agent 只看这一处就能用对。 */
export const TOOL_DESCRIPTION = [
    '生成、修改或去背景一张图片（本地 ComfyUI 后端）。一个工具覆盖四种模式，模式可以不传、由参数自动推断。',
    '',
    '模式 mode：',
    '  text2img          文生图：只给 prompt。',
    '  img2img           图生图：prompt + input_image。',
    '  inpaint           局部重绘：prompt + input_image + mask_image（遮罩里白色/亮色区域 = 要重绘的区域）。',
    '  remove_background 背景移除：只给 input_image，不需要 prompt。',
    '',
    '不传 mode 时的推断规则：有 input_image 和 mask_image → inpaint；只有 input_image → img2img；都没有 → text2img。',
    '参数冲突（例如 mode=text2img 却给了 input_image）会直接报错，不会猜。',
    '',
    '默认值：尺寸按底模自动（SDXL 系 1024，SD1.5 系 512）；seed 随机；steps 20；cfg_scale 7；',
    '输出落到当前项目根目录，文件名自动带时间戳，绝不覆盖已有文件。',
    '',
    '用法要点：',
    '  - 返回文本里的「图片：<绝对路径>」就是成品，可以直接把它引用给用户看。',
    '  - 想复现同一张图：把上次返回的 seed 原样传回来。想微调：改 prompt 或换 seed。',
    '  - width/height 只对 text2img 生效；img2img / inpaint 的画布由输入图决定。',
    '  - input_image / mask_image / output_path 都是本机路径：绝对路径，或相对当前工作目录。',
    '  - 需要 ComfyUI 正在运行（默认 http://127.0.0.1:8188）；没启动时会明确报错。',
    '  - remove_background 需要 ComfyUI 装第三方去背节点；缺了会报错并指出该装哪个。',
    '',
    '风格/角色一致性（style_reference / character_reference）V1 只写入元数据，暂不参与生成。'
].join('\n');
/** 参数的原始 JSON Schema（只用 DSH 支持的子集）。 */
export const PARAMETERS_SCHEMA = {
    type: 'object',
    properties: {
        mode: {
            type: 'string',
            enum: [...GENERATE_MODES],
            description: '操作模式。不传则自动推断：有 input_image+mask_image → inpaint；只有 input_image → img2img；都没有 → text2img。'
        },
        prompt: {
            type: 'string',
            description: '正向提示词。text2img / img2img / inpaint 必填；remove_background 不需要。'
        },
        negative_prompt: {
            type: 'string',
            description: '负向提示词（不想出现的东西）。不传用插件默认值。'
        },
        input_image: {
            type: 'string',
            description: '输入图片路径。img2img / inpaint / remove_background 必填。'
        },
        mask_image: {
            type: 'string',
            description: '遮罩图片路径，仅 inpaint 用。白色/亮色区域 = 要重绘的区域，尺寸需与 input_image 一致。'
        },
        width: {
            type: 'integer',
            description: '输出宽度（64~8192，会自动对齐到 8 的倍数）。仅 text2img 生效；不传按底模自动。'
        },
        height: {
            type: 'integer',
            description: '输出高度（64~8192，会自动对齐到 8 的倍数）。仅 text2img 生效；不传按底模自动。'
        },
        seed: {
            type: 'integer',
            description: '随机种子（0~4294967295）。不传则随机；传上次返回的 seed 可复现同一张图。'
        },
        output_path: {
            type: 'string',
            description: '输出目录，或带图片扩展名的具体文件路径。不传则存到当前项目根目录。目标已存在时会自动加 -1/-2 后缀，绝不覆盖。'
        },
        style_reference: {
            type: 'string',
            description: '【预留】风格参考图路径。V1 只记录进元数据，不参与生成。'
        },
        character_reference: {
            type: 'string',
            description: '【预留】角色参考图路径。V1 只记录进元数据，不参与生成。'
        },
        strength: {
            type: 'number',
            description: '改动幅度 0~1。img2img 默认 0.6（越小越贴近原图），inpaint 默认 1.0。'
        },
        steps: { type: 'integer', description: '采样步数（1~500），默认 20。越大越细、越慢。' },
        cfg_scale: { type: 'number', description: '提示词贴合度 CFG（0~100），默认 7。' },
        model: {
            type: 'string',
            description: '底模文件名（ComfyUI 的 models/checkpoints 下的名字）。不传则自动挑一个可用的。'
        },
        sampler_name: { type: 'string', description: '采样器，例如 euler / dpmpp_2m。不传用默认值。' },
        scheduler: { type: 'string', description: '调度器，例如 normal / karras。不传用默认值。' },
        extra_options: {
            type: 'object',
            additionalProperties: true,
            description: '扩展字段（预留）。其中 workflow_path 可以指向一个 API 格式工作流 JSON，' +
                '用 {{prompt}} / {{seed}} / {{input_image}} 等占位符接管本次生成——用来支持本插件还没内置的能力（扩图、超分等）。'
        }
    },
    required: [],
    additionalProperties: false
};
/** 输出的原始 JSON Schema。 */
export const OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        text: { type: 'string', description: '给模型看的完整结果说明' },
        path: { type: 'string', description: '产出图片的绝对路径' },
        files: { type: 'array', items: { type: 'string' }, description: '本次产出的全部文件路径' },
        mode: { type: 'string', description: '实际使用的模式' },
        seed: { type: 'integer', description: '本次使用的种子' },
        width: { type: 'integer', description: '输出宽度' },
        height: { type: 'integer', description: '输出高度' },
        steps: { type: 'integer', description: '采样步数' },
        cfg_scale: { type: 'number', description: 'CFG' },
        strength: { type: 'number', description: '改动幅度' },
        model: { type: 'string', description: '实际使用的底模' },
        sampler: { type: 'string', description: '采样器' },
        scheduler: { type: 'string', description: '调度器' },
        prompt_id: { type: 'string', description: 'ComfyUI 的 prompt_id，便于去它的界面里查' },
        comfy_url: { type: 'string', description: '使用的 ComfyUI 地址' },
        duration_ms: { type: 'integer', description: '耗时（毫秒）' },
        success: { type: 'boolean', description: '是否成功' },
        mode_inferred: { type: 'boolean', description: '模式是否为自动推断' },
        metadata_path: { type: 'string', description: '元数据 sidecar（.json）路径，含完整参数与工作流' },
        notes: { type: 'array', items: { type: 'string' }, description: '本次的提醒/注意事项' }
    },
    required: [
        'text',
        'path',
        'files',
        'mode',
        'seed',
        'width',
        'height',
        'steps',
        'cfg_scale',
        'strength',
        'model',
        'sampler',
        'scheduler',
        'prompt_id',
        'comfy_url',
        'duration_ms',
        'success',
        'mode_inferred',
        'notes'
    ],
    additionalProperties: false
};
/**
 * 从执行上下文里挖出「当前工作目录」。
 *
 * 需求书要求默认输出到「项目根目录」。DSH 把 cwd 挂在 agent 上，
 * 但具体挂在哪一层属于宿主内部结构，所以这里按候选顺序**防御式**取，
 * 全都没有就退回进程 cwd——绝不会因为取不到就报错。
 */
export function resolveCwd(exec) {
    const agent = exec?.agent;
    if (agent) {
        const candidates = [
            agent.cwd,
            agent.meta?.cwd,
            agent.session?.cwd,
            agent.session?.header?.cwd
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim() !== '')
                return candidate;
        }
    }
    return process.cwd();
}
/** 猜一下这次调用想干什么——只用于失败时的文案，不影响执行。 */
function guessMode(args) {
    const value = args?.mode;
    return typeof value === 'string' ? value : 'text2img';
}
/**
 * 造出工具定义。
 *
 * @param pluginConfig 宿主注入的插件配置（cordis.patch.yml 里那条 entry 的 config）。
 *        注意：配置是**每次调用时**重新解析的，所以用户改完
 *        `~/.dsh-comfyui-image/config.json` 立刻生效，不用重启 DSH。
 */
export function createGenerateImageTool(pluginConfig) {
    return {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        parameters: PARAMETERS_SCHEMA,
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => [
                { type: 'text', text: String(value?.text ?? '') }
            ],
            presentationMeta: (_args, value) => {
                const result = value;
                return {
                    kind: 'image-generation',
                    mode: result?.mode ?? 'unknown',
                    path: result?.path ?? '',
                    seed: result?.seed ?? 0
                };
            }
        },
        async execute(args, exec) {
            const config = resolveConfig(pluginConfig);
            const cwd = resolveCwd(exec);
            logDebug('execute', { cwd, baseUrl: config.baseUrl });
            try {
                const run = await runGeneration({
                    args: (args ?? {}),
                    cwd,
                    config,
                    ...(exec?.signal ? { signal: exec.signal } : {})
                });
                return formatResult(run);
            }
            catch (error) {
                // 失败也把「为什么 + 怎么办」原样交给模型——这比抛个 fetch failed 有用得多。
                const text = renderFailureText(error, guessMode(args));
                logDebug('生成失败', formatError(error));
                throw new Error(text);
            }
        }
    };
}

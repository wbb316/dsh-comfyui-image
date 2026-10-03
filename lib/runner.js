/**
 * 执行引擎：把「一次 generate_image 调用」从头跑到尾。
 *
 * 流程（每一步失败都抛带建议的 ImagePluginError）：
 *   参数归一化 → 能力探测 → 上传输入图 → 构建工作流 → 提交 → 轮询 →
 *   取图 → 落盘 → 写元数据 sidecar
 *
 * 刻意与 tool.ts 分开：
 *   - tool.ts 只负责「对外契约」（schema / 描述 / render），要稳定；
 *   - runner.ts 负责「怎么跑」，以后加 outpaint / upscale / 多后端都改这里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { extensionOf, guessImageMime, humanBytes, imageSizeOf, isFile, planOutputFile, readImageBytes } from './files.js';
import { ImagePluginError } from './errors.js';
import { logDebug } from './log.js';
import { applyModelAwareSize, normalizeRequest } from './params.js';
import { ComfyUIClient, describeHistoryError } from './comfy/client.js';
import { chooseCheckpoint, chooseRembgPlan, chooseSampler } from './comfy/nodes.js';
import { applyCustomWorkflow, buildWorkflow, filenamePrefixFor } from './comfy/workflows.js';
/** 插件版本（写进元数据，便于以后排查）。 */
export const PLUGIN_VERSION = '0.1.0';
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        function cleanup() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
        function onAbort() {
            cleanup();
            reject(new ImagePluginError('已取消：调用方中止了本次生成。', 'ComfyUI 那边的任务可能还在跑完。'));
        }
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort);
    });
}
/** 从历史记录里找产出图片：优先指定节点，找不到就全体扫描。 */
export function pickImageRef(entry, preferredNodeId) {
    const outputs = entry.outputs ?? {};
    const preferred = preferredNodeId ? outputs[preferredNodeId] : undefined;
    if (preferred?.images && preferred.images.length > 0) {
        return preferred.images[preferred.images.length - 1];
    }
    for (const [nodeId, node] of Object.entries(outputs)) {
        if (node.images && node.images.length > 0) {
            logDebug(`产出图片来自节点 ${nodeId}（不是预期的 ${preferredNodeId ?? '未指定'}）`);
            return node.images[node.images.length - 1];
        }
    }
    return undefined;
}
/** 把已存在的输出路径换成带正确扩展名的（ComfyUI 一般给 .png）。 */
function withCorrectExtension(filePath, extension) {
    const currentExt = path.extname(filePath);
    if (currentExt.toLowerCase() === extension.toLowerCase())
        return filePath;
    return filePath.slice(0, filePath.length - currentExt.length) + extension;
}
/** 读自定义工作流模板文件，返回解析后的对象（逃生舱）。 */
function readCustomWorkflowFile(templatePath, cwd) {
    const resolved = path.isAbsolute(templatePath) ? templatePath : path.resolve(cwd, templatePath);
    if (!isFile(resolved)) {
        throw new ImagePluginError(`extra_options.workflow_path 指向的文件不存在：${resolved}`, '请给出 API 格式工作流 JSON 的路径（ComfyUI 界面里的「Save (API Format)」导出）。');
    }
    try {
        return { resolved, parsed: JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '')) };
    }
    catch (error) {
        throw new ImagePluginError(`自定义工作流不是合法 JSON：${resolved}`, error instanceof Error ? error.message : String(error));
    }
}
/** 替换占位符，得到可提交的工作流（逃生舱）。 */
function applyCustomWorkflowTemplate(options) {
    const { template, templatePath, request } = options;
    const values = {
        prompt: request.prompt,
        negative_prompt: request.negativePrompt,
        width: request.width,
        height: request.height,
        seed: request.seed,
        steps: request.steps,
        cfg_scale: request.cfgScale,
        strength: request.strength,
        checkpoint: options.checkpoint,
        mode: request.mode
    };
    if (options.uploadedInput)
        values.input_image = options.uploadedInput;
    if (options.uploadedMask)
        values.mask_image = options.uploadedMask;
    logDebug('使用自定义工作流', { template: templatePath, values: Object.keys(values) });
    return applyCustomWorkflow(template, values);
}
/** 主流程。 */
export async function runGeneration(options) {
    const { args, cwd, config, signal } = options;
    const startedAt = Date.now();
    // ── 1. 参数归一化（含模式推断、默认值、冲突检查）──
    const { request, modeInferred } = normalizeRequest(args, { cwd, config });
    const notes = [...request.notes];
    logDebug('归一化后的请求', {
        mode: request.mode,
        seed: request.seed,
        size: `${request.width}x${request.height}`,
        output: request.outputPath
    });
    const client = options.client ?? new ComfyUIClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs });
    // 早一步做健康检查：连不上就别浪费时间
    await client.systemStats(signal);
    // 逃生舱：extra_options.workflow_path 指向的 API 格式工作流。先读一次，后面判占位符和构建都复用它。
    const customTemplatePath = typeof request.extra.workflow_path === 'string' && request.extra.workflow_path.trim() !== ''
        ? request.extra.workflow_path.trim()
        : undefined;
    const customTemplate = customTemplatePath ? readCustomWorkflowFile(customTemplatePath, cwd) : undefined;
    const customTemplateText = customTemplate ? JSON.stringify(customTemplate.parsed) : undefined;
    // ── 2. 能力探测（自定义工作流只探它真正用到的部分）──
    const needsGeneration = request.mode !== 'remove_background';
    let checkpoint = request.checkpoint;
    if (needsGeneration) {
        const templateNeedsCheckpoint = customTemplateText?.includes('{{checkpoint}}') ?? false;
        if (!customTemplate || templateNeedsCheckpoint) {
            const choice = await chooseCheckpoint(client, request.checkpoint, signal);
            checkpoint = choice.checkpoint;
            if (!request.checkpoint) {
                notes.push(`自动选用底模：${checkpoint}（本机共 ${choice.available.length} 个可选，可用 model 参数指定）。`);
            }
        }
    }
    // 底模定了才能定默认尺寸：用户既没传 model、配置也没写 checkpoint 时，参数层那一刻
    // 只拿得到配置默认值，这里按最终底模（可能是刚自动挑的）再自适应一次。
    applyModelAwareSize(request, checkpoint, config, notes);
    let samplerName = request.samplerName;
    let scheduler = request.scheduler;
    if (needsGeneration && !customTemplate) {
        const sampler = await chooseSampler(client, request, config, signal);
        samplerName = sampler.samplerName;
        scheduler = sampler.scheduler;
        notes.push(...sampler.notes);
    }
    let rembg;
    if (request.mode === 'remove_background' && !customTemplate) {
        rembg = await chooseRembgPlan(client, config.rembgNode, signal);
        notes.push(`去背方案：${rembg.label}`);
    }
    // ── 3. 上传输入图 / 遮罩 ──
    // 参数层已经保证了：只有 img2img / inpaint / remove_background 才会有 inputImage，
    // 只有 inpaint 才会有 maskImage，所以这里不用再按模式判断一遍。
    let uploadedInput;
    let uploadedMask;
    const uploadIfNeeded = async (filePath, kind) => {
        const bytes = readImageBytes(filePath, kind);
        const result = await client.uploadImage({ filename: path.basename(filePath), bytes, mime: guessImageMime(filePath) }, signal);
        logDebug(`已上传${kind}`, { local: filePath, comfy: result });
        return result;
    };
    if (request.inputImage) {
        uploadedInput = (await uploadIfNeeded(request.inputImage, 'input_image')).name;
    }
    if (request.maskImage) {
        uploadedMask = (await uploadIfNeeded(request.maskImage, 'mask_image')).name;
    }
    // ── 4. 构建工作流 ──
    const filenamePrefix = filenamePrefixFor(request);
    let built;
    if (customTemplate) {
        const custom = applyCustomWorkflowTemplate({
            template: customTemplate.parsed,
            templatePath: customTemplate.resolved,
            request,
            checkpoint,
            ...(uploadedInput ? { uploadedInput } : {}),
            ...(uploadedMask ? { uploadedMask } : {})
        });
        // 自定义工作流的产出节点我们不知道，留空让 pickImageRef 全表扫描
        built = { workflow: custom, mode: request.mode, outputNodeId: '' };
        notes.push('本次使用 extra_options.workflow_path 指定的自定义工作流。');
    }
    else {
        built = buildWorkflow({
            request,
            config,
            checkpoint,
            samplerName,
            scheduler,
            filenamePrefix,
            ...(uploadedInput ? { uploadedInput } : {}),
            ...(uploadedMask ? { uploadedMask } : {}),
            ...(rembg ? { rembg } : {})
        });
    }
    // ── 5. 提交 ──
    const clientId = `dsh-comfyui-image-${Date.now().toString(36)}`;
    const { promptId } = await client.queuePrompt(built.workflow, clientId, signal);
    // ── 6. 轮询直到出结果（或超时 / 报错 / 取消）──
    const deadline = Date.now() + config.timeoutMs;
    let entry;
    for (;;) {
        if (signal?.aborted) {
            throw new ImagePluginError('已取消：调用方中止了本次生成。', 'ComfyUI 那边的任务可能还在跑完。');
        }
        if (Date.now() > deadline) {
            // 超时了：尽力取消，别让它白占显存
            await client.interrupt(signal);
            throw new ImagePluginError(`等待 ComfyUI 出图超时（等了 ${Math.round(config.timeoutMs / 1000)} 秒，prompt_id=${promptId}）。`, `已尝试取消该任务。请确认 ComfyUI 是否卡住、或正在跑别的队列任务；也可以在 ~/.dsh-comfyui-image/config.json 里把 timeoutMs 调大。`);
        }
        entry = await client.historyEntry(promptId, signal);
        if (entry)
            break;
        await sleep(config.pollIntervalMs, signal);
    }
    const statusStr = entry.status?.status_str;
    if (statusStr === 'error' || statusStr === 'cancelled') {
        throw describeHistoryError(entry, promptId);
    }
    const comfyImage = pickImageRef(entry, built.outputNodeId);
    if (!comfyImage) {
        // 走到这里说明任务没报错、但历史记录里一个图片产出都没有。
        // 这跟「执行失败」是两回事，不能说成「没有更多细节」——那是句废话。
        throw new ImagePluginError(`ComfyUI 报告任务已结束（状态 ${statusStr ?? '未知'}），但没有任何图片产出（prompt_id=${promptId}）。`, '最常见的原因是工作流末端没有接 SaveImage / PreviewImage 节点——用 extra_options.workflow_path ' +
            '传自定义工作流时特别容易这样。也可能是工作流只输出了 mask / latent 之类的非图片结果。' +
            `可以打开 ${config.baseUrl} 在队列里找到这个 prompt_id 看节点图。`);
    }
    // ── 7. 取图并落盘 ──
    const bytes = await client.viewImage(comfyImage, signal);
    // 对外报的尺寸以**产出字节**为准：img2img / inpaint 的画布跟输入图走，请求值并不生效
    // （真机实测：512×512 的输入图产出了 512 的图，报告里却写着 1024）。
    // 直接写回 request，元数据与返回值（formatResult 读的就是 request）自然一致。
    const actualSize = imageSizeOf(bytes);
    if (actualSize && (actualSize.width !== request.width || actualSize.height !== request.height)) {
        notes.push(request.mode === 'text2img'
            ? `输出尺寸是 ${actualSize.width}x${actualSize.height}，与请求的 ${request.width}x${request.height} 不同。`
            : `输出尺寸是 ${actualSize.width}x${actualSize.height}（${request.mode} 的画布由输入图决定，请求里的 ${request.width}x${request.height} 不生效）。`);
        request.width = actualSize.width;
        request.height = actualSize.height;
    }
    const extension = extensionOf(comfyImage.filename, '.png');
    const finalFile = planOutputFile(withCorrectExtension(request.outputPath, extension), cwd, extension);
    fs.writeFileSync(finalFile.filePath, bytes);
    logDebug(`已写入 ${finalFile.filePath}（${humanBytes(bytes.length)}）`);
    const durationMs = Date.now() - startedAt;
    // ── 8. 元数据 sidecar（可复现 / 便于以后做一致性）──
    let metadataPath;
    if (config.writeMetadata) {
        metadataPath = `${finalFile.filePath}.json`;
        const metadata = {
            plugin: 'dsh-comfyui-image',
            pluginVersion: PLUGIN_VERSION,
            createdAt: new Date().toISOString(),
            mode: request.mode,
            modeInferred,
            prompt: request.prompt,
            negativePrompt: request.negativePrompt,
            seed: request.seed,
            width: request.width,
            height: request.height,
            steps: request.steps,
            cfgScale: request.cfgScale,
            strength: request.strength,
            checkpoint,
            samplerName,
            scheduler,
            /** 预留的一致性字段：V1 只记录，不参与生成。 */
            styleReference: request.styleReference,
            characterReference: request.characterReference,
            inputs: { inputImage: request.inputImage, maskImage: request.maskImage },
            comfy: { url: config.baseUrl, promptId, image: comfyImage, filenamePrefix, rembg: rembg?.label },
            durationMs,
            outputFile: finalFile.filePath,
            notes,
            extra: request.extra,
            workflow: built.workflow
        };
        fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    }
    return {
        request,
        mode: request.mode,
        modeInferred,
        outputPaths: [finalFile.filePath],
        ...(metadataPath ? { metadataPath } : {}),
        comfyImage,
        promptId,
        comfyUrl: config.baseUrl,
        durationMs,
        checkpoint,
        samplerName,
        scheduler,
        ...(rembg ? { rembgLabel: rembg.label } : {}),
        notes,
        workflow: built.workflow
    };
}

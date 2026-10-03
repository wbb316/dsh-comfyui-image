import { PLUGIN_VERSION } from './runner.js';
const MODE_LABELS = {
    text2img: '文生图',
    img2img: '图生图',
    inpaint: '局部重绘',
    remove_background: '背景移除'
};
/**
 * 拼给模型看的文本。
 *
 * 注意顺序：**先把绝对路径单独放一行**（`图片：<路径>`），
 * 后面才是参数说明。这样即使模型只扫一眼，也不会漏掉路径。
 */
export function renderResultText(result) {
    const label = MODE_LABELS[result.mode] ?? result.mode;
    const lines = [];
    lines.push(`✅ 出图成功（${label}${result.mode_inferred ? '，模式自动推断' : ''}）`);
    lines.push('');
    lines.push(`图片：${result.path}`);
    if (result.metadata_path)
        lines.push(`元数据：${result.metadata_path}`);
    lines.push('');
    lines.push(`参数：seed=${result.seed} 尺寸=${result.width}x${result.height} steps=${result.steps} ` +
        `cfg=${result.cfg_scale}${result.mode === 'img2img' || result.mode === 'inpaint' ? ` strength=${result.strength}` : ''}`);
    lines.push(`底模：${result.model}`);
    lines.push(`采样：${result.sampler} / ${result.scheduler}　耗时：${(result.duration_ms / 1000).toFixed(1)} 秒`);
    lines.push(`ComfyUI：${result.comfy_url}（prompt_id=${result.prompt_id}）`);
    if (result.notes.length > 0) {
        lines.push('');
        lines.push('备注：');
        for (const note of result.notes)
            lines.push(`  - ${note}`);
    }
    lines.push('');
    lines.push('提示：想复现同一张图，用相同的 seed 再调一次；想微调就改 prompt 后换个 seed。');
    return lines.join('\n');
}
/** RunResult → 工具返回值。 */
export function formatResult(run) {
    const primary = run.outputPaths[0] ?? '';
    const value = {
        text: '',
        path: primary,
        files: [...run.outputPaths],
        mode: run.mode,
        seed: run.request.seed,
        width: run.request.width,
        height: run.request.height,
        steps: run.request.steps,
        cfg_scale: run.request.cfgScale,
        strength: run.request.strength,
        model: run.checkpoint,
        sampler: run.samplerName,
        scheduler: run.scheduler,
        prompt_id: run.promptId,
        comfy_url: run.comfyUrl,
        duration_ms: run.durationMs,
        success: true,
        mode_inferred: run.modeInferred,
        notes: run.notes.length > 0 ? run.notes : [`由 dsh-comfyui-image v${PLUGIN_VERSION} 生成`]
    };
    if (run.metadataPath)
        value.metadata_path = run.metadataPath;
    value.text = renderResultText(value);
    return value;
}
/**
 * 失败时给模型看的文本。
 * 需求第九条第 4 点：ComfyUI 没启动 / 输入文件不存在 / 工作流失败，都必须说清楚。
 */
export function renderFailureText(error, mode) {
    const label = MODE_LABELS[mode] ?? mode;
    const message = error instanceof Error ? error.message : String(error);
    const hint = error && typeof error === 'object' && 'hint' in error
        ? String(error.hint ?? '')
        : '';
    const lines = [`❌ 出图失败（${label}）`, '', message];
    if (hint) {
        lines.push('');
        lines.push(hint);
    }
    return lines.join('\n');
}

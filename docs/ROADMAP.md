# 路线图

记录 V1 之后想做的事，以及**每件事为什么现在没做**。分三档：近期（接口已就位，增量实现）、
中期（需要新依赖或新节点）、远期（需要先解决设计问题）。

> 原则不变：**实用优先**。宁可少而稳，也不加一堆「看起来有、实际不能用」的参数。

---

## 一、近期（V1.x，接口已预留）

### 1. 一致性：把预留位接上

现在 `style_reference` / `character_reference` 只写进元数据。要真的生效，有两条路：

| 方案 | 依赖 | 说明 |
|---|---|---|
| **IPAdapter 系** | `ComfyUI_IPAdapter_plus` | 把参考图编码成条件注入 KSampler；风格参考和角色参考本质是一回事，只是权重/层不同 |
| **参考图 + 降噪重绘** | 核心节点即可 | 简单版：拿参考图当 `img2img` 的输入图 + 低 `strength`，能蹭到一点风格相似度 |

接口侧不用改：`NormalizedRequest` 里已有 `styleReference` / `characterReference`，
要加的是**工作流构建层**多两个节点。元数据 sidecar 从一开始就记着这些字段，将来可以拿历史数据做对照实验。

### 2. 批量多图

现在一次出一张（`batch_size` 固定 1）。做批量要考虑的是**返回结构**：
`outputPaths` 已经是数组、`files` 已经是数组，所以底层不用动；要改的是：

- 工具参数加 `count`（1~8）；
- 工作流 `EmptyLatentImage.batch_size` 或 `RepeatLatentBatch`；
- 结果文本里列出多个路径（每行一个绝对路径，保证前端能识别）；
- 失败语义要想清楚：**要么全成功要么全失败**（ComfyUI 单次任务本身就是原子的），
  不要做成「部分成功」。

### 3. 超分辨率 / 放大 `upscale`

- 走 **模型放大**（`UpscaleModelLoader` + `ImageUpscaleWithModel`）或**简单缩放**（`ImageScaleBy`）——
  两者都是核心节点，不需要装东西；
- 参数设计：`extra_options` 里已经能用逃生舱跑通，正式化就是加一个 `mode: upscale` +
  `scale` 参数（2x / 4x）；
- 注意：模型放大要用户自己往 `models/upscale_models/` 放 ESRGAN 之类的权重，缺了要像去背节点那样
  给出「装什么」的提示。

### 4. 扩图 `outpaint`

- 核心节点能做的简化版：把图贴到更大的画布上 + 边缘遮罩 + `inpaint` 重绘；
- 正式版要处理「往哪个方向扩、扩多少」，参数会比现在复杂 —— 这是它排在后面的原因。

### 5. 更聪明的模式与尺寸

- 尺寸没传时，除了看底模名字（已有），还能看**输入图尺寸**做对齐；
- `remove_background` 之外的三模式若缺 `input_image` 但用户明显想「改图」，能否给更准的提示（**不自动补图**）。

---

## 二、中期（需要新依赖 / 新节点）

### 6. 去背：接入核心 `RemoveBackground`（零第三方依赖）

ComfyUI 0.3x 起核心自带 `LoadBackgroundRemovalModel` + `RemoveBackground`
（`comfy_extras/nodes_bg_removal.py`，**不是** API 节点）：输入图 → 输出 **MASK**，
模型放 `models/background_removal/`。它有潜力把 `remove_background` 从「必须装第三方节点」
变成「开箱可用」，但要先解决三件事：

1. 现在的工作流是「一张图进、一张图出」，而它产出的是遮罩——链路要变成
   `LoadBackgroundRemovalModel → RemoveBackground → JoinImageWithAlpha → SaveImage`
   （`JoinImageWithAlpha` 也是核心节点：`image` + `alpha` → 带 alpha 通道的 IMAGE）；
2. `RembgPlan` 目前只有 `single` / `pair` 两种构建方式，需要加第三种「自定义构建」；
3. 模型要用户自己放进 `models/background_removal/`（与 `upscale` 的权重同类问题），缺了要给下载链接。

好处很实在：这一套**不需要 `pip install rembg`**，也就绕开了 onnxruntime 那一串依赖，
而且 `doctor` 的探测逻辑（按可用节点挑方案）可以直接复用。

### 7. 多后端

`runner.ts` 与 `comfy/` 是分开的，所以加后端理论上只动 `comfy/` 那一层。计划中的顺序：

1. **ComfyUI 远程实例**（其实现在就能用：把 `baseUrl` 指过去即可，只是没有鉴权/重试）；
2. **A1111 / Forge**（`/sdapi/v1/txt2img`）—— 参数映射能复用的部分很多；
3. **其它本地推理服务**（如 SD.cpp、LocalAI）—— 需要先确认它们的参数模型。

要做的前提：把「工作流构建」抽象成接口（`Backend`），现在它是四个具体的 `buildXxx` 函数。

### 8. 稳定性与体验

- **重试**：ComfyUI 偶尔会 OOM 或排队超时，可对「提交失败」做一次有限重试（**不要**对「已提交但超时」重试，
  否则会重复出图）；
- **任务取消**：现在超时会 `/interrupt`，可以再加一个显式的 `cancel` 语义（DSH 的 `signal` 已经接好了）；
- **队列可见性**：`prompt_id` 已经有了，可以在结果里附上 ComfyUI 的队列页链接（需要知道是否 LAN 可达）。

### 9. 一致性数据闭环

元数据 sidecar 已经是「参数 + 工作流 + 产出路径」的完整记录。下一步：

- 一个可选的**生成历史索引**（`~/.dsh-comfyui-image/history.jsonl`），便于按 prompt / seed 检索；
- 基于历史做「同一角色多张图」的 seed 与 prompt 复用实验；
- 让 `.json` 能一键导回 ComfyUI 界面（现在手动拖进去就行，只是没写教程）。

---

## 三、远期（需要先解决设计问题）

### 10. DSH 侧的可视化与交互

- 设置页里直接编辑配置（现在要手动改 `config.json`）——需要 DSH 客户端插件的 UI 能力；
- 出图后在会话里直接内联预览（现在靠路径可点开）；DSH 有 GenUI 组件，可以把图片路径渲染成卡片；
- 一个「最近生成的图」面板。

### 11. 提示词辅助

- **提示词增强**（把中文口语翻成 SD 友好的英文 tag 串）——这属于模型能力，也许更适合放 DSH 侧而不是插件里；
- **负面提示词预设库**（人像 / 风景 / 产品图各一套）；
- **风格词库**（"水彩 / 赛博朋克 / 皮克斯" → 一串 tag）。

### 12. 安全与配额

- 目前没有配额概念（本地 ComfyUI，你自己说了算）；
- 如果要给多人/远程实例共享，需要加：并发上限、单次尺寸上限、输出目录白名单。

---

## 四、明确**不**打算做的

写在这里，省得反复讨论：

| 不做 | 原因 |
|---|---|
| 内置商业 API 后端（DALL·E / SD API 之类） | 插件的定位就是「不依赖外部商业 API」，要接也是作为可选后端放中期 |
| 自动下载底模 / 去背权重 | 动辄几个 GB，不该由插件偷偷下；给链接和命令更负责 |
| 自动生成遮罩（比如分割模型全自动抠图） | 依赖链太重、行为不可预测；「白/亮区 = 重绘区」这条规则简单又可控 |
| 把 ComfyUI 全部参数倒出来给 Agent | 与「统一抽象参数层」的初衷相反；需要底层控制时用 `workflow_path` 逃生舱 |
| 静默降级（模式冲突时替用户做决定） | 会让人以为在做局部重绘、其实整图重画了；**宁可报错** |

---

## 五、想参与？

- 代码结构见 [README 的架构一节](../README.md#架构与目录结构)，测试不需要真装 ComfyUI（自带 mock）；
- 报 issue 时带上 `npm run doctor --json` 的输出与报错原文，定位会快很多；
- 打算加参数 / 加模式的话，先看一眼 `src/types.ts` 与 `src/tool.ts` 的注释——
  那里的分层约定（对外契约 / 参数层 / 执行层）就是给扩展留的接口。

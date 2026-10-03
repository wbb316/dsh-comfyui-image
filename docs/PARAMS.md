# 工具参数说明

对外只有**一个**工具：`generate_image`。这份文档逐项说明它的参数、默认值、以及在什么情况下会被忽略。

- 参数 schema 定义在 `src/tool.ts`（`PARAMETERS_SCHEMA`），归一化逻辑在 `src/params.ts`。
- 参数是**原始 JSON Schema**，且只用 DSH 支持的子集（`minimum` / `maximum` / `format` 这些键会被直接拒绝），
  所以取值范围只写在 description 里，由插件在运行时**兜底校验并给出明确报错**。

---

## 一、参数总表

| 参数 | 类型 | 默认 | 生效模式 | 说明 |
|---|---|---|---|---|
| `mode` | string 枚举 | 自动推断 | 全部 | `text2img` / `img2img` / `inpaint` / `remove_background`。传了不认识的值得直接报错 |
| `prompt` | string | — | `text2img` `img2img` `inpaint` | 正向提示词，必填。`remove_background` 传了会被忽略并在 `notes` 里说明 |
| `negative_prompt` | string | 插件默认负向词 | 生成类 | 覆盖配置里的 `negativePrompt` |
| `input_image` | string | — | `img2img` `inpaint` `remove_background` | 必填。绝对路径或相对**当前工作目录**；支持 `~` |
| `mask_image` | string | — | `inpaint` | 必填。**白色/亮色区域 = 要重绘的区域**（alpha 通道不被读取），尺寸需与 `input_image` 一致 |
| `width` | integer | 按底模（1024 / 512） | **仅** `text2img` | `64`~`8192`，非 8 的倍数会自动对齐并在 `notes` 里说明 |
| `height` | integer | 按底模（1024 / 512） | **仅** `text2img` | 同上 |
| `seed` | integer | 随机 | 生成类 | `0`~`4294967295`。同 seed + 同 prompt + 同底模 = 同一张图 |
| `output_path` | string | 当前工作目录 | 全部 | 给目录 → 里面自动起名；给 `xxx.png` 这种带图片扩展名的 → 当文件路径（已存在则加 `-1`/`-2`，**绝不覆盖**） |
| `strength` | number | `img2img` 0.6 / `inpaint` 1.0 | `img2img` `inpaint` | `0`~`1`，越小越贴近原图。`remove_background` 传了会被忽略 |
| `steps` | integer | `20` | 生成类 | `1`~`500`，越大越细越慢 |
| `cfg_scale` | number | `7` | 生成类 | `0`~`100`，越高越贴提示词、越低越自由 |
| `model` | string | 自动挑 | 生成类 | 底模文件名。不传则自动选（优先带 `xl` 的），选了什么会写进结果的 `notes` |
| `sampler_name` | string | `euler` | 生成类 | **显式传**了本机没有的值 → 报错并列出可用值；只是配置默认值在本机不存在时 → 自动回退并在 `notes` 里说明 |
| `scheduler` | string | `normal` | 生成类 | 同上 |
| `style_reference` | string | — | **（预留）** | V1 只校验文件存在 + 写进元数据，**不影响出图** |
| `character_reference` | string | — | **（预留）** | 同上 |
| `extra_options` | object | — | 全部 | 现在只有 `workflow_path` 有行为：用它指定的 API 格式工作流**接管**本次生成 |

> 结果里返回的 `width` / `height` 一律是**产出图的实际像素尺寸**：`text2img` 就等于请求的尺寸，
> 而 `img2img` / `inpaint` / `remove_background` 会等于输入图的尺寸——这几种模式的画布跟输入图走，
> 请求里的 `width` / `height` 并不生效。尺寸与请求不一致时，`notes` 里会写明原因。

### 取值范围与报错

超出范围的值得的是**明确报错**，不是被夹到边界：

```
width 超出允许范围 64~8192，收到 99999。
```

```
steps 必须是数字，收到的是 "abc"。
```

### 「被忽略」而不是「报错」的情况

这些不会失败，但会在结果的 `notes` 里明说，避免你以为它生效了：

| 情况 | `notes` 里的说法（大意） |
|---|---|
| 非 `text2img` 传了 `width` / `height` | 「输出尺寸由输入图决定，width/height 已忽略」 |
| `remove_background` 传了 `prompt` | 「不使用 prompt，已忽略」 |
| `remove_background` 传了 `strength` | 「不使用 strength，已忽略」 |
| 尺寸不是 8 的倍数 | 「width 已从 1001 对齐到 8 的倍数：1000（ComfyUI 要求）」 |
| 传了 `style_reference` / `character_reference` | 「V1 只做记录（写入元数据），暂不参与生成」 |
| 没传 `model` | 「自动选用底模：xxx（本机共 N 个可选，可用 model 参数指定）。」 |
| 配置里的默认采样器 / 调度器本机没有（**不是**调用时显式传的） | 「采样器 xxx 在本机不存在，已改用 yyy。」 |
| 没指定 `width` / `height`，且底模判定出的默认尺寸与配置默认值不同 | 「未指定尺寸：按底模 xxx 自适应为 512x512（自适应前为 1024x1024，可用 width/height 覆盖）。」 |
| `img2img` / `inpaint` 的产出尺寸与请求里的 `width` / `height` 不同 | 「输出尺寸是 512x512（img2img 的画布由输入图决定，请求里的 1024x1024 不生效）。」 |

---

## 二、模式推断与冲突规则

不传 `mode` 时按三条规则推断：

```
有 input_image 且有 mask_image  →  inpaint
只有 input_image               →  img2img
都没有                         →  text2img
```

**推断只做这一步**。任何冲突都直接报错（宁可报错，也不猜你想干什么）：

| 输入 | 结果 |
|---|---|
| `mode=text2img` + `input_image` | ✗ 报错：「想基于这张图改，请显式传 `mode="img2img"`」 |
| `mode=text2img` + `mask_image` | ✗ 报错：「请显式传 `mode="inpaint"`」 |
| `mode=img2img` + `mask_image` | ✗ 报错：「有遮罩属于局部重绘，请改传 `mode="inpaint"`」 |
| `mask_image` 但没有 `input_image` | ✗ 报错：「局部重绘需要原图 + 遮罩两张图」 |
| `mode=img2img` / `inpaint` / `remove_background` 缺 `input_image` | ✗ 报错 |
| `mode=inpaint` 缺 `mask_image` | ✗ 报错（V1 不做自动抠图 / 自动生成遮罩） |
| `mode=text2img` / `img2img` / `inpaint` 缺 `prompt` | ✗ 报错 |
| `input_image` / `mask_image` 路径不存在 | ✗ 报错，**在上传之前**就拦下来 |
| `input_image` 指向目录或 0 字节文件 | ✗ 报错，并说明「给具体的图片文件路径」/「文件里没有图像数据」 |
| `mode` 是不认识的值 | ✗ 报错，并列出 V1 支持的四种 |

**为什么这么设计**：Agent 调用出错时最怕「静默降级成另一个模式」——你以为在局部重绘，结果它整图重画了。
所以本插件的原则是：**能一眼判定的就推断，有歧义的一律报错**，报错文本里带上「怎么办」。

---

## 三、输出结构

工具返回值（`output.schema`）字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | 给模型看的完整结果说明（也是 UI 里显示的那段） |
| `path` | string | **主产出文件的绝对路径**（放最前面，便于前端识别成可点开的文件） |
| `files` | string[] | 本次产出的全部文件（当前固定 1 个） |
| `mode` | string | 实际使用的模式 |
| `seed` | integer | 本次种子（复现就靠它） |
| `width` / `height` | integer | 实际尺寸（非 `text2img` 时是输入图的尺寸） |
| `steps` / `cfg_scale` / `strength` | number | 本次参数 |
| `model` | string | 实际使用的底模（可能是自动挑的） |
| `sampler` / `scheduler` | string | 实际使用的采样器 / 调度器（可能是回退后的） |
| `prompt_id` | string | ComfyUI 的 `prompt_id`，可以去它界面/队列里查这次任务 |
| `comfy_url` | string | 使用的 ComfyUI 地址 |
| `duration_ms` | integer | 从提交到取回图片的耗时 |
| `success` | boolean | 是否成功（失败时工具抛错，不会返回 `success:false`） |
| `mode_inferred` | boolean | 模式是否为自动推断 |
| `metadata_path` | string? | `.json` 元数据 sidecar 路径（关掉 `writeMetadata` 时不存在） |
| `notes` | string[] | 本次的提醒（见上表） |

`text` 的排版是刻意的：**绝对路径单独占一行、不加任何修饰**，这样 DSH 前端会把它渲染成可点开的文件链接。

```text
✅ 出图成功（局部重绘）

图片：C:\Users\me\Desktop\comfyui-20261003-131501-7f2c.png
元数据：C:\Users\me\Desktop\comfyui-20261003-131501-7f2c.png.json

参数：seed=991203 尺寸=768x768 steps=25 cfg=7 strength=1
底模：sd_xl_base_1.0.safetensors
采样：euler / normal　耗时：18.7 秒
ComfyUI：http://127.0.0.1:8188（prompt_id=1f0a…）

备注：
  - 自动选用底模：sd_xl_base_1.0.safetensors（本机共 3 个可选，可用 model 参数指定）。
```

## 四、失败时长什么样

失败时工具**抛错**，报错文本 = 「发生了什么」+「下一步怎么办」：

```text
❌ 出图失败（文生图）

连不上 ComfyUI：http://127.0.0.1:8188（fetch failed）

请先启动本地 ComfyUI 服务（默认监听 127.0.0.1:8188），或把地址改对——改
~/.dsh-comfyui-image/config.json 里的 baseUrl，或设环境变量 COMFYUI_URL=http://主机:端口。
```

常见的还有：没有任何可用的底模、缺少去背节点（会列出四套安装方案）、
工作流执行失败（带 `prompt_id` 与排查建议）、等图超时（已尽力取消任务）、
「任务结束但没有任何图片产出」（多半是自定义工作流末端没接 `SaveImage`）。

## 五、自定义工作流的占位符

用 `extra_options.workflow_path` 接管生成时，插件会在提交前替换这些占位符：

| 占位符 | 值 |
|---|---|
| `{{prompt}}` | 正向提示词 |
| `{{negative_prompt}}` | 负向提示词（含插件默认值） |
| `{{width}}` / `{{height}}` | 尺寸 |
| `{{seed}}` | 种子 |
| `{{steps}}` | 采样步数 |
| `{{cfg_scale}}` | CFG |
| `{{strength}}` | 强度 |
| `{{checkpoint}}` | 实际使用的底模名 |
| `{{input_image}}` | **已上传到 ComfyUI 后**的文件名（不是本地路径） |
| `{{mask_image}}` | 同上 |
| `{{mode}}` | 本次模式 |

替换规则：

- **整个值就是一个占位符**（如 `"ckpt_name": "{{checkpoint}}"`）→ 原样替换，**类型保持不变**（数字仍是数字）；
- 占位符嵌在句子中间 → 按字符串拼接；
- **没提供的占位符原样保留**（如 `{{foo}}` 留成 `{{foo}}`）——便于你发现自己拼错了。

> 注意：`input_image` 的语义是「ComfyUI 输入目录里的文件名」——因为 `LoadImage` 节点的 `image`
> 参数是**输入目录下的文件名枚举**，不是自由字符串。插件已经用 `/upload/image` 返回的文件名回填，
> 所以你在模板里写 `{{input_image}}` 就对了，别写本地绝对路径。

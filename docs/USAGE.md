# 使用示例

四种模式各来一遍，再讲几个实际用得到的套路（复现、微调、换地方存、批量、自定义工作流）。

> 两条通用建议：
> 1. **对 Agent 说人话就够了** —— 它会自己填参数。下面给的 JSON 是「它实际调用时长的样子」和「你要写代码调用时长的样子」。
> 2. 每次调用都会在图片旁边留一份 `.json` 元数据，里面有这次用的**全部参数**和**提交给 ComfyUI 的完整工作流**。

---

## 1. 文生图 `text2img`

对 Agent 说：

```text
画一只穿宇航服的柯基站在月球上，数字艺术风格，方图
```

对应调用（不传 `mode`，只要没有输入图就是文生图）：

```json
{
  "prompt": "a corgi in a spacesuit standing on the moon, digital art, highly detailed",
  "negative_prompt": "blurry, low quality, watermark",
  "width": 1024,
  "height": 1024,
  "steps": 25
}
```

加固定种子，方便反复对比提示词：

```json
{
  "prompt": "a corgi in a spacesuit, digital art",
  "seed": 1234567
}
```

---

## 2. 图生图 `img2img`

对 Agent 说：

```text
把 D:/pics/room.jpg 改成水彩画风格，别改构图
```

对应调用（有 `input_image`、没有 `mask_image` → 自动推断为 `img2img`）：

```json
{
  "prompt": "watercolor painting, soft edges, paper texture, same composition",
  "input_image": "D:/pics/room.jpg",
  "strength": 0.45
}
```

**`strength` 是这里最要紧的旋钮**：

| 值 | 效果 |
|---|---|
| `0.2` ~ `0.35` | 几乎只做风格化，构图/主体很稳 |
| `0.45` ~ `0.65` | 明显改动，但还认得出原图（默认 `0.6`） |
| `0.75` ~ `1.0` | 基本重画，只继承个大概 |

> 尺寸不用传：`img2img` 的画布由输入图决定，传了 `width` / `height` 会被忽略（结果 `notes` 里会说明）。

---

## 3. 局部重绘 `inpaint`

对 Agent 说：

```text
把 D:/pics/portrait.png 里的背景换成夜晚的城市，遮罩我用 D:/pics/mask.png 标好了
```

对应调用（`input_image` + `mask_image` → 自动推断为 `inpaint`）：

```json
{
  "prompt": "night city skyline with bokeh lights, cinematic",
  "input_image": "D:/pics/portrait.png",
  "mask_image": "D:/pics/mask.png",
  "strength": 1.0
}
```

关于遮罩，三件事必须说清楚：

1. **白色/亮色区域 = 要重绘的区域**，黑色/暗区 = 保持原样；
2. 遮罩**尺寸要与输入图一致**（不一致时由 ComfyUI 报错，插件会把原文带回来）；
3. 插件会自动把重绘区域**向外扩张 6 像素**（配置项 `inpaintGrowMask`，可调 0~256）——
   这是为了消掉接缝处的硬边，调成 `0` 会看到明显的拼接痕迹。

想让它更贴原图，把 `strength` 调到 `0.6`~`0.8`。

---

## 4. 背景移除 `remove_background`

对 Agent 说：

```text
把 D:/pics/product.jpg 的背景去掉，只留商品
```

对应调用（只要 `input_image`，不需要 `prompt`）：

```json
{
  "input_image": "D:/pics/product.jpg",
  "output_path": "D:/pics/cutout.png"
}
```

前置条件：ComfyUI 里装了**任意一套第三方去背节点**（纯核心 ComfyUI 自带的 `RemoveBackground`
需要自备 `models/background_removal/` 模型且产物是遮罩，本插件暂未接入）。
插件会自动在 `ComfyUI_essentials` / `ComfyUI-BRIA_AI-RMBG` / `ComfyUI-LayerStyle` / `WAS Node Suite`
四套里择优，并在结果的 `notes` 里告诉你用了哪一套：

```text
备注：
  - 去背方案：ComfyUI_essentials（RemBGSession+ → ImageRemoveBackground+）
```

一套都没装时会明确报错，并把四套的安装命令都列出来。只想固定用某一套就设配置 `rembgNode`。

---

## 5. 套路：复现同一张图 / 微调

第一次调用返回里带 `seed`，把它抄下来就是复现的全部密钥：

```text
参数：seed=1783492011 尺寸=1024x1024 steps=20 cfg=7
```

- **完全复现**：同一 `prompt` + `negative_prompt` + `seed` + `model` + `sampler_name` + `scheduler` + 尺寸；
- **微调**：改 `prompt`（保留 seed 看「同一张构图下的不同描述」）或改 seed（看「同一提示词的不同随机结果」）；
- 最保险的复现方式：直接看图片旁边的 `.json` 元数据 —— 里面连**完整工作流**都存着，
  可以原样导进 ComfyUI 重跑。

> 底模不一样，seed 的复现性就没意义了。所以元数据里也记了实际使用的 `checkpoint`。

---

## 6. 套路：指定输出位置

不传 `output_path` → 图落在**当前项目根目录**，文件名 `comfyui-<时间戳>-<随机4位>.png`。

```json
// 给目录：在里面自动起名
{ "prompt": "a cat", "output_path": "D:/images" }

// 给文件：同名已存在就自动加 -1 / -2，绝不覆盖
{ "prompt": "a cat", "output_path": "D:/images/cat-cover.png" }
```

也可以一次性在配置里设默认目录，省得每次传：

```json
// ~/.dsh-comfyui-image/config.json
{ "outputDir": "D:/images" }
```

---

## 7. 套路：批量出图

V1 的 `generate_image` **一次出一张**（刻意如此：失败重试、进度反馈都简单）。
批量就让 Agent 循环调用——它天然会一次一个、逐个报错：

```text
请用 generate_image 依次为「猫 / 狗 / 兔子」各出一张 512x512 的图，
都用 seed=42，输出到 D:/images/pets/
```

这样做的额外好处：一张失败不影响其他张，而且每张都有独立的元数据。
（真正的批量 / 多图工作流可以用下节的逃生舱接进来。）

---

## 8. 套路：用自定义工作流做 V1 没内置的事

扩图（outpaint）、超分（upscale）、特殊节点，都能用 `extra_options.workflow_path` 接管：

**第 1 步**：在 ComfyUI 界面里搭好工作流，用菜单里的 **Save (API Format)** 导出 JSON。

**第 2 步**：把会变的字段换成占位符（用文本编辑器改就行）：

```jsonc
{
  "3": {
    "class_type": "KSampler",
    "inputs": {
      "seed": "{{seed}}",          // 整个值就是占位符 → 仍然是数字
      "steps": "{{steps}}",
      "cfg": "{{cfg_scale}}",
      "sampler_name": "euler",
      "scheduler": "normal",
      "denoise": "{{strength}}",
      "positive": ["6", 0],
      "model": ["4", 0],
      "negative": ["7", 0],
      "latent_image": ["5", 0]
    }
  },
  "6": {
    "class_type": "CLIPTextEncode",
    "inputs": { "text": "{{prompt}}", "clip": ["4", 1] }
  }
}
```

**第 3 步**：调用时指过去：

```json
{
  "mode": "img2img",
  "prompt": "same scene, extended to the left",
  "input_image": "D:/pics/pano.png",
  "extra_options": { "workflow_path": "D:/workflows/outpaint.json" }
}
```

要点：

- 走逃生舱时插件**不再注入**内置的参数节点，只探它真正需要的部分（模板里出现 `{{checkpoint}}` 才去挑底模）；
- 工作流末端**必须有 `SaveImage` / `PreviewImage`**，否则会报「任务结束但没有任何图片产出」；
- 想找回这次用的工作流：元数据 `.json` 里的 `workflow` 字段就是替换后的成品。

---

## 9. 在 DSH 里看到的样子

工具的返回文本里，**图片绝对路径单独占一行**，DSH 前端会把它渲染成可点开的文件引用：

```text
✅ 出图成功（文生图，模式自动推断）

图片：C:\Users\me\Desktop\comfyui-20261003-130812-a1b2.png
```

点开或直接把这一行贴进文件管理器都能看图；旁边的 `.json` 是同名元数据。

写代码调用（不经过 Agent）时，拿到的就是[输出结构](./PARAMS.md#三输出结构)里那些字段，
`path` 是绝对路径、`text` 是给人/模型看的那段文本。

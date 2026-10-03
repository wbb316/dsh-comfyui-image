[English](./INSTALL.en.md) | **简体中文**

# 安装教程

装这个插件分两步：**① 让 ComfyUI 跑起来** → **② 把插件装进 DSH**。第二步只花一分钟，第一步才是重活。

> 不想读长文？最短路径：装 ComfyUI 便携版 → 双击启动 → 往 `models/checkpoints/` 放一个底模 →
> 在 DSH 插件管理器里装 `github:wbb316/dsh-comfyui-image`（已经 clone 到本地就用 `link:<插件目录>`）→
> 跑 `npm run doctor` 看到四个 ✓ 就成了。

---

## 一、安装并启动 ComfyUI

### 1.1 选一种安装方式

| 方式 | 适合谁 | 说明 |
|---|---|---|
| **官方 Windows 便携版** | Windows 用户，最省事 | 从 [ComfyUI Releases](https://github.com/comfyanonymous/ComfyUI/releases) 下载 `ComfyUI_windows_portable.7z`，解压（路径别带中文/空格，省事），双击 `run_nvidia_gpu.bat` |
| **Comfy Desktop** | 想图形化装 / 管理 | [ComfyUI 官网](https://www.comfy.org/) 的桌面版，装完直接能跑 |
| **源码安装** | 想自己控环境 / Linux | 见 [ComfyUI 仓库](https://github.com/comfyanonymous/ComfyUI) 的 README：`git clone` → 建 venv → `pip install -r requirements.txt` → `python main.py` |
| **已有 ComfyUI** | 你已经跑着 | 跳过本节，只确认监听地址 |

### 1.2 确认服务真的起来了

启动后浏览器打开这两个地址：

- `http://127.0.0.1:8188/system_stats` → 返回一段 JSON（里面有 `system` / `devices`）
- `http://127.0.0.1:8188/` → ComfyUI 的节点界面

命令行也可以：

```powershell
# Windows PowerShell
Invoke-WebRequest http://127.0.0.1:8188/system_stats -UseBasicParsing | Select-Object -Expand StatusCode
```

```bash
# macOS / Linux
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8188/system_stats
```

`200` 就是好的。**不是 200 就别往下走**，插件那边一定连不上。

### 1.3 放一个底模（必须）

插件会去问 ComfyUI「你有哪些底模」，一个都没有就没法出图。

把底模（`.safetensors` / `.ckpt`）放进：

```
<ComfyUI>/models/checkpoints/
```

推荐起步模型（任选一个）：

- **SDXL 系**（默认按 1024×1024 出图）：`sd_xl_base_1.0.safetensors`
- **SD1.5 系**（插件识别到名字里像 SD1.5 时会自动改用 512×512）：`v1-5-pruned-emaonly.safetensors`

放好后**在 ComfyUI 界面里刷新一下**（或重启），让它重新扫模型目录。命令行确认：

```bash
curl -s http://127.0.0.1:8188/object_info/CheckpointLoaderSimple
# 返回 JSON 里 ckpt_name 的枚举值就是它当前认识的底模列表
```

### 1.4 关于显卡的额外注意

这套插件只管「调 ComfyUI」，出图快不快、能不能跑，全看 ComfyUI 那边：

- **NVIDIA**：装 CUDA 版 PyTorch，用 `run_nvidia_gpu.bat`（便携版自带环境）。
- **AMD**：Windows 上通常走 DirectML 或 ROCm（Linux），按 ComfyUI README 的对应章节走。
- **Intel（Arc 独显 / 核显）**：ComfyUI 官方主线对 Intel 的支持不如 CUDA 顺，
  常见做法是走 **IPEX-LLM** 的 ComfyUI 支持（见 [ipex-llm](https://github.com/intel/ipex-llm) 的 ComfyUI 章节），
  或者退回 CPU 模式（能跑，但一张 1024 图可能要几分钟）。
- **纯 CPU**：启动时加 `--cpu`。功能不缺，只是慢——出图慢的时候先把 `steps` 和尺寸调小。

> 插件侧不需要任何显卡设置：显存不够、模型不兼容这类问题会以 ComfyUI 的报错原文返回给你。

### 1.5 （可选）装背景移除节点

**只有 `remove_background` 模式需要**，其余三种模式纯核心 ComfyUI 就能跑。
插件会在下面四套里自动择优（按顺序），装**任意一套**即可：

| 方案 key | 需要的节点 | 安装 |
|---|---|---|
| `essentials` | `RemBGSession+` → `ImageRemoveBackground+` | `git clone https://github.com/cubiq/ComfyUI_essentials` 到 `custom_nodes/`，再用 ComfyUI 自己的 Python 执行 `pip install "rembg[cpu]"` |
| `bria` | `BRIA_RMBG_ModelLoader_Zho` → `BRIA_RMBG_Zho` | `git clone https://github.com/ZHO-ZHO-ZHO/ComfyUI-BRIA_AI-RMBG` 到 `custom_nodes/`（首次使用会自动下权重） |
| `layerstyle` | `LayerMask: RemBgUltra` | `git clone https://github.com/chflame163/ComfyUI_LayerStyle` 到 `custom_nodes/`，按它的 README 装 `rembg` / `onnxruntime` |
| `was` | `Image Rembg (Remove Background)` | `git clone https://github.com/ltdrdata/was-node-suite-comfyui` 到 `custom_nodes/`，按它的 requirements 装依赖（含 `rembg` / `onnxruntime`） |

> **两个实测踩出来的坑**：
> 1. `rembg` 2.0 起**不再自动带 onnxruntime**。只写 `pip install rembg` 的话，`import rembg`
>    会直接报「No onnxruntime backend found」，必须写 `pip install "rembg[cpu]"`（或 `rembg[gpu]`）。
> 2. 类名要**逐字**照抄：essentials 的注册键是 `RemBGSession+`（**带加号**），`RemBGSession`
>    只是它的 Python 类名，`/object_info` 里没有这个名字，写错了插件就永远挑不到这套方案。
>
> 首次去背还会自动下载 u2net 权重（约 176MB）到 `~/.u2net/`。

装完**重启 ComfyUI**。想让插件只用其中某一套，就设配置 `rembgNode`（值可以是上表的方案 key，
如 `essentials` / `bria` / `layerstyle` / `was`，也可以直接写节点类名）。

用 `npm run doctor` 可以看到最终选中的是哪一套：

```
✓ 去背方案：ComfyUI_essentials（RemBGSession+ → ImageRemoveBackground+）（节点 RemBGSession+ → ImageRemoveBackground+）
```

> **核心 ComfyUI 呢？** 0.3x 起核心自带了 `LoadBackgroundRemovalModel` + `RemoveBackground`
> （输入图 → 输出 MASK，需要自己往 `models/background_removal/` 放模型）。它的产物是遮罩而不是
> 「一张图进、一张图出」，与插件现有的去背路径不同，**本插件暂未接入**（见 [ROADMAP.md](./ROADMAP.md)）。

---

## 二、把插件装进 DSH

> ⚠️ **本插件尚未发布到 npm**。所以「用包名装」现在装不到东西，请用下面的**本地路径**方式。

### 2.1 先拿到插件代码

- 从仓库 clone：`git clone <本仓库地址> D:/dsh/plugins/dsh-comfyui-image`
- 或者直接用你已有的本地目录（例如本机上的 `D:/dsh/plugins/dsh-comfyui-image`）

**不需要**跑 `npm install` / `npm run build` —— 仓库里已经带了编译好的 `lib/`。
只有你要改源码时才需要（见 [README 的开发一节](../README.md#开发)）。

### 2.2 方式 A：DSH 插件管理器（推荐）

> 目标也可以直接填 `github:wbb316/dsh-comfyui-image`：管理器会从 GitHub 拉取，**不需要你 clone 到本地**。
> 命令行等价写法是 `dsh plugin --profile <你的 profile> add github:wbb316/dsh-comfyui-image`（实测 21.6 秒）。

1. 打开 DSH → **设置 → 插件**（插件管理器）；
2. 选择**安装**，目标填本地路径，前缀 `link:`：

   ```
   link:D:/dsh/plugins/dsh-comfyui-image
   ```

3. 管理器会自己改当前 profile 的 `package.json`：加一条 `dsh-comfyui-image: link:...` 依赖，
   并把 `dsh-comfyui-image` 追加进 `dsh.profile.bundles`；失败会自动回滚。
4. 装完重启 DSH（或按界面提示重载）。

### 2.3 方式 B：手动改 profile

编辑 `~/.dsh/profiles/<你的 profile>/package.json`：

```jsonc
{
  "dependencies": {
    // ……
    "dsh-comfyui-image": "link:D:/dsh/plugins/dsh-comfyui-image"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ……（保留原有条目）
        "dsh-comfyui-image"
      ]
    }
  }
}
```

然后在 profile 目录里装一次依赖：

```bash
cd ~/.dsh/profiles/<你的 profile>
pnpm install        # 或者用 DSH 界面里的「安装/更新插件」
```

重启 DSH。（改 profile 的 `package.json` 前建议先备份 —— 这个文件里还挂着别的插件。）

### 2.4 方式 C：不装 DSH，先单独验证

插件本身**不 import 任何宿主包**，所以可以直接在 Node 里跑，不需要 DSH 在位：

```bash
cd <插件目录>
npm run doctor    # 直接对着 ComfyUI 体检，不经过 DSH

# 想手动试一下配置解析和工具定义：
node -e "import('./lib/index.js').then(m => {
  const cfg = m.resolveConfig()
  console.log('ComfyUI 地址：', cfg.baseUrl, '| 默认底模：', cfg.checkpoint ?? '(自动挑)')
  console.log('工具名：', m.TOOL_NAME, '| 参数：', Object.keys(m.PARAMETERS_SCHEMA.properties).join(', '))
  console.log('是否已构建：', typeof m.runGeneration === 'function')
})"
```

所以**装插件之前**就能先确认「ComfyUI 那边一切正常」——`doctor` 和真实执行路径调的是同一批探测函数，
不会出现「自检说能跑、真跑却挑不到底模」。

### 2.5 插件在 profile 配置树里的样子

本包自带一份 `cordis.patch.yml`，装了 bundle 就会自动往配置树里插一条：

```yaml
- insert:
    - id: dsh-comfyui-image
      name: dsh-comfyui-image
```

想在这里直接给插件写配置（优先级最高，见 [CONFIG.md](./CONFIG.md)），就在**profile 的**
`cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-comfyui-image
  name: dsh-comfyui-image
  config:
    baseUrl: 'http://127.0.0.1:8188'
    checkpoint: 'sd_xl_base_1.0.safetensors'
```

想临时关掉插件：加 `disabled: true`，或用插件管理器里的开关。

---

## 三、装完怎么确认成功

按顺序做这四件事，每件都能独立判断：

| # | 检查 | 期望看到 |
|---|---|---|
| 1 | `npm run doctor`（在插件目录） | 打印生效配置 + ComfyUI 版本 + 四种模式的可用性；退出码 `0` |
| 2 | DSH 设置 → 插件列表 | 能看到 `dsh-comfyui-image`（显示名「ComfyUI 图片生成」），开关可用 |
| 3 | 对 Agent 说「用 generate_image 生成一张测试图」 | 模型能看到并调用这个工具，返回 `✅ 出图成功` + 一行绝对路径 |
| 4 | 点/打开返回的路径 | 图片存在，旁边还有一个同名 `.json` 元数据文件 |

任何一步不对，先看 [FAQ.md](./FAQ.md)；再不行就带上 `npm run doctor --json` 的输出提 issue。

---

## 四、卸载

1. 插件管理器里**移除**该 bundle（或手动删掉 profile `package.json` 里的依赖与 `bundles` 条目），重启 DSH；
2. 可选清理：删除配置文件目录 `~/.dsh-comfyui-image/`；
3. 插件**不会**往 ComfyUI 里装任何东西、也不改 ComfyUI 配置；
   它产生的中间文件都在 ComfyUI 的 `output/dsh-comfyui-image/` 子目录里，想清就删这个目录。

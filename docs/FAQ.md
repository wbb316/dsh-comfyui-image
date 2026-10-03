# 常见问题与故障排查

排查顺序建议：**先跑 `npm run doctor`**（它把「配置 → 连通性 → 底模 → 四种模式」一次问清楚），
再对着下面的报错原文表定位。

```bash
cd <插件目录>
npm run doctor            # 人看
npm run doctor -- --json  # 贴 issue 用
```

---

## 一、先看自检怎么读

```
【生效配置】来源优先级：插件配置 > ~/.dsh-comfyui-image/config.json > 环境变量 > 默认值
  配置文件：C:\Users\me\.dsh-comfyui-image\config.json（存在：是）
  ComfyUI 地址：http://127.0.0.1:8188
  底模：自动选择
  ...

【ComfyUI】可达：是
  版本/设备：...

【底模】共 2 个可选：sd_xl_base_1.0.safetensors、v1-5-pruned-emaonly.safetensors
【采样器】...

【模式可用性】
  ✓ 文生图 text2img：可用
  ✓ 图生图 img2img：可用
  ✓ 局部重绘 inpaint：可用
  ✗ 背景移除 remove_background：不可用
    → 本机 ComfyUI 里没有任何可用的背景移除节点。
```

三个退出码的含义：

| 退出码 | 含义 | 下一步 |
|---|---|---|
| `0` | 四种模式全可用 | 没别的事了，直接出图 |
| `1` | **连不上 ComfyUI** | 先解决连通性，见下文 §2 |
| `2` | 连上了，但有模式跑不了 | 看 `✗` 那几行的原因（多半是缺底模或缺去背节点） |

> 别忘了 `npm run doctor` 是**在插件目录**里跑的，且它不经过 DSH —— 所以它能用来在装插件之前
> 就验证 ComfyUI 那一侧。

---

## 二、连不上 ComfyUI

报错原文：

```text
连不上 ComfyUI：http://127.0.0.1:8188（fetch failed）

请先启动本地 ComfyUI 服务（默认监听 127.0.0.1:8188），或把地址改对——改
~/.dsh-comfyui-image/config.json 里的 baseUrl，或设环境变量 COMFYUI_URL=http://主机:端口。
```

按顺序查：

1. **ComfyUI 到底起了吗**：浏览器打开 `http://127.0.0.1:8188/system_stats`，看有没有 JSON。
   命令行：`curl -s -o NUL -w "%{http_code}" http://127.0.0.1:8188/system_stats`（Linux/macOS 用 `/dev/null`）。
2. **端口对不对**：ComfyUI 换端口是启动参数（`--port 8189`），改完插件这边也要改 `baseUrl`。
3. **是不是在容器 / WSL / 虚拟机里**：那边的 `127.0.0.1` 指的是它**自己**，不是宿主机。
   要把 `baseUrl` 改成宿主机的实际 IP（例如 `http://192.168.1.10:8188`），并让 ComfyUI 监听 `--listen 0.0.0.0`。
4. **`0.0.0.0` 别当请求地址填**：`0.0.0.0` 是「监听所有网卡」的意思，不是能连的目标。
   插件看到这个值会警告并建议改成 `127.0.0.1`（或具体 IP）。
5. **代理变量**：如果设了 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，某些 Node 配置会把 `127.0.0.1`
   也走代理，于是本地请求被代理拦掉。临时清掉这几个变量试试：

   ```powershell
   $env:HTTP_PROXY=''; $env:HTTPS_PROXY=''; $env:ALL_PROXY=''; npm run doctor
   ```
6. **防火墙**：Windows 首次启动 ComfyUI 时会弹「允许访问网络」，如果当时点了“取消”，
   本机回环一般仍可访问，但换成局域网 IP 就会被拦。

---

## 三、报错原文 → 原因 → 怎么办

### 「ComfyUI 里没有 CheckpointLoaderSimple 节点」/「ComfyUI 里没有 KSampler 节点」

```text
ComfyUI 里没有 CheckpointLoaderSimple 节点。
下一步：这个节点是 ComfyUI 核心自带的。请确认 baseUrl 指向的是真的 ComfyUI，且版本不过旧。
```

**原因**：`baseUrl` 指向的不是 ComfyUI（比如指到了自己的反向代理、别的服务、或者一个假端口），
或者 ComfyUI 版本太老。**先访问 `http://<baseUrl>/object_info/KSampler`** 看有没有 JSON。

### 「ComfyUI 报告没有任何可用的底模（models/checkpoints 是空的）」

**原因**：ComfyUI 的 `models/checkpoints/` 是空的。

**解决**：往里放一个 `.safetensors` / `.ckpt`（SDXL 或 SD1.5 都行），然后在 ComfyUI 界面里**刷新**一下
（或重启），再跑 `doctor`。注意别放错目录 —— 便携版是
`ComfyUI_windows_portable/ComfyUI/models/checkpoints/`。

### 「指定的底模不存在：xxx」

```text
指定的底模不存在：my-model.safetensors
下一步：本机可用的底模有：a.safetensors、b.safetensors。请把 model 改成其中之一，或清空该配置让插件自动挑。
```

**原因**：配置里的 `checkpoint`（或调用时传的 `model`）写的名字和 ComfyUI 认识的名字不完全一样
（**带不带子目录前缀**、后缀 `.safetensors` 都可能不一样）。照报错里列出的名字抄。

### 「采样器不存在」/「调度器不存在」

```text
采样器不存在：dpmpp_3m
下一步：本机可用：euler、euler_ancestral、dpmpp_2m、…
```

**原因**：你**显式**传了 `sampler_name` / `scheduler`，而本机没有这个值 —— 显式指定会被严格校验。

**注意区别**：如果只是**配置里的默认值**在本机没有，插件不会报错，而是**自动回退**并在结果 `notes` 里说明：

```text
备注：
  - 采样器 dpmpp_3m 在本机不存在，已改用 euler。
```

### 「本机 ComfyUI 里没有任何可用的背景移除节点」

只影响 `remove_background`，其他三种模式不受影响。插件会列出四套方案的安装命令
（`ComfyUI_essentials` / `ComfyUI-BRIA_AI-RMBG` / `ComfyUI-LayerStyle` / `WAS Node Suite`），
装任意一套、重启 ComfyUI 即可。详见 [INSTALL.md §1.5](./INSTALL.md#15-可选装背景移除节点)。

### 「节点 rb1: required_input_missing … rembg_session」

```text
工作流被 ComfyUI 拒绝（HTTP 400）：节点 rb1: required_input_missing（rembg_session）
```

`ImageRemoveBackground+` 有一个**必填**输入 `rembg_session`（类型 `REMBG_SESSION`），
必须由 `RemBGSession+` 喂进来，插件从 0.1.0 起会**成对**构建这两个节点。
看到这条报错说明跑的是「把该节点当单节点用」的旧副本——
插件模块是启动时加载的，**改完文件不会热更新，要重启 DSH（或新开会话）**。

### 「配置里的 rembgNode=xxx 不在已知方案里」

```text
配置里的 rembgNode=foo 不在已知方案里。
下一步：已知：essentials（ComfyUI_essentials（RemBGSession+ → ImageRemoveBackground+））；bria（…）；layerstyle（…）；was（…）
```

`rembgNode` 只认这四个 key，或者直接写节点类名（如 `RemBGSession+`、`ImageRemoveBackground+`）。
把它清空就会恢复「自动择优」。

### 「ComfyUI 执行工作流失败（prompt_id=…）」

```text
ComfyUI 执行工作流失败（prompt_id=8f3c…）：…

下一步：常见的两个原因：工作流里用到的节点/模型在本机不存在（去 ComfyUI 控制台看红色报错），
或者显存不足。也可以用模型参数覆盖：generate_image 的 model / steps / width / height 调小一点重试。
```

**怎么办**：打开 ComfyUI 界面，在队列/历史里按 `prompt_id` 找到这次任务，看它标红的节点。
最常见的三类：缺自定义节点、缺 VAE/模型的子文件、显存不足（OOM）。
OOM 的典型解法：尺寸降到 768 或 512、`steps` 调小、换个更小的底模。

### 「等待 ComfyUI 出图超时（等了 N 秒）」

**原因**：ComfyUI 那边在排队/很慢。**怎么办**：

- 把配置里 `timeoutMs` 调大（默认 300 秒，上限 1 小时）；
- 看一眼 ComfyUI 是不是正在跑别的任务（它默认一次只跑一个）；
- 缩小尺寸 / 减少 `steps`；CPU 模式出图本来就慢，1024×1024 可能要几分钟；
- 插件在超时时**已经尽力调用了 `/interrupt`**（不让它白占显存），但 ComfyUI 可能还在收尾。

### 「ComfyUI 报告任务已结束（状态 …），但没有任何图片产出」

```text
ComfyUI 报告任务已结束（状态 success），但没有任何图片产出（prompt_id=…）。

下一步：最常见的原因是工作流末端没有接 SaveImage / PreviewImage 节点——用
extra_options.workflow_path 传自定义工作流时特别容易这样。也可能是工作流只输出了 mask / latent 之类的非图片结果。
```

**原因**：用逃生舱传自定义工作流时，末端没接保存节点。**解决**：在 ComfyUI 里给工作流加一个
`SaveImage`（或 `PreviewImage`），重新导出 API 格式。

### 「input_image 指向的文件不存在」/「是一个空文件（0 字节）」

```text
input_image 指向的文件不存在：D:\pics\in.png
下一步：请检查路径是否正确。
```

- 相对路径是**相对 Agent 的当前工作目录**（就是工具返回里默认出图的那个目录），不是相对插件目录；
- 支持 `~`，Windows 反斜杠/正斜杠都行；路径里有空格时**用引号包起来**（在 JSON 里就是普通的字符串）；
- 0 字节文件会被提前拦下：常见原因是下载没下完、或者路径其实指向了一个占位文件。

### 「width 超出允许范围 64~8192」/「steps 必须是数字」

参数校验报错，改值就行。注意：
- 尺寸只对 `text2img` 有意义，其他模式传了会被**忽略**（`notes` 里会说明）；
- 尺寸会自动对齐到 **8 的倍数**，被改过也会在 `notes` 里如实说明。

### 「已取消：调用方中止了本次生成。」

你在 DSH 里按了停止 / 中断。ComfyUI 那边的任务**可能还会跑完**（插件的取消是尽力而为）。

### 参数冲突类报错

```text
mode=text2img 不接受 input_image（收到 D:\in.png）。
下一步：想基于这张图改，请显式传 mode="img2img"（要局部改就再带上 mask_image 并传 mode="inpaint"）。
```

这类报错是**故意的**（宁可报错也不猜，避免「以为在局部重绘，结果整图重画」）。
对照 [PARAMS.md 的冲突表](./PARAMS.md#二模式推断与冲突规则) 改参数即可。

---

## 四、其他常见疑问

### DSH 里看不到 `generate_image` 工具

按顺序查：

1. **插件启用了吗**：设置 → 插件列表里 `dsh-comfyui-image` 是不是开着；
2. **装进的是当前 profile 吗**：换过 profile（例如 web / desktop / headless）的话，
   `dsh.profile.bundles` 是在**那一个** profile 的 `package.json` 里加的；
3. **重启过 DSH 吗**：bundle 列表是启动时读的；
4. **会话是在装插件之前开的吗**：工具表在会话/运行时装配时注入，装完插件**新开一个会话**最稳；
5. **看宿主日志有没有这行警告**：`拿不到 tools 服务，generate_image 未注册（请在 profile 里确认插件依赖正常）。`
   —— 出现它就说明插件加载了但工具注册表没拿到。

### 改了 `~/.dsh-comfyui-image/config.json` 没反应

配置**每次调用都会重新解析**，所以正常情况下立即生效。没生效多半是：

1. 同一项**也**写在 profile 的插件 `config:` 里了 —— 插件配置优先级更高，会盖掉配置文件；
2. 环境变量在盖（`COMFYUI_URL` 等）；
3. **JSON 写坏了**：读不了时插件**不会崩**，而是静默退回默认值，只在日志里留一条警告。
   跑 `npm run doctor` 看「生效配置」那段最直观。

### 图片在 DSH 里显示不出来 / 点不开

- 返回的 `path` 是**绝对路径**，插件保证它单独占一行（这样前端才能识别成文件引用）；
- 文件真的存在吗：去那个路径看一眼（同目录还会有个同名 `.json`）；
- 路径太长 / 含特殊字符的极端情况，可以先传 `output_path` 到更短、更简单的目录试试。

### 出图很慢怎么办

| 手段 | 效果 |
|---|---|
| 降尺寸（1024 → 768 / 512） | 最有效，显存占用与耗时都按面积掉 |
| `steps` 20 → 12~15 | 明显变快，质量损失通常可接受 |
| 换更小的底模（SD1.5 系） | 快很多，插件识别到 SD1.5 会自动按 512 出图 |
| 确认用的是 GPU 而不是 CPU | 看 ComfyUI 启动日志；CPU 出 1024 图要几分钟是正常的 |
| 关掉 `saveToComfyUI` | 不影响速度，但不再往 ComfyUI 的 output 里堆文件 |

### 出图占用多少磁盘 / 能清理什么

- 每张图 ≈ 1~3 MB（1024×1024 PNG），旁边 `.json` 几 KB；
- ComfyUI 那边（`saveToComfyUI: true` 时）会在 `output/dsh-comfyui-image/` 里留一份，可以随时删；
- 上传给 ComfyUI 的输入图会进 ComfyUI 的 `input/` 目录，ComfyUI 自己不清理时也会越攒越多。

### 会泄露隐私吗 / 联网吗

不会。插件只连你配置的 `baseUrl`，不访问任何第三方服务，也不把图片上传到云。
唯一的网络行为就是和你自己的 ComfyUI 说话。详见 [CONFIG.md §6](./CONFIG.md#六安全与隐私)。

### 怎么上报问题

带上这几样，通常一次就能定位：

1. `npm run doctor --json` 的输出（已经隐去了业务数据，只有配置和节点清单）；
2. 报错原文（工具返回的那段文本，包含 `prompt_id`）；
3. 出图目录里对应的 `.json` 元数据（含完整参数与工作流，**注意里面可能有你的提示词和本地路径**，按需删减）；
4. DSH 版本、操作系统、ComfyUI 版本（`/system_stats` 里能看到）。

需要更细的过程日志（选中的去背方案、上传给 ComfyUI 的文件名、HTTP 细节）时，
在启动 DSH 前设 `DSH_COMFYUI_IMAGE_DEBUG=1`，复现一次，然后把带 `[dsh-comfyui-image]` 前缀的行一起贴上来。

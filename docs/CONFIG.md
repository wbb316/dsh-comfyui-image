# 配置说明

插件的配置有**四个来源，优先级从高到低**：

```
① 插件配置    profile 的 cordis.patch.yml 里那条 entry 的 config:   ← 最高
② 配置文件    ~/.dsh-comfyui-image/config.json
③ 环境变量    COMFYUI_URL 等
④ 内置默认值  src/config.ts 里的 DEFAULTS                          ← 最低
```

合并规则是**逐键**的：某一项在①里没有、在②里有，就用②。非法值（负数步数、非数字超时…）
**不会**让插件崩，而是被丢掉并退回默认值（debug 日志里有痕迹）。

为什么①最高：DSH 的配置树是运维/宿主的权威来源，写了就该它说了算。
而②③是给「只想改个地址，不想动 YAML」的人准备的便利层。

> ✨ **配置是每次调用时重新解析的** —— 改完 `config.json` **立即生效，不用重启 DSH**。

---

## 一、最常用的方式：改配置文件

路径：`~/.dsh-comfyui-image/config.json`（Windows 上是 `C:\Users\<你>\.dsh-comfyui-image\config.json`）

不存在就自己建（目录一起建）。一份典型配置：

```json
{
  "baseUrl": "http://127.0.0.1:8188",
  "checkpoint": "sd_xl_base_1.0.safetensors",
  "outputDir": "D:/images",
  "steps": 25,
  "cfgScale": 7,
  "timeoutMs": 600000,
  "saveToComfyUI": false
}
```

**所有键都是可选的**，只写你要改的那几个。

---

## 二、全部配置项

### 连接与位置

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `baseUrl` | string | `http://127.0.0.1:8188` | `COMFYUI_URL` / `COMFYUI_BASE_URL` | ComfyUI 地址；末尾的 `/` 会被自动去掉。**别填 `0.0.0.0`**（那是监听地址，不是请求地址），插件会警告并建议改 `127.0.0.1` |
| `outputDir` | string | 无（落当前项目根目录） | `DSH_COMFYUI_IMAGE_OUTPUT` | 默认输出目录。工具参数 `output_path` 优先级更高；支持 `~` 展开 |
| `requestTimeoutMs` | number | `30000` | — | 单次 HTTP 请求超时（毫秒），合法区间 `1000`~`600000` |
| `timeoutMs` | number | `300000` | `COMFYUI_TIMEOUT_MS` | **等出图**的总超时（毫秒），合法区间 `1000`~`3600000`。慢机器 / 大模型就调大 |
| `pollIntervalMs` | number | `700` | — | 轮询 `/history` 的间隔（毫秒），合法区间 `100`~`10000` |

### 生成默认值

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `checkpoint` | string | 自动挑 | `COMFYUI_CHECKPOINT` | 底模文件名（`models/checkpoints` 下的名字）。不填就自动挑一个可用的，**优先带 `xl` 的** |
| `negativePrompt` | string | 见下 | — | 默认负向提示词；工具参数 `negative_prompt` 会覆盖它 |
| `steps` | number | `20` | `COMFYUI_STEPS` | 采样步数，合法区间 `1`~`500` |
| `cfgScale` | number | `7` | `COMFYUI_CFG_SCALE` | CFG，合法区间 `0`~`100` |
| `samplerName` | string | `euler` | `COMFYUI_SAMPLER` | 采样器；**本机不存在时会自动回退**并在结果 `notes` 里说明 |
| `scheduler` | string | `normal` | `COMFYUI_SCHEDULER` | 调度器；同样会自动回退并说明 |
| `width` / `height` | number | `1024` / `1024` | — | 默认尺寸，合法区间 `64`~`8192`。**只对 `text2img` 生效**；若底模名字像 SD1.5 会自动改用 512×512 |
| `strength` | number | `0.6` | — | 图生图默认改动幅度，合法区间 `0`~`1`（`inpaint` 的默认值是写死的 `1.0`） |
| `inpaintGrowMask` | number | `6` | — | 局部重绘时遮罩向外扩张的像素数，合法区间 `0`~`256`。调大能让接缝更自然，调 0 会留下硬边 |

内置默认负向提示词：

```text
lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry
```

### 输出与元数据

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `saveToComfyUI` | boolean | `true` | — | `true` = 工作流用 `SaveImage`，产出同时留在 ComfyUI 的 `output/dsh-comfyui-image/`；`false` = 改用 `PreviewImage`，**不污染** ComfyUI 的 output 目录 |
| `writeMetadata` | boolean | `true` | — | 是否在图片旁写 `<图片>.json` 元数据 sidecar（含完整参数与工作流，未来做一致性要靠它） |

### 背景移除

| 键 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `rembgNode` | string | 自动择优 | `COMFYUI_REMBG_NODE` | 指定去背方案，**只影响 `remove_background`**。可填方案 key：`essentials` / `bria` / `layerstyle` / `was`，也可以直接填节点类名（如 `RemBGSession+`、`ImageRemoveBackground+`）。指定的方案在本机不存在时会**明确报错**（而不是偷偷换别的） |

### 插件自身

| 环境变量 | 说明 |
|---|---|
| `DSH_COMFYUI_IMAGE_CONFIG` | 覆盖**配置文件路径本身**（默认 `~/.dsh-comfyui-image/config.json`）。测试和多环境切换用 |
| `DSH_COMFYUI_IMAGE_DEBUG` | 设为 `1` / `true` / `yes` 打开调试日志（带 `[dsh-comfyui-image]` 前缀）：配置解析结果、选中的去背方案、上传给 ComfyUI 的文件名、HTTP 细节等。**默认关闭**，避免污染 DSH 会话输出 |

---

## 三、环境变量速查表

按字母序，方便往 Docker / 启动脚本里抄：

```bash
COMFYUI_URL=http://127.0.0.1:8188          # = baseUrl
COMFYUI_BASE_URL=http://127.0.0.1:8188     # = baseUrl（别名）
COMFYUI_CHECKPOINT=sd_xl_base_1.0.safetensors
COMFYUI_STEPS=25
COMFYUI_CFG_SCALE=7
COMFYUI_SAMPLER=euler
COMFYUI_SCHEDULER=normal
COMFYUI_TIMEOUT_MS=600000
COMFYUI_REMBG_NODE=essentials
DSH_COMFYUI_IMAGE_OUTPUT=D:/images         # = outputDir
DSH_COMFYUI_IMAGE_CONFIG=/etc/dsh-cii.json # 配置文件路径本身
DSH_COMFYUI_IMAGE_DEBUG=1                  # 打开调试日志
```

布尔项（`saveToComfyUI` / `writeMetadata`）只认 `true` / `false` / `1` / `0`（大小写不敏感）。

> 环境变量是整个 DSH 进程级的 —— 想让某个键对**所有人**生效但优先级又低于 profile，
> 就写配置文件；只想一次性覆盖，用环境变量。另外**注意**：从图形界面启动的 DSH 未必继承你
> 在终端里 `set` 的环境变量（Windows 尤其容易踩）。

---

## 四、写在 profile 配置树里（优先级最高）

编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- id: dsh-comfyui-image
  name: dsh-comfyui-image
  config:
    baseUrl: 'http://127.0.0.1:8188'
    checkpoint: 'sd_xl_base_1.0.safetensors'
    outputDir: 'D:/images'
    timeoutMs: 900000
```

改完重启 DSH（配置树是启动时读的）。想临时关掉插件：同一处加 `disabled: true`，
或者在插件管理器里关。

Cordis 在没有导出 `Config` schema 时会把原始对象**原样**交给 `apply`，所以这里不需要任何 schema 声明。

---

## 五、确认配置真的生效

```bash
cd <插件目录>
npm run doctor
```

输出的第一段就是**生效配置**和它来自哪里：

```
【生效配置】来源优先级：插件配置 > ~/.dsh-comfyui-image/config.json > 环境变量 > 默认值
  配置文件：C:\Users\me\.dsh-comfyui-image\config.json（存在：是）
  ComfyUI 地址：http://127.0.0.1:8188
  底模：自动选择
  默认尺寸：1024x1024　steps=20　cfg=7　采样器=euler/normal
  超时：300 秒　输出目录：当前工作目录
```

`--json` 可以拿到机器可读版本，便于对比和贴 issue。

**配置没生效的三条自查顺序**：

1. 这一项是不是**同时**写在 profile 的插件 `config:` 里了？（它优先级更高，会盖掉配置文件）
2. 可能是环境变量在盖：`COMFYUI_URL` 一类是不是在别处设过？
3. JSON 语法错了吗？—— 配置**读不了时插件不会崩**，会**静默退回默认值**并在日志里警告，
   所以「文件明明改了却没反应」最常见的原因就是拼错了一个逗号。单独验一下语法即可：

   ```bash
   node -e "const fs=require('fs'),os=require('os'),p=require('path');JSON.parse(fs.readFileSync(p.join(os.homedir(),'.dsh-comfyui-image','config.json'),'utf8'));console.log('JSON 语法 OK')"
   ```

   或者直接看 `doctor` 打印的「生效配置」——它显示的就是**合并之后真正会用的值**。

---

## 六、安全与隐私

- 插件**只**连你配置的 `baseUrl`，不发往任何第三方服务；
- 不上传你的图片到任何云（只上传到本地 ComfyUI 的 `/upload/image`）；
- 不读也不写 ComfyUI 的配置/模型目录（除了走它的 HTTP API）；
- 唯一写入的位置：你指定的输出目录、`~/.dsh-comfyui-image/`、以及图片旁的 `.json` sidecar。

# 更新日志

本文件记录 **dsh-comfyui-image** 的版本变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] — 2026-10-03

首个可用版本（需求书里的「实用版 V1」）。

### 新增

- **统一的 Agent 工具 `generate_image`**：一个入口覆盖四种模式，内部按模块拆分，
  对外只暴露一个工具（`text2img` / `img2img` / `inpaint` / `remove_background`）。
- **参数推断**：不传 `mode` 时按 `input_image` / `mask_image` 推断（有图+遮罩 → inpaint，只有图 → img2img，
  都没有 → text2img）；模式**不猜**，冲突直接报错并给出怎么改。
- **统一抽象参数层**：`prompt` / `negative_prompt` / `input_image` / `mask_image` / `width` / `height` /
  `seed` / `output_path` / `strength` / `steps` / `cfg_scale` / `model` / `sampler_name` / `scheduler` /
  `extra_options`；`style_reference` / `character_reference` 作为一致性预留位（V1 只记录进元数据）。
- **合理默认值**：尺寸按底模自动（SDXL 1024 / SD1.5 512）、seed 随机、steps 20、cfg 7、
  输出落到当前项目根目录、文件名带时间戳且**绝不覆盖**已有文件。
- **本地 ComfyUI 后端**：只用 Node 内置能力（`fetch` / `FormData`），零运行时依赖；
  自己实现 `/system_stats`、`/object_info`、`/upload/image`、`/prompt`、`/history`、`/view`、`/interrupt` 的调用。
- **能力探测**：自动挑底模（优先带 `xl` 的）、校验采样器/调度器是否真的存在、按可用性挑一套去背方案
  （ComfyUI_essentials / ComfyUI-BRIA_AI-RMBG / ComfyUI-LayerStyle / WAS Node Suite 四套择优；
  仓库与节点类名取自 ComfyUI-Manager 的 `extension-node-map.json` 索引，不凭记忆写）。
- **明确报错**：连不上 ComfyUI、输入文件不存在、工作流执行失败、超时、缺去背节点……
  每条错误都带「下一步怎么办」，而不是一句 `fetch failed`。
- **结果与元数据**：返回本地绝对路径（单独一行，DSH 里可直接点开）、mode / seed / 尺寸 / 耗时 / prompt_id 等；
  每张图旁边写一份 `.json` 元数据 sidecar（含完整参数与提交的工作流，可复现、可调试）。
- **配置四层来源**：插件配置 > `~/.dsh-comfyui-image/config.json` > 环境变量 > 内置默认值；
  改配置文件**立刻生效**，不用重启 DSH。
- **扩展逃生舱**：`extra_options.workflow_path` 可指向任意 API 格式工作流 JSON，
  用 `{{prompt}}` / `{{seed}}` / `{{input_image}}` 等占位符接管本次生成（扩图、超分、批量、特殊节点都能自己接）。
- **自检脚本** `npm run doctor`：打印生效配置、ComfyUI 版本与设备、底模/采样器真实可选值，
  并逐模式判定能不能跑（退出码 0 全部可用 / 1 连不上 / 2 有模式不可用）。
- **测试**：88 项测试，含一个「假 ComfyUI」（真 PNG 编解码、真上传、真轮询、真报错路径）的端到端验证——
  没装 ComfyUI 的机器也能跑。
- **文档**：中英双语 README（`README.md` / `README.en.md`）与安装教程（`docs/INSTALL.md` / `docs/INSTALL.en.md`），
  另有 `docs/`（配置、用法、参数、FAQ、路线图）。

### 修复

真机验证（ComfyUI 0.38.0 + Intel Arc XPU）跑出来的两个 bug，都已修并带回归测试：

- **默认尺寸的「按底模自适应」在最常见的路径上不生效**：参数层解析时底模可能还没定
  （用户没传 `model`、配置里也没写 `checkpoint`，得靠自动挑选），于是尺寸永远落到配置默认值——
  本机只有 SD1.5 底模时仍出 1024×1024，与工具说明承诺的 512 自相矛盾。
  现在把「哪些维度是显式给的」记在请求里，等底模真正选定（可能是自动挑的）后再补默认尺寸，
  并在 `notes` 里写明依据；mock 也补上了「只放 SD1.5 底模」的用例，消除
  「自适应值恰好等于配置默认值」造成的盲区。
- **`img2img` / `inpaint` 报告的尺寸与产出图不符**：`width` / `height` 在 `OUTPUT_SCHEMA` 里的含义是
  「输出宽度 / 输出高度」，但报告与 sidecar 之前照抄请求值——512×512 的输入图产出 512 的图，
  报告里却写着 1024。现在一律以**产出文件字节**里的真实像素为准（解析 PNG / JPEG 头部），
  与请求值不同时额外在 `notes` 里说明原因。顺带把 mock 改忠实：`img2img` / `inpaint` 的产出尺寸
  改为跟随上传的输入图（与真实 ComfyUI 一致），不再一律回 64×64。
- **一条测试的环境依赖**：它要求「默认地址必然连不上」，本机装了 ComfyUI 就会失败（CI 上绿、
  开发机红）。现已按测试套件自己的原则把默认地址钉到不可达端口，只验证该验证的事。
- **`npm test` 在 Node 20 上直接报错**（CI 矩阵里 Node 20 两个平台全红、Node 22 全绿）：
  `node --test "test/*.test.mjs"` 依赖 `--test` 的 glob 展开，而那是 Node 21 才有的能力，
  Node 20 会把引号里的通配符当字面路径，报 `Could not find '.../test/*.test.mjs'`；
  去掉引号交给 shell 展开也不行——npm scripts 在 Windows 走 cmd（不展开 glob）、POSIX 走 sh（展开）。
  现改为 `scripts/run-tests.mjs`：自己列出 `test/*.test.mjs`，把**显式路径**交给 `--test`，
  Node 18+ 通用、两个平台行为一致（`engines` 仍声明 `>=20`，不靠提高门槛掩盖兼容问题）。
- **去背方案清单里的三处硬伤**（真机装上 `ComfyUI_essentials` 之后才暴露，靠 ComfyUI-Manager 的
  `extension-node-map.json` 索引定证）：
  1. 原第一优先方案写的是节点类名 `RemBG`，而索引里**没有任何仓库**声明这个类名，
     安装提示指向的 `Limbicnation/ComfyUI_RemBG-U2Net` 仓库也**不存在**（API 返回 404）；
  2. 提示里说 `git clone https://github.com/1038lab/ComfyUI-RMBG` 就能拿到 `BRIA_RMBG_Zho`，
     但该仓库提供的是 `AILab_*` 那一套，真正的提供者是 `ZHO-ZHO-ZHO/ComfyUI-BRIA_AI-RMBG`；
  3. essentials 方案把 `ImageRemoveBackground+` 当**单节点**用，可它的 `rembg_session` 是必填输入，
     必须由 `RemBGSession+` 喂进来；缺了会在真机上以
     「HTTP 400 required_input_missing: rembg_session」失败——**`doctor` 还会误报「可用」**，
     因为探测阶段只检查节点是否存在。
  现在四套方案全部换成索引里可查的真实仓库，essentials 改为 `RemBGSession+ → ImageRemoveBackground+`
  **成对**构建并断言接线，另补一个单节点方案（WAS）的回归测试，覆盖 `buildSingle` 分支。

### 已知限制

- 背景移除依赖第三方自定义节点，本插件只做择优与安装指引，不打包节点。核心 ComfyUI 0.3x 起自带
  `LoadBackgroundRemovalModel` + `RemoveBackground`（输入图 → 输出 MASK，需自备
  `models/background_removal/` 模型），与现有「一张图进、一张图出」的路径不同，**暂未接入**。
- `upscale` / `outpaint` / 批量多图**不在 V1 内置范围**，走 `extra_options.workflow_path` 自定义工作流实现。
- `style_reference` / `character_reference` **V1 只记录、不参与生成**（一致性属于后续版本）。
- 真机已验：ComfyUI 0.38.0 + Intel Arc（XPU 后端，`torch 2.14.0+xpu`），**四种模式全部端到端跑通**——
  `text2img` / `img2img` / `inpaint` 直接出图；`remove_background` 走
  `RemBGSession+ → ImageRemoveBackground+`，产出 512×512 的 RGBA（真 alpha 通道，可验证）。
  缺第三方节点时的报错路径同样实测过，会列出四套可照做的安装方案。
  节点键名与枚举已与 ComfyUI 官方源码（`nodes.py` / `samplers.py`）逐字对账。

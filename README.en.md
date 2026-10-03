# dsh-comfyui-image

**English** | [简体中文](./README.md)

A plugin that gives [DeepSeek Harness](https://github.com/) (DSH) an **image generation capability**: the backend talks to a **local ComfyUI**, and it exposes exactly **one** Agent tool, `generate_image` — text-to-image, image-to-image, inpainting and background removal in one. It depends on no external commercial API and has **zero third-party runtime dependencies** (it only uses Node's built-in `fetch` / `FormData`).

> In one sentence: install ComfyUI, enable the plugin, then tell the Agent "generate a picture of a corgi astronaut" — that's it.

---

## Table of Contents

- [What It Solves](#what-it-solves)
- [Features at a Glance](#features-at-a-glance)
- [Requirements](#requirements)
- [Installation](#installation)
- [Enabling and Verifying](#enabling-and-verifying)
- [Letting the Agent Use It](#letting-the-agent-use-it)
- [Configuration](#configuration)
- [Tool Parameters Cheat Sheet](#tool-parameters-cheat-sheet)
- [Mode Inference and Error Rules](#mode-inference-and-error-rules)
- [Output and Files](#output-and-files)
- [Style / Character Consistency (V1 Status)](#style--character-consistency-v1-status)
- [Extension: Handing Generation Over to a Custom Workflow](#extension-handing-generation-over-to-a-custom-workflow)
- [FAQ](#faq)
- [Architecture and Directory Layout](#architecture-and-directory-layout)
- [Development](#development)
- [Roadmap](#roadmap)
- [License](#license)
- [More Documentation](#more-documentation)

---

## What It Solves

DSH has no image generation of its own, while the Agent frequently needs to "draw a picture". This plugin wires in a **local ComfyUI**:

- Agent side: it adds just one tool, `generate_image`, with few parameters, sensible defaults, and errors that tell you what to do next;
- User side: images land directly in the **current project root**, and the returned absolute path can be clicked open right inside DSH;
- Ops side: the ComfyUI address / checkpoint / default parameters all live in a config file, and changes take effect **immediately** — no DSH restart required.

## Features at a Glance

| Mode `mode` | Input | What it does | Notes |
|---|---|---|---|
| `text2img` | `prompt` | Text-to-image | Only this mode honors `width` / `height` |
| `img2img` | `prompt` + `input_image` | Image-to-image / full redraw | `strength` defaults to 0.6 |
| `inpaint` | `prompt` + `input_image` + `mask_image` | Inpainting | The mask's **white/bright area = the region to repaint**; `strength` defaults to 1.0 |
| `remove_background` | `input_image` | Background removal | **Requires a third-party background-removal node in ComfyUI** (see below) |

Other capabilities:

- **Omitting `mode` triggers auto-inference**, and there are only three rules — see [mode inference](#mode-inference-and-error-rules);
- It **never overwrites** an existing file: if the target already exists, it automatically appends a `-1` / `-2` suffix;
- A **`.json` metadata sidecar** is written next to every image (containing the full parameters and the workflow submitted to ComfyUI), so results are reproducible and debuggable;
- `remove_background` picks the **best available** option among four common background-removal node packs, and when none is installed it lists "what to install and how";
- For anything V1 doesn't build in (outpainting / upscaling / batch generation), use [`extra_options.workflow_path`](#extension-handing-generation-over-to-a-custom-workflow) to plug in your own workflow.

## Requirements

| Item | Requirement |
|---|---|
| DSH | A version with the `tools` service (tool registry); this plugin declares `dsh.engines.dsh >= 0.2.0-rc.1` |
| Node.js | **>= 20** (relies on the built-in `fetch` / `FormData` / `Blob`) |
| ComfyUI | A locally reachable ComfyUI service (default `http://127.0.0.1:8188`), with at least one checkpoint in `models/checkpoints` |
| GPU | Whatever can run ComfyUI; CPU works too, just slowly |

> Background removal is the **only** feature that needs extra nodes. Install **any one** of these
> (the plugin picks the best available automatically, in this order):
> `ComfyUI_essentials` (`RemBGSession+` → `ImageRemoveBackground+`), `ComfyUI-BRIA_AI-RMBG`,
> `ComfyUI-LayerStyle`, `WAS Node Suite`.
> For the exact commands, see [docs/INSTALL.en.md](./docs/INSTALL.en.md); note the dependency must be
> `pip install "rembg[cpu]"` (without `[cpu]` there is no onnxruntime backend — a pitfall found by testing).
>
> Core ComfyUI 0.3x ships a `RemoveBackground` node (image → MASK; you supply a model under
> `models/background_removal/`). It does not fit the plugin's "one image in, one image out" path, so it is
> **not wired up yet** — see [docs/ROADMAP.md](./docs/ROADMAP.md).

## Installation

Two steps: **get ComfyUI running first**, then **install the plugin into DSH**.

### 1. Install and start ComfyUI

Install it following the [official ComfyUI instructions](https://github.com/comfyanonymous/ComfyUI), then after starting it confirm that these two URLs open:

- `http://127.0.0.1:8188/system_stats` — health check
- `http://127.0.0.1:8188/` — the UI

Then drop at least one checkpoint (an SDXL or SD1.5 `.safetensors`) into `ComfyUI/models/checkpoints/`.

> For detailed steps (including the Windows portable build and extra notes for Intel GPUs), see [docs/INSTALL.en.md](./docs/INSTALL.en.md).

### 2. Install the plugin into DSH

> ⚠️ **This plugin is not published to npm yet**, so the second approach below (installing by "npm package name") will only work once it is published;
> for now, please install from a **local path**.

**Option A: the DSH plugin manager (recommended)**

Install it from DSH's **Settings → Plugins**, entering the local path of the plugin's directory as the target, for example:

```
link:D:/dsh/plugins/dsh-comfyui-image
```

The manager updates the profile's `package.json` itself (adding a `link:` dependency + an entry in `dsh.profile.bundles`) and rolls back if it fails.

**Option B: edit the profile manually**

Open the current profile's `package.json` (`~/.dsh/profiles/<profile>/package.json`) and do two things:

```jsonc
{
  "dependencies": {
    "dsh-comfyui-image": "link:D:/dsh/plugins/dsh-comfyui-image"   // ① add the dependency
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ……
        "dsh-comfyui-image"                                        // ② add it to bundles
      ]
    }
  }
}
```

Then install dependencies once inside the profile directory (`pnpm install`, or "Install / update plugins" in the DSH UI), and restart DSH.

**Option C: local development**

```bash
git clone <this repository> dsh-comfyui-image
cd dsh-comfyui-image
npm install          # installs only typescript and @types/node (for development)
npm run build        # only needed if you changed src/; lib/ is already committed
npm test             # 88 tests, ships with a mock ComfyUI, no real ComfyUI needed
```

After that, just link it into the profile following Option A / B.

## Enabling and Verifying

Once installed:

1. **It appears in the plugin list**: the entry name is `dsh-comfyui-image` (display name "ComfyUI Image Generation");
2. **It can be toggled**: it is an ordinary bundle entry — toggle it with the plugin manager, or write `disabled: true` in the profile's patch;
3. **The Agent can see the tool**: an extra `generate_image` shows up on the model side (this session's tool table already carries its full schema);
4. **Whether this machine can actually generate images** — running a self-check is the least effort:

```bash
cd <plugin-directory>
npm run doctor
```

The self-check prints: the effective config → the ComfyUI version and device → the **real available values** for checkpoints/samplers → a per-mode availability verdict.

> Note: the script itself prints in Chinese (it ships with the Chinese-first docs). The sample below is translated for readability.

```
[Mode availability]
  ✓ text2img: available
  ✓ img2img: available
  ✓ inpaint: available
  ✗ remove_background: unavailable
    → No usable background-removal node in the local ComfyUI.
```

Exit codes: `0` all four modes available / `1` cannot reach ComfyUI / `2` connected but some mode cannot run (handy for scripting).
Add `--json` for machine-readable output, and `--base-url http://host:port` to point at a different address temporarily.

## Letting the Agent Use It

Once enabled, just speak plainly and the Agent fills in the parameters itself:

```text
Generate a picture of a corgi astronaut on the moon, digital art style
```

The text the tool returns looks like this (the **absolute path sits on its own line** and can be clicked open in DSH):

```text
✅ Image generated (text2img, mode inferred automatically)

Image: C:\Users\me\Desktop\comfyui-20261003-130812-a1b2.png
Metadata: C:\Users\me\Desktop\comfyui-20261003-130812-a1b2.png.json

Params: seed=1783492011 size=1024x1024 steps=20 cfg=7
Checkpoint: sd_xl_base_1.0.safetensors
Sampling: euler / normal  Elapsed: 12.4 s
ComfyUI: http://127.0.0.1:8188 (prompt_id=8f3c…)
```

For more usage (call examples for the four modes, reproduction and fine-tuning, batching ideas), see [docs/USAGE.md](./docs/USAGE.md).

## Configuration

Configuration has **four layers of sources, and the higher one wins**:

```
Plugin config (the config of that entry in the profile's cordis.patch.yml)
  > config file ~/.dsh-comfyui-image/config.json
    > environment variables (COMFYUI_URL, etc.)
      > built-in defaults
```

Plugin config ranks highest because DSH's config tree is the authoritative source; the **config file**, in turn, is a convenience layer for people who "just want to change an address without touching YAML" —
**changes take effect immediately, with no DSH restart**.

The most commonly used `~/.dsh-comfyui-image/config.json` looks like this:

```json
{
  "baseUrl": "http://127.0.0.1:8188",
  "checkpoint": "sd_xl_base_1.0.safetensors",
  "outputDir": "D:/images",
  "steps": 25,
  "timeoutMs": 600000
}
```

For the complete key table, the environment variable mapping, and "what to do when config doesn't take effect", see [docs/CONFIG.md](./docs/CONFIG.md).

## Tool Parameters Cheat Sheet

| Parameter | Type | Description |
|---|---|---|
| `mode` | string | `text2img` / `img2img` / `inpaint` / `remove_background`; if omitted, inferred from the inputs |
| `prompt` | string | Positive prompt (not needed for `remove_background`) |
| `negative_prompt` | string | Negative prompt; if omitted, the plugin default is used |
| `input_image` | string | Input image path (required for `img2img` / `inpaint` / `remove_background`) |
| `mask_image` | string | Mask image path (required for `inpaint`); **white/bright area = the region to repaint** |
| `width` / `height` | integer | Output size, **only effective for `text2img`**; automatically aligned to a multiple of 8 |
| `seed` | integer | Random seed; the same seed + the same prompt reproduces the same image |
| `output_path` | string | Output directory or file path; if omitted, it lands in the current project root |
| `strength` | number | Denoise strength, 0~1; defaults to 0.6 for `img2img` and 1.0 for `inpaint` |
| `steps` | integer | Sampling steps, default 20 |
| `cfg_scale` | number | CFG scale, default 7 |
| `model` | string | Checkpoint file name; if omitted, one is picked automatically (preferring names containing `xl`) |
| `sampler_name` / `scheduler` | string | Sampler / scheduler; if omitted the defaults are used, and a non-existent one produces an explicit error |
| `style_reference` / `character_reference` | string | **Reserved**: V1 only records them into the metadata; they do not affect generation |
| `extra_options` | object | Reserved extension slot; `workflow_path` can take over this generation (see below) |

The output structure (`output.schema`) contains `path` / `files` / `mode` / `seed` / `width` / `height` / `steps` /
`cfg_scale` / `strength` / `model` / `sampler` / `scheduler` / `prompt_id` / `comfy_url` /
`duration_ms` / `success` / `mode_inferred` / `metadata_path` / `notes`, plus the `text` meant for the model.

For each parameter's value range, where its default comes from, and which modes ignore it, see [docs/PARAMS.md](./docs/PARAMS.md).

## Mode Inference and Error Rules

When `mode` is omitted, these three rules decide it (they live in `src/params.ts`; this README just copies them):

1. `input_image` **and** `mask_image` present → `inpaint`
2. Only `input_image` → `img2img`
3. Neither → `text2img`

**A conflict is an error, never a guess**. The common ones:

| Situation | Result |
|---|---|
| `mode=text2img` but `input_image` was passed | Error, with the hint "to edit an image, pass `mode="img2img"` explicitly" |
| `mode=img2img` but `mask_image` was passed | Error, with the hint "a mask means inpainting; please pass `mode="inpaint"`" |
| `mask_image` given but no `input_image` | Error — inpainting needs both the source image and the mask |
| `mode=inpaint` without `mask_image` | Error (V1 requires an explicit mask and does not do automatic matting) |
| `input_image` / `mask_image` path doesn't exist | Error, caught **before the upload** |
| `width` / `height` passed with a non-`text2img` mode | No error, but the result's `notes` says "ignored — the size is determined by the input image" |

## Output and Files

- **Default location**: the current **project root** (that is, the Agent session's working directory); you can also use `output_path` to specify a directory or a file.
- **Naming**: `comfyui-<timestamp>-<4 random chars>.png`; when a file name is specified it **never overwrites** — a name collision gets a `-1` / `-2` suffix.
- **Metadata sidecar**: `<image path>.json`, containing the plugin version, mode, all parameters, the input image, the ComfyUI address and `prompt_id`,
  plus the **complete workflow submitted to ComfyUI** (which you can take straight into ComfyUI to reproduce the result).
- **On the ComfyUI side**: it uses `SaveImage` by default, so the output lands in ComfyUI's `output/dsh-comfyui-image/` subdirectory
  with a file name prefix of `timestamp-seed`; if you'd rather not pollute ComfyUI's output directory, set `saveToComfyUI: false` (which switches to `PreviewImage`).

## Style / Character Consistency (V1 Status)

In V1, consistency does **only "reserve + record"** and does not take part in generation — please use it with that expectation:

- `style_reference` / `character_reference`: accepted, checked for file existence, **written into the metadata**, but they do not affect the generated image;
- `seed` + `prompt` + `model` + `sampler` + `scheduler`: in V1 this set **already** reproduces the same image;
- The metadata sidecar exists precisely to prepare for consistency later: it records the full parameters and workflow of every generation,
  so when you later want IPAdapter / reference images / character LoRA, this data can be used to line things up.

## Extension: Handing Generation Over to a Custom Workflow

Anything V1 doesn't build in (**outpainting, upscaling, batch generation, special nodes**) can be wired in through this escape hatch:

1. Build the workflow in the ComfyUI UI and export it in **API format** (*Save (API Format)* in the menu);
2. Replace the fields that need to vary with placeholders: `{{prompt}}`, `{{negative_prompt}}`, `{{width}}`, `{{height}}`,
   `{{seed}}`, `{{steps}}`, `{{cfg_scale}}`, `{{strength}}`, `{{checkpoint}}`, `{{input_image}}`,
   `{{mask_image}}`, `{{mode}}`;
3. When calling, pass `extra_options.workflow_path` pointing at that JSON:

```json
{
  "mode": "img2img",
  "prompt": "upscale this, keep details",
  "input_image": "D:/pics/in.png",
  "extra_options": { "workflow_path": "D:/workflows/upscale.json" }
}
```

Details: a form like `"{{width}}"` where **the whole value is a single placeholder** preserves the type (a number stays a number),
while one embedded mid-string is concatenated as a string; placeholders that aren't supplied are **left as-is** (which makes a typo easy to spot).
Remember to end the workflow with `SaveImage` / `PreviewImage`, otherwise you'll get "the job finished but produced no images".

## FAQ

| Symptom | Look here first |
|---|---|
| "Can't reach ComfyUI" | Is ComfyUI running? Is the address right? Inside a container, `127.0.0.1` doesn't mean the host machine |
| "No usable checkpoint" | Put a checkpoint into `ComfyUI/models/checkpoints/` and refresh in the UI |
| "No node `ImageRemoveBackground+`" or similar | The background-removal node isn't installed (this only affects `remove_background`); install one pack as prompted, and use `pip install "rembg[cpu]"` |
| "The job finished but produced no images" | The custom workflow doesn't end with `SaveImage` / `PreviewImage` |
| Generation is slow / times out | Raise `timeoutMs`, or lower `steps` / the dimensions; check the ComfyUI console |
| Changing `config.json` seems to have no effect | Is that same key also set in the profile's plugin `config:`? Plugin config takes priority |
| Passing `width` has no effect | Only `text2img` honors `width` / `height`; for other modes the canvas is determined by the input image |

For the complete troubleshooting checklist (including how to read `doctor` output and a table that maps raw error messages), see [docs/FAQ.md](./docs/FAQ.md).

## Architecture and Directory Layout

```
src/
  index.ts            Plugin entry: apply(ctx, config) → tools.register(generate_image)
  tool.ts             Public contract: tool name, description, parameter JSON Schema, output schema (must stay stable)
  runner.ts           Execution engine: normalize → probe capabilities → upload → build workflow → submit → poll → fetch image → write to disk → metadata
  params.ts           Unified parameter layer: mode inference, defaults, conflict errors
  config.ts           Four-layer config merge + validation (no schema library dependency)
  files.ts            Path resolution, output naming, image reading
  result.ts           Result text / output structure
  errors.ts           Error types that carry "what to do next"
  log.ts              Debug logging
  comfy/
    client.ts         ComfyUI HTTP client (/system_stats /object_info /upload/image /prompt /history /view /interrupt)
    nodes.ts          Capability probing: pick the checkpoint, validate samplers, choose the best background-removal option
    workflows.ts      Pure-function workflow building (four modes + custom workflow token substitution)
lib/                  TypeScript build output (**committed on purpose**: it runs without TS installed)
test/                 88 tests + a mock ComfyUI (real PNG encode/decode, real uploads, real polling, real error paths)
scripts/doctor.mjs    Self-check script
docs/                 install / config / usage / params / FAQ / roadmap
```

The design deliberately separates three layers: the **public contract** (`tool.ts`) must stay stable, the **parameter layer** (`params.ts`) must be predictable,
and the **execution layer** (`runner.ts` + `comfy/`) can be changed freely — swapping the backend or adding a mode only touches that last layer.

> Two implementation constraints (learned the hard way; they're written in the code comments): the plugin **must not import any `@deepseek-ai/*` host package**
> (with a link install that inevitably gives `ERR_MODULE_NOT_FOUND`; just get the host service with `ctx.reflect.get('tools')`);
> and the tool's `parameters` must be a **raw JSON Schema** using only the subset DSH supports (things like `minimum` / `format` are rejected outright).

## Development

```bash
npm install
npm run build      # tsc → lib/
npm run typecheck  # check only, no output
npm test           # 88 tests (ships with a mock ComfyUI)
npm run doctor     # health-check against a real ComfyUI
```

- `lib/` is a build artifact **committed to the repository**; if you change `src/`, remember to run `npm run build` and include `lib/` in the commit;
- CI runs type checking + build + tests, and checks whether `lib/` and `src/` are in sync;
- The tests don't need a real ComfyUI installation: `test/mock-comfyui.mjs` genuinely encodes PNGs, genuinely accepts uploads, and genuinely polls for output images.

## Roadmap

Plans beyond V1 (upscaling / outpainting / batching / multiple backends / consistency) are in [docs/ROADMAP.md](./docs/ROADMAP.md).

## License

[MIT](./LICENSE).

## More Documentation

| Document | Contents |
|---|---|
| [docs/INSTALL.en.md](./docs/INSTALL.en.md) | Installation guide: ComfyUI (including Windows / Intel GPUs) + plugin installation + background-removal nodes |
| [docs/CONFIG.md](./docs/CONFIG.md) | Configuration: the four-layer priority, the complete key table, environment variables, examples |
| [docs/USAGE.md](./docs/USAGE.md) | Usage examples: the four modes + reproduction / fine-tuning + custom workflows |
| [docs/PARAMS.md](./docs/PARAMS.md) | Item-by-item documentation of the tool parameters and the output structure |
| [docs/FAQ.md](./docs/FAQ.md) | FAQ and troubleshooting |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Future expansion plans |
| [CHANGELOG.md](./CHANGELOG.md) | Version history |

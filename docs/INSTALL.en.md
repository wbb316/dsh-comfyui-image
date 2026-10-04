[English](./INSTALL.en.md) | [简体中文](./INSTALL.md)

# Installation Guide

Installing this plugin takes two steps: **① get ComfyUI running** → **② install the plugin into DSH**. The second step takes a minute; the first one is the real work.

> Don't feel like reading a long document? Shortest path: install the ComfyUI portable build → double-click to start it → drop a checkpoint into `models/checkpoints/` →
> install `dsh-comfyui-image` in the DSH plugin manager (enter `github:wbb316/dsh-comfyui-image` to install from
> GitHub instead, or `link:<plugin directory>` if you already cloned it) → run `npm run doctor` and see four ✓ — done.

---

## 1. Install and Start ComfyUI

### 1.1 Pick an Installation Method

| Method | Who it suits | Notes |
|---|---|---|
| **Official Windows portable build** | Windows users, least hassle | Download `ComfyUI_windows_portable.7z` from [ComfyUI Releases](https://github.com/comfyanonymous/ComfyUI/releases), extract it (keep the path free of non-ASCII characters/spaces — that saves trouble), double-click `run_nvidia_gpu.bat` |
| **Comfy Desktop** | Want a graphical install / management | The desktop build from the [ComfyUI website](https://www.comfy.org/); it runs right after installing |
| **Install from source** | Want to control the environment yourself / Linux | See the README of the [ComfyUI repository](https://github.com/comfyanonymous/ComfyUI): `git clone` → create a venv → `pip install -r requirements.txt` → `python main.py` |
| **Already have ComfyUI** | You already have it running | Skip this section; just confirm the listening address |

### 1.2 Confirm the Service Is Actually Up

Once it has started, open these two addresses in a browser:

- `http://127.0.0.1:8188/system_stats` → returns some JSON (containing `system` / `devices`)
- `http://127.0.0.1:8188/` → the ComfyUI node interface

You can also do it from the command line:

```powershell
# Windows PowerShell
Invoke-WebRequest http://127.0.0.1:8188/system_stats -UseBasicParsing | Select-Object -Expand StatusCode
```

```bash
# macOS / Linux
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8188/system_stats
```

`200` means it's healthy. **If it isn't 200, don't go any further** — the plugin will definitely not be able to connect.

### 1.3 Add a Checkpoint (Required)

The plugin asks ComfyUI "which checkpoints do you have"; with none at all it cannot generate images.

Put the checkpoint (`.safetensors` / `.ckpt`) into:

```
<ComfyUI>/models/checkpoints/
```

Recommended starter models (pick either one):

- **SDXL family** (defaults to generating at 1024×1024): `sd_xl_base_1.0.safetensors`
- **SD1.5 family** (when the plugin recognizes a name as SD1.5-like it automatically switches to 512×512): `v1-5-pruned-emaonly.safetensors`

Once it's in place, **refresh in the ComfyUI interface** (or restart it) so it rescans the model directory. Confirm from the command line:

```bash
curl -s http://127.0.0.1:8188/object_info/CheckpointLoaderSimple
# the enum values of ckpt_name in the returned JSON are the checkpoint list it currently knows about
```

### 1.4 Extra Notes on GPUs

This set of plugins only handles "talking to ComfyUI" — how fast generation is and whether it runs at all depends entirely on the ComfyUI side:

- **NVIDIA**: install the CUDA build of PyTorch and use `run_nvidia_gpu.bat` (the portable build ships its own environment).
- **AMD**: on Windows you usually go through DirectML, or ROCm on Linux — follow the corresponding section of the ComfyUI README.
- **Intel (Arc discrete / integrated graphics)**: the official ComfyUI mainline doesn't support Intel as smoothly as CUDA,
  the common approach is to go through **IPEX-LLM**'s ComfyUI support (see the ComfyUI section of [ipex-llm](https://github.com/intel/ipex-llm)),
  or fall back to CPU mode (it runs, but a single 1024 image may take several minutes).
- **Pure CPU**: add `--cpu` at startup. No features are missing, it's just slow — when generation is slow, first turn `steps` and the dimensions down.

> The plugin needs no GPU configuration at all: problems such as insufficient VRAM or an incompatible model come back to you as ComfyUI's own error text.

### 1.5 (Optional) Install Background-Removal Nodes

**Only the `remove_background` mode needs these**; the other three modes run on core ComfyUI alone.
The plugin automatically picks the best available option among the four sets below (in order); installing **any one set** is enough:

| Option key | Required nodes | Installation |
|---|---|---|
| `essentials` | `RemBGSession+` → `ImageRemoveBackground+` | `git clone https://github.com/cubiq/ComfyUI_essentials` into `custom_nodes/`, then run `pip install "rembg[cpu]"` with ComfyUI's own Python |
| `bria` | `BRIA_RMBG_ModelLoader_Zho` → `BRIA_RMBG_Zho` | `git clone https://github.com/ZHO-ZHO-ZHO/ComfyUI-BRIA_AI-RMBG` into `custom_nodes/` (weights are downloaded automatically on first use) |
| `layerstyle` | `LayerMask: RemBgUltra` | `git clone https://github.com/chflame163/ComfyUI_LayerStyle` into `custom_nodes/`, and install `rembg` / `onnxruntime` per its README |
| `was` | `Image Rembg (Remove Background)` | `git clone https://github.com/ltdrdata/was-node-suite-comfyui` into `custom_nodes/`, and install its requirements (including `rembg` / `onnxruntime`) |

> **Two pitfalls discovered by testing on a real machine**:
> 1. Since `rembg` 2.0, onnxruntime is **no longer** pulled in automatically. With a plain
>    `pip install rembg`, importing rembg fails outright with "No onnxruntime backend found";
>    use `pip install "rembg[cpu]"` (or `rembg[gpu]`) instead.
> 2. Copy class names **character for character**: the registered key in essentials is
>    `RemBGSession+` (**with the trailing plus**). `RemBGSession` is only its Python class name and
>    does not exist in `/object_info`; get it wrong and the plugin can never select that set.
>
> The first background removal also downloads the u2net weights (about 176MB) into `~/.u2net/`.

After installing, **restart ComfyUI**. If you want the plugin to use only one specific set, set the `rembgNode` config option (the value can be an option key from the table above,
such as `essentials` / `bria` / `layerstyle` / `was`, or you can write the node class name directly).

With `npm run doctor` you can see which set was finally selected:

```
✓ 去背方案：ComfyUI_essentials（RemBGSession+ → ImageRemoveBackground+）（节点 RemBGSession+ → ImageRemoveBackground+）
```

> The line above is the verbatim output. `doctor` itself prints in Chinese; only this guide is translated.

> **What about core ComfyUI?** Since 0.3x, core ships `LoadBackgroundRemovalModel` + `RemoveBackground`
> (image → MASK; you must supply your own model under `models/background_removal/`). Its output is a mask
> rather than "one image in, one image out", which does not fit the plugin's current background-removal
> path, so it is **not wired up yet** (see [ROADMAP.md](./ROADMAP.md)).

---

## 2. Install the Plugin into DSH

> Three ways to install it, easiest first: **Option A installs from npm** (published, least work);
> **Option B is the plugin manager** (you can enter `github:wbb316/dsh-comfyui-image` and skip cloning);
> **Option C is the manual profile edit**.

### 2.1 Option A: Install from npm (Recommended)

```bash
dsh plugin --profile <your profile> add dsh-comfyui-image
```

Equivalent: `npm i dsh-comfyui-image`, or entering `dsh-comfyui-image` as the install target in
DSH → **Settings → Plugins**. The published `lib/` is already compiled — **no build step**. Restart DSH afterwards.

### 2.2 Option B: the DSH Plugin Manager (Cloning Optional)

> The target can also be `github:wbb316/dsh-comfyui-image`: the manager fetches it from GitHub, so you do **not**
> need to clone it locally. The equivalent command line is
> `dsh plugin --profile <your profile> add github:wbb316/dsh-comfyui-image` (measured: 21.6 s).

Get the plugin code first (skip this when you enter the `github:` target):

- Clone from the repository: `git clone <this repository's URL> D:/dsh/plugins/dsh-comfyui-image`
- Or just use the local directory you already have (for example `D:/dsh/plugins/dsh-comfyui-image` on this machine)

You do **not** need to run `npm install` / `npm run build` — the repository already ships a compiled `lib/`.
You only need to when you're changing the source (see the [Development section of the README](../README.en.md#development)).

1. Open DSH → **Settings → Plugins** (the plugin manager);
2. Choose **Install** and enter a local path as the target, prefixed with `link:`:

   ```
   link:D:/dsh/plugins/dsh-comfyui-image
   ```

3. The manager edits the current profile's `package.json` itself: it adds a `dsh-comfyui-image: link:...` dependency,
   and appends `dsh-comfyui-image` to `dsh.profile.bundles`; on failure it rolls back automatically.
4. After installing, restart DSH (or reload when the interface prompts you to).

### 2.3 Option C: Edit the Profile Manually

Edit `~/.dsh/profiles/<your profile>/package.json`:

```jsonc
{
  "dependencies": {
    // ……
    "dsh-comfyui-image": "link:D:/dsh/plugins/dsh-comfyui-image"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …… (keep the existing entries)
        "dsh-comfyui-image"
      ]
    }
  }
}
```

Then install the dependencies once inside the profile directory:

```bash
cd ~/.dsh/profiles/<your profile>
pnpm install        # or use "Install/Update plugin" in the DSH interface
```

Restart DSH. (Before changing the profile's `package.json`, back it up first — other plugins hang off that file too.)

### 2.4 Option C: No DSH Install, Verify on Its Own First

The plugin itself **imports no host packages**, so you can run it directly under Node, with no DSH in place:

```bash
cd <plugin directory>
npm run doctor    # run a health check straight against ComfyUI, without going through DSH

# to try the config resolution and tool definition by hand:
node -e "import('./lib/index.js').then(m => {
  const cfg = m.resolveConfig()
  console.log('ComfyUI address: ', cfg.baseUrl, '| default checkpoint: ', cfg.checkpoint ?? '(auto-pick)')
  console.log('tool name: ', m.TOOL_NAME, '| parameters: ', Object.keys(m.PARAMETERS_SCHEMA.properties).join(', '))
  console.log('built or not: ', typeof m.runGeneration === 'function')
})"
```

So **before installing the plugin** you can already confirm that "everything is normal on the ComfyUI side" — `doctor` and the real execution path call the same set of probe functions,
so you won't get "the self-check says it can run, but a real run can't find a checkpoint".

### 2.5 What the Plugin Looks Like in the Profile Config Tree

This package ships its own `cordis.patch.yml`; installing the bundle automatically inserts an entry into the config tree:

```yaml
- insert:
    - id: dsh-comfyui-image
      name: dsh-comfyui-image
```

If you want to write config for the plugin right there (it has the highest priority; see [CONFIG.md](./CONFIG.md)), override it by id in **the profile's**
`cordis.patch.yml`:

```yaml
- id: dsh-comfyui-image
  name: dsh-comfyui-image
  config:
    baseUrl: 'http://127.0.0.1:8188'
    checkpoint: 'sd_xl_base_1.0.safetensors'
```

To disable the plugin temporarily: add `disabled: true`, or use the toggle in the plugin manager.

---

## 3. How to Confirm the Install Succeeded

Do these four things in order; each one can be judged on its own:

| # | Check | What you expect to see |
|---|---|---|
| 1 | `npm run doctor` (in the plugin directory) | prints the effective config + the ComfyUI version + the availability of the four modes; exit code `0` |
| 2 | DSH Settings → plugin list | `dsh-comfyui-image` is visible (display name "ComfyUI 图片生成"), and the toggle works |
| 3 | Tell the Agent "use generate_image to generate a test image" | the model can see and call this tool, returning `✅ 出图成功` + a line with an absolute path |
| 4 | Click/open the returned path | the image exists, and next to it there is a same-named `.json` metadata file |

If any step goes wrong, check [FAQ.md](./FAQ.md) first; if that doesn't help, file an issue with the output of `npm run doctor --json`.

---

## 4. Uninstalling

1. **Remove** the bundle in the plugin manager (or manually delete the dependency and the `bundles` entry from the profile's `package.json`), then restart DSH;
2. Optional cleanup: delete the config file directory `~/.dsh-comfyui-image/`;
3. The plugin **does not** install anything into ComfyUI, and does not touch the ComfyUI config either;
   the intermediate files it produces all live in ComfyUI's `output/dsh-comfyui-image/` subdirectory — delete that directory if you want to clean them up.

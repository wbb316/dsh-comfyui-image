/**
 * 必须第一个被 import 的模块。
 *
 * 原因：`lib/config.js` 在**模块加载时**就把 `CONFIG_FILE` 定下来了
 * （`process.env.DSH_COMFYUI_IMAGE_CONFIG || ~/.dsh-comfyui-image/config.json`）。
 * 如果在 import 之后再设环境变量，插件读写的仍然是用户真实的配置文件——
 * 测试就会去动用户的真数据。所以这里在**任何** lib 的 import 之前把它指到临时目录。
 *
 * 本文件不 import 任何 lib 代码，这是它有意义的前提。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cii-cfg-'))

/** 本次测试进程使用的插件配置文件路径。 */
export const CONFIG_PATH = path.join(dir, 'config.json')

process.env.DSH_COMFYUI_IMAGE_CONFIG = CONFIG_PATH

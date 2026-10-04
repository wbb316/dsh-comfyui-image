# 发版流程（自动建 Release + 自动发 npm）

本仓库有两条发版流水线，**都由 tag 驱动**，不需要在本地跑发布命令：

| 工作流 | 触发条件 | 做什么 |
|---|---|---|
| [release.yml](../.github/workflows/release.yml) | 推 `v*.*.*` tag | 建 GitHub Release，变更说明由 GitHub 按提交自动生成 |
| [publish.yml](../.github/workflows/publish.yml) | Release 被发布 | `npm test` → `npm publish --provenance --access public` |

顺序是自动串起来的：推 tag → Release 建立 → Release 发布事件 → npm 发布。

---

## 一次性配置：加 NPM_TOKEN

npm 发布需要凭据，而凭据**不放在代码里**，只放在 GitHub 的仓库 secret 里——它不会被写进日志，也不会出现在 PR 中，任何人（包括帮你配环境的 AI）都不需要看到它的明文。

1. 打开 <https://www.npmjs.com/settings/~/tokens>，点绿色的 **Generate New Token**。
   新版界面**直接进入 `New Granular Access Token` 表单**，没有「Classic Token」入口了（旧文档里说的
   「Classic → Automation」在现在的 npm 上找不到，别去找）。按这样填：

   | 表单项 | 填什么 | 为什么 |
   |---|---|---|
   | Token name | 随便取，例如 `dsh-comfyui-image-ci` | 以后轮换时好认 |
   | Expiration | **90 days**（界面给的最长值，没有"永不过期"） | 到期后 CI 发布会失败，见下方「轮换」 |
   | **Bypass two-factor authentication (2FA)** | **勾上** | 不勾的话发布会要求手机验证码，无人值守的流水线会卡死 |
   | Packages and scopes → Permissions | **Read and write (publish and stage)** | 选成 `stage only` **发不出去**（只能传暂存区），这是最容易选错的一项 |
   | Organizations | **No access** | 个人包用不到组织权限 |
   | Allowed IP ranges | **留空** | GitHub Actions 的出口 IP 每次都不一样，填了必然失败 |

2. 保存后**立刻复制** token（`npm_` 开头，只显示这一次，关掉页面就再也看不到）。
3. 打开 <https://github.com/wbb316/dsh-comfyui-image/settings/secrets/actions>，点 **New repository secret**：
   - Name 填 `NPM_TOKEN`（必须一字不差，工作流就是按这个名字取的）；
   - Secret 粘贴刚复制的 token，保存。

配好之后不需要改任何代码。

> **轮换**：Granular token 最长 90 天，到期后 `publish.yml` 会在发布那一步失败（报 401 / 权限错误）。
> 到时候回 token 页面删掉旧的、照上表重新生成一个，更新 `NPM_TOKEN` 即可——**不用改代码，也不用改版本号**。
> token 也**不要**贴进聊天、issue 或提交里：它等同密码；一旦怀疑泄露，立刻在 npm 页面吊销并重新生成。

> **没配会怎样？** `publish.yml` 里的 guard 会检测到 `NPM_TOKEN` 为空，**跳过** npm 发布并在运行摘要里留一条 notice——
> 工作流仍然是绿的。这样 fork 出去的人推 tag 不会因为缺少 secret 而红一片。

## 发一个新版本

```bash
# 1. 改版本号（三处保持一致：package.json / CHANGELOG.md / tag 名）
#    package.json 的 "version"

# 2. 提交
git add -A
git commit -m "chore: 发布 v0.2.0"

# 3. 打 tag 并推送（tag 名必须是 v 开头 + 与 package.json 版本一致）
git tag -a v0.2.0 -m "v0.2.0"
git push origin main
git push origin v0.2.0
```

推完 tag 之后：

- **Release** 工作流建好 https://github.com/wbb316/dsh-comfyui-image/releases ；
- **Publish to npm** 工作流接着跑，成功后 https://www.npmjs.com/package/dsh-comfyui-image 会出现新版本。

`publish.yml` 会先校验 **tag 名与 `package.json` 的 version 是否一致**——
不一致直接失败并说明原因（`tag 是 v0.2.0，但 package.json 的 version 是 0.1.0，拒绝发布`），
避免把错的版本号发出去（npm 上同一个版本号**不能覆盖重发**，这个防呆很值）。

## 手动重发 / 补发

- **补发某个历史 tag 的 Release**：Actions → Release → Run workflow，填 tag 名（例如 `v0.1.0`）。已存在的 Release 会被跳过而不是报错。
- **手动重发 npm**：Actions → Publish to npm → Run workflow。注意 npm 不允许重发同一个版本号，得先升版本。
- **本地手动发布**（不走 CI，备选）：

  ```bash
  npm login --registry=https://registry.npmjs.org
  npm test
  npm publish --access public
  ```

  本机若配了国内镜像源（`npm config get registry`），发布前务必显式指定官方源，否则会推到镜像上（镜像只读，会失败或报权限错误）。

## provenance（可验证的来源签名）

`npm publish --provenance` 会用 GitHub Actions 的 OIDC 身份给包签名：npm 页面上会出现 **Built and signed on GitHub Actions** 标记，任何人都能核验「这个包确实由本仓库的这次构建产出」。这也是 `publish.yml` 里 `id-token: write` 权限的用途。

前提：仓库是**公开**的，且 `package.json` 里有 `repository` 字段——本仓库两者都满足。

## 发布内容包含什么

由 `package.json` 的 `files` 字段决定（不是 `.npmignore`）：`lib/`（编译产物，**故意提交**，用户不装 TypeScript 也能直接跑）、`src/`、`scripts/`、`docs/`、`tsconfig.json`、`cordis.patch.yml`、`icon.svg`、两个 README、`CHANGELOG.md`、`LICENSE`。

发布前想先看清单，用：

```bash
npm pack --dry-run
```

## 相关文档

- [INSTALL.md](./INSTALL.md) —— 从 npm / 本地目录两种方式的安装步骤
- [README 的开发一节](../README.md#开发) —— 本地构建与测试

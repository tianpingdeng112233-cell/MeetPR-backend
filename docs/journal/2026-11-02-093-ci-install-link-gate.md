# 093 CN install links CI gate — 2026-11-02

## 目标与范围

依据本会话明确任务卡，防止 plan-web bundle 遗漏 CN 安装链接后进入 staging 镜像。实现仅修改 `.github/workflows/build-push-staging.yml`，在原 same-origin 步骤后新增指定 gate；本文件记录开发证据。未修改 `web/`，未 commit、push、合并或部署。

基准 HEAD 与本地 `origin/staging` 均为 `73007219a389522b02756b5401d397152735cc27`，工作分支 `claude/ci-install-link-gate-376a96`，开工工作区干净。已有明确卡片与验收清单，本次不创建新 spec 或 ship-web 文档。

## Harness 与运行证据

Harness 保留在指定 scratchpad，不进入仓库。Ruby YAML 解析当前 workflow 的 `jobs.verify.steps`，按完整名称提取 `run:`，然后通过 `git archive <ref> web | tar -x -C <tmpdir>` 导出真实 bundle，在临时目录执行 `bash -e -c <run body>`。每次输出原始 stdout/stderr，最后一行 `EXIT CODE` 记录实际退出码，harness 自身以同一码退出。合成用例仅修改临时副本；移除 URL 使用 sed。

```sh
HARNESS=/private/tmp/claude-501/-Users-david-Projects-apps-MeetPR-backend--claude-worktrees-ci-install-link-gate-376a96/d689f515-cf92-479c-b279-7ab19a98def2/scratchpad/verify-bundle.rb
```

以下命令均从仓根运行。01 在修改 workflow 前执行，02–09 在修改后执行；输出逐字记录如下。

### 修改前：步骤不存在（red）

```sh
ruby "$HARNESS" .github/workflows/build-push-staging.yml 'Verify bundled plan-web carries CN install links' 9bf71b1
```

```text
HARNESS ERROR: step not found: Verify bundled plan-web carries CN install links
EXIT CODE: 2
```

### 修改后：历史包缺少两条链接

```sh
ruby "$HARNESS" .github/workflows/build-push-staging.yml 'Verify bundled plan-web carries CN install links' 9bf71b1
```

```text
::error::web/assets/index-C0tMUIgh.js is missing VITE_CN_TESTFLIGHT_URL — rebuild plan-web with CN install links.
::error::web/assets/index-C0tMUIgh.js is missing VITE_CN_ANDROID_URL — rebuild plan-web with CN install links.
VITE_API_BASE='' VITE_CN_TESTFLIGHT_URL=https://testflight.apple.com/join/aKmSgx4b VITE_CN_ANDROID_URL=https://dl.meetpr.cn/android/meetpr-cn.apk npm run build
EXIT CODE: 1
```

### 修改后：两条链接均存在

```sh
ruby "$HARNESS" .github/workflows/build-push-staging.yml 'Verify bundled plan-web carries CN install links' origin/staging
```

```text
OK: web/assets/index-DuCVovjx.js carries CN install links
EXIT CODE: 0
```

### 修改后：只移除 Android URL

```sh
ruby "$HARNESS" .github/workflows/build-push-staging.yml 'Verify bundled plan-web carries CN install links' origin/staging remove-android
```

```text
::error::web/assets/index-DuCVovjx.js is missing VITE_CN_ANDROID_URL — rebuild plan-web with CN install links.
VITE_API_BASE='' VITE_CN_TESTFLIGHT_URL=https://testflight.apple.com/join/aKmSgx4b VITE_CN_ANDROID_URL=https://dl.meetpr.cn/android/meetpr-cn.apk npm run build
EXIT CODE: 1
```

### 原 same-origin 步骤回归

```sh
ruby "$HARNESS" .github/workflows/build-push-staging.yml 'Verify bundled plan-web uses same-origin API base' origin/staging
```

```text
OK: web/assets/index-DuCVovjx.js carries same-origin base ''
EXIT CODE: 0
```

### 补充：只移除 TestFlight URL

```sh
ruby "$HARNESS" .github/workflows/build-push-staging.yml 'Verify bundled plan-web carries CN install links' origin/staging remove-testflight
```

```text
::error::web/assets/index-DuCVovjx.js is missing VITE_CN_TESTFLIGHT_URL — rebuild plan-web with CN install links.
VITE_API_BASE='' VITE_CN_TESTFLIGHT_URL=https://testflight.apple.com/join/aKmSgx4b VITE_CN_ANDROID_URL=https://dl.meetpr.cn/android/meetpr-cn.apk npm run build
EXIT CODE: 1
```

### 补充：无 web/index.html

```sh
ruby "$HARNESS" .github/workflows/build-push-staging.yml 'Verify bundled plan-web carries CN install links' origin/staging no-index
```

```text
web/ absent — nothing to verify
EXIT CODE: 0
```

### 补充：index 未引用入口

```sh
ruby "$HARNESS" .github/workflows/build-push-staging.yml 'Verify bundled plan-web carries CN install links' origin/staging no-entry
```

```text
::error::web/index.html references no existing entry bundle
VITE_API_BASE='' VITE_CN_TESTFLIGHT_URL=https://testflight.apple.com/join/aKmSgx4b VITE_CN_ANDROID_URL=https://dl.meetpr.cn/android/meetpr-cn.apk npm run build
EXIT CODE: 1
```

### 补充：入口文件不存在

```sh
ruby "$HARNESS" .github/workflows/build-push-staging.yml 'Verify bundled plan-web carries CN install links' origin/staging missing-entry
```

```text
::error::web/index.html references no existing entry bundle
VITE_API_BASE='' VITE_CN_TESTFLIGHT_URL=https://testflight.apple.com/join/aKmSgx4b VITE_CN_ANDROID_URL=https://dl.meetpr.cn/android/meetpr-cn.apk npm run build
EXIT CODE: 1
```

## 检查与审查

- Harness 断言全部通过：退出码符合预期；双缺失输出两条变量错误；单缺失仅输出对应变量错误；所有失败均独立输出完整重建命令，保留 `VITE_API_BASE=''` 的字面单引号。
- 对比 HEAD，原 same-origin 步骤逐字节一致；`git diff HEAD -- web/` 为空。`git diff --check` 通过。
- `actionlint` 未安装，按卡跳过。
- `pnpm install --frozen-lockfile` 退出 1：registry 下载遭网络限制 `connect EPERM 127.0.0.1:18083`。常规基线 `pnpm typecheck && pnpm lint && pnpm test` 退出 1（`tsc: command not found`），后续 lint/test 未运行；不声称完整仓库测试通过。
- 格式检查借用主 checkout 已有的 Prettier 可执行文件，未改依赖或锁文件：`PATH="/Users/david/Projects/apps/MeetPR-backend/node_modules/.bin:$PATH" pnpm format:check`。全仓及两份修改文件的定向检查均退出 0，输出 `All matched files use Prettier code style!`。
- 独立只读 code-review：Standards 0 项；Spec 0 项。规格来源为本会话任务卡。仓库缺少 `docs/agents/issue-tracker.md`，未使用依赖 tracker 的流程，也未私建配置。

本记录仅陈述开发自测与自审证据，最终收货由任务发起方按卡完成。

## 收货复跑（Opus，自包含命令）

scratch harness 会被清掉，以下命令只依赖仓库与 ruby，在仓根可直接复跑：

```sh
D=$(mktemp -d); ruby -ryaml -e 'w=YAML.load_file(ARGV[0]); File.write(ARGV[2], w["jobs"]["verify"]["steps"].find{|x| x["name"]==ARGV[1]}["run"])' .github/workflows/build-push-staging.yml "Verify bundled plan-web carries CN install links" "$D/step.sh"
for r in 9bf71b1 origin/staging; do mkdir -p "$D/$r"; git archive "$r" web | tar -x -C "$D/$r"; (cd "$D/$r" && bash -e "$D/step.sh"); echo "exit=$?"; done
```

收货结果：`9bf71b1` → 两条 `::error::`（VITE_CN_TESTFLIGHT_URL、VITE_CN_ANDROID_URL）+ 完整构建命令，exit=1；`origin/staging`（7300721）→ `OK: web/assets/index-DuCVovjx.js carries CN install links`，exit=0。diff 对原 workflow 零删除行，same-origin 步骤未改。

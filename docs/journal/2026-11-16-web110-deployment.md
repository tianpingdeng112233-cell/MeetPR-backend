# Web 110 计划接续适配部署

## 授权与来源

David 2026-11-16：「我给你所有的权限……网页端合并部署完」。plan-web [#181](https://github.com/tianpingdeng112233-cell/meetpr-plan-web/pull/181) 已合并，来源 `1088cce1d646f7d25de17b99ebaca58a4f9c4e17`（含 #180 跨周期拖动复制）。行为、1647 项测试与浏览器验收见来源仓 `docs/journal/2026-11-16-110-web.md`。

## 换装

仅替换生成的 `web/` 静态资源，无后端代码、迁移、env 修改，沿用已应用的 0087。回滚可重部署上一镜像（web 180 换装，`246c505`）。

构建：`VITE_API_BASE='' VITE_CN_TESTFLIGHT_URL=https://testflight.apple.com/join/aKmSgx4b VITE_CN_ANDROID_URL=https://dl.meetpr.cn/android/meetpr-cn.apk npm run build`。新入口内 TestFlight 与安卓安装链接各 1 次，无开发用 `/api` 前缀。

- JS：`assets/index-DAYvx1ov.js`，SHA-256 `ebe9708b9fe572dbd02dd6c60e36675e95407ef40f1dd2eb64ddf510b20b6196`
- CSS：`assets/index-Cmpmwkks.css`（未变）

## 验证

CI、镜像构建、部署与线上入口核对结果见 `db/MIGRATIONS-APPLIED.md` 对应条目与后续追加。

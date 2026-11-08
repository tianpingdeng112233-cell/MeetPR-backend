# 返修卡 · 语言头改为 X-MeetPR-Locale（四仓通用，Opus 收货发现）

读同目录 SPEC.md「共享契约」v2 修订两条。原因：老客户端（已发布 iOS、浏览器）自动发 `Accept-Language`，以它为准会让老客户端在繁体系统上拿到不支持的繁体数据。

- **客户端（网页/iOS/安卓）**：把显式设置的 `Accept-Language: <locale>` 一律改为 `X-MeetPR-Locale: <locale>`（值 `zh-Hans|zh-Hant|en`）；不要再手动覆盖 `Accept-Language`（恢复平台默认）。覆盖面不变：API、未登录 auth、WebSocket、更新检查、analytics。相关测试断言同步改。
- **后端**：
  1. 只读 `X-MeetPR-Locale`（大小写不敏感，值需在三值内，否则忽略）；删除基于 `Accept-Language` 的判定；`req.locale` 与邮件语言都来自它，无头时行为与现网逐字一致（加一条测试：带 `Accept-Language: zh-TW` 但无自定义头的请求 → 出参简体、不写 preferred_locale）。
  2. 中间件：先 `next()`，再后台执行**单条**条件更新 `UPDATE users SET preferred_locale=$1 WHERE id=$2 AND preferred_locale IS DISTINCT FROM $1`（不先 SELECT）；失败只 `logger.warn`，绝不传给 `next(err)`、不影响响应。测试：DB 更新抛错时请求仍 200。
  3. CORS：若有 `allowedHeaders` 白名单（Global 网页跨域），加入 `X-MeetPR-Locale`，加测试。
- 先红后绿；定向测试 + lint/typecheck 绿；不 commit；JOURNAL 追加「语言头返修」小节。

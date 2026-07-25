# 027 — 学员连续训练次数

Status: InProgress

为当前登录的学员提供一个纯查询端点，返回截至指定 gym-day 仍然有效的连续训练次数，以及当前链的起止训练日。

## API 契约

| 项          | 值                                                                               |
| ----------- | -------------------------------------------------------------------------------- |
| 方法 / 路径 | `GET /students/me/streak`                                                        |
| 鉴权        | 全局 `requireAuth` + `requireRole('coached_student', 'self_train_student')`      |
| 主体        | 当前登录学员本人；没有 `:id` 变体，教练和 admin 返回 403                         |
| Query       | 可选 `as_of`（真实的 `YYYY-MM-DD` 日历日期）；schema 为 strict，未知参数返回 400 |

200 响应：

```json
{
  "streak": {
    "current": 12,
    "as_of": "2026-07-25",
    "started_on": "2026-06-30",
    "last_session_date": "2026-07-25"
  }
}
```

| 字段                       | 类型                               | 语义                                                      |
| -------------------------- | ---------------------------------- | --------------------------------------------------------- |
| `streak`                   | object，永不为 `null`              | 顶层具名包装                                              |
| `streak.current`           | integer ≥ 0                        | 连续训练次数；0 表示没有仍在进行的链                      |
| `streak.as_of`             | string `YYYY-MM-DD`，永不为 `null` | 本次计算的基准 gym-day                                    |
| `streak.started_on`        | string `YYYY-MM-DD` \| `null`      | 当前链第一次训练的 gym-day；`current === 0` 时为 `null`   |
| `streak.last_session_date` | string `YYYY-MM-DD` \| `null`      | 当前链最近一次训练的 gym-day；`current === 0` 时为 `null` |

错误响应：

| 状态 | body                                               | 触发条件                                          |
| ---- | -------------------------------------------------- | ------------------------------------------------- |
| 401  | `{ "error": "AUTH_INVALID_TOKEN" }`                | token 缺失或无效                                  |
| 403  | `{ "error": "AUTHORIZATION_FORBIDDEN" }`           | 角色不是 `coached_student` / `self_train_student` |
| 400  | `{ "error": "VALIDATION_ERROR", "issues": [...] }` | `as_of` 不是实际日历日期，或存在未知 query 参数   |

## 规则与边界

| 情形                              | 结果                                                          |
| --------------------------------- | ------------------------------------------------------------- |
| 从未训练，或 `as_of` 早于最早训练 | `current: 0`，两个日期字段为 `null`                           |
| 休息日夹在两次训练之间            | 休息日隐形，不计数也不断链                                    |
| 漏掉一个应练日                    | 立即断链；不使用告警的连续缺练阈值                            |
| 顺延计划日                        | 只使用 `effectivePlanDays` 折算后的应练日，原日期不再导致断链 |
| 临时训练或任意 session status     | `training_sessions` 行存在即计为一次训练                      |
| 未完成评估期                      | 跳过应练日漏练判断，但仍应用最大间隔兜底                      |
| 两次训练相隔超过 14 天            | 无论有无计划都断链；恰好 14 天不断                            |
| `as_of` 当天应练但尚未练          | 当天尚未结算，不算漏练                                        |
| 严格晚于 `as_of` 的训练或应练日   | 不参与计算                                                    |

学员自己的 streak 合并其全部 published 计划的有效应练日，不按教练或计划分账。当前链从最近训练日向前回溯：
每经过一次训练计数加一；中间出现任何未训练的有效应练日，或相邻训练超过 14 天，就在该处停止。最后一次
训练距 `as_of` 超过 14 天，或其后且严格早于 `as_of` 已漏应练日时，当前链直接归零。

## 时区口径

默认 `as_of` 一律使用 `src/utils/date.ts` 的 `shanghaiTrainingDay()`，即 Asia/Shanghai 且凌晨 4 点为
gym-day cutoff，与 `training_sessions.session_date` 的落库口径一致。所有数据库 DATE 值先通过
`normalizeDateOnly()`，纯日历差值使用 `utcDate()` / `utcDateOnly()`；不得用 UTC 日期切片另造
gym-day 口径。

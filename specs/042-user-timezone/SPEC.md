# 042 — 全用户时区化(gym-day / 结算 / 推送全按用户所在时区)

- **Status: InProgress**(2026-08-15 起草,⚖️同日 David 拍板方案 A 并终审通过,按现稿开工)
- **级别**: T3(一条 additive 迁移 + cron 调度重构 + ~10 文件口径改造 + 约 8 组测试基线重写)
- **侦察依据**: `~/Projects/scratch/meetpr-uk-timezone-recon-2026-08-15.md`(全量日期边界清单,行号锚 staging@41a04e5)

## 背景

服务端所有「今天」目前锚定上海:gym-day 用上海 04:00 翻天,每日结算 cron 跑在上海 04:05,教练摘要
推送跑在上海 08:00。用户全在国内时这套完全正确;海外用户一上来就全错——伦敦用户晚上八九点之后的
每场训练会整场记到「明天」,而且结算正好在他举铁途中跑,当场判他缺练。侦察确认 iOS 打卡请求根本
不送日期(全靠服务端兜底),所以**这是纯服务端问题,也能纯服务端根治,零客户端配合即可生效**。

⚖️拍板:不做「只修英国主线」的最小刀,直接按方案 A 做全时区——任何 IANA 时区的用户,gym-day、
结算、推送、统计口径全部以他所在时区为准。

## 核心设计

### 1. 时区从哪来:`users.timezone` 列(迁移 0066,取号实装前照例三源现场核实)

```sql
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai';
```

- 纯增量,**零回填零改写**:存量用户默认上海 = 语义与今天逐字节一致(交付红线的存量照护即由默认值
  完成,无需任何数据操作)。
- 合法性校验在应用层:`Intl.supportedValuesOf('timeZone')`(Node 22 内建)做白名单,启动时缓存成
  Set;非法值一律 400 `INVALID_TIMEZONE`。DB 不加 CHECK(IANA 表会随 tzdata 演进)。

**写路径(时区怎么被设置)**:

- 三通道注册(`/auth/email/register`、`/auth/apple`、`/auth/google` 首登建号)请求体新增**可选**
  `timezone`;缺省 `'Asia/Shanghai'`(与存量一致,W1 的 `.strict()` schema 放行该新键)。
- 国内 `/auth/register` 同样放行可选 `timezone`(国内老包不送,不受影响)。
- 新端点 `PATCH /me/timezone`(body `{ timezone }`,任何角色)——客户端约定:app 启动/登录时若
  检测到设备时区 ≠ 账上时区就调一次(iOS 卡在 W4 一并做,见 §客户端契约)。
- 用户改时区即改未来口径,历史 `logged_date`/`session_date` 不迁移(旅行/搬家场景接受
  gym-day 边界一次性错动,写 audit log 一行,不做补偿逻辑——过度设计)。

### 2. 口径函数:`trainingDay(now, timezone)`

`src/utils/date.ts` 的 `shanghaiTrainingDay(now)` 泛化为 `trainingDay(now, tz)`:实例回拨
4 小时后取 `toLocaleDateString('en-CA', { timeZone: tz })`。**04:00 截断规则全球统一**(gym-day
的产品语义不变,只换锚定时区)。`shanghaiTrainingDay` 保留为 `trainingDay(now, 'Asia/Shanghai')`
的别名并标 deprecated,防止仍有漏网调用点在重构窗口期炸掉;全部改造完后删。

**必须成立的等价性(测试钉死)**:`trainingDay(x, 'Asia/Shanghai') ≡ 旧 shanghaiTrainingDay(x)`
对侦察报告里的全部既有边界用例(03:59/04:00/跨月/跨年)逐一成立——这是「存量用户零变化」的证明。

### 3. 改造点(全部换成请求者/所属学员的时区;行号见侦察报告)

| 组                    | 位置                                            | 换成谁的时区                                                                                                            |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 打卡兜底              | `sets.ts:150`                                   | 学员本人                                                                                                                |
| 连胜 as_of            | `training-streak.ts:44`                         | 学员本人                                                                                                                |
| 会话/事件流缺省日     | `signals.ts:334` / `:107`                       | 被查学员                                                                                                                |
| 账本开行与比较        | `activity-ledger.ts:114/155/274`                | 学员本人                                                                                                                |
| 结算撤销窗口          | `plan-day-completions.ts:126`                   | 学员本人                                                                                                                |
| e1RM 滚动窗口         | `exercise-stats.ts:495-499`                     | 学员本人                                                                                                                |
| 顺延三处 UTC today    | `plans/index.ts:443/496/561`                    | 请求者本地 today(注:spec 035 已拍板下线顺延端点,若 035 W2 先落地则前两处自然消失,实装时以当时代码为准,不为将死代码加卡) |
| scope=plan 查询窗     | `sets-fetch.ts:84-85`                           | 学员本人(与 scope=all 的设备本地口径就此收敛)                                                                           |
| 周聚合起点            | `exercise-stats.ts:195-199`                     | 学员本人                                                                                                                |
| 缺练判定              | `missed-training.ts` / `activity-settlement.ts` | 学员本人(见 §4)                                                                                                         |
| digest 目标日与数据窗 | `daily-digest.ts`                               | **教练**本人(收件人视角)                                                                                                |

每个 handler 的用户时区随现有的用户行查询捎带(users 表 PK 查已在多数路径上,新增列不加查询;
个别只拿 id 的路径补一次 PK select,禁止 N+1——列表路径一次性 join 取出)。

### 4. 调度重构:从「每天一发」到「每小时扫桶」

现状:结算 cron `5 4 * * *`(沪)一次结全体;digest `0 8 * * *`(沪)一次推全体。全时区化后
「每个用户的 04:05 / 08:00」在 UTC 上是连续分布的,改为:

- **runner 每小时跑一次**(`5 * * * *`,UTC,无时区参数)。每轮:
  1. `SELECT DISTINCT timezone FROM users`(实际基数=有用户的时区数,个位数起步);
  2. 对每个时区算 `justClosedGymDay(now, tz)`;
  3. 结算该时区中「此 gym-day 尚未结算」的学员;digest 同理对「本地时间已过 08:00 且此 gym-day
     尚未推送」的教练。
- **幂等靠账本不靠时刻**:结算与 digest 的「已做过」判定都以 `(user, gymDay)` 为键——结算沿用
  signals/absence_epoch 的既有去重语义,digest 沿用 `notification_outbox` 唯一约束
  (`daily-digest.ts:62-66` 的 aggregate_id 本就含 gymDay,天然 per-user 化,**无需改键结构**)。
  错过的轮次(部署窗口、cron 停摆)下一轮自动补,与今天的 noOverlap 语义一致。
- 半点/刻钟时区(印度 +5:30、尼泊尔 +5:45)在整点 runner 下最多延迟 55 分钟触达,记入已知
  容差,不为此加密扫描频率。
- DST 换季由 IANA tz 数据天然处理;换季日 gym-day 可能 23/25 小时,接受(与手机闹钟同语义)。
- `scheduler.ts:99-102`「digest 假设结算已完成」的顺序假设改为**同轮先结算后 digest**,
  显式串行,不再靠 4 小时间隔。

### 5. 客户端契约(本 spec 只定契约,不含实装)

- iOS W4(Global 登录 UI 卡)注册/登录时送 `timezone: TimeZone.current.identifier`;启动时
  不一致则 `PATCH /me/timezone`。国内线 iOS 后续班车同样接入(老包不送=默认上海,永远安全)。
- ⚠️**美区还差一颗 iOS 侧独立地雷**(本 spec 不覆盖,单独开卡):`TodayWorkoutViewModel` 用设备
  本地日历匹配 UTC 午夜锚定的计划日,UTC 以西时区白天会把「今天」匹配到明天——07-12 侦察已标,
  排美区前必修,挂进海外状态板。

## 不在范围

- 顺延端点本体的修与删(归 spec 035 W2);
- 历史数据按新时区重算(存量默认上海=语义不变,无历史可迁);
- 客户端实装(iOS W4 卡 + 美区 TodayWorkoutViewModel 卡);
- 按地理 IP 猜时区(只信客户端申报)。

## 验收

1. **存量零变化(交付红线)**:`trainingDay(·,'Asia/Shanghai')` 与旧函数在全部既有边界用例上
   逐一相等;全量既有测试在「所有用户默认上海」前提下语义不变(基线测试逐条重写为参数化,
   不是删除——侦察报告列了 8 组钉死沪口径的测试,均须迁移)。
2. **伦敦学员主场景**:tz=Europe/London 的学员 20:30(GMT)/21:30(BST)打卡,`logged_date`=当天;
   其账本 session、连胜、缺练判定全部按伦敦 gym-day;结算发生在伦敦 04:05 后的首轮扫桶。
3. **UTC 以西**:tz=America/New_York 学员晚练同样当天;跨 UTC 午夜不错日。
4. **教练 digest**:tz=Europe/London 教练在本地 08:05 左右收到摘要,内容为其本地昨 gym-day;
   同一 gymDay 不重复推(幂等键实证)。
5. **改时区**:PATCH 后新打卡按新时区,旧行不动;非法时区 400。
6. **调度幂等**:runner 连跑两轮同一时区,结算/digest 零重复;停一轮后下一轮补上。
7. `pnpm test` 全绿 + typecheck/lint/format 过。

## 部署序(合并后)

1. DMS 应用迁移 0066(纯增量,秒级);
2. 部署 staging(行为对存量=不变,新调度 runner 空转扫到的都是上海桶,与今日结算结果一致——
   上线当天核对一次结算/digest 是否恰好一次);
3. 造 tz=Europe/London 测试学员,按验收 2/4 实证。

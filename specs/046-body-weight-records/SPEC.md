# 046 — 体重记录（每天一条，学员端体重曲线的数据源）

- **状态**: InProgress（David 2026-10-09 grill 拍板：2A 后端存、7A 每天一条只记今天、8A 可删单条、9A 老用户回填；共识复述后「确认」）
- **级别 / 节奏**: T2（迁移 + 新接口）；P1。合并等 David 放行；staging 部署随合并；**Global 生产的迁移与部署不在本 spec 授权内**，另等 David 放行。
- **对应**: 安卓学员端 `meetpr-rn` `specs/087-progress-menu/SPEC.md` §5（体重页）。iOS 与教练端本轮不消费新接口，但 iOS 现有的档案保存会经 §3 自动产生记录。
- **迁移号**: **0071**（2026-10-09 现场核实：origin/staging 头 0070；open PR #267 占 0069）。实装时再核一次。
- **先读**: 仓根 `CONTEXT.md`（体重记录）。

## 问题（为什么做）

学员体重现在只有档案表 `student_onboarding_profiles.weight_kg` 一个当前值，每次保存都覆盖，没有历史，画不出变化曲线。

## 语义（一句话）

每个学员每个日历日至多一条体重记录；档案里的 `weight_kg` 始终等于日期最新那一条的值（一条都没有时为 NULL）。

## §1 数据模型（0071-body-weight-records.sql）

```sql
CREATE TABLE body_weight_records (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recorded_on DATE NOT NULL,
  weight_kg   NUMERIC(5,2) NOT NULL CHECK (weight_kg > 0 AND weight_kg < 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, recorded_on)
);
```

- 纯新增表，不改任何现有列；`weight_kg` 的精度与取值范围与档案列一致。
- 删号：随 `users` 级联删除（体重是个人数据，不做匿名保留）。
- `src/db/types.ts` 手工补表类型。

### 存量回填（同一个迁移文件内）

档案里 `weight_kg IS NOT NULL` 的每个用户插入一条：`recorded_on` = 档案 `updated_at` 换算到该用户 `users.timezone` 后的日历日，`weight_kg` = 档案现值，`created_at` / `updated_at` = 档案 `updated_at`。

- 回填只插入新表，**不改档案表任何一行**。
- 幂等：`ON CONFLICT (user_id, recorded_on) DO NOTHING`，迁移重跑不产生重复、不覆盖已有记录。
- `users.timezone` 若不是有效时区名，该用户按 UTC 取日期，不得让整个迁移失败。
- 已知偏差（David 已知并接受）：`updated_at` 会被档案其他字段的修改刷新，所以这一条的日期可能晚于真实称重日。
- 回滚口径：本迁移可整体回滚（`DROP TABLE body_weight_records`），不丢任何原有数据，因为档案列未被触碰。

## §2 新接口

三个接口都挂在现有 `/students` 路由下，角色 `coached_student` 与 `self_train_student`，只能操作自己的记录。日期一律 `YYYY-MM-DD` 文本，小数一律两位小数的字符串（沿用本仓线上约定）。

### GET `/students/me/body-weights`

200：`{ "records": [{ "recorded_on": "2026-10-09", "weight_kg": "83.00" }, ...] }`，按 `recorded_on` 升序，返回该用户全部记录（不分页）。没有记录返回空数组。

### PUT `/students/me/body-weights/:date`

请求体 `{ "weight_kg": "83.25" }`（接受字符串或数字，至多两位小数，取值范围同档案）。

- 该日已有记录则覆盖（`updated_at` 刷新），没有则新增。
- `:date` 必须是合法日历日，且与服务器当前 UTC 日期相差不超过 1 天（覆盖全部时区的"今天"）；否则 400 `BODY_WEIGHT_DATE_OUT_OF_RANGE`。请求体不合法走现有的校验错误信封。
- 同一事务内把档案 `weight_kg` 同步为日期最新一条的值，并刷新档案 `updated_at`；用户还没有档案行时按现有 upsert 方式建行。
- 200：`{ "record": { "recorded_on", "weight_kg" }, "current_weight_kg": "83.25" }`。

### DELETE `/students/me/body-weights/:date`

- 记录不存在：404 `BODY_WEIGHT_NOT_FOUND`。日期不限范围（任何一天的记录都可删）。
- 同一事务内把档案 `weight_kg` 同步为剩余记录里日期最新一条的值；一条不剩则置 NULL。档案 `updated_at` 刷新。
- 200：`{ "current_weight_kg": "83.50" | null }`。

## §3 现有档案保存接口的联动（让不升级的客户端也产生记录）

`PUT /students/me/onboarding` 的请求体与响应形状**一字不改**（该 schema 是 strict，线上 iOS 与安卓都在用）。只在处理里加一步，与档案 upsert 同一事务：

- 请求带了 `weight_kg`，且（它与档案里原值不同，**或** 该用户还没有任何体重记录）→ 以"当前时刻换算到 `users.timezone` 的日历日"为日期 upsert 一条记录。
- 请求带了 `weight_kg` 但与原值相同且已有记录 → 不动记录表（客户端改别的字段时常把整份档案一起发上来，不能因此每天多出一条）。
- 请求没带 `weight_kg` → 不动记录表。
- 教练侧的 `PUT /students/:id/one-rm` 等其他接口不涉及体重，不动。

写入后档案 `weight_kg` 仍是请求里的值；若该用户存在日期晚于"今天"的记录（跨时区边界的极端情况），不特殊处理。

## §4 兼容与安全

- 新表、新路由、现有接口行为加法式变化；不加环境开关。线上老客户端零感知。
- 不新增推送、不新增教练侧读取（教练看体重曲线不在本 spec）。
- 现有 `GET /students/:id/onboarding`、教练绑定申请里读到的 `weight_kg` 因 §2 / §3 的同步始终是最新值，形状不变。
- 限流沿用全局中间件。

## Out of Scope

教练读取学员体重记录；补记过去日期（超出 ±1 天）；批量导入；体重目标与提醒；单位换算（一律 kg，换算在客户端）；分页；对 `student_onboarding_profiles` 的任何结构改动；Global 生产迁移与部署；plan-web。

## 测试 seam

1. `tests/migrations/0071-body-weight-records.test.ts`（沿用该目录现有迁移测试的方式）：建表；回填——有体重的档案各一条且日期按用户时区取；没体重的不回填；档案表逐行不变；重跑幂等；无效时区按 UTC。若测试用的内存库不支持时区换算语法，回填日期的断言改在真 PostgreSQL 17 上验证并把命令与结果记入 `docs/verification-0071-pg17-<日期>.md`（0070 有先例），不得因此改掉"按用户时区"的口径。
2. `tests/body-weights.test.ts`（新增，supertest，沿用 `tests/onboarding.test.ts` 的上下文与鉴权 helper）：
   - GET：空数组；多条升序；看不到别人的记录；教练角色 403；未登录 401。
   - PUT：新增；同日覆盖不新增；两位小数归一（`83` → `83.00`）；非法小数与越界 400；日期超出 ±1 天 400 `BODY_WEIGHT_DATE_OUT_OF_RANGE`；写入后 `GET /students/me/onboarding` 的 `weight_kg` 等于最新日期那条（先写今天、再写昨天时档案仍是今天的值）；无档案行的用户也能写。
   - DELETE：删最新一条后档案退回次新；删到不剩档案为 null；删不存在的 404；删别人的日期等同不存在。
3. `tests/onboarding.test.ts`（已有，补用例不改旧断言）：首次带 `weight_kg` 保存产生一条记录；同值再存不新增；改值后当天那条被覆盖；不带 `weight_kg` 的保存不动记录；响应形状与改前逐字段一致。

## 验收清单（开发前定，Opus 逐项收货）

- [ ] 1 迁移在干净库与已有数据的库上都能应用；回填条数 = 档案里有体重的用户数；档案表前后逐行一致。
- [ ] 2 迁移重跑不报错、不增行。
- [ ] 3 三个新接口的全部状态码与响应形状符合 §2。
- [ ] 4 任意顺序的 PUT / DELETE 之后，档案 `weight_kg` 恒等于日期最新一条（或 null）。
- [ ] 5 `PUT /students/me/onboarding` 的请求与响应形状未变（现有测试不改断言全部通过），§3 四种情况各有用例。
- [ ] 6 **老用户第一屏**：对一个迁移前就有体重的账号，迁移后 `GET /students/me/onboarding` 返回值与迁移前逐字段相同，`GET /students/me/body-weights` 返回恰好一条回填记录。
- [ ] 7 `pnpm typecheck && pnpm lint && pnpm test` 全绿；`db/MIGRATIONS-APPLIED*.md` 不由实装方改（部署台账由 Opus 在部署后登记）。

## 拆卡

一张卡、一个 PR：`CARD.md`。

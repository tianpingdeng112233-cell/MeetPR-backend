# 卡 B2 · 后端放宽学员资料完成必填（095 资料向导缩减）

先读同目录 `AMEND-wizard-trim.md`（本卡的正典，口径以它为准）。

## 目标
`POST /students/me/onboarding/complete` 的必填从 17 项减为 12 项：从 `src/handlers/onboarding.ts` 的 `REQUIRED_FOR_COMPLETION` 去掉 `gym_tier`、`daily_life_intensity`、`life_stress`、`recovery_speed`、`sleep_hours`。

## 文件范围
- `src/handlers/onboarding.ts`
- 对应的现有 onboarding 完成测试文件
- 若其它文件、注释或 spec 写死了「18 字段 / 17 字段 / 7 步」口径，在 JOURNAL 列出，只改代码注释，不改正典 spec

## 约束
- 不加迁移，不动数据库列，不改 `GET/PATCH` 字段与校验，不改教练端读取接口，不改自主训练学员的必填。
- `competition_date` 的条件必填（`is_competing = true` 时）不变。
- 不 commit、不 push（Opus 收货后提交）。

## 验收
`AMEND-wizard-trim.md` 的「验收」三条：12 项齐即完成；缺任一项 422 且 `missing_fields` 正确，五个放宽字段为 null 时不出现在里面；全量提交照常完成；后端全量测试绿。

## 测试 seam
`completeOnboardingProfile` 现有测试：先加「五字段为 null、其余 12 项齐 → 完成」断言跑红，再改列表跑绿。不新开 seam。

## 交付
JOURNAL 写 `docs/journal/2026-11-02-055-B2.md`。回报：改动文件、测试数字、发现的其它写死口径。

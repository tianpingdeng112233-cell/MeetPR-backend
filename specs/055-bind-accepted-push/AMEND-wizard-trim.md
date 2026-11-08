# 055 补充 · 学员资料完成必填放宽（2026-11-02，配合客户端 095 资料向导缩减）

产品正典：`meetpr-rn` 仓 `specs/095-post-bind-first-run/AMEND-wizard-trim.md`（iOS 仓有镜像）。David 11/02 拍板：学员资料向导只留基础信息、训练背景、三大项 1RM、补充信息四步，训练环境、恢复能力、训练资料三步先不要。

## 改动

- `src/handlers/onboarding.ts` 的 `REQUIRED_FOR_COMPLETION` 从 17 项减为 12 项，去掉 `gym_tier`、`daily_life_intensity`、`life_stress`、`recovery_speed`、`sleep_hours`。`training_days` 原本就不在必填里，`competition_date` 的条件必填（`is_competing = true` 时）不变。自主训练学员的 `REQUIRED_FOR_COMPLETION_SELF_TRAIN` 不变。
- 数据库列、迁移、`GET/PATCH /students/me/onboarding` 的字段与校验、教练端读取接口一律不动。老客户端照常提交全量。

## 存量

不迁移、不回填、不清值。已完成的资料 `completed_at` 不变；已填的五个字段原样保留，教练端照常可读。

## 上线

先合入 staging 分支并部署国内 staging，再合两端客户端。Global 生产未授权部署，Global 安卓包在后端同步前不得带客户端改动发版。

## 验收

- 12 项齐了就能完成；缺其中任一项返回 422，`missing_fields` 正确；五个被放宽的字段为 null 不再出现在 `missing_fields` 里。
- 全量提交（老客户端）照常完成。
- 后端全量测试绿。

## 测试 seam

`completeOnboardingProfile` 现有测试：先改断言变红（五字段为 null 时期望完成），再改必填列表变绿。

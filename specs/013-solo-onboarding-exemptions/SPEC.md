# SPEC 013 — solo onboarding 豁免:1RM 锁与完成必填集 role 化

- **状态**: Accepted(2026-07-04,与实现同 PR)
- **来源**: 自己练 Free 档 wave A2(iOS spec 046 的 backend 半)。solo 轻 onboarding(≤2 屏、可跳过)撞上两条 coached 语义的墙,均为源码核实。

## 背景(现状)

1. **1RM 完成后锁**(spec 005 E,`upsertOnboardingProfile`):`completed_at` 落后学员 PUT 任一 1RM 字段 → 403 `ONE_RM_LOCKED`;唯一合法写者是教练端点 `/coach/students/:id/one-rm`。
2. **完成必填集**(`REQUIRED_FOR_COMPLETION`,18 字段):`POST /students/me/onboarding/complete` 要求 coached 7 步全向导字段齐才落 `completed_at`。

solo(`self_train_student`)两条都撞死:

- 没有教练——锁的唯一合法写者**不存在**,跳过基线的 solo 用户永远无法补记 1RM;
- 两屏轻 onboarding(单位必填,体重/三大项可选)永远填不满 18 字段 → 永不 completed → 每次启动重弹向导。

## 改动

1. `upsertOnboardingProfile` 增 `role: UserRole` 参数:1RM 完成后锁仅对 `coached_student` 生效,`self_train_student` 豁免。理由:锁保护的是「基线归教练所有」的 coached 契约;solo 的基线归本人,可随时修订(iOS 我的页「补记入门基线」入口,spec 046 §2)。
2. `completeOnboardingProfile` 增 `role: UserRole` 参数:必填集 role 化——coached 维持 18 字段不动;self_train 仅 `['unit_preference']`(屏 1 唯一必填;跳过语义 = 只提交单位即可 complete)。`is_competing=true → competition_date` 条件规则对两种角色一致(solo 不采集该字段,天然不触发)。
3. `src/routes/onboarding.ts` 两个调用点传 `req.user.role`。

## 非目标

角色迁移(solo→coached 的 profile 归属/锁语义切换)不在本 wave;coach one-rm 端点不动;/complete 幂等语义不动;GET 读矩阵不动。

## 测试

- solo:空 profile complete → 422 `missing_fields=['unit_preference']`;PUT 单位 → complete 200 + completed_at;完成后 PUT squat_1rm_kg → 200(锁豁免)。
- coached:既有 18 字段 422 明细与 1RM 锁双测试保持全绿(语义零变化回归)。
